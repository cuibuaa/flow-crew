import { readEvidence } from '../src/evidence-ledger.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { stageWorkPath, runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import './test-support/policy-runtime.js';
import * as contractProbe from '../src/stage-artifact-contract.js';
import { providerFailureFromEvent, providerFailureFromDiagnostic } from '../src/provider-result.js';
import { atomicWrite } from '../src/engine-fs.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { withRunProcessOwnership } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { HANDOFF_SCHEMA, RECORDED_HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, attachStageConstraintAudit, isContinuingStage, runDir, readRunState, readStageStatus, updateRunState, writeStageStatus } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { WorkflowConfigSchema, normalizeStageContracts, findAllReady, tryTerminateOnTerminalState, runWorkflow } from '../src/scheduler.js';
import { StageWatchdog } from '../src/stage-watchdog.js';
import { recordGateValidationDelta, settledGateValidationExecution } from '../src/scheduler/sched_settlement/gate-validation.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../src/scheduler/sched_policy/terminal.js';
import { decideStageRetry, executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { executeIteration } from '../src/scheduler/sched_loop/iteration.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { prepareWorkflowIteration } from '../src/scheduler/sched_loop/iteration-setup.js';
import { prepareWorkflowLaunch, workflowContinuation } from '../src/scheduler/sched_loop/launch.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
const role: AgentConfig = { name: 'coder', description: '', model: 'fixture', reasoning_effort: 'default', tools: ['default'], prompt: 'Complete the declared duties.' };
const budget = 20000;
function manualClock() {
  let elapsed = 0;
  const started = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, {
    at: number;
    callback: () => void;
  }>();
  const clock: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
    setTimer(callback, delay) { const timer = {} as ReturnType<typeof setTimeout>; timers.set(timer, { at: elapsed + delay, callback }); return timer; },
    clearTimer(timer) { timers.delete(timer); } };
  return { clock, timers, advanceTo(value: number) {
      elapsed = value;
      for (const [timer, entry] of [...timers])
        if (entry.at <= elapsed) {
          timers.delete(timer);
          entry.callback();
        }
    } };
}
let root: string, project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-stage-budget-'));
  project = join(root, 'project');
  mkdirSync(project);
  setEngineDefaults({ default_timeout_ms: budget, stage_technical_retries: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function options(created: {
  runId: string;
  runDirPath: string;
}, time = manualClock()) {
  return { stageId: 'work', scope: ['.'], role, dependsOn: [], promptTemplate: 'Complete two units and retain unit 1 for continuation.',
    artifactContract: fixtureArtifactContract('work'), outputSchema: HANDOFF_SCHEMA,
    timeout_ms: budget, deadlineClock: time.clock, projectDir: project, runId: created.runId, runDir: created.runDirPath,
    retries: 0, };
}
const completed = (opts: RunOpts, summary = 'Done: unit 1. Remaining: unit 2.'): RunResult => {
  const refs = opts.outputSchema?.anyOf?.[0].properties?.criteria.required ?? [];
  return opts.outputSchema?.anyOf ? { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: true, reason: summary,
      criteria: Object.fromEntries(refs.map(id => [id, { status: 'pass', evidence: 'Synthetic fixture evidence.' }])), audit_findings: { version: 1, findings: [] } }) }
    : fixtureResult({ exitCode: 0, output: summary, duration_ms: 1 }, opts) as RunResult;
};
describe('stage budget delivery through the shared guidance boundary', () => {
  it('B04 preserves a genuine gate rejection returned at the warning boundary without another invocation', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (++calls > 1) return completed(opts, 'Replacement answer must not erase a genuine rejection.');
      time.advanceTo((budget - 1));
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: 'Actual defect', criteria: {}, audit_findings: { version: 1, findings: [] }, repairability: { version: 1, disposition: 'repairable', evidence: 'fixture' } }) };
    } };
    const result = await runStage(adapter, { ...options(created, time), isGate: true, outputSchema: stageRecordSchema({ isGate: true }), artifactContract: fixtureArtifactContract('work', true) });
    expect(result.exitCode).toBe(0);
    expect(result.continuation).toBeUndefined();
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(runRecordPath(created.runDirPath, 'verdict_work.json'), 'utf8'))).toMatchObject({ pass: false, reason: 'Actual defect' });
  });
  it.each(['watchdog', 'parent'] as const)('B05 keeps %s cancellation authoritative over a budget boundary', async (source) => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const parent = new AbortController();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
        time.advanceTo(budget + 1);
        if (source === 'parent')
          parent.abort('cancelled');
        else {
          mkdirSync(runRecordPath(opts.runDir, 'signals'), { recursive: true });
          atomicWrite(runRecordPath(opts.runDir, 'signals', 'abort_work.json'), JSON.stringify({ version: 1, stageId: 'work', attemptIndex: 1, reason: 'Actual abort', timestamp: new Date().toISOString(), source: 'watchdog' }));
        }
        return { exitCode: 0, duration_ms: budget + 1, output: 'cancelled' };
      } };
    const result = await withRunProcessOwnership(project, created.runId, () => runStage(adapter, options(created, time)), parent.signal);
    expect(result.exitCode).toBe(137);
    expect(result.continuation).toBeUndefined();
    expect(readStageStatus(project, created.runId, 'work').status).toBe('failed');
  });
  it('B06 never promotes a guard refusal into retained success at the hard stop', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run() { time.advanceTo(budget); return { engineVoid: true, terminationCause: 'engine_void', exitCode: 125, duration_ms: budget, output: 'ENGINE_STATE_REFUSED: fixture', friendlyError: 'ENGINE_STATE_REFUSED: fixture' }; } };
    const result = await runStage(adapter, options(created, time));
    expect(result.exitCode).not.toBe(0);
    expect(result.continuation).toBeUndefined();
  });
  it('B08 keeps timer-starved expiry bounded while preserving work and recording missing delivery honestly', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run() { writeFileSync(join(project, 'work.txt'), 'unit 1\n'); time.advanceTo(budget + 1); return { exitCode: 0, duration_ms: budget, output: 'late' }; } };
    const result = await runStage(adapter, options(created, time));
    expect(result.continuation?.forced).toBe(true);
    expect(existsSync(join(project, 'work.txt'))).toBe(true);
    expect(readStageStatus(project, created.runId, 'work').timeout?.wrapUpDeliveredAt).toBeUndefined();
  });
});
function workflowFixture(maxIterations = 2) {
  const roles = join(root, 'roles');
  mkdirSync(roles);
  for (const name of ['coder', 'qa'])
    writeFileSync(join(roles, `${name}.yaml`), `name: ${name}\nprompt: Fixture.\ntools: []\n`);
  const workflow = WorkflowConfigSchema.parse({ name: 'budget-workflow', defaults: { max_iterations: maxIterations, max_retries: 0 }, stages: [
      { id: 'done', role: 'coder', scope: [] },
      { id: 'work', role: 'coder', depends_on: ['done'], scope: ['work.txt'] },
      { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [] },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['work.txt'] },
    ] });
  normalizeStageContracts(workflow.stages);
  return { roles, workflow };
}
/** Explicit authored completion; prose alone cannot settle a warned stage. */
function withRemaining(result: RunResult, remaining_work: string[]): RunResult {
  return { ...result, output: JSON.stringify({ ...JSON.parse(result.output), remaining_work }) };
}
async function finishWorkflowAtWrap(stageId: 'work' | 'review', duringWrap: boolean, maxIterations = 2) {
  const { roles, workflow } = workflowFixture(maxIterations);
  workflow.stages.find(stage => stage.id === 'work')!.artifact_contract = {
    ...fixtureArtifactContract('work'), produces: [{ id: 'units', root: 'project', path: 'work.txt' }],
  };
  let time = manualClock();
  const calls: string[] = [];
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(`${opts.stageId}:${opts.attemptIndex}`);
    if (opts.stageId === stageId && !prompt.includes('# Stage budget wrap-up')) {
      time.advanceTo((budget - 1));
      if (duringWrap) return { exitCode: 137, duration_ms: 1, output: 'Closed at warning.' };
    }
    if (opts.stageId === 'work') writeFileSync(join(project, 'work.txt'), 'unit 1\nunit 2\n');
    if (opts.stageId === 'review') {
      expect(prompt).toContain('evidence-ledger.jsonl');
      expect(prompt).not.toContain('Both units and all assigned checks are complete.');
      expect(readFileSync(join(project, 'work.txt'), 'utf8')).toContain('unit 2');
    }
    return withRemaining(completed(opts, 'Both units and all assigned checks are complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles,
    undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
  return { result, calls };
}
describe('authored completion at the budget boundary', () => {
  it('B45 completion lists are optional for compatibility but malformed lists cannot certify completion', () => {
    for (const schema of [RECORDED_HANDOFF_SCHEMA, stageRecordSchema({ isGate: true })]) {
      const base = schema === RECORDED_HANDOFF_SCHEMA
        ? { status: 'delivered', summary: 'Complete.', checks: [], caveats: [] }
        : { pass: true, reason: 'Complete.', criteria: {}, audit_findings: { version: 1, findings: [] } };
      expect(() => parseStageRecord(JSON.stringify(base), schema)).not.toThrow();
      expect(() => parseStageRecord(JSON.stringify({ ...base, remaining_work: [] }), schema)).not.toThrow();
      for (const remaining_work of [null, false, 'none', [''], ['   '], [1]]) {
        expect(() => parseStageRecord(JSON.stringify({ ...base, remaining_work }), schema)).toThrow('remaining_work');
      }
    }
  });
});
describe('durable bounded continuation', () => {
  it('B36 child closure persists the budget handoff in both history and projection before final settlement', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']); beginStageAttempt(project, created.runId, 'work', 0);
    const continuation = { reason: 'stage_budget' as const, forced: false, handoff: 'stages/work/output_attempt_1.md' };
    const closed = completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1, continuation });
    expect(closed.continuation).toEqual(continuation);
    expect(closed.attempts?.at(-1)?.continuation).toEqual(continuation);
    expect(readStageStatus(project, created.runId, 'work').continuation).toEqual(continuation);
    expect(readRunState(project, created.runId).stages.work.continuation).toEqual(continuation);
  });
  it.each(['complete', 'pending'] as const)('B11 cancel/resume spends the next iteration for a settled budget handoff and refuses a reset beyond the ceiling (%s)', status => {
    const { workflow } = workflowFixture(2);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    updateRunState(project, created.runId, state => { state.status = 'cancelled'; state.currentIteration = 1; state.maxIterations = 2; state.stages.work = { status, retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } }; });
    const state = readRunState(project, created.runId);
    expect(workflowContinuation(state, project, created.runId, workflow).iteration).toBe(2);
    state.currentIteration = 2;
    expect(() => workflowContinuation(state, project, created.runId, workflow)).toThrow('iteration budget exhausted');
  });
  it('B13 rejects an infinite or nonpositive live iteration allowance', () => {
    for (const max_iterations of [Infinity, NaN, 0, -1, 1.5])
      expect(() => WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations }, stages: [{ id: 'work', role: 'coder' }] })).toThrow();
  });
  it('B33 direct launch enforces the finite iteration bound before allocating a run', () => {
    const { workflow } = workflowFixture();
    for (const maxIterations of [Infinity, NaN, 0, -1, 1.5]) {
      workflow.defaults.max_iterations = maxIterations;
      expect(() => prepareWorkflowLaunch(workflow, stringify(workflow), project)).toThrow('max_iterations must be a finite positive integer');
    }
  });
  it('B22 a completed budget slice cannot satisfy dependencies or expose a stale accepted gate', () => {
    const { workflow } = workflowFixture(2);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    const continuation = { reason: 'stage_budget' as const, forced: false, handoff: 'stages/work/output_attempt_1.md' };
    updateRunState(project, created.runId, state => { state.stages.done = { status: 'complete', retries: 0 }; state.stages.work = { status: 'complete', retries: 0, continuation }; });
    const state = readRunState(project, created.runId);
    expect(findAllReady(workflow.stages, state)).toEqual([]);
    writeStageStatus(project, created.runId, 'review', { status: 'complete', retries: 0, continuation, acceptedFrom: { runId: 'old-child', verdict: { pass: true, reason: 'Old acceptance' } } });
    expect(readGateEvaluation(project, 'review', created.runId)).toBeNull();
  });
  it('B23 a persisted budget boundary stops independent pending authors in the same iteration', async () => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'coder', scope: [] }, { id: 'other', role: 'coder', scope: [] }] });
    normalizeStageContracts(workflow.stages);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    writeStageStatus(project, created.runId, 'work', { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } });
    updateRunState(project, created.runId, state => recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Admitted fixture'));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) { calls.push(opts.stageId); return completed(opts); } };
    const result = await executeIteration(workflow.stages, project, created.runId, created.runDirPath, workflow, adapter, new Map([['coder', role]]), root, new Map([['coder', { name: 'coder', description: '' }]]), new Set(), new Map());
   expect(calls).toEqual([]);
    expect(result.stages.other.status).toBe('pending');
  });
  it('B24 terminal settlement defers retained budget work at every entrance, including the next iteration', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    writeFileSync(join(project, 'report.md'), 'Unfinished terminal document.');
    updateRunState(project, created.runId, state => { state.terminalStates = { complete: { paths: ['report.md'] } }; state.stages.work = { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } }; });
    const result = await tryTerminateOnTerminalState(readRunState(project, created.runId), { projectDir: project, runId: created.runId, runDirPath: created.runDirPath, iteration: 2, stages: [] });
    expect(result).toEqual({ decision: 'deferred', reasons: ['retained stage budget work must continue before terminal settlement'] });
    expect(readRunState(project, created.runId).status).toBe('running');
  });

  it('B29 a final settlement refusal cannot leave a retained-success marker', async () => {
    const time = manualClock(); const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) { time.advanceTo((budget - 1)); return completed(opts); } };
    await expect(runStage(adapter, { ...options(created, time), settlementBoundary: async phase => { if (phase === 'attempt_closed') throw new Error('Actual settlement refusal'); return false; } })).rejects.toThrow('Actual settlement refusal');
    const status = readStageStatus(project, created.runId, 'work'); expect(status.status).toBe('failed'); expect(status.continuation).toBeUndefined(); expect(status.attempts?.at(-1)?.continuation).toBeUndefined();
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1, endingCause: 'work_failed', continuation: false }));
  });

  it('B30 a scope audit refusal removes the budget marker from both history and projection', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']); beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } });
    const status = attachStageConstraintAudit(project, created.runId, 'work', 1, { path: 'stages/work/audit.json', declaredScope: [], effectiveScope: [], violationCount: 1, unverifiedCount: 0 }, 'Actual scope refusal');
    expect(status.status).toBe('failed'); expect(status.continuation).toBeUndefined(); expect(status.attempts?.at(-1)?.continuation).toBeUndefined();
    expect(status.attempts?.at(-1)?.endingCause).toBe('work_failed');
  });

  it('B32 returns a durable final refusal without a success continuation', async () => {
    const time = manualClock(); const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) { time.advanceTo((budget - 1)); return completed(opts); } };
    const result = await runStage(adapter, { ...options(created, time), settlementBoundary: async phase => {
      if (phase === 'attempt_closed') attachStageConstraintAudit(project, created.runId, 'work', 1,
        { path: 'stages/work/audit.json', declaredScope: [], effectiveScope: [], violationCount: 1, unverifiedCount: 0 }, 'Actual settlement refusal');
      return false;
    } });
    expect(result.exitCode).toBe(1); expect(result.continuation).toBeUndefined();
    expect(result.endingCause).toBe('work_failed');
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1, endingCause: 'work_failed', continuation: false }));
    expect(readStageStatus(project, created.runId, 'work').status).toBe('failed');
  });

});


