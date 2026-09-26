import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { assessResearchShipTarget, evaluateResearch } from '../src/research-policy.js';
import type { ResearchConfig } from '../src/store.js';

function config(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    baseline: 0.1457,
    policy: 'greedy_stack',
    higherIsBetter: true,
    stop: { beat: 0.2, maxRounds: 2 },
    ...overrides,
  };
}

function researchBrief(input: {
  baseline: number;
  beat?: number;
  higherIsBetter?: boolean;
  resultMinimum?: number;
  resultMaximum?: number;
  outlierFactor?: number;
}): string {
  const resultBounds = [
    input.resultMinimum === undefined ? undefined : `        minimum: ${input.resultMinimum}`,
    input.resultMaximum === undefined ? undefined : `        maximum: ${input.resultMaximum}`,
  ].filter((line): line is string => line !== undefined);
  return [
    '---',
    'research:',
    `  baseline: ${input.baseline}`,
    '  policy: greedy_stack',
    `  higher_is_better: ${input.higherIsBetter !== false}`,
    ...(input.outlierFactor === undefined ? [] : [
      '  integrity:',
      `    outlier_factor: ${input.outlierFactor}`,
    ]),
    ...(resultBounds.length === 0 ? [] : [
      '  result_schema:',
      '    type: object',
      '    required: [label, result]',
      '    properties:',
      '      label: {type: string}',
      '      result:',
      '        type: number',
      ...resultBounds,
    ]),
    '  stop:',
    ...(input.beat === undefined ? [] : [`    beat: ${input.beat}`]),
    '    max_rounds: 2',
    '---',
    '# Goal',
    'Measure one candidate.',
    '',
    '## What the report must show',
    '',
    '1. Record the measured result and the engine decision.',
  ].join('\n');
}

function decisionBrief(requirement: string): string {
  return [
    '# Requirements',
    'The operator supplied an expected result of 0.20.',
    requirement,
  ].join('\n');
}

function relationCodes(brief: string): string[] {
  return inspectBrief(brief).findings
    .map((finding) => finding.code)
    .filter((code) => code.startsWith('research_ship_target_'));
}

describe('item 6 — every locally provable ship-target relation is compared', () => {
  it('refuses the recorded already-crossed target while retaining the policy comparison it exposed', () => {
    const brief = researchBrief({ baseline: 0.1457, beat: 0.10 });
    expect(relationCodes(brief)).toContain('research_ship_target_already_crossed');
    expect(inspectBrief(brief).contractReady).toBe(false);

    expect(evaluateResearch(config({ stop: { beat: 0.10, maxRounds: 2 } }), [
      { label: 'r1', result: 0.15 },
    ])).toMatchObject({ decision: 'ship', runningBest: 0.15, keptLabels: ['r1'] });
  });

  it('preserves a materially different feasible target and the ordinary ship judgment', () => {
    const brief = researchBrief({ baseline: 0.1457, beat: 0.20 });
    expect(relationCodes(brief)).toEqual([]);
    expect(assessResearchShipTarget(config())).toMatchObject({ status: 'reachable' });
    expect(evaluateResearch(config(), [{ label: 'independent-r2', result: 0.21 }]))
      .toMatchObject({ decision: 'ship', runningBest: 0.21, keptLabels: ['independent-r2'] });
  });

  it('does not turn an external historical best into an invented empirical ceiling', () => {
    const assessment = assessResearchShipTarget(config());
    const observedButUnauthorizedHistoricalBest = 0.018;
    expect(observedButUnauthorizedHistoricalBest).toBeLessThan(assessment.bindings.baseline);
    expect(assessment.status).toBe('reachable');
    expect(assessment.reason).not.toContain(String(observedButUnauthorizedHistoricalBest));
  });

  it('refuses targets excluded by either schema or integrity bounds', () => {
    expect(relationCodes(researchBrief({
      baseline: 0.1,
      beat: 0.5,
      resultMinimum: -0.3,
      resultMaximum: 0.3,
    }))).toContain('research_ship_target_unreachable');
    expect(relationCodes(researchBrief({
      baseline: 0.1,
      beat: 0.6,
      outlierFactor: 5,
    }))).toContain('research_ship_target_unreachable');
  });

  it('enumerates every assessment disposition in both metric directions', () => {
    const population = [
      config({ stop: undefined }),
      config({ stop: { beat: 0.10 } }),
      config({ baseline: 0.2, higherIsBetter: false, stop: { beat: 0.3 } }),
      config(),
      config({ resultSchema: { properties: { result: { type: 'number', maximum: 0.18 } } } }),
      config({
        baseline: 0.2,
        higherIsBetter: false,
        stop: { beat: 0.1 },
        resultSchema: { properties: { result: { type: 'number', minimum: 0.15 } } },
      }),
    ];
    expect(population.map((entry) => assessResearchShipTarget(entry).status)).toEqual([
      'ceiling_only',
      'already_crossed',
      'already_crossed',
      'reachable',
      'unreachable',
      'unreachable',
    ]);
  });

  it('keeps the existing ceiling-only warning instead of inventing a target failure', () => {
    expect(relationCodes(researchBrief({ baseline: 0.1457 }))).toEqual(['research_ship_target_missing']);
  });
});

describe('item 15 — anti-anchoring field polarity is mention-local', () => {
  const finding = (requirement: string): boolean => inspectBrief(decisionBrief(requirement)).findings
    .some((entry) => entry.code === 'operator_figure_anti_anchoring_missing');

  it('accepts both required fields when a sibling clause prohibits method adjustment', () => {
    expect(finding(
      'The result must include `within_expected_range` and `method_was_not_adjusted_to_match_expectation`, and the method must not be adjusted to match the expectation.',
    )).toBe(false);
  });

  it('retains the pure-prohibition guard and a genuinely missing-field refusal', () => {
    expect(finding(
      'Do not include `within_expected_range` or `method_was_not_adjusted_to_match_expectation`.',
    )).toBe(true);
    expect(finding('The result must include only `within_expected_range`.')).toBe(true);
  });

  it('preserves plain positive requirements and recognizes a negated omission as positive', () => {
    expect(finding(
      'The result must include `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
    )).toBe(false);
    expect(finding(
      'The result must not omit `within_expected_range` or `method_was_not_adjusted_to_match_expectation`.',
    )).toBe(false);
  });

  it('does not let one positive token hide a locally prohibited sibling', () => {
    expect(finding(
      'Include `within_expected_range`, but do not include `method_was_not_adjusted_to_match_expectation`.',
    )).toBe(true);
  });
});
