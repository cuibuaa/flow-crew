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
import { StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir } from '../src/store.js';

const roots: string[] = [];
const previous = fcGlobalDir();
afterEach(() => { setFcGlobalDir(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('refuses planner replan admission when new work depends on a gate rejected in the prior revision', async () => {
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
  let plans = 0;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    let output = 'Fixture completed.';
    if (opts.stageId === 'plan') {
      plans++;
      const state = readRunState(project, basename(opts.runDir));
      const stages = plans === 1 ? [
        { id: 'author', role: 'coder', scope: [], depends_on: ['plan'] },
        { id: 'review', role: 'qa', scope: [], depends_on: ['author'], is_gate: true },
        { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], decision: { successors: ['replan'], default: 'replan' } },
      ] : [...state.planControl!.stages.filter(stage => !stage.dynamic_dispatch),
        StageConfigSchema.parse({ id: 'finish', role: 'coder', scope: [], depends_on: ['review'], artifact_contract: contract })];
      writeFileSync(stageWorkPath(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringify({ stages })));
    } else if (opts.stageId === 'review') {
      output = JSON.stringify({ pass: false, reason: 'Required outcome remains unverified.', criteria: {}, audit_findings: { version: 1, findings: [] },
        repairability: { version: 1, disposition: 'repairable', evidence: 'Fixture rejection.' } });
    } else if (opts.stageId === 'repair') output = JSON.stringify({ successor: 'replan', reason: 'Revise remaining work.' });
    return fixtureResult({ output, exitCode: 0, duration_ms: 1 }, opts);
  } };
  const final = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, agents, undefined, '', true);
  const report = JSON.parse(readFileSync(runRecordPath(runDir(project, final.runId), 'dispatch_admission.json'), 'utf8'));
  expect(plans).toBe(2);
  expect(report.errors).toContainEqual(expect.objectContaining({ code: 'stage_dependency_rejected', stageId: 'finish', field: 'depends_on.review' }));
  expect(final.status, final.failureReason).toBe('failed');
  expect(final.queryState!.planRevision!.revision).toBe(0);
  expect(final.stages).not.toHaveProperty('finish');
  expect(calls).not.toContain('finish');
});
