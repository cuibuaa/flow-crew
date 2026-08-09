/**
 * Phase-0 safety net — LoopPolicy decision contract (metric-kind).
 *
 * Pins the observable contract of the research/loop decision policy: given an
 * objective (baseline + stop conditions) and an ordered history of measured
 * rounds, evaluateResearch must return the correct ship | continue | stop_ceiling
 * decision and running-best. This contract MUST survive the P1–P4 refactor — the
 * clean LoopPolicy generalizes it but must not change these answers for metric-kind.
 */
import { describe, expect, it } from 'vitest';
import { evaluateResearch, RESEARCH_POLICY_IDS, type ResearchRound } from '../../src/research-policy.js';
import type { ResearchConfig } from '../../src/store.js';

function cfg(over: Partial<ResearchConfig> = {}): ResearchConfig {
  return { baseline: 0, policy: 'greedy_stack', higherIsBetter: true, ...over } as ResearchConfig;
}
const R = (label: string, result: number, resultStd?: number): ResearchRound => ({ label, result, resultStd });

describe('LoopPolicy / evaluateResearch — metric-kind contract', () => {
  it('no rounds, no stop conditions → continue at baseline', () => {
    const e = evaluateResearch(cfg(), []);
    expect(e.decision).toBe('continue');
    expect(e.runningBest).toBe(0);
  });

  it('ship when running-best reaches the beat target (higher-is-better)', () => {
    const e = evaluateResearch(cfg({ stop: { beat: 1.5 } }), [R('a', 0.5), R('b', 1.6)]);
    expect(e.decision).toBe('ship');
    expect(e.runningBest).toBeCloseTo(1.6);
  });

  it('ceiling on max_rounds', () => {
    const e = evaluateResearch(cfg({ stop: { maxRounds: 2 } }), [R('a', 0.1), R('b', 0.2)]);
    expect(e.decision).toBe('stop_ceiling');
    expect(e.reason).toMatch(/max_rounds/);
  });

  it('ceiling on halt_after_no_improvement streak', () => {
    // baseline 1.0: first round improves, then 2 non-improving → halt=2 ceilings.
    const e = evaluateResearch(cfg({ baseline: 1.0, stop: { haltAfterNoImprovement: 2 } }), [R('a', 1.5), R('b', 1.4), R('c', 1.3)]);
    expect(e.decision).toBe('stop_ceiling');
    expect(e.consecutiveNoImprovement).toBe(2);
  });

  it('ceiling on max_wall_hours', () => {
    const rounds = [{ label: 'a', result: 0.1, wallHoursCumulative: 13 }];
    const e = evaluateResearch(cfg({ stop: { maxWallHours: 12 } }), rounds);
    expect(e.decision).toBe('stop_ceiling');
    expect(e.reason).toMatch(/wall/);
  });

  it('continue while budget remains and a round just improved', () => {
    const e = evaluateResearch(cfg({ stop: { maxRounds: 8, haltAfterNoImprovement: 3 } }), [R('a', 0.1), R('b', 0.2)]);
    expect(e.decision).toBe('continue');
    expect(e.latestKept).toBe(true);
  });

  it('significance margin: a within-1-SE gain does NOT count as improvement', () => {
    // baseline 1.0; round result 1.05 with SE 0.2 → margin 0.2 → 1.05 < 1.0+0.2 → NOT kept.
    const e = evaluateResearch(cfg({ baseline: 1.0, stop: { improvementSEMultiple: 1, haltAfterNoImprovement: 1 } }), [R('a', 1.05, 0.2)]);
    expect(e.latestKept).toBe(false);
    expect(e.runningBest).toBe(1.0);
    expect(e.decision).toBe('stop_ceiling'); // 1 non-improving round, halt=1
  });

  it('significance margin: a gain clearing >1 SE DOES count', () => {
    const e = evaluateResearch(cfg({ baseline: 1.0, stop: { improvementSEMultiple: 1 } }), [R('a', 1.5, 0.2)]);
    expect(e.latestKept).toBe(true);
    expect(e.runningBest).toBeCloseTo(1.5);
  });

  it('lower-is-better: improvement means a smaller value', () => {
    const e = evaluateResearch(cfg({ baseline: 10, higherIsBetter: false, stop: { beat: 5 } }), [R('a', 8), R('b', 4)]);
    expect(e.runningBest).toBe(4);
    expect(e.decision).toBe('ship');
  });

  it('greedy_stack keeps every improving round; best_of_n keeps only the single best', () => {
    const rounds = [R('a', 0.2), R('b', 0.5), R('c', 0.3)];
    const greedy = evaluateResearch(cfg({ policy: 'greedy_stack' }), rounds);
    const bestOf = evaluateResearch(cfg({ policy: 'best_of_n' }), rounds);
    expect(greedy.keptLabels).toEqual(['a', 'b']); // c (0.3) does not beat running-best 0.5
    expect(bestOf.keptLabels).toEqual(['b']);       // only the single best label
    expect(greedy.runningBest).toBeCloseTo(0.5);
    expect(bestOf.runningBest).toBeCloseTo(0.5);
  });

  it('policy registry is the single source of allowed ids', () => {
    expect([...RESEARCH_POLICY_IDS].sort()).toEqual(['best_of_n', 'greedy_stack', 'replace_if_better']);
  });
});
