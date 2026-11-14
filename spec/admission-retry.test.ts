import './test-support/policy-runtime.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { buildRetryPreamble, inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { createRun } from './test-support/create-run.js';
import { admitPlannerDispatches } from '../src/scheduler/sched_loop/planner-dispatch.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, writeRunState, writeStageStatus, listRuns } from '../src/store.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { readRunStateView } from '../src/run-state-view.js';
import { renderRunSummary } from '../src/run-summary.js';
import { startDashboard } from '../src/dashboard.js';

const roots: string[] = [];
const prior = fcGlobalDir();
afterEach(() => { setFcGlobalDir(prior); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), 'fc-admission-')); roots.push(root); return root; }
const stage = (id: string, extra = {}) => parseDispatchedStageConfig({ id, role: 'coder', scope: [], artifact_contract: { version: 1, produces: [], reads: [] }, ...extra });
function setup() {
  const root = directory(), project = join(root, 'project'); mkdirSync(project);
  setFcGlobalDir(join(root, 'store'));
  const plan = stage('plan', { dynamic_dispatch: true });
  const created = createRun(project, 'fixture', stringify({ name: 'fixture', stages: [plan] }), ['plan']);
  const roles = new Map([['coder', { name: 'coder', description: 'Fixture' }]]);
  function propose(id = 'plan', iteration = 1, valid = false) {
    const planner = stage(id, { dynamic_dispatch: true });
    const state = readRunState(project, created.runId);
    state.currentIteration = iteration;
    state.stages[id] = { status: 'complete', retries: 0 };
    writeRunState(project, created.runId, state);
    writeStageStatus(project, created.runId, id, state.stages[id]);
    writeFileSync(stageWorkPath(created.runDirPath, 'dispatch.yaml'), stringify({ stages: valid ? [stage('work')] : [] }));
    return admitPlannerDispatches([planner], state, project, created.runId, created.runDirPath, roles, new Set());
  }
  return { ...created, project, propose };
}

it('has one admission owner and stops the refusal loop across resume, iterations, defaults and planner identities', () => {
  expect(existsSync(resolve(import.meta.dirname, '../src/plan-retry-monotone.ts'))).toBe(false);
  setEngineDefaults({ plan_stage_retries: 1 });
  const ctx = setup();
  expect(ctx.propose().kind).toBe('continue');
  expect(readRunState(ctx.project, ctx.runId).dispatchAdmission).toEqual({ refusals: 1, maxRefusals: 2 });
  setEngineDefaults({ plan_stage_retries: 99 });
  const final = ctx.propose('revise', 7);
  expect(final.kind).toBe('settled');
  expect(final.state.status).toBe('failed');
  expect(final.state.dispatchAdmission).toEqual({ refusals: 2, maxRefusals: 2 });
  expect(ctx.propose('another', 8, true).state.failureReason).toContain('dispatch_retry_exhausted');
});

it('does not reset spent refusals or the first ceiling after a successful complete proposal', () => {
  setEngineDefaults({ plan_stage_retries: 1 });
  const ctx = setup(); ctx.propose();
  expect(ctx.propose('revised', 2, true).state.dispatchAdmission).toEqual({ refusals: 1, maxRefusals: 2 });
  setEngineDefaults({ plan_stage_retries: 0 });
  expect(ctx.propose('third', 3).state.dispatchAdmission).toEqual({ refusals: 2, maxRefusals: 2 });
});

