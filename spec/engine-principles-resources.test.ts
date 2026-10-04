import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStartToken, processStartTokensMatch } from '../src/run-lock.js';
import { captureResourceLeaseOwner, observeResourceLeaseOwner, readDiskHeadroom, readHostBootId, readResourceLeaseRegistry, ResourceLeaseRegistry, resourceLeaseRegistryPath, type ResourceLeaseOwner, type ResourceLeaseRequest, type ResourceOwnerObservation } from '../src/resource-leases.js';

let root: string, registryPath: string;
const at = '2026-10-03T00:00:00.000Z';
const repositoryRoot = join(import.meta.dirname, '..');
const owner = (runId = 'run-a'): ResourceLeaseOwner => ({ runId, stageId: 'work', attemptIndex: 1, attemptStartedAt: at, generation: 'generation-a', bootId: 'synthetic-boot-a', pid: 100, processStart: { kind: 'linux', value: '1000' } });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flowcrew-resource-leases-')); registryPath = join(root, 'registry.sqlite'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function registry(observation: ResourceOwnerObservation = { kind: 'unknown', reason: 'synthetic identity cannot be proven' }) {
  return new ResourceLeaseRegistry({ registryPath, now: () => at, gpuInventory: () => ({ cardIds: ['card-a', 'card-b'], observedAt: at }), diskHeadroom: (path) => ({ path, filesystemId: 'same-filesystem', availableBytes: 1000, observedAt: at }), observeOwner: () => observation });
}
function request(requestId = 'claim-a', extra: Partial<ResourceLeaseRequest> = {}): ResourceLeaseRequest { return { version: 1, requestId, owner: owner(), gpuCards: ['card-a'], ...extra }; }
function requiredLease(result: ReturnType<ResourceLeaseRegistry['acquire']>) { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason); return result; }

