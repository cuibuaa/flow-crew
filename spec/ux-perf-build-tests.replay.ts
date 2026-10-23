import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDistFresh, pinBuildRuntime, assertBuildArtifactInventory } from '../src/build-manifest.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanupRoots: string[] = [];
const ownedChildren = new Set<ChildProcess>();
const liveBuildTest = process.env.npm_execpath === undefined ? it.skip : it;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

function buildPrivateBackend(root: string, prepare: (projectRoot: string) => void): string {
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
  for (const path of ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build.ts']) {
    cpSync(join(repositoryRoot, path), join(projectRoot, path), { recursive: true });
  }
  symlinkSync(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  const checkoutKey = createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 16);
  cleanupRoots.push(join(tmpdir(), `flowcrew-build-${checkoutKey}`));
  prepare(projectRoot);
  isolatedProjectCommand(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], projectRoot, root);
  return projectRoot;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const fcHome = join(home, '.fc');
  mkdirSync(fcHome, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    FC_HOME: fcHome,
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  };
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  return predicate();
}

afterEach(async () => {
  for (const child of ownedChildren) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already exited */ }
    }
  }
  await Promise.all([...ownedChildren].map((child) => waitForChild(child).catch(() => undefined)));
  ownedChildren.clear();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transactional build and truthful fast-test contracts', () => {
  liveBuildTest('a task launched from a pinned runtime loads only old gate code after a changed-source rebuild and re-pin', { timeout: 120_000 }, async () => {
    const root = temporaryRoot('flowcrew-item12-live-build-');
    const readyPath = join(root, 'gate.ready');
    const releasePath = join(root, 'gate.release');
    const terminalPath = join(root, 'terminal.json');
    const projectRoot = buildPrivateBackend(root, project => {
      // The task uses its own physical module directory, just like the orchestrator's cliPath.
      writeFileSync(join(project, 'src/task-probe.ts'), [
        "import { spawn } from 'node:child_process';",
        "import { join } from 'node:path';",
        "const child = spawn(process.execPath, [join(import.meta.dirname, 'gate-probe.js'), ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });",
        "child.once('error', error => { console.error(error); process.exitCode = 1; });",
        "child.once('exit', code => { process.exitCode = code ?? 1; });",
      ].join('\n'));
      writeFileSync(join(project, 'src/gate-probe.ts'), [
        "import * as fs from 'node:fs';",
        "const [ready, release, terminal, root] = process.argv.slice(2);",
        "fs.writeFileSync(ready, 'ready');",
        "while (!fs.existsSync(release)) await new Promise(r => setTimeout(r, 5));",
        "const gate = await import('./reality-gate/index.js');",
        "const report = await gate.runAllChecks([{ name: 'terminal', type: 'file-exists-nonempty', reads: [{ kind: 'file', id: 'terminal', root: 'project', path: 'terminal.json', source: { kind: 'input' } }], params: { paths: ['terminal.json'] } }], { projectDir: root, taskDir: root });",
        "fs.writeFileSync(terminal, JSON.stringify({ status: report.pass ? 'complete' : 'failed', checksRun: report.checksRun, version: gate.replayVersion, details: report.results[0].details }));",
      ].join('\n'));
      const index = join(project, 'src/reality-gate/index.ts');
      writeFileSync(index, readFileSync(index, 'utf8') + "\nexport const replayVersion = 'old';\n");
      const handler = join(project, 'src/reality-gate/checks/file-exists-nonempty.ts');
      writeFileSync(handler, readFileSync(handler, 'utf8').replace('file(s) exist and are nonempty', 'file(s) exist and are nonempty [old]'));
    });
    const first = assertDistFresh(projectRoot);
    const runtimeRoot = join(root, 'daemon/runtime');
    const runtime = pinBuildRuntime(join(projectRoot, 'dist'), runtimeRoot);
    writeFileSync(terminalPath, '{"status":"candidate"}\n');
    const environment = isolatedEnvironment(root);
    const gateChild = spawn(process.execPath, [
      join(runtime, 'task-probe.js'), readyPath, releasePath, terminalPath, root,
    ], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        HOME: environment.HOME,
        FC_HOME: environment.FC_HOME,
      },
    });
    ownedChildren.add(gateChild);
    let gateOutput = '';
    gateChild.stdout?.on('data', (chunk) => { gateOutput += String(chunk); });
    gateChild.stderr?.on('data', (chunk) => { gateOutput += String(chunk); });
    expect(await waitUntil(() => existsSync(readyPath), 10_000), gateOutput).toBe(true);

    for (const relative of ['src/reality-gate/index.ts', 'src/reality-gate/checks/file-exists-nonempty.ts']) {
      const path = join(projectRoot, relative);
      writeFileSync(path, readFileSync(path, 'utf8').replace("replayVersion = 'old'", "replayVersion = 'new'").replace('[old]', '[new]'));
    }
    const npmCli = process.env.npm_execpath!;
    const buildChild = spawn(process.execPath, [npmCli, 'run', 'build'], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        HOME: environment.HOME,
        FC_HOME: environment.FC_HOME,
      },
    });
    ownedChildren.add(buildChild);
    let buildOutput = '';
    buildChild.stdout?.on('data', (chunk) => { buildOutput += String(chunk); });
    buildChild.stderr?.on('data', (chunk) => { buildOutput += String(chunk); });
    const checksDirectory = join(projectRoot, 'dist', 'reality-gate', 'checks');
    let missingObserved = false;
    const gapProbe = setInterval(() => {
      if (!existsSync(checksDirectory)) missingObserved = true;
    }, 2);
    try {
      const buildExit = await waitForChild(buildChild);
      expect(buildExit, buildOutput).toEqual({ code: 0, signal: null });
      const second = assertDistFresh(projectRoot);
      expect(second.inputs.hash).not.toBe(first.inputs.hash);
      const nextRuntime = pinBuildRuntime(join(projectRoot, 'dist'), runtimeRoot);
      expect(nextRuntime).not.toBe(runtime);
      expect(assertBuildArtifactInventory(runtime, first)).toEqual(first.artifacts);
      expect(readFileSync(join(nextRuntime, 'reality-gate/index.js'), 'utf8')).toContain("replayVersion = 'new'");
      expect(readFileSync(join(nextRuntime, 'reality-gate/checks/file-exists-nonempty.js'), 'utf8')).toContain('[new]');
      writeFileSync(releasePath, 'release\n');
      const gateExit = await waitForChild(gateChild);
      ownedChildren.delete(buildChild);
      ownedChildren.delete(gateChild);
      expect(gateExit, gateOutput).toEqual({ code: 0, signal: null });
      expect(missingObserved).toBe(false);
      expect(buildOutput).toContain('[flowcrew-build] committed');
      expect(JSON.parse(readFileSync(terminalPath, 'utf-8')), gateOutput).toEqual({
        status: 'complete',
        checksRun: 1,
        version: 'old',
        details: '1 file(s) exist and are nonempty [old]',
      });
    } finally {
      clearInterval(gapProbe);
    }
  });
});
