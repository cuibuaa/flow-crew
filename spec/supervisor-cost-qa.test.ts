import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { loadSupervisorConfig, resetConfigCache, type SupervisorConfig } from '../src/config.js';
import type { StoreState } from '../src/store.js';
import {
  buildSupervisorRolePrompt,
  detectStalledStages,
  selectSupervisorAssessmentTrigger,
  Supervisor,
  type StageExecutionFacts,
} from '../src/supervisor.js';
import {
  createSupervisorEvent,
  SupervisorEventCursor,
  type SupervisorEventCandidate,
  type SupervisorEventQuantities,
} from '../src/supervisor-events.js';

const quantities: SupervisorEventQuantities = {
  iteration: 1,
  runningStageCount: 1,
  activeAttempts: [{
    stageId: 'work', attemptIndex: 1,
    attemptStartedAt: '2026-09-25T00:00:00.000Z', elapsedMs: 60_000,
  }],
  minArtifactDeltaBytes: 4096,
  deadlineMarginMs: 60_000,
  pollIntervalMs: 30_000,
  changedBytes: 16_384,
  changedPathCount: 1,
  supervisorAssessmentBudget: { used: 20, maximum: 20, remaining: 0 },
  supervisorRejectBudget: { maximum: 2 },
  gateRetryBudget: { maximum: 3 },
};

function candidate(type: SupervisorEventCandidate['type'], id: string): SupervisorEventCandidate {
  return {
    type,
    observedAt: '2026-09-25T00:01:00.000Z',
    source: 'qa-construction',
    fingerprint: { id },
    quantities,
  };
}

