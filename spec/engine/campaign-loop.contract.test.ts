/**
 * Phase-0 safety net — autonomous outer loop (P3) contract.
 *
 * The campaign loop is the SAME loop at direction scope: propose a direction → execute it → the
 * SAME policy (evaluateResearch) decides ship/continue/frontier. Mock-driven (no LLM, no runs):
 * pins that it explores until the policy ships / ceilings / the proposer runs dry, never repeats
 * a tried direction, and reuses the inner policy verbatim.
 */
import { describe, expect, it } from 'vitest';
import { runCampaignLoop, type DirectionOutcome } from '../../src/campaign-loop.js';
import type { ResearchConfig } from '../../src/store.js';

function objective(stop: Record<string, unknown>): ResearchConfig {
  return { baseline: 0, policy: 'best_of_n', higherIsBetter: true, stop } as ResearchConfig;
}

/** A proposer that hands out a fixed sequence of directions, then null (frontier). */
function sequenceProposer(seq: string[]): (tried: string[]) => Promise<string | null> {
  return async (tried: string[]) => seq.find((d) => !tried.includes(d)) ?? null;
}

describe('autonomous outer loop — runCampaignLoop (mock-driven)', () => {
  it('ships when a direction beats the campaign target', async () => {
    const results: Record<string, number> = { d1: 0.5, d2: 2.0 };
    const res = await runCampaignLoop({
      objective: objective({ beat: 1.5, maxRounds: 8, haltAfterNoImprovement: 3 }),
      propose: sequenceProposer(['d1', 'd2', 'd3']),
      executeDirection: async (d): Promise<DirectionOutcome> => ({ direction: d, bestResult: results[d] ?? 0 }),
    });
    expect(res.decision).toBe('shipped');
    expect(res.outcomes.map((o) => o.direction)).toEqual(['d1', 'd2']);
  });

  it('reaches frontier (policy ceiling) after non-improving directions, never repeating one', async () => {
    const results: Record<string, number> = { d1: 0.5, d2: 0.4, d3: 0.3 };
    const seen: string[] = [];
    const res = await runCampaignLoop({
      objective: objective({ beat: 99, maxRounds: 8, haltAfterNoImprovement: 2 }),
      propose: sequenceProposer(['d1', 'd2', 'd3', 'd4', 'd5']),
      executeDirection: async (d): Promise<DirectionOutcome> => { seen.push(d); return { direction: d, bestResult: results[d] ?? 0 }; },
    });
    expect(res.decision).toBe('frontier');
    expect(res.outcomes.map((o) => o.direction)).toEqual(['d1', 'd2', 'd3']); // improve, then 2 non-improving → ceiling
    expect(new Set(seen).size).toBe(seen.length); // no direction executed twice
  });

  it('reaches frontier when the proposer runs dry (no new direction)', async () => {
    const res = await runCampaignLoop({
      objective: objective({ beat: 99, maxRounds: 50, haltAfterNoImprovement: 50 }),
      propose: sequenceProposer(['only-one']),
      executeDirection: async (d): Promise<DirectionOutcome> => ({ direction: d, bestResult: 0.5 }),
    });
    expect(res.decision).toBe('frontier');
    expect(res.reason).toMatch(/proposer found no new direction/);
    expect(res.outcomes).toHaveLength(1);
  });
});

describe('outer loop — declared-portfolio coverage floor (anti-confabulation)', () => {
  const withDirs = (stop: Record<string, unknown>, directions: string[]): ResearchConfig =>
    ({ ...objective(stop), directions } as ResearchConfig);

  it('forces every UNTESTED portfolio direction before honoring a proposer frontier', async () => {
    const seen: string[] = [];
    const res = await runCampaignLoop({
      objective: withDirs({ beat: 99, maxRounds: 20, haltAfterNoImprovement: 20 }, ['d1', 'd2', 'd3']),
      propose: async () => null, // proposer confabulates an immediate frontier...
      executeDirection: async (d): Promise<DirectionOutcome> => { seen.push(d); return { direction: d, bestResult: 0 }; },
    });
    expect(seen).toEqual(['d1', 'd2', 'd3']); // ...but the floor forces all three first
    expect(res.outcomes.every((o) => o.forced)).toBe(true);
    expect(res.decision).toBe('frontier'); // frontier only AFTER the portfolio is covered
  });

  it('does NOT honor a policy ceiling while portfolio directions remain untested', async () => {
    const results: Record<string, number> = { d1: 0.5, d2: 0.4, d3: 0.3 };
    const res = await runCampaignLoop({
      objective: withDirs({ beat: 99, maxRounds: 20, haltAfterNoImprovement: 1 }, ['d1', 'd2', 'd3']),
      propose: async () => null,
      executeDirection: async (d): Promise<DirectionOutcome> => ({ direction: d, bestResult: results[d] ?? 0 }),
    });
    // haltAfterNoImprovement=1 would normally ceiling after d2; the floor still covers d3 first.
    expect(res.outcomes.map((o) => o.direction)).toEqual(['d1', 'd2', 'd3']);
    expect(res.decision).toBe('frontier');
  });

  it('still ships a real beat found while covering the portfolio (ship always wins)', async () => {
    const results: Record<string, number> = { d1: 0.5, d2: 2.0, d3: 0.1 };
    const seen: string[] = [];
    const res = await runCampaignLoop({
      objective: withDirs({ beat: 1.5, maxRounds: 20, haltAfterNoImprovement: 20 }, ['d1', 'd2', 'd3']),
      propose: async () => null,
      executeDirection: async (d): Promise<DirectionOutcome> => { seen.push(d); return { direction: d, bestResult: results[d] ?? 0 }; },
    });
    expect(res.decision).toBe('shipped');
    expect(seen).toEqual(['d1', 'd2']); // d2 beats → ship; d3 never forced
  });
});
