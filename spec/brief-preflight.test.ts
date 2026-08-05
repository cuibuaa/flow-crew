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
    expect(finding?.message).toContain('Nothing in the engine writes them');
    expect(finding?.message).toContain('min_wall_minutes');
    expect(finding?.message).toContain('stage_glob');
  });

  it('only warns when the author configured stage_glob explicitly', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  ceiling_hit:\n    paths: [docs/v8/ceiling_report.md]\n    stage_glob: docs/v8/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 3\n',
      '# Goal\nExplore.\n',
    ));
    // A `stage_glob:` line matches its own pattern, so searching the whole brief would
    // leave this branch dead. The check reads the instructions only.
    expect(report.findings.find((entry) => entry.code === 'terminal_floor_uncountable_ceiling_hit')?.level).toBe('warn');
  });

  it('stays silent when the instructions ask for the counted files', () => {
    const report = inspectBrief(withFloor(
      'terminal_states:\n  complete:\n    paths: [docs/run/summary.md]\n    floor:\n      min_attempted_stages: 2\n',
      '# Goal\nEach stage writes `docs/run/stage_1_verdict.md` when it settles.\n',
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