describe('cause-owned budget handoff', () => {
  it('SI an unreviewed environment gap remains negative without spending another attempt', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { run: vi.fn(async () => ({ exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: 'Required renderer is unavailable.', caveats: [], remaining_work: ['Obtain rendering evidence.'] }) })) };
    const result = await runStage(adapter, options(created));
    expect(result.exitCode).toBe(1);
    expect(result.endingCause).toBe('environment_gap');
    expect(decideStageRetry(result, 0, 5, 5)).toBe('stop');
    expect(adapter.run).toHaveBeenCalledTimes(1);
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1,
      endingCause: 'environment_gap', environmentGap: { reason: 'Required renderer is unavailable.', blocks: null } }));
  });

  it('SI rejects malformed continuation declarations instead of silently using a different allowance', async () => {
    for (const value of [-1, 1.5, 'one', null, '.inf'])
      expect(parseBriefFrontmatter(`---\nmax_continuations: ${value}\n---\n# Task`).workflowError).toContain('max_continuations');
    const { roles, workflow } = workflowFixture(3);
    const run = vi.fn();
    const result = await runWorkflow(workflow, stringify(workflow), project, { run }, new Map(), undefined, roles,
      undefined, '---\nmax_continuations: -1\n---\n# Task', false, undefined, false);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('max_continuations');
    expect(readRunState(project, result.runId).status).toBe('failed');
    expect(run).not.toHaveBeenCalled();
  });
});


