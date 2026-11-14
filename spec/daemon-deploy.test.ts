import './test-support/policy-runtime.js';
import { reattestCompatibility } from './test-support/manifest-compatibility.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDaemon, type DaemonProcessControls } from '../src/cli-daemon.js';
import { BUILD_MANIFEST_FILENAME, createBuildManifest, expectedBuildOutputs, pinBuildRuntime } from '../src/build-manifest.js';
import { createDaemonIdentity, writeDaemonIdentity } from '../src/daemon-identity.js';
import { markDeploymentStopping, readDeploymentHold, releaseDeploymentHold, requestDeploymentHold } from '../src/deployment-hold.js';
import { DaemonUnavailableError, RpcOutcomeUnknownError, type DaemonStatusRpcResponse, type RpcResponse } from '../src/orchestrator-rpc.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const oldPid = 900001;
const newPid = 900002;
const oldStartedAt = '2026-01-01T00:00:00.000Z';
const newStartedAt = '2026-01-02T00:00:00.000Z';
let scratch: string;
let previousStore: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fc-dd-'));
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(scratch, 'state'));
  mkdirSync(fcGlobalDir());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setFcGlobalDir(previousStore);
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(exclusive = true) {
  const project = join(scratch, 'checkout');
  const dist = join(project, 'dist');
  const socket = join(fcGlobalDir(), 'daemon.sock');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(dist);
  writeFileSync(join(project, 'tsconfig.json'), '{}');
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'src', 'cli.ts'), 'export const value = 1;');
  const publish = (generation: number) => {
    for (const output of expectedBuildOutputs(project)) {
      writeFileSync(join(dist, output), output.endsWith('.d.ts') ? 'export declare const value: number;' : `export const value = ${generation};`);
    }
    const manifest = createBuildManifest(project, dist);
    writeFileSync(join(dist, BUILD_MANIFEST_FILENAME), JSON.stringify(manifest));
    return manifest;
  };
  publish(1);
  const oldDist = pinBuildRuntime(dist, join(fcGlobalDir(), 'runtime'));
  const f = {
    project, dist, socket, publish,
    owner: oldPid as number | undefined,
    identity: createDaemonIdentity({ socketPath: socket, distDir: oldDist, pid: oldPid, startedAt: oldStartedAt }),
    events: [] as string[],
    output: '', error: '',
    pendingHold: 0,
    failBuild: false,
    failStart: false,
    continuationErrors: [] as string[],
    onDelay: () => {},
    onBuild: () => {},
    afterSpawn: () => {},
  };
  writeDaemonIdentity(socket, f.identity);
  const status = (): DaemonStatusRpcResponse => ({
    pid: f.identity.pid, startedAt: f.identity.startedAt, socketPath: socket,
    build: f.identity.build.hash, buildFiles: f.identity.build.files,
    buildNewestMtimeMs: f.identity.build.newestMtimeMs,
    uptime: 1, watched_tasks: 0, registry_unreadable_records: 0,
  });
  const held = (ready = f.pendingHold === 0) => ({ hold: readDeploymentHold(), ready, tasks: [], errors: [] });
  const controls: DaemonProcessControls = {
    sendRpc: async (_socket, request): Promise<RpcResponse> => {
      f.events.push(`rpc:${request.cmd}`);
      if (request.cmd === 'hold') { requestDeploymentHold(); return held(); }
      if (request.cmd === 'hold-status') { f.pendingHold = Math.max(0, f.pendingHold - 1); return held(); }
      if (request.cmd === 'status') {
        if (f.owner === undefined) throw new DaemonUnavailableError();
        return status();
      }
      if (request.cmd === 'stop') { f.owner = undefined; return { ok: true }; }
      if (request.cmd === 'continue') {
        const hold = readDeploymentHold()!;
        if (f.continuationErrors.length) return { ...held(), released: false, errors: f.continuationErrors };
        releaseDeploymentHold(hold);
        return { ...held(false), released: true };
      }
      throw new Error(`Unexpected fixture RPC: ${request.cmd}`);
    },
    findSocketOwnerPid: () => f.owner,
    processAlive: () => false,
    processStart: () => ({ kind: 'linux', value: '1' }),
    processState: () => f.owner === oldPid ? 'alive' : 'dead',
    build: async (target) => {
      f.events.push('build');
      expect(target).toBe(project);
      expect(f.owner).toBe(exclusive ? undefined : oldPid);
      expect(readDeploymentHold()?.releasedAt).toBeUndefined();
      if (f.failBuild) throw new Error('fixture compiler failure');
      publish(2);
      f.onBuild();
    },
    spawnDaemon: () => {
      f.events.push('spawn');
      if (f.failStart) throw new Error('fixture spawn failure');
      f.owner = newPid;
      f.identity = createDaemonIdentity({ socketPath: socket, distDir: dist, pid: newPid, startedAt: new Date(Date.parse(newStartedAt) + f.events.filter(event => event === 'spawn').length * 1000).toISOString() });
      writeDaemonIdentity(socket, f.identity);
      f.afterSpawn();
      return { pid: newPid, exited: new Promise(() => {}) };
    },
    killProcess: () => { throw new Error('Deployment must not signal a consumer'); },
    delay: async () => { f.events.push('delay'); f.onDelay(); },
  };
  const run = (timeout = 1000) => {
    if (exclusive) requestDeploymentHold();
    return cmdDaemon(['daemon', 'deploy', '--socket', socket, '--timeout-ms', String(timeout)], {
    distDir: dist, controls,
    stdout: { write: (text: string) => { f.output += text; } } as never,
    stderr: { write: (text: string) => { f.error += text; } } as never,
  });
  };
  return Object.assign(f, { run, controls });
}

