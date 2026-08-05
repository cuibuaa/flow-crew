import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import type { SupervisorConfig } from '../src/config.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import {
  inspectStageExecutionFacts,
  Supervisor,
  type SupervisorAssessment,
} from '../src/supervisor.js';
import { readTraceEvents } from '../src/trace.js';
import { runStage } from '../src/worker.js';

const stageId = 'acceptance_gate';
const role: AgentConfig = {
  name: 'qa',
  description: 'test gate',
  tools: [],
  prompt: 'verify the deliverable',
};
const supervisorConfig: SupervisorConfig = {
  enabled: true,
  adapter: 'scripted',
  model: 'test',
  reasoningEffort: 'low',
  pollIntervalMs: 30_000,
  routineAssessmentIntervalMs: 180_000,
  cooldownAfterActionMs: 0,
  maxAssessmentsPerIteration: 20,
  tailBytes: 16_384,
  minDeltaBytes: 4096,
  stuckThresholdMs: 1_000,
};

let projectDir: string;
let isolatedFcHome: string;
let previousFcHome: string;
let currentRunId: string;
let currentRunDir: string;

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e8-project-'));
  isolatedFcHome = mkdtempSync(join(tmpdir(), 'flowcrew-e8-home-'));
  setFcGlobalDir(isolatedFcHome);
  const created = createRun(
    projectDir,
    'e8-supervision',
    'name: e8-supervision\nstages:\n  - id: acceptance_gate\n    role: qa\n',
    [stageId],
  );
  currentRunId = created.runId;
  currentRunDir = created.runDirPath;
  mkdirSync(join(currentRunDir, 'signals'), { recursive: true });
  writeFileSync(join(currentRunDir, 'task_brief.md'), '# Deterministic E8 fixture\n');
});

afterEach(() => {
  vi.useRealTimers();
  setFcGlobalDir(previousFcHome);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedFcHome, { recursive: true, force: true });
});

function markRunningAttempt(startedAt = new Date(Date.now() - 60_000).toISOString()): void {
  const state = readRunState(projectDir, currentRunId);
  state.stages[stageId] = {
    status: 'running',
    retries: 0,
    startedAt,
    attempts: [{ index: 1, startedAt, status: 'running' }],
  };
  writeRunState(projectDir, currentRunId, state);
}

function waitThenReturnOnAbort(cleanDelayMs = 2_500): Adapter {
  return {
    name: 'abort-aware-test-adapter',
    detect: () => true,
    run: async (_prompt, _role, opts): Promise<RunResult> => new Promise((resolve) => {
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(cleanTimer);
        resolve(aborted
          ? { output: '[stage aborted by supervisor]\n', exitCode: 137, duration_ms: 2_000 }
          : { output: 'completed normally\n', exitCode: 0, duration_ms: cleanDelayMs });
      };
      const cleanTimer = setTimeout(() => finish(false), cleanDelayMs);
      if (opts.abortSignal?.aborted) finish(true);
      else opts.abortSignal?.addEventListener('abort', () => finish(true), { once: true });
    }),
  };
}

function stageOptions() {
  return {
    stageId,
    role,
    dependsOn: [] as string[],
    promptTemplate: 'perform the acceptance check',
    timeout_ms: 60_000,
    projectDir,
    runId: currentRunId,
    runDir: currentRunDir,
    retries: 0,
  };
}