it('SI typed provider quota parks without retries and resumes the same stage after its reset', async () => {
  const { roles, workflow } = workflowFixture(3);
  const reset = Date.now() + 60_000;
  const quota = providerFailureFromEvent('codex', { type: 'turn.failed', error: {
    code: 'usage_limit_reached', reset_at: new Date(reset).toISOString(), message: 'Opaque provider diagnostic.' } })!;
  const calls: string[] = [];
  let stopped = false;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'work' && !stopped) {
      stopped = true;
      return { exitCode: 1, duration_ms: 1, output: '', providerFailure: quota };
    }
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const run = (existing?: string) => runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    existing, undefined, false, undefined, false);
  const parked = await run();
  expect(parked.status, parked.failureReason).toBe('parked');
  expect(calls).toEqual(['done', 'work']);
  expect(parked.stages.work).toMatchObject({ status: 'pending', retries: 0 });
  expect(parked.stages.work.attempts).toHaveLength(1);
  expect(parked.stages.work.attempts![0].endingCause).toBe('provider_quota');
  expect(parked.recovery).toMatchObject({ cause: 'provider_quota', notBefore: new Date(reset).toISOString() });
  expect((await run(parked.runId)).status).toBe('parked');
  expect(calls).toEqual(['done', 'work']);
  vi.spyOn(Date, 'now').mockReturnValue(reset + 1);
  const resumed = await run(parked.runId);
  expect(resumed.status, resumed.failureReason).toBe('complete');
  expect(calls).toEqual(['done', 'work', 'work', 'review']);
  expect(resumed.currentIteration).toBe(1);
  expect(resumed.stages.work.retries).toBe(0);
  expect(resumed.stages.done.attempts).toHaveLength(1);
});


