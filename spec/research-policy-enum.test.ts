import { describe, expect, it } from 'vitest';
import { parseBriefFrontmatter } from '../src/scheduler.js';
import { RESEARCH_POLICY_IDS, ResearchPolicySchema } from '../src/research-policy.js';

function brief(policyLine: string): string {
  return [
    '---',
    'research:',
    '  baseline: 0.0',
    policyLine,
    '  higher_is_better: true',
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

describe('research.policy is a rejected contract, not a coerced hint', () => {
  it('accepts every documented id and reports no error', () => {
    for (const id of RESEARCH_POLICY_IDS) {
      const parsed = parseBriefFrontmatter(brief(`  policy: ${id}`));
      expect(parsed.research?.policy).toBe(id);
      expect(parsed.researchPolicyError).toBeUndefined();
    }
  });

  it('omitting policy takes greedy_stack deliberately, with no error', () => {
    const parsed = parseBriefFrontmatter(
      ['---', 'research:', '  baseline: 0.0', '  higher_is_better: true', '---', '', '# body', ''].join('\n'),
    );
    expect(parsed.research?.policy).toBe('greedy_stack');
    expect(parsed.researchPolicyError).toBeUndefined();
  });

  // The regression this file exists for: a brief once wrote `heuristic_policy_v1`,
  // believing `policy` named the opponent rather than the keep/drop rule. It fell
  // through to greedy_stack in silence, and the campaign's premature ceiling was
  // traced back to it only by reading the parser. Falling back is still correct --
  // nothing in parseBriefFrontmatter throws -- but it must now say so.
  it('names the offending value and the legal set instead of coercing quietly', () => {
    const parsed = parseBriefFrontmatter(brief('  policy: heuristic_policy_v1'));
    expect(parsed.researchPolicyError).toBeDefined();
    expect(parsed.researchPolicyError).toContain('heuristic_policy_v1');
    for (const id of RESEARCH_POLICY_IDS) {
      expect(parsed.researchPolicyError).toContain(id);
    }
    expect(parsed.research?.policy).toBe('greedy_stack');
  });

  it('rejects a non-string policy as well', () => {
    const parsed = parseBriefFrontmatter(brief('  policy: 7'));
    expect(parsed.researchPolicyError).toBeDefined();
    expect(parsed.research?.policy).toBe('greedy_stack');
  });

  it('the schema and the id list cannot drift apart', () => {
    expect([...ResearchPolicySchema.options].sort()).toEqual([...RESEARCH_POLICY_IDS].sort());
  });
});
