import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, previousStore: string;
const contract = ArtifactContractSchema.parse({ version: 1, produces: [{
  id: 'build', root: 'run', path: 'stages/author/build', kind: 'directory',
}], reads: [] });
const stage = { id: 'author', depends_on: [], artifact_contract: contract };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-resume-continuation-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

const role = { name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'low', tools: [], prompt: 'fixture' };
function workerOptions(created: ReturnType<typeof createRun>, artifactContract = contract) {
  return { stageId: stage.id, role, dependsOn: [], promptTemplate: 'Build in private scratch.',
    timeout_ms: 60000, projectDir: project, runId: created.runId, runDir: created.runDirPath,
    retries: 0, artifactContract };
}

it.each(['file', 'directory'] as const)('refuses an escaping %s output root before starting stage code', async kind => {
  const output = { id: 'report', root: 'run' as const, path: 'report', kind, nonempty: true };
  const created = createRun(project, 'scratch-output', 'name: scratch-output', [stage.id]);
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'file'), 'Outside output.\n');
  symlinkSync(kind === 'directory' ? outside : join(outside, 'file'), join(created.runDirPath, output.path));
  let called = false;
  await expect(runStage({ async run() {
    called = true;
    return { output: 'Must not start.', exitCode: 0, duration_ms: 1 };
  } }, workerOptions(created, ArtifactContractSchema.parse({ version: 1, produces: [contract.produces[0], output], reads: [] }))))
    .rejects.toThrow('ARTIFACT_PATH_ESCAPE: run:report');
  expect(called).toBe(false);
});

