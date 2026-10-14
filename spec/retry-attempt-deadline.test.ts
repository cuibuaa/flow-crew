import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import type { AttemptDeadlineClock, TechnicalRetryBudgetState } from '../src/attempt-deadline.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { createRun, readRunState, readStageStatus, type StageStatus } from '../src/store.js';
import { inspectStageExecutionFacts } from '../src/stage-watchdog.js';
import { runStage } from '../src/worker.js';
import { stageLiveLogPath } from '../src/stage-live-log.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const role: AgentConfig = {
  name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture',
};

function manualClock() {
  let elapsed = 0;
  const wallStart = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const clock: AttemptDeadlineClock = {
    monotonicNow: () => elapsed,
    wallNow: () => wallStart + elapsed,
    setTimer(callback, delayMs) {
      const timer = {} as ReturnType<typeof setTimeout>;
      timers.set(timer, { at: elapsed + delayMs, callback });
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
  };
  return { clock, timers, advance(ms: number) {
    elapsed += ms;
    for (const [timer, entry] of timers) {
      if (entry.at > elapsed) continue;
      timers.delete(timer);
      entry.callback();
    }
  } };
}

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'retry-deadline-'));
  setEngineDefaults({ timeout_ms: 40, stage_technical_retries: 1 });
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

function scenario(repair = false) {
  const stageId = repair ? 'repair' : 'rewrite';
  const workflow = WorkflowConfigSchema.parse({
    name: 'attempt-deadline', defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{ id: stageId, role: 'coder', scope: [],
      ...(repair ? { retry_to: ['review'] } : {}), artifact_contract: fixtureArtifactContract(stageId) }],
  });
  const created = createRun(projectDir, workflow.name, stringify(workflow), [stageId]);
  const observed: Array<{
    status: StageStatus; aggregate: StageStatus; ledger: { budgetMs: number; deadlineAt: string; attemptId: string };
    resumeSessionId?: string;
    protectedFromIdleAbort: boolean; activeCommandCount: number; abortedEarly: boolean; abortedAtDeadline: boolean;
  }> = [];
  let time = manualClock();
  const factory = () => { time = manualClock(); return time.clock; };
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    const status = readStageStatus(projectDir, created.runId, stageId);
    const aggregate = readRunState(projectDir, created.runId).stages[stageId];
    const ledger = JSON.parse(readFileSync(join(created.runDirPath, 'stages', stageId,
      `attempt_deadline_execution_${opts.attemptIndex}_budget.jsonl`), 'utf8').split('\n')[0]);
    // Fresh output bytes protect idle work even when there are no active commands.
    appendFileSync(stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt), 'Still working\n');
    const facts = inspectStageExecutionFacts({ runDir: created.runDirPath, stageId, status, sinceMs: 0 });
    const observation = { status, aggregate, ledger, resumeSessionId: opts.resumeSessionId, protectedFromIdleAbort: facts.protectedFromIdleAbort,
      activeCommandCount: facts.activeCommandCount, abortedEarly: false, abortedAtDeadline: false };
    observed.push(observation);
    return new Promise<RunResult>(resolve => {
      opts.abortSignal!.addEventListener('abort', () => resolve({ output: 'cancelled', exitCode: 137,
        duration_ms: ledger.budgetMs }), { once: true });
      time.advance(ledger.budgetMs - 1);
      observation.abortedEarly = opts.abortSignal!.aborted;
      time.advance(1);
      observation.abortedAtDeadline = opts.abortSignal!.aborted;
    });
  } };
  return { stageId, workflow, created, observed, factory, adapter };
}

function expectVisibleDeadline(observation: ReturnType<typeof scenario>['observed'][number], index: number, budgetMs: number) {
  expect(observation.status.timeout, `execution ${index} has no live deadline`).toMatchObject({
    attemptId: observation.ledger.attemptId, budgetMs, deadlineAt: observation.ledger.deadlineAt,
    remainingMs: budgetMs,
  });
  expect(observation.status.attempts?.at(-1)).toMatchObject({ index, status: 'running', timeout: observation.status.timeout });
  expect(observation.aggregate).toEqual(observation.status);
  expect(observation.status.timeout?.terminationCause).toBeUndefined();
  expect(observation.status.timeout?.childClosedAt).toBeUndefined();
  expect(observation).toMatchObject({ protectedFromIdleAbort: true, activeCommandCount: 0,
    abortedEarly: false, abortedAtDeadline: true });
  expect(Date.parse(observation.status.timeout!.deadlineAt) - Date.parse(observation.status.timeout!.attemptStartedAt)).toBe(budgetMs);
}

