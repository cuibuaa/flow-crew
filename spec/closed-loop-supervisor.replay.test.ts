import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import type { SupervisorConfig } from '../src/config.js';
import {
  SupervisorEventCursor,
  createSupervisorEvent,
  isCompleteSupervisorEvent,
  replayDeterministicSupervisorTimeline,
  type SupervisorEventCandidate,
  type SupervisorEventQuantities,
} from '../src/supervisor-events.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { readTraceEvents } from '../src/trace.js';
import {
  loadClosedLoopEngineEvidence,
  summarizeDistribution,
} from './test-support/closed-loop-engine-evidence.js';

const config: SupervisorConfig = {
  enabled: true,
  adapter: 'fixture',
  model: 'default',
  reasoningEffort: 'low',
  pollIntervalMs: 30_000,
  routineAssessmentIntervalMs: 180_000,
  cooldownAfterActionMs: 60_000,
  maxAssessmentsPerIteration: 20,
  tailBytes: 16_384,
  minDeltaBytes: 4096,
  stuckThresholdMs: 600_000,
};

const quantities: SupervisorEventQuantities = {
  iteration: 1,
  runningStageCount: 1,
  activeAttempts: [],
  minArtifactDeltaBytes: 4096,
  deadlineMarginMs: 60_000,
  pollIntervalMs: 30_000,
  changedBytes: 4096,
  changedPathCount: 1,
  supervisorAssessmentBudget: { used: 0, maximum: 20, remaining: 20 },
  supervisorRejectBudget: { maximum: 2 },
  gateRetryBudget: { maximum: 2 },
};

let projectDir: string;
let stateDir: string;
let priorStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-supervisor-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-supervisor-state-'));
  priorStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
});

