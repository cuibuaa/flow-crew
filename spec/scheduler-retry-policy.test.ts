import './test-support/policy-runtime.js';
import { providerFailureFromDiagnostic, providerFailureFromEvent } from '../src/provider-result.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { settleGateRetries } from '../src/scheduler/sched_loop/gate-loop.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { completedStageAttemptStatus, fcGlobalDir, readRunState, readStageStatus, rependStageStatus, setFcGlobalDir, writeRunState, writeStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

vi.mock('../src/worker.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/worker.js')>(), runStage: vi.fn(),
}));

const role: AgentConfig = { name: 'coder', description: 'fixture', tools: [], prompt: 'fixture' };
const adapter: Adapter = { async run() { throw new Error('scheduler fixture must use the mocked worker'); } };
const paths = ['batch', 'single'] as const;
type ExecutionPath = typeof paths[number];
let root: string, project: string, agentsDir: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-retry-policy-')); project = join(root, 'project');
  agentsDir = join(project, 'config', 'agents'); mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'coder.yaml'), stringify(role));
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ default_timeout_ms: 50, stage_technical_retries: 1 });
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const workflow = WorkflowConfigSchema.parse({ name: 'retry-policy', defaults: { max_iterations: 1 },
    stages: [{ id: 'work', role: 'coder', scope: [], prompt_template: 'fixture', artifact_contract: fixtureArtifactContract('work') }] });
  return { workflow, ...createRun(project, workflow.name, stringify(workflow), ['work']) };
}

function workerResults(results: RunResult[]) {
  const budgets: number[] = [];
  vi.mocked(runStage).mockImplementation(async (_adapter, options) => {
    const result = results[Math.min(budgets.length, results.length - 1)];
    budgets.push(options.timeout_ms!);
    let previous = readRunState(project, options.runId).stages[options.stageId];
    try { previous = readStageStatus(project, options.runId, options.stageId); } catch { /* first worker call */ }
    const now = new Date().toISOString();
    writeStageStatus(project, options.runId, options.stageId, completedStageAttemptStatus(previous, options.retries, {
      exitCode: result.exitCode, duration_ms: 1, error: result.friendlyError ?? result.output,
      terminationCause: result.terminationCause, engineVoid: result.engineVoid, providerFailure: result.providerFailure,
      timeout: { attemptId: `fixture-${budgets.length}`, budgetMs: options.timeout_ms!,
        attemptStartedAt: now, deadlineAt: now, elapsedMs: 1, remainingMs: 0 },
    }));
    return result;
  });
  return budgets;
}

async function execute(path: ExecutionPath, f: ReturnType<typeof fixture>) {
  const agents = new Map([['coder', role]]), technicalRetries = new Map();
  if (path === 'single') return executeSingleStage(f.workflow.stages[0], project, f.runId, f.runDirPath,
    f.workflow, adapter, agents, agentsDir, readRunState(project, f.runId), f.workflow.stages);
  // A batch schedules one wave at a time; re-enter exactly as the iteration loop does.
  for (let wave = 0; wave < 4; wave++) {
    const next = await executeReadyBatch(f.workflow.stages, readRunState(project, f.runId), project,
      f.runId, f.runDirPath, f.workflow, adapter, agents, agentsDir, new Map([['coder', role]]), technicalRetries);
    if (next.kind === 'settled' || readStageStatus(project, f.runId, 'work').status !== 'pending') return next;
  }
  throw new Error('fixture retry allowance was not exhausted');
}

const ordinaryFailure: RunResult = { output: 'ordinary failure', exitCode: 1, duration_ms: 1, terminationCause: 'exit' };
const timeout: RunResult = { output: 'attempt timeout', exitCode: 124, duration_ms: 1, terminationCause: 'attempt_timeout' };
const voided: RunResult = { output: '', friendlyError: 'ENGINE_STATE_TAMPERED: synthetic protected record changed',
  exitCode: 125, duration_ms: 1, terminationCause: 'engine_void', engineVoid: true };

