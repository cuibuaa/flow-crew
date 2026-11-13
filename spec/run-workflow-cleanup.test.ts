import { beforeEach, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import type { WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import type { StoreState } from '../src/store.js';

vi.hoisted(() => vi.resetModules());
const fixture = vi.hoisted(() => ({
  state: undefined as unknown as StoreState,
  calls: [] as string[],
  events: [] as { type: string; timestamp: string }[],
  admitted: false,
  reject: vi.fn(),
  read: vi.fn(),
  iterations: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/run-events.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/run-events.js')>(), recordRunEvent: (_project: string, _run: string, event: { type: string; timestamp: string }) => { fixture.events.push(event); },
}));
vi.mock('../src/jsonl.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/jsonl.js')>(),
  readOptionalJsonlFile: () => fixture.events,
}));
vi.mock('../src/adapters/base.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/base.js')>(),
  withRunProcessOwnership: async (_project: string, _run: string, body: () => unknown) => body(),
}));
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
vi.mock('../src/scheduler/sched_scope/frozen-inputs.js', () => ({ bindFrozenInputs: vi.fn() }));
vi.mock('../src/store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/store.js')>(),
  readRunState: (...args: unknown[]) => fixture.read(...args),
  runDir: () => '/workspace/run',
  updateRunState: (_project: string, _run: string, update: (state: StoreState) => void, afterCommit?: (state: StoreState) => void) => {
    update(fixture.state); afterCommit?.(fixture.state); return fixture.state;
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
vi.mock('../src/scheduler/sched_loop/services.js', () => ({ writeCampaignEntry: vi.fn() }));

import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';
const invoke = () => runWorkflow({ name: 'fixture' } as WorkflowConfig, '', '/workspace/project', {} as Adapter, new Map());
beforeEach(() => {
  fixture.state = { runId: 'fixture', projectDir: '/workspace/project', status: 'running', stages: {} } as StoreState;
  fixture.calls = [];
  fixture.events = [];
  fixture.admitted = false;
  fixture.read.mockImplementation(() => { throw new Error('Unexpected terminal state reread'); });
  fixture.iterations.mockImplementation(async () => { fixture.state.status = 'complete'; return fixture.state; });
});

it('releases scheduler ownership after an ordinary workflow completes', async () => {
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.calls).toEqual(['remove-pid', 'release-intent']);
  expect(fixture.read).not.toHaveBeenCalled();
});

it('returns an already settled launch without taking cleanup ownership', async () => {
  fixture.admitted = true; fixture.state.status = 'failed';
  await expect(invoke()).resolves.toBe(fixture.state);
  expect(fixture.calls).toEqual([]);
});
