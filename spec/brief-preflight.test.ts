import './test-support/policy-runtime.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createBriefAdmission,
  inspectBrief,
  verifyBriefAdmission,
} from '../src/brief-preflight.js';
import { parseBriefFrontmatter } from '../src/scheduler.js';

function structuredBrief(body = '# Goal\nShip an observable result.\n', metadata: string[] = []): string {
  return [
    '---',
    ...metadata,
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    body,
    '## Requirements',
    '1. Produce the declared deliverable.',
  ].join('\n');
}

describe('shared brief preflight', () => {
  it('classifies the documented narrow plain-text boundary without pretending it is semantic', () => {
    expect(inspectBrief('Fix the login race').inputKind).toBe('plain_text');
    expect(inspectBrief('修复登录竞态').inputKind).toBe('plain_text');
    expect(inspectBrief('Goal\n====').inputKind).toBe('brief');
    expect(inspectBrief('**Goal**').inputKind).toBe('brief');

    const compact = 'Goal: fix the race; Success criteria: deterministic regression test; Boundary: no schema change.';
    expect(inspectBrief(compact).inputKind).toBe('plain_text');
    expect(inspectBrief('Ordinary prose wrapped across\ntwo physical lines.').inputKind).toBe('brief');
  });

  it('reports absent, valid, and invalid frontmatter while keeping findings overridable', () => {
    const absent = inspectBrief('# Goal\nDo the work.\n## Requirements\n1. Produce the declared deliverable.');
    expect(absent.frontmatter.status).toBe('absent');
    expect(absent.contractReady).toBe(true);
    expect(absent.findings.map((finding) => finding.code)).toContain('terminal_states_missing');

    const valid = inspectBrief(structuredBrief());
    expect(valid.frontmatter.status).toBe('valid');
    expect(valid.contractReady).toBe(true);
    expect(valid.findings.some(finding => finding.code === 'research_policy_invalid')).toBe(false);

    const invalid = inspectBrief('---\nterminal_states: [\n---\n# Goal');
    expect(invalid.frontmatter.status).toBe('invalid');
    expect(invalid.contractReady).toBe(false);
    const admitted = createBriefAdmission(invalid, { kind: 'not_required' });
    expect(verifyBriefAdmission('---\nterminal_states: [\n---\n# Goal', admitted).status).toBe('valid');
  });

  it('fails a declared Reality-check section that parses to no valid checks', () => {
    const malformed = inspectBrief(`${structuredBrief()}\n## Reality checks\nchecks:\n  - name: broken\n    type: file-exists-nonempty\n     params: {}\n`);
    expect(malformed.contractReady).toBe(false);
    expect(malformed.findings).toContainEqual(expect.objectContaining({
      code: 'reality_checks_empty_or_invalid',
      level: 'fail',
      message: expect.stringContaining('YAML parsing failed'),
    }));

    const empty = inspectBrief(`${structuredBrief()}\n## Reality checks\nchecks: []\n`);
    expect(empty.findings).toContainEqual(expect.objectContaining({
      code: 'reality_checks_empty_or_invalid',
      level: 'fail',
    }));

    const absent = inspectBrief(structuredBrief());
    expect(absent.findings.some((finding) => finding.code === 'reality_checks_empty_or_invalid')).toBe(false);
  });

  it('digests exact UTF-8 bytes, including BOM, CRLF, and trailing newlines', () => {
    const variants = [
      structuredBrief(),
      `${structuredBrief()}\n`,
      structuredBrief().replaceAll('\n', '\r\n'),
      `\uFEFF${structuredBrief()}`,
    ];
    const reports = variants.map(inspectBrief);
    expect(new Set(reports.map((report) => report.digest)).size).toBe(variants.length);
    variants.forEach((text, index) => {
      expect(reports[index].digest).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    });
  });

  it('admits advisory findings while binding exact bytes', () => {
    const text = 'Fix the race';
    const report = inspectBrief(text);
    const record = createBriefAdmission(report, { kind: 'not_required' });
    expect(verifyBriefAdmission(text, record).status).toBe('valid');
    expect(verifyBriefAdmission(`${text}\n`, record).status).toBe('digest_mismatch');
    expect(verifyBriefAdmission(text, undefined).status).toBe('missing');
  });

});