describe('engine resource reservation and identity-bound reconciliation', () => {
  it('keeps queries read-only and requires explicit supported declarations', () => {
    expect(readResourceLeaseRegistry(registryPath).status).toBe('absent');
    expect(existsSync(registryPath)).toBe(false);
    expect(resourceLeaseRegistryPath(root)).toBe(join(root, 'resource-leases.v1.sqlite'));
    expect(() => new ResourceLeaseRegistry({ registryPath: 'relative.sqlite' })).toThrow('RESOURCE_REGISTRY_PATH_REQUIRED');
    expect(() => registry().acquire(request('duplicate', { gpuCards: ['card-a', 'card-a'] }))).toThrow('RESOURCE_REQUEST_INVALID');
    expect(() => registry().acquire(request('none', { gpuCards: [] }))).toThrow('RESOURCE_REQUEST_INVALID');
    expect(() => registry().acquire(request('bad-stage', { owner: { ...owner(), stageId: '../foreign' } }))).toThrow();
    expect(() => registry().acquire(request('bad-size', { gpuCards: [], disk: [{ path: root, bytes: Number.NaN }] }))).toThrow();
    const unavailable = new ResourceLeaseRegistry({ registryPath, now: () => at });
    expect(unavailable.acquire(request())).toMatchObject({ ok: false, code: 'GPU_INVENTORY_REQUIRED' });
    expect(readResourceLeaseRegistry(registryPath).status).toBe('available');
  });

  it('arbitrates independent engine clients and records an idempotent request without double allocation', () => {
    const first = requiredLease(registry().acquire(request()));
    expect(registry().acquire(request())).toMatchObject({ ok: true, replayed: true, handle: first.handle });
    expect(registry().acquire(request('claim-b', { owner: owner('run-b') }))).toMatchObject({ ok: false, code: 'GPU_BUSY', blockingLeaseIds: [first.lease.leaseId] });
    expect(() => registry().acquire(request('claim-a', { gpuCards: ['card-b'] }))).toThrow('RESOURCE_REQUEST_CONFLICT');
    const snapshot = registry().read();
    expect(snapshot.status).toBe('available');
    if (snapshot.status === 'available') {
      expect(snapshot.snapshot.leases).toHaveLength(1);
      expect(snapshot.snapshot.history.map((event) => event.kind)).toEqual(['acquired', 'refused']);
    }
  });

  it('makes a multi-resource request atomic when one GPU or disk requirement is refused', () => {
    requiredLease(registry().acquire(request()));
    expect(registry().acquire(request('both', { gpuCards: ['card-a', 'card-b'] }))).toMatchObject({ ok: false, code: 'GPU_BUSY' });
    expect(registry().acquire(request('disk-short', { gpuCards: ['card-b'], disk: [{ path: root, bytes: 1001 }] }))).toMatchObject({ ok: false, code: 'DISK_HEADROOM' });
    requiredLease(registry().acquire(request('other-card', { gpuCards: ['card-b'] })));
    const snapshot = registry().read();
    if (snapshot.status !== 'available') throw new Error('missing registry');
    expect(snapshot.snapshot.leases).toHaveLength(2);
    expect(snapshot.snapshot.leases.every((lease) => !['both', 'disk-short'].includes(lease.requestId))).toBe(true);
  });

  it('groups disk aliases, sums requested paths and preserves each active minimum-free floor', () => {
    const firstPath = join(root, 'one'), secondPath = join(root, 'two');
    expect(registry().acquire(request('same-fs', { gpuCards: [], disk: [{ path: firstPath, bytes: 600 }, { path: secondPath, bytes: 500 }] }))).toMatchObject({ ok: false, code: 'DISK_HEADROOM' });
    const first = requiredLease(registry().acquire(request('floor', { gpuCards: [], disk: [{ path: firstPath, bytes: 400, minimumFreeBytes: 200 }] })));
    expect(registry().acquire(request('ignores-floor', { owner: owner('run-b'), gpuCards: [], disk: [{ path: secondPath, bytes: 450 }] }))).toMatchObject({ ok: false, code: 'DISK_HEADROOM', blockingLeaseIds: [first.lease.leaseId] });
    requiredLease(registry().acquire(request('fits-floor', { owner: owner('run-b'), gpuCards: [], disk: [{ path: secondPath, bytes: 400 }] })));
  });

  it('refuses unknown identities and stale or invalid resource measurements', () => {
    expect(registry().acquire(request('unknown-card', { gpuCards: ['absent-card'] }))).toMatchObject({ ok: false, code: 'GPU_UNKNOWN' });
    const stale = new ResourceLeaseRegistry({ registryPath, now: () => at, gpuInventory: () => ({ cardIds: ['card-a'], observedAt: '2026-10-02T00:00:00.000Z' }) });
    expect(stale.acquire(request('old-observation'))).toMatchObject({ ok: false, code: 'RESOURCE_OBSERVATION_STALE' });
    const future = new ResourceLeaseRegistry({ registryPath, now: () => at, diskHeadroom: (path) => ({ path, filesystemId: 'disk', availableBytes: 1000, observedAt: '2026-10-04T00:00:00.000Z' }) });
    expect(future.acquire(request('future-observation', { gpuCards: [], disk: [{ path: root, bytes: 1 }] }))).toMatchObject({ ok: false, code: 'RESOURCE_OBSERVATION_STALE' });
    const duplicates = new ResourceLeaseRegistry({ registryPath, now: () => at, gpuInventory: () => ({ cardIds: ['card-a', 'card-a'], observedAt: at }) });
    expect(duplicates.acquire(request('duplicate-inventory'))).toMatchObject({ ok: false, code: 'GPU_INVENTORY_INVALID' });
    const invalid = new ResourceLeaseRegistry({ registryPath, now: () => at, diskHeadroom: (path) => ({ path, filesystemId: 'disk', availableBytes: -1, observedAt: at }) });
    expect(() => invalid.acquire(request('invalid-disk', { gpuCards: [], disk: [{ path: root, bytes: 1 }] }))).toThrow();
  });

  it('never expires a live or unknown owner and requires exact owner/fence binding', () => {
    const first = requiredLease(registry({ kind: 'live', reason: 'identity-bound live holder' }).acquire(request()));
    const later = new ResourceLeaseRegistry({ registryPath, now: () => '2026-11-03T00:00:00.000Z', gpuInventory: () => ({ cardIds: ['card-a'], observedAt: '2026-11-03T00:00:00.000Z' }), observeOwner: () => ({ kind: 'live', reason: 'still live' }) });
    expect(later.reconcile()[0]).toMatchObject({ released: false, observation: { kind: 'live' } });
    expect(later.acquire(request('after-month'))).toMatchObject({ ok: false, code: 'GPU_BUSY' });
    expect(() => later.release(first.handle, { kind: 'owner_dead' })).toThrow('LEASE_RELEASE_UNPROVEN');
    expect(() => registry().release(first.handle, { kind: 'owner_dead' })).toThrow('LEASE_RELEASE_UNPROVEN');
    expect(() => registry().release({ ...first.handle, fence: first.handle.fence + 1 }, { kind: 'owner_dead' })).toThrow('LEASE_FENCE_MISMATCH');
    expect(() => registry().release({ ...first.handle, owner: owner('foreign-run') }, { kind: 'owner_dead' })).toThrow('LEASE_FENCE_MISMATCH');
    expect(registry().reconcile()[0]).toMatchObject({ released: false, observation: { kind: 'unknown' } });
  });

  it('reconciles proven prior-boot death and preserves increasing fences and history', () => {
    const first = requiredLease(registry().acquire(request()));
    const afterRestart = registry({ kind: 'dead', reason: 'different proven host boot' });
    expect(afterRestart.reconcile()).toEqual([{ leaseId: first.lease.leaseId, observation: { kind: 'dead', reason: 'different proven host boot' }, released: true }]);
    expect(() => afterRestart.acquire(request())).toThrow('RESOURCE_REQUEST_CONFLICT');
    const second = requiredLease(afterRestart.acquire(request('claim-new-boot', { owner: { ...owner(), bootId: 'synthetic-boot-b' } })));
    expect(second.handle.fence).toBeGreaterThan(first.handle.fence);
    expect(afterRestart.release(first.handle, { kind: 'owner_dead' }).status).toBe('released');
    expect(afterRestart.acquire(request('third'))).toMatchObject({ ok: false, code: 'GPU_BUSY', blockingLeaseIds: [second.lease.leaseId] });
    const snapshot = afterRestart.read();
    if (snapshot.status !== 'available') throw new Error('missing registry');
    expect(snapshot.snapshot.history.map((event) => event.kind)).toEqual(['acquired', 'released', 'acquired', 'refused']);
  });

  it('releases only a matching settled attempt with child exit evidence', () => {
    const first = requiredLease(registry().acquire(request()));
    const runDirectory = join(root, 'run-a');
    const stageDirectory = join(runDirectory, 'stages', 'work');
    mkdirSync(stageDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({ runId: 'run-a' }));
    const statusPath = join(stageDirectory, 'status.json');
    const settled = { index: 1, startedAt: at, completedAt: '2026-10-03T00:01:00.000Z', status: 'complete', exitCode: 0 };
    const write = (entry: unknown) => writeFileSync(statusPath, JSON.stringify({ attempts: [entry] }));
    write({ ...settled, startedAt: '2026-10-03T00:02:00.000Z' });
    expect(() => registry().release(first.handle, { kind: 'attempt_finished', runDirectory })).toThrow('LEASE_RELEASE_UNPROVEN');
    write({ ...settled, exitCode: null });
    expect(() => registry().release(first.handle, { kind: 'attempt_finished', runDirectory })).toThrow('LEASE_RELEASE_UNPROVEN');
    write({ ...settled, status: 'running' });
    expect(() => registry().release(first.handle, { kind: 'attempt_finished', runDirectory })).toThrow('LEASE_RELEASE_UNPROVEN');
    write(settled);
    expect(() => registry().release(first.handle, { kind: 'attempt_finished', runDirectory })).toThrow('consumer-closure verifier');
    const closureVerified = new ResourceLeaseRegistry({ registryPath, now: () => at, verifyAttemptClosure: () => ({ kind: 'closed', evidence: 'synthetic foreground consumers have closed' }) });
    const released = closureVerified.release(first.handle, { kind: 'attempt_finished', runDirectory });
    expect(released.release).toMatchObject({ kind: 'attempt_finished', evidence: expect.stringContaining('sha256=') });
    requiredLease(registry().acquire(request('successor', { owner: owner('run-b') })));
  });

  it('retains an exited same-boot controller while its real owned bounded child survives', { timeout: 10000 }, async () => {
    const marker = join(root, 'child-closed');
    const childSource = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed'); process.exit(0); }, 1500);`;
    const source = `
      import { spawn } from 'node:child_process';
      import { captureResourceLeaseOwner } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'dist', 'resource-leases.js')).href)};
      import { processStartToken } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'dist', 'run-lock.js')).href)};
      const owner = captureResourceLeaseOwner({runId:'owned-parent',stageId:'fixture',attemptIndex:1,attemptStartedAt:${JSON.stringify(at)},generation:'fixture'});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {stdio:'ignore'});
      await new Promise(resolve => setTimeout(resolve, 25));
      process.stdout.write(JSON.stringify({owner,childPid:child.pid,childStart:processStartToken(child.pid)}));
      process.exit(0);
    `;
    let info: { owner: ResourceLeaseOwner; childPid: number; childStart: ReturnType<typeof processStartToken> } | undefined;
    try {
      const parent = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: repositoryRoot, env: { ...process.env, HOME: root, FC_HOME: join(root, 'private-store') }, encoding: 'utf8', timeout: 5000 });
      expect(parent.status, parent.stderr).toBe(0);
      info = JSON.parse(parent.stdout);
      expect(existsSync(marker)).toBe(false);
      expect(observeResourceLeaseOwner(info!.owner).kind).toBe('unknown');
      if (info!.childStart) expect(processStartTokensMatch(info!.childStart, processStartToken(info!.childPid))).toBe(true);
      const deadline = Date.now() + 3000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (info && !existsSync(marker) && processStartTokensMatch(info.childStart, processStartToken(info.childPid))) {
        try { process.kill(info.childPid, 'SIGKILL'); } catch { /* already closed */ }
      }
    }
  });

  it('preserves malformed registry data and refuses both reads and further acquisitions', () => {
    requiredLease(registry().acquire(request()));
    const db = new DatabaseSync(registryPath);
    try { db.prepare('UPDATE resource_registry SET data = ? WHERE id = 1').run(JSON.stringify({ version: 2, leases: [] })); } finally { db.close(); }
    expect(() => readResourceLeaseRegistry(registryPath)).toThrow('RESOURCE_REGISTRY_INVALID');
    expect(() => registry().acquire(request('new'))).toThrow('RESOURCE_REGISTRY_INVALID');
    const after = new DatabaseSync(registryPath, { readOnly: true });
    try { expect(after.prepare('SELECT data FROM resource_registry WHERE id = 1').get()?.data).toBe('{"version":2,"leases":[]}'); } finally { after.close(); }
  });

  it('observes real disk identity and its own process without GPU discovery or signalling', () => {
    const disk = readDiskHeadroom(root);
    expect(disk.availableBytes).toBeGreaterThanOrEqual(0);
    expect(disk.filesystemId).toBeTruthy();
    const self = captureResourceLeaseOwner({ runId: 'run-a', stageId: 'work', attemptIndex: 1, attemptStartedAt: at, generation: 'fixture' });
    expect(self.pid).toBe(process.pid);
    expect(observeResourceLeaseOwner(self).kind).toBe(readHostBootId() && self.processStart?.kind === 'linux' ? 'live' : 'unknown');
    expect(observeResourceLeaseOwner({ ...self, bootId: undefined }).kind).toBe('unknown');
    if (readHostBootId()) expect(observeResourceLeaseOwner({ ...self, bootId: 'a-different-boot' }).kind).toBe('dead');
    const acquired = new ResourceLeaseRegistry({ registryPath }).acquire(request('default-disk', { gpuCards: [], disk: [{ path: root, bytes: 1 }] }));
    expect(acquired.ok).toBe(true);
  });

  it('keeps module loading and absent-registry queries usable when SQLite is unavailable, and refuses acquisition precisely', () => {
    const source = `
      import fs from 'node:fs';
      import Module from 'node:module';
      const original = Module._load;
      Module._load = function(name, ...args) { if (name === 'node:sqlite') throw new Error('synthetic unavailable builtin'); return original.call(this, name, ...args); };
      const { ResourceLeaseRegistry, readResourceLeaseRegistry } = await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'dist', 'resource-leases.js')).href)});
      const before = readResourceLeaseRegistry(${JSON.stringify(registryPath)});
      let code;
      try { new ResourceLeaseRegistry({ registryPath: ${JSON.stringify(registryPath)} }).acquire(${JSON.stringify(request())}); } catch (error) { code = error.code; }
      process.stdout.write(JSON.stringify({ absent: before.status, code, fileExists: fs.existsSync(${JSON.stringify(registryPath)}) }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: repositoryRoot, env: { ...process.env, HOME: root, FC_HOME: join(root, 'private-store') }, encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ absent: 'absent', code: 'RESOURCE_REGISTRY_UNAVAILABLE', fileExists: false });
  });

  it('allows exactly one of six real concurrent processes to acquire one synthetic card', { timeout: 20000 }, async () => {
    const moduleUrl = pathToFileURL(join(repositoryRoot, 'dist', 'resource-leases.js')).href;
    const gate = join(root, 'start');
    const children: Array<ReturnType<typeof spawn>> = [];
    try {
      const results = Array.from({ length: 6 }, (_, index) => {
        const source = `
          import { existsSync, writeFileSync } from 'node:fs';
          import { ResourceLeaseRegistry } from ${JSON.stringify(moduleUrl)};
          writeFileSync(${JSON.stringify(join(root, `ready-${index}`))}, 'ready');
          const deadline = Date.now() + 5000;
          while (!existsSync(${JSON.stringify(gate)})) { if (Date.now() > deadline) throw new Error('start barrier expired'); await new Promise(resolve => setTimeout(resolve, 5)); }
          const registry = new ResourceLeaseRegistry({ registryPath: ${JSON.stringify(registryPath)}, now: () => ${JSON.stringify(at)}, gpuInventory: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); return { cardIds: ['synthetic-card'], observedAt: ${JSON.stringify(at)} }; }, busyTimeoutMs: 5000 });
          const startedAtMs = Date.now();
          const result = registry.acquire({ version: 1, requestId: 'process-${index}', owner: ${JSON.stringify(owner(`run-${index}`))}, gpuCards: ['synthetic-card'] });
          process.stdout.write(JSON.stringify({ ...result, startedAtMs, finishedAtMs: Date.now() }));
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: repositoryRoot, env: { ...process.env, HOME: root, FC_HOME: join(root, 'private-store'), FLOWCREW_DAEMON_SOCKET: join(root, 'unavailable.sock') }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
          let stdout = '', stderr = '';
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned lease-test child timed out')); }, 10000);
          child.stdout!.on('data', (data) => { stdout += data; });
          child.stderr!.on('data', (data) => { stderr += data; });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }); });
        });
      });
      const readyDeadline = Date.now() + 5000;
      while (!Array.from({ length: 6 }, (_, index) => existsSync(join(root, `ready-${index}`))).every(Boolean) && Date.now() < readyDeadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      expect(Array.from({ length: 6 }, (_, index) => existsSync(join(root, `ready-${index}`))).every(Boolean)).toBe(true);
      writeFileSync(gate, 'go');
      const settled = await Promise.all(results);
      for (const result of settled) expect(result.code, result.stderr).toBe(0);
      const decisions = settled.map((result) => JSON.parse(result.stdout));
      // Every acquisition call entered before the first finished. The slow
      // synthetic inventory holds the real SQLite transaction, exposing races
      // that a cold-start-only parallel launch could accidentally serialize.
      expect(Math.max(...decisions.map((decision) => decision.startedAtMs))).toBeLessThan(Math.min(...decisions.map((decision) => decision.finishedAtMs)));
      expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
      expect(decisions.filter((decision) => !decision.ok).every((decision) => decision.code === 'GPU_BUSY')).toBe(true);
      const snapshot = readResourceLeaseRegistry(registryPath);
      if (snapshot.status !== 'available') throw new Error('missing concurrent registry');
      expect(snapshot.snapshot.leases).toHaveLength(1);
      expect(snapshot.snapshot.history).toHaveLength(6);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(readFileSync(gate, 'utf8')).toBe('go');
  });
});