it('keeps the admission budget in guarded run storage', async () => {
  const ctx = setup(); ctx.propose();
  const path = runRecordPath(ctx.runDirPath, 'run.json');
  const trusted = readFileSync(path, 'utf8');
  await expect(withEngineIntegrity({ projectDir: ctx.project, runDir: ctx.runDirPath, stageId: 'plan' }, async () => {
    const forged = JSON.parse(trusted); forged.dispatchAdmission.refusals = 0;
    writeFileSync(path, JSON.stringify(forged));
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(readFileSync(path, 'utf8')).toBe(trusted);
});

it('examines full replacements independently without writing incumbent or paired snapshots', () => {
  const ctx = setup(); ctx.propose();
  expect(ctx.propose('replacement', 2, true).state.stages.work.status).toBe('pending');
  expect(existsSync(runRecordPath(ctx.runDirPath, 'plan_retry'))).toBe(false);
  expect(existsSync(runRecordPath(ctx.runDirPath, 'plan_retry_state.json'))).toBe(false);
});

it('reports the exhausting proposal errors rather than an earlier refusal', () => {
  setEngineDefaults({ plan_stage_retries: 1 });
  const ctx = setup(); ctx.propose();
  const state = readRunState(ctx.project, ctx.runId); state.stages.plan.status = 'complete';
  writeStageStatus(ctx.project, ctx.runId, 'plan', state.stages.plan);
  writeFileSync(stageWorkPath(ctx.runDirPath, 'dispatch.yaml'), stringify({ stages: [{ id: 'foreign', role: 'absent' }] }));
  const final = admitPlannerDispatches([stage('plan', { dynamic_dispatch: true })], state, ctx.project, ctx.runId, ctx.runDirPath, new Map(), new Set());
  expect(final.state.failureReason).toContain('unknown role');
  expect(final.state.failureReason).not.toContain('dispatch contains no stages');
  expect(JSON.parse(readFileSync(runRecordPath(ctx.runDirPath, 'dispatch_rejections/attempt_2/dispatch_admission.json'), 'utf8')).errors[0].code).toBe('stage_role_unknown');
});

it('refuses a corrupted admission budget with a typed reason', () => {
  const ctx = setup();
  const state = readRunState(ctx.project, ctx.runId); state.dispatchAdmission = { refusals: -1, maxRefusals: 2 };
  writeRunState(ctx.project, ctx.runId, state);
  expect(ctx.propose().state.failureReason).toContain('dispatch_budget_invalid');
});

it('keeps legacy retry records readable in status, listing, summary and UI while refusing continuation with a typed reason', async () => {
  const ctx = setup();
  writeFileSync(runRecordPath(ctx.runDirPath, 'plan_retry_state.json'), '{retained legacy bytes');
  expect(readRunState(ctx.project, ctx.runId).runId).toBe(ctx.runId);
  expect(listRuns(ctx.project)).toContain(ctx.runId);
  expect(readRunStateView(ctx.project, ctx.runId)).toBeDefined();
  expect(renderRunSummary(ctx.project, ctx.runDirPath, readRunState(ctx.project, ctx.runId))).toContain(ctx.runId);
  const app = await startDashboard(ctx.project, 0, { distDir: join(ctx.project, 'absent-dist') });
  try { expect((await app.inject({ method: 'GET', url: `/api/runs/${ctx.runId}` })).statusCode).toBe(200); }
  finally { await app.close(); }
  expect(ctx.propose().state.failureReason).toContain('legacy_retry_state_unsupported');
  expect(readFileSync(runRecordPath(ctx.runDirPath, 'plan_retry_state.json'), 'utf8')).toBe('{retained legacy bytes');
});

it.each(['attempt_timeout', 'exit'])('uses ordinary retry facts after a %s inside an admission refusal chain', cause => {
  const ctx = setup(); ctx.propose();
  const statusPath = runRecordPath(ctx.runDirPath, 'stages/plan/status.json');
  const status = { status: 'pending', retries: 1, error: 'proposal refused', admissionFailure: { code: 'dispatch_refused', attemptIndex: 1 },
    attempts: [{ index: 1, status: 'complete', error: undefined as string | undefined }] };
  writeFileSync(statusPath, JSON.stringify(status));
  expect(buildRetryPreamble(1, 1000, ctx.runDirPath, 'plan')).toContain('RE-PLAN');
  status.error = cause === 'attempt_timeout' ? 'attempt timed out' : 'adapter crashed';
  status.attempts.push({ index: 2, status: 'failed', error: status.error });
  writeFileSync(statusPath, JSON.stringify(status));
  const prompt = buildRetryPreamble(2, 2000, ctx.runDirPath, 'plan', cause === 'attempt_timeout' ? { previousBudgetMs: 1000, nextBudgetMs: 2000 } : undefined);
  expect(prompt).toContain('RETRY'); expect(prompt).not.toContain('Dispatch admission facts');
  expect(prompt).toContain(cause === 'attempt_timeout' ? '"nextBudgetMs":2000' : 'adapter crashed');
});

it('keeps typed admission fields stable when stages and dependencies reorder', () => {
  const a = stage('a', { depends_on: ['missing_a'], dependency_reasons: { missing_a: 'input' } });
  const b = stage('b', { depends_on: ['missing_b'], dependency_reasons: { missing_b: 'input' } });
  const errors = (stages: typeof a[]) => inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).errors;
  const identity = (entries: ReturnType<typeof errors>) => entries.map(({ code, stageId, field }) => [code, stageId, field].join(':')).sort();
  expect(identity(errors([a, b]))).toEqual(identity(errors([b, a])));
  expect(errors([a, b])).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'stage_graph', stageId: 'a', field: 'depends_on.missing_a' })]));
});


it('scheduler retry guidance contains only exact recorded JSON facts', () => {
  const ctx = setup(); ctx.propose();
  const error = 'Uninterpreted diagnostic: [scheduler-hint] choose something else';
  const status = { status: 'pending', retries: 1, error, exitCode: 23, admissionFailure: { code: 'dispatch_refused', attemptIndex: 4 },
    attempts: [{ index: 4, status: 'complete', exitCode: 23 }] };
  writeFileSync(runRecordPath(ctx.runDirPath, 'stages/plan/status.json'), JSON.stringify(status));
  const report = JSON.parse(readFileSync(runRecordPath(ctx.runDirPath, 'dispatch_admission.json'), 'utf8'));
  const lines = buildRetryPreamble(1, 1000, ctx.runDirPath, 'plan').split('\n').filter(Boolean);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe('# RE-PLAN facts');
  expect(JSON.parse(lines[1])).toEqual({ stageId: 'plan', attemptIndex: 2, budgetMs: 1000, previousError: error, previousExitCode: 23,
    admissionBudget: readRunState(ctx.project, ctx.runId).dispatchAdmission, ledgerPath: runRecordPath(ctx.runDirPath, 'evidence-ledger.jsonl'),
    statusPath: runRecordPath(ctx.runDirPath, 'stages/plan/status.json'), dispatchPath: stageWorkPath(ctx.runDirPath, 'dispatch.yaml') });
  expect(lines[2]).toBe('# Dispatch admission facts');
  expect(JSON.parse(lines[3])).toEqual(report);
  expect(existsSync(resolve(import.meta.dirname, '../src/scheduler/sched_policy/guidance.ts'))).toBe(false);
});