it.each((['failed', 'incomplete', 'cancelled'] as const).flatMap(status =>
  (['pending', 'skipped'] as const).map(successor => ({ status, successor }))))(
  'continues a $status run from failed stages with its admitted work and budget ($successor successor)', async ({ status, successor }) => {
    const roles = join(project, 'config/agents'); mkdirSync(roles, { recursive: true });
    writeFileSync(join(roles, 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const done = { id: 'done', role: 'coder', depends_on: [], dynamic_dispatch: true, scope: [], prompt_template: 'Earlier work.',
      artifact_contract: { version: 1, produces: [], reads: [] } };
    const later = { id: 'later', role: 'coder', depends_on: [stage.id], scope: [], prompt_template: 'Finish work.',
      artifact_contract: { version: 1, produces: [], reads: [] } };
    const workflow = WorkflowConfigSchema.parse({ name: 'failed-stage-resume', defaults: { max_iterations: 3, max_retries: 0 },
      stages: [done, { ...stage, role: 'coder', depends_on: ['done'], scope: ['docs/**'], prompt_template: 'Continue work.' }, later] });
    normalizeStageContracts(workflow.stages);
    const created = createRun(project, workflow.name, stringify(workflow), ['done', stage.id, 'later']);
    updateRunState(project, created.runId, state => {
      state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 0;
      recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Fixture admitted before execution.');
    });
    beginStageAttempt(project, created.runId, 'done', 0);
    completeStageAttempt(project, created.runId, 'done', 0, { exitCode: 0, duration_ms: 1 });
    beginStageAttempt(project, created.runId, stage.id, 0);
    completeStageAttempt(project, created.runId, stage.id, 0, { exitCode: 0, duration_ms: 1, disposition: 'superseded',
      tokens_in: 7, tokens_out: 2, tokenUsage: 'known', invocations: [{ startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), exitCode: 0, source: 'native_stdout', tokens_in: 7, tokens_out: 2 }] });
    const build = join(created.runDirPath, contract.produces[0].path); mkdirSync(build);
    writeFileSync(join(build, 'prior.txt'), 'Retained build.\n');
    const reason = 'Fixture stage failure';
    beginStageAttempt(project, created.runId, stage.id, 1);
    completeStageAttempt(project, created.runId, stage.id, 1, {
      exitCode: 1, duration_ms: 0, error: reason,
      writes: ['docs/report.md'], writeAttribution: 'structured', disposition: 'discarded',
    });
    updateRunState(project, created.runId, state => {
      state.status = status; state.currentIteration = 2;
      state.completedAt = new Date().toISOString(); state.failureReason = reason;
      state.stages.later.status = successor;
    });
    const earlier = readStageStatus(project, created.runId, 'done');
    const failedAttempts = readStageStatus(project, created.runId, stage.id).attempts!;
    const before = readRunState(project, created.runId);
    const workflowBefore = readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf8');
    const signal = join(created.runDirPath, 'signals/operator-note.txt');
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true }); writeFileSync(signal, 'Retain operator context.\n');
    const changedWorkflow = WorkflowConfigSchema.parse({ name: 'changed-project-workflow', defaults: { max_iterations: 9, max_retries: 7 },
      stages: [{ ...later, id: 'replacement', depends_on: [] }] });
    const calls: string[] = [], iterations: number[] = [];
    const resumed = await runWorkflow(changedWorkflow, stringify(changedWorkflow), project, { async run(_prompt, _agent, opts) {
      calls.push(opts.stageId);
      iterations.push(readRunState(project, created.runId).currentIteration!);
      if (opts.stageId === stage.id) {
        expect(readFileSync(join(build, 'prior.txt'), 'utf8')).toBe('Retained build.\n');
        writeFileSync(join(build, 'result.txt'), 'Resumed build.\n');
      }
      return fixtureResult({ output: 'Continued at the failed stage.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
    } }, new Map(), undefined, roles, created.runId);
    expect(resumed.status, resumed.failureReason).toBe('complete');
    expect(calls).toEqual([stage.id, 'later']);
    expect(iterations).toEqual([2, 2]);
    expect(readStageStatus(project, created.runId, 'done')).toEqual(earlier);
    expect(resumed).toMatchObject({ currentIteration: 2, maxIterations: 3, maxRetries: 0, startedAt: before.startedAt });
    expect(resumed.planControl).toEqual(before.planControl);
    expect(resumed.queryState?.planRevision).toEqual(before.queryState?.planRevision);
    expect(readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf8')).toBe(workflowBefore);
    expect(readFileSync(signal, 'utf8')).toBe('Retain operator context.\n');
    const attempts = readStageStatus(project, created.runId, stage.id).attempts!;
    const history = (entries: typeof attempts) => entries.map(({ index, startedAt, completedAt, status, exitCode, duration_ms, disposition, error,
      tokens_in, tokens_out, tokens_cached, tokens_reasoning, tokenUsage, invocations, providerFailure, adapterFailureKind }) =>
      ({ index, startedAt, completedAt, status, exitCode, duration_ms, disposition, error,
        tokens_in, tokens_out, tokens_cached, tokens_reasoning, tokenUsage, invocations, providerFailure, adapterFailureKind }));
    expect(history(attempts.slice(0, -1))).toEqual(history(failedAttempts));
    for (const earlierAttempt of failedAttempts) if (earlierAttempt.writeAttribution === 'structured') {
      expect(attempts.find(attempt => attempt.index === earlierAttempt.index)?.writes).toEqual(earlierAttempt.writes);
    }
    expect(attempts.at(-1)).toMatchObject({ index: 3, status: 'complete', exitCode: 0 });
    expect(readStageStatus(project, created.runId, 'later').attempts).toHaveLength(1);
  },
);

it.each(['current', 'legacy settlement', 'accepted gate', 'unrecorded round', 'earlier'] as const)('continues an admitted repair from the %s iteration without repeating completed companions or granting another gate round', async admission => {
  const resumingRepair = admission !== 'earlier';
  const repairRound = admission === 'unrecorded round' ? 2 : 1;
  const settlementFailure = admission === 'legacy settlement' || admission === 'accepted gate';
  const roles = join(project, 'config/agents'); mkdirSync(roles, { recursive: true });
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
  const workflow = WorkflowConfigSchema.parse({ name: 'repair-continuation', defaults: { max_iterations: 3, max_retries: repairRound }, stages: [
    { id: 'plan', role: 'coder', depends_on: [], dynamic_dispatch: true, scope: [],
      artifact_contract: { version: 1, produces: [], reads: [] } },
    { id: 'review', role: 'coder', depends_on: ['plan'], is_gate: true, scope: [],
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json', kind: 'file' }], reads: [] } },
    { ...stage, role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [], prompt_template: 'Continue repair.' },
    { id: 'companion', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [],
      artifact_contract: { version: 1, produces: [], reads: [] } },
  ] });
  normalizeStageContracts(workflow.stages);
  const created = createRun(project, workflow.name, stringify(workflow), ['plan', 'review', stage.id, 'companion']);
  mkdirSync(join(created.runDirPath, contract.produces[0].path), { recursive: true });
  writeFileSync(join(created.runDirPath, contract.produces[0].path, 'result.txt'), 'Earlier repair build.\n');
  updateRunState(project, created.runId, state => {
    state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = repairRound;
    state.gateRetryRound = { iteration: 2, round: repairRound };
    recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Admitted repair fixture.');
  });
  for (const id of ['plan', 'review']) {
    beginStageAttempt(project, created.runId, id, 0, undefined, { role: 'coder', iteration: 2 });
    completeStageAttempt(project, created.runId, id, 0, { exitCode: 0, duration_ms: 1 });
  }
  writeFileSync(join(created.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: !resumingRepair || admission === 'accepted gate', reason: resumingRepair ? 'Repair remains admitted.' : 'Earlier verification remains valid.' }));
  beginStageAttempt(project, created.runId, stage.id, 0, undefined, { role: 'coder',
    ...(admission === 'legacy settlement' ? {} : { iteration: admission === 'earlier' ? 1 : 2 }) });
  completeStageAttempt(project, created.runId, stage.id, 0, {
    exitCode: resumingRepair && !settlementFailure ? 1 : 0, duration_ms: 1,
    error: resumingRepair && !settlementFailure ? 'Repair settlement failed.' : undefined, writes: [], writeAttribution: 'structured',
    ...(settlementFailure ? { disposition: 'discarded' as const } : {}),
  });
  if (settlementFailure) writeStageStatus(project, created.runId, stage.id,
    { ...readStageStatus(project, created.runId, stage.id), status: 'failed', error: 'Repair settlement failed.' });
  beginStageAttempt(project, created.runId, 'companion', 0, undefined, { role: 'coder', iteration: 2 });
  completeStageAttempt(project, created.runId, 'companion', 0, { exitCode: 0, duration_ms: 1 });
  const consumed = join(created.runDirPath, 'gate_reevaluation/iteration_2/round_1'); mkdirSync(consumed, { recursive: true });
  const consumedEvidence = JSON.stringify({ iteration: 2, round: 1, repairStageIds: [stage.id, 'companion'],
    completedAt: admission === 'unrecorded round'
      ? new Date(Date.parse(readStageStatus(project, created.runId, stage.id).attempts!.at(-1)!.startedAt) - 1).toISOString()
      : new Date().toISOString() });
  writeFileSync(join(consumed, 'repair_diff.json'), consumedEvidence);
  updateRunState(project, created.runId, state => {
    state.status = 'failed'; state.failureReason = 'Fixture continuation required.'; state.completedAt = new Date().toISOString();
    if (admission === 'earlier') state.stages[stage.id].status = 'pending';
  });
  const completed = ['plan', 'review', 'companion'].map(id => readStageStatus(project, created.runId, id));
  const before = readRunState(project, created.runId);
  const calls: string[] = [];
  const resumed = await runWorkflow(workflow, stringify(workflow), project, { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === stage.id) writeFileSync(join(opts.runDir, contract.produces[0].path, 'result.txt'), 'Continued repair build.\n');
    if (opts.stageId === 'review') writeFileSync(join(opts.runDir, 'fixture_verdict_review.json'),
      JSON.stringify({ pass: true, reason: 'Repair independently verified.', audit_findings: { version: 1, findings: [] } }));
    return fixtureResult({ output: 'Repair continued.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } }, new Map(), undefined, roles, created.runId);
  expect(resumed.status, resumed.failureReason).toBe('complete');
  expect(calls).toEqual(resumingRepair ? [stage.id, 'review'] : []);
  expect(readStageStatus(project, created.runId, 'plan')).toEqual(completed[0]);
  const reviewed = readStageStatus(project, created.runId, 'review');
  expect(readStageStatus(project, created.runId, 'companion')).toEqual(completed[2]);
  if (resumingRepair) {
    expect(reviewed.attempts).toHaveLength(2);
    expect(reviewed.attempts?.[0]).toMatchObject({ ...completed[1].attempts![0], disposition: 'superseded' });
  } else expect(reviewed).toEqual(completed[1]);
  expect(resumed).toMatchObject({ currentIteration: 2, maxIterations: 3, maxRetries: repairRound, startedAt: before.startedAt });
  expect(resumed.planControl).toEqual(before.planControl);
  if (resumingRepair) expect(JSON.parse(readFileSync(join(created.runDirPath, `gate_reevaluation/iteration_2/round_${repairRound}/repair_diff.json`), 'utf8')))
    .toMatchObject({ iteration: 2, round: repairRound, repairStageIds: [stage.id] });
  if (!resumingRepair || admission === 'unrecorded round') expect(readFileSync(join(consumed, 'repair_diff.json'), 'utf8')).toBe(consumedEvidence);
  expect(existsSync(join(created.runDirPath, `gate_reevaluation/iteration_2/round_${repairRound + 1}/repair_diff.json`))).toBe(false);
  const repairAttempts = readStageStatus(project, created.runId, stage.id).attempts!;
  expect(repairAttempts[0]).toMatchObject(before.stages[stage.id].attempts![0]);
  expect(repairAttempts.map(attempt => attempt.exitCode)).toEqual(resumingRepair ? [settlementFailure ? 0 : 1, 0] : [0]);
});

it('refuses an output root aliased to its authored project', () => {
  const created = createRun(project, 'alias-escape', 'name: alias-escape\nstages: []\n', [stage.id]);
  symlinkSync(project, join(created.runDirPath, contract.produces[0].path), 'dir');
  const errors = inspectArtifactDeclarations({ stages: [stage], projectDir: project, runDir: created.runDirPath });
  expect(errors.join('\n')).toContain('ARTIFACT_PATH_ESCAPE');
});

it.each(['symlink', 'hardlink'])('refuses an engine-owned run member reached by a %s in the private build', alias => {
  const created = createRun(project, 'alias-carrier', 'name: alias-carrier\nstages: []\n', [stage.id]);
  const build = join(created.runDirPath, contract.produces[0].path); mkdirSync(build);
  const carrier = join(created.runDirPath, 'run.json');
  if (alias === 'symlink') symlinkSync(carrier, join(build, 'carrier.json'));
  else linkSync(carrier, join(build, 'carrier.json'));
  const errors = inspectArtifactDeclarations({ stages: [stage], projectDir: project, runDir: created.runDirPath });
  expect(errors.join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
});
