import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const commands = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: commands.run }), spawn: commands.spawn };
});

import { NodeSystemd } from '../src/orchestrator.js';
import { claimLaunchIntent, readLaunchIntent, releaseLaunchIntent } from '../src/run-lock.js';
import { fcGlobalDir, initializeReservedRun, readRunReservation, requireExistingRunArtifactDirectory, reserveRun, setFcGlobalDir } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { cmdPrune } from '../src/run-retention.js';
import { startRpcServer } from '../src/orchestrator-rpc.js';
import { selectRelevantCampaignContext } from '../src/campaign-context.js';
import { cmdDaemon, type DaemonProcessControls } from '../src/cli-daemon.js';
import { createDaemonIdentity, writeDaemonIdentity } from '../src/daemon-identity.js';

let root: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'identity-'));
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubEnv('XDG_RUNTIME_DIR', root); vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
  commands.run.mockReset(); commands.spawn.mockReset();
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true });
});
const longWait = 365 * 24 * 60 * 60_000;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
// Model execFile's actual completion/timeout boundary. Reintroducing a timeout
// must stop this healthy command, not merely fail a source/options assertion.
function commandPending(options: { timeout?: number } = {}) {
  let reject!: (error: Error) => void;
  const answer = deferred<{ stdout: string; stderr: string }>();
  const failed = new Promise<never>((_, no) => { reject = no; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = options.timeout ? Promise.race([answer.promise, failed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('command stopped'), { killed: true, code: 'ETIMEDOUT' })), options.timeout);
  })]) : Promise.race([answer.promise, failed]);
  return { promise: promise.finally(() => clearTimeout(timer)), reject, finish: (stdout = '') => answer.resolve({ stdout, stderr: '' }) };
}

describe('pre-publication identities', () => {
  it('H07 keeps a slow claim occupied until matching-owner release', async () => {
    expect(claimLaunchIntent(root, 'first').claimed).toBe(true);
    const fast = readLaunchIntent(root);
    await vi.advanceTimersByTimeAsync(longWait);
    expect(readLaunchIntent(root)).toEqual(fast);
    expect(claimLaunchIntent(root, 'second')).toEqual({ claimed: false, blockingOwnerRunId: 'first' });
    releaseLaunchIntent(root, 'second'); expect(readLaunchIntent(root)).toEqual(fast);
    releaseLaunchIntent(root, 'first');
    expect(readLaunchIntent(root)).toBeNull();
    expect(claimLaunchIntent(root, 'second')).toEqual({ claimed: true });
  });

  it('H07 retains malformed ownership across age and clock skew', async () => {
    claimLaunchIntent(root, 'first');
    const path = join(fcGlobalDir(), 'launch-intents', `${createHash('sha256').update(root).digest('hex')}.json`);
    for (const raw of ['{', JSON.stringify({ version: 1, projectDir: root, ownerRunId: 'first', claimedAt: new Date(Date.now() + longWait).toISOString() })]) {
      writeFileSync(path, raw);
      await vi.advanceTimersByTimeAsync(longWait * 2);
      expect(claimLaunchIntent(root, 'second').claimed).toBe(false);
      if (raw === '{') expect(claimLaunchIntent(root, 'unreadable-launch-intent').claimed).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(raw);
    }
  });

  it('H08 keeps a reservation readable and intact through slow launch and cleanup, then consumes it on initialization', async () => {
    const r = reserveRun(root), fast = readRunReservation(root, r.runId);
    const artifact = runRecordPath(r.runDirPath, 'launch-evidence.txt'); writeFileSync(artifact, 'unique pre-init evidence');
    await vi.advanceTimersByTimeAsync(longWait);
    expect(readRunReservation(root, r.runId)).toEqual(fast);
    expect(requireExistingRunArtifactDirectory(r.runDirPath)).toBe(r.runDirPath);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(readFileSync(artifact, 'utf8')).toBe('unique pre-init evidence');
    initializeReservedRun(root, r.runId, 'clock', 'name: clock\nstages: []', []);
    expect(readRunReservation(root, r.runId)).toBeUndefined();
    expect(requireExistingRunArtifactDirectory(r.runDirPath)).toBe(r.runDirPath);
  });

  it('H08 rejects a reservation bound to a different project regardless of age', async () => {
    const r = reserveRun(root);
    for (const elapsed of [0, longWait]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(readRunReservation(join(root, 'other-project'), r.runId)).toBeUndefined();
      expect(() => initializeReservedRun(join(root, 'other-project'), r.runId, 'clock', '', [])).toThrow();
    }
  });
});

