import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RunDetail from '../ui/src/components/RunDetail.js';
import { loadWorkflow, StageConfigSchema } from '../src/scheduler.js';
import { RecordedWorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { plannerReply } from './test-support/planner-entry.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, listRuns, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { readRunStateView } from '../src/run-state-view.js';
import { stateToRunDetail } from '../src/dashboard.js';
import { renderRunSummary } from '../src/run-summary.js';
import { assertContinuationCompatible, ContinuationRefusal } from '../src/engine-continuation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

let root: string, project: string, previous: string;
const brief = '---\ncriteria: [{id: result, text: Deliver the greeting.}]\n---\n# Greeting\n';
const workflows = join(import.meta.dirname, '../config/workflows');
const roles = join(import.meta.dirname, '../config/agents');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'planner-entry-')); project = join(root, 'project'); mkdirSync(project);
  mkdirSync(join(root, 'home'));
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  setEngineDefaults({ max_iterations: 1, plan_stage_retries: 1, gate_retry_loops: 1 });
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

it('starts entry at the planner with no preceding decision or fixed answer', () => {
  const { config } = loadWorkflow(join(workflows, 'entry.yaml'));
  expect(config.stages).toHaveLength(1);
  expect(config.stages[0]).toMatchObject({ id: 'plan', role: 'planner', dynamic_dispatch: true, depends_on: [] });
  expect(config.stages[0].decision).toBeUndefined();
  expect(config.dispatch).toBeUndefined();
  expect(StageConfigSchema.safeParse({ id: 'route', role: 'planner', decision: { kind: 'shape', successors: ['plan'], default: 'plan' } }).success).toBe(false);
});

it.each([1, 2])('admits a planner graph with %s author duties through dispatch admission and independent acceptance', async count => {
  const { config, raw } = loadWorkflow(join(workflows, 'entry.yaml'));
  const authors = Array.from({ length: count }, (_, n) => ({ id: `author_${n}`, role: 'coder', depends_on: n ? [`author_${n - 1}`] : [] }));
  const proposal = [...authors,
    { id: 'gate', role: 'qa', depends_on: [authors.at(-1)!.id], is_gate: true },
    { id: 'repair', role: 'coder', depends_on: ['gate'], retry_to: ['gate'] },
  ].map(stage => ({ ...stage, artifact_contract: { version: 1, produces: [], reads: [] } }));
  const calls: string[] = [];
  const final = await runWorkflow(config, raw, project, { async run(_user, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') return plannerReply(opts, proposal);
    return { output: JSON.stringify(opts.outputSchema?.anyOf
      ? { pass: true, reason: 'Independent greeting check.', criteria: { result: { status: 'pass', evidence: 'Independent check.' } }, audit_findings: { version: 1, findings: [] } }
      : { status: 'delivered', summary: 'Greeting delivered.', caveats: [], remaining_work: [], blocks: null }), exitCode: 0, duration_ms: 0 };
  } }, new Map(), undefined, roles, undefined, brief, true);
  expect(final.status, final.failureReason).toBe('complete');
  expect(final.decisionGraph?.records.some(record => record.gateAccepted === true)).toBe(true);
  const admission = JSON.parse(readFileSync(runRecordPath(join(fcGlobalDir(), 'runs', final.runId), 'dispatch_admission.json'), 'utf8'));
  expect(admission.pass).toBe(true);
  expect(admission.criterionGateRefs).toEqual({ gate: ['result'] });
  expect(calls).toEqual(['plan', ...authors.map(stage => stage.id), 'gate']);
});

it.each([1, 2])('refuses an ungated planner graph with %s author duties before execution', async count => {
  const { config, raw } = loadWorkflow(join(workflows, 'entry.yaml'));
  const calls: string[] = [];
  const final = await runWorkflow(config, raw, project, { async run(_user, _role, opts) {
    calls.push(opts.stageId);
    return plannerReply(opts, Array.from({ length: count }, (_, n) => ({ id: `author_${n}`, role: 'coder', artifact_contract: { version: 1, produces: [], reads: [] } })));
  } }, new Map(), undefined, roles, undefined, brief, true);
  expect(final.status).not.toBe('complete');
  expect(calls.every(id => id === 'plan' || id.startsWith('_'))).toBe(true);
  const admission = JSON.parse(readFileSync(runRecordPath(join(fcGlobalDir(), 'runs', final.runId), 'dispatch_admission.json'), 'utf8'));
  expect(admission.pass).toBe(false);
});

