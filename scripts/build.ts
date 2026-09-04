import { createHash } from 'node:crypto';
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
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  computeBuildInputDigest,
  createBuildManifest,
  pruneStaleBuildOutputs,
  publishBuildGeneration,
} from '../src/build-manifest.js';
import { findDeployedDistConsumers } from '../src/daemon-identity.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(projectRoot, '.cache');
const lockPath = join(cacheDir, 'build.lock');
const checkoutKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
const stagingDist = join(tmpdir(), `flowcrew-build-${checkoutKey}`, 'dist');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireBuildLock(): number {
  mkdirSync(cacheDir, { recursive: true });
  if (existsSync(lockPath)) {
    let owner: number | undefined;
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
      if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) owner = Number(value.pid);
    } catch { /* malformed lock is stale */ }
    if (owner && processAlive(owner)) throw new Error(`Another build is publishing this checkout (pid ${owner}).`);
    rmSync(lockPath, { force: true });
  }
  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf-8');
  fsyncSync(fd);
  return fd;
}

function warnAboutDeployedConsumers(): void {
  const distDir = join(projectRoot, 'dist');
  if (!existsSync(distDir)) return;
  const fcHome = resolve(process.env.FC_HOME ?? join(homedir(), '.fc'));
  const consumers = findDeployedDistConsumers(distDir, { fcHome });
  if (consumers.length === 0) {
    process.stdout.write(`[flowcrew-build] transactional publication target: ${distDir}\n`);
    return;
  }
  process.stderr.write(
    `\n[flowcrew-build] WARNING: deployed dist is live; publishing safely without removing it.\n`
    + `[flowcrew-build] target: ${distDir}\n`
    + consumers.map((consumer) => `[flowcrew-build] affected ${consumer.label}\n`).join('')
    + '[flowcrew-build] the running process keeps its loaded generation; restart it later to load new fixes.\n\n',
  );
}

function compileGeneration(): void {
  mkdirSync(stagingDist, { recursive: true });
  const compiler = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [
    compiler,
    '-p', join(projectRoot, 'tsconfig.json'),
    '--outDir', stagingDist,
    '--incremental',
    '--tsBuildInfoFile', join(cacheDir, 'tsc.tsbuildinfo'),
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`TypeScript compilation exited ${result.status ?? 'without a status'}`);
  pruneStaleBuildOutputs(projectRoot, stagingDist);
  chmodSync(join(stagingDist, 'cli.js'), 0o755);
}

function main(): void {
  const lockFd = acquireBuildLock();
  try {
    warnAboutDeployedConsumers();
    const before = computeBuildInputDigest(projectRoot);
    compileGeneration();
    const manifest = createBuildManifest(projectRoot, stagingDist);
    if (manifest.inputs.hash !== before.hash) {
      throw new Error('Build inputs changed during compilation; rerun `npm run build` against a settled source tree.');
    }
    publishBuildGeneration({
      projectRoot,
      stagedDistDir: stagingDist,
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

