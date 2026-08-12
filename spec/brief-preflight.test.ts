import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canDeriveBriefAdmission,
  createBriefAdmission,
  inspectBrief,
  verifyBriefAdmission,
  type BriefAdmissionAcknowledgement,
  type BriefAdmissionRecord,
} from '../src/brief-preflight.js';

const AT = '2026-08-03T00:00:00.000Z';

function structuredBrief(body = '# Goal\nShip an observable result.\n'): string {
  return [
    '---',
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    body,
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
    const absent = inspectBrief('# Goal\nDo the work.');
    expect(absent.frontmatter.status).toBe('absent');
    expect(absent.contractReady).toBe(true);
    expect(absent.findings.map((finding) => finding.code)).toContain('terminal_states_missing');

    const valid = inspectBrief(structuredBrief());
    expect(valid.frontmatter.status).toBe('valid');
    expect(valid.contractReady).toBe(true);
    expect(valid.requiresAcknowledgement).toBe(false);
    expect(valid.findings).toContainEqual(expect.objectContaining({
      code: 'research_absent',
      acknowledgementRequired: false,
    }));

    const invalid = inspectBrief('---\nterminal_states: [\n---\n# Goal');
    expect(invalid.frontmatter.status).toBe('invalid');
    expect(invalid.contractReady).toBe(false);
    expect(invalid.requiresAcknowledgement).toBe(true);
    expect(() => createBriefAdmission(invalid, { kind: 'not_required' })).toThrow(/explicit acknowledgement/);
    const admitted = createBriefAdmission(invalid, {
      kind: 'explicit', source: 'cli_digest_flag', at: AT,
    });
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

  it('keeps Chinese criterion support while all generated guidance remains English', () => {
    const criterion = '源码里必须出现 `new JSDOM(...)`。';
    const report = inspectBrief(`${structuredBrief()}\n${criterion}\n`);
    const finding = report.findings.find((item) => item.code === 'criterion_instrument_wording');
    expect(finding).toMatchObject({
      level: 'warn',
      acknowledgementRequired: true,
      excerpt: criterion,
    });
    expect(finding?.risk).toMatch(/^This wording makes/);
    expect(finding?.suggestion).toMatch(/^State the observable property/);
    expect(`${finding?.message}\n${finding?.risk}\n${finding?.suggestion}`.replace(criterion, ''))
      .not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('constructs and verifies every acknowledgement class and rejects malformed provenance', () => {
    const cleanText = structuredBrief();
    const clean = inspectBrief(cleanText);
    const notRequired = createBriefAdmission(clean, { kind: 'not_required' });
    expect(verifyBriefAdmission(cleanText, notRequired).status).toBe('valid');

    const consequentialText = 'Fix the race';
    const consequential = inspectBrief(consequentialText);
    const acknowledgements: BriefAdmissionAcknowledgement[] = [
      { kind: 'explicit', source: 'cli_current_input_flag', at: AT },
      { kind: 'explicit', source: 'cli_digest_flag', at: AT },
      { kind: 'explicit', source: 'dashboard_receipt', at: AT },
      {
        kind: 'derived',
        source: 'campaign_loop',
        at: AT,
        parentDigest: clean.digest,
        transformation: 'outer_loop_directive_v1',
      },
    ];
    for (const acknowledgement of acknowledgements) {
      const record = createBriefAdmission(consequential, acknowledgement);
      expect(verifyBriefAdmission(consequentialText, record).status).toBe('valid');
    }

    const valid = createBriefAdmission(consequential, acknowledgements[0]);
    expect(verifyBriefAdmission(`${consequentialText}\n`, valid).status).toBe('digest_mismatch');
    expect(verifyBriefAdmission(consequentialText, undefined).status).toBe('missing');
    const missingAcknowledgement = { ...valid, acknowledgement: undefined } as unknown as BriefAdmissionRecord;
    expect(verifyBriefAdmission(consequentialText, missingAcknowledgement).status).toBe('acknowledgement_missing');
  });

  it('derives only an exact child whose contract does not degrade or gain a finding', () => {
    const parentText = structuredBrief('# Goal\nExplore one direction.\n');
    const parentReport = inspectBrief(parentText);
    const parent = createBriefAdmission(parentReport, { kind: 'not_required' });
    const fixedChild = inspectBrief(`${parentText}\n\n## OUTER-LOOP DIRECTIVE\nFocus on one direction.\n`);
    expect(canDeriveBriefAdmission(parent, parentReport, fixedChild)).toBe(true);

    const newFinding = inspectBrief(`${parentText}\nThe implementation must import \`probe.ts\`.\n`);
    expect(newFinding.findings.map((finding) => finding.code)).toContain('criterion_instrument_wording');
    expect(canDeriveBriefAdmission(parent, parentReport, newFinding)).toBe(false);
  });
});

describe('decision-grade brief requirements', () => {
  it('fails a requested headline statistic that omits its distribution', () => {
    const report = inspectBrief(structuredBrief([
      '# Result',
      'Report the headline statistic as the quoted result in basis points.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'headline_distribution_missing',
      level: 'fail',
      message: expect.stringContaining('mean, median'),
      suggestion: expect.stringContaining('percentile'),
    }));
    expect(report.contractReady).toBe(false);
  });

  it('accepts a headline statistic that requires center and distribution location', () => {
    const report = inspectBrief(structuredBrief([
      '# Result',
      'Report the headline statistic as the quoted result in basis points.',
      'Also report the mean, median, and percentile where that value sits in its own distribution.',
    ].join('\n')));

    expect(report.findings.some((finding) => finding.code === 'headline_distribution_missing')).toBe(false);
    expect(report.contractReady).toBe(true);
  });

  it('does not treat a prohibition as the required headline distribution', () => {
    const report = inspectBrief(structuredBrief([
      '# Result',
      'Report the headline statistic as the quoted result in basis points.',
      'Do not report its mean, median, percentile, quantile, rank, or distribution location.',
    ].join('\n')));

    expect(report.findings.map((finding) => finding.code)).toContain('headline_distribution_missing');
  });

  it('fails a frozen pre-registration that omits structural feasibility', () => {
    const report = inspectBrief(structuredBrief([
      '# Measurement',
      'Pre-register and freeze the selection rule before measuring any outcomes.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'preregistration_feasibility_missing',
      level: 'fail',
      message: expect.stringContaining('expected qualifying-member count'),
      suggestion: expect.stringContaining('numeric minimum'),
    }));
    expect(report.contractReady).toBe(false);
  });

  it('does not mistake a prose promise of future arithmetic for a feasibility calculation', () => {
    const report = inspectBrief(structuredBrief([
      '# Measurement',
      'Pre-register and freeze the selection rule before measuring any outcomes.',
      'Compute the expected qualifying-member count from structural quantities: universe size times eligibility rates.',
      'Set the feasibility floor: 10. Below that floor, revise the rule before any outcome is seen.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'preregistration_feasibility_missing',
      level: 'fail',
      message: expect.stringContaining('machine-readable research.feasibility'),
    }));
    expect(report.contractReady).toBe(false);
  });

  it('does not treat prohibited feasibility work as a pre-registration feasibility figure', () => {
    const report = inspectBrief(structuredBrief([
      '# Measurement',
      'Pre-register and freeze the selection rule before measuring any outcomes.',
      'Do not compute the expected qualifying-member count from structural quantities.',
      'The feasibility floor is 10, but never revise the rule below it before any outcome is seen.',
    ].join('\n')));

    expect(report.findings.map((finding) => finding.code)).toContain('preregistration_feasibility_missing');
  });

  it('fails an operator-supplied figure without both anti-anchoring fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'operator_figure_anti_anchoring_missing',
      level: 'fail',
      message: expect.stringContaining('within_expected_range'),
      suggestion: expect.stringContaining('both exact anti-anchoring fields'),
    }));
    expect(report.contractReady).toBe(false);
  });

  it('accepts an operator-supplied figure with both exact anti-anchoring fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
      'The result must include `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
    ].join('\n')));

    expect(report.findings.some((finding) => finding.code === 'operator_figure_anti_anchoring_missing')).toBe(false);
    expect(report.contractReady).toBe(true);
  });

  it('does not treat forbidden anti-anchoring field names as required fields', () => {
    const report = inspectBrief(structuredBrief([
      '# Context',
      'The operator supplied an expected result of -112.89 bps.',
      'Do not include `within_expected_range` or `method_was_not_adjusted_to_match_expectation`.',
    ].join('\n')));

    expect(report.findings.map((finding) => finding.code)).toContain('operator_figure_anti_anchoring_missing');
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

describe('gitignored input declaration convention', () => {
  const ignoredReferenceBrief = (declare: boolean): string => [
    '---',
    ...(declare ? ['inputs:', '  - private-data/prices.parquet'] : []),
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    '# Constraints',
    '| path | property |',
    '| --- | --- |',
    '| `private-data/prices.parquet` | frozen evidence |',
  ].join('\n');

  it('warns when a neutral table reference under an injected ignored directory is not declared', () => {
    const report = inspectBrief(ignoredReferenceBrief(false), {
      gitignoredPathPrefixes: ['private-data/'],
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'gitignored_input_undeclared',
      level: 'warn',
      message: expect.stringContaining('leading frontmatter `inputs:`'),
      excerpt: '| `private-data/prices.parquet` | frozen evidence |',
    }));
  });

  it('accepts the same ignored reference when leading frontmatter declares it', () => {
    const report = inspectBrief(ignoredReferenceBrief(true), {
      gitignoredPathPrefixes: ['private-data/'],
    });

    expect(report.findings.some((finding) => finding.code === 'gitignored_input_undeclared')).toBe(false);
  });

  it('does not report the exact subject-position prohibition as an undeclared input', () => {
    const brief = [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '---',
      '# Constraints',
      'Nothing under `tests/` may be added to version control.',
    ].join('\n');

    const report = inspectBrief(brief, { gitignoredPathPrefixes: ['tests/'] });

    expect(brief.endsWith('Nothing under `tests/` may be added to version control.')).toBe(true);
    expect(report.findings.some((finding) => finding.code === 'gitignored_input_undeclared')).toBe(false);

    const variant = inspectBrief(structuredBrief(
      '# Constraints\n**Nothing within `tests/` shall be published at any time**.',
    ), { gitignoredPathPrefixes: ['tests/'] });
    expect(variant.findings.some((finding) => finding.code === 'gitignored_input_undeclared')).toBe(false);
  });

  it('retains auxiliary prohibitions while keeping positive nothing-lines visible', () => {
    const prohibited = [
      'Do not read `tests/` as an input.',
      'Never commit anything under `tests/`.',
    ];
    for (const line of prohibited) {
      const report = inspectBrief(structuredBrief(`# Constraints\n${line}`), {
        gitignoredPathPrefixes: ['tests/'],
      });
      expect(report.findings.some((finding) => finding.code === 'gitignored_input_undeclared')).toBe(false);
    }

    const genuineRequirements = [
      'Nothing prevents this task from reading `tests/` as an input.',
      'Nothing under `tests/` is optional; use the directory as an input.',
      'Nothing under `tests/` may prevent this task from reading the directory as an input.',
      'Nothing under `tests/` may be added to version control — audit that directory as an input.',
      'Read everything under `tests/` as a required input.',
    ];
    for (const line of genuineRequirements) {
      const report = inspectBrief(structuredBrief(`# Inputs\n${line}`), {
        gitignoredPathPrefixes: ['tests/'],
      });
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: 'gitignored_input_undeclared',
        excerpt: line,
      }));
    }
  });

  it('suppresses only the governed path token when a line names another real input', () => {
    const line = 'Read `private-data/source.csv` as an input. **Nothing under `tests/` may be added to version control.**';
    const report = inspectBrief(structuredBrief(`# Inputs\n${line}`), {
      gitignoredPathPrefixes: ['private-data/', 'tests/'],
    });
    const findings = report.findings.filter((finding) => finding.code === 'gitignored_input_undeclared');

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('private-data/source.csv');
    expect(findings[0].message).not.toContain('`tests`');
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
      acknowledgementRequired: true,
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

describe('per-stage writable-path structure', () => {
  it('warns for named stages with only a generic permission to write files', () => {
    const report = inspectBrief(structuredBrief([
      '# Stage 1 — implementation',
      'Implement the change. Stages may write files when needed.',
      '# Stage 2 — QA gate',
      'Verify the result.',
    ].join('\n')));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'stage_writable_paths_missing',
      level: 'warn',
      message: expect.stringContaining('per-stage writable-path mapping'),
    }));
  });

  it('accepts an explicit Writable paths, by stage mapping', () => {
    const report = inspectBrief(structuredBrief([
      '# Stage 1 — implementation',
      'Implement the change.',
      '# Stage 2 — QA gate',
      'Verify the result.',
      '## Writable paths, by stage',
      '- Stage 1: `src/**`, `spec/**`',
      '- Stage 2: read-only',
    ].join('\n')));

    expect(report.findings.some((entry) => entry.code === 'stage_writable_paths_missing')).toBe(false);
  });
});

