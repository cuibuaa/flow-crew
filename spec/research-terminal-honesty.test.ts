/**
 * Regression tests for the three engine bugs found auditing the event-drift
 * research run (2026-07-29T01-29-31): a confirm-gate failure on a would-ship
 * round used to (1) terminate the run as ceiling_hit ignoring the brief's
 * declared ceiling floor (4 rounds/32 min vs a declared 5 stages/180 min),
 * (2) leave the declared terminal artifact path unwritten, and (3) freeze
 * still-pending stages in run.json forever.
 *
 * These tests cover the pure decision layer: confirm-failed rounds must be
 * excluded from kept/running-best (so the loop CONTINUES when budget remains
 * instead of re-triggering ship→confirm→fail), and the research ceiling floor
 * must gate a ceiling claim on rounds attempted / wall time.
 */
import { describe, expect, it } from 'vitest';
import { evaluateResearch, evaluateResearchCeilingFloor } from '../src/research-policy.js';
import type { ResearchRound } from '../src/research-policy.js';
import type { ResearchConfig } from '../src/store.js';

/** The event-drift brief's research config, as parsed from its frontmatter. */
const EVENT_DRIFT_CONFIG: ResearchConfig = {
  baseline: 0.0,
  policy: 'best_of_n',
  higherIsBetter: true,
  stop: { beat: 1.0, maxRounds: 8, maxWallHours: 24, haltAfterNoImprovement: 4, improvementSEMultiple: 1 },
};

/** The four measured rounds of the event-drift run, real numbers. */
function eventDriftRounds(r4ConfirmFailed: boolean): ResearchRound[] {
  return [
    { label: 'R1 upgrade drift', result: 0.339 },
    { label: 'R2 downgrade drift', result: -1.57 },
    { label: 'R3 rating momentum', result: -0.439 },
    { label: 'R4 PEAD drift', result: 3.918, ...(r4ConfirmFailed ? { confirmFailed: true } : {}) },
  ];
}

describe('confirm-failed rounds are excluded from kept/running-best', () => {
  it('without the flag, R4 triggers ship (the pre-fix behavior)', () => {
    const ev = evaluateResearch(EVENT_DRIFT_CONFIG, eventDriftRounds(false));
    expect(ev.decision).toBe('ship');
    expect(ev.runningBest).toBe(3.918);
  });

  it('with the flag, R4 is excluded and the loop CONTINUES (budget remains)', () => {
    const ev = evaluateResearch(EVENT_DRIFT_CONFIG, eventDriftRounds(true));
    expect(ev.decision).toBe('continue');           // 4 < max_rounds 8, streak 3 < halt 4
    expect(ev.runningBest).toBe(0.339);             // best_of_n falls back to R1
    expect(ev.keptLabels).toEqual(['R1 upgrade drift']);
    expect(ev.consecutiveNoImprovement).toBe(3);    // R2, R3, R4(confirm-failed)
  });

  it('a confirm-failed round still counts toward the no-improvement halt', () => {
    const cfg: ResearchConfig = { ...EVENT_DRIFT_CONFIG, stop: { ...EVENT_DRIFT_CONFIG.stop, haltAfterNoImprovement: 3 } };
    const ev = evaluateResearch(cfg, eventDriftRounds(true));
    expect(ev.decision).toBe('stop_ceiling');       // streak 3 >= halt 3
  });

  it('greedy_stack also skips confirm-failed rounds', () => {
    const cfg: ResearchConfig = { ...EVENT_DRIFT_CONFIG, policy: 'greedy_stack' };
    const ev = evaluateResearch(cfg, eventDriftRounds(true));
    expect(ev.runningBest).toBe(0.339);
    expect(ev.keptLabels).toEqual(['R1 upgrade drift']);
    expect(ev.decision).toBe('continue');
  });
});

describe('research ceiling floor (rounds are the attempted stages)', () => {
  const floor = { minAttemptedStages: 5, minWallMinutes: 180 };

  it('no floor declared → always passes', () => {
    expect(evaluateResearchCeilingFloor(undefined, 0, 0).passed).toBe(true);
  });

  it('event-drift scenario: 4 rounds / 32 min vs floor 5 stages / 180 min → blocked', () => {
    const check = evaluateResearchCeilingFloor(floor, 4, 32);
    expect(check.passed).toBe(false);
    expect(check.reason).toContain('4 research round');
    expect(check.reason).toContain('requires 5');
  });

  it('stages satisfied → passes even below the wall minimum (wall is advisory)', () => {
    expect(evaluateResearchCeilingFloor(floor, 5, 32).passed).toBe(true);
  });

  it('wall-only floor gates on elapsed minutes', () => {
    expect(evaluateResearchCeilingFloor({ minWallMinutes: 180 }, 4, 32).passed).toBe(false);
    expect(evaluateResearchCeilingFloor({ minWallMinutes: 180 }, 4, 200).passed).toBe(true);
  });
});
