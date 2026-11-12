/**
 * Phase-0 safety net — Objective primitive frontmatter contract.
 *
 * `objective:` is the unified primitive name; `research:` is the back-compat alias. Both parse to
 * the same ResearchConfig (metric-kind). Pins that promoting the name didn't break the legacy block.
 */
import { describe, expect, it } from 'vitest';
import { parseBriefFrontmatter } from '../../src/scheduler.js';

const body = (key: string) => [
  '---', `${key}:`, '  baseline: 14.82', '  policy: greedy_stack', '  higher_is_better: true',
  '  stop:', '    beat: 15.0', '    max_rounds: 8', '    halt_after_no_improvement: 3',
  '---', '# task',
].join('\n');

describe('Objective primitive — research/objective frontmatter', () => {
  it('refuses the legacy research block', () => {
    const parsed = parseBriefFrontmatter(body('research'));
    expect(parsed.research).toBeUndefined();
    expect(parsed.workflowError).toContain('research-instrument/v1');
  });

  it('refuses the retired objective alias identically', () => {
    const parsed = parseBriefFrontmatter(body('objective'));
    expect(parsed.research).toBeUndefined();
    expect(parsed.workflowError).toContain('research-instrument/v1');
  });

  it('strips the frontmatter from the brief body either way', () => {
    expect(parseBriefFrontmatter(body('objective')).stripped.trim()).toBe('# task');
  });
});
