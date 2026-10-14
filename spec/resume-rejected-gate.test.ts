import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { Orchestrator } from '../src/orchestrator.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';
import { declaredDispatch, fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, roles: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-rejected-continuation-'));
  project = join(root, 'project');
  roles = join(project, 'config', 'agents');
  mkdirSync(roles, { recursive: true });
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function fixture(dynamic: boolean, repairs: number, iterations = 3, withRepair = true) {
  setEngineDefaults({ gate_retry_loops: repairs, stage_technical_retries: 0 });
  const brief = '# Goal\nCheck external readiness.\n\n# Acceptance criteria\n1. External readiness is confirmed.';
  const criterionRefs = extractBriefCriteria(brief).criteria.map(criterion => criterion.id);
  const stages = [
    { id: 'done', role: 'coder', scope: [], depends_on: [], prompt_template: 'Prepare once.', artifact_contract: fixtureArtifactContract('done') },
    { id: 'review', role: 'coder', scope: [], depends_on: ['done'], is_gate: true, criterion_refs: criterionRefs, prompt_template: 'Check external readiness.', artifact_contract: fixtureArtifactContract('review', true) },
    ...(withRepair ? [{ id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], prompt_template: 'Inspect the environment.', artifact_contract: fixtureArtifactContract('repair') }] : []),
  ];
  const plan = { id: 'plan', role: 'coder', scope: [], dynamic_dispatch: true, prompt_template: 'Admit the work.', artifact_contract: {
    version: 1, produces: [{ id: 'dispatch', root: 'run', path: 'dispatch.yaml', kind: 'file' }], reads: [], replays: [],
  } };
  const workflow = WorkflowConfigSchema.parse({ name: 'continuation-fixture', defaults: { max_iterations: iterations, max_retries: repairs }, stages: dynamic ? [plan] : stages });
  let ready = false;
  const calls: Array<{ stage: string; iteration: number }> = [];
  const adapter: Adapter = { async run(_prompt, _agent, opts) {
    calls.push({ stage: opts.stageId, iteration: JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).currentIteration });
    if (opts.stageId === 'plan') writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringify({ stages })));
    const output = opts.stageId === 'plan' ? 'Authored the execution plan.'
      : opts.stageId === 'review' ? JSON.stringify({ pass: ready, reason: ready ? 'External condition fixed.' : 'External condition unavailable.',
        criteria: Object.fromEntries(criterionRefs.map(id => [id, { status: ready ? 'pass' : 'fail', evidence: 'Checked external readiness.' }])),
        audit_findings: { version: 1, findings: [] },
        ...(!ready ? { repairability: { version: 1, disposition: 'repairable', evidence: 'The operator can restore external readiness.' } } : {}) })
      : 'Completed admitted work.';
    return fixtureResult({ output, exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } };
  const admission = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
  const run = (id?: string) => runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles, id, brief, false, undefined, true, admission);
  const seedPrematureIncomplete = async () => {
    // Build settled execution evidence with one iteration, then explicitly
    // seed the premature incomplete projection produced by older schedulers.
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    updateRunState(project, created.runId, state => {
      state.maxIterations = 1;
      // Old admitted static plans may lack the repair route now required at admission.
      if (!withRepair) recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Legacy static plan admitted before repair routes were required', true);
    });
    const settled = await run(created.runId);
    expect(settled).toMatchObject({ status: 'incomplete', currentIteration: 1, maxIterations: 1 });
    updateRunState(project, created.runId, state => {
      state.maxIterations = iterations;
      state.failureReason = 'Persisted premature incomplete fixture.';
    });
    return readRunState(project, created.runId);
  };
  return { run, seedPrematureIncomplete, calls, brief, fix: () => { ready = true; } };
}

