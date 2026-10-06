import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectDefaultsLocally, resetConfigCache } from '../src/config.js';
import { parsePlannerPolicySelection, renderPlannerPolicies } from '../src/planner-policies.js';
import { inspectDispatchAdmission, StageConfigSchema } from '../src/scheduler.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-planner-policies-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); resetConfigCache();
});
afterEach(() => { setFcGlobalDir(previousStore); resetConfigCache(); rmSync(root, { recursive: true, force: true }); });
function defaults(value: unknown) { mkdirSync(join(project, 'config'), { recursive: true }); writeFileSync(join(project, 'config/defaults.yaml'), JSON.stringify(value)); }

describe('project policy selection is explicit and does not replace core admission', () => {
  it('does not inherit this engine project\'s statistical policy when initializing a new project', () => {
    expect(loadProjectDefaultsLocally(project).planner_policies).toEqual([]);
    expect(readFileSync(join(project, 'config/defaults.yaml'), 'utf8')).not.toContain('planner_policies');
    expect(renderPlannerPolicies([])).toBe('');
  });

  it.each([null, 'evidence_statistics', ['unknown'], ['evidence_statistics', 'evidence_statistics']])('refuses malformed selection %j precisely', (value) => {
    defaults({ planner_policies: value });
    expect(() => loadProjectDefaultsLocally(project)).toThrow('PLANNER_POLICY_INVALID');
    expect(() => parsePlannerPolicySelection(value)).toThrow('planner_policies');
  });

  it('always refuses core malformed topology, scope and missing declarations under both policy selections', () => {
    for (const policies of [[], ['evidence_statistics']]) {
      defaults({ planner_policies: policies }); resetConfigCache();
      expect(loadProjectDefaultsLocally(project).planner_policies).toEqual(policies);
      const stage = StageConfigSchema.parse({ id: 'work', role: 'coder', scope: [], depends_on: ['absent'], dependency_reasons: { absent: 'Needs absent output.' }, prompt_template: 'Work.' });
      const admission = inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan', requireArtifactContracts: true });
      expect(admission.pass).toBe(false); expect(admission.errors.join(';')).toContain('ARTIFACT_DECLARATION_REQUIRED');
      expect(admission.errors.join(';')).toContain('absent');
    }
  });

  it('captures the selected policy in the exact final planner invocation while other roles stay unchanged', async () => {
    defaults({ planner_policies: ['evidence_statistics'] });
    const runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['plan', 'coder']).runId;
    const directory = runDir(project, runId); const received: Record<string, string> = {};
    const adapter = { async run(_prompt: string, role: { prompt: string }, opts: { stageId: string }) { received[opts.stageId] = role.prompt; return { output: 'done', exitCode: 0, duration_ms: 1 }; } };
    for (const role of ['planner', 'coder']) await runStage(adapter, { stageId: role === 'planner' ? 'plan' : 'coder', role: { name: role, description: role, model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Execute the fixture.' }, dependsOn: [], promptTemplate: 'Work.', timeout_ms: 10000, projectDir: project, runId, runDir: directory, retries: 0, artifactContract: emptyArtifactContract() });
    expect(received.plan).toContain('# Project planning policies'); expect(received.plan).toContain('method_was_not_adjusted_to_match_expectation');
    expect(received.coder).toBe('Execute the fixture.');
    const view = readRunStateView(project, runId, { includePromptText: true });
    expect(view.prompts.invocations.find((entry) => entry.record?.stageId === 'plan')?.record?.systemPrompt).toBe(received.plan);
  });
});