it.each([true, false])('SI process deaths are bounded separately from repeated work failures (crash=%s)', async crash => {
  const { roles, workflow } = workflowFixture(3);
  workflow.defaults.max_retries = 1;
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return opts.stageId === 'work' ? { exitCode: crash ? 137 : 1, duration_ms: 1, output: 'Fixture failure.',
      ...(crash ? { processSignal: 'SIGKILL' as const, processExitCode: null } : {}) }
      : withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    undefined, undefined, false, undefined, false);
  expect(calls.filter(id => id === 'work')).toHaveLength(2);
  expect(result.stages.work.attempts).toHaveLength(2);
  expect(result.stages.work.attempts!.every(attempt => attempt.endingCause === (crash ? 'process_death' : 'work_failed'))).toBe(true);
  expect(result.stages.work.retries).toBe(crash ? 0 : 1);
  expect(result.status).toBe('incomplete');
});


it('SI verified success after provider cleanup is complete and never starts a crash retry', async () => {
  const { roles, workflow } = workflowFixture(3);
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return { ...withRemaining(completed(opts, 'Complete.'), []),
      ...(opts.stageId === 'work' ? { processSignal: 'SIGKILL' as const, processExitCode: null } : {}) };
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    undefined, undefined, false, undefined, false);
  expect(result.status, result.failureReason).toBe('complete');
  expect(calls).toEqual(['done', 'work', 'review']);
  expect(result.stages.work.attempts).toHaveLength(1);
  expect(result.stages.work.attempts![0]).toMatchObject({ endingCause: 'complete', exitCode: 0, processSignal: 'SIGKILL' });
});