const config: SupervisorConfig = {
  enabled: true,
  adapter: 'mock',
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

afterEach(() => {
  vi.useRealTimers();
  resetConfigCache();
});

describe('supervisor cost audit constructions', () => {
  it('does not call the model for a clock or byte threshold without a typed event', () => {
    expect(selectSupervisorAssessmentTrigger({
      deterministicEvents: [],
      accumulatedOutputBytes: 1_000_000,
      now: 360_000,
      lastRoutineAssessmentAt: 0,
      routineAssessmentIntervalMs: 180_000,
    })).toBe('none');
  });

  it('still calls on busy output with exhausted routine budget and active work', () => {
    const event = createSupervisorEvent(candidate('artifact_change', 'busy-output'));
    expect(selectSupervisorAssessmentTrigger({
      deterministicEvents: [event],
      runningStageCount: 1,
      accumulatedOutputBytes: 16_384,
      now: 60_000,
      lastRoutineAssessmentAt: 59_000,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 20,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: 120_000,
    })).toBe('event');
  });

  it('still calls for a failed gate at the same exhausted budget and cooldown', () => {
    const event = createSupervisorEvent(candidate('gate_verdict', 'failed-gate'));
    expect(selectSupervisorAssessmentTrigger({
      deterministicEvents: [event],
      runningStageCount: 0,
      accumulatedOutputBytes: 0,
      now: 60_000,
      lastRoutineAssessmentAt: 59_000,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 20,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: 120_000,
    })).toBe('event');
  });

  it('selects an urgent event first and consumes a simultaneous artifact event', () => {
    const cursor = new SupervisorEventCursor();
    cursor.offer([candidate('artifact_change', 'output'), candidate('gate_verdict', 'gate')]);
    const selected = cursor.next();
    expect(selected?.type).toBe('gate_verdict');
    expect(selected?.quantities.coalescedEventCount).toBe(2);
    expect(cursor.next()).toBeUndefined();
  });

  it('does not replay an already consumed artifact fingerprint', () => {
    const cursor = new SupervisorEventCursor();
    const artifact = candidate('artifact_change', 'same-output');
    cursor.offer([artifact]);
    expect(cursor.next()?.type).toBe('artifact_change');
    cursor.offer([artifact]);
    expect(cursor.pendingCount).toBe(0);
  });

  it('defers concurrent output only before the exact interval boundary', () => {
    const event = createSupervisorEvent({
      ...candidate('artifact_change', 'two-active-stages'),
      quantities: { ...quantities, runningStageCount: 2, changedPathCount: 2 },
    });
    const common = {
      deterministicEvents: [event],
      lastRoutineAssessmentAt: 1_000,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 20,
      maxRoutineAssessmentsPerIteration: 20,
    };
    expect(selectSupervisorAssessmentTrigger({ ...common, now: 180_999 })).toBe('none');
    expect(selectSupervisorAssessmentTrigger({ ...common, now: 181_000 })).toBe('event');
  });

  it('restores a pending artifact with its first observed time and latest quantities', () => {
    const cursor = new SupervisorEventCursor();
    const first = candidate('artifact_change', 'first-threshold');
    const later = {
      ...candidate('artifact_change', 'later-output'),
      observedAt: '2026-09-25T00:02:00.000Z',
      quantities: { ...quantities, runningStageCount: 2, changedPathCount: 2,
        changedBytes: 32_768 },
    };
    cursor.offer([first]);
    cursor.offer([later]);
    const restored = new SupervisorEventCursor(cursor.snapshot());
    expect(restored.peek()?.observedAt).toBe(first.observedAt);
    expect(restored.peek()?.quantities.changedBytes).toBe(32_768);
    expect(restored.pendingCount).toBe(1);
  });

  it('fails open when a concurrent artifact clock is invalid', () => {
    const event = createSupervisorEvent({
      ...candidate('artifact_change', 'invalid-clock'),
      quantities: { ...quantities, runningStageCount: 2, changedPathCount: 2 },
    });
    expect(selectSupervisorAssessmentTrigger({
      deterministicEvents: [event], now: 50_000,
      lastRoutineAssessmentAt: 60_000,
      routineAssessmentIntervalMs: 180_000,
    })).toBe('event');
    expect(selectSupervisorAssessmentTrigger({
      deterministicEvents: [event], now: 60_000,
      lastRoutineAssessmentAt: 59_000,
      routineAssessmentIntervalMs: Number.NaN,
    })).toBe('event');
  });

  it('does not mistake productive high-output work for an idle stall', () => {
    const result = detectStalledStages({
      runningStages: ['work'],
      progressedStageIds: new Set(['work']),
      lastProgressMs: { work: 0 },
      now: 600_000,
      thresholdMs: 600_000,
    });
    expect(result.stalledStageIds).toEqual([]);
  });

  it('keeps the idle watchdog eligible exactly at the threshold', () => {
    const result = detectStalledStages({
      runningStages: ['work'],
      progressedStageIds: new Set(),
      lastProgressMs: { work: 0 },
      now: 600_000,
      thresholdMs: 600_000,
    });
    expect(result.stalledStageIds).toEqual(['work']);
  });

  it('puts changing elapsed time near the start of consecutive assessment prompts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:01:00.000Z'));
    const supervisor = new Supervisor('/tmp/unused', 'unused', {} as Adapter, config, 'goal');
    const internal = supervisor as unknown as {
      buildAssessmentPrompt: (
        tails: Map<string, string>, state: StoreState, stages: string[],
        artifacts: Array<{ path: string; content: string }>,
        facts: ReadonlyMap<string, StageExecutionFacts>,
      ) => string;
    };
    const state = {
      runId: 'unused', workflowName: 'qa', projectDir: '/tmp/unused',
      status: 'running', startedAt: '2026-09-25T00:00:00.000Z',
      currentIteration: 1, maxIterations: 5,
      stages: { work: { status: 'running', retries: 0, attempts: [{
        index: 1, startedAt: '2026-09-25T00:00:00.000Z', status: 'running',
      }] } },
    } as unknown as StoreState;
    const facts = new Map<string, StageExecutionFacts>([['work', {
      stageId: 'work', attemptIndex: 1,
      attemptStartedAt: '2026-09-25T00:00:00.000Z',
      verdictObserved: false, outputObserved: false, handoffObserved: false,
      commitObserved: false, liveProgressThisTick: true,
      artifactProgressThisTick: false, activeCommandCount: 1,
      commandActivityValid: true, finalizing: false,
      protectedFromIdleAbort: false,
    }]]);
    const args = [new Map([['work', 'active output']]), state, ['work'], [], facts] as const;
    const roleBefore = buildSupervisorRolePrompt(600_000, 'goal');
    const first = internal.buildAssessmentPrompt(...args);
    vi.advanceTimersByTime(1000);
    const second = internal.buildAssessmentPrompt(...args);
    const roleAfter = buildSupervisorRolePrompt(600_000, 'goal');
    let common = 0;
    while (common < first.length && first[common] === second[common]) common++;
    expect(common).toBeLessThan(80);
    expect(first.slice(common)).not.toBe(second.slice(common));
    expect(roleBefore).toBe(roleAfter);
  });

  it.each([
    ['poll_interval_ms', 'pollIntervalMs', 10_000],
    ['routine_assessment_interval_ms', 'routineAssessmentIntervalMs', 60_000],
    ['min_delta_bytes', 'minDeltaBytes', 8_192],
    ['max_assessments_per_iteration', 'maxAssessmentsPerIteration', 1],
    ['stuck_threshold_ms', 'stuckThresholdMs', 120_000],
  ] as const)('loads the configured %s value', (yamlKey, property, value) => {
    const project = mkdtempSync(join(tmpdir(), 'flowcrew-supervisor-cost-qa-'));
    try {
      mkdirSync(join(project, 'config'));
      const source = readFileSync(new URL('../config/defaults.yaml', import.meta.url), 'utf8');
      const line = new RegExp(`(^  ${yamlKey}: )\\d+`, 'm');
      expect(source).toMatch(line);
      writeFileSync(join(project, 'config', 'defaults.yaml'), source.replace(line, `$1${value}`));
      resetConfigCache();
      expect(loadSupervisorConfig(project)[property]).toBe(value);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
