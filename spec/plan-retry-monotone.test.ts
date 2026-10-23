import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMonotonePlanRetryContext, planRetryRequirement, preparePlanRetryCandidate, readMonotonePlanRetryState, recordPlanRetryAdmission, recordPlanRetryRefusal } from '../src/plan-retry-monotone.js';
import { buildRetryPreamble, inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';

import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { createRun } from './test-support/create-run.js';
import { admitPlannerDispatches } from '../src/scheduler/sched_loop/planner-dispatch.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, writeStageStatus } from '../src/store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), 'fc-plan-retry-')); roots.push(root); return root; }
const requirement = planRetryRequirement({ code: 'stage_scope', stageId: 'work', field: 'scope', message: 'work.scope: refused' });
function pair(root: string, scope: string, attemptIndex: number, checks?: string) {
  const dispatch = stringify({ stages: [{ id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: [scope], artifact_contract: { version: 1, produces: [], reads: [] } }] });
  writeFileSync(join(root, 'dispatch.yaml'), dispatch);
  if (checks !== undefined) writeFileSync(join(root, 'reality_checks.md'), checks);
  return preparePlanRetryCandidate({ runDirPath: root, stageId: 'plan', iteration: 1, attemptIndex });
}
function refuse(root: string, scope: string, index: number, maxAttempts = 3, detail = requirement) {
  return recordPlanRetryRefusal({ runDirPath: root, prepared: pair(root, scope, index), maxAttempts, unsatisfied: [detail] });
}

describe('complete proposal retries', () => {
  it('examines a full replacement independently instead of locking unrelated fields or check bytes', () => {
    const root = directory();
    refuse(root, 'docs/old.md', 1);
    const checks = '## Reality checks\n```yaml\nchecks: []\n```\n';
    const candidate = pair(root, 'docs/new.md', 2, checks);
    expect(candidate.effective).toEqual(candidate.proposed);
    expect(readFileSync(join(root, 'dispatch.yaml'), 'utf8')).toBe(candidate.proposed.dispatch);
    expect(readFileSync(join(root, 'reality_checks.md'), 'utf8')).toBe(checks);
    const stage = parseDispatchedStageConfig({ id: 'replacement', role: 'coder', scope: [], depends_on: [], dependency_reasons: {}, artifact_contract: { version: 1, produces: [], reads: [] } });
    expect(inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
    recordPlanRetryAdmission({ runDirPath: root, prepared: candidate });
    expect(readMonotonePlanRetryState(root)?.terminal?.disposition).toBe('admitted');
  });

  it('keeps the first call ceiling after restart even when a later caller requests more attempts', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1, 2);
    const resumed = pair(root, 'docs/b.md', 1);
    expect(resumed.attemptIndex).toBe(2);
    const result = recordPlanRetryRefusal({ runDirPath: root, prepared: resumed, maxAttempts: 99, unsatisfied: [requirement] });
    expect(result.state.maxAttempts).toBe(2);
    expect(result.state.terminal?.disposition).toBe('attempts_exhausted');
  });

  it('records new failures directly instead of quarantining a changed complete candidate', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1);
    const second = pair(root, 'docs/b.md', 2);
    const different = planRetryRequirement('work.role: unknown');
    const result = recordPlanRetryRefusal({ runDirPath: root, prepared: second, maxAttempts: 3, unsatisfied: [different] });
    expect(result.state.unsatisfied).toEqual([different]);
    expect(result.disposition).toBe('incumbent_advanced');
    expect(buildMonotonePlanRetryContext(root, 'plan')).toContain('complete replacement');
  });

  it('still refuses corrupted retained evidence without materializing it over a replacement', () => {
    const root = directory();
    const result = refuse(root, 'docs/a.md', 1);
    writeFileSync(join(root, result.state.incumbent.dispatchPath), 'tampered');
    expect(() => pair(root, 'docs/b.md', 2)).toThrow('incumbent dispatch digest mismatch');
    expect(readFileSync(join(root, 'dispatch.yaml'), 'utf8')).toContain('docs/b.md');
  });

  it('reports the actual exhausting candidate requirements rather than a previous refusal', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1, 2);
    const latest = planRetryRequirement('replacement.role: unknown');
    const result = refuse(root, 'docs/b.md', 2, 2, latest);
    expect(result.state.unsatisfied).toEqual([latest]);
    expect(result.state.attempts).toHaveLength(2);
    expect(result.reason).toContain(latest.detail);
    expect(result.reason).not.toContain(requirement.detail);
    expect(() => recordPlanRetryRefusal({ runDirPath: root, prepared: pair(directory(), 'docs/x.md', 1), maxAttempts: 0, unsatisfied: [] })).toThrow('positive safe integer');
  });
});

describe('structured planner refusal identity', () => {
  it('uses code, stage and field regardless of diagnostics or embedded engine-like prose', () => {
    const error = { code: 'stage_scope', stageId: 'writer', field: 'scope', message: 'work.role: unknown role 42' };
    const first = planRetryRequirement(error);
    expect(first.id).toBe('stage_scope:writer:scope');
    expect(planRetryRequirement({ ...error, message: '此字段需要修改：99' }).id).toBe(first.id);
    expect(planRetryRequirement({ ...error, field: 'role' }).id).not.toBe(first.id);
    expect(planRetryRequirement({ ...error, stageId: 'reviewer' }).id).not.toBe(first.id);
    expect(planRetryRequirement({ ...error, code: 'different_rule' }).id).not.toBe(first.id);
  });
});