it.each([false, true])('SI a gate rejection cannot spend another attempt on a declared environment gap even with a confirmed finding (repair discovers=%s)', async repairDiscovers => {
  const { roles, workflow } = workflowFixture(3);
  const calls: string[] = [];
  const gap = { reason: 'Renderer unavailable; visual evidence cannot be supplied in this environment.' };
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === (repairDiscovers ? 'repair' : 'work')) return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: gap.reason, blocks: { criterion_ids: [], paths: ['work.txt'] }, caveats: [], remaining_work: ['Obtain the required visual evidence.'] }) };
    if (opts.stageId === 'review') {
      if (!repairDiscovers && calls.filter(id => id === 'review').length > 1) return withRemaining(completed(opts, 'Complete.'), []);
      if (!repairDiscovers || calls.filter(id => id === 'review').length > 1) expect(prompt).toContain(gap.reason);
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: gap.reason, criteria: {},
        audit_findings: { version: 1, findings: [{ id: 'missing_visual', paths: ['work.txt'], reason: gap.reason, criterion_ids: [], invalidates_plan: false, repair_role: 'coder' }] }, repairability: { version: 1, disposition: 'repairable', evidence: gap.reason } }) };
    }
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter, 20_000), new Map(), undefined, roles,
    undefined, undefined, false, undefined, false, undefined, () => manualClock().clock);
  expect(calls).toEqual(repairDiscovers ? ['done', 'work', 'review', 'repair', 'review'] : ['done', 'work', 'review']);
  expect(result.status, result.failureReason).toBe('incomplete');
  expect(readGateEvaluation(project, 'review', result.runId)?.findings?.confirmed).toHaveLength(1);
  expect(result.stages.repair.attempts ?? []).toHaveLength(repairDiscovers ? 1 : 0);
  expect(result.decisionGraph?.records.filter(record => record.stageId === 'review').at(-1)?.reason).toContain(`Environment gap already reported by ${repairDiscovers ? 'repair' : 'work'}`);
}, 60_000);


it.each(['gap', 'refusal', 'cancellation'] as const)('SI repair a validated gap at deadline preserves %s precedence', async disposition => {
  const created = createRun(project, 'fixture', 'name: fixture', ['work']);
  const time = manualClock();
  const cancellation = new AbortController();
  const adapter: Adapter = { async run() {
    return { exitCode: 0, duration_ms: 1, output: JSON.stringify({status:'environment_gap', summary:'Renderer missing.', caveats:[], remaining_work:['Obtain visual evidence.']}) };
  } };
  const inspect = contractProbe.inspectStageArtifactContract;
  vi.spyOn(contractProbe,'inspectStageArtifactContract').mockImplementation((...args) => {
    const audit = inspect(...args);
    time.advanceTo(budget + 1);
    if (disposition === 'refusal') audit.violations.push({ kind: 'declared_artifact', source: 'declaration', mention: 'work.txt', path: join(project, 'work.txt'), reason: 'Fixture settlement refused.' });
    if (disposition === 'cancellation') cancellation.abort();
    return audit;
  });
  const result = await withRunProcessOwnership(project, created.runId,
    () => runStage(adapter, { ...options(created, time), gateReviewed: true }), cancellation.signal);
  expect(contractProbe.inspectStageArtifactContract).toHaveBeenCalled();
  const endingCause = disposition === 'gap' ? 'environment_gap' : disposition === 'refusal' ? 'work_failed' : 'cancelled';
  expect(result.endingCause).toBe(endingCause);
  expect(result.continuation).toBeUndefined();
  expect(readStageStatus(project, created.runId, 'work').attempts!.at(-1)!.endingCause).toBe(endingCause);
  expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', endingCause, continuation: false }));
});

function withTextReproduction(adapter: Adapter): Adapter {
 return { async run(prompt,role,opts) {
  const result=await adapter.run(prompt,role,opts);
  if(result.exitCode || !opts.outputSchema?.anyOf)return result;
  const verdict=JSON.parse(result.output);
  if(verdict.pass!==false)return result;
  const client=prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
  const snippet="process.exit(require('node:fs').readFileSync('work.txt','utf8')==='correct text'?0:1)";
  const command=JSON.stringify(process.execPath)+' -e '+"'"+snippet.replaceAll("'", "'\\''")+"'";
  const request=JSON.stringify({command,cwd:opts.workDir,shell:'/bin/sh'});
  const {runProjectCommand}=await import('../src/project-validation.js');
  const response=await runProjectCommand({role:'test',command:'/bin/sh',args:['-c',`${client} '${request.replaceAll("'", "'\\''")}'`],display:'Independently reproduce wrong work.txt',cwd:opts.workDir,runDir:opts.runDir,timeoutMs:20000});
  const recorded=JSON.parse(response.stdout!).record;
  expect(response.exitCode).toBe(0);expect(recorded.exitCode).toBe(1);
  verdict.audit_findings.findings=verdict.audit_findings.findings.map((finding:Record<string,unknown>)=>({...finding,reproduction:recorded.sequence}));
  return {...result,output:JSON.stringify(verdict)};
 }};
}