describe('unsatisfiable stage-count floor', () => {
  const withFloor = (frontmatter: string, body: string): string =>
    `---\n${frontmatter}---\n${body}`;

  it('fails an inferred stage_glob floor no stage is asked to satisfy', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/task_summary.md]\n    floor:\n      min_attempted_stages: 3\n',
      '# Goal\nProduce a summary.\n',
    ));
    const finding = report.findings.find((entry) => entry.code === 'terminal_floor_uncountable_complete');
    expect(finding?.level).toBe('fail');
    // The message has to say what is counted, why it will not appear, and both ways out.
    expect(finding?.message).toContain('docs/stage_*_verdict.md');
    expect(finding?.message).toContain('stage_glob');
    expect(finding?.risk).toContain('implicit counting pattern');
    expect(finding?.suggestion).toContain('Set stage_glob explicitly');
  });

  it('only warns when the author configured stage_glob explicitly', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  ceiling_hit:\n    paths: [docs/v8/ceiling_report.md]\n    stage_glob: docs/v8/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 3\n',
      '# Goal\nExplore.\n',
    ));
    // A `stage_glob:` line matches its own pattern, so searching the whole brief would
    // leave this branch dead. The check reads the instructions only.
    expect(report.findings.find((entry) => entry.code === 'terminal_floor_uncountable_ceiling_hit')).toMatchObject({
      level: 'warn',
      risk: expect.stringContaining('count remains zero'),
      suggestion: expect.stringContaining('matching evidence files'),
    });
  });

  it('does not mistake a passive write check for an assigned stage writer', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/result.md]\n    stage_glob: docs/stages/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 1\n',
      '# QA\nCheck whether `docs/stages/stage_1_verdict.md` was written; no stage owns that file.\n',
    ));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'terminal_floor_uncountable_complete',
      level: 'warn',
    }));
  });

  it('does not mistake an existing output noun for a writer assignment', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/result.md]\n    stage_glob: docs/stages/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 1\n',
      '# QA\nInspect the existing output `docs/stages/stage_1_verdict.md` for correctness.\n',
    ));

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'terminal_floor_uncountable_complete',
      level: 'warn',
    }));
  });

  it('still rejects an inferred glob when the instructions happen to mention matching files', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/run/summary.md]\n    floor:\n      min_attempted_stages: 2\n',
      '# Goal\nEach stage writes `docs/run/stage_1_verdict.md` when it settles.\n',
    ));
    expect(report.findings.find((entry) => entry.code === 'terminal_floor_uncountable_complete')).toMatchObject({
      level: 'fail',
      message: expect.stringContaining('brief mentions a matching write'),
    });
  });

  it('stays silent only when stage_glob is explicit and a stage must write matching files', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/run/summary.md]\n    stage_glob: docs/run/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 2\n',
      '# Stage 1\nOutputs:\n\n- `docs/run/stage_1_verdict.md`\n',
    ));
    expect(report.findings.some((entry) => entry.code.startsWith('terminal_floor_uncountable'))).toBe(false);
  });

  it('recognizes an inline stage output assignment as a writer contract', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/run/summary.md]\n    stage_glob: docs/run/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 1\n',
      '# Workflow\n- Stage 1 output: `docs/run/stage_1_verdict.md`\n',
    ));

    expect(report.findings.some((entry) => entry.code.startsWith('terminal_floor_uncountable'))).toBe(false);
  });

  it('stays silent for a wall-time-only floor, which is a hard gate on its own', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/task_summary.md]\n    floor:\n      min_wall_minutes: 30\n',
      '# Goal\nProduce a summary.\n',
    ));
    expect(report.findings.some((entry) => entry.code.startsWith('terminal_floor_uncountable'))).toBe(false);
  });
});