describe('factual supervisor stall decisions', () => {
  it('distinguishes current-attempt verdict, handoff, and commit facts', () => {
    markRunningAttempt();
    writeFileSync(join(currentRunDir, `verdict_${stageId}.json`), '{"pass":false}\n');
    writeFileSync(join(currentRunDir, `handoff_${stageId}.md`), '## Delivered\nchecked\n');
    const status = readRunState(projectDir, currentRunId).stages[stageId];

    const facts = inspectStageExecutionFacts({
      runDir: currentRunDir,
      stageId,
      status,
      sinceMs: Date.now() - 1_000,
      commitObserved: true,
    });

    expect(facts).toMatchObject({
      attemptIndex: 1,
      verdictObserved: true,
      handoffObserved: true,
      commitObserved: true,
      protectedFromIdleAbort: true,
      finalizing: false,
    });
  });

  it('does not treat an earlier attempt output as a new finalization window', () => {
    const outputPath = join(currentRunDir, 'stages', stageId, 'output.md');
    writeFileSync(outputPath, 'old attempt output\n');
    const oldTime = new Date(Date.now() - 120_000);
    utimesSync(outputPath, oldTime, oldTime);
    const attemptOneStart = new Date(Date.now() - 180_000).toISOString();
    const attemptTwoStart = new Date(Date.now() - 60_000).toISOString();

    const facts = inspectStageExecutionFacts({
      runDir: currentRunDir,
      stageId,
      status: {
        status: 'running',
        retries: 0,
        attempts: [
          { index: 1, startedAt: attemptOneStart, completedAt: attemptTwoStart, status: 'failed' },
          { index: 2, startedAt: attemptTwoStart, status: 'running' },
        ],
      },
      sinceMs: Date.now() - 1_000,
    });

    expect(facts.outputObserved).toBe(false);
    expect(facts.finalizing).toBe(false);
    expect(facts.protectedFromIdleAbort).toBe(false);
  });

  it('does not abort a quiet stage while it is writing durable artifacts', async () => {
    markRunningAttempt();
    const adapter: Adapter = {
      run: async () => ({
        output: '{"verdict":"WAIT","target_stage":null,"reason":"artifact progress","guidance":null}',
        exitCode: 0,
        duration_ms: 1,
      }),
    };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const internals = supervisor as unknown as {
      tick(): Promise<void>;
      act(assessment: SupervisorAssessment): Promise<SupervisorAssessment>;
      prevStageStatusSnapshot: Record<string, string>;
      stageLastProgressMs: Record<string, number>;
      watchdogLastArtifactCheckMs: number;
    };
    internals.prevStageStatusSnapshot = { [stageId]: 'running' };
    internals.stageLastProgressMs = { [stageId]: Date.now() - 10_000 };
    internals.watchdogLastArtifactCheckMs = Date.now() - 1_000;
    const checkpoint = join(currentRunDir, 'stages', stageId, 'checkpoint.json');
    writeFileSync(checkpoint, '{"completed_checks":17}\n');
    const future = new Date(Date.now() + 100);
    utimesSync(checkpoint, future, future);

    await internals.tick();

    expect(existsSync(join(currentRunDir, 'signals', `abort_${stageId}.json`))).toBe(false);
  });

  it('rechecks durable progress written during semantic assessment before an idle ABORT', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startedAt = new Date(now - 60_000).toISOString();
    markRunningAttempt(startedAt);
    const checkpoint = join(currentRunDir, 'stages', stageId, 'checkpoint.json');
    const adapter: Adapter = {
      run: async () => new Promise((resolve) => {
        setTimeout(() => {
          writeFileSync(checkpoint, '{"completed_checks":18}\n');
          resolve({
            output: '{"verdict":"ABORT","target_stage":"acceptance_gate","reason":"stdout was quiet","guidance":null}',
            exitCode: 0,
            duration_ms: 1_500,
          });
        }, 1_500);
      }),
    };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const internals = supervisor as unknown as {
      tick(): Promise<void>;
      prevStageStatusSnapshot: Record<string, string>;
      stageLastProgressMs: Record<string, number>;
      watchdogAttemptKeys: Record<string, string>;
      watchdogLastArtifactCheckMs: number;
    };
    internals.prevStageStatusSnapshot = { [stageId]: 'running' };
    internals.stageLastProgressMs = { [stageId]: now - 500 };
    internals.watchdogAttemptKeys = { [stageId]: `${stageId}:1:${startedAt}` };
    internals.watchdogLastArtifactCheckMs = now;
    writeFileSync(join(currentRunDir, 'user_input.md'), 'check progress now\n');

    const tick = internals.tick();
    await vi.advanceTimersByTimeAsync(1_500);
    await tick;

    expect(readFileSync(checkpoint, 'utf-8')).toContain('18');
    expect(existsSync(join(currentRunDir, 'signals', `abort_${stageId}.json`))).toBe(false);
    const supervisorState = JSON.parse(readFileSync(
      join(currentRunDir, 'supervisor_state.json'),
      'utf-8',
    )) as { actions: Array<{ verdict: string; reason: string }> };
    expect(supervisorState.actions.at(-1)).toMatchObject({ verdict: 'WAIT' });
    expect(supervisorState.actions.at(-1)?.reason).toMatch(/artifact progress/i);
  });

  it('protects the current attempt after terminal output is written while its verdict is finalizing', async () => {
    markRunningAttempt();
    writeFileSync(
      join(currentRunDir, 'stages', stageId, 'output.md'),
      'Final consistency check complete. I am now writing the one-time verdict.\n',
    );
    const adapter: Adapter = {
      run: async () => ({
        output: '{"verdict":"ABORT","target_stage":"acceptance_gate","reason":"already emitted a failing verdict","guidance":null}',
        exitCode: 0,
        duration_ms: 1,
      }),
    };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const internals = supervisor as unknown as {
      tick(): Promise<void>;
      prevStageStatusSnapshot: Record<string, string>;
      stageLastProgressMs: Record<string, number>;
      watchdogLastArtifactCheckMs: number;
    };
    internals.prevStageStatusSnapshot = { [stageId]: 'running' };
    internals.stageLastProgressMs = { [stageId]: Date.now() - 10_000 };
    internals.watchdogLastArtifactCheckMs = Date.now() + 10_000;

    await internals.tick();
    const semanticResult = await internals.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'already emitted a failing verdict',
      guidance: null,
    });

    expect(existsSync(join(currentRunDir, 'signals', `abort_${stageId}.json`))).toBe(false);
    expect(existsSync(join(currentRunDir, `verdict_${stageId}.json`))).toBe(false);
    expect(semanticResult.verdict).toBe('WAIT');
    expect(semanticResult.reason).toMatch(/finalization window/i);
  });

  it('replaces an unverified model claim with a reason that states no verdict was observed', async () => {
    markRunningAttempt();
    const adapter: Adapter = { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const internals = supervisor as unknown as {
      act(assessment: SupervisorAssessment): Promise<void>;
      stageLastProgressMs: Record<string, number>;
    };
    internals.stageLastProgressMs = { [stageId]: Date.now() - 10_000 };

    await internals.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'The gate is stuck after already emitting an honest failing verdict.',
      guidance: null,
    });

    const signal = JSON.parse(readFileSync(
      join(currentRunDir, 'signals', `abort_${stageId}.json`),
      'utf-8',
    )) as {
      version: number;
      stageId: string;
      attemptIndex: number;
      reason: string;
      source: string;
      unverifiedAssessmentReason: string;
    };
    expect(signal).toMatchObject({
      version: 1,
      stageId,
      attemptIndex: 1,
      source: 'supervisor',
      unverifiedAssessmentReason: 'The gate is stuck after already emitting an honest failing verdict.',
    });
    expect(signal.reason).toMatch(/no verdict observed/i);
    expect(signal.reason).not.toContain('already emitting');
  });

  it('labels the raw model claim unverified and persists the grounded effective assessment', async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    markRunningAttempt(startedAt);
    const rawReason = 'The gate already emitted a failing verdict and should be killed.';
    const adapter: Adapter = {
      run: async () => {
        writeFileSync(
          join(currentRunDir, 'stages', stageId, 'output.md'),
          'Final checks complete; writing the one-time verdict now.\n',
        );
        return {
          output: JSON.stringify({
            verdict: 'ABORT',
            target_stage: stageId,
            reason: rawReason,
            guidance: null,
          }),
          exitCode: 0,
          duration_ms: 1,
        };
      },
    };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const internals = supervisor as unknown as {
      tick(): Promise<void>;
      prevStageStatusSnapshot: Record<string, string>;
      stageLastProgressMs: Record<string, number>;
      watchdogAttemptKeys: Record<string, string>;
    };
    internals.prevStageStatusSnapshot = { [stageId]: 'running' };
    internals.stageLastProgressMs = { [stageId]: Date.now() };
    internals.watchdogAttemptKeys = { [stageId]: `${stageId}:1:${startedAt}` };
    writeFileSync(join(currentRunDir, 'user_input.md'), 'verify the finalization state\n');

    await internals.tick();

    expect(existsSync(join(currentRunDir, 'signals', `abort_${stageId}.json`))).toBe(false);
    const usage = JSON.parse(readFileSync(
      join(currentRunDir, 'stages', '_supervisor', 'status.json'),
      'utf-8',
    )) as {
      attempts: Array<{
        verdict?: string;
        effectiveReason?: string;
        unverifiedAssessment?: { verdict: string; reason: string };
      }>;
    };
    expect(usage.attempts.at(-1)).toMatchObject({
      verdict: 'WAIT',
      unverifiedAssessment: { verdict: 'ABORT', reason: rawReason },
    });
    expect(usage.attempts.at(-1)?.effectiveReason).toMatch(/no verdict observed/i);
    expect(usage.attempts.at(-1)?.effectiveReason).toMatch(/finalization window/i);

    const trace = readTraceEvents(projectDir, currentRunId, '_supervisor');
    expect(trace.at(-1)?.outputSummary).toContain(rawReason);
    expect(trace.at(-1)?.outputSummary).toMatch(/unverified model assessment/i);
  });

  it('still aborts a productive wrong direction after repeated GUIDE decisions', async () => {
    markRunningAttempt();
    const adapter: Adapter = { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) };
    const supervisor = new Supervisor(projectDir, currentRunId, adapter, supervisorConfig, 'test goal');
    const guideAssessment: SupervisorAssessment = {
      verdict: 'GUIDE',
      targetStage: stageId,
      reason: 'same wrong implementation path',
      guidance: 'use the required production path',
    };
    const internals = supervisor as unknown as {
      act(assessment: SupervisorAssessment): Promise<SupervisorAssessment>;
      actions: Array<{
        timestamp: string;
        tick: number;
        assessment: SupervisorAssessment;
        runningStages: string[];
      }>;
      stageLastProgressMs: Record<string, number>;
    };
    internals.actions = [1, 2].map((tick) => ({
      timestamp: new Date().toISOString(),
      tick,
      assessment: guideAssessment,
      runningStages: [stageId],
    }));
    internals.stageLastProgressMs = { [stageId]: Date.now() };

    const result = await internals.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the same wrong direction continues despite active output',
      guidance: null,
    });

    expect(result.verdict).toBe('ABORT');
    expect(result.reason).toContain('2 prior GUIDE decisions observed');
    expect(existsSync(join(currentRunDir, 'signals', `abort_${stageId}.json`))).toBe(true);
  });
});