describe('one scheduler retry policy across batch and gate execution', () => {
  it('makes the same next decision after a timeout followed by an ordinary failure', async () => {
    const observed = [];
    for (const path of paths) {
      const f = fixture(), budgets = workerResults([timeout, ordinaryFailure]);
      await execute(path, f);
      const status = readStageStatus(project, f.runId, 'work');
      observed.push({ budgets, retries: status.retries, status: status.status,
        causes: status.attempts?.map(attempt => attempt.terminationCause) });
    }
    expect(observed[0]).toEqual(observed[1]);
    expect(observed[0]).toEqual({ budgets: [50, 100], retries: 1, status: 'failed', causes: ['attempt_timeout', 'exit'] });
  });

  it.each(paths)('keeps the default ordinary retry allowance in the %s path', async path => {
    const f = fixture(), budgets = workerResults([ordinaryFailure]);
    await execute(path, f);
    expect(budgets).toEqual([50, 50]);
    expect(readStageStatus(project, f.runId, 'work').attempts).toHaveLength(2);
  });

  describe.each(paths)('%s uncoded terminal failure policy', path => {
    it.each([
      ['codex', { type: 'error' }],
      ['claude', { type: 'result', subtype: 'error_max_turns' }],
    ] as const)('uses max_retries for %s %j and never concludes adapter_failure', async (provider, event) => {
      for (const maxRetries of [0, 2]) {
        const f = fixture();
        f.workflow.stages[0].max_retries = maxRetries;
        const budgets = workerResults([{ ...ordinaryFailure, providerFailure: providerFailureFromEvent(provider, event) }]);
        await execute(path, f);
        expect(budgets).toEqual(Array(maxRetries + 1).fill(50));
        expect(readStageStatus(project, f.runId, 'work')).toMatchObject({ status: 'failed', retries: maxRetries });
        expect(readStageStatus(project, f.runId, 'work').attempts).toHaveLength(maxRetries + 1);
        expect(readRunState(project, f.runId).reasonCode).not.toBe('adapter_failure');
      }
    });
  });

  describe.each(paths)('%s non-temporary typed provider failure policy', path => {
    it.each(['codex', 'claude'] as const)('uses stage max_retries for %s without concluding adapter_failure', async provider => {
      for (const code of ['invalid_request_error', 'not_found_error', 'permission_error']) {
        for (const maxRetries of [0, 2]) {
          const f = fixture();
          f.workflow.stages[0].max_retries = maxRetries;
          const envelope = provider === 'codex' ? { type: 'turn.failed' } : { type: 'result', is_error: true };
          const budgets = workerResults([{ ...ordinaryFailure,
            providerFailure: providerFailureFromEvent(provider, { ...envelope, error: { type: code, message: 'request rejected' } }) }]);
          await execute(path, f);
          expect(budgets).toEqual(Array(maxRetries + 1).fill(50));
          const status = readStageStatus(project, f.runId, 'work');
          expect(status).toMatchObject({ status: 'failed', retries: maxRetries });
          expect(status.attempts).toHaveLength(maxRetries + 1);
          expect(status.attempts?.every(attempt => !attempt.providerFailure)).toBe(true);
          expect(readRunState(project, f.runId).reasonCode).not.toBe('adapter_failure');
        }
      }
    });
  });

  it('resumes a persisted pending timeout retry with its consumed allowance and increased budget', async () => {
    const f = fixture(), state = readRunState(project, f.runId), now = '2026-10-01T00:00:00.000Z';
    const timedOut = completedStageAttemptStatus(state.stages.work, 0, {
      exitCode: 124, duration_ms: 50, terminationCause: 'attempt_timeout', error: 'synthetic timeout',
      timeout: { attemptId: 'persisted-timeout', budgetMs: 50, attemptStartedAt: now, deadlineAt: now, elapsedMs: 50, remainingMs: 0 },
    });
    state.stages.work = rependStageStatus(timedOut, 1, timedOut.error);
    writeStageStatus(project, f.runId, 'work', state.stages.work); writeRunState(project, f.runId, state);
    const budgets = workerResults([ordinaryFailure]);
    await execute('single', f);
    expect(budgets).toEqual([100]);
    expect(readStageStatus(project, f.runId, 'work')).toMatchObject({ status: 'failed', retries: 1 });
    expect(readStageStatus(project, f.runId, 'work').attempts?.map(attempt => attempt.terminationCause))
      .toEqual(['attempt_timeout', 'exit']);
  });

  it('gives a new repair round its default retry allowance while retaining the previous round ledger', async () => {
    const f = fixture(), state = readRunState(project, f.runId);
    const previousRound = completedStageAttemptStatus(state.stages.work, 1, {
      exitCode: 1, duration_ms: 1, terminationCause: 'exit', error: 'previous repair round failed',
    });
    writeStageStatus(project, f.runId, 'work', previousRound);
    state.stages.work = rependStageStatus(previousRound, 0); writeRunState(project, f.runId, state);
    expect(readStageStatus(project, f.runId, 'work').retries).toBe(1);
    expect(readRunState(project, f.runId).stages.work.retries).toBe(0);
    const budgets = workerResults([ordinaryFailure]);
    await execute('single', f);
    expect(budgets).toEqual([50, 50]);
    expect(readStageStatus(project, f.runId, 'work')).toMatchObject({ status: 'failed', retries: 1 });
    expect(readStageStatus(project, f.runId, 'work').attempts).toHaveLength(3);
  });

  it.each(['current', 'legacy'] as const)('preserves the consumed repair and technical allowances for a %s gate run', async shape => {
    const workflow = WorkflowConfigSchema.parse({ name: 'resumed-repair', defaults: { max_iterations: 1 }, stages: [
      { id: 'work', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'],
        prompt_template: 'Repair fixture.', artifact_contract: fixtureArtifactContract('work') },
      { id: 'review', role: 'coder', scope: [], is_gate: true, prompt_template: 'Review fixture.',
        artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }], reads: [] } },
    ] });
    const f = createRun(project, workflow.name, stringify(workflow), ['work', 'review']);
    const state = readRunState(project, f.runId), now = '2026-10-01T00:00:00.000Z';
    state.status = 'running'; state.currentIteration = 1; state.maxRetries = 2;
    state.gateRetryRound = { iteration: 1, round: 2 };
    state.stages.review = completedStageAttemptStatus(state.stages.review, 0, { exitCode: 0, duration_ms: 1 });
    const timedOut = completedStageAttemptStatus(state.stages.work, 0, {
      attribution: { role: 'coder', iteration: 1 }, exitCode: 124, duration_ms: 50,
      terminationCause: 'attempt_timeout', error: 'synthetic timeout',
      timeout: { attemptId: 'resumed-timeout', budgetMs: 50, attemptStartedAt: now, deadlineAt: now, elapsedMs: 50, remainingMs: 0 },
    });
    state.stages.work = rependStageStatus(timedOut, 1, timedOut.error);
    for (const id of ['work', 'review']) writeStageStatus(project, f.runId, id, state.stages[id]);
    writeRunState(project, f.runId, state);
    writeFileSync(join(f.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: false, reason: 'Synthetic repairable rejection.' }));
    const archive = join(f.runDirPath, 'gate_reevaluation/iteration_1/round_2');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'repair_diff.json'), JSON.stringify({ completedAt: timedOut.attempts!.at(-1)!.startedAt, repairStageIds: ['work'] }));
    if (shape === 'legacy') {
      const path = join(f.runDirPath, 'run.json'), raw = JSON.parse(readFileSync(path, 'utf8'));
      delete raw.gateRetryRound;
      const bytes = JSON.stringify(raw); writeFileSync(path, bytes);
      expect(readRunState(project, f.runId).gateRetryRound).toEqual({ iteration: 1, round: 2 });
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    }
    const budgets = workerResults([ordinaryFailure]);
    await settleGateRetries(state, workflow.stages, 1, new Set(), project, f.runId, f.runDirPath,
      workflow, adapter, new Map([['coder', role]]), agentsDir, new Map());
    expect(budgets).toEqual([100]);
    expect(readStageStatus(project, f.runId, 'work')).toMatchObject({ status: 'failed', retries: 1 });
    expect(readStageStatus(project, f.runId, 'work').attempts).toHaveLength(2);
    expect(readRunState(project, f.runId).gateRetryRound).toEqual({ iteration: 1, round: 2 });
    // Once ordinary publication stores the coordinate, receipts are no longer
    // a source of authority for this run's repair budget.
    const later = join(f.runDirPath, 'gate_reevaluation/iteration_1/round_9');
    mkdirSync(later, { recursive: true }); writeFileSync(join(later, 'repair_diff.json'), '{}');
    expect(readRunState(project, f.runId).gateRetryRound).toEqual({ iteration: 1, round: 2 });
  });

  it.each(paths)('never retries authentication failure in the %s path', async path => {
    const f = fixture(), budgets = workerResults([{ ...ordinaryFailure, terminationCause: 'exit', providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', message: 'not logged in' }) }]);
    await execute(path, f);
    expect(budgets).toEqual([50]);
    expect(readRunState(project, f.runId)).toMatchObject({ status: 'failed' });
    expect(readStageStatus(project, f.runId, 'work')).toMatchObject({ retries: 0, attempts: [{ providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', message: 'not logged in' }) }] });
  });

  it.each(paths)('refuses a voided attempt without retrying in the %s path', async path => {
    const f = fixture(), budgets = workerResults([voided]);
    await expect(execute(path, f)).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(budgets).toEqual([50]);
    expect(readStageStatus(project, f.runId, 'work').attempts).toMatchObject([{ terminationCause: 'engine_void', engineVoid: true }]);
  });

  it.each([undefined, 'attempt_timeout', 'complete'])('projects a legacy exit 124 attempt with nested cause %s without writing its stored bytes', legacy => {
    const f = fixture(), path = join(f.runDirPath, 'stages', 'work', 'status.json');
    const raw = JSON.stringify({ status: 'failed', retries: 0, exitCode: 124,
      attempts: [{ index: 1, startedAt: '2026-10-01T00:00:00.000Z', status: 'failed', exitCode: 124, timeout: legacy ? { terminationCause: legacy } : undefined }] });
    writeFileSync(path, raw);
    expect(readStageStatus(project, f.runId, 'work').attempts?.[0].terminationCause).toBe(legacy === 'complete' ? 'exit' : 'attempt_timeout');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
});
