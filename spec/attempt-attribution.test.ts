import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { atomicWrite } from '../src/store.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, RunResult } from '../src/adapters/base.js';
import {
  beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, readRunState,
  readStageStatus, setFcGlobalDir, writeRunState,
} from '../src/store.js';
import { readRunEvents, recordStageOutcome } from '../src/run-events.js';
import { runStage } from '../src/worker.js';
import {
  recordThrownStageAttempt,
} from '../src/scheduler/sched_scope/stage-group.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';
import { recordRequest } from '../src/inbox.js';
import { admitPlannerDispatches } from '../src/scheduler/sched_loop/planner-dispatch.js';
import type { StageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { LiveConstraintGuard } from '../src/live-constraint-guard.js';

let root: string, project: string, prior: string;
const role: AgentConfig = {
  name: 'reviewer', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture',
};
const attribution = { role: 'reviewer', iteration: 3 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-attribution-'));
  project = join(root, 'project');
  mkdirSync(project);
  prior = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  setFcGlobalDir(prior);
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // Deliberately no role clue in the stage identifier.
  return createRun(project, 'attribution', 'name: attribution', ['opaque']);
}
function workerOpts(created: ReturnType<typeof fixture>) {
  return {
    stageId: 'opaque', role, attribution, dependsOn: [], promptTemplate: 'fixture',
    timeout_ms: 60000, projectDir: project, runId: created.runId, runDir: created.runDirPath,
    retries: 0, preserveSession: true,
    artifactContract: { version: 1 as const, produces: [], reads: [], replays: [] },
  };
}
const result = (exitCode = 0): RunResult => ({ output: 'fixture', exitCode, duration_ms: 1, tokens_out: 5 });
function events(created: ReturnType<typeof fixture>) {
  const attemptTypes = ['attempt_started', 'attempt_finished', 'attempt_failed', 'attempt_suspended',
    'approval_attempt_suspended', 'attempt_results_updated'];
  return readRunEvents(project, created.runId).filter(event => event.stageId === 'opaque' && attemptTypes.includes(event.type));
}
function settled(created: ReturnType<typeof fixture>) {
  return events(created).filter(event => event.type !== 'attempt_started').at(-1);
}
function startLedger(created: ReturnType<typeof fixture>) {
  beginStageAttempt(project, created.runId, 'opaque', 0, '2026-01-01T00:00:00.000Z', attribution);
}

describe('durable attempt attribution on every publisher', () => {
  it.each([0, 1, 124, 137])('attributes worker start and exit %s independently of stage names', async exitCode => {
    const created = fixture();
    await runStage({ run: async () => result(exitCode) }, workerOpts(created));
    expect(events(created)).toEqual([
      expect.objectContaining({ type: 'attempt_started', ...attribution, disposition: 'pending', attemptIndex: 1 }),
      expect.objectContaining({ type: exitCode === 0 ? 'attempt_finished' : 'attempt_failed',
        ...attribution, disposition: exitCode === 0 ? 'accepted' : 'discarded', attemptIndex: 1 }),
    ]);
    expect(events(created)[0].attemptStartedAt).toBe(events(created)[1].attemptStartedAt);
    expect(readStageStatus(project, created.runId, 'opaque').attempts?.[0]).toMatchObject(attribution);
  });

  it('captures standalone role and iteration before the live state changes', async () => {
    const created = fixture();
    const state = readRunState(project, created.runId);
    state.currentIteration = 3;
    writeRunState(project, created.runId, state);
    const { attribution: _unused, ...opts } = workerOpts(created);
    await runStage({ run: async () => {
      state.currentIteration = 9;
      writeRunState(project, created.runId, state);
      return result();
    } }, opts);
    expect(events(created).every(event => event.role === 'reviewer' && event.iteration === 3)).toBe(true);
    expect(events(created)).toHaveLength(2);
  });

  it('attributes a standalone worker without a run-state projection', async () => {
    const created = fixture();
    rmSync(join(created.runDirPath, 'run.json'));
    const { attribution: _unused, ...opts } = workerOpts(created);
    await runStage({ run: async () => result() }, opts);
    expect(events(created)).toEqual([
      expect.objectContaining({ role: 'reviewer', iteration: 1, disposition: 'pending' }),
      expect.objectContaining({ role: 'reviewer', iteration: 1, disposition: 'accepted' }),
    ]);
  });

  it.each(['scheduler', 'supervisor'] as const)('attributes the worker control signal from %s', async source => {
    const created = fixture();
    await runStage({ run: async () => {
      mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
      atomicWrite(join(created.runDirPath, 'signals', 'abort_opaque.json'), JSON.stringify({
        version: 1, stageId: 'opaque', attemptIndex: 1, source, reason: 'control boundary',
        timestamp: new Date().toISOString(), ...(source === 'scheduler' ? { requestId: 'review' } : {}),
      }));
      return result();
    } }, workerOpts(created));
    expect(settled(created)).toMatchObject({ type: source === 'scheduler' ? 'approval_attempt_suspended' : 'attempt_failed',
      ...attribution, disposition: 'discarded' });
  });

  it.each(['scope_revision', 'approval'] as const)('attributes worker suspension for %s', async suspensionReason => {
    const created = fixture();
    await runStage({ run: async () => ({ ...result(), suspended: true, suspensionReason }) }, workerOpts(created));
    expect(settled(created)).toMatchObject({ type: 'attempt_suspended', ...attribution, disposition: 'discarded' });
  });

  it.each([false, true])('attributes awaited settlement after reconciliation failure=%s', async failed => {
    const created = fixture();
    const execution = runStage({ run: async () => result() }, { ...workerOpts(created), settlementBoundary: async phase => {
      if (phase === 'child_closed') return false;
      expect(events(created)).toHaveLength(1);
      expect(readStageStatus(project, created.runId, 'opaque')).toMatchObject({ status: 'running', attempts: [{ status: 'closed' }] });
      // Current controller metadata cannot replace immutable invocation attribution.
      const state = readRunState(project, created.runId);
      state.currentIteration = 9;
      writeRunState(project, created.runId, state);
      if (failed) throw new Error('reconciliation refused');
      return false;
    } });
    if (failed) await expect(execution).rejects.toThrow('reconciliation refused');
    else await execution;
    expect(settled(created)).toMatchObject({ type: failed ? 'attempt_failed' : 'attempt_finished',
      ...attribution, disposition: failed ? 'discarded' : 'accepted', attemptIndex: 1 });
    expect(readStageStatus(project, created.runId, 'opaque').attempts).toHaveLength(1);
  });

  it.each([false, true])('attributes scheduler throws with worker already started=%s', async started => {
    const created = fixture();
    if (started) startLedger(created);
    recordThrownStageAttempt(project, created.runId, 'opaque', 0, new Error('role or adapter failed'), attribution);
    expect(settled(created)).toMatchObject({ type: 'attempt_failed', ...attribution, disposition: 'discarded', attemptIndex: 1 });
    expect(settled(created)?.attemptStartedAt).toBeDefined();
    expect(readStageStatus(project, created.runId, 'opaque').attempts).toHaveLength(1);
  });

  it('attributes scheduler approval suspension to the settled attempt, including its start identity', async () => {
    const created = fixture();
    startLedger(created);
    completeStageAttempt(project, created.runId, 'opaque', 0, { exitCode: 0, duration_ms: 1 });
    recordRequest({ runId: created.runId, projectDir: project, requestId: 'review', action: 'publish',
      risk: 'external', title: 'Review publication', stageId: 'opaque', createdAt: new Date().toISOString() });
    const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused: () => {} });
    await monitor.tryParkOnApprovalRequest(readRunState(project, created.runId), {
      projectDir: project, runId: created.runId, runDirPath: created.runDirPath, iteration: 9,
    });
    expect(settled(created)).toMatchObject({ type: 'approval_attempt_suspended', ...attribution,
      disposition: 'discarded', attemptIndex: 1, attemptStartedAt: '2026-01-01T00:00:00.000Z' });
  });

  it.each([0, 1])('attributes a live-corrected result with final exit %s', async exitCode => {
    const created = fixture();
    let calls = 0, dirty = false;
    await runStage({ run: async () => {
      if (++calls === 1) dirty = true;
      return result(calls === 1 ? 0 : exitCode);
    } }, { ...workerOpts(created), liveConstraintGuardFactory: ({ attemptIndex }) => new LiveConstraintGuard({
      projectDir: project, runDir: created.runDirPath, stageId: 'opaque', attemptIndex,
      effectiveScope: () => [], watchProject: () => undefined,
      scopeRevisionInstruction: () => 'correct the unauthorized write',
      scanAndRestore: () => {
        if (!dirty) return { scannedPaths: 0, violations: [] };
        dirty = false;
        return { scannedPaths: 1, violations: [{ path: 'product.txt', reason: 'outside scope', restored: true }] };
      },
    }) });
    expect(calls).toBe(2);
    expect(settled(created)).toMatchObject({ ...attribution, disposition: exitCode === 0 ? 'repaired' : 'discarded' });
    expect(readStageStatus(project, created.runId, 'opaque').attempts).toHaveLength(1);
  });

  it('retains the original attribution when another execution supersedes the accepted result', async () => {
    const created = fixture();
    await runStage({ run: async () => result() }, workerOpts(created));
    const second = { role: 'repair', iteration: 4 };
    await runStage({ run: async () => result() }, { ...workerOpts(created), attribution: second });
    expect(events(created).find(event => event.type === 'attempt_results_updated')).toMatchObject({
      ...attribution, disposition: 'superseded', attemptIndex: 1,
    });
    expect(settled(created)).toMatchObject({ ...second, disposition: 'accepted', attemptIndex: 2 });
    const status = readStageStatus(project, created.runId, 'opaque');
    expect(status.attempts?.[0]).toMatchObject({ ...attribution, disposition: 'superseded', tokens_out: 5 });
    expect(status.tokens_out).toBe(10);
    // Both breakdown tools already have this identity: event rows and live-log starts.
    const byStart = new Map(events(created).map(event => [event.attemptStartedAt, event]));
    expect(status.attempts?.map(attempt => byStart.get(attempt.startedAt)?.role)).toEqual(['reviewer', 'repair']);
  });

  it('carries attribution through stage-outcome artifact publication', async () => {
    const created = fixture();
    await runStage({ run: async () => result() }, workerOpts(created));
    const status = readStageStatus(project, created.runId, 'opaque');
    status.artifacts = ['results.json'];
    recordStageOutcome(project, created.runId, 'opaque', 9, status);
    expect(events(created).find(event => event.type === 'attempt_results_updated')).toMatchObject({
      ...attribution, disposition: 'accepted', attemptIndex: 1,
      attemptStartedAt: status.attempts?.[0].startedAt,
    });
  });

  it.each([0, 1])('records refused planner output even with %s retries already used', retries => {
    const created = fixture();
    startLedger(created);
    completeStageAttempt(project, created.runId, 'opaque', 0, { exitCode: 0, duration_ms: 1 });
    setEngineDefaults({ plan_stage_retries: 1 });
    writeFileSync(join(created.runDirPath, 'dispatch.yaml'), 'stages: []\n');
    const planner: StageConfig = { id: 'opaque', role: 'reviewer', depends_on: [], skills: [],
      dynamic_dispatch: true, is_gate: false, criterion_refs: [], prompt_template: 'plan',
      artifact_contract: { version: 1, produces: [], reads: [], replays: [] } };
    admitPlannerDispatches([planner], readRunState(project, created.runId), project, created.runId,
      created.runDirPath, new Map([['reviewer', { name: 'reviewer', description: 'fixture' }]]),
      new Set(), new Map([['opaque', retries]]));
    expect(events(created).find(event => event.type === 'attempt_results_updated')).toMatchObject({
      ...attribution, disposition: 'discarded', attemptIndex: 1,
    });
    expect(readStageStatus(project, created.runId, 'opaque').attempts?.[0].disposition).toBe('discarded');
  });

  it('reports legacy attribution as unknown without borrowing the current plan', () => {
    const created = fixture();
    const state = readRunState(project, created.runId);
    state.currentIteration = 9;
    writeRunState(project, created.runId, state);
    recordThrownStageAttempt(project, created.runId, 'opaque', 0, new Error('legacy failure'));
    expect(settled(created)).toMatchObject({ role: 'unknown', iteration: 0, disposition: 'discarded' });
  });
});