it('resumes planner refusal from the persisted ceiling and replans with a concrete field once', () => {
  const root = directory();
  const project = join(root, 'project'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  try {
    setEngineDefaults({ plan_stage_retries: 1 });
    const plan = parseDispatchedStageConfig({ id: 'plan', role: 'planner', dynamic_dispatch: true, scope: [] });
    const { runId, runDirPath } = createRun(project, 'fixture', stringify({ name: 'fixture', stages: [plan] }), ['plan']);
    const roles = new Map([['qa', { name: 'qa', description: 'Review' }]]);
    writeFileSync(join(runDirPath, 'dispatch.yaml'), stringify({ stages: [{ id: 'review', role: 'qa', is_gate: true, scope: [] }] }));
    const state = { ...readRunState(project, runId), currentIteration: 1 };
    state.stages.plan = { status: 'complete', retries: 0 };
    writeStageStatus(project, runId, 'plan', state.stages.plan);
    const first = admitPlannerDispatches([plan], state, project, runId, runDirPath, roles, new Set());
    expect(first.kind).toBe('continue');
    expect(first.state.stages.plan).toMatchObject({ status: 'pending', retries: 1 });
    expect(buildMonotonePlanRetryContext(runDirPath, 'plan')).toContain('stage_retry_to:review:retry_to');
    // A restarted scheduler has new in-memory collections and changed defaults.
    // Its next refusal still consumes the second and final recorded call.
    setEngineDefaults({ plan_stage_retries: 99 });
    const resumed = readRunState(project, runId);
    resumed.stages.plan = { ...resumed.stages.plan, status: 'complete' };
    writeStageStatus(project, runId, 'plan', resumed.stages.plan);
    const second = admitPlannerDispatches([plan], resumed, project, runId, runDirPath, roles, new Set());
    expect(second.kind).toBe('settled');
    expect(second.state.status).toBe('failed');
    const retry = readMonotonePlanRetryState(runDirPath)!;
    expect(retry.maxAttempts).toBe(2);
    expect(retry.attempts.map(attempt => attempt.attemptIndex)).toEqual([1, 2]);
    expect(retry.terminal?.disposition).toBe('attempts_exhausted');
  } finally { setFcGlobalDir(previous); }
});

it.each(['attempt_timeout', 'exit'])('uses ordinary guidance after a %s inside an admission refusal chain', cause => {
  const root = directory();
  refuse(root, 'docs/a.md', 1);
  mkdirSync(join(root, 'stages', 'plan'), { recursive: true });
  const statusPath = join(root, 'stages', 'plan', 'status.json');
  const status = { status: 'pending', retries: 1, error: 'proposal refused',
    admissionFailure: { code: 'dispatch_refused', attemptIndex: 1 },
    attempts: [{ index: 1, status: 'complete', error: undefined as string | undefined }] };
  writeFileSync(statusPath, JSON.stringify(status));
  expect(buildRetryPreamble(1, 1000, root, 'plan')).toContain('RE-PLAN');
  status.error = cause === 'attempt_timeout' ? 'attempt timed out' : 'adapter crashed';
  status.attempts.push({ index: 2, status: 'failed', error: status.error });
  writeFileSync(statusPath, JSON.stringify(status));
  const prompt = buildRetryPreamble(2, 2000, root, 'plan', cause === 'attempt_timeout'
    ? { previousBudgetMs: 1000, nextBudgetMs: 2000 } : undefined);
  expect(prompt).toContain('RETRY');
  expect(prompt).not.toContain('dispatch admission rejected');
  expect(prompt).toContain(cause === 'attempt_timeout' ? 'strictly larger immutable budget' : 'adapter crashed');
});

it('keeps admission identities when unrelated stages, dependencies and artifact errors reorder', () => {
  const stage = (id: string, dependency: string) => parseDispatchedStageConfig({ id, role: 'coder',
    depends_on: [dependency, `${dependency}_extra`],
    dependency_reasons: { [dependency]: 'required input', [`${dependency}_extra`]: 'other input' }, scope: [],
    artifact_contract: { version: 1, produces: [], reads: [
      { id: 'input', root: 'run', path: `${id}.md`, source: { kind: 'stage', stage: dependency, artifact: 'out' } },
      { id: 'other', root: 'run', path: `${id}-other.md`, source: { kind: 'stage', stage: dependency, artifact: 'other' } },
    ] } });
  const a = stage('a', 'missing_a'), b = stage('b', 'missing_b');
  const errors = (stages: typeof a[]) => inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).errors;
  const first = errors([a, b]);
  a.artifact_contract!.reads.reverse();
  a.depends_on.reverse();
  const second = errors([b, a]);
  const identities = (entries: typeof first) => entries.map(error => planRetryRequirement(error).id).sort();
  expect(identities(second)).toEqual(identities(first));
  expect(new Set(identities(first)).size).toBe(first.length);
  expect(first.filter(error => error.code === 'stage_graph')).toEqual(expect.arrayContaining([
    expect.objectContaining({ stageId: 'a', field: 'depends_on.missing_a' }),
    expect.objectContaining({ stageId: 'b', field: 'depends_on.missing_b' }),
  ]));
  expect(first.every(error => error.stageId && !/\.\d+(?:\.|$)/.test(error.field!))).toBe(true);
});
