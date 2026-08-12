import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import {
  evaluateResearchFeasibility,
  parseResearchFeasibility,
  type ResearchFeasibilityConfig,
} from '../src/research-feasibility.js';
import { parseBriefFrontmatter } from '../src/scheduler.js';

const PREREGISTRATION = [
  '# Measurement',
  'Pre-register and freeze the selection rule before measuring any outcomes.',
].join('\n');

function researchBrief(feasibilityYaml: string, body = PREREGISTRATION): string {
  return [
    '---',
    'research:',
    '  baseline: 0',
    '  policy: greedy_stack',
    ...feasibilityYaml.split('\n').map((line) => `  ${line}`),
    '  stop:',
    '    max_rounds: 1',
    'terminal_states:',
    '  ceiling_hit:',
    '    paths: [docs/ceiling.md]',
    '---',
    body,
  ].join('\n');
}

function validConfig(overrides: Partial<ResearchFeasibilityConfig> = {}): ResearchFeasibilityConfig {
  return {
    hardFloor: 10,
    rules: [{
      label: 'generic conjunction',
      model: 'independent_repeated_conjunction',
      population: 100,
      perPeriodRate: 0.5,
      periods: 3,
    }],
    ...overrides,
  };
}

describe('research feasibility parser', () => {
  it('is parsed by the canonical leading-frontmatter parser', () => {
    const brief = researchBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  warn_below: 20',
      '  rules:',
      '    - label: all-period eligibility',
      '      model: independent_repeated_conjunction',
      '      population: 100',
      '      per_period_rate: 0.5',
      '      periods: 3',
    ].join('\n'));

    expect(parseBriefFrontmatter(brief).research?.feasibility).toEqual(validConfig({
      warnBelow: 20,
      rules: [{
        label: 'all-period eligibility',
        model: 'independent_repeated_conjunction',
        population: 100,
        perPeriodRate: 0.5,
        periods: 3,
      }],
    }));
  });

  it('rejects malformed, ambiguous, non-finite, and out-of-range models', () => {
    const invalidValues: unknown[] = [
      null,
      { hard_floor: 0, rules: [] },
      { hard_floor: 10, warn_below: 9, rules: [{ label: 'x', model: 'not_computable', reason: 'missing distribution' }] },
      { hard_floor: 10, rules: [] },
      { hard_floor: 10, rules: [{ label: 'x', model: 'independent_repeated_conjunction', population: 100, per_period_rate: 1.1, periods: 2 }] },
      { hard_floor: 10, rules: [{ label: 'x', model: 'independent_repeated_conjunction', population: 100.5, per_period_rate: 0.5, periods: 2 }] },
      { hard_floor: 10, rules: [{ label: 'x', model: 'formation_count_distribution', counts: [12, -1] }] },
      { hard_floor: 10, rules: [{ label: 'x', model: 'not_computable', reason: '' }] },
      { hard_floor: 10, rules: [{ label: 'x', model: 'not_computable', reason: 'missing joint distribution', counts: [10] }] },
      { hard_floor: 10, rules: [
        { label: 'same', model: 'not_computable', reason: 'missing first distribution' },
        { label: 'same', model: 'not_computable', reason: 'missing second distribution' },
      ] },
    ];

    for (const value of invalidValues) expect(parseResearchFeasibility(value).status).toBe('invalid');
  });

  it('fails preflight instead of silently dropping an invalid declaration', () => {
    const report = inspectBrief(researchBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  rules:',
      '    - label: ambiguous rule',
      '      model: not_computable',
      '      reason: The joint distribution is unavailable.',
      '      counts: [20, 20]',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_invalid',
      level: 'fail',
      message: expect.stringContaining('unsupported field'),
    }));
    expect(report.contractReady).toBe(false);
  });
});

