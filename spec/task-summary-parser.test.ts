import { describe, expect, it } from 'vitest';
import { parseTaskSummary } from '../src/task-summary-parser.js';

const VALID_SUMMARY = `# Task Summary

**Verdict**: PASS

## What was achieved
The daemon now records operator-readable task summaries at completion.

## Key numbers
- 1 parser added
- 3 CLI paths covered

## Files produced
- src/task-summary-parser.ts
- spec/task-summary-parser.test.ts

## What operator should do next
Review the displayed summary before closing the task.
`;

describe('parseTaskSummary', () => {
  it('parses a well-formed summary', () => {
    const parsed = parseTaskSummary(VALID_SUMMARY);

    expect(parsed).toMatchObject({
      valid: true,
      verdict: 'PASS',
      oneLiner: 'The daemon now records operator-readable task summaries at completion.',
      full: VALID_SUMMARY,
      errors: [],
    });
  });

  it.each([
    ['verdict', VALID_SUMMARY.replace('**Verdict**: PASS\n\n', ''), 'missing verdict line'],
    ['What was achieved', VALID_SUMMARY.replace('## What was achieved\nThe daemon now records operator-readable task summaries at completion.\n\n', ''), 'missing section: What was achieved'],
    ['Key numbers', VALID_SUMMARY.replace('## Key numbers\n- 1 parser added\n- 3 CLI paths covered\n\n', ''), 'missing section: Key numbers'],
    ['Files produced', VALID_SUMMARY.replace('## Files produced\n- src/task-summary-parser.ts\n- spec/task-summary-parser.test.ts\n\n', ''), 'missing section: Files produced'],
    ['What operator should do next', VALID_SUMMARY.replace('## What operator should do next\nReview the displayed summary before closing the task.\n', ''), 'missing section: What operator should do next'],
  ])('reports a specific error when %s is missing', (_section, markdown, error) => {
    expect(parseTaskSummary(markdown).errors).toContain(error);
  });

  it.each(['SUCCESS', 'Failed', 'pass'])('rejects invalid verdict value %s', (verdict) => {
    const parsed = parseTaskSummary(VALID_SUMMARY.replace('**Verdict**: PASS', `**Verdict**: ${verdict}`));

    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`invalid verdict: ${verdict}`);
  });

  it('truncates one-liner to 200 characters', () => {
    const longLine = 'A'.repeat(250);
    const parsed = parseTaskSummary(VALID_SUMMARY.replace('The daemon now records operator-readable task summaries at completion.', longLine));

    expect(parsed.valid).toBe(true);
    expect(parsed.oneLiner).toHaveLength(200);
    expect(parsed.oneLiner).toBe('A'.repeat(200));
  });

  it.each([
    ['What was achieved', '## What was achieved\n\n'],
    ['Key numbers', '## Key numbers\n\n'],
    ['Files produced', '## Files produced\n\n'],
    ['What operator should do next', '## What operator should do next\n   \n'],
  ])('rejects empty %s section', (section, replacement) => {
    const markdown = VALID_SUMMARY.replace(sectionBlock(section), replacement);
    const parsed = parseTaskSummary(markdown);

    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`empty section: ${section}`);
  });

  it('requires bullets in bullet sections', () => {
    const parsed = parseTaskSummary(VALID_SUMMARY
      .replace('- 1 parser added\n- 3 CLI paths covered', '1 parser added')
      .replace('- src/task-summary-parser.ts\n- spec/task-summary-parser.test.ts', 'src/task-summary-parser.ts'));

    expect(parsed.errors).toContain('section requires at least 1 bullet: Key numbers');
    expect(parsed.errors).toContain('section requires at least 1 bullet: Files produced');
  });

  it('captures only the first paragraph from multiline achievement text', () => {
    const parsed = parseTaskSummary(VALID_SUMMARY.replace(
      'The daemon now records operator-readable task summaries at completion.',
      'First paragraph is the operator summary.\n\nSecond paragraph is retained only in the full document.',
    ));

    expect(parsed.valid).toBe(true);
    expect(parsed.oneLiner).toBe('First paragraph is the operator summary.');
    expect(parsed.full).toContain('Second paragraph is retained only in the full document.');
  });
});

function sectionBlock(section: string): string {
  const start = VALID_SUMMARY.indexOf(`## ${section}`);
  const rest = VALID_SUMMARY.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
