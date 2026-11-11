import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
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
