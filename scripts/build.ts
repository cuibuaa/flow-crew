import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  computeBuildInputDigest,
  createBuildManifest,
  pruneStaleBuildOutputs,
  publishBuildGeneration,
} from '../src/build-manifest.js';
import { processIsAlive } from '../src/process-liveness.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// One destination owns backend, UI, incremental state and publication history.
// Deleting conflict checks cannot isolate writes; changing their destination can.
const outputRoot = resolve(process.argv[2] ?? projectRoot);
const cacheDir = join(outputRoot, '.cache');
const lockPath = join(cacheDir, 'build.lock');
const checkoutKey = createHash('sha256').update(outputRoot).digest('hex').slice(0, 16);
const stagingRoot = join(tmpdir(), `flowcrew-build-${checkoutKey}`);
const stagingDist = join(stagingRoot, 'dist');
const stagingUi = join(stagingRoot, 'ui-dist');

function acquireBuildLock(): number {
  mkdirSync(cacheDir, { recursive: true });
  if (existsSync(lockPath)) {
    let owner: number | undefined;
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
      if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) owner = Number(value.pid);
    } catch { /* malformed lock is stale */ }
    if (owner && processIsAlive(owner)) throw new Error(`Another build is publishing this checkout (pid ${owner}).`);
    rmSync(lockPath, { force: true });
  }
  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf-8');
  fsyncSync(fd);
  return fd;
}

function compileGeneration(): void {
  mkdirSync(stagingDist, { recursive: true });
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  let compiler: string;
  try {
    compiler = projectRequire.resolve('typescript/bin/tsc');
  } catch (error) {
    const lookupPaths = projectRequire.resolve.paths('typescript/bin/tsc') ?? [];
    throw new Error(
      `Cannot resolve TypeScript compiler from ${projectRoot}; lookup paths: ${lookupPaths.join(', ') || '(none)'}`,
      { cause: error },
    );
  }
  const result = spawnSync(process.execPath, [
    compiler,
    '-p', join(projectRoot, 'tsconfig.json'),
    '--outDir', stagingDist,
    '--incremental',
    '--tsBuildInfoFile', join(stagingDist, '.tsbuildinfo'),
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`TypeScript compilation exited ${result.status ?? 'without a status'}`);
  pruneStaleBuildOutputs(projectRoot, stagingDist);
  const stagedCli = join(stagingDist, 'cli.js');
  if (!existsSync(stagedCli)) {
    throw new Error(`TypeScript compilation reported success but did not emit required output ${stagedCli}`);
  }
  chmodSync(stagedCli, 0o755);
}

function compileUi(): string | undefined {
  const uiRoot = join(projectRoot, 'ui');
  if (!existsSync(join(uiRoot, 'package.json'))) return undefined;
  const uiRequire = createRequire(join(uiRoot, 'package.json'));
  const compiler = uiRequire.resolve('typescript/bin/tsc');
  for (const config of ['tsconfig.json', 'tsconfig.node.json']) {
    const result = spawnSync(process.execPath, [compiler, '--noEmit', '-p', join(uiRoot, config)], {
      cwd: uiRoot, stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`UI type check exited ${result.status ?? 'without a status'}`);
  }
  rmSync(stagingUi, { recursive: true, force: true });
  const vite = join(dirname(uiRequire.resolve('vite/package.json')), 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [vite, 'build', '--outDir', stagingUi], {
    cwd: uiRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`UI compilation exited ${result.status ?? 'without a status'}`);
  return stagingUi;
}

function main(): void {
  const lockFd = acquireBuildLock();
  try {
    const before = computeBuildInputDigest(projectRoot);
    compileGeneration();
    const stagedUiDir = compileUi();
    const manifest = createBuildManifest(projectRoot, stagingDist, { stagedUiDir });
    if (manifest.inputs.hash !== before.hash) {
      throw new Error('Build inputs changed during compilation; rerun `npm run build` against a settled source tree.');
    }
    // A live destination is immutable, including replacements and its marker.
    publishBuildGeneration({
      projectRoot,
      stagedDistDir: stagingDist,
      stagedUiDir,
      distDir: join(outputRoot, 'dist'),
      cacheDir,
      manifest,
      onPhase: (phase, detail) => {
        process.stdout.write(`[flowcrew-build] ${phase}: ${detail}\n`);
      },
    });
    process.stdout.write(
      `[flowcrew-build] committed ${manifest.generation.slice(0, 12)} `
      + `(${manifest.outputs.length} files; manifest last)\n`,
    );
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[flowcrew-build] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
