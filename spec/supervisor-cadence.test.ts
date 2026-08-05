import { describe, expect, it } from 'vitest';
import {
  buildSupervisorSystemPrompt,
  detectSupervisorAnomalySignals,
  selectSupervisorAssessmentTrigger,
  summarizeSupervisorGuidanceHistory,
  SUPERVISOR_VERDICTS,
} from '../src/supervisor.js';
import type { StoreState } from '../src/store.js';

function baseState(): StoreState {
  return {
    runId: 'run', workflowName: 'test', projectDir: '/tmp/project', status: 'running',
    startedAt: '2026-07-31T00:00:00.000Z', currentIteration: 1,
    stages: { work: { status: 'running', retries: 0 } },
  };
}

describe('supervisor routine/anomaly scheduling', () => {
  it('keeps every intervention verdict available', () => {
    expect(SUPERVISOR_VERDICTS.map((verdict) => verdict.id)).toEqual([
      'WAIT', 'GUIDE', 'EXTEND', 'ABORT', 'REPLAN', 'REJECT', 'DONE',
    ]);
  });

  it('allows repeated GUIDE decisions to escalate a high-output wrong direction to ABORT', () => {
    const prompt = buildSupervisorSystemPrompt(20 * 60_000);
    expect(prompt).toContain('same concrete wrong direction continues after repeated GUIDE decisions');
    expect(prompt).toContain('Active or high-volume output is not proof');
    expect(prompt).toContain('Do not ABORT slow but correct work');
    expect(prompt).not.toContain('ABORT only if a stage has been running');

    const history = summarizeSupervisorGuidanceHistory(
      Array.from({ length: 10 }, (_, index) => ({
        assessment: {
          verdict: 'GUIDE' as const,
          targetStage: 'run_round1',
          reason: `still following the same wrong recipe ${index + 1}`,
          guidance: 'use the required teacher rationale source',
        },
      })),
      ['run_round1'],
    );
    expect(history).toContain('run_round1: 10 cumulative GUIDE decisions');
    expect(history).toContain('same wrong recipe 8');
    expect(history).toContain('same wrong recipe 10');
    expect(history).not.toContain('same wrong recipe 7');
  });

  it('lets anomaly signals bypass cadence, output threshold, cooldown, and routine cap', () => {
    expect(selectSupervisorAssessmentTrigger({
      anomalySignals: ['gate_failed:release'],
      runningStageCount: 0,
      accumulatedOutputBytes: 0,
      minDeltaBytes: 4096,
      now: 1,
      lastRoutineAssessmentAt: 1,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 20,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: Number.MAX_SAFE_INTEGER,
    })).toBe('anomaly');
  });

  it('requires cumulative 4096 bytes and 180 seconds for an ordinary assessment', () => {
    const common = {
      anomalySignals: [] as string[],
      runningStageCount: 1,
      minDeltaBytes: 4096,
      now: 180_000,
      lastRoutineAssessmentAt: 0,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 0,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: 0,
    };
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 1500 + 1500 + 1500 })).toBe('routine');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4095 })).toBe('none');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4096, now: 179_999 })).toBe('none');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4096, routineAssessmentsThisIteration: 20 })).toBe('none');
  });

  it('retains enough semantic opportunities for the real 2789-second 10 GUIDE → ABORT case', () => {
    const historical = [
      [5, '2026-07-06T08:04:10.409Z', 'GUIDE'],
      [7, '2026-07-06T08:05:43.309Z', 'GUIDE'],
      [11, '2026-07-06T08:07:59.316Z', 'GUIDE'],
      [21, '2026-07-06T08:13:14.799Z', 'GUIDE'],
      [31, '2026-07-06T08:18:30.731Z', 'GUIDE'],
      [41, '2026-07-06T08:23:39.211Z', 'GUIDE'],
      [51, '2026-07-06T08:28:48.101Z', 'GUIDE'],
      [61, '2026-07-06T08:33:55.903Z', 'GUIDE'],
      [72, '2026-07-06T08:39:32.545Z', 'GUIDE'],
      [82, '2026-07-06T08:44:42.067Z', 'GUIDE'],
      [92, '2026-07-06T08:49:48.315Z', 'ABORT'],
    ] as const;
    expect(historical.filter(([, , verdict]) => verdict === 'GUIDE')).toHaveLength(10);
    expect(historical.at(-1)).toEqual([92, '2026-07-06T08:49:48.315Z', 'ABORT']);
    const timestamps = historical.map(([, timestamp]) => Date.parse(timestamp));
    expect(timestamps.at(-1)! - timestamps[0]).toBe(2_737_906);
    expect(timestamps.at(-1)! - timestamps.at(-2)!).toBe(306_248);
    expect(Math.max(...timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]))).toBe(336_642);

    const historicalWindowMs = 2_789_000;
    const conservativeCycleMs = 180_000 + 30_000; // cadence plus full assessment timeout
    const opportunities = Math.floor(historicalWindowMs / conservativeCycleMs);
    expect(opportunities).toBe(13);
    expect(opportunities).toBeGreaterThanOrEqual(11); // ten GUIDE decisions plus ABORT
    expect(20).toBeGreaterThanOrEqual(opportunities); // routine cap cannot truncate the sequence
  });

  it('detects every enumerated immediate signal class', () => {
    const state = baseState();
    state.status = 'parked';
    state.campaignAlert = {
      type: 'plateau', action: 'inject_researcher', message: 'flat metric',
      source: 'campaign_health', triggeredAt: '2026-07-31T00:01:00.000Z', iteration: 1,
    };
    state.budget = { totalTokens: 1000, usedTokens: 950 };
    state.stages.work = {
      status: 'failed', retries: 1,
      attempts: [
        { index: 1, startedAt: 'a', completedAt: 'b', status: 'failed' },
        { index: 2, startedAt: 'c', completedAt: 'd', status: 'failed' },
      ],
    };
    const signals = detectSupervisorAnomalySignals({
      state,
      stageTransitionFingerprint: 'work:running>failed',
      stalledStageIds: ['work'],
      recentArtifacts: [{ path: 'verdict_release.json', content: '{"pass":false,"reason":"broken"}' }],
      userInput: 'inspect the failure',
      pendingApprovalFingerprint: 'work:123',
    });
    for (const prefix of [
      'stage_transition:', 'stalled:', 'gate_failed:', 'repeated_failure:',
      'metric_plateau:', 'budget_near_exhaustion:', 'pending_approval:',
      'pending_approval_state:', 'user_input:',
    ]) {
      expect(signals.some((signal) => signal.startsWith(prefix)), prefix).toBe(true);
    }
  });
});
