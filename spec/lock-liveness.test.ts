import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, utimesSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { claimLaunchIntent } from '../src/run-lock.js';
import { TaskRegistry } from '../src/task-registry.js';
import { ledgerLockPath, readTaskLedger } from '../src/fc-tasks.js';
import { readLockWaits, type LockWait } from '../src/lock-publication.js';
import { cmdState } from '../src/run-state-access.js';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import { cmdDaemon } from '../src/cli-daemon.js';

type Kind = 'run-state' | 'registry' | 'ledger';
interface Message { type: 'held' | 'waiting' | 'recovering' | 'entered' | 'done' | 'error'; step?: number; waits?: LockWait[]; error?: string }
let root: string, previous: string, project: string, runId: string, runDirectory: string;
const children = new Set<ChildProcess>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'll-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  ({ runId, runDirPath: runDirectory } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []));
  mkdirSync(join(root, 'ledger'));
  writeFileSync(join(root, 'clock'), '1');
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  }
  children.clear(); setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
const pathFor = (kind: Kind) => kind === 'run-state' ? runRecordPath(runDirectory, '.run-state.lock')
  : kind === 'registry' ? join(root, 'fc', 'tasks.lock') : ledgerLockPath(join(root, 'ledger'), 'session');
let serial = 0;
function worker(kind: Kind, mode: 'hold' | 'wait' | 'legacy-hold', controlled: boolean | 'recovery' = false, pathOverride?: string) {
  const label = String(serial++);
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('spec/test-support/lock-worker.ts'),
    kind, mode, root, pathOverride ?? pathFor(kind), runId, project, label, controlled === 'recovery' ? 'recovery' : controlled ? 'controlled' : ''], {
    cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc'), FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.add(child);
  let diagnostic = '';
  const messages: Message[] = [];
  let changed: (() => void) | undefined;
  child.stderr!.on('data', data => { diagnostic += data; });
  child.on('message', value => { messages.push(value as Message); changed?.(); });
  child.on('close', () => changed?.());
  const next = async (type: Message['type']) => {
    for (;;) {
      const message = messages.shift();
      if (message) { expect(message, diagnostic).toMatchObject({ type }); return message; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${child.exitCode}: ${diagnostic}`);
      await new Promise<void>(resolve => { changed = resolve; });
    }
  };
  return { child, next, advance: (step: number) => writeFileSync(join(root, `step-${label}-${step}`), 'proceed'), release: () => writeFileSync(join(root, `release-${label}`), 'release'), diagnostic: () => diagnostic };
}
async function joined(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  children.delete(child);
}
async function status(kind: Kind, selectedRun = runId): Promise<LockWait[]> {
  let output = '', errors = '';
  const stdout = { write: (value: string) => { output += value; return true; } };
  const stderr = { write: (value: string) => { errors += value; return true; } };
  if (kind === 'run-state') {
    expect(cmdState(['state', '--project', project, '--run', selectedRun, '--summary'], stdout as never, stderr as never), errors).toBe(selectedRun === runId ? 0 : 1);
    return JSON.parse(output).lockWaits;
  }
  if (kind === 'ledger') {
    expect(cmdFcTasks(['fc_tasks', 'list', '--session', 'session', '--store-root', join(root, 'ledger')], { stdout, stderr }), errors).toBe(0);
    return JSON.parse(output).lockWaits;
  }
  // Do not need a live daemon: this CLI reads the wait before attempting its RPC.
  await cmdDaemon(['daemon', 'status', '--socket', join(root, 'daemon.sock')], {
    distDir: join(root, 'absent-runtime'), stdout: stdout as never, stderr: stderr as never,
    controls: { sendRpc: async () => { throw new Error('fixture has no RPC listener'); }, findSocketOwnerPid: () => undefined },
  });
  expect(output, errors).not.toBe('');
  return JSON.parse(output.split('\n')[0]).lockWaits;
}
function mutationCompleted(kind: Kind): void {
  if (kind === 'run-state') expect(readRunState(project, runId).taskDescription).toBe('mutation completed');
  else if (kind === 'registry') expect(new TaskRegistry({ baseDir: join(root, 'fc') }).list()[0].name).toBe('mutation completed');
  else expect(readTaskLedger(join(root, 'ledger'), 'session').entries.map(entry => entry.id).some(id => id.startsWith('wait-'))).toBe(true);
}

describe('native synchronous lock liveness', () => {
  it.each(['run-state', 'registry', 'ledger'] as const)('%s remains visibly waiting across a far-advanced clock and completes after controlled release', async kind => {
    const holder = worker(kind, 'hold'); await holder.next('held');
    const waiter = worker(kind, 'wait');
    await waiter.next('waiting');
    writeFileSync(join(root, 'clock'), '1000000000000000');
    waiter.advance(0);
    const observed = await waiter.next('waiting');
    expect(observed.waits).toEqual([expect.objectContaining({ kind: 'lock_wait', holder: expect.objectContaining({ pid: holder.child.pid }) })]);
    expect(process.kill(holder.child.pid!, 0)).toBe(true);
    expect(await status(kind)).toEqual(observed.waits);
    // The actual CLI process also reads persisted wait state, independently of the synchronous writer.
    const arguments_ = kind === 'run-state' ? ['status', '--project', project]
      : kind === 'registry' ? ['daemon', 'status', '--socket', join(root, 'daemon.sock')]
      : ['fc_tasks', 'list', '--session', 'session', '--store-root', join(root, 'ledger')];
    const cli = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/cli.ts'), ...arguments_], {
      cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc'), FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock') }, encoding: 'utf8', timeout: 120_000,
    });
    expect(cli.status, cli.stderr).toBe(kind === 'registry' ? 1 : 0); // private fixture has no daemon listener
    expect(cli.stdout).toContain(kind === 'ledger' ? '"kind": "lock_wait"' : '"kind":"lock_wait"');
    if (kind !== 'run-state') {
      const output = JSON.parse(kind === 'ledger' ? cli.stdout : cli.stdout.split('\n')[0]);
      expect(output.lockWaits).toEqual(observed.waits);
    } else expect(cli.stdout).toContain(`"pid":${holder.child.pid}`);
    writeFileSync(join(root, 'release-holder'), 'release');
    await holder.next('done'); await joined(holder.child);
    waiter.advance(1);
    await waiter.next('done'); await joined(waiter.child);
    mutationCompleted(kind);
    expect(readLockWaits(pathFor(kind))).toEqual([]);
    expect(existsSync(pathFor(kind))).toBe(false);
  }, 120_000);

  it.each(['deployment', 'validation', 'project ownership', 'custom daemon root'] as const)('observes %s reuse of the run-state mutex through existing status readers', async scope => {
    let directory = scope === 'deployment' ? join(root, 'fc') : join(root, 'fc', 'validation');
    if (scope === 'custom daemon root') directory = root;
    if (scope === 'project ownership') {
      expect(claimLaunchIntent(project, runId).claimed).toBe(true);
      const ownership = join(root, 'fc', 'launch-intents');
      directory = join(ownership, readdirSync(ownership).find(name => name.endsWith('.ownership'))!);
    }
    mkdirSync(directory, { recursive: true });
    const path = runRecordPath(directory, '.run-state.lock');
    const holder = worker('run-state', 'hold', false, path); await holder.next('held');
    const waiter = worker('run-state', 'wait', false, path); await waiter.next('waiting');
    const waiting = await status(scope === 'custom daemon root' ? 'registry' : 'run-state');
    expect(waiting).toEqual([expect.objectContaining({ lock: { kind: 'run-state', path }, holder: expect.objectContaining({ pid: holder.child.pid }) })]);
    if (scope !== 'project ownership') expect(await status('registry')).toEqual(waiting);
    writeFileSync(join(root, 'release-holder'), 'release'); await holder.next('done'); await joined(holder.child);
    waiter.advance(0); await waiter.next('done'); await joined(waiter.child);
    expect(readFileSync(join(root, 'global-mutation'), 'utf8')).toBe('completed');
  }, 120_000);

  it('shows the run-state waiter before a reserved run has published its run record', async () => {
    const directory = join(root, 'fc', 'runs', 'reserved'); mkdirSync(directory);
    const path = runRecordPath(directory, '.run-state.lock');
    const holder = worker('run-state', 'hold', false, path); await holder.next('held');
    const waiter = worker('run-state', 'wait', false, path); await waiter.next('waiting');
    expect(await status('run-state', 'reserved')).toEqual([expect.objectContaining({ lock: { kind: 'run-state', path }, holder: expect.objectContaining({ pid: holder.child.pid }) })]);
    writeFileSync(join(root, 'release-holder'), 'release'); await holder.next('done'); await joined(holder.child);
    waiter.advance(0); await waiter.next('done'); await joined(waiter.child);
    expect(readFileSync(join(root, 'global-mutation'), 'utf8')).toBe('completed');
  }, 120_000);

  it.each(['run-state', 'registry', 'ledger'] as const)('%s takes over a killed holder without advancing the frozen clock', async kind => {
    const holder = worker(kind, 'hold'); await holder.next('held');
    const waiter = worker(kind, 'wait'); await waiter.next('waiting');
    holder.child.kill('SIGKILL'); await joined(holder.child);
    waiter.advance(0);
    await waiter.next('done'); await joined(waiter.child);
    expect(readFileSync(join(root, 'clock'), 'utf8')).toBe('1');
    mutationCompleted(kind);
  }, 120_000);

  it.each(['run-state', 'registry', 'ledger'] as const)('%s keeps concurrent dead-owner contenders mutually exclusive', async kind => {
    const holder = worker(kind, 'hold'); await holder.next('held');
    const first = worker(kind, 'wait', true); await first.next('waiting');
    const second = worker(kind, 'wait', true); await second.next('waiting');
    holder.child.kill('SIGKILL'); await joined(holder.child);
    first.advance(0);
    await first.next('entered');
    second.advance(0);
    const waiting = await second.next('waiting');
    expect(waiting.waits).toEqual([expect.objectContaining({ holder: expect.objectContaining({ pid: first.child.pid }) })]);
    first.release(); await first.next('done'); await joined(first.child);
    second.advance(1); await second.next('entered');
    second.release(); await second.next('done'); await joined(second.child);
    mutationCompleted(kind);
    if (kind === 'registry') expect(new TaskRegistry({ baseDir: join(root, 'fc') }).list()).toHaveLength(2);
    if (kind === 'ledger') expect(readTaskLedger(join(root, 'ledger'), 'session').entries).toHaveLength(2);
  }, 120_000);

  it.each(['run-state', 'registry', 'ledger'] as const)('%s serializes takeover before canonical unlink under concurrent contenders', async kind => {
    const holder = worker(kind, 'hold'); await holder.next('held');
    const first = worker(kind, 'wait', 'recovery'); await first.next('waiting');
    const second = worker(kind, 'wait'); await second.next('waiting');
    holder.child.kill('SIGKILL'); await joined(holder.child);
    first.advance(0); await first.next('recovering');
    second.advance(0);
    const waiting = await second.next('waiting');
    expect(waiting.waits?.find(wait => wait.waiter.pid === second.child.pid)).toMatchObject({ holder: { pid: first.child.pid } });
    first.release(); await first.next('done'); await joined(first.child);
    second.advance(1); await second.next('done'); await joined(second.child);
    mutationCompleted(kind);
  }, 120_000);

  it.each(['run-state', 'registry', 'ledger'] as const)('%s exposes the legacy orphan ambiguity without evicting a paused writer', async kind => {
    const holder = worker(kind, 'legacy-hold'); await holder.next('held');
    const path = pathFor(kind);
    utimesSync(path, new Date(0), new Date(0));
    const identity = lstatSync(path).ino;
    const waiter = worker(kind, 'wait');
    const live = await waiter.next('waiting');
    expect(live.waits).toEqual([expect.objectContaining({ holder: null, reason: 'legacy_owner_unavailable' })]);
    expect(process.kill(holder.child.pid!, 0)).toBe(true);
    holder.child.kill('SIGKILL'); await joined(holder.child);
    waiter.advance(0);
    const orphan = await waiter.next('waiting');
    expect(orphan.waits).toEqual(live.waits);
    expect(lstatSync(path).ino).toBe(identity);
    // Fixture cleanup supplies information/action the owner-less on-disk format
    // cannot provide. Production deliberately cannot automate this deletion.
    rmSync(path, { recursive: true });
    waiter.advance(1); await waiter.next('done'); await joined(waiter.child);
    mutationCompleted(kind);
  }, 120_000);

  it('rewrites an admitted legacy run without requiring new lock fields in its stored record', () => {
    const legacy = readRunState(project, runId);
    delete legacy.stateFormat;
    legacy.status = 'incomplete';
    writeFileSync(runRecordPath(runDirectory, 'run.json'), JSON.stringify(legacy));
    const before = readRunState(project, runId);
    expect(before.stateFormat).toBeUndefined();
    writeRunState(project, runId, { ...before, status: 'running' });
    expect(readRunState(project, runId).status).toBe('running');
  });
});
