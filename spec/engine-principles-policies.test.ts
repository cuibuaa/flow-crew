import './test-support/policy-runtime.js';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { parsePlannerPolicySelection, renderPlannerPolicies } from '../src/planner-policies.js';
import { inspectDispatchAdmission, runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { log } from '../src/scheduler/sched_admission/shared.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-planner-policies-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
function brief(policies: unknown): string { return `---\nplanner_policies: ${JSON.stringify(policies)}\n---\n# Goal\nApply the selected planning constraints.\n`; }

async function runPolicyWorkflow(task: string) {
  const workflow = WorkflowConfigSchema.parse({ name: 'policy-fixture', defaults: { max_iterations: 1, max_retries: 0 },
    stages: ['planner', 'coder'].map((role, index) => ({ id: role, role, scope: [], depends_on: index ? ['planner'] : [],
      prompt_template: '{task_description}', artifact_contract: emptyArtifactContract() })) });
  const roles = new Map(['planner', 'coder'].map(name => [name, { name, description: name, model: 'default',
    reasoning_effort: 'default', tools: [], prompt: 'Execute the fixture.' }]));
  const received: Record<string, { user: string; system: string }> = {};
  const calls: string[] = [];
  const final = await runWorkflow(workflow, 'name: policy-fixture', project, {
    async run(user, role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId !== '_summary') received[opts.stageId] = { user, system: role.prompt };
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    },
  }, roles, undefined, undefined, undefined, task, true);
  return { final, received, calls };
}

describe('brief policy selection is explicit and does not replace core admission', () => {
  it('selects no policies when a brief omits the key', () => {
    expect(parseBriefFrontmatter('# Goal\nWork.').plannerPolicies ?? []).toEqual([]);
    expect(renderPlannerPolicies([])).toBe('');
  });

  it.each([null, 'evidence_statistics', ['unknown']])('refuses malformed selection %j precisely', (value) => {
    expect(parseBriefFrontmatter(brief(value)).frontmatterError).toContain('PLANNER_POLICY_INVALID');
    expect(() => parsePlannerPolicySelection(value)).toThrow('planner_policies');
  });

  it('refuses malformed policy selection through the scheduler before any adapter invocation', async () => {
    const { final, received, calls } = await runPolicyWorkflow(brief(['unknown']));
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('PLANNER_POLICY_INVALID');
    expect(received).toEqual({});
    expect(calls).toEqual([]);
  });

  it('retains original selected policies after the scheduler strips frontmatter from stage task text', async () => {
    const task = brief(['evidence_statistics']);
    const { final, received } = await runPolicyWorkflow(task);
    expect(final.status, final.failureReason).toBe('complete');
    expect(readFileSync(join(runDir(project, final.runId), 'task_brief.md'), 'utf8')).toBe(task);
    expect(received.planner.system).toContain('# Brief planning policies');
    expect(received.planner.system).toContain('method_was_not_adjusted_to_match_expectation');
    expect(received.coder.system).not.toContain('# Brief planning policies');
    for (const { user } of Object.values(received)) {
      expect(user).toContain(parseBriefFrontmatter(task).stripped.trim());
      expect(user).not.toContain('planner_policies:');
    }
  });

  it('warns and completes an ordinary workflow when unrelated brief YAML is malformed', async () => {
    const warning = vi.spyOn(log, 'warn');
    const { final, received } = await runPolicyWorkflow('---\nordinary_metadata: [unterminated\n---\n# Goal\nApply the task.\n');
    expect(final.status, final.failureReason).toBe('complete');
    expect(Object.keys(received)).toEqual(['planner', 'coder']);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ frontmatterError: expect.any(String) }),
      expect.stringContaining('brief frontmatter failed to parse'));
  });

  it('always refuses core malformed topology, scope and missing declarations under both policy selections', () => {
    for (const policies of [[], ['evidence_statistics']]) {
      expect(parseBriefFrontmatter(brief(policies)).plannerPolicies).toEqual(policies);
      const stage = StageConfigSchema.parse({ id: 'work', role: 'coder', scope: [], depends_on: ['absent'], dependency_reasons: { absent: 'Needs absent output.' }, prompt_template: 'Work.' });
      const admission = inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan', requireArtifactContracts: true });
      expect(admission.pass).toBe(false); expect(admission.errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toContain('ARTIFACT_DECLARATION_REQUIRED');
      expect(admission.errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toContain('absent');
    }
  });

  it('captures the selected policy in the exact final planner invocation while other roles stay unchanged', async () => {
    const selected = ['evidence_statistics', 'evidence_statistics'] as const;
    expect(parseBriefFrontmatter(brief(selected)).plannerPolicies).toEqual(['evidence_statistics']);
    expect(parsePlannerPolicySelection(selected)).toEqual(['evidence_statistics']);
    expect(renderPlannerPolicies(selected)).toBe(renderPlannerPolicies(['evidence_statistics']));
    const runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['plan', 'coder']).runId;
    const directory = runDir(project, runId); const received: Record<string, string> = {};
    const adapter = { async run(_prompt: string, role: { prompt: string }, opts: { stageId: string }) { received[opts.stageId] = role.prompt; return { output: 'done', exitCode: 0, duration_ms: 1 }; } };
    for (const role of ['planner', 'coder']) await runStage(adapter, { stageId: role === 'planner' ? 'plan' : 'coder', role: { name: role, description: role, model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Execute the fixture.' }, dependsOn: [], promptTemplate: 'Work.', timeout_ms: 10000, projectDir: project, runId, runDir: directory, taskDescription: brief(selected), retries: 0, artifactContract: emptyArtifactContract() });
    expect(received.plan).toContain('# Brief planning policies'); expect(received.plan).toContain('method_was_not_adjusted_to_match_expectation');
    expect(received.coder).toBe('Execute the fixture.');
    const view = readRunStateView(project, runId, { includePromptText: true });
    expect(view.prompts.invocations.find((entry) => entry.record?.stageId === 'plan')?.record?.systemPrompt).toBe(received.plan);
  });
});