function expectHeldFailure(f: ReturnType<typeof fixture>, step: string) {
  expect(readDeploymentHold()).toBeDefined();
  expect(readDeploymentHold()?.releasedAt).toBeUndefined();
  expect(readDeploymentHold()?.stopRequestedAt).toEqual(expect.any(String));
  expect(f.error).toContain(`DEPLOY STOPPED at ${step}:`);
  expect(f.error).toContain('hold remains active');
  expect(f.error).toContain('Retry flowcrew daemon deploy');
  expect(f.events).not.toContain('rpc:continue');
}

describe('explicit migration through the durable hold', () => {
  it.each(['standalone start', 'exclusive recovery'] as const)('%s fences startup on recorded old-process death after listener release', async entrance => {
    const f = fixture();
    f.owner = undefined; // stop closed its listener, but control has not exited.
    markDeploymentStopping(requestDeploymentHold());
    let alive = true;
    let observed!: () => void;
    const checked = new Promise<'checked'>(done => { observed = () => done('checked'); });
    let spawned!: () => void;
    const launched = new Promise<'spawned'>(done => { spawned = () => done('spawned'); });
    let release!: () => void;
    const barrier = new Promise<void>(done => { release = done; });
    const observations: unknown[] = [];
    f.controls.processState = (pid, start) => {
      observations.push([pid, start]);
      observed();
      return alive ? 'alive' : 'dead';
    };
    f.controls.delay = async () => { await barrier; };
    const spawn = f.controls.spawnDaemon;
    f.controls.spawnDaemon = (...args) => {
      spawned();
      return spawn(...args);
    };
    const pending = entrance === 'exclusive recovery' ? f.run() : cmdDaemon(['daemon', 'start', '--socket', f.socket], {
      distDir: f.dist, controls: f.controls,
      stdout: { write: (text: string) => { f.output += text; } } as never,
      stderr: { write: (text: string) => { f.error += text; } } as never,
    });
    try {
      // A spawn event loses immediately; no elapsed observation grants a pass.
      expect(await Promise.race([checked, launched, pending.then(() => 'settled')])).toBe('checked');
      expect(observations).toEqual([[oldPid, { kind: 'linux', value: '1' }]]);
      expect(f.events).not.toContain('spawn');
    } finally {
      alive = false;
      release();
      await pending;
    }
    expect(await pending, f.error).toBe(0);
    expect(f.events).toContain('spawn');
  });

  it('holds, retires, builds, proves the new identity/generation, then continues', async () => {
    const f = fixture();
    expect(await f.run(), f.error).toBe(0);
    const ordered = ['rpc:hold', 'rpc:stop', 'build', 'spawn', 'rpc:continue'];
    const positions = ordered.map(event => f.events.indexOf(event));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(f.output).toContain('FRESH:');
    expect(f.output).toMatch(/generation: [a-f0-9]{64}/);
    expect(readDeploymentHold()?.releasedAt).toBeDefined();
    expect(existsSync(join(fcGlobalDir(), 'deployment-transaction.json'))).toBe(false);
    expect(existsSync(join(fcGlobalDir(), 'deployment-transaction.lock'))).toBe(false);
  });

  it('waits for a running stage to settle before stopping', async () => {
    const f = fixture(); f.pendingHold = 1;
    expect(await f.run(), f.error).toBe(0);
    expect(f.events.indexOf('rpc:hold-status')).toBeLessThan(f.events.indexOf('rpc:stop'));
  });

  it('allows a historical continuation refusal to rebuild and revalidate', async () => {
    const f = fixture();
    const sendRpc = f.controls.sendRpc;
    f.controls.sendRpc = async (...input) => {
      const result = await sendRpc(...input);
      return ['hold', 'hold-status'].includes(input[1].cmd)
        ? { ...result, errors: ['Historical continuation refusal; deployment may repair the engine'] } : result;
    };
    expect(await f.run(), f.error).toBe(0);
    expect(f.events).toContain('build');
    expect(readDeploymentHold()?.releasedAt).toBeDefined();
  });

  it.each(['unbound', 'corrupt'])('refuses an unsafe %s registry before holding or stopping', async unsafe => {
    const f = fixture();
    writeFileSync(join(fcGlobalDir(), 'tasks.jsonl'), unsafe === 'corrupt' ? 'invalid registry row\n'
      : JSON.stringify({ id: 1, status: 'running', projectDir: f.project }) + '\n');
    expect(await f.run()).toBe(1);
    expect(f.owner).toBe(oldPid);
    expect(f.events).not.toContain('rpc:hold');
    expect(f.events).not.toContain('build');
  });

  it('returns in progress and preserves the unsettled hold at a declared limit', async () => {
    const f = fixture(); f.pendingHold = 1;
    expect(await expireHold(f, 0)).toBe(5);
    expect(JSON.parse(f.output)).toMatchObject({ status: 'in-progress', code: 'RPC_IN_PROGRESS' });
    expect(f.error).toBe('');
    expect(readDeploymentHold()?.releasedAt).toBeUndefined();
    expect(f.events).not.toContain('rpc:stop');
    expect(f.events).not.toContain('build');
  });

  it('retries a failed build by settling the durable hold through the last published generation', async () => {
    const f = fixture(); f.failBuild = true;
    expect(await f.run()).toBe(1);
    expectHeldFailure(f, 'build');
    const holdId = readDeploymentHold()!.id;
    f.failBuild = false;
    expect(await f.run(), f.error).toBe(0);
    expect(readDeploymentHold()?.id).toBe(holdId);
    expect(f.events.filter(event => event === 'rpc:hold')).toHaveLength(2);
    expect(f.events.filter(event => event === 'spawn')).toHaveLength(2);
    expect(readDeploymentHold()?.releasedAt).toBeDefined();
  });

  it('retains the hold after a lost stop reply and can retry without a transaction receipt', async () => {
    const f = fixture(); const sendRpc = f.controls.sendRpc;
    f.controls.sendRpc = async (...input) => {
      const result = await sendRpc(...input);
      if (input[1].cmd === 'stop') throw new RpcOutcomeUnknownError('fixture lost stop reply');
      return result;
    };
    expect(await f.run()).toBe(2);
    expectHeldFailure(f, 'stop');
    f.controls.sendRpc = sendRpc;
    expect(await f.run(), f.error).toBe(0);
  });

  it('accepts an identical rebuilt generation when a new daemon loads it freshly', async () => {
    const f = fixture();
    const generation = JSON.parse(readFileSync(join(f.dist, BUILD_MANIFEST_FILENAME), 'utf8')).generation;
    f.controls.build = async () => { f.events.push('build'); };
    expect(await f.run(), f.error).toBe(0);
    expect(f.output).toContain(`generation: ${generation}`);
    expect(f.identity.pid).toBe(newPid);
  });

  it.each(['manifest', 'source', 'output'])('rejects a successful build with invalid %s evidence before starting', async broken => {
    const f = fixture();
    f.onBuild = () => {
      if (broken === 'manifest') writeFileSync(join(f.dist, BUILD_MANIFEST_FILENAME), '{}');
      if (broken === 'source') writeFileSync(join(f.project, 'src', 'cli.ts'), 'export const value = 999;');
      if (broken === 'output') writeFileSync(join(f.dist, 'cli.js'), 'export const tampered = true;');
    };
    expect(await f.run()).toBe(1);
    expectHeldFailure(f, 'build');
    expect(f.events).not.toContain('spawn');
  });

  it('keeps the hold when spawning fails', async () => {
    const f = fixture(); f.failStart = true;
    expect(await f.run()).toBe(1);
    expectHeldFailure(f, 'start');
  });

  it.each(['stale', 'persisted', 'same-process', 'changed-generation'])('does not continue when verification detects %s', async broken => {
    const f = fixture();
    f.afterSpawn = () => {
      if (broken === 'stale') f.identity.build.hash = '0'.repeat(64);
      if (broken === 'persisted') writeDaemonIdentity(f.socket, { ...f.identity, startedAt: oldStartedAt });
      if (broken === 'same-process') {
        f.owner = oldPid; f.identity.pid = oldPid; f.identity.startedAt = oldStartedAt;
        writeDaemonIdentity(f.socket, f.identity);
      }
      if (broken === 'changed-generation') {
        f.publish(3);
        f.identity = createDaemonIdentity({ socketPath: f.socket, distDir: f.dist, pid: newPid, startedAt: newStartedAt });
        writeDaemonIdentity(f.socket, f.identity);
      }
    };
    expect(await f.run()).toBe(1);
    expect(readDeploymentHold()?.releasedAt).toBeUndefined();
    expect(f.events).not.toContain('rpc:continue');
  });

  it('keeps the hold when continuation refuses incompatible runs', async () => {
    const f = fixture(); f.continuationErrors = ['fixture incompatible held run'];
    expect(await f.run()).toBe(1);
    expect(f.error).toContain('DEPLOY STOPPED at continue:');
    expect(readDeploymentHold()?.releasedAt).toBeUndefined();
  });

  it('reports the released durable latch accurately when a continuation reply is lost', async () => {
    const f = fixture(); const sendRpc = f.controls.sendRpc;
    f.controls.sendRpc = async (...input) => {
      const result = await sendRpc(...input);
      if (input[1].cmd === 'continue') throw new RpcOutcomeUnknownError('fixture lost continuation reply');
      return result;
    };
    expect(await f.run()).toBe(2);
    expect(readDeploymentHold()?.releasedAt).toBeDefined();
    expect(f.error).toContain('hold already released; verify tasks before retrying');
    expect(f.output).not.toContain('Deployment complete');
  });
});


