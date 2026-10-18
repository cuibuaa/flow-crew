import { beforeEach, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import type { WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import type { StoreState } from '../src/store.js';

const fixture = vi.hoisted(() => ({
  state: undefined as unknown as StoreState,
  calls: [] as string[],
  admitted: false,
  reject: vi.fn(),
  read: vi.fn(),
  iterations: vi.fn(),
  close: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/research-candidate.js', () => ({
  rejectPendingResearchGateCandidates: (...args: unknown[]) => { fixture.calls.push('settle'); fixture.reject(...args); },
}));
vi.mock('../src/adapters/base.js', () => ({ withRunProcessOwnership: async (_project: string, _run: string, body: () => unknown) => body() }));
vi.mock('../src/restart-recovery.js', () => ({ captureEngineCheckpoint: () => ({}) }));
vi.mock('../src/run-lock.js', () => ({
  releaseLaunchIntent: () => { fixture.calls.push('release-intent'); },
  invalidateRunLockCache: vi.fn(),
}));
vi.mock('../src/scheduler-heartbeat.js', () => ({ startSchedulerHeartbeat: () => ({ ready: Promise.resolve(), stop: async () => {} }) }));
vi.mock('../src/scheduler/sched_admission/configuration.js', () => ({ loadDefaults: () => ({}) }));
vi.mock('../src/scheduler/sched_admission/dispatch.js', () => ({
  loadBasePrompt: () => '', applyBasePrompt: (agent: unknown) => agent,
  buildRoleRegistry: () => new Map(), listAvailableSkills: () => [],
}));
vi.mock('../src/scheduler/sched_admission/shared.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => fixture.error(...args) } }));
vi.mock('../src/scheduler/sched_policy/identity.js', () => ({ removeSchedulerPidIfOwned: () => { fixture.calls.push('remove-pid'); } }));
vi.mock('../src/scheduler/sched_scope/rollback-baseline.js', () => ({ closeRollbackBaseline: () => fixture.close() }));
vi.mock('../src/store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/store.js')>(),
  readRunState: (...args: unknown[]) => fixture.read(...args),
  runDir: () => '/workspace/run',
  updateRunState: (_project: string, _run: string, update: (state: StoreState) => void) => {
    update(fixture.state); return fixture.state;
  },
}));
vi.mock('../src/stage-watchdog.js', () => ({ StageWatchdog: class { start() {} stop() {} } }));
vi.mock('../src/scheduler/sched_loop/brief.js', () => ({ configureWorkflowBrief: () => ({ kind: 'configured' }) }));
vi.mock('../src/scheduler/sched_loop/launch.js', () => ({ prepareWorkflowLaunch: () => fixture.admitted
  ? { kind: 'settled', state: fixture.state }
  : { kind: 'ready', runId: 'fixture', runDirPath: '/workspace/run', maxIterations: 1,
    baseStages: [], resumingExistingRun: false, resumeAtIteration: 1, schedulerPidPath: '/workspace/run/scheduler.pid',
    launchIntentOwned: true, workflowYaml: '' },
}));
vi.mock('../src/scheduler/sched_loop/workflow-loop.js', () => ({ runWorkflowIterations: () => fixture.iterations() }));
vi.mock('../src/scheduler/sched_loop/iteration-outcome.js', () => ({ publishRunCompletion: vi.fn() }));

import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';
const invoke = () => runWorkflow({ name: 'fixture' } as WorkflowConfig, '', '/workspace/project', {} as Adapter, new Map());
beforeEach(() => {
  fixture.state = { runId: 'fixture', status: 'running', stages: {}, research: { baseline: 0, policy: 'best_of_n' } } as StoreState;
  fixture.calls = [];
  fixture.admitted = false;
  fixture.read.mockImplementation(() => { throw new Error('Unexpected terminal state reread'); });
  fixture.iterations.mockImplementation(async () => { fixture.state.status = 'complete'; return fixture.state; });
});

it('settles terminal research candidates before releasing scheduler ownership', async () => {
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.calls).toEqual(['settle', 'remove-pid', 'release-intent']);
  expect(fixture.read).not.toHaveBeenCalled();
});

it('does no candidate IO or terminal state reread for an ordinary workflow', async () => {
  delete fixture.state.research;
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.reject).not.toHaveBeenCalled();
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.calls).toEqual(['remove-pid', 'release-intent']);
});

it.each(['complete', 'failed'] as const)('records candidate cleanup failure without replacing a %s result', async status => {
  const cleanupError = new Error('Synthetic unreadable candidate');
  fixture.reject.mockImplementation(() => { throw cleanupError; });
  if (status === 'failed') fixture.iterations.mockRejectedValue(new Error('Original scheduler failure'));
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.state.status).toBe(status);
  if (status === 'failed') expect(fixture.state.failureReason).toBe('Scheduler failed: Original scheduler failure');
  expect(fixture.error).toHaveBeenCalledWith({ err: cleanupError, runId: 'fixture' }, 'Failed to settle pending research gate candidates');
  expect(fixture.calls).toEqual(['settle', 'remove-pid', 'release-intent']);
});

it('does not mask an escaping lifecycle exception with candidate cleanup failure', async () => {
  const original = new Error('Original owned cleanup failure');
  const cleanup = new Error('Synthetic candidate failure');
  fixture.close.mockImplementation(() => { throw original; });
  fixture.reject.mockImplementation(() => { throw cleanup; });
  await expect(invoke()).rejects.toBe(original);
  expect(fixture.error).toHaveBeenCalledWith({ err: cleanup, runId: 'fixture' }, 'Failed to settle pending research gate candidates');
});

it('uses the same best effort research-only cleanup for a terminal launch refusal', async () => {
  fixture.admitted = true;
  fixture.state.status = 'failed';
  const cleanup = new Error('Synthetic candidate failure');
  fixture.reject.mockImplementation(() => { throw cleanup; });
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.error).toHaveBeenCalledWith({ err: cleanup, runId: 'fixture' }, 'Failed to settle pending research gate candidates');
  expect(fixture.calls).toEqual(['settle']);
});

it('leaves parked research candidates pending', async () => {
  fixture.iterations.mockImplementation(async () => { fixture.state.status = 'parked'; return fixture.state; });
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.reject).not.toHaveBeenCalled();
});