describe('attempt-scoped one-shot abort signals', () => {
  it('consumes a matching signal once so the next same-name attempt runs normally', async () => {
    vi.useFakeTimers();
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    writeFileSync(signalPath, JSON.stringify({
      version: 1,
      stageId,
      attemptIndex: 1,
      reason: 'verified idle stage',
      timestamp: new Date().toISOString(),
      source: 'watchdog',
    }));

    const firstRun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_000);
    const first = await firstRun;
    const signalAfterFirst = existsSync(signalPath);

    const secondRun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_500);
    const second = await secondRun;

    expect({ firstExit: first.exitCode, signalAfterFirst, secondExit: second.exitCode }).toEqual({
      firstExit: 137,
      signalAfterFirst: false,
      secondExit: 0,
    });
  });

  it('ignores, warns about, and removes an abort signal owned by an old attempt', async () => {
    vi.useFakeTimers();
    beginStageAttempt(projectDir, currentRunId, stageId, 0, '2026-08-01T00:00:00.000Z');
    completeStageAttempt(projectDir, currentRunId, stageId, 0, {
      exitCode: 0,
      duration_ms: 1,
      completedAt: '2026-08-01T00:00:01.000Z',
    });
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    writeFileSync(signalPath, JSON.stringify({
      version: 1,
      stageId,
      attemptIndex: 1,
      reason: 'belongs to attempt one',
      timestamp: '2026-08-01T00:00:00.500Z',
      source: 'supervisor',
    }));

    const rerun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await rerun;
    const liveLog = readFileSync(join(currentRunDir, 'stages', stageId, 'live.log'), 'utf-8');

    expect(result.exitCode).toBe(0);
    expect(existsSync(signalPath)).toBe(false);
    expect(liveLog).toMatch(/ignored stale supervisor abort signal/i);
    expect(liveLog).toContain('expected attempt 2');
    expect(liveLog).toContain('observed attempt 1');
  });

  it('cleans an owned signal when the adapter throws before the next poll', async () => {
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    const adapter: Adapter = {
      run: async () => {
        writeFileSync(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'arrived during a crashing adapter call',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        throw new Error('deterministic adapter crash');
      },
    };

    await expect(runStage(adapter, stageOptions())).rejects.toThrow('deterministic adapter crash');
    expect(existsSync(signalPath)).toBe(false);
  });
});