describe('every execution publishes and obeys its attempt deadline', () => {
  it('publishes attempt 2 after a timeout through the ordinary scheduler retry path', async () => {
    const s = scenario();
    const retries = new Map<string, TechnicalRetryBudgetState>();
    for (let index = 0; index < 2; index++) {
      await executeReadyBatch(s.workflow.stages, readRunState(projectDir, s.created.runId), projectDir,
        s.created.runId, s.created.runDirPath, s.workflow, s.adapter, new Map([['coder', role]]), projectDir,
        new Map(), retries, undefined, undefined, undefined, s.factory);
    }
    expect(s.observed).toHaveLength(2);
    // Check the reported failure first, so reverting the fix reproduces the missing retry field.
    expectVisibleDeadline(s.observed[1], 2, 80);
    expectVisibleDeadline(s.observed[0], 1, 40);
    const status = readStageStatus(projectDir, s.created.runId, s.stageId);
    expect(status.attempts?.map(attempt => attempt.exitCode)).toEqual([124, 124]);
    expect(status.attempts?.map(attempt => attempt.timeout?.budgetMs)).toEqual([40, 80]);
    expect(status.attempts?.[0].timeout?.attemptId).not.toBe(status.attempts?.[1].timeout?.attemptId);
  });

  it('uses the same deadline for repair executions and their technical retries', async () => {
    const s = scenario(true);
    const result = await executeSingleStage(s.workflow.stages[0], projectDir, s.created.runId, s.created.runDirPath,
      s.workflow, s.adapter, new Map([['coder', role]]), projectDir, readRunState(projectDir, s.created.runId),
      s.workflow.stages, undefined, undefined, 1, undefined, undefined, undefined, s.factory);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(s.observed).toHaveLength(2);
    expectVisibleDeadline(s.observed[1], 2, 80);
    expectVisibleDeadline(s.observed[0], 1, 40);
  });

  it('publishes a fresh deadline for a resumed session after a timed-out attempt', async () => {
    const s = scenario();
    for (let retries = 0; retries < 2; retries++) {
      const result = await runStage(s.adapter, {
        stageId: s.stageId, role, dependsOn: [], promptTemplate: 'fixture', artifactContract: fixtureArtifactContract(s.stageId),
        projectDir, runId: s.created.runId, runDir: s.created.runDirPath, retries, timeout_ms: 40, deadlineClock: s.factory(),
        ...(retries ? { resumeSessionId: '123e4567-e89b-42d3-a456-426614174000' } : {}),
      });
      expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    }
    expectVisibleDeadline(s.observed[1], 2, 40);
    expectVisibleDeadline(s.observed[0], 1, 40);
    expect(s.observed[1].resumeSessionId).toBe('123e4567-e89b-42d3-a456-426614174000');
  });

  it('disposes the deadline if execution setup throws before invoking the adapter', async () => {
    const s = scenario();
    const time = manualClock();
    await expect(runStage(s.adapter, {
      stageId: s.stageId, role, dependsOn: [], promptTemplate: 'fixture', artifactContract: fixtureArtifactContract(s.stageId),
      projectDir, runId: s.created.runId, runDir: s.created.runDirPath, retries: 0, timeout_ms: 40, deadlineClock: time.clock,
      liveConstraintGuardFactory: () => {
        expect(time.timers.size).toBe(1);
        expect(readStageStatus(projectDir, s.created.runId, s.stageId).timeout?.budgetMs).toBe(40);
        throw new Error('setup refused');
      },
    })).rejects.toThrow('setup refused');
    expect(time.timers.size).toBe(0);
    expect(s.observed).toHaveLength(0);
  });
});
