import { describe, expect, it } from 'vitest';
import { autoSelectedWorkflow, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { inspectBrief } from '../src/brief-preflight.js';

const select = (brief: string) => autoSelectedWorkflow(parseBriefFrontmatter(brief)).workflow;
const body = '\n# TASK\n\n## Outcome\n\nDo the one thing.\n';

describe('automatic choice of the workflow', () => {
  it('honours the author choice independently of declared inputs and output count', () => {
    const declarations = 'inputs: [docs/notes.md]\noutputs: [docs/a.md, docs/b.md]';
    expect(select(`---\nworkflow: direct\n${declarations}\n---\n${body}`)).toBe('direct');
    expect(select(`---\nworkflow: planner\n---\n${body}`)).toBe('default');
    expect(autoSelectedWorkflow(parseBriefFrontmatter('---\nworkflow: direct\n---\n'))).toMatchObject({
      reason: expect.stringContaining('workflow: direct'),
    });
  });
  it('runs a research block on the research loop', () => {
    expect(select(`---\nresearch:\n  baseline: 0.5\n  policy: greedy_stack\n  higher_is_better: true\n  result_file: r/result.json\n  stop:\n    max_rounds: 2\n---\n${body}`)).toBe('research');
  });
  it('uses the fixed plan by default independently of input and output count', () => {
    expect(select(`# TASK\n\nNo frontmatter at all.\n`)).toBe('direct');
    expect(select(`---\noutputs: [docs/report.md]\n---\n${body}`)).toBe('direct');
    expect(select(`---\ninputs:\n  - docs/notes.md\noutputs:\n  - docs/report.md\n---\n${body}`)).toBe('direct');
    expect(select(`---\noutputs:\n  - docs/a.md\n  - docs/b.md\n---\n${body}`)).toBe('direct');
    // Invalid frontmatter still reaches the existing refusal, not a fixed-plan admission.
    expect(select(`---\noutputs: [docs/report.md\n---\n${body}`)).toBe('default');
    expect(inspectBrief(`---\noutputs: [docs/report.md]\n---\n${body}`).findings).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('Workflow without --workflow: direct'),
    }));
  });

  it('keeps program planning and explicit CLI choices ahead of the default', () => {
    const program = parseBriefFrontmatter(`---\nprogram:\n  name: study\n  phase: first\n---\n${body}`);
    expect(autoSelectedWorkflow(program).workflow).toBe('default');
    expect(autoSelectedWorkflow(program, 'direct').error).toContain('direct cannot run the program loop');
    expect(autoSelectedWorkflow(parseBriefFrontmatter(body), 'default').workflow).toBe('default');
    expect(autoSelectedWorkflow(parseBriefFrontmatter('---\nworkflow: direct\n---\n'), 'custom').workflow).toBe('custom');
    const research = parseBriefFrontmatter('---\nresearch:\n  baseline: 0.5\n---\n');
    expect(autoSelectedWorkflow(research, 'default').workflow).toBe('default');
    expect(autoSelectedWorkflow(research, 'direct').error).toContain('direct cannot run the research loop');
  });

  it('refuses direct loops with the structural reason and rejects unknown choices', () => {
    for (const loop of ['research:\n  baseline: 0.5', 'program:\n  name: study\n  phase: first']) {
      const task = `---\nworkflow: direct\n${loop}\n---\n${body}`;
      expect(inspectBrief(task).findings).toContainEqual(expect.objectContaining({
        level: 'fail', message: expect.stringMatching(/direct.*(?:research|program).*loop/),
      }));
      expect(select(task.replace('workflow: direct', 'workflow: planner'))).toBe(loop.startsWith('research') ? 'research' : 'default');
    }
    for (const value of ['typo', 'null', '[direct]', 'default']) {
      expect(autoSelectedWorkflow(parseBriefFrontmatter(`---\nworkflow: ${value}\n---\n${body}`)).error).toContain('workflow');
    }
  });
});
