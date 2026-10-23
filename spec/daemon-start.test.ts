import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDaemon, type DaemonProcessControls } from '../src/cli-daemon.js';
import { createDaemonIdentity, writeDaemonIdentity } from '../src/daemon-identity.js';
import { DaemonUnavailableError, type DaemonStatusRpcResponse } from '../src/orchestrator-rpc.js';

describe('daemon start owns and verifies its child', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fc-start-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const socket = join(root, 'daemon.sock');
    const dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'runtime.js'), 'export const build = "start";\n');
    const identity = createDaemonIdentity({ socketPath: socket, distDir: dist, pid: 12345 });
    writeDaemonIdentity(socket, identity);
    const status: DaemonStatusRpcResponse = {
      pid: identity.pid, startedAt: identity.startedAt, socketPath: socket,
      build: identity.build.hash, buildFiles: identity.build.files,
      buildNewestMtimeMs: identity.build.newestMtimeMs,
      uptime: 0, watched_tasks: 0, registry_unreadable_records: 0,
    };
    let exit!: (reason: string) => void;
    const exited = new Promise<string>(done => { exit = done; });
    let spawned = false;
    let output = '';
    const stream = { write: (chunk: string) => { output += String(chunk); return true; } };
    const controls: DaemonProcessControls = {
      sendRpc: vi.fn(async () => {
        if (!spawned) throw new DaemonUnavailableError();
        return status;
      }),
      findSocketOwnerPid: () => identity.pid,
      spawnDaemon: vi.fn(() => { spawned = true; return { pid: identity.pid, exited }; }),
      processAlive: () => true,
      killProcess: vi.fn(() => exit('SIGKILL')),
      delay: vi.fn(async () => {}),
      build: async () => { throw new Error('start must not build'); },
    };
    const start = () => cmdDaemon(['daemon', 'start', '--socket', socket], {
      distDir: dist, stdout: stream as never, stderr: stream as never, controls,
    });
    return { controls, start, status, identity, socket, exit, output: () => output };
  }

  it('waits beyond forty 100ms polls for its child to initialize', async () => {
    const f = fixture();
    let polls = 0;
    f.controls.sendRpc = vi.fn(async () => {
      if (polls++ <= 45) throw new DaemonUnavailableError();
      return f.status;
    });
    expect(await f.start(), f.output()).toBe(0);
    expect(f.controls.delay).toHaveBeenCalledTimes(45);
    expect(f.output()).toContain(`daemon started at ${f.socket}`);
    expect(f.controls.killProcess).not.toHaveBeenCalled();
  });

  it('reports its child exit instead of leaving a startup waiter', async () => {
    const f = fixture();
    f.controls.sendRpc = async () => { throw new DaemonUnavailableError(); };
    f.controls.delay = async () => { f.exit('17'); };
    f.controls.processAlive = () => false;
    expect(await f.start()).toBe(1);
    expect(f.output()).toContain('child exited before readiness (17)');
    expect(f.controls.killProcess).not.toHaveBeenCalled();
  });

  it('reaps its child when the persisted identity disagrees with RPC', async () => {
    const f = fixture();
    writeDaemonIdentity(f.socket, { ...f.identity, startedAt: '2020-01-01T00:00:00.000Z' });
    expect(await f.start()).toBe(1);
    expect(f.output()).toContain('daemon.json do not agree');
    expect(f.controls.killProcess).toHaveBeenCalledExactlyOnceWith(f.identity.pid, 'SIGKILL');
  });

  it('kills only its owned child when a competing verified listener wins', async () => {
    const f = fixture();
    const competitor = f.identity.pid + 1;
    writeDaemonIdentity(f.socket, { ...f.identity, pid: competitor });
    f.status.pid = competitor;
    f.controls.findSocketOwnerPid = () => competitor;
    expect(await f.start()).toBe(1);
    expect(f.output()).toContain('different child');
    expect(f.controls.killProcess).toHaveBeenCalledExactlyOnceWith(f.identity.pid, 'SIGKILL');
  });

  it('accepts an existing daemon only when RPC, owner and persisted identity agree', async () => {
    const f = fixture();
    f.controls.sendRpc = async () => f.status;
    expect(await f.start()).toBe(0);
    expect(f.output()).toContain('already running');
    expect(f.controls.spawnDaemon).not.toHaveBeenCalled();
  });

  it.each(['socket owner', 'persisted identity'] as const)('refuses an already-running claim with a different %s', async mismatch => {
    const f = fixture();
    f.controls.sendRpc = async () => f.status;
    if (mismatch === 'socket owner') f.controls.findSocketOwnerPid = () => f.identity.pid + 1;
    else writeDaemonIdentity(f.socket, { ...f.identity, pid: f.identity.pid + 1 });
    expect(await f.start()).toBe(1);
    expect(f.output()).toContain('daemon.json do not agree');
    expect(f.controls.spawnDaemon).not.toHaveBeenCalled();
    expect(f.controls.killProcess).not.toHaveBeenCalled();
  });
});