it.each((['disjoint','absent','broad','narrow'] as const).flatMap(mapping =>
  (['narrow','broad','absent'] as const).map(otherMapping => ({mapping,otherMapping,binding:'criteria' as string}))).concat(
    ['paths','joint','absent','empty'].map(binding => ({mapping:'broad' as const,otherMapping:'broad' as const,binding}))))(
  'SI repair text finding after gap with author=$mapping other=$otherMapping binding=$binding', async ({mapping,otherMapping,binding}) => {
  const {roles,workflow} = workflowFixture(3);
  const brief="---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"A missing optional renderer may be accepted using textual evidence.\"},{\"id\":\"fixture_2\",\"text\":\"work.txt contains correct text.\"}]\noutputs: [work.txt]\n---\n# Produce text with an optional renderer\n\n## Requirements\n1. A missing optional renderer may be accepted using textual evidence.\n2. work.txt contains correct text.";
  const {extractBriefCriteria}=await import('../src/brief-criteria.js');
  const refs=extractBriefCriteria(brief).criteria.map(c=>c.id);expect(refs).toHaveLength(2);
  workflow.stages.find(s=>s.id==='review')!.criterion_refs=refs;
  workflow.stages.find(s=>s.id==='repair')!.criterion_refs=[refs[1]];
  workflow.stages.find(s=>s.id==='work')!.scope = mapping === 'disjoint' ? [] : ['work.txt'];
  if (mapping === 'broad' || mapping === 'narrow') workflow.stages.find(s=>s.id==='work')!.criterion_refs = mapping === 'broad' ? refs : [refs[0]];
  const text={...workflow.stages[1],id:'text',scope:['work.txt'],depends_on:['work']};
  if(otherMapping==='absent')delete text.criterion_refs;else text.criterion_refs=otherMapping==='broad'?refs:[refs[1]];
  workflow.stages.splice(2,0,text);
  workflow.stages.find(s=>s.id==='review')!.depends_on=['text'];
  normalizeStageContracts(workflow.stages);
  const calls:string[]=[];
  const adapter:Adapter={async run(prompt,_role,opts){
    calls.push(opts.stageId);
    if(opts.stageId==='review'&&(binding==='absent'||binding==='empty'))expect(prompt).toContain(binding==='absent'?'"blocks":null':'"blocks":{"criterion_ids":[],"paths":[]}');
    if(opts.stageId==='work') return {exitCode:0,duration_ms:1,output:JSON.stringify({status:'environment_gap',summary:'Optional renderer missing; textual evidence can satisfy the brief.',...(binding==='absent'?{}:{blocks:binding==='empty'?{criterion_ids:[],paths:[]}:binding==='paths'?{criterion_ids:[],paths:['renderer']}:{criterion_ids:[refs[0]],paths:binding==='joint'?['work.txt']:[]}}),caveats:[],remaining_work:['Optional visual evidence unavailable.']})};
    if(opts.stageId==='text') writeFileSync(join(project,'work.txt'),'wrong text');
    if(opts.stageId==='repair') writeFileSync(join(project,'work.txt'),'correct text');
    if(opts.stageId==='review' && !calls.includes('repair')) return {exitCode:0,duration_ms:1,output:JSON.stringify({pass:false,reason:'Renderer gap accepted under criteria; independently reproduced text typo must be fixed.',criteria:{[refs[0]]:{status:'pass',evidence:'The stated optional renderer gap is accepted using delivered textual evidence.'},[refs[1]]:{status:'fail',evidence:'work.txt contains wrong text.'}},audit_findings:{version:1,findings:[{id:'text_typo',paths:['work.txt'],reason:'Text is wrong; renderer is unrelated.',criterion_ids:[refs[1]],invalidates_plan:false,repair_role:'coder'}]},repairability:{version:1,disposition:'repairable',evidence:'Repair work.txt only; no renderer invocation or gap reopening.'}})};
    return withRemaining(completed(opts,'Complete.'),[]);
  }};
  const result=await runWorkflow(workflow,stringify(workflow),project,withTextReproduction(adapter),new Map(),undefined,roles,undefined,brief,false,undefined,false,undefined,()=>manualClock().clock);
  expect(calls).toEqual(['done','work','text','review','repair','review']);
  expect(result.status).toBe('complete');
  expect(readFileSync(join(project,'work.txt'),'utf8')).toBe('correct text');
  expect(result.stages.work.attempts).toHaveLength(1);
  expect(result.stages.repair.attempts??[]).toHaveLength(1);
  const fact=readEvidence(runDir(project,result.runId)).find(entry=>entry.kind==='attempt'&&entry.stageId==='work');
  expect(fact?.kind==='attempt'&&fact.environmentGap?.blocks).toEqual(binding==='absent'?null:binding==='empty'?{criterion_ids:[],paths:[]}:binding==='paths'?{criterion_ids:[],paths:['renderer']}:{criterion_ids:[refs[0]],paths:binding==='joint'?['work.txt']:[]});
  if(binding==='absent'||binding==='empty')expect(result.decisionGraph?.records.find(record=>record.stageId==='review')?.reason).toContain('Environment gaps without declared blocks: work; relatedness unknown');
});

