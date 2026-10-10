import { describe, expect, it } from 'vitest';
import { autoSelectedWorkflow, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { extractDeclaredBriefInputPaths } from '../src/ship-inputs.js';

const select = (brief: string) => autoSelectedWorkflow(parseBriefFrontmatter(brief), extractDeclaredBriefInputPaths(brief)).workflow;
const body = '\n# TASK\n\n## Outcome\n\nDo the one thing.\n';

describe('automatic choice of the workflow', () => {
  it('runs a brief with one deliverable and nothing to arrange on the fixed plan', () => {
    expect(select(`---\noutputs:\n  - docs/report.md\n---\n${body}`)).toBe('direct');
    expect(select(`# TASK\n\nNo frontmatter at all.\n`)).toBe('direct');
  });
  it('runs a research block on the research loop', () => {
    expect(select(`---\nresearch:\n  baseline: 0.5\n  policy: greedy_stack\n  higher_is_better: true\n  result_file: r/result.json\n  stop:\n    max_rounds: 2\n---\n${body}`)).toBe('research');
  });
  it('keeps the planner for declared inputs, programs, terminal states, several outputs or a broken frontmatter', () => {
    expect(select(`---\ninputs:\n  - docs/notes.md\noutputs:\n  - docs/report.md\n---\n${body}`)).toBe('default');
    expect(select(`---\noutputs:\n  - docs/a.md\n  - docs/b.md\n---\n${body}`)).toBe('default');
    expect(select(`---\noutputs: [docs/report.md\n---\n${body}`)).toBe('default');
  });
});
