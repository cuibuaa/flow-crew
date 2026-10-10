import { describe, expect, it } from 'vitest';
import { extractBriefCriteria } from '../src/brief-criteria.js';
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
});