function withRendererReproduction(adapter: Adapter): Adapter {
 return {async run(prompt,role,opts) {
  const result=await adapter.run(prompt,role,opts);
  if(result.exitCode || !opts.outputSchema?.anyOf)return result;
  const verdict=JSON.parse(result.output);if(verdict.pass!==false)return result;
  const client=prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
  const request=JSON.stringify({command:'/bin/sh -c \'test -x ./renderer\'',cwd:opts.workDir,shell:'/bin/sh'});
  const {runProjectCommand}=await import('../src/project-validation.js');
  const response=await runProjectCommand({role:'test',command:'/bin/sh',args:['-c',`${client} '${request.replaceAll("'", "'\\''")}'`],display:'Reproduce same missing renderer capability',cwd:opts.workDir,runDir:opts.runDir,timeoutMs:20000});
  expect(response.exitCode).toBe(0);const record=JSON.parse(response.stdout!).record;expect(record.exitCode).toBe(1);
  verdict.audit_findings.findings=verdict.audit_findings.findings.map((f:Record<string,unknown>)=>({...f,reproduction:record.sequence}));
  return {...result,output:JSON.stringify(verdict)};
 }};
}

it.each((['narrow','broad','absent','mismatched'] as const).flatMap(authorMapping =>
 (['narrow','broad','absent'] as const).map(otherMapping => ({authorMapping,otherMapping,binding:'joint'}))).concat(
  ['paths','criteria'].map(binding=>({authorMapping:'mismatched' as const,otherMapping:'broad' as const,binding}))))(
 'SI repair shared ownership cannot reopen the same renderer gap with author=$authorMapping other=$otherMapping binding=$binding',async ({authorMapping,otherMapping,binding})=>{
 const {roles,workflow}=workflowFixture(3);
 const brief="---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"The renderer executable supplies visual evidence.\"},{\"id\":\"fixture_2\",\"text\":\"work.txt contains correct text.\"}]\noutputs: [work.txt]\n---\n# Renderer work\n\n## Requirements\n1. The renderer executable supplies visual evidence.\n2. work.txt contains correct text.";
 const {extractBriefCriteria}=await import('../src/brief-criteria.js');const refs=extractBriefCriteria(brief).criteria.map(c=>c.id);expect(refs).toHaveLength(2);
 workflow.stages.find(s=>s.id==='work')!.scope=['renderer','work.txt'];
 if(authorMapping==='absent')delete workflow.stages.find(s=>s.id==='work')!.criterion_refs;
 else workflow.stages.find(s=>s.id==='work')!.criterion_refs=authorMapping==='broad'?refs:[refs[authorMapping==='mismatched'?1:0]];
 workflow.stages.find(s=>s.id==='repair')!.scope=['renderer','work.txt'];
 workflow.stages.find(s=>s.id==='repair')!.criterion_refs=[refs[0]];
 workflow.stages.find(s=>s.id==='review')!.criterion_refs=refs;
 const text={...workflow.stages[1],id:'text',scope:['renderer','work.txt'],depends_on:['work']};
 if(otherMapping==='absent')delete text.criterion_refs;else text.criterion_refs=otherMapping==='broad'?refs:[refs[1]];
 workflow.stages.splice(2,0,text);workflow.stages.find(s=>s.id==='review')!.depends_on=['text'];normalizeStageContracts(workflow.stages);
 const calls:string[]=[],rendererProbes:string[]=[];
 const adapter:Adapter={async run(_prompt,_role,opts){
  calls.push(opts.stageId);
  if(opts.stageId==='work'||opts.stageId==='repair') {
   rendererProbes.push(opts.stageId);expect(existsSync(join(project,'renderer'))).toBe(false);
   return {exitCode:0,duration_ms:1,output:JSON.stringify({status:'environment_gap',summary:'The required renderer executable is unavailable in this environment.',blocks:{criterion_ids:binding==='paths'?[]:[refs[0]],paths:binding==='criteria'?[]:['renderer']},caveats:[],remaining_work:['Supply visual evidence with renderer.']})};
  }
  if(opts.stageId==='text')writeFileSync(join(project,'work.txt'),'correct text');
  if(opts.stageId==='review')return {exitCode:0,duration_ms:1,output:JSON.stringify({pass:false,reason:'The renderer is absent; text is correct.',criteria:{[refs[0]]:{status:'fail',evidence:'Renderer unavailable.'},[refs[1]]:{status:'pass',evidence:'Correct text exists.'}},audit_findings:{version:1,findings:[{id:'missing_renderer',paths:['renderer'],reason:'Same renderer capability missing.',criterion_ids:[refs[0]],invalidates_plan:false,repair_role:'coder'}]},repairability:{version:1,disposition:'repairable',evidence:'The renderer is absent.'}})};
  return withRemaining(completed(opts,'Complete.'),[]);
 }};
 const result=await runWorkflow(workflow,stringify(workflow),project,withRendererReproduction(adapter),new Map(),undefined,roles,undefined,brief,false,undefined,false,undefined,()=>manualClock().clock);
 expect(rendererProbes).toEqual(['work']);
 expect(calls).toEqual(['done','work','text','review']);
 expect(result.status).toBe('incomplete');
 expect(result.stages.work.attempts).toHaveLength(1);
 expect(result.stages.repair.attempts ?? []).toHaveLength(0);
 expect(readGateEvaluation(project,'review',result.runId)?.findings?.confirmed).toHaveLength(1);
 expect(result.decisionGraph?.records.find(record => record.stageId === 'review')?.reason).toContain('Environment gap already reported by work');
});


