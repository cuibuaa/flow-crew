import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { deploymentHeld, parkAtDeploymentBoundary, readDeploymentHold, requestDeploymentHold } from '../src/deployment-hold.js';
import { Orchestrator, type SupervisorBackend } from '../src/orchestrator.js';
import { captureEngineCheckpoint, reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, fcGlobalDir, readRunState, readStageStatus, rependStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import type { Adapter } from '../src/adapters/base.js';
import { cmdDaemon } from '../src/cli-daemon.js';
import { writeStageStatus } from '../src/store.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { execFileSync } from 'node:child_process';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import * as deployment from '../src/deployment-hold.js';
import * as store from '../src/store.js';

let root: string, project: string, previous: string, roles: string;
let registry: TaskRegistry, orchestrator: Orchestrator;
let units: SupervisorBackend;
let launches: string[];
const brief = '# Deployment fixture\n\n## Requirements\n1. Retain completed producer work and complete later work under independent verification.\n';
const criterion = extractBriefCriteria(brief).criteria[0].id;
function admitted() {
  return { brief_text: brief, brief_admission: createBriefAdmission(inspectBrief(brief), {
    kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString(),
  }) };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-deployment-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  roles = join(root, 'roles'); mkdirSync(roles);
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\nprompt: Fixture.\ntools: []\n');
  launches = [];
  units = { async isActive() { return { kind: 'terminal', exitCode: 0 }; },
    async runUnit(input) { launches.push(input.command); }, async stopUnit() { throw new Error('Hold must never stop a unit'); }, async journalTail() { return ''; } };
  registry = new TaskRegistry({ baseDir: fcGlobalDir() });
  orchestrator = new Orchestrator({ registry, systemd: units, isProjectBusy: () => null });
});
afterEach(async () => {
  await orchestrator.stop();
  setFcGlobalDir(previous);
  rmSync(root, { recursive: true, force: true });
});