describe('research feasibility evaluation', () => {
  it('re-derives the all-period control as catastrophically empty in log space', () => {
    const [evaluation] = evaluateResearchFeasibility({
      hardFloor: 10,
      rules: [{
        label: 'control matched at every formation',
        model: 'independent_repeated_conjunction',
        population: 500,
        perPeriodRate: 0.456,
        periods: 103,
      }],
    });

    expect(evaluation.decision).toBe('fail');
    expect(evaluation.qualifyingMemberCount).toBeCloseTo(3.735500499113763e-33, 12);
    expect(evaluation.log10QualifyingMemberCount).toBeCloseTo(-32.42765120122718, 12);
    expect(evaluation.distribution).toMatchObject({
      sampleSize: 103,
      mean: 0.456,
      median: 0.456,
      spread: 0,
      selectedValue: 0.456,
      location: { lowerRank: 1, upperRank: 103, of: 103, percentile: 50 },
    });
  });

  it('re-derives the fixed historical-coverage cohort as tied at zero', () => {
    const [evaluation] = evaluateResearchFeasibility({
      hardFloor: 10,
      rules: [{
        label: 'stable coverage at every formation',
        model: 'formation_count_distribution',
        counts: Array.from({ length: 84 }, () => 0),
      }],
    });

    expect(evaluation).toMatchObject({
      decision: 'fail',
      qualifyingMemberCount: 0,
      logQualifyingMemberCount: null,
      log10QualifyingMemberCount: null,
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

  it('distinguishes a tight feasible rule and both threshold boundaries', () => {
    const evaluations = evaluateResearchFeasibility({
      hardFloor: 10,
      warnBelow: 20,
      rules: [
        { label: 'at hard floor', model: 'formation_count_distribution', counts: [10, 18, 30] },
        { label: 'repeated at hard floor', model: 'independent_repeated_conjunction', population: 20, perPeriodRate: 0.5, periods: 1 },
        { label: 'tight interior', model: 'independent_repeated_conjunction', population: 100, perPeriodRate: 0.5, periods: 3 },
        { label: 'at warning boundary', model: 'formation_count_distribution', counts: [20, 25, 40] },
      ],
    });

    expect(evaluations.map((entry) => [entry.label, entry.decision])).toEqual([
      ['at hard floor', 'warn'],
      ['repeated at hard floor', 'warn'],
      ['tight interior', 'warn'],
      ['at warning boundary', 'ok'],
    ]);
    expect(evaluations[0].qualifyingMemberCount).toBe(10);
    expect(evaluations[1].qualifyingMemberCount).toBeCloseTo(10, 12);
    expect(evaluations[2].qualifyingMemberCount).toBeCloseTo(12.5, 12);
    expect(evaluations[3].qualifyingMemberCount).toBe(20);
  });

  it('keeps an underflowed expectation comparable rather than treating it as missing arithmetic', () => {
    const [evaluation] = evaluateResearchFeasibility({
      hardFloor: 1,
      rules: [{
        label: 'underflow case',
        model: 'independent_repeated_conjunction',
        population: 1_000,
        perPeriodRate: 0.01,
        periods: 1_000,
      }],
    });

    expect(evaluation.qualifyingMemberCount).toBe(0);
    expect(evaluation.log10QualifyingMemberCount).toBeCloseTo(-1997, 10);
    expect(evaluation.displayQualifyingMemberCount).toContain('underflowed to 0');
    expect(evaluation.decision).toBe('fail');
  });

  it('evaluates generic multiple-rule declarations rather than recognizing fixtures', () => {
    const evaluations = evaluateResearchFeasibility({
      hardFloor: 8,
      rules: [
        { label: 'generic repeated', model: 'independent_repeated_conjunction', population: 240, perPeriodRate: 0.8, periods: 5 },
        { label: 'generic formation counts', model: 'formation_count_distribution', counts: [17, 14, 21, 12] },
      ],
    });

    expect(evaluations.map((entry) => entry.decision)).toEqual(['ok', 'ok']);
    expect(evaluations[1].distribution).toMatchObject({ mean: 16, median: 15.5, spread: 9 });
  });
});

describe('research feasibility preflight decisions', () => {
  it('fails both historical structural models before a run starts', () => {
    const report = inspectBrief(researchBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  rules:',
      '    - label: control matched at every formation',
      '      model: independent_repeated_conjunction',
      '      population: 500',
      '      per_period_rate: 0.456',
      '      periods: 103',
      '    - label: stable coverage at every formation',
      '      model: formation_count_distribution',
      `      counts: [${Array.from({ length: 84 }, () => 0).join(', ')}]`,
    ].join('\n')));

    const failures = report.findings.filter((finding) => finding.code === 'research_feasibility_below_floor');
    expect(failures).toHaveLength(2);
    expect(failures[0].message).toContain('3.735500e-33');
    expect(failures[0].message).toContain('spread=0');
    expect(failures[1].message).toContain('n=84, mean=0, median=0, spread=0');
    expect(report.contractReady).toBe(false);
  });

  it('warns rather than refuses a feasible but tight rule', () => {
    const report = inspectBrief(researchBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  warn_below: 20',
      '  rules:',
      '    - label: tight control',
      '      model: independent_repeated_conjunction',
      '      population: 100',
      '      per_period_rate: 0.5',
      '      periods: 3',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_tight',
      level: 'warn',
      message: expect.stringContaining('12.5'),
    }));
    expect(report.contractReady).toBe(true);
  });

  it('states honest incomputability without inventing a number', () => {
    const report = inspectBrief(researchBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  rules:',
      '    - label: distribution-dependent cohort',
      '      model: not_computable',
      '      reason: The joint per-formation coverage distribution has not been measured.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_not_computable',
      level: 'warn',
      message: expect.stringContaining('No qualifying-member count was synthesized'),
    }));
    expect(report.researchFeasibility?.[0]).not.toHaveProperty('qualifyingMemberCount');
    expect(report.contractReady).toBe(true);
  });
});
