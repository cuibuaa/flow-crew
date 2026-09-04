import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanupRoots: string[] = [];
const ownedChildren = new Set<ChildProcess>();
const liveBuildTest = process.env.npm_execpath === undefined ? it.skip : it;

const EVIDENCE = {
  exit: {
    id: 'item12_build_crash_exit',
    sha256: '343f69a952e22757066bf936e429ec690e6dcf81d2c5ba23e30e113018265e49',
  },
  missingChecks: {
    id: 'item12_build_crash_line',
    sha256: '694150fc257a7a802e5bcc61d3d982b049c84f47207b407bb8c35a652475b325',
  },
} as const;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
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
  it('unchanged-base seam: eagerly loaded reality checks finish after their deployed directory moves', () => {
    expect(EVIDENCE.missingChecks.id).toBe('item12_build_crash_line');
    const root = temporaryRoot('flowcrew-item12-static-gate-');
    const copiedDist = join(root, 'dist');
    const copiedGate = join(copiedDist, 'reality-gate');
    const terminalPath = join(root, 'terminal.json');
    cpSync(join(repositoryRoot, 'dist', 'reality-gate'), copiedGate, { recursive: true });
    symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const indexUrl = pathToFileURL(join(copiedGate, 'index.js')).href;
    const source = [
      "const fs = await import('node:fs');",
      `const gate = await import(${JSON.stringify(indexUrl)});`,
      `fs.renameSync(${JSON.stringify(join(copiedGate, 'checks'))}, ${JSON.stringify(join(copiedGate, 'checks.previous'))});`,
      'const types = await gate.listCheckTypes();',
      `const report = await gate.runAllChecks([{ name: 'terminal', type: 'file-exists-nonempty', params: { paths: [${JSON.stringify(terminalPath)}] } }], { projectDir: ${JSON.stringify(root)}, taskDir: ${JSON.stringify(root)} });`,
      `fs.writeFileSync(${JSON.stringify(terminalPath)}, JSON.stringify({ status: report.results.length === 1 ? 'complete' : 'failed' }));`,
      'process.stdout.write(JSON.stringify({ types: types.map(({ type }) => type), checksRun: report.checksRun }));',
    ].join('\n');
    // The candidate must exist before its reality check, mirroring the terminal
    // artifact that had already been written in the evidence run.
    writeFileSync(terminalPath, '{"status":"candidate"}\n');
    const environment = isolatedEnvironment(root);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        ...environment,
        HOME: environment.HOME,
        FC_HOME: environment.FC_HOME,
      },
    });

    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ checksRun: 1, types: expect.any(Array) });
    expect(JSON.parse(readFileSync(terminalPath, 'utf-8'))).toEqual({ status: 'complete' });
  });

  it('publishes complete files first, commits the manifest last, and rolls back a failed publication', async () => {
    const {
      BUILD_MANIFEST_FILENAME,
      assertDistFresh,
      createBuildManifest,
      publishBuildGeneration,
    } = await import('../src/build-manifest.js');
    const root = temporaryRoot('flowcrew-build-publication-');
    const sourceRoot = join(root, 'src');
    const stagedDist = join(root, 'staged');
    const dist = join(root, 'dist');
    mkdirSync(sourceRoot);
    mkdirSync(stagedDist);
    mkdirSync(dist);
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
    writeFileSync(join(sourceRoot, 'entry.ts'), 'export const generation = "new";\n');
    writeFileSync(join(stagedDist, 'entry.js'), 'export const generation = "new";\n');
    writeFileSync(join(stagedDist, 'entry.d.ts'), 'export declare const generation = "new";\n');
    writeFileSync(join(dist, 'entry.js'), 'export const generation = "old";\n');
    writeFileSync(join(dist, 'entry.d.ts'), 'export declare const generation = "old";\n');
    const phases: string[] = [];
    const manifest = createBuildManifest(root, stagedDist, { builtAt: '2026-09-03T00:00:00.000Z' });

    publishBuildGeneration({
      projectRoot: root,
      stagedDistDir: stagedDist,
      distDir: dist,
      cacheDir: join(root, '.cache'),
      manifest,
      onPhase: (phase) => {
        phases.push(phase);
        if (phase === 'replacement_files_prepared') {
          expect(readFileSync(join(dist, 'entry.js'), 'utf-8')).toContain('old');
          expect(existsSync(join(dist, BUILD_MANIFEST_FILENAME))).toBe(false);
        }
        if (phase === 'runtime_files_published') {
          expect(readFileSync(join(dist, 'entry.js'), 'utf-8')).toContain('new');
          expect(existsSync(join(dist, BUILD_MANIFEST_FILENAME))).toBe(false);
        }
      },
    });
    expect(phases.at(-1)).toBe('manifest_committed');
    expect(assertDistFresh(root, dist).generation).toBe(manifest.generation);

    let unchangedCommits = 0;
    publishBuildGeneration({
      projectRoot: root,
      stagedDistDir: stagedDist,
      distDir: dist,
      cacheDir: join(root, '.cache'),
      manifest,
      beforeFileCommit: () => { unchangedCommits += 1; },
    });
    expect(unchangedCommits).toBe(0);

    writeFileSync(join(stagedDist, 'entry.js'), 'export const generation = "broken";\n');
    writeFileSync(join(stagedDist, 'entry.d.ts'), 'export declare const generation: "broken";\n');
    const broken = createBuildManifest(root, stagedDist, { builtAt: '2026-09-03T00:01:00.000Z' });
    expect(() => publishBuildGeneration({
      projectRoot: root,
      stagedDistDir: stagedDist,
      distDir: dist,
      cacheDir: join(root, '.cache'),
      manifest: broken,
      beforeFileCommit: (_path, index) => {
        if (index === 1) throw new Error('injected publication interruption');
      },
    })).toThrow('injected publication interruption');
    expect(readFileSync(join(dist, 'entry.js'), 'utf-8')).toContain('new');
    expect(assertDistFresh(root, dist).generation).toBe(manifest.generation);
  });

  it('rejects a source change or modified output before dist-backed specs run', async () => {
    const {
      assertDistFresh,
      createBuildManifest,
      publishBuildGeneration,
    } = await import('../src/build-manifest.js');
    const root = temporaryRoot('flowcrew-build-freshness-');
    const sourceRoot = join(root, 'src');
    const stagedDist = join(root, 'staged');
    const dist = join(root, 'dist');
    mkdirSync(sourceRoot);
    mkdirSync(stagedDist);
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
    writeFileSync(join(sourceRoot, 'entry.ts'), 'export const value = 1;\n');
    writeFileSync(join(stagedDist, 'entry.js'), 'export const value = 1;\n');
    writeFileSync(join(stagedDist, 'entry.d.ts'), 'export declare const value = 1;\n');
    publishBuildGeneration({
      projectRoot: root,
      stagedDistDir: stagedDist,
      distDir: dist,
      cacheDir: join(root, '.cache'),
      manifest: createBuildManifest(root, stagedDist),
    });
    expect(() => assertDistFresh(root, dist)).not.toThrow();
    writeFileSync(join(sourceRoot, 'entry.ts'), 'export const value = 2;\n');
    expect(() => assertDistFresh(root, dist)).toThrow(/dist is stale.*npm run build/s);
    writeFileSync(join(sourceRoot, 'entry.ts'), 'export const value = 1;\n');
    writeFileSync(join(dist, 'entry.js'), 'export const value = 9;\n');
    expect(() => assertDistFresh(root, dist)).toThrow(/modified or partial.*npm run build/s);
  });

  it('keeps a deployed daemon warning bound to its dist after the disk generation changes', async () => {
    const {
      createDaemonIdentity,
      findDeployedDistConsumers,
      writeDaemonIdentity,
    } = await import('../src/daemon-identity.js');
    const root = temporaryRoot('flowcrew-deployed-dist-warning-');
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

  liveBuildTest('unchanged-base seam: a live gate survives npm run build and the operator sees the affected run', { timeout: 60_000 }, async () => {
    expect(EVIDENCE.exit.sha256).toHaveLength(64);
    const root = temporaryRoot('flowcrew-item12-live-build-');
    const readyPath = join(root, 'gate.ready');
    const releasePath = join(root, 'gate.release');
    const terminalPath = join(root, 'terminal.json');
    const gateIndex = pathToFileURL(join(repositoryRoot, 'dist', 'reality-gate', 'index.js')).href;
    const gateSource = [
      "const fs = await import('node:fs');",
      "const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      `const gate = await import(${JSON.stringify(gateIndex)});`,
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      `while (!fs.existsSync(${JSON.stringify(releasePath)})) await delay(5);`,
      `const report = await gate.runAllChecks([{ name: 'terminal', type: 'file-exists-nonempty', params: { paths: [${JSON.stringify(terminalPath)}] } }], { projectDir: ${JSON.stringify(root)}, taskDir: ${JSON.stringify(root)} });`,
      `fs.writeFileSync(${JSON.stringify(terminalPath)}, JSON.stringify({ status: report.pass ? 'complete' : 'failed', checksRun: report.checksRun }));`,
    ].join('\n');
    writeFileSync(terminalPath, '{"status":"candidate"}\n');
    const environment = isolatedEnvironment(root);
    const gateChild = spawn(process.execPath, [
      '--input-type=module', '-e', gateSource, '--',
      '--existing-run-id', 'item12-live-build-replay',
    ], {
      cwd: repositoryRoot,
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
      cwd: repositoryRoot,
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
    const checksDirectory = join(repositoryRoot, 'dist', 'reality-gate', 'checks');
    let missingObserved = false;
    const gapProbe = setInterval(() => {
      if (!existsSync(checksDirectory)) missingObserved = true;
    }, 2);
    try {
      const reachedPublicationOrGap = await waitUntil(
        () => buildOutput.includes('replacement_files_prepared') || !existsSync(checksDirectory),
        30_000,
      );
      expect(reachedPublicationOrGap, buildOutput).toBe(true);
      writeFileSync(releasePath, 'release\n');
      const [buildExit, gateExit] = await Promise.all([
        waitForChild(buildChild),
        waitForChild(gateChild),
      ]);
      ownedChildren.delete(buildChild);
      ownedChildren.delete(gateChild);
      expect(buildExit, buildOutput).toEqual({ code: 0, signal: null });
      expect(gateExit, gateOutput).toEqual({ code: 0, signal: null });
      expect(missingObserved).toBe(false);
      expect(buildOutput).toContain('WARNING: deployed dist is live');
      expect(buildOutput).toContain('affected run item12-live-build-replay');
      expect(JSON.parse(readFileSync(terminalPath, 'utf-8'))).toEqual({
        status: 'complete',
        checksRun: 1,
      });
      process.stdout.write(`ITEM12_LIVE_BUILD_REPLAY=${JSON.stringify({
        evidence: [EVIDENCE.exit.id, EVIDENCE.missingChecks.id],
        buildExit: buildExit.code,
        gateExit: gateExit.code,
        missingObserved,
        warning: buildOutput.split(/\r?\n/).filter((line) => (
          line.includes('WARNING: deployed dist is live')
          || line.includes('affected run item12-live-build-replay')
        )),
        terminal: JSON.parse(readFileSync(terminalPath, 'utf-8')),
      })}\n`);
    } finally {
      clearInterval(gapProbe);
    }
  });

  it('unchanged-base seam: root setup targets DOM matchers and cancels debounce without a per-file sleep', () => {
    const setup = readFileSync(join(repositoryRoot, 'vitest.setup.ts'), 'utf-8');
    const config = readFileSync(join(repositoryRoot, 'vitest.config.ts'), 'utf-8');
    const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const tsconfig = JSON.parse(readFileSync(join(repositoryRoot, 'tsconfig.json'), 'utf-8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(setup).toContain('expect.getState().environment === "jsdom"');
    expect(setup).toContain('clearAttemptSummaryRefreshDebounce()');
    expect(setup).not.toMatch(/setTimeout\([^)]*lateCallbackGraceMs|lateCallbackGraceMs\s*=\s*300/s);
    expect(config).toContain('maxWorkers: VITEST_MAX_WORKERS');
    expect(config).not.toContain('maxWorkers: 3');
    expect(packageManifest.scripts?.build).not.toContain('clean');
    expect(packageManifest.scripts?.['build:clean']).toBeTypeOf('string');
    expect(tsconfig.compilerOptions).toMatchObject({
      incremental: true,
      tsBuildInfoFile: '.cache/tsc.tsbuildinfo',
    });
  });
});
