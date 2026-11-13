/** Legacy metric blocks and the retired alias refuse with a schema-owned migration pointer. */
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
    expect(parsed.declarationRefusal).toMatchObject({
      code: 'declaration_invalid', keyPath: 'research.baseline',
      replacement: { key: 'research', protocol: 'research-instrument/v1' },
    });
  });

  it('refuses the retired objective alias identically', () => {
    const parsed = parseBriefFrontmatter(body('objective'));
    expect(parsed.research).toBeUndefined();
    expect(parsed.declarationRefusal).toMatchObject({
      code: 'declaration_invalid', keyPath: 'objective',
      replacement: { key: 'research', protocol: 'research-instrument/v1' },
    });
  });

  it.each(['unknown', 'constructor', 'toString', '__proto__'])('refuses unrelated %s without inventing a migration pointer', key => {
    const parsed = parseBriefFrontmatter(`---\n${key}: true\n---\n# task`);
    expect(parsed.research).toBeUndefined();
    expect(parsed.declarationRefusal).toMatchObject({ code: 'declaration_invalid', keyPath: key });
    expect(parsed.declarationRefusal?.replacement).toBeUndefined();
  });

  it('strips the frontmatter from the brief body either way', () => {
    expect(parseBriefFrontmatter(body('objective')).stripped.trim()).toBe('# task');
  });
});
