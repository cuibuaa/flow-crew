import './test-support/policy-runtime.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { declaredDispatch, fixtureResult } from './test-support/declared-dispatch.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { inspectDispatchAdmission, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir } from '../src/store.js';

const roots: string[] = [];
const previous = fcGlobalDir();
afterEach(() => { setFcGlobalDir(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([false, true])('refuses planner replan admission when work depends on a gate rejected in the prior revision (retained ID: %s)', async retained => {
  const root = mkdtempSync(join(tmpdir(), 'planner-rejected-edge-')); roots.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ plan_stage_retries: 0, gate_retry_loops: 1, max_iterations: 1 });
  const agents = join(project, 'config/agents'); mkdirSync(agents, { recursive: true });
  for (const role of ['planner', 'coder', 'qa']) writeFileSync(join(agents, `${role}.yaml`), stringify({ name: role, description: 'Fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Fixture.' }));
  const contract = { version: 1, produces: [], reads: [] };
  const workflow = WorkflowConfigSchema.parse({ name: 'rejected-edge', defaults: { max_iterations: 1 }, stages: [
    { id: 'plan', role: 'planner', scope: [], dynamic_dispatch: true, artifact_contract: contract },
  ] });
  const calls: string[] = [];
  let plans = 0, replanPrompt = '';
  let replanState: ReturnType<typeof readRunState> | undefined;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    let output = 'Fixture completed.';
    if (opts.stageId === 'plan') {
      plans++;
      const state = readRunState(project, basename(opts.runDir));
      if (plans === 2) { replanPrompt = _prompt; replanState = state; }
      const stages = plans === 1 ? [
        { id: 'author', role: 'coder', scope: [], depends_on: ['plan'] },
        { id: 'review', role: 'qa', scope: [], depends_on: ['author'], is_gate: true },
        { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], decision: { successors: ['replan'], default: 'replan' } },
        ...(retained ? [{ id: 'finish', role: 'coder', scope: [], depends_on: ['repair'] }] : []),
      ] : [...state.planControl!.stages.filter(stage => !stage.dynamic_dispatch && stage.id !== 'finish'),
        StageConfigSchema.parse({ id: 'finish', role: 'coder', scope: [], depends_on: ['review'], artifact_contract: contract })];
      writeFileSync(stageWorkPath(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringify({ stages })));
    } else if (opts.stageId === 'review') {
      output = JSON.stringify({ pass: false, reason: 'Required outcome remains unverified.', criteria: {}, audit_findings: { version: 1, findings: [] },
        repairability: { version: 1, disposition: 'repairable', evidence: 'Fixture rejection.' } });
    } else if (opts.stageId === 'repair') output = JSON.stringify({ successor: 'replan', reason: 'Revise remaining work.' });
    return fixtureResult({ output, exitCode: 0, duration_ms: 1 }, opts);
  } };
  const final = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, agents, undefined, '', true);
  {
    const _prompt = replanPrompt, state = replanState!;
    const block = _prompt.split('# Replan facts\n')[1]?.split('\n\nWork-division note (scope):')[0].trim();
    expect(block).toBeDefined();
    const facts = JSON.parse(block!);
    expect(block).toBe(JSON.stringify(facts));
    expect(Object.keys(facts).sort()).toEqual(['admitted_stages', 'budgets', 'current_revision', 'decisions', 'progress', 'reason']);
    expect(facts).toMatchObject({ current_revision: state.queryState!.planRevision, admitted_stages: state.planControl!.stages,
      decisions: state.decisionGraph!.records, reason: state.decisionGraph!.replan!.reason,
      budgets: { dispatchAdmission: state.dispatchAdmission, iteration: state.currentIteration, maximum_iterations: state.maxIterations, started_at: state.startedAt } });
    expect(Object.keys(facts.progress).sort()).toEqual(Object.keys(state.stages).sort());
    for (const [id, progress] of Object.entries(facts.progress) as [string, { status: string; attempts?: Record<string, unknown>[] }][]) {
      expect(Object.keys(progress).every(key => ['status', 'attempts'].includes(key))).toBe(true);
      for (const attempt of progress.attempts ?? []) expect(Object.keys(attempt).every(key =>
        ['index', 'startedAt', 'completedAt', 'status', 'exitCode', 'tokenUsage'].includes(key))).toBe(true);
      if (id !== 'plan') expect(progress).toEqual(JSON.parse(JSON.stringify({ status: state.stages[id].status,
        attempts: state.stages[id].attempts?.map(({ index, startedAt, completedAt, status, exitCode, tokenUsage }) =>
          ({ index, startedAt, completedAt, status, exitCode, tokenUsage })) })));
    }
  }
  const report = JSON.parse(readFileSync(runRecordPath(runDir(project, final.runId), 'dispatch_admission.json'), 'utf8'));
  expect(plans).toBe(2);
  const snapshot = replanState!;
  const unrecordedPlan = inspectDispatchAdmission({
    dispatched: [StageConfigSchema.parse({ id: 'finish', role: 'coder', scope: [], depends_on: ['review'], artifact_contract: contract })],
    baseStages: snapshot.planControl!.stages.filter(stage => stage.id !== 'finish'), dispatchStageId: 'plan',
    state: { ...snapshot, planControl: undefined }, projectDir: project,
  });
  expect(unrecordedPlan.errors).toContainEqual(expect.objectContaining({ code: 'stage_dependency_rejected', stageId: 'finish', field: 'depends_on.review' }));
  expect(report.errors).toContainEqual(expect.objectContaining({ code: 'stage_dependency_rejected', stageId: 'finish', field: 'depends_on.review' }));
  expect(final.status, final.failureReason).toBe('failed');
  expect(final.queryState!.planRevision!.revision).toBe(0);
  if (retained) {
    expect(final.stages.finish.attempts ?? []).toHaveLength(0);
    expect(final.planControl!.stages.find(stage => stage.id === 'finish')!.depends_on).toEqual(['repair']);
  } else expect(final.stages).not.toHaveProperty('finish');
  expect(calls).not.toContain('finish');
});
