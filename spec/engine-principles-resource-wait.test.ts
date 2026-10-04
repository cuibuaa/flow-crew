import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { ResourceLeaseRegistry, captureResourceLeaseOwner } from '../src/resource-leases.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runStage, type StageOpts } from '../src/worker.js';

let root: string, project: string, previousStore: string, runId: string, directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-resource-wait-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['writer']).runId; directory = runDir(project, runId);
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
function options(registry?: ResourceLeaseRegistry, timeout_ms = 4000): StageOpts {
  return { stageId: 'writer', role: { name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Synthetic resource fixture.' }, dependsOn: [], promptTemplate: 'Execute declared work.', artifactContract: { version: 1, produces: [], reads: [], groups: [] }, timeout_ms, projectDir: project, runId, runDir: directory, retries: 0, resources: { gpu_cards: ['synthetic-card'], disk: [] }, resourceRegistry: registry };
}
function expose(registry: ResourceLeaseRegistry) {
  updateRunState(project, runId, (state) => { state.queryState = { version: 1, resourceRegistryPath: registry.path }; });
}
async function waitForWait() {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const view = readRunStateView(project, runId);
    if (view.resourceWaits.length) return view;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('No observable resource wait at the engine boundary');
}

describe('resource contention waits within the existing attempt deadline', () => {
  it('exposes a wait and invokes only after a trusted holder death releases the synthetic card', async () => {
    let stopped = false, calls = 0;
    const registry = new ResourceLeaseRegistry({ registryPath: join(root, 'resources.sqlite'), gpuInventory: () => ({ cardIds: ['synthetic-card'], observedAt: new Date().toISOString() }), observeOwner: (owner) => owner.stageId === 'holder' && stopped ? { kind: 'dead', reason: 'Trusted synthetic prior-boot death' } : { kind: 'unknown', reason: 'All consumer closure is not yet proven' } });
    expose(registry);
    const holder = registry.acquire({ version: 1, requestId: 'holder', owner: captureResourceLeaseOwner({ runId, stageId: 'holder', attemptIndex: 1, attemptStartedAt: new Date().toISOString(), generation: 'fixture' }), gpuCards: ['synthetic-card'], disk: [] });
    expect(holder.ok).toBe(true);
    const adapter: Adapter = { async run() { calls++; return { output: 'done', exitCode: 0, duration_ms: 1 }; } };
    const work = runStage(adapter, options(registry));
    try {
      const waiting = await waitForWait(); expect(waiting.resourceWaits[0].reason).toContain('GPU_BUSY'); expect(calls).toBe(0);
      expect(waiting.stages.writer.attempts?.at(-1)?.status).toBe('running');
    } finally { stopped = true; await work; }
    const result = await work;
    expect(result.exitCode).toBe(0); expect(calls).toBe(1);
    const final = readRunStateView(project, runId); expect(final.resourceWaits).toEqual([]);
    expect(final.stages.writer.attempts).toHaveLength(1);
    expect(final.events.rows.filter((row) => row.type === 'resource_lease_wait_finished')).toHaveLength(1);
    const read = registry.read(); if (read.status !== 'available') throw Error('No registry');
    expect(read.snapshot.leases.map((lease) => lease.status)).toEqual(['released', 'active']);
  });

  it('times out truthfully without invoking a model or releasing an unknown holder', async () => {
    const registry = new ResourceLeaseRegistry({ registryPath: join(root, 'resources.sqlite'), gpuInventory: () => ({ cardIds: ['synthetic-card'], observedAt: new Date().toISOString() }), observeOwner: () => ({ kind: 'unknown', reason: 'Unknown descendant fate' }) });
    expose(registry);
    registry.acquire({ version: 1, requestId: 'holder', owner: captureResourceLeaseOwner({ runId, stageId: 'holder', attemptIndex: 1, attemptStartedAt: new Date().toISOString(), generation: 'fixture' }), gpuCards: ['synthetic-card'], disk: [] });
    let calls = 0;
    const result = await runStage({ async run() { calls++; return { output: 'unexpected', exitCode: 0, duration_ms: 1 }; } }, options(registry, 150));
    expect(result.exitCode).toBe(124); expect(result.timedOut).toBe(true); expect(calls).toBe(0); expect(result.output).toContain('GPU_BUSY');
    expect(readRunStateView(project, runId).resourceWaits).toEqual([]);
    const read = registry.read(); if (read.status !== 'available') throw Error('No registry');
    expect(read.snapshot.leases).toHaveLength(1); expect(read.snapshot.leases[0].status).toBe('active');
  });

  it('refuses an absent inventory provider immediately, without a contention wait', async () => {
    let calls = 0;
    const result = await runStage({ async run() { calls++; return { output: 'unexpected', exitCode: 0, duration_ms: 1 }; } }, options());
    expect(result.exitCode).toBe(1); expect(result.output).toContain('GPU_INVENTORY_REQUIRED'); expect(calls).toBe(0);
    expect(readRunStateView(project, runId).events.rows.some((row) => row.type === 'resource_lease_wait_started')).toBe(false);
  });

  it('waits for synthetic disk headroom and deduplicates identical reservation observations', async () => {
    let free = 100, calls = 0;
    const registry = new ResourceLeaseRegistry({ registryPath: join(root, 'resources.sqlite'), diskHeadroom: (path) => ({ path, filesystemId: 'synthetic-fs', availableBytes: free, observedAt: new Date().toISOString() }) });
    expose(registry);
    const opts = options(registry); opts.resources = { gpu_cards: [], disk: [{ root: 'project', path: '.', bytes: 200, minimum_free_bytes: 20 }] };
    const work = runStage({ async run() { calls++; return { output: 'done', exitCode: 0, duration_ms: 1 }; } }, opts);
    try { expect((await waitForWait()).resourceWaits[0].reason).toContain('DISK_HEADROOM'); expect(calls).toBe(0); }
    finally { free = 500; await work; }
    expect((await work).exitCode).toBe(0); expect(calls).toBe(1);
    const request = { version: 1 as const, requestId: 'another', owner: captureResourceLeaseOwner({ runId, stageId: 'holder', attemptIndex: 1, attemptStartedAt: new Date().toISOString(), generation: 'fixture' }), gpuCards: [], disk: [{ path: project, bytes: 600, minimumFreeBytes: 0 }] };
    expect(registry.acquire(request)).toMatchObject({ ok: false, code: 'DISK_HEADROOM' });
    const first = registry.read(); for (let index = 0; index < 10; index++) registry.acquire(request);
    const second = registry.read(); expect(second).toEqual(first);
  });
});