function workflow() {
  const stage = (id: string, deps: string[]) => ({ id, role: 'coder', depends_on: deps, scope: [],
    criterion_refs: [criterion],
    artifact_contract: { version: 1, produces: [{ id: 'artifact', root: 'run', path: `stages/${id}/artifact.txt`, kind: 'file' }], reads: [] } });
  const config = WorkflowConfigSchema.parse({ name: 'deployment-fixture', defaults: { max_iterations: 2, max_retries: 0 }, stages: [
    stage('producer', []), stage('active_a', ['producer']), stage('active_b', ['producer']),
    stage('later', ['active_a', 'active_b']),
    { id: 'review', role: 'coder', is_gate: true, depends_on: ['later'], scope: [], criterion_refs: [criterion],
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json', kind: 'file' }], reads: [] } },
    { ...stage('repair', ['review']), retry_to: ['review'], criterion_refs: [] },
  ] });
  normalizeStageContracts(config.stages);
  return config;
}

function execute(config: ReturnType<typeof workflow>, adapter: Adapter, existingRunId?: string) {
  return runWorkflow(config, stringify(config), project, adapter, new Map(), undefined, roles,
    existingRunId, brief, true, undefined, true, admitted().brief_admission);
}

it.each([false, true])('holds at the current shared-tree owner, preserves completed attempts and budgets, then continues (gate=%s)', async gate => {
  const config = workflow();
  const enteredA = barrier(), enteredB = barrier(), releaseA = barrier(), releaseB = barrier();
  const calls: string[] = [];
  let runId = '';
  const adapter = { async run(_prompt: string, _role: unknown, opts: Parameters<typeof fixtureResult>[1]) {
    calls.push(opts.stageId); runId = JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId;
    if (opts.stageId === 'producer') updateRunState(project, runId, state => { state.maxRetries = 1; });
    if (opts.stageId === 'active_a') { enteredA.resolve(); await releaseA.promise; }
    if (opts.stageId === 'active_b') { enteredB.resolve(); await releaseB.promise; }
    if (opts.stageId === 'review') writeFileSync(join(opts.runDir, 'fixture_verdict_review.json'), JSON.stringify({ pass: !gate, reason: gate ? 'Independent rejection remains binding.' : 'Independently accepted.', criteria: { [criterion]: { status: gate ? 'fail' : 'pass', evidence: 'Completed producer and later work inspected.' } } }));
    else writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), `${opts.stageId} product\n`);
    return fixtureResult({ output: 'Fixture result.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } };
  const running = execute(config, adapter);
  try {
    await Promise.race([enteredA.promise, running.then(state => { throw new Error(`Fixture did not dispatch: ${state.failureReason ?? state.status}`); })]);
    const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: runId });
    const before = readRunState(project, runId);
    const producer = readStageStatus(project, runId, 'producer');
    const first = await orchestrator.holdDeployment();
    expect(first.ready).toBe(false);
    expect((await orchestrator.holdDeployment()).hold).toEqual(first.hold);
    const stdout = new PassThrough(), stderr = new PassThrough();
    let diagnostic = ''; stderr.on('data', chunk => { diagnostic += chunk; });
    expect(await cmdDaemon(['daemon', 'hold', '--timeout-ms', '0'], {
      stdout: stdout as NodeJS.WriteStream, stderr: stderr as NodeJS.WriteStream,
      controls: { sendRpc: async () => orchestrator.holdDeployment() },
    })).toBe(1);
    expect(diagnostic).toContain('HOLD NOT SETTLED');
    expect((await orchestrator.continueDeployment()).released).not.toBe(true);
    expect(deploymentHeld()).toBe(true);
    releaseA.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toEqual(['producer', 'active_a']);
    releaseB.resolve();
    const held = await running;
    const workflowBefore = readFileSync(join(root, 'store/runs', runId, 'workflow.yaml'), 'utf8');
    expect(held.status, held.failureReason).toBe('parked');
    expect(held.deploymentHold?.heldAt).toBeTruthy();
    expect((await orchestrator.deploymentStatus()).ready).toBe(true);
    expect(held.stages[gate ? 'review' : 'later'].attempts).toBeUndefined();
    const queued = await orchestrator.register({ ...admitted(), projectDir: join(root, 'other-project') });
    await orchestrator.tickOnce();
    expect(launches).toEqual([]);
    expect(registry.get(queued.id)?.status).toBe('pending');
    // A new daemon instance reads the same durable fence and queue.
    await orchestrator.stop();
    registry = new TaskRegistry({ baseDir: fcGlobalDir() });
    orchestrator = new Orchestrator({ registry, systemd: units, isProjectBusy: () => null });
    await orchestrator.tickOnce();
    expect(launches).toEqual([]);
    expect(deploymentHeld()).toBe(true);
    await expect(orchestrator.resume(task.id)).rejects.toThrow('Deployment hold');
    const released = await orchestrator.continueDeployment();
    expect(released.errors).toEqual([]);
    expect(released.released).toBe(true);
    await orchestrator.tickOnce();
    expect(registry.get(task.id)?.attempt).toBe(task.attempt);
    expect(registry.get(task.id)?.systemd_unit).not.toBe(task.systemd_unit);
    const changedDefaults = WorkflowConfigSchema.parse({ name: 'changed-build-default', defaults: { max_iterations: 9, max_retries: 9 },
      stages: [{ id: 'replacement', role: 'coder', scope: [], artifact_contract: { version: 1, produces: [], reads: [] } }] });
    const continued = await execute(changedDefaults, adapter, runId);
    expect(continued.status).toBe(gate ? 'incomplete' : 'complete');
    expect(calls).toEqual(['producer', 'active_a', 'active_b', 'later', 'review', ...(gate ? ['repair', 'review'] : [])]);
    expect(readStageStatus(project, runId, 'producer')).toEqual(producer);
    expect(readFileSync(join(root, 'store/runs', runId, 'stages/producer/artifact.txt'), 'utf8')).toBe('producer product\n');
    expect(continued).toMatchObject({ currentIteration: before.currentIteration, maxIterations: before.maxIterations, startedAt: before.startedAt });
    expect(continued.maxRetries).toBe(before.maxRetries);
    expect(continued.engineHistory?.map(entry => entry.kind)).toEqual(['start', 'resume']);
    expect(continued.deploymentHold).toBeUndefined();
    expect(continued.engineHistory?.[0]).toEqual(held.engineHistory?.[0]);
    expect(continued.planControl).toEqual(held.planControl);
    expect(readFileSync(join(root, 'store/runs', runId, 'workflow.yaml'), 'utf8')).toBe(workflowBefore);
    expect(readDeploymentHold()?.releasedAt).toBeTruthy();
  } finally { releaseA.resolve(); releaseB.resolve(); await running; }
});

it.each([undefined, 'Cancelled by user'])('refuses an unsettled stopped ledger without resetting attempts, retries or history (reason=%s)', failureReason => {
  const config = workflow();
  const created = createRun(project, config.name, stringify(config), config.stages.map(s => s.id));
  beginStageAttempt(project, created.runId, 'producer', 1);
  writeStageStatus(project, created.runId, 'producer', { ...readStageStatus(project, created.runId, 'producer'), status: 'failed' });
  updateRunState(project, created.runId, state => { state.status = 'cancelled'; state.failureReason = failureReason; state.currentIteration = 2; state.maxIterations = 2; });
  const before = readStageStatus(project, created.runId, 'producer');
  expect(reconcileHostInterruptedRun(project, created.runId).status).toBe('cancelled');
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('unsettled attempt');
  expect(readStageStatus(project, created.runId, 'producer')).toEqual(before);
  expect(readRunState(project, created.runId)).toMatchObject({ currentIteration: 2, maxIterations: 2 });
});

it('keeps a corrupt global hold fail closed across a fresh control instance', async () => {
  requestDeploymentHold();
  writeFileSync(join(fcGlobalDir(), 'deployment-hold.json'), '{bad');
  await expect(orchestrator.register({ ...admitted(), projectDir: project })).rejects.toThrow();
  expect(launches).toEqual([]);
});

it('does not convert an acknowledged cancellation into a deployment continuation', async () => {
  const config = workflow();
  const created = createRun(project, config.name, stringify(config), config.stages.map(s => s.id));
  const task = registry.create({ ...admitted(), projectDir: project, status: 'pending', run_id: created.runId });
  requestDeploymentHold();
  await orchestrator.cancel(task.id);
  expect(readRunState(project, created.runId).status).toBe('cancelled');
  parkAtDeploymentBoundary(project, created.runId);
  await orchestrator.continueDeployment();
  await orchestrator.tickOnce();
  await orchestrator.stop();
  orchestrator = new Orchestrator({ registry, systemd: units, isProjectBusy: () => null });
  await orchestrator.tickOnce();
  expect(readRunState(project, created.runId).status).toBe('cancelled');
  expect(registry.get(task.id)?.status).toBe('cancelled');
  expect(launches).toEqual([]);
});

it.each([false, true])('explicitly resumes safely settled cancelled work with retained hold metadata (released=%s)', async released => {
  const config = workflow();
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _agent, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') return { output: JSON.stringify({ pass: true, reason: 'Retained work inspected.', criteria: { [criterion]: { status: 'pass', evidence: 'Completed producer and remaining products checked.' } }, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1 };
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed work.\n');
    if (opts.stageId === 'producer') requestDeploymentHold();
    return fixtureResult({ output: 'Completed.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } };
  const held = await execute(config, adapter);
  expect(held.status, held.failureReason).toBe('parked');
  const producer = readStageStatus(project, held.runId, 'producer');
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  if (released) expect((await orchestrator.continueDeployment()).errors).toEqual([]);
  units.stopUnit = async () => {};
  expect((await orchestrator.cancel(task.id)).ok).toBe(true);
  const stopped = readRunState(project, held.runId);
  expect(stopped).toMatchObject({ status: 'cancelled', failureReason: 'Cancelled by user', deploymentHold: { id: held.deploymentHold!.id } });
  if (!released) {
    await expect(orchestrator.resume(task.id)).rejects.toThrow('Deployment hold');
    expect((await orchestrator.continueDeployment()).errors).toEqual([]);
  }
  await orchestrator.tickOnce();
  expect(registry.get(task.id)?.status).toBe('cancelled');
  expect(launches).toEqual([]);
  expect(await orchestrator.resume(task.id)).toMatchObject({ status: 'pending', run_id: held.runId, attempt: task.attempt });
  // Queueing is not scheduler admission and must not mutate stopped history.
  expect(readRunState(project, held.runId)).toEqual(stopped);
  await orchestrator.tickOnce();
  expect(launches).toHaveLength(1);
  const completed = await execute(config, adapter, held.runId);
  expect(completed.status, completed.failureReason).toBe('complete');
  expect(readStageStatus(project, held.runId, 'producer')).toEqual(producer);
  expect(calls).toEqual(['producer', 'active_a', 'active_b', 'later', 'review']);
  expect(completed.engineHistory?.map(entry => entry.kind)).toEqual(['start', 'resume']);
  expect(completed.deploymentHold).toBeUndefined();
  expect(completed).toMatchObject({ currentIteration: held.currentIteration, maxIterations: held.maxIterations, startedAt: held.startedAt });
});

it.each(['checkpoint', 'plan', 'plan_version', 'ledger', 'missing_projection', 'missing_plan_projection', 'missing_projection_and_ledger'] as const)('reports incompatible %s state before publishing resume or a new attempt', async invalid => {
  const config = workflow();
  const held = await execute(config, { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  expect(held.status, held.failureReason).toBe('parked');
  const attempts = readStageStatus(project, held.runId, 'producer');
  updateRunState(project, held.runId, state => {
    if (invalid === 'checkpoint') Object.assign(state.engineCheckpoint!, { version: 99 });
    if (invalid === 'plan') state.planControl!.stages[0].role = 'inconsistent_plan';
    if (invalid === 'plan_version') Object.assign(state.planControl!, { version: 99 });
    if (invalid === 'ledger') delete state.stages.producer.attempts;
    if (invalid === 'missing_projection' || invalid === 'missing_plan_projection' || invalid === 'missing_projection_and_ledger') delete state.stages.producer;
  });
  if (invalid === 'missing_projection_and_ledger') rmSync(join(root, 'store/runs', held.runId, 'stages/producer/status.json'));
  if (invalid === 'missing_plan_projection') {
    // A dynamically admitted stage need not appear in the base workflow.
    const base = WorkflowConfigSchema.parse({ ...config, stages: config.stages.filter(stage => stage.id !== 'producer')
      .map(stage => ({ ...stage, depends_on: stage.depends_on.filter(id => id !== 'producer') })) });
    writeFileSync(join(root, 'store/runs', held.runId, 'workflow.yaml'), stringify(base));
  }
  const result = await orchestrator.continueDeployment();
  expect(result.released).toBe(false);
  expect(result.errors.join('\n'), result.errors.join('\n')).toContain('CONTINUATION_INCOMPATIBLE');
  expect(registry.get(task.id)?.status).toBe('stuck');
  expect(readRunState(project, held.runId)).toMatchObject({ status: 'parked', continuationFailure: { reason: expect.stringContaining('CONTINUATION_INCOMPATIBLE') } });
  if (invalid === 'missing_projection_and_ledger') {
    expect(readRunState(project, held.runId).stages.producer).toBeUndefined();
    expect(() => readStageStatus(project, held.runId, 'producer')).toThrow();
  } else expect(readStageStatus(project, held.runId, 'producer')).toEqual(attempts);
  expect(readRunState(project, held.runId).engineHistory).toEqual(held.engineHistory);
  expect(launches).toEqual([]);
  await expect(execute(config, { async run() { throw new Error('Unsafe work must not run'); } }, held.runId)).rejects.toThrow('CONTINUATION_INCOMPATIBLE');
});

it('retains the hold across a controller interruption and continues once on retry', async () => {
  const held = await execute(workflow(), { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  const interruption = vi.spyOn(deployment, 'releaseDeploymentHold').mockImplementationOnce(() => { throw new Error('Fixture controller lost before latch release'); });
  try { await expect(orchestrator.continueDeployment()).rejects.toThrow('before latch release'); }
  finally { interruption.mockRestore(); }
  expect(deploymentHeld()).toBe(true);
  await orchestrator.tickOnce();
  expect(launches).toEqual([]);
  const queued = registry.get(task.id);
  expect((await orchestrator.continueDeployment()).released).toBe(true);
  expect(registry.get(task.id)).toEqual(queued);
});

it('keeps compatible peers held until every current-hold run is compatible', async () => {
  const config = workflow();
  const held = await execute(config, { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const compatible = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  const invalid = createRun(project, config.name, stringify(config), []);
  updateRunState(project, invalid.runId, state => {
    state.status = 'parked';
    state.taskDescription = brief;
    state.briefAdmission = admitted().brief_admission;
    state.deploymentHold = held.deploymentHold;
    state.engineCheckpoint = { ...held.engineCheckpoint!, version: 99 } as unknown as typeof state.engineCheckpoint;
  });
  writeFileSync(join(invalid.runDirPath, 'task_brief.md'), brief);
  registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: invalid.runId });
  const result = await orchestrator.continueDeployment();
  expect(result.errors.join('\n'), JSON.stringify(result)).toContain('CONTINUATION_INCOMPATIBLE');
  expect(result.released).toBe(false);
  expect(deploymentHeld()).toBe(true);
  expect(registry.get(compatible.id)?.status).toBe('running');
  expect(Boolean(readRunState(project, held.runId).deploymentHold?.releasedAt)).toBe(false);
  await orchestrator.tickOnce();
  expect(launches).toEqual([]);
  expect(readRunState(project, invalid.runId).deploymentHold?.releasedAt).toBeUndefined();
  expect(readRunState(project, invalid.runId).continuationFailure).toBeDefined();
});

it.each(['repair', 'cancel'] as const)('can continue after resolving a refused held run by %s', async resolution => {
  const held = await execute(workflow(), { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  updateRunState(project, held.runId, state => { Object.assign(state.engineCheckpoint!, { version: 99 }); });
  expect((await orchestrator.continueDeployment()).released).toBe(false);
  expect(registry.get(task.id)?.status).toBe('stuck');
  expect(deploymentHeld()).toBe(true);
  if (resolution === 'repair') {
    updateRunState(project, held.runId, state => { state.engineCheckpoint = held.engineCheckpoint; });
    const write = vi.spyOn(registry, 'update').mockImplementationOnce(() => { throw new Error('Fixture queue write failed'); });
    try { await expect(orchestrator.continueDeployment()).rejects.toThrow('Fixture queue write failed'); }
    finally { write.mockRestore(); }
    expect(deploymentHeld()).toBe(true);
    expect(readRunState(project, held.runId).deploymentHold?.releasedAt).toBeUndefined();
    expect(readRunState(project, held.runId).continuationFailure).toBeDefined();
  } else expect((await orchestrator.cancel(task.id)).ok).toBe(true);
  expect((await orchestrator.continueDeployment()).released).toBe(true);
  expect(deploymentHeld()).toBe(false);
  expect(registry.get(task.id)).toMatchObject({ status: resolution === 'repair' ? 'pending' : 'stuck', attempt: task.attempt });
  if (resolution === 'repair') expect(readRunState(project, held.runId).continuationFailure).toBeUndefined();
  else expect(readRunState(project, held.runId).status).toBe('cancelled');
  expect(launches).toEqual([]);
});

async function registeredHeldRun() {
  const held = await execute(workflow(), { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  return { held, task };
}

it('revalidates a repaired stuck task before releasing its hold', async () => {
  const { held, task } = await registeredHeldRun();
  updateRunState(project, held.runId, state => { Object.assign(state.engineCheckpoint!, { version: 99 }); });
  expect((await orchestrator.continueDeployment()).released).toBe(false);
  updateRunState(project, held.runId, state => { state.engineCheckpoint = held.engineCheckpoint; });
  expect(await orchestrator.continueDeployment()).toMatchObject({ released: true, ready: true, errors: [] });
  expect(registry.get(task.id)?.status).toBe('pending');
  expect(readRunState(project, held.runId).continuationFailure).toBeUndefined();
});

it('clears a prior refusal after compatibility is proved', async () => {
  const { held, task } = await registeredHeldRun();
  updateRunState(project, held.runId, state => {
    state.continuationFailure = { at: new Date().toISOString(), reason: 'Prior refusal', generation: 'a'.repeat(64) };
  });
  expect(await orchestrator.continueDeployment()).toMatchObject({ released: true, ready: true, errors: [] });
  expect(registry.get(task.id)?.status).toBe('pending');
  expect(readRunState(project, held.runId).continuationFailure).toBeUndefined();
});

it('retains the global hold if a run changes during continuation', async () => {
  const { held, task } = await registeredHeldRun();
  const update = store.updateRunState;
  const race = vi.spyOn(store, 'updateRunState').mockImplementationOnce((projectDir, runId, mutate) =>
    update(projectDir, runId, current => { current.status = 'cancelled'; mutate(current); }));
  try { await expect(orchestrator.continueDeployment()).rejects.toThrow(`Held run ${held.runId} changed during continuation; hold remains active`); }
  finally { race.mockRestore(); }
  expect(deploymentHeld()).toBe(true);
  expect(registry.get(task.id)?.status).toBe('pending');
  expect(readRunState(project, held.runId).deploymentHold?.releasedAt).toBeUndefined();
});

it('queues a continuation before releasing its run latch', async () => {
  const { held } = await registeredHeldRun();
  const original = registry.update.bind(registry);
  const order = vi.spyOn(registry, 'update').mockImplementationOnce((id, patch) => {
    expect(readRunState(project, held.runId).deploymentHold?.releasedAt).toBeUndefined();
    expect(deploymentHeld()).toBe(true);
    return original(id, patch);
  });
  try { expect((await orchestrator.continueDeployment()).released).toBe(true); expect(order).toHaveBeenCalledOnce(); }
  finally { order.mockRestore(); }
});

it.each([false, true])('leaves settled cancelling tasks to cancellation (invalid=%s)', async invalid => {
  const { held, task } = await registeredHeldRun();
  registry.update(task.id, { status: 'cancelling' });
  if (invalid) updateRunState(project, held.runId, state => { Object.assign(state.engineCheckpoint!, { version: 99 }); });
  expect(await orchestrator.continueDeployment()).toMatchObject({ released: true, errors: [] });
  expect(readRunState(project, held.runId).deploymentHold?.releasedAt).toBeUndefined();
  expect(registry.get(task.id)?.status).toBe('cancelling');
});

it('keeps a same-hold refusal visible after the run stops', async () => {
  const { held, task } = await registeredHeldRun();
  updateRunState(project, held.runId, state => {
    state.status = 'cancelled';
    state.continuationFailure = { at: new Date().toISOString(), reason: 'Prior refusal', generation: 'a'.repeat(64) };
  });
  const status = await orchestrator.deploymentStatus();
  expect(status.errors).toEqual([`Task ${task.id}: Prior refusal`]);
  expect(status.tasks).toContainEqual(expect.objectContaining({ id: task.id, runId: held.runId, status: 'cancelled', settled: true }));
  expect(await orchestrator.continueDeployment()).toMatchObject({ released: true, ready: true, errors: [] });
});

it('accepts a different supported generation and makes repeated continue idempotent', async () => {
  const config = workflow();
  const held = await execute(config, { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  updateRunState(project, held.runId, state => { state.engineCheckpoint!.generation = 'a'.repeat(64); });
  expect(assertContinuationCompatible(project, held.runId).status, held.failureReason).toBe('parked');
  expect((await orchestrator.continueDeployment()).errors).toEqual([]);
  const queued = registry.get(task.id);
  expect((await orchestrator.continueDeployment()).released).toBe(true);
  expect(registry.get(task.id)).toEqual(queued);
  expect(launches).toEqual([]);
});

it('accepts normal iteration repending with the retained completed attempt ledger', async () => {
  const held = await execute(workflow(), { async run(_prompt, _agent, opts) {
    requestDeploymentHold();
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed producer.\n');
    return fixtureResult({ output: 'Producer complete.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } });
  const ledger = readStageStatus(project, held.runId, 'producer');
  updateRunState(project, held.runId, state => { state.stages.producer = rependStageStatus(state.stages.producer); });
  const compatible = assertContinuationCompatible(project, held.runId);
  expect(compatible.stages.producer).toMatchObject({ status: 'pending', retries: ledger.retries, attempts: ledger.attempts });
  expect(readStageStatus(project, held.runId, 'producer')).toEqual(ledger);
  expect(compatible.engineHistory).toEqual(held.engineHistory);
});

it('continues an attemptless legacy preparation without inventing completed history', async () => {
  const config = workflow();
  const prepared = createRun(project, config.name, stringify(config), []);
  updateRunState(project, prepared.runId, state => { state.status = 'failed'; });
  expect(assertContinuationCompatible(project, prepared.runId).stages).toEqual({});
  const calls: string[] = [];
  const result = await execute(config, { async run(_prompt, _agent, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') return { output: JSON.stringify({ pass: true, reason: 'Prepared work completed.', criteria: { [criterion]: { status: 'pass', evidence: 'Every required artifact was produced once.' } }, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1 };
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'First execution.\n');
    return fixtureResult({ output: 'Completed.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } }, prepared.runId);
  expect(result.status, result.failureReason).toBe('complete');
  expect(calls).toEqual(['producer', 'active_a', 'active_b', 'later', 'review']);
  expect(result.stages.producer.attempts).toHaveLength(1);
});

it('retains completed uncommitted project work across a deployment hold and scheduler replacement', async () => {
  writeFileSync(join(project, 'product.txt'), 'Original tracked product.\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', "import { execFileSync } from 'node:child_process'; execFileSync('git', ['init', '-q']); execFileSync('git', ['add', 'product.txt']);"], {
    cwd: project, env: { ...process.env, HOME: project, FC_HOME: project }, timeout: 10_000,
  });
  const config = workflow();
  config.defaults.max_iterations = 1;
  config.stages = [config.stages[0], { ...config.stages[3], depends_on: ['producer'] }, config.stages[4], config.stages[5]];
  config.stages[0].scope = ['product.txt'];
  config.stages[1].scope = ['product.txt'];
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') return { output: JSON.stringify({ pass: true, reason: 'Completed product retained.', criteria: { [criterion]: { status: 'pass', evidence: 'product.txt contains the completed producer bytes.' } }, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1 };
    if (opts.stageId === 'producer') writeFileSync(join(project, 'product.txt'), 'Completed product.\n');
    else {
      expect(readFileSync(join(project, 'product.txt'), 'utf8')).toBe('Completed product.\n');
    }
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Stage evidence.\n');
    if (opts.stageId === 'producer') requestDeploymentHold();
    return fixtureResult({ output: 'Fixture result.', exitCode: 0, duration_ms: 1, writes: ['product.txt'], writeAttribution: 'structured' }, opts);
  } };
  const held = await execute(config, adapter);
  expect(held.status, held.failureReason).toBe('parked');
  const producer = readStageStatus(project, held.runId, 'producer');
  registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: held.runId });
  expect((await orchestrator.continueDeployment()).errors).toEqual([]);
  const settled = await execute(config, adapter, held.runId);
  expect(settled.status, settled.failureReason).toBe('complete');
  expect(readFileSync(join(project, 'product.txt'), 'utf8')).toBe('Completed product.\n');
  expect(readStageStatus(project, held.runId, 'producer')).toEqual(producer);
  expect(calls).toEqual(['producer', 'later', 'review']);
});

it.each([2, 99])('settles a lost scheduler through existing recovery under a hold (checkpoint version %s)', async version => {
  const config = workflow();
  const created = createRun(project, config.name, stringify(config), config.stages.map(stage => stage.id));
  updateRunState(project, created.runId, state => {
    state.taskDescription = brief; state.briefAdmission = admitted().brief_admission;
    state.currentIteration = 1; state.maxIterations = 2; state.maxRetries = 1;
    recordAdmittedPlan(state, config.stages, created.runDirPath, 'Admitted recovery fixture.');
    state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: 999_999_999, processStart: undefined };
    Object.assign(state.engineCheckpoint, { version });
  });
  beginStageAttempt(project, created.runId, 'producer', 0);
  completeStageAttempt(project, created.runId, 'producer', 0, { exitCode: 0, duration_ms: 1 });
  const completed = readStageStatus(project, created.runId, 'producer');
  const task = registry.create({ ...admitted(), projectDir: project, status: 'running', run_id: created.runId, attempt: 1, max_retries: 1 });
  units.isActive = async unit => unit === task.systemd_unit ? { kind: 'terminal', exitCode: 0 } : { kind: 'active' };
  requestDeploymentHold();
  await orchestrator.tickOnce();
  expect(readStageStatus(project, created.runId, 'producer')).toEqual(completed);
  if (version === 99) {
    expect(registry.get(task.id)).toMatchObject({ status: 'stuck', attempt: 1, notes: expect.stringContaining('CONTINUATION_INCOMPATIBLE') });
    expect(readRunState(project, created.runId).continuationFailure?.reason).toContain('RECOVERY_RUN_BINDING');
    expect(launches).toEqual([]);
    return;
  }
  expect(readRunState(project, created.runId)).toMatchObject({ status: 'parked', recovery: { kind: 'resumable' }, deploymentHold: { id: readDeploymentHold()!.id } });
  expect(registry.get(task.id)).toMatchObject({ status: 'deferred', attempt: 1, defer_kind: 'wait' });
  expect((await orchestrator.continueDeployment()).errors).toEqual([]);
  await orchestrator.tickOnce();
  expect(registry.get(task.id), registry.get(task.id)?.notes).toMatchObject({ status: 'running', attempt: 1 });
  expect(registry.get(task.id)?.systemd_unit).not.toBe(task.systemd_unit);
  expect(readStageStatus(project, created.runId, 'producer')).toEqual(completed);
});

it('can explicitly continue an unregistered foreground run after releasing the store fence', async () => {
  const config = workflow();
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _agent, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') return { output: JSON.stringify({ pass: true, reason: 'Retained producer inspected.', criteria: { [criterion]: { status: 'pass', evidence: 'All completed fixture artifacts retained.' } }, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1 };
    writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'artifact.txt'), 'Completed work.\n');
    if (opts.stageId === 'producer') requestDeploymentHold();
    return fixtureResult({ output: 'Completed.', exitCode: 0, duration_ms: 1, writes: [] }, opts);
  } };
  const held = await execute(config, adapter);
  const producer = readStageStatus(project, held.runId, 'producer');
  await expect(execute(config, adapter, held.runId)).rejects.toThrow('Deployment hold is active');
  expect(readRunState(project, held.runId).continuationFailure).toBeUndefined();
  expect((await orchestrator.continueDeployment()).released).toBe(true);
  const completed = await execute(config, adapter, held.runId);
  expect(completed.status, completed.failureReason).toBe('complete');
  expect(calls).toEqual(['producer', 'active_a', 'active_b', 'later', 'review']);
  expect(readStageStatus(project, held.runId, 'producer')).toEqual(producer);
  expect(completed.engineHistory?.map(entry => entry.kind)).toEqual(['start', 'resume']);
});