afterEach(() => {
  setFcGlobalDir(priorStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('deterministic supervisor event replay', () => {
  it('replays the byte-anchored 120-call cutoff as 37 event calls with exact token totals', () => {
    const evidence = loadClosedLoopEngineEvidence();
    expect(evidence.baseFailures.behavior2).toEqual({
      exitCode: 1,
      logBytes: 934,
      logSha256: '2ce54c2b125da72582696fdc1096e1380217e078c54fc23e95bd289eb94f44f2',
    });
    const replay = replayDeterministicSupervisorTimeline(evidence.calls);
    expect(replay).toMatchObject({
      beforeCalls: 120,
      afterCalls: 37,
      beforeTokensIn: 2_172_792,
      afterTokensIn: 653_704,
      beforeTokensOut: 9_840,
      afterTokensOut: 3_427,
    });
    expect(replay.afterCalls).toBe(evidence.expectedCounterfactual.calls);
    expect(replay.retained.every((row) => row.eventId && row.eventType)).toBe(true);
    expect(evidence.finalHistoricalStateForDisclosure).toMatchObject({
      calls: 121, tokensIn: 2_190_534,
    });

    const beforeTokens = summarizeDistribution({
      name: 'historical_supervisor_input_tokens_per_call',
      unit: 'tokens/call',
      phase: 'before',
      samples: evidence.calls.map((call) => call.tokensIn),
    });
    const afterTokens = summarizeDistribution({
      name: 'counterfactual_supervisor_input_tokens_per_retained_call',
      unit: 'tokens/call',
      phase: 'after',
      samples: replay.retained.map((call) => call.tokensIn),
    });
    for (const distribution of [beforeTokens, afterTokens]) {
      expect(distribution.mean).toBeGreaterThan(0);
      expect(distribution.median).toBeGreaterThan(0);
      expect(distribution.reportedRank).toBeGreaterThan(0);
      expect(distribution.reportedPercentile).toBeGreaterThan(0);
      expect(distribution.method_was_not_adjusted_to_match_expectation).toBe(true);
    }
  });

  it('separates the two historical false ABORT mechanisms', () => {
    const evidence = loadClosedLoopEngineEvidence();
    const replay = replayDeterministicSupervisorTimeline(evidence.calls);
    const first = evidence.falseAborts.find((call) => call.index === 21)!;
    const second = evidence.falseAborts.find((call) => call.index === 22)!;
    expect(first).toMatchObject({
      tokensIn: 18_941,
      selectedByReconstructableEvent: true,
      clockComparison: { stageElapsedMs: 5_452_486, activeAttemptElapsedMs: 292 },
    });
    expect(replay.retained.some((row) => row.callIndex === 21)).toBe(true);
    expect(first.expectedCurrentDisposition).toContain('ABORT is invalid');
    expect(second).toMatchObject({
      tokensIn: 19_069,
      selectedByReconstructableEvent: false,
      clockComparison: { stageElapsedMs: 5_494_800, activeAttemptElapsedMs: 42_606 },
      expectedCurrentDisposition: 'no model call',
    });
    expect(replay.omittedCallIndexes).toContain(22);
    expect(evidence.anchors.falseAbort1.sha256).toBe('053622832acd0441624ce23d2bc809379543b3820947a6d2358ade87e455dd1b');
    expect(evidence.anchors.falseAbort2.sha256).toBe('44a4f8e34e1d3dca0b0e6bd3ca2d9947156ddd6c737b87ea1119b22793566765');
  });

  it('coalesces a deterministic event batch, suppresses duplicate ticks, and restores its cursor', () => {
    const types = [
      'stage_transition', 'gate_verdict', 'artifact_change', 'deadline_margin',
      'guidance_arrival', 'scope_request', 'adapter_failure',
    ] as const;
    const candidates: SupervisorEventCandidate[] = types.map((type, index) => ({
      type,
      observedAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index)).toISOString(),
      source: 'fixture',
      fingerprint: { type, index },
      quantities,
    }));
    const cursor = new SupervisorEventCursor();
    cursor.offer(candidates);
    const selected = cursor.next()!;
    expect(selected.type).toBe('guidance_arrival');
    expect(selected.quantities.coalescedEventCount).toBe(7);
    expect(isCompleteSupervisorEvent(selected)).toBe(true);
    cursor.offer(candidates);
    expect(cursor.next()).toBeUndefined();
    expect(new SupervisorEventCursor(cursor.snapshot()).next()).toBeUndefined();
  });

  it('uses the active attempt clock, persists the trigger on raw and effective verdicts, and makes no call on the next empty tick', async () => {
    const yaml = 'name: event-supervisor\nstages:\n  - id: work\n    role: coder\n';
    const created = createRun(projectDir, 'event-supervisor', yaml, ['work']);
    const now = Date.now();
    const attemptStartedAt = new Date(now - 300).toISOString();
    const state = readRunState(projectDir, created.runId);
    state.startedAt = new Date(now - 5_452_486).toISOString();
    state.stages.work = {
      status: 'running',
      retries: 0,
      startedAt: state.startedAt,
      attempts: [{ index: 3, startedAt: attemptStartedAt, status: 'running' }],
    };
    writeRunState(projectDir, created.runId, state);
    writeFileSync(join(runDir(projectDir, created.runId), 'verdict_audit_round.json'), JSON.stringify({
      pass: true, reason: 'gate transition fixture',
    }));

    let calls = 0;
    const prompts: string[] = [];
    const adapter: Adapter = { async run(prompt) {
      calls++;
      prompts.push(prompt);
      return {
        output: JSON.stringify({
          verdict: 'ABORT', target_stage: 'work',
          reason: 'incorrectly measured the whole stage clock', guidance: null,
        }),
        exitCode: 0,
        duration_ms: 1,
        tokens_in: 18_941,
        tokens_out: 258,
      };
    } };
    const supervisor = new Supervisor(projectDir, created.runId, adapter, config, 'event supervisor fixture');
    const tick = () => (supervisor as unknown as { tick(): Promise<void> }).tick();

    await tick();
    expect(calls).toBe(1);
    expect(prompts[0]).toContain('# Deterministic Triggering Event');
    const usage = JSON.parse(readFileSync(
      join(runDir(projectDir, created.runId), 'stages', '_supervisor', 'status.json'),
      'utf-8',
    )) as {
      attempts: Array<{
        trigger: ReturnType<typeof createSupervisorEvent>;
        unverifiedAssessment: { verdict: string };
        verdict: string;
        effectiveReason: string;
      }>;
    };
    expect(usage.attempts[0]).toMatchObject({
      trigger: { type: 'gate_verdict', source: 'artifact_scan' },
      unverifiedAssessment: { verdict: 'ABORT' },
      verdict: 'WAIT',
    });
    expect(isCompleteSupervisorEvent(usage.attempts[0].trigger)).toBe(true);
    expect(usage.attempts[0].effectiveReason).toContain('only 0 prior GUIDE');
    const active = usage.attempts[0].trigger.quantities.activeAttempts[0];
    expect(active).toMatchObject({ stageId: 'work', attemptIndex: 3, attemptStartedAt });
    expect(active.elapsedMs).toBeLessThan(10_000);
    expect(existsSync(join(runDir(projectDir, created.runId), 'signals', 'abort_work.json'))).toBe(false);

    await tick();
    expect(calls).toBe(1);
    const supervisorState = JSON.parse(readFileSync(
      join(runDir(projectDir, created.runId), 'supervisor_state.json'),
      'utf-8',
    )) as { actions: Array<{ verdict: string; trigger: ReturnType<typeof createSupervisorEvent> }> };
    expect(supervisorState.actions[0]).toMatchObject({
      verdict: 'WAIT', trigger: { type: 'gate_verdict' },
    });
    expect(supervisorState.actions[0].trigger.quantities).toMatchObject({
      minArtifactDeltaBytes: 4096,
      deadlineMarginMs: 60_000,
      supervisorAssessmentBudget: { maximum: 20 },
    });
    expect(readTraceEvents(projectDir, created.runId, '_supervisor')[0].inputSummary).toContain('triggered by gate_verdict');

    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    writeFileSync(
      join(runDir(projectDir, created.runId), 'stages', 'work', 'attempt_deadline_execution_3_budget.jsonl'),
      `${JSON.stringify({
        type: 'attempt_deadline_created',
        attemptId: 'deadline-fixture',
        observedAt: new Date().toISOString(),
        elapsedMs: 300,
        remainingMs: 30_000,
        budgetMs: 60_000,
        attemptStartedAt,
        deadlineAt,
      })}\n`,
    );
    await tick();
    expect(calls).toBe(2);
    const deadlineUsage = JSON.parse(readFileSync(
      join(runDir(projectDir, created.runId), 'stages', '_supervisor', 'status.json'),
      'utf-8',
    )) as { attempts: Array<{ trigger: ReturnType<typeof createSupervisorEvent> }> };
    expect(deadlineUsage.attempts[1].trigger).toMatchObject({
      type: 'deadline_margin',
      source: 'attempt_deadline_ledger',
      quantities: {
        deadlineStageId: 'work',
        deadlineAttemptIndex: 3,
        deadlineMarginMs: 60_000,
      },
    });
    expect(deadlineUsage.attempts[1].trigger.quantities.deadlineRemainingMs).toBeLessThanOrEqual(30_000);
  });
});
