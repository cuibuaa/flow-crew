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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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

function buildPrivateBackend(root: string): string {
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
  for (const path of ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build.ts']) {
    cpSync(join(repositoryRoot, path), join(projectRoot, path), { recursive: true });
  }
  symlinkSync(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  const checkoutKey = createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 16);
  cleanupRoots.push(join(tmpdir(), `flowcrew-build-${checkoutKey}`));
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all([...ownedChildren].map((child) => waitForChild(child).catch(() => undefined)));
  ownedChildren.clear();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transactional build and truthful fast-test contracts', () => {
  it('keeps a deployed daemon warning bound to its dist after the disk generation changes', async () => {
    const {
      createDaemonIdentity,
      findDeployedDistConsumers,
      writeDaemonIdentity,
    } = await import('../src/daemon-identity.js');
    const root = temporaryRoot('fc-bld-');
    const dist = join(root, 'dist');
    const procRoot = join(root, 'empty-proc');
    const socketPath = join(root, 'daemon.sock');
    mkdirSync(dist);
    mkdirSync(procRoot);
    writeFileSync(join(dist, 'runtime.js'), 'export const generation = "old";\n');
    const identity = createDaemonIdentity({
      socketPath,
      distDir: dist,
      pid: 424_242,
      startedAt: '2026-09-03T00:00:00.000Z',
    });
    writeDaemonIdentity(socketPath, identity);
    writeFileSync(join(dist, 'runtime.js'), 'export const generation = "new";\n');

    expect(findDeployedDistConsumers(dist, {
      fcHome: root,
      procRoot,
      processAlive: (pid) => pid === identity.pid,
    })).toEqual([{
      pid: identity.pid,
      kind: 'daemon',
      label: `daemon pid ${identity.pid} (${socketPath})`,
    }]);
  });

  liveBuildTest('a live gate keeps its distribution when npm run build refuses publication', { timeout: 120_000 }, async () => {
    const root = temporaryRoot('flowcrew-item12-live-build-');
    const projectRoot = buildPrivateBackend(root);
    const readyPath = join(root, 'gate.ready');
    const releasePath = join(root, 'gate.release');
    const terminalPath = join(root, 'terminal.json');
    const gateIndex = pathToFileURL(join(projectRoot, 'dist', 'reality-gate', 'index.js')).href;
    const gateSource = [
      "const fs = await import('node:fs');",
      "const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      `const gate = await import(${JSON.stringify(gateIndex)});`,
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      `while (!fs.existsSync(${JSON.stringify(releasePath)})) await delay(5);`,
      `const report = await gate.runAllChecks([{ name: 'terminal', type: 'file-exists-nonempty', reads: [{ id: 'terminal', root: 'project', path: 'terminal.json', source: { kind: 'input' } }], params: { paths: ['terminal.json'] } }], { projectDir: ${JSON.stringify(root)}, taskDir: ${JSON.stringify(root)} });`,
      `fs.writeFileSync(${JSON.stringify(terminalPath)}, JSON.stringify({ status: report.pass ? 'complete' : 'failed', checksRun: report.checksRun }));`,
      'process.stdout.write(JSON.stringify(report));',
    ].join('\n');
    writeFileSync(terminalPath, '{"status":"candidate"}\n');
    const environment = isolatedEnvironment(root);
    const gateChild = spawn(process.execPath, [
      '--input-type=module', '-e', gateSource, '--',
      '--existing-run-id', 'item12-live-build-replay',
    ], {
      cwd: projectRoot,
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

    const npmCli = process.env.npm_execpath!;
    const buildChild = spawn(process.execPath, [npmCli, 'run', 'build'], {
      cwd: projectRoot,
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
      writeFileSync(releasePath, 'release\n');
      const gateExit = await waitForChild(gateChild);
      ownedChildren.delete(buildChild);
      ownedChildren.delete(gateChild);
      expect(buildExit, buildOutput).toEqual({ code: 1, signal: null });
      expect(gateExit, gateOutput).toEqual({ code: 0, signal: null });
      expect(missingObserved).toBe(false);
      expect(buildOutput).toContain('Refusing to publish build outputs while dist has live consumers');
      expect(buildOutput).toContain('run item12-live-build-replay');
      expect(JSON.parse(readFileSync(terminalPath, 'utf-8')), gateOutput).toEqual({
        status: 'complete',
        checksRun: 1,
      });
    } finally {
      clearInterval(gapProbe);
    }
  });
});
