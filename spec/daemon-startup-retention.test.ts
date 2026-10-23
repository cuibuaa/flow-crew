import './test-support/policy-runtime.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { cmdDaemon } from '../src/cli-daemon.js';
import { sendRpc } from '../src/orchestrator-rpc.js';
import { createInvocationScratch, retireRunScratch } from '../src/invocation-scratch.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function exitWithin(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('error', failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error('owned daemon child did not exit')), 5000);
    child.once('exit', exited);
    child.once('error', failed);
  });
}

it('listens FRESH on repeated starts without traversing retained terminal runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-ready-'));
  const home = join(root, 'home');
  const run = join(home, 'runs', 'terminal');
  const dist = join(root, 'dist');
  const socket = join(root, 'daemon.sock');
  const entered = join(root, 'scan-entered');
  const release = join(root, 'release-scan');
  const archive = join(run, 'archive');
  const runner = join(root, 'serve.mjs');
  const missingRecord = join(home, 'runs', 'missing-record');
  const deletedOwner = join(home, 'runs', 'deleted-owner');
  const put = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  // A complete, offline run with both eligible work and a durable tree. The
  // tree is small: its controllable filesystem latency stands in for millions
  // of retained files, proving the dependency without a timing assertion.
  const stage = { status: 'complete', retries: 0 };
  put(join(run, 'run.json'), JSON.stringify({
    runId: 'terminal', projectDir: root, workflowName: 'startup', status: 'complete',
    startedAt: '2026-01-01T00:00:00.000Z', stages: { done: stage },
    engineCheckpoint: { version: 2, runId: 'terminal', projectDir: root,
      pid: 2147483647, processes: [], at: '2026-01-01T00:00:00.000Z' },
  }));
  put(join(run, 'workflow.yaml'), 'name: startup\nstages:\n  - id: done\n    artifact_contract: { version: 1, produces: [], reads: [] }\n');
  put(join(run, 'stages/done/status.json'), JSON.stringify(stage));
  put(join(run, 'stages/done/build/attempt_1/payload.bin'), 'disposable work');
  put(join(archive, 'nested/retained.bin'), 'durable history');
  put(join(run, 'scratch/nested/invocation.bin'), 'old invocation scratch');
  const deleted = createInvocationScratch(deletedOwner);
  const danglingAlias = dirname(deleted.path);
  rmSync(deletedOwner, { recursive: true, force: true });
  put(join(dist, 'runtime.js'), 'export const build = "fixture";\n');
  // Patch the native export before loading engine modules. If startup enters
  // this terminal tree it cannot listen until the parent releases the latch.
  put(runner, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readdirSync;
const originalRm = fs.rmSync;
function blockTraversal(path) {
  if ([${JSON.stringify(archive)}, ${JSON.stringify(join(missingRecord, 'scratch'))}].includes(String(path))) {
    fs.writeFileSync(${JSON.stringify(entered)}, String(path));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('test scan latch timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
fs.readdirSync = function(path, ...options) {
  blockTraversal(path);
  return original.call(this, path, ...options);
};
fs.rmSync = function(path, ...options) {
  blockTraversal(path);
  return originalRm.call(this, path, ...options);
};
syncBuiltinESMExports();
const { cmdDaemon } = await import(${JSON.stringify(pathToFileURL(resolve('src/cli-daemon.ts')).href)});
process.exitCode = await cmdDaemon(['daemon', 'serve', '--socket', ${JSON.stringify(socket)}], { distDir: ${JSON.stringify(dist)} });
`);

  let child: ChildProcess | undefined;
  let orphan: ReturnType<typeof createInvocationScratch> | undefined;
  let errors = '';
  try {
    for (let start = 0; start < 2; start++) {
      // First prove the terminal retention boundary alone. The second start
      // also proves missing-record scratch cannot add recursive startup work.
      if (start === 1) {
        orphan = createInvocationScratch(missingRecord);
        put(join(orphan.path, 'payload.bin'), 'orphan scratch for explicit clean');
      }
      child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), runner], {
        cwd: root,
        env: { ...process.env, HOME: process.env.HOME, FC_HOME: home, FLOWCREW_DAEMON_SOCKET: socket },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      const deadline = Date.now() + 10000;
      while (!existsSync(socket) && !existsSync(entered) && child.exitCode === null && Date.now() < deadline) await delay(10);
      if (existsSync(entered)) {
        expect(existsSync(socket), 'blocked retention has not yet opened the RPC socket').toBe(false);
        expect(readFileSync(entered, 'utf8')).toBe(start === 0 ? archive : join(missingRecord, 'scratch'));
        throw new Error('terminal-run retention traversed retained history before the daemon could listen');
      }
      expect(existsSync(socket), errors).toBe(true);
      let output = '';
      const stream = { write: (chunk: string) => { output += String(chunk); return true; } };
      expect(await cmdDaemon(['daemon', 'status', '--socket', socket], {
        distDir: dist, stdout: stream as never, stderr: stream as never,
      }), output).toBe(0);
      expect(output).toContain('FRESH:');
      expect(await sendRpc(socket, { cmd: 'hold' }, 1000)).toMatchObject({ ready: true });
      expect(await sendRpc(socket, { cmd: 'continue' }, 1000)).toMatchObject({ released: true });
      expect(existsSync(entered)).toBe(false);
      expect(() => lstatSync(danglingAlias)).toThrow(/ENOENT/);
      if (orphan) expect(readFileSync(join(orphan.path, 'payload.bin'), 'utf8')).toBe('orphan scratch for explicit clean');
      expect(readFileSync(join(archive, 'nested/retained.bin'), 'utf8')).toBe('durable history');
      expect(readFileSync(join(run, 'stages/done/build/attempt_1/payload.bin'), 'utf8')).toBe('disposable work');
      expect(readFileSync(join(run, 'scratch/nested/invocation.bin'), 'utf8')).toBe('old invocation scratch');
      await sendRpc(socket, { cmd: 'stop' }, 1000);
      await exitWithin(child).catch(error => { throw new Error(`${error.message}; daemon stderr: ${errors}`); });
      child = undefined;
    }
  } finally {
    writeFileSync(release, 'release');
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exitWithin(child).catch(error => { throw new Error(`${error.message}; daemon stderr: ${errors}`); });
    }
    retireRunScratch(missingRecord);
    retireRunScratch(deletedOwner);
    rmSync(root, { recursive: true, force: true });
  }
});

it('starts one verified serve with a 15 MB registry and retained run library, binding before storage work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-scale-'));
  const home = join(root, 'home');
  const socket = join(home, 'daemon.sock');
  const dist = join(root, 'dist');
  const release = join(root, 'release');
  const entered = join(root, 'first-storage');
  const duplicateEntered = join(root, 'duplicate-storage');
  const runner = join(root, 'serve.mjs');
  mkdirSync(home, { recursive: true });
  mkdirSync(dist);
  writeFileSync(join(dist, 'runtime.js'), 'export const build = "scale";\n');
  const task = {
    id: 1, name: 'retained fixture', projectDir: root, systemd_unit: 'fixture.service',
    status: 'complete', attempt: 1, max_retries: 0, created_at: '2026-01-01T00:00:00.000Z',
    tick_log_path: join(root, 'ticks.jsonl'), notes: 'x'.repeat(1024),
  };
  const row = JSON.stringify(task) + '\n';
  writeFileSync(join(home, 'tasks.jsonl'), row.repeat(Math.ceil(15 * 1024 * 1024 / Buffer.byteLength(row))));
  for (let i = 0; i < 1500; i++) {
    const run = join(home, 'runs', `retained-${i}`);
    mkdirSync(join(run, 'stages', 'done', 'archive'), { recursive: true });
    writeFileSync(join(run, 'run.json'), JSON.stringify({
      runId: `retained-${i}`, projectDir: root, workflowName: 'startup', status: 'complete',
      startedAt: '2026-01-01T00:00:00.000Z', stages: { done: { status: 'complete', retries: 0 } },
    }));
  }
  // Stop the first storage read at a parent-controlled latch. A duplicate must
  // refuse the bound socket without ever reaching this same storage boundary.
  writeFileSync(runner, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.openSync;
let firstRead = true;
fs.openSync = function(path, ...options) {
  if (firstRead && String(path) === ${JSON.stringify(join(home, 'tasks.jsonl'))}) {
    firstRead = false;
    fs.writeFileSync(process.argv[2], String(process.pid));
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('storage latch timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return originalOpen.call(this, path, ...options);
};
syncBuiltinESMExports();
const { cmdDaemon } = await import(${JSON.stringify(pathToFileURL(resolve('src/cli-daemon.ts')).href)});
process.exitCode = await cmdDaemon(['daemon', 'serve', '--socket', ${JSON.stringify(socket)}], { distDir: ${JSON.stringify(dist)} });
`);
  const children: ChildProcess[] = [];
  let errors = '';
  let pendingStart: Promise<number> | undefined;
  let output = '';
  const stream = { write: (chunk: string) => { output += String(chunk); return true; } };
  const launch = (marker: string) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), runner, marker], {
      cwd: root, env: { ...process.env, HOME: process.env.HOME, FC_HOME: home, FLOWCREW_DAEMON_SOCKET: socket },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    children.push(child);
    return child;
  };
  try {
    pendingStart = cmdDaemon(['daemon', 'start', '--socket', socket], {
      distDir: dist, stdout: stream as never, stderr: stream as never,
      controls: { spawnDaemon: () => {
        const child = launch(entered);
        return { pid: child.pid, exited: new Promise<string>(done => {
          child.once('error', error => done(error.message));
          child.once('exit', (code, signal) => done(String(code ?? signal)));
        }) };
      } },
    });
    const deadline = Date.now() + 10000;
    while (!existsSync(entered) && Date.now() < deadline) await delay(10);
    expect(existsSync(entered), errors).toBe(true);
    expect(existsSync(socket), 'serve must reserve the socket before registry initialization').toBe(true);
    const duplicate = launch(duplicateEntered);
    await exitWithin(duplicate);
    expect(duplicate.exitCode, errors).toBe(1);
    expect(errors).toContain('daemon socket already active');
    expect(existsSync(duplicateEntered), 'competing serve must not read storage').toBe(false);
    writeFileSync(release, 'release');
    expect(await pendingStart, output + errors).toBe(0);
    pendingStart = undefined;
    const status = await sendRpc(socket, { cmd: 'status' }, 1000);
    expect(status).toMatchObject({ pid: children[0].pid, registry_tasks: 1 });
    expect(children.filter(child => child.exitCode === null && child.signalCode === null)).toHaveLength(1);
    await sendRpc(socket, { cmd: 'stop' }, 1000);
    await exitWithin(children[0]);
  } finally {
    writeFileSync(release, 'release');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exitWithin(child);
    }
    if (pendingStart) await pendingStart;
    rmSync(root, { recursive: true, force: true });
  }
});