describe('decision-grade brief requirements', () => {
  it('fails a frontmatter-declared supplied figure without both anti-anchoring fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
    ].join('\n'), ['supplied_numbers: [-112.89]']));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'operator_figure_anti_anchoring_missing',
      level: 'fail',
      message: expect.stringContaining('within_expected_range'),
      suggestion: expect.stringContaining('both exact anti-anchoring fields'),
    }));
    expect(report.contractReady).toBe(false);
  });

  it('accepts a frontmatter-declared supplied figure with both exact anti-anchoring fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
      'The result must include `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
    ].join('\n'), ['supplied_numbers: [-112.89]']));

    expect(report.findings.some((finding) => finding.code === 'operator_figure_anti_anchoring_missing')).toBe(false);
    expect(report.contractReady).toBe(true);
  });

  it('does not treat forbidden anti-anchoring field names as required fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
      'Do not include `within_expected_range` or `method_was_not_adjusted_to_match_expectation`.',
    ].join('\n'), ['supplied_numbers: [-112.89]']));

    expect(report.findings.map((finding) => finding.code)).toContain('operator_figure_anti_anchoring_missing');
  });

  it.each(['', 'supplied_numbers: []', 'planner_policies: [evidence_statistics]'])(
    'only warns for prose expectations without declared supplied numbers: %s', metadata => {
      const report = inspectBrief(structuredBrief('The operator supplied an expected value of 42.', [metadata]));
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: 'operator_figure_anti_anchoring_missing', level: 'warn',
      }));
      expect(report.contractReady).toBe(true);
    },
  );

  it.each([0, -112.89, 42])('checks a declared number independently of prose: %s', value => {
    const report = inspectBrief(structuredBrief('# Goal\nMeasure independently.', [`supplied_numbers: [${value}]`]));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'operator_figure_anti_anchoring_missing', level: 'fail',
    }));
    expect(report.contractReady).toBe(false);
  });

  it('does not promote illustrative examples, implementation counts, or unanchored numbers into these requirements', () => {
    const report = inspectBrief(structuredBrief([
      '# Implementation',
      'Create 3 files and run 103 checks.',
      'For example, a brief might request a headline statistic of 226.69 bps.',
      'Illustrative examples:',
      '- Pre-register a selection rule before outcomes.',
      '- An operator might provide an expected result of -112.89 bps.',
      'The measured fixture contains -98.68 bps without a supplied expectation.',
    ].join('\n')));

    expect(report.findings.map((finding) => finding.code)).not.toEqual(expect.arrayContaining([
      'headline_distribution_missing',
      'preregistration_feasibility_missing',
      'operator_figure_anti_anchoring_missing',
    ]));
  });
});

describe('brief finding actionability', () => {
  it('attaches a concrete next action to every previously non-actionable finding family', () => {
    const activeResearch = [
      '---',
      'research:',
      '  baseline: 0',
      '  policy: greedy_stack',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '---',
      '# Goal',
      'Explore safely.',
    ].join('\n');
    const unreachableFloor = [
      '---',
      'research:',
      '  baseline: 0',
      '  policy: greedy_stack',
      '  stop:',
      '    max_rounds: 1',
      'terminal_states:',
      '  ceiling_hit:',
      '    paths: [docs/ceiling.md]',
      '    floor:',
      '      min_attempted_stages: 2',
      '---',
      '# Goal',
      'Explore safely.',
    ].join('\n');
    const reports = [
      inspectBrief('---\nterminal_states: [\n---\n# Goal'),
      inspectBrief(`${structuredBrief()}\n## Reality checks\nchecks: []\n`),
      inspectBrief(structuredBrief()),
      inspectBrief(activeResearch),
      inspectBrief('# Goal\nShip safely.'),
      inspectBrief(unreachableFloor),
    ];
    const expectedCodes = [
      'frontmatter_invalid', 'reality_checks_empty_or_invalid',
      'research_policy_invalid', 'terminal_states_missing',
    ];
    for (const code of expectedCodes) {
      const finding = reports.flatMap(({ findings }) => findings).find((candidate) => candidate.code === code);
      expect(finding, code).toBeDefined();
      expect(finding?.suggestion, code).toMatch(/add|declare|fix|remove|lower|raise|use|choose|correct/i);
    }
  });
});

describe('terminal wall-floor structure', () => {
  it('warns above ten wall minutes with actionable risk and stays quiet at ten', () => {
    const above = inspectBrief([
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '    floor:',
      '      min_wall_minutes: 11',
      '---',
      '# Goal',
      'Ship the result.',
    ].join('\n'));
    expect(above.findings).toContainEqual(expect.objectContaining({
      code: 'terminal_wall_floor_too_high_complete',
      level: 'warn',
      consequential: true,
      message: expect.stringContaining('clock gate'),
      risk: expect.stringContaining('efficient run'),
      suggestion: expect.stringContaining('at most 10 minutes'),
    }));

    const boundary = inspectBrief([
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '    floor:',
      '      min_wall_minutes: 10',
      '---',
      '# Goal',
      'Ship the result.',
    ].join('\n'));
    expect(boundary.findings.some((entry) => entry.code.startsWith('terminal_wall_floor_too_high'))).toBe(false);
  });
});
