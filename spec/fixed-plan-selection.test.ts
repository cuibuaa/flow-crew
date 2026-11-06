import './test-support/policy-runtime.js';
import { describe, expect, it } from 'vitest';
import { entryWorkflow, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { inspectBrief } from '../src/brief-preflight.js';
import { parseCommandArgs } from '../src/cli-args.js';
const body = '# Task\n\n## Acceptance criteria\n1. Deliver the coherent change.\n';

describe('one entry, with model-owned shape selection', () => {
  it.each(['', 'inputs: [docs/notes.md]\noutputs: [docs/a.md, docs/b.md]', 'research:\n  baseline: 0.5\n  policy: greedy_stack\n  stop:\n    max_rounds: 2'])('admits the same entry independently of declarations: %s', declaration => {
    expect(entryWorkflow(parseBriefFrontmatter(declaration ? `---\n${declaration}\n---\n${body}` : body)).workflow).toBe('entry');
  });
  it.each(['direct', 'planner', 'default', 'typo', 'null', '[direct]'])('refuses the removed field for %s instead of routing', value => {
    expect(entryWorkflow(parseBriefFrontmatter(`---\nworkflow: ${value}\n---\n${body}`)).error).toContain('field no longer exists');
  });
  it('refuses the CLI override as unknown', () => {
    expect(() => parseCommandArgs('quick', ['--workflow', 'planner'])).toThrow(/unknown/i);
  });
  it('retains malformed YAML refusal and shows the entry contract in preflight', () => {
    expect(entryWorkflow(parseBriefFrontmatter(`---\noutputs: [docs/report.md\n---\n${body}`)).error).toBeTruthy();
    expect(inspectBrief(body).findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('Entry workflow: entry') }));
  });
});
