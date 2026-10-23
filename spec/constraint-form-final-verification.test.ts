import './test-support/policy-runtime.js';
import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { evaluateResearchFeasibility } from '../src/research-feasibility.js';

function researchBrief(feasibility: string): string {
  return [
    '---',
    'research:',
    '  baseline: 0',
    '  policy: greedy_stack',
    '  feasibility:',
    ...feasibility.split('\n').map((line) => `    ${line}`),
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    '# Measurement',
    'Pre-register and freeze the selection rule before measuring any outcomes.',
    '## Acceptance criteria',
    '1. Report the qualifying sample count or explain why it cannot be computed.',
  ].join('\n');
}

describe('constraint-form final verification', () => {
  it('fails the historical repeated conjunction using independently derived arithmetic', () => {
    const independentlyDerived = Math.exp(Math.log(500) + 103 * Math.log(0.456));
    const [evaluation] = evaluateResearchFeasibility({
      hardFloor: 10,
      rules: [{
        label: 'all-formation control',
        model: 'independent_repeated_conjunction',
        population: 500,
        perPeriodRate: 0.456,
        periods: 103,
      }],
    });

    expect(independentlyDerived).toBeCloseTo(3.73550049911375e-33, 12);
    expect(evaluation.qualifyingMemberCount).toBeCloseTo(independentlyDerived, 12);
    expect(evaluation.decision).toBe('fail');
    expect(evaluation.distribution).toMatchObject({
      sampleSize: 103,
      mean: 0.456,
      median: 0.456,
      spread: 0,
      location: { lowerRank: 1, upperRank: 103, of: 103, percentile: 50 },
    });
  });

  it('fails the historical formation-count distribution at its structural minimum', () => {
    const [evaluation] = evaluateResearchFeasibility({
      hardFloor: 10,
      rules: [{
        label: 'fixed coverage cohort',
        model: 'formation_count_distribution',
        counts: Array.from({ length: 84 }, () => 0),
      }],
    });

    expect(evaluation).toMatchObject({
      decision: 'fail',
      qualifyingMemberCount: 0,
      distribution: {
        sampleSize: 84,
        mean: 0,
        median: 0,
        spread: 0,
        selectedValue: 0,
        location: { lowerRank: 1, upperRank: 84, of: 84, percentile: 50 },
      },
    });
  });

  it('warns without refusing a feasible rule inside its declared warning band', () => {
    const report = inspectBrief(researchBrief([
      'hard_floor: 10',
      'warn_below: 20',
      'rules:',
      '  - label: tight generic rule',
      '    model: independent_repeated_conjunction',
      '    population: 100',
      '    per_period_rate: 0.5',
      '    periods: 3',
    ].join('\n')));

    expect(report.contractReady).toBe(true);
    expect(report.researchFeasibility?.[0]).toMatchObject({
      decision: 'warn',
      qualifyingMemberCount: 12.500000000000007,
    });
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_tight',
      level: 'warn',
    }));
  });

  it('reports genuine incomputability without synthesizing a count', () => {
    const report = inspectBrief(researchBrief([
      'hard_floor: 10',
      'rules:',
      '  - label: unavailable joint distribution',
      '    model: not_computable',
      '    reason: The outcome-independent joint coverage distribution has not been measured.',
    ].join('\n')));

    expect(report.contractReady).toBe(true);
    expect(report.researchFeasibility?.[0]).toMatchObject({ decision: 'not_computable' });
    expect(report.researchFeasibility?.[0]).not.toHaveProperty('qualifyingMemberCount');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_not_computable',
      level: 'warn',
    }));
  });
});
