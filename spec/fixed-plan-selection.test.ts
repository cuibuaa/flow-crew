import { describe, expect, it } from 'vitest';
import { isFixedPlanBrief, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { extractDeclaredBriefInputPaths } from '../src/ship-inputs.js';

const select = (brief: string) => isFixedPlanBrief(parseBriefFrontmatter(brief), extractDeclaredBriefInputPaths(brief));
const body = '\n# TASK\n\n## Outcome\n\nDo the one thing.\n';

describe('automatic choice of the fixed plan', () => {
  it('runs a brief with one deliverable and nothing to arrange on the fixed plan', () => {
    expect(select(`---\noutputs:\n  - docs/report.md\n---\n${body}`)).toBe(true);
    expect(select(`# TASK\n\nNo frontmatter at all.\n`)).toBe(true);
  });
  it('keeps the planner for declared inputs, research, programs, terminal states, several outputs or a broken frontmatter', () => {
    expect(select(`---\ninputs:\n  - docs/notes.md\noutputs:\n  - docs/report.md\n---\n${body}`)).toBe(false);
    expect(select(`---\nresearch:\n  baseline: 0.5\n  policy: greedy_stack\n  higher_is_better: true\n  result_file: r/result.json\n  stop:\n    max_rounds: 2\n---\n${body}`)).toBe(false);
    expect(select(`---\noutputs:\n  - docs/a.md\n  - docs/b.md\n---\n${body}`)).toBe(false);
    expect(select(`---\noutputs: [docs/report.md\n---\n${body}`)).toBe(false);
  });
});
