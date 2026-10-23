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
    expect(valid.findings).toContainEqual(expect.objectContaining({
      code: 'research_absent',
      consequential: false,
    }));

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

  it.each(['', 'supplied_numbers: []', 'research: {baseline: 42}', 'planner_policies: [evidence_statistics]'])(
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
      'frontmatter_invalid',
      'reality_checks_empty_or_invalid',
      'research_absent',
      'research_confirm_missing',
      'research_ship_target_missing',
      'research_stop_rule_missing',
      'terminal_states_missing',
      'terminal_floor_unreachable',
    ];
    for (const code of expectedCodes) {
      const finding = reports.flatMap(({ findings }) => findings).find((candidate) => candidate.code === code);
      expect(finding, code).toBeDefined();
      expect(finding?.suggestion, code).toMatch(/add|declare|fix|remove|lower|raise|use|choose|correct/i);
    }
  });
});

describe('feasibility-only brief declarations', () => {
  const preregistration = [
    '# Measurement',
    'Pre-register and freeze the selection rule before measuring any outcomes.',
  ].join('\n');

  const feasibilityOnlyBrief = (feasibilityYaml: string): string => [
    '---',
    'research:',
    ...feasibilityYaml.split('\n').map((line) => `  ${line}`),
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    preregistration,
    '## Requirements',
    '1. Produce the declared deliverable.',
  ].join('\n');

  it('evaluates the real diagnostic shape without creating a metric loop', () => {
    const reason = [
      'The per-formation distribution of how many distinct firms cover the same name has never',
      'been measured, and dispersion requires at least two firms per name per formation.',
    ].join(' ');
    const brief = feasibilityOnlyBrief([
      'feasibility:',
      '  hard_floor: 20',
      '  warn_below: 50',
      '  rules:',
      '    - label: broker_leave_one_out',
      '      model: formation_count_distribution',
      '      counts: [234, 235, 240, 250, 275, 399, 533]',
      '    - label: cross_broker_dispersion',
      '      model: not_computable',
      '      reason: >-',
      '        The per-formation distribution of how many distinct firms cover the same name has never',
      '        been measured, and dispersion requires at least two firms per name per formation.',
    ].join('\n'));

    const parsed = parseBriefFrontmatter(brief);
    expect(parsed.research).toBeUndefined();
    expect(parsed.researchFeasibility).toEqual({
      hardFloor: 20,
      warnBelow: 50,
      rules: [
        {
          label: 'broker_leave_one_out',
          model: 'formation_count_distribution',
          counts: [234, 235, 240, 250, 275, 399, 533],
        },
        { label: 'cross_broker_dispersion', model: 'not_computable', reason },
      ],
    });

    const report = inspectBrief(brief);
    expect(report.contractReady).toBe(true);
    expect(report.findings.map((finding) => finding.code)).not.toContain('preregistration_feasibility_missing');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_absent',
      message: expect.stringContaining('research loop was not simulated'),
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_ok',
      level: 'ok',
      message: expect.stringContaining('n=7, mean=309.42857142857144, median=250, spread=299'),
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_not_computable',
      level: 'warn',
      message: expect.stringContaining(reason),
    }));
    expect(report.researchFeasibility?.[0]).toMatchObject({
      decision: 'ok',
      qualifyingMemberCount: 234,
      distribution: {
        sampleSize: 7,
        mean: 309.42857142857144,
        median: 250,
        minimum: 234,
        maximum: 533,
        spread: 299,
        selectedValue: 234,
        location: { lowerRank: 1, upperRank: 1, of: 7, percentile: 7.142857142857143 },
      },
    });
    expect(report.researchFeasibility?.[1]).toMatchObject({
      decision: 'not_computable',
      reason,
    });
    expect(report.researchFeasibility?.[1]).not.toHaveProperty('qualifyingMemberCount');

    const objectiveAlias = parseBriefFrontmatter(brief.replace('\nresearch:\n', '\nobjective:\n'));
    expect(objectiveAlias.research).toBeUndefined();
    expect(objectiveAlias.researchFeasibility).toEqual(parsed.researchFeasibility);
  });

  it('pins both thresholds, the adjacent failing boundary, and honest incomputability', () => {
    const reason = 'The joint structural distribution is unavailable.';
    const report = inspectBrief(feasibilityOnlyBrief([
      'feasibility:',
      '  hard_floor: 10',
      '  warn_below: 20',
      '  rules:',
      '    - label: just below hard floor',
      '      model: formation_count_distribution',
      '      counts: [9, 9]',
      '    - label: at hard floor',
      '      model: formation_count_distribution',
      '      counts: [10, 10]',
      '    - label: just below warning boundary',
      '      model: formation_count_distribution',
      '      counts: [19, 19]',
      '    - label: at warning boundary',
      '      model: formation_count_distribution',
      '      counts: [20, 20]',
      '    - label: unavailable structure',
      '      model: not_computable',
      `      reason: ${reason}`,
    ].join('\n')));

    expect(report.researchFeasibility?.map(({ label, decision }) => [label, decision])).toEqual([
      ['just below hard floor', 'fail'],
      ['at hard floor', 'warn'],
      ['just below warning boundary', 'warn'],
      ['at warning boundary', 'ok'],
      ['unavailable structure', 'not_computable'],
    ]);
    for (const evaluation of report.researchFeasibility?.slice(0, 4) ?? []) {
      expect(evaluation.distribution).toMatchObject({
        mean: evaluation.qualifyingMemberCount,
        median: evaluation.qualifyingMemberCount,
        spread: 0,
        selectedValue: evaluation.qualifyingMemberCount,
        location: { lowerRank: 1, upperRank: 2, of: 2, percentile: 50 },
      });
      const finding = report.findings.find((candidate) => candidate.message.includes(`“${evaluation.label}”`));
      expect(finding?.message).toContain(`mean=${evaluation.qualifyingMemberCount}`);
      expect(finding?.message).toContain(`median=${evaluation.qualifyingMemberCount}`);
      expect(finding?.message).toContain('spread=0');
      expect(finding?.message).toContain('rank=1-2/2, midrank percentile=50');
    }
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'research_feasibility_not_computable',
      level: 'warn',
      message: expect.stringContaining(reason),
    }));
  });

  it('preserves the complete baseline-carrying ResearchConfig and loop marker', () => {
    const brief = [
      '---',
      'research:',
      '  baseline: 12.5',
      '  policy: greedy_stack',
      '  higher_is_better: false',
      '  result_file: docs/round.json',
      '  report_dir: docs/reports',
      '  feasibility:',
      '    hard_floor: 10',
      '    warn_below: 20',
      '    rules:',
      '      - label: baseline fixture',
      '        model: formation_count_distribution',
      '        counts: [20, 25]',
      '  integrity:',
      '    max_std_ratio: 0.25',
      '    outlier_factor: 4',
      '    field_floors: {sample_size: 30}',
      '    reject_if_positive: [leakage]',
      '  result_schema:',
      '    type: object',
      '    properties:',
      '      result: {type: number}',
      '    required: [result]',
      '  context_roots: [src, data]',
      '  confirm:',
      '    command: npm run verify-result',
      '    requires: independent rerun',
      '    timeout_seconds: 45',
      '  stop:',
      '    beat: 10',
      '    max_rounds: 8',
      '    max_wall_hours: 2',
      '    halt_after_no_improvement: 3',
      '    min_improvement: 0.1',
      '    improvement_se_multiple: 2',
      '---',
      preregistration,
    ].join('\n');
    const feasibility = {
      hardFloor: 10,
      warnBelow: 20,
      rules: [{
        label: 'baseline fixture',
        model: 'formation_count_distribution' as const,
        counts: [20, 25],
      }],
    };
    const expectedResearch = {
      baseline: 12.5,
      policy: 'greedy_stack',
      higherIsBetter: false,
      resultFile: 'docs/round.json',
      reportDir: 'docs/reports',
      feasibility,
      integrity: {
        maxStdRatio: 0.25,
        outlierFactor: 4,
        fieldFloors: { sample_size: 30 },
        rejectIfPositive: ['leakage'],
      },
      resultSchema: {
        type: 'object',
        properties: { result: { type: 'number' } },
        required: ['result'],
      },
      contextRoots: ['src', 'data'],
      confirm: {
        command: 'npm run verify-result',
        requires: 'independent rerun',
        timeoutSeconds: 45,
      },
      stop: {
        beat: 10,
        maxRounds: 8,
        maxWallHours: 2,
        haltAfterNoImprovement: 3,
        minImprovement: 0.1,
        improvementSEMultiple: 2,
      },
    };

    const parsed = parseBriefFrontmatter(brief);
    expect(parsed.research).toEqual(expectedResearch);
    expect(parsed.researchFeasibility).toEqual(feasibility);
    expect(inspectBrief(brief).findings.map((finding) => finding.code)).toContain('research_valid');
    expect(parseBriefFrontmatter(brief.replace('\nresearch:\n', '\nobjective:\n')).research)
      .toEqual(expectedResearch);
  });

  it('retains the same strict invalid diagnostic with and without a baseline', () => {
    const invalidBrief = (withBaseline: boolean): string => [
      '---',
      'research:',
      ...(withBaseline ? ['  baseline: 1'] : []),
      '  feasibility:',
      '    hard_floor: 0',
      '    rules:',
      '      - label: invalid floor',
      '        model: formation_count_distribution',
      '        counts: [20]',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '---',
      preregistration,
    ].join('\n');

    const withoutBaseline = parseBriefFrontmatter(invalidBrief(false));
    const withBaseline = parseBriefFrontmatter(invalidBrief(true));
    expect(withoutBaseline.research).toBeUndefined();
    expect(withoutBaseline.researchFeasibilityError)
      .toBe('research.feasibility.hard_floor must be a positive finite number');
    expect(withBaseline.research?.feasibilityError).toBe(withoutBaseline.researchFeasibilityError);

    const messages = [false, true].map((withBaseline) => {
      const report = inspectBrief(invalidBrief(withBaseline));
      expect(report.contractReady).toBe(false);
      expect(report.findings.map((finding) => finding.code)).not.toContain('preregistration_feasibility_missing');
      const finding = report.findings.find((candidate) => candidate.code === 'research_feasibility_invalid');
      expect(finding).toMatchObject({
        level: 'fail',
        message: expect.stringContaining('hard_floor must be a positive finite number'),
      });
      return finding?.message;
    });
    expect(messages[0]).toBe(messages[1]);
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
