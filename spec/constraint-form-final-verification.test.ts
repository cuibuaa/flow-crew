import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { evaluateResearchFeasibility } from '../src/research-feasibility.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

function structuredBrief(body: string): string {
  return [
    '---',
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    body,
  ].join('\n');
}

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
  ].join('\n');
}

describe('constraint-form final verification', () => {
  it('keeps sibling-run mutation absolutely prohibited', () => {
    const prompt = readFileSync(resolve(PROJECT_ROOT, 'config', 'agents', '_base.md'), 'utf8');

    expect(prompt).toMatch(
      /never write, move, delete, or otherwise modify any run directory other than this task's own run directory/i,
    );
    expect(prompt).toMatch(/this prohibition is absolute/i);
    expect(prompt).toMatch(/read authorization never grants mutation authority/i);
  });

  it('lets only explicit bounded brief authorization override default read restrictions', () => {
    const prompt = readFileSync(resolve(PROJECT_ROOT, 'config', 'agents', '_base.md'), 'utf8');

    expect(prompt).toMatch(/by default, do not read, browse, or list other `?\.fc\/runs\/?`? directories/i);
    expect(prompt).toMatch(/explicitly authorizes a bounded set of other runs as read-only evidence/i);
    expect(prompt).toMatch(/for that evidence only/i);
    expect(prompt).toMatch(/grants no permission to write, move, delete, or modify those runs/i);
  });

  it('does not infer an ignored input from the exact subject-position prohibition', () => {
    const report = inspectBrief(structuredBrief([
      '# Constraints',
      'Nothing under `tests/` may be added to version control.',
    ].join('\n')), { gitignoredPathPrefixes: ['tests/'] });

    expect(report.findings.some((finding) => finding.code === 'gitignored_input_undeclared')).toBe(false);
  });

  it('does not suppress positive requirements or a different path on a mixed line', () => {
    const positive = inspectBrief(structuredBrief([
      '# Inputs',
      'Nothing prevents this task from reading `tests/` as an input.',
    ].join('\n')), { gitignoredPathPrefixes: ['tests/'] });
    const mixed = inspectBrief(structuredBrief([
      '# Inputs',
      'Read `private-data/source.csv` as an input. **Nothing under `tests/` may be added to version control.**',
    ].join('\n')), { gitignoredPathPrefixes: ['private-data/', 'tests/'] });

    expect(positive.findings).toContainEqual(expect.objectContaining({
      code: 'gitignored_input_undeclared',
      path: 'tests',
    }));
    expect(mixed.findings.filter((finding) => finding.code === 'gitignored_input_undeclared'))
      .toEqual([expect.objectContaining({ path: 'private-data/source.csv' })]);
  });

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