it('declared deployment waiting covers a held reply without failure cleanup', async () => {
  const f = fixture();
  const send = f.controls.sendRpc;
  const received = deferred<void>();
  f.controls.sendRpc = async (...args) => {
    const response = await send(...args);
    if (args[1].cmd !== 'hold') return response;
    received.resolve();
    return new Promise((_, reject) => args[2]!.signal!.addEventListener('abort', () => reject(args[2]!.signal!.reason), { once: true }));
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const pending = f.run(1000);
  await received.promise;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(5);
  expect(JSON.parse(f.output)).toMatchObject({ status: 'in-progress', code: 'RPC_IN_PROGRESS' });
  expect(f.error).toBe('');
  expect(readDeploymentHold()?.releasedAt).toBeUndefined();
  expect(f.owner).toBe(oldPid);
  expect(f.events).not.toContain('rpc:continue');
  expect(f.events).not.toContain('rpc:stop');
  expect(f.events).not.toContain('build');
});

it('SI genuine daemon transport failure remains a transport failure', async () => {
  const f = fixture(); f.pendingHold = 100;
  const sendRpc = f.controls.sendRpc;
  f.controls.sendRpc = async (...args) => {
    if (args[1].cmd === 'hold-status') throw new RpcOutcomeUnknownError('fixture genuine transport failure');
    return sendRpc(...args);
  };
  expect(await f.run(), f.error).toBe(2);
  expect(f.error).toContain('fixture genuine transport failure');
  expect(f.error).not.toContain('Hold is not settled');
  expect(readDeploymentHold()?.releasedAt).toBeDefined();
  expect(f.owner).toBe(oldPid);
});

it('SI a pre-existing stopped recovery hold survives a later wait timeout', async () => {
  const f = fixture(); f.pendingHold = 100;
  const requested = requestDeploymentHold();
  markDeploymentStopping(requested);
  const hold = readDeploymentHold();
  expect(await expireHold(f, 0)).toBe(5);
  expect(readDeploymentHold()).toEqual(hold);
  expect(f.events).not.toContain('rpc:continue');
});


it('a declared limit preserves an earlier unsettled hold before any stop request', async () => {
  const f = fixture(); f.pendingHold = 100;
  requestDeploymentHold();
  expect(await expireHold(f, 0)).toBe(5);
  expect(readDeploymentHold()?.releasedAt).toBeUndefined();
  expect(f.events).not.toContain('rpc:stop');
});


it('SI a legacy hold with unknown stop status preserves its recovery fence', async () => {
  const f = fixture(); f.pendingHold = 100;
  const { stopRequestedAt: _unknown, ...legacy } = requestDeploymentHold();
  writeFileSync(join(fcGlobalDir(), 'deployment-hold.json'), JSON.stringify(legacy));
  expect(await expireHold(f, 0)).toBe(5);
  expect(readDeploymentHold()).toEqual(legacy);
  expect(f.events).not.toContain('rpc:continue');
  expect(f.events).not.toContain('rpc:stop');
});

async function expireHold(f: ReturnType<typeof fixture>, limit: number) {
  const waiting = deferred<void>();
  f.controls.delay = async (_ms, signal) => {
    waiting.resolve();
    return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const pending = f.run(limit);
  await waiting.promise;
  await vi.advanceTimersByTimeAsync(limit);
  return pending;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}


describe('compatible deployment beside live work', () => {
  it('builds while old control serves, then replaces without hold or continue', async () => {
    const f = fixture(false);
    expect(await f.run(), f.error).toBe(0);
    expect(f.events.indexOf('build')).toBeLessThan(f.events.indexOf('rpc:stop'));
    expect(f.events).not.toContain('rpc:hold');
    expect(f.events).not.toContain('rpc:continue');
    expect(readDeploymentHold()).toBeUndefined();
    expect(f.output).toContain('FRESH:');
  });

  it('refuses a tampered retained target runtime before stopping old control', async () => {
    const f=fixture(false);
    f.onBuild=()=>{
      const runtime=pinBuildRuntime(f.dist,join(fcGlobalDir(),'runtime'));
      const manifestPath=join(runtime,BUILD_MANIFEST_FILENAME);
      const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
      manifest.controlCompatibility='tampered';
      writeFileSync(manifestPath,JSON.stringify(manifest));
    };
    expect(await f.run()).toBe(1);
    expect(f.error).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
    expect(f.events).not.toContain('rpc:stop');
    expect(f.owner).toBe(oldPid);
  });

  it('a failed compatible build leaves the old control serving', async () => {
    const f = fixture(false); f.failBuild = true;
    expect(await f.run()).toBe(1);
    expect(f.owner).toBe(oldPid);
    expect(f.events).not.toContain('rpc:stop');
    expect(f.events).not.toContain('spawn');
    expect(readDeploymentHold()).toBeUndefined();
  });

  it('does not authorize a new owner from listener absence while old process lives', async () => {
    const f = fixture(false);
    let alive = true;
    f.controls.processState = () => alive ? 'alive' : 'dead';
    f.onDelay = () => {
      expect(f.events).not.toContain('spawn');
      expect(f.owner).toBeUndefined();
      alive = false;
    };
    expect(await f.run(), f.error).toBe(0);
    expect(f.events).toContain('delay');
  });

  it('unknown process identity refuses replacement', async () => {
    const f = fixture(false); f.controls.processStart = () => undefined;
    expect(await f.run()).toBe(1);
    expect(f.events).not.toContain('rpc:stop');
    expect(f.owner).toBe(oldPid);
  });

  it('a lost stop reply uses exact old process death, without replaying work', async () => {
    const f = fixture(false); const send = f.controls.sendRpc;
    f.controls.sendRpc = async (...args) => {
      const response = await send(...args);
      if (args[1].cmd === 'stop') throw new RpcOutcomeUnknownError('lost reply');
      return response;
    };
    expect(await f.run(), f.error).toBe(0);
    expect(f.events.filter(event => event === 'rpc:stop')).toHaveLength(1);
  });

  it.each([{status:'running'}, {status:'pending',launch:2}])('a legacy %j record without execution binding gets a typed migration refusal', async record => {
    const f=fixture(false);
    writeFileSync(join(fcGlobalDir(),'tasks.jsonl'),JSON.stringify({id:1,projectDir:f.project,...record})+'\n');
    expect(await f.run()).toBe(1);
    expect(f.error).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
    expect(f.error).toContain('hold-status');
    expect(f.events).not.toContain('build');
    expect(f.events).not.toContain('rpc:stop');
  });

  it('old task records remain listable but require explicit migration', async () => {
    const f = fixture(false);
    writeFileSync(join(fcGlobalDir(), 'tasks.jsonl'), JSON.stringify({ id: 1, status: 'running', projectDir: f.project, run_id: 'bound' }) + '\n');
    expect(await f.run()).toBe(1);
    expect(f.error).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
    expect(f.error).toContain('hold-status');
    expect(f.events).not.toContain('build');
    expect(f.events).not.toContain('rpc:stop');
  });
});


it.each([undefined,'foreign-release','unknown'])('ordinary deploy refuses attested compatibility %s before stopping old control', async compatibility=>{
  const f=fixture(false);
  f.onBuild=()=>{
    const path=join(f.dist,BUILD_MANIFEST_FILENAME);
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    writeFileSync(path,JSON.stringify(reattestCompatibility(manifest,compatibility)));
  };
  expect(await f.run()).toBe(1);
  expect(f.error).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
  for (const command of ['hold','hold-status','continue']) expect(f.error).toContain(command);
  expect(f.owner).toBe(oldPid);
  expect(f.events).not.toContain('rpc:stop');
  expect(f.events).not.toContain('spawn');
});

it('serves terminal legacy task records without granting them execution compatibility', async()=>{
  const f=fixture(false);
  writeFileSync(join(fcGlobalDir(),'tasks.jsonl'),JSON.stringify({id:1,status:'done',projectDir:f.project,run_id:'historic',started_at:oldStartedAt})+'\n');
  expect(await f.run(),f.error).toBe(0);
});


it.each([undefined,'foreign-release','unknown'])('old control manifest compatibility %s is readable but refuses ordinary replacement', async compatibility=>{
  const f=fixture(false), dist=f.identity.distDir!;
  const path=join(dist,BUILD_MANIFEST_FILENAME);
  writeFileSync(path,JSON.stringify(reattestCompatibility(JSON.parse(readFileSync(path,'utf8')),compatibility)));
  f.identity=createDaemonIdentity({socketPath:f.socket,distDir:dist,pid:oldPid,startedAt:oldStartedAt});
  writeDaemonIdentity(f.socket,f.identity);
  expect(await f.run()).toBe(1);
  expect(f.error).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
  expect(f.error).toContain('hold-status');
  expect(f.events).not.toContain('build');
  expect(f.events).not.toContain('rpc:stop');
  expect(f.owner).toBe(oldPid);
});