it.each([
  { gapPath: 'renderer/', findingPath: 'renderer', sameGap: true },
  { gapPath: './renderer', findingPath: 'renderer', sameGap: true },
  { gapPath: './renderer/', findingPath: 'renderer/bin', sameGap: true },
  { gapPath: 'assets', findingPath: 'assets/x.png', sameGap: true },
  { gapPath: './assets//', findingPath: 'assets/nested/x.png', sameGap: true },
  { gapPath: 'assets', findingPath: './assets/x.png', sameGap: true },
  { gapPath: 'assets', findingPath: 'assets-sibling/x.png', sameGap: false },
  { gapPath: './renderer/', findingPath: 'renderer-sibling', sameGap: false },
])('SI gap path scope $gapPath contains $findingPath = $sameGap', async ({ gapPath, findingPath, sameGap }) => {
  const { roles, workflow } = workflowFixture(3);
  workflow.stages.find(stage => stage.id === 'repair')!.scope = ['renderer', 'assets', 'assets-sibling', 'renderer-sibling', 'work.txt'];
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'work') return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: 'Required capability unavailable.',
      blocks: { criterion_ids: [], paths: [gapPath] }, caveats: [], remaining_work: ['Supply the missing evidence.'],
    }) };
    if (opts.stageId === 'review' && !calls.includes('repair')) return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
      pass: false, reason: 'Missing required evidence.', criteria: {},
      audit_findings: { version: 1, findings: [{ id: 'missing_evidence', paths: [findingPath], reason: 'Evidence unavailable.', criterion_ids: [], invalidates_plan: false, repair_role: 'coder' }] },
      repairability: { version: 1, disposition: 'repairable', evidence: 'Independently reproduced missing evidence.' },
    }) };
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withRendererReproduction(adapter), new Map(), undefined, roles,
    undefined, undefined, false, undefined, false, undefined, () => manualClock().clock);
  expect(readGateEvaluation(project, 'review', result.runId)?.findings?.confirmed ?? []).toHaveLength(sameGap ? 1 : 0);
  expect(calls).toEqual(sameGap ? ['done', 'work', 'review'] : ['done', 'work', 'review', 'repair', 'review']);
  expect(result.status, result.failureReason).toBe('incomplete');
  expect(result.stages.repair.attempts ?? []).toHaveLength(sameGap ? 0 : 1);
  if (sameGap) expect(result.decisionGraph?.records.find(record => record.stageId === 'review')?.reason).toContain('Environment gap already reported by work');
  const fact = readEvidence(runDir(project, result.runId)).find(entry => entry.kind === 'attempt' && entry.stageId === 'work');
  expect(fact?.kind === 'attempt' && fact.environmentGap?.blocks?.paths).toEqual([gapPath.includes('renderer') ? 'renderer' : 'assets']);
});

it('SI gap path scope reports unknown blocked criterion ids to the gate', async () => {
  const { roles, workflow } = workflowFixture(3);
  const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Supply required evidence.\"}]\n---\n# Evidence request\n\n## Requirements\n1. Supply required evidence.";
  const { extractBriefCriteria } = await import('../src/brief-criteria.js');
  const refs = extractBriefCriteria(brief).criteria.map(criterion => criterion.id);
  expect(refs).toHaveLength(1);
  workflow.stages.find(stage => stage.id === 'review')!.criterion_refs = refs;
  const unknown = 'not-a-brief-criterion';
  workflow.stages.find(stage => stage.id === 'repair')!.scope = ['renderer', 'work.txt'];
  const calls: string[] = [];
  let gateSawFact = false;
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'work') return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: 'Capability unavailable.', blocks: { criterion_ids: [refs[0], unknown], paths: ['./renderer/'] },
      caveats: [], remaining_work: ['Supply evidence.'],
    }) };
    if (opts.stageId === 'repair') writeFileSync(join(project, 'renderer'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    if (opts.stageId === 'review') {
      const fact = readEvidence(opts.runDir).find(entry => entry.kind === 'attempt' && entry.stageId === 'work');
      expect(fact?.kind === 'attempt' && fact.environmentGap).toMatchObject({
        blocks: { criterion_ids: [refs[0], unknown], paths: ['renderer'] }, unknownCriterionIds: [unknown],
      });
      expect(prompt).toContain('"unknownCriterionIds":["not-a-brief-criterion"]');
      gateSawFact = true;
      if (!calls.includes('repair')) return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
        pass: false, reason: 'Required evidence missing.', criteria: { [refs[0]]: { status: 'fail', evidence: 'Renderer is absent.' } },
        audit_findings: { version: 1, findings: [{ id: 'missing_renderer', paths: ['renderer'], reason: 'Renderer is absent.', criterion_ids: [unknown], invalidates_plan: false, repair_role: 'coder' }] },
        repairability: { version: 1, disposition: 'repairable', evidence: 'Independently reproduced missing renderer.' },
      }) };
    }
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withRendererReproduction(adapter), new Map(), undefined, roles,
    undefined, brief, false, undefined, false, undefined, () => manualClock().clock);
  expect(gateSawFact).toBe(true);
  expect(calls).toEqual(['done', 'work', 'review', 'repair', 'review']);
  expect(result.stages.repair.attempts ?? []).toHaveLength(1);
  expect(result.status, result.failureReason).toBe('complete');
});
