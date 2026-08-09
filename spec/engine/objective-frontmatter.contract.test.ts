/**
 * Phase-0 safety net — Objective primitive frontmatter contract.
 *
 * `objective:` is the unified primitive name; `research:` is the back-compat alias. Both parse to
 * the same ResearchConfig (metric-kind). Pins that promoting the name didn't break the legacy block.
 */
import { describe, expect, it } from 'vitest';
import { parseBriefFrontmatter } from '../../src/scheduler.js';

const body = (key: string) => [
  '---', `${key}:`, '  baseline: 14.82', '  policy: best_of_n', '  higher_is_better: true',
  '  stop:', '    beat: 15.0', '    max_rounds: 8', '    halt_after_no_improvement: 3',
  '---', '# task',
].join('\n');

describe('Objective primitive — research/objective frontmatter', () => {
  it('parses the legacy `research:` block', () => {
    const r = parseBriefFrontmatter(body('research')).research;
    expect(r?.baseline).toBe(14.82);
    expect(r?.policy).toBe('best_of_n');
    expect(r?.stop?.beat).toBe(15.0);
    expect(r?.stop?.haltAfterNoImprovement).toBe(3);
  });

  it('parses the `objective:` alias identically', () => {
    const r = parseBriefFrontmatter(body('objective')).research;
    expect(r?.baseline).toBe(14.82);
    expect(r?.policy).toBe('best_of_n');
    expect(r?.stop?.beat).toBe(15.0);
    expect(r?.stop?.haltAfterNoImprovement).toBe(3);
  });

  it('strips the frontmatter from the brief body either way', () => {
    expect(parseBriefFrontmatter(body('objective')).stripped.trim()).toBe('# task');
  });
});
