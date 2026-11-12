import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
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

describe('brief planning uses the authored contract', () => {
  it('does not inject retired evidence-statistics obligations into any invocation', async () => {
    const { final, received } = await runPolicyWorkflow(brief(['evidence_statistics']));
    expect(final.status, final.failureReason).toBe('complete');
    for (const { system } of Object.values(received)) {
      expect(system).not.toContain('# Brief planning policies');
      expect(system).not.toContain('method_was_not_adjusted_to_match_expectation');
    }
  });

  it('retains core topology and artifact declaration refusals', () => {
    const stage = StageConfigSchema.parse({ id: 'work', role: 'coder', scope: [], depends_on: ['absent'], dependency_reasons: { absent: 'Needs absent output.' }, prompt_template: 'Work.' });
    const admission = inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan', requireArtifactContracts: true });
    expect(admission.pass).toBe(false);
    const errors = admission.errors.map(error => typeof error === 'string' ? error : error.message).join(';');
    expect(errors).toContain('ARTIFACT_DECLARATION_REQUIRED');
    expect(errors).toContain('absent');
  });
});
