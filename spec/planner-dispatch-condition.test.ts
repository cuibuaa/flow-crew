import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const temporary: string[] = [];
const executions = new Set<Promise<unknown>>();
const previousHome = fcGlobalDir();
function track<T>(execution: Promise<T>): Promise<T> {
  const settled = execution.finally(() => { executions.delete(settled); });
  executions.add(settled);
  return settled;
}
afterEach(async () => {
  const ownRoots = temporary.splice(0);
  while (executions.size) await Promise.allSettled([...executions]);
  setFcGlobalDir(previousHome);
  for (const root of ownRoots) rmSync(root, { recursive: true, force: true });
});

it('admits planner roots as conditional DAG duties without inventing a chosen successor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-condition-'));
  temporary.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  setFcGlobalDir(join(root, 'fc'));
  setEngineDefaults({ max_iterations: 1 });
  const artifact_contract = { version: 1, produces: [], reads: [] };
  const workflow = WorkflowConfigSchema.parse({ name: 'planner-conditions', stages: [
    { id: 'plan', role: 'planner', scope: [], dynamic_dispatch: true, artifact_contract },
  ] });
  // Put the false root first: the old summary named it as the chosen successor
  // solely because of proposal order, although admission accepts both duties.
  const proposal = ['unmet', 'met'].map(id => ({
    id, role: 'coder', scope: [], depends_on: ['plan'], artifact_contract,
    condition: `plan.status == ${id === 'met' ? 'complete' : 'failed'}`,
  }));
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: proposal }));
    return { output: JSON.stringify({ status: 'delivered', summary: 'Completed fixture duty.', checks: [], caveats: [], remaining_work: [] }),
      exitCode: 0, duration_ms: 1,
      ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
  } };
  const state = await track(runWorkflow(workflow, JSON.stringify(workflow), project, adapter, new Map(), undefined,
    join(import.meta.dirname, '../config/agents')));
  expect(state.status, state.failureReason).toBe('complete');
  expect(state.planControl!.stages.map(stage => stage.id)).toEqual(['plan', 'unmet', 'met']);
  expect(calls).toEqual(['plan', 'met']);
  expect(state.stages.met.attempts).toHaveLength(1);
  expect(state.stages.unmet.status).toBe('skipped');
  expect(state.stages.unmet.attempts ?? []).toHaveLength(0);
  expect(state.decisionGraph!.records).toEqual([]);
  expect(state.decisionGraph!.enabled).toEqual({});
  expect(readRunEvents(project, state.runId).filter(event => event.type === 'decision_chosen')).toEqual([]);
});

it('grants the entry fixed-shape choice before dispatching its conditional implement stage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixed-shape-condition-'));
  temporary.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  setFcGlobalDir(join(root, 'fc'));
  setEngineDefaults({ max_iterations: 1 });
  const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
  config.dispatch = [{ id: 'implement', role: 'coder', scope: [], condition: 'choose.status == failed',
    artifact_contract: { version: 1, produces: [], reads: [] } }];
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return { output: JSON.stringify(opts.stageId === 'choose'
      ? { successor: 'implement', reason: 'One implementation duty.', metric_search: false, assumptions: [], missing_author_facts: [] }
      : { status: 'delivered', summary: 'Completed selected duty.', checks: [], caveats: [], remaining_work: [] }),
    exitCode: 0, duration_ms: 1 };
  } };
  const state = await track(runWorkflow(config, JSON.stringify(config), project, adapter, new Map(), undefined,
    join(import.meta.dirname, '../config/agents')));
  expect(state.status, state.failureReason).toBe('complete');
  expect(calls).toEqual(['choose', 'implement']);
  expect(state.stages.plan.status).toBe('skipped');
  expect(state.stages.implement.status).toBe('complete');
  expect(state.stages.implement.attempts).toHaveLength(1);
  expect(state.decisionGraph!.records).toEqual([expect.objectContaining({ stageId: 'choose', successor: 'implement', outcome: 'chosen' })]);
  expect(state.decisionGraph!.enabled.implement).toBe('choose');
});