function bytes(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(bytes(path)).map(([key, value]) => [`${entry.name}/${key}`, value])
      : entry.isFile() ? [[entry.name, readFileSync(path).toString('base64')]] : [];
  }));
}
it('reads legacy choose/shape through status, listing, summary and rendered UI; refuses resume without mutation', async () => {
  const legacy = { name: 'entry', stages: [
    { id: 'choose', role: 'planner', decision: { kind: 'shape', successors: ['implement', 'plan'], default: 'plan' } },
    { id: 'plan', role: 'planner', depends_on: ['choose'], dynamic_dispatch: true },
  ] };
  const raw = JSON.stringify(legacy);
  const { runId, runDirPath } = createRun(project, 'entry', raw, ['choose', 'plan'], brief);
  updateRunState(project, runId, state => {
    state.status = 'failed'; state.currentIteration = 1; state.maxIterations = 3;
    state.stages.choose = { status: 'complete', retries: 0 };
    state.decisionGraph = { records: [{ key: 'legacy', stageId: 'choose', iteration: 1, successor: 'plan', outcome: 'chosen',
      reason: 'Historical decomposition.', assumptions: ['Retained greeting convention.'] }], enabled: { plan: 'choose' }, visits: {} };
  });
  const before = bytes(runDirPath);
  const recorded = RecordedWorkflowConfigSchema.parse(legacy);
  expect(recorded.stages[0].decision?.kind).toBe('shape');
  expect(() => loadWorkflow(runRecordPath(runDirPath, 'workflow.yaml'))).toThrow();
  expect(loadWorkflow(runRecordPath(runDirPath, 'workflow.yaml'), true).config.stages[0].decision?.kind).toBe('shape');
  expect(readRunStateView(project, runId).stages.choose.status).toBe('complete');
  expect(listRuns(project)).toContain(runId);
  const state = readRunState(project, runId);
  expect(renderRunSummary(project, runDirPath, state)).toContain('Retained greeting convention.');
  const ui = stateToRunDetail(state, project);
  expect(ui.stages.some(stage => stage.id === 'choose')).toBe(true);
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RunDetail, { run: ui })));
  expect(html).toContain('choose'); expect(html).toContain(runId);
  const status = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname,
    'status', '--project', project], { cwd: project, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: join(root, 'home'), FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'private.sock'), TSX_DISABLE_CACHE: '1' } });
  expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain(runId); expect(status.stdout).toContain('choose');
  expect(() => assertContinuationCompatible(project, runId)).toThrow(ContinuationRefusal);
  try { assertContinuationCompatible(project, runId); } catch (error) { expect(error).toMatchObject({ code: 'retired_shape_decision' }); }
  let calls = 0;
  await expect(runWorkflow(recorded, raw, project, { async run() { calls++; throw new Error('retired stage executed'); } }, new Map(), undefined, roles, runId))
    .rejects.toMatchObject({ code: 'retired_shape_decision' });
  expect(calls).toBe(0);
  expect(bytes(runDirPath)).toEqual(before);
});