describe('supervisor observations wait for evidence', () => {
  it('R03 never treats a slow socket connect as permission to take over', async () => {
    const socketPath = join(root, 's'); writeFileSync(socketPath, 'existing endpoint');
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as unknown as net.Socket);
    let settled = false;
    const pending = startRpcServer(socketPath, () => ({ ok: true })).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(longWait);
    expect(settled).toBe(false); expect(readFileSync(socketPath, 'utf8')).toBe('existing endpoint');
    socket.emit('connect');
    expect((await pending).message).toContain('already active');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('R03 retains an endpoint on real connect failure, leaving owner cleanup authoritative', async () => {
    const socketPath = join(root, 's'); writeFileSync(socketPath, 'closed endpoint');
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as unknown as net.Socket);
    const pending = startRpcServer(socketPath, () => ({ ok: true })).catch(error => error);
    socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    expect((await pending).message).toContain('needs inspection');
    expect(readFileSync(socketPath, 'utf8')).toBe('closed endpoint');
  });

  it('R05 waits for a slow successful manager acknowledgement without launching another shim', async () => {
    let command!: ReturnType<typeof commandPending>;
    commands.run.mockImplementation((_file, _args, options) => { command = commandPending(options); return command.promise; });
    let settled = false;
    const backend = new NodeSystemd(fcGlobalDir());
    const pending = backend.runUnit({ unit: 'slow.service', workingDirectory: root, command: 'finite-work' }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(longWait);
    expect(settled).toBe(false); expect(commands.spawn).not.toHaveBeenCalled();
    command.finish(); await pending;
    expect(settled).toBe(true); expect(commands.run).toHaveBeenCalledTimes(1); expect(commands.spawn).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 1, 'ETIMEDOUT'])('R05 only spawns a portable shim when manager spawn failed (%s)', async code => {
    const failure = Object.assign(new Error('manager did not acknowledge'), { code });
    commands.run.mockRejectedValue(failure);
    commands.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
    const backend = new NodeSystemd(fcGlobalDir());
    const pending = backend.runUnit({ unit: 'failed.service', workingDirectory: root, command: 'finite-work' });
    if (code === 'ENOENT') { await pending; expect(commands.spawn).toHaveBeenCalledTimes(1); }
    else { await expect(pending).rejects.toBe(failure); expect(commands.spawn).not.toHaveBeenCalled(); }
    expect(existsSync(join(fcGlobalDir(), 'supervise', 'failed.service', 'launch.json'))).toBe(true);
  });

  it.each([false, true])('R13 a slow LoadState response retains its meaning (real error=%s)', async fail => {
    let command!: ReturnType<typeof commandPending>;
    commands.run.mockImplementation((_file, args, options) => {
      if (args.includes('is-active')) return Promise.reject(Object.assign(new Error('inactive'), { stdout: 'inactive' }));
      command = commandPending(options); return command.promise;
    });
    let settled = false;
    const backend = new NodeSystemd(fcGlobalDir());
    const pending = backend.isActive('absent.service').then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(longWait);
    expect(settled).toBe(false);
    if (fail) {
      command.reject(new Error('LoadState read failed'));
    } else command.finish('not-found');
    expect(await pending).toMatchObject({ kind: fail ? 'terminal-unknown' : 'absent' });
  });
});

describe('restart and campaign relevance', () => {
  it.each([false, true])('R12 waits for the original owner to release and refuses a replacement (replacement=%s)', async replacement => {
    const socketPath = join(root, 's'), dist = join(root, 'dist'); mkdirSync(dist);
    writeFileSync(join(dist, 'entry.js'), 'export const fixture = true;');
    const identity = createDaemonIdentity({ socketPath, distDir: dist, pid: 12345 }); writeDaemonIdentity(socketPath, identity);
    const status = { pid: identity.pid, startedAt: identity.startedAt, socketPath, build: identity.build.hash,
      buildFiles: identity.build.files, buildNewestMtimeMs: identity.build.newestMtimeMs, uptime: 0, watched_tasks: 0, registry_unreadable_records: 0 };
    const entered = deferred();
    let owner: number | undefined = 123, text = '';
    const stream = { write: (value: string) => { text += value; return true; } } as NodeJS.WriteStream;
    const controls: DaemonProcessControls = {
      sendRpc: vi.fn(async () => status), findSocketOwnerPid: () => owner,
      spawnDaemon: vi.fn(() => { owner = identity.pid; return { pid: identity.pid, exited: new Promise<string>(() => {}) }; }),
      processAlive: () => true, killProcess: vi.fn(), build: vi.fn(),
      delay: vi.fn(async () => { entered.resolve(); await new Promise(resolve => setTimeout(resolve, 100)); }),
    };
    let settled = false;
    const pending = cmdDaemon(['daemon', 'restart', '--socket', socketPath], { distDir: dist, stdout: stream, stderr: stream, controls }).then(value => { settled = true; return value; });
    await entered.promise; await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false); expect(controls.spawnDaemon).not.toHaveBeenCalled(); expect(controls.killProcess).not.toHaveBeenCalled();
    owner = replacement ? 456 : undefined; await vi.advanceTimersByTimeAsync(100);
    expect(await pending, text).toBe(replacement ? 1 : 0);
    expect(controls.killProcess).not.toHaveBeenCalled();
    expect(controls.spawnDaemon).toHaveBeenCalledTimes(replacement ? 0 : 1);
    if (replacement) expect(text).toContain('changed ownership');
  });

  it('H10 retains slow nonterminal campaign facts until an explicit terminal or phase completion event', async () => {
    const entries = [{ seq: 1, runId: 'active', status: 'running', timestamp: new Date().toISOString(), phase: 'one', phaseComplete: false }];
    const fast = selectRelevantCampaignContext(entries);
    await vi.advanceTimersByTimeAsync(longWait);
    expect(selectRelevantCampaignContext(entries)).toEqual(fast);
    expect(selectRelevantCampaignContext([...entries, { ...entries[0], seq: 2, phaseComplete: true, nextPhase: 'two' }])).toMatchObject({ entries: [], recommendedPhase: 'two' });
    expect(selectRelevantCampaignContext([...entries, { ...entries[0], seq: 3, status: 'complete' }]).entries).toEqual([]);
  });
});
