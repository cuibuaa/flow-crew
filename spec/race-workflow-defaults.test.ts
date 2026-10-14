import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { parseDispatchedStageConfig, WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-defaults-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(failingStage: 'work' | 'review', stageOverride?: number) {
  const project = join(directory, 'project'); mkdirSync(project);
  setEngineDefaults({ stage_technical_retries: 0, gate_retry_loops: 0 });
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  isolatedProjectCommand('git', ['init', '-q'], project, directory);
  isolatedProjectCommand('git', ['add', '.'], project, directory);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input'], project, directory);
  const brief = '# Deliver an answer\n\n## Acceptance criteria\n1. answer.txt contains the new answer.\n';
  const criterion = extractBriefCriteria(brief).criteria[0].id;
  const author = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt'], race: true, criterion_refs: [criterion] });
  const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [], criterion_refs: [criterion] });
  const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['answer.txt'] });
  // Retry overrides belong to fixed operator workflows; live dispatched
  // stages deliberately omit them.
  author.max_retries = stageOverride; gate.max_retries = stageOverride;
  const workflow = WorkflowConfigSchema.parse({ name: 'race_defaults', defaults: { max_iterations: 1, max_retries: 1 }, stages: [
    author, gate, repair,
  ] });
  // Each fresh child starts with the same transient failure. Retrying the
  // parent race cannot replace the missing retry policy inside a child.
  const attempts = new Map<string, number>();
  const adapter: Adapter = { async run(_prompt, role, opts) {
    if (opts.stageId === '_summary') return { output: 'Summary.', exitCode: 0, duration_ms: 0 };
    const key = `${opts.runDir}:${opts.stageId}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    if (opts.workDir !== project) attempts.set(key, attempt);
    if (opts.workDir !== project && opts.stageId === failingStage && attempt === 1)
      return { output: 'Temporary fixture failure; retry this same stage.', exitCode: 1, duration_ms: 0 };
    if (opts.stageId === 'work') {
      writeFileSync(join(opts.workDir, 'answer.txt'), 'new answer\n');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Delivered answer.', checks: [], caveats: [] }), exitCode: 0, duration_ms: 0,
        writes: ['answer.txt'], writeAttribution: 'structured' };
    }
    const pass = readFileSync(join(opts.workDir, 'answer.txt'), 'utf8') === 'new answer\n';
    return { output: JSON.stringify({ pass, reason: 'Inspected answer.', criteria: { [criterion]: { status: pass ? 'pass' : 'fail', evidence: 'answer.txt contains the new answer.' } },
      audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 0 };
  } };
  const state = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined,
    join(import.meta.dirname, '../config/agents'), undefined, brief, false, undefined, false);
  return { state, project, attempts: [...attempts] };
}

describe('race workflow retry defaults', () => {
  it.each(['work', 'review'] as const)('keeps the parent workflow retry policy for a transient candidate %s failure', async failingStage => {
    const { state, project, attempts } = await fixture(failingStage);
    expect(state.status, state.failureReason).toBe('complete');
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
    const childAttempts = attempts.filter(([key]) => key.endsWith(`:${failingStage}`));
    expect(childAttempts).toHaveLength(1);
    expect(childAttempts.every(([, count]) => count === 2)).toBe(true);
  });
  it('preserves an explicit stage retry override over the workflow default', async () => {
    const { state, attempts } = await fixture('work', 0);
    expect(state.status).toBe('incomplete');
    expect(attempts).toHaveLength(2);
    expect(attempts.every(([, count]) => count === 1)).toBe(true);
  });
});
