import { describe, expect, it } from 'vitest';
import { extractBriefCriteria, scopeBriefCriteria } from '../src/brief-criteria.js';
import { extractDeclaredBriefInputPaths } from '../src/ship-inputs.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';

describe('brief consumers share the leading metadata boundary', () => {
  it.each(['\n', '\r\n'])('keeps BOM metadata out of criteria and preserves original criterion lines (%j)', (newline) => {
    const brief = ['\uFEFF---', 'inputs: [input.txt]', '---', '## Acceptance Criteria', '1. Preserve exact evidence.'].join(newline);
    expect(extractDeclaredBriefInputPaths(brief)).toEqual(['input.txt']);
    expect(parseBriefFrontmatter(brief).stripped).toBe(['## Acceptance Criteria', '1. Preserve exact evidence.'].join(newline));
    expect(extractBriefCriteria(brief).criteria).toMatchObject([{ line: 5, text: 'Preserve exact evidence.' }]);
  });

  it('accepts an empty block and refuses a closing delimiter with trailing text', () => {
    expect(parseBriefFrontmatter('---\n---\nBody').stripped).toBe('Body');
    expect(parseBriefFrontmatter('---\ninputs: [input.txt]\n---suffix\nBody').frontmatterError).toContain('never closed');
  });

  it.each(['\n', '\r\n'])('scopes numbered and named multiline criteria while preserving context and IDs (%j)', newline => {
    const lines = ['---', 'inputs: [input.txt]', '---', '# Goal', 'Keep source evidence unchanged.', '',
      '## Acceptance criteria', '1. Write the later report.', '   Include its measurements.',
      '   - Compare report measurements.', '   ```text', '   report example', '   ```', '',
      '4) Deliver the implementation.', '   Preserve negative values.', '',
      '## Verification requirements', '- **Independent check**: Execute the oracle.', '  Record its evidence.', '',
      '- **Report check**: Review the report.', '', '## Constraints', 'Do not publish.'];
    const brief = lines.join(newline);
    const original = extractBriefCriteria(brief).criteria;
    const scoped = scopeBriefCriteria(brief, [original[1].id, original[2].id]);
    expect(scoped).toBe(['---', 'inputs: [input.txt]', '---', '# Goal', 'Keep source evidence unchanged.', '',
      '## Acceptance criteria', '', '4) Deliver the implementation.', '   Preserve negative values.', '',
      '## Verification requirements', '- **Independent check**: Execute the oracle.', '  Record its evidence.', '',
      '', '## Constraints', 'Do not publish.'].join(newline));
    expect(extractBriefCriteria(scoped).criteria.map(({ id, text, section }) => ({ id, text, section })))
      .toEqual(original.slice(1, 3).map(({ id, text, section }) => ({ id, text, section })));
    expect(scopeBriefCriteria(brief, original.map(criterion => criterion.id))).toBe(brief);
    expect(extractBriefCriteria(scopeBriefCriteria(brief, [])).criteria).toEqual([]);
  });
});
