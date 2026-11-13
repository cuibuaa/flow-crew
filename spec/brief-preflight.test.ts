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
    "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Produce the declared deliverable.\"}]",
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
  it('leaves single-line and multilingual prose opaque', () => {
    for (const brief of ['Fix the race', '修复竞态', '**Goal**', 'Do not require 42.']) {
      expect(inspectBrief(brief).contractReady).toBe(true);
      expect(inspectBrief(brief).findings.some(f => f.code === 'plain_text_input')).toBe(false);
    }
  });

  it('reports absent, valid, and invalid frontmatter and refuses invalid admission', () => {
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
    expect(() => createBriefAdmission(invalid, { kind: 'not_required' })).toThrow('DECLARATION_INVALID: terminal_states');
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
      'terminal_states_missing',
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