it.each([false, true])('continues a rejected gate in the next iteration, retaining completed work (dynamic=%s)', async dynamic => {
  const f = fixture(dynamic, 1);
  const before = await f.seedPrematureIncomplete();
  expect(before).toMatchObject({ status: 'incomplete', currentIteration: 1, maxIterations: 3 });
  expect(Object.values(before.stages).every(stage => stage.status === 'complete')).toBe(true);
  const done = readStageStatus(project, before.runId, 'done');
  const repair = readStageStatus(project, before.runId, 'repair');
  const gate = readStageStatus(project, before.runId, 'review');
  const archive = join(root, 'state', 'runs', before.runId, 'gate_reevaluation', 'iteration_1', 'round_1', 'repair_diff.json');
  const archived = readFileSync(archive, 'utf8');
  f.fix();
  f.calls.length = 0;

  const after = await f.run(before.runId);

  expect(after.status, after.failureReason).toBe('complete');
  expect(f.calls).toEqual([{ stage: 'review', iteration: 2 }]);
  expect(after).toMatchObject({ runId: before.runId, startedAt: before.startedAt, currentIteration: 2, maxIterations: 3 });
  expect(after.planControl).toEqual(before.planControl);
  expect(readStageStatus(project, before.runId, 'done')).toEqual(done);
  expect(readStageStatus(project, before.runId, 'repair')).toEqual(repair);
  expect(readStageStatus(project, before.runId, 'review').attempts?.slice(0, -1)).toEqual(gate.attempts?.map((attempt, index) => (
    index === gate.attempts!.length - 1 ? { ...attempt, disposition: 'superseded' } : attempt
  )));
  expect(readFileSync(archive, 'utf8')).toBe(archived);
  if (dynamic) expect(after.stages.plan).toEqual(before.stages.plan);
});

it.each([false, true])('can reevaluate a rejection with zero repair budget (repair admitted=%s)', async withRepair => {
  const f = fixture(false, 0, 3, withRepair);
  const before = await f.seedPrematureIncomplete();
  expect(before.status).toBe('incomplete');
  f.fix();
  f.calls.length = 0;
  const after = await f.run(before.runId);
  expect(after.status, after.failureReason).toBe('complete');
  expect(f.calls).toEqual([{ stage: 'review', iteration: 2 }]);
  if (withRepair) expect(after.stages.repair.status).toBe('skipped');
});

it('spends successive iteration budgets and retains the normal admitted rejection repair route', async () => {
  const f = fixture(true, 1, 2);
  const before = await f.seedPrematureIncomplete();
  f.calls.length = 0;
  const after = await f.run(before.runId);
  expect(after).toMatchObject({ status: 'incomplete', currentIteration: 2, maxIterations: 2 });
  expect(f.calls).toEqual([{ stage: 'review', iteration: 2 }, { stage: 'repair', iteration: 2 }, { stage: 'review', iteration: 2 }]);
  expect(after.stages.done).toEqual(before.stages.done);
  expect(after.stages.plan).toEqual(before.stages.plan);
  f.calls.length = 0;
  const persisted = readFileSync(join(root, 'state', 'runs', before.runId, 'run.json'), 'utf8');
  await expect(f.run(before.runId)).rejects.toThrow(/iteration budget exhausted.*2\/2/i);
  expect(f.calls).toEqual([]);
  expect(readFileSync(join(root, 'state', 'runs', before.runId, 'run.json'), 'utf8')).toBe(persisted);
});

it.each([true, false])('reports exhausted iteration budget before queuing an operator task resume (saved budget=%s)', async savedBudget => {
  const f = fixture(false, 0, 1);
  const before = await f.run();
  expect(before.status).toBe('incomplete');
  if (!savedBudget) {
    updateRunState(project, before.runId, state => { delete state.maxIterations; });
    setEngineDefaults({ gate_retry_loops: 0, stage_technical_retries: 0, max_iterations: 9 });
  }
  const persisted = readFileSync(join(root, 'state', 'runs', before.runId, 'run.json'), 'utf8');
  const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
  const task = registry.create({ kind: 'quick', name: 'Continuation fixture', projectDir: project,
    brief_text: f.brief, brief_admission: before.briefAdmission,
    status: 'failed', run_id: before.runId });
  const orchestrator = new Orchestrator({ registry });

  await expect(orchestrator.resume(task.id)).rejects.toThrow(/iteration budget exhausted.*1\/1/i);

  expect(registry.get(task.id)).toEqual(task);
  expect(readFileSync(join(root, 'state', 'runs', before.runId, 'run.json'), 'utf8')).toBe(persisted);
});

it.each(['absent', 'invalid'])('reopens a completed nonpassing gate with an %s verdict', async verdict => {
  const f = fixture(false, 0, 3, false);
  const before = await f.seedPrematureIncomplete();
  expect(before.status).toBe('incomplete');
  const path = join(root, 'state', 'runs', before.runId, 'verdict_review.json');
  if (verdict === 'absent') rmSync(path);
  else writeFileSync(path, '{invalid');
  f.fix();
  f.calls.length = 0;

  const after = await f.run(before.runId);

  expect(after.status, after.failureReason).toBe('complete');
  expect(f.calls).toEqual([{ stage: 'review', iteration: 2 }]);
  expect(after.stages.done).toEqual(before.stages.done);
});