it.each(['workflow', 'planControl'])('reads legacy review_assess through status, listing, summary and rendered UI; refuses resume without mutation (%s)', async carrier => {
  const legacy = { name: 'entry', stages: [
    { id: 'review_assess', role: 'qa', decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } },
    { id: 'review', role: 'qa', depends_on: ['review_assess'], is_gate: true },
    { id: 'review_full', role: 'qa', depends_on: ['review_assess'], is_gate: true },
  ] };
  const raw = JSON.stringify(legacy);
  const { runId, runDirPath } = createRun(project, 'entry', raw, ['review_assess', 'review', 'review_full'], brief);
  updateRunState(project, runId, state => {
    state.status = 'failed'; state.currentIteration = 1; state.maxIterations = 3;
    state.stages.review_assess = { status: 'complete', retries: 0 };
    state.decisionGraph = { records: [{ key: 'legacy', stageId: 'review_assess', iteration: 1, successor: 'review_full', outcome: 'chosen',
      reason: 'Historical decomposition.', risk_areas: [{ file: 'docs/result.md', risk: 'Historical risk.', experiment: 'Read the result.' }] }], enabled: { review_full: 'review_assess' }, visits: {} };
  });
  const recorded = RecordedWorkflowConfigSchema.parse(legacy);
  if (carrier === 'planControl') {
    updateRunState(project, runId, state => { state.planControl = { stages: recorded.stages } as typeof state.planControl; });
    writeFileSync(runRecordPath(runDirPath, 'workflow.yaml'), JSON.stringify({ name: 'entry', stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true }] }));
  }
  const before = bytes(runDirPath);
  expect(recorded.stages[0].decision?.kind).toBe('review');
  if (carrier === 'workflow') {
    expect(() => loadWorkflow(runRecordPath(runDirPath, 'workflow.yaml'))).toThrow();
    expect(loadWorkflow(runRecordPath(runDirPath, 'workflow.yaml'), true).config.stages[0].decision?.kind).toBe('review');
  }
  expect(readRunStateView(project, runId).stages.review_assess.status).toBe('complete');
  expect(listRuns(project)).toContain(runId);
  const state = readRunState(project, runId);
  expect(renderRunSummary(project, runDirPath, state)).toContain('review_assess');
  expect(state.decisionGraph!.records[0].risk_areas?.[0].risk).toBe('Historical risk.');
  const ui = stateToRunDetail(state, project);
  expect(ui.stages.some(stage => stage.id === 'review_assess')).toBe(true);
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RunDetail, { run: ui })));
  expect(html).toContain('review_assess'); expect(html).toContain(runId);
  const status = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname,
    'status', '--project', project], { cwd: project, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: join(root, 'home'), FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'private.sock'), TSX_DISABLE_CACHE: '1' } });
  expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain(runId); expect(status.stdout).toContain('review_assess');
  expect(() => assertContinuationCompatible(project, runId)).toThrow(ContinuationRefusal);
  try { assertContinuationCompatible(project, runId); } catch (error) { expect(error).toMatchObject({ code: 'retired_review_decision' }); }
  let calls = 0;
  await expect(runWorkflow(recorded, raw, project, { async run() { calls++; throw new Error('retired stage executed'); } }, new Map(), undefined, roles, runId))
    .rejects.toMatchObject({ code: 'retired_review_decision' });
  expect(calls).toBe(0);
  expect(bytes(runDirPath)).toEqual(before);
});

it('shipped workflows contain no pre-review routing decision', async () => {
  for (const file of readdirSync(workflows).filter(file => file.endsWith('.yaml'))) {
    const { config } = loadWorkflow(join(workflows, file));
    const stages = [...config.stages, ...(config.dispatch ?? []).map(stage => StageConfigSchema.parse(stage))];
    // Shipped repair routing stays possible; no separate model selects review depth.
    expect(stages.filter(stage => !stage.is_gate && !stage.retry_to?.length && stage.decision), file).toEqual([]);
  }
  expect(() => StageConfigSchema.parse({ id: 'route', role: 'qa', decision: {
    kind: 'review', successors: ['gate', 'full'], default: 'full',
  } })).toThrow();
  // Entry's topology is emitted by the planner and normalized in code.
  const { config, raw } = loadWorkflow(join(workflows, 'entry.yaml'));
  const calls: string[] = [];
  const final = await runWorkflow(config, raw, project, { async run(_user, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') return plannerReply(opts);
    return { output: JSON.stringify(opts.outputSchema?.anyOf
      ? { pass: true, reason: 'Independent greeting check.', criteria: { result: { status: 'pass', evidence: 'Independent check.' } }, audit_findings: { version: 1, findings: [] } }
      : { status: 'delivered', summary: 'Greeting delivered.', caveats: [], remaining_work: [], blocks: null }), exitCode: 0, duration_ms: 0 };
  } }, new Map(), undefined, roles, undefined, brief, true);
  expect(final.status, final.failureReason).toBe('complete');
  expect(calls).toEqual(['plan', 'implement', 'review']);
  expect(final.planControl!.stages.filter(stage => stage.is_gate).map(stage => stage.id)).toEqual(['review']);
});
