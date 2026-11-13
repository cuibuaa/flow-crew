import './test-support/policy-runtime.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseBriefDeclarations, DeclarationRefusal } from '../src/brief-declarations.js';
import { admittedContract, createBriefAdmission, inspectBrief, verifyBriefAdmission } from '../src/brief-preflight.js';
import { readAdmittedContract } from '../src/brief-criteria.js';
import { readBriefCriteriaForAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { ensureAttemptValidationPlan } from '../src/scheduler/sched_settlement/gate-validation.js';
import { readAdmittedBriefContract } from '../src/ship-inputs.js';
import { runShipSetup } from '../src/cli-ship-setup.js';
import { rehearseBrief } from '../src/rehearse.js';
import { Orchestrator, buildCommand } from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { removeSchedulerPidIfOwned } from '../src/scheduler/sched_policy/identity.js';
import { invalidateRunLockCache, releaseLaunchIntent } from '../src/run-lock.js';
import { engineDirectory, runRecordPath } from '../src/run-layout.js';
import { fcGlobalDir, readRunState, setFcGlobalDir, updateRunState, updateOperationalRunState, reserveRun, initializeReservedRun, evaluateRealityGate } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, oldStore: string;
const envelope = (yaml: string, body = 'Original body.') => `---\n${yaml}\n---\n${body}\n`;
const workflow = () => WorkflowConfigSchema.parse({ name: 'contract', defaults: { max_iterations: 2 }, stages: [{
  id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'Work.',
  artifact_contract: { version: 1, produces: [], reads: [] },
}] });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'contract-strict-')); project = join(root, 'project'); mkdirSync(project);
  oldStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { vi.useRealTimers(); invalidateRunLockCache(); setFcGlobalDir(oldStore); rmSync(root, { recursive: true, force: true }); });

const malformed = [
  ['unknown key', 'unknown: true', 'unknown'],
  ['alias', 'terminal_states: {complete: {path: result.md}}', 'terminal_states.complete.path'],
  ['duplicate', 'terminal_states:\n  complete:\n    paths: [one.md]\n    paths: [two.md]', 'terminal_states.complete.paths'],
  ['malformed value', 'terminal_states: {complete: {paths: [result.md], post_terminate_hook: {command: echo, args: [1]}}}', 'terminal_states.complete.post_terminate_hook.args.0'],
] as const;

describe('closed declaration admission', () => {
  it.each(malformed)('refuses %s with the same key path at setup, rehearse, quick and daemon registration', async (_kind, yaml, path) => {
    const brief = envelope(yaml), briefPath = join(root, 'brief.md'); writeFileSync(briefPath, brief);
    try { parseBriefDeclarations(brief); throw new Error('must refuse'); }
    catch (error) { expect(error).toBeInstanceOf(DeclarationRefusal); expect(error).toHaveProperty('keyPath', path); }
    const setup = await runShipSetup(['ship-setup', '--brief', briefPath, '--project', project,
      '--target', join(root, 'target'), '--branch', 'contract', '--base', 'HEAD']);
    expect(setup).toMatchObject({ state: 'refused', worktreeCreated: false });
    expect(setup.blockers.some(blocker => blocker.reason.includes(path))).toBe(true);
    const rehearsal = await rehearseBrief([briefPath, '--static-only'], { render: false });
    expect(rehearsal.exitCode).toBe(1);
    expect(rehearsal.findings.some(f => f.level === 'fail' && f.text.includes(path))).toBe(true);
    const quick = spawnSync(process.execPath, ['dist/cli.js', 'quick', '--adapter', 'mock', '--project', project, '--task', brief], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: root, TMPDIR: root, FC_HOME: join(root, 'quick'), FLOWCREW_DAEMON_SOCKET: join(root, 'quick.sock') },
    });
    expect(quick.status, quick.stderr).toBe(1); expect(quick.stderr).toContain(path);
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const daemon = new Orchestrator({ registry, now: () => new Date() });
    expect(() => daemon.enqueue({ name: 'invalid', projectDir: project, brief_text: brief })).toThrow(path);
    expect(registry.list()).toEqual([]);
    const adapter = { run: vi.fn() };
    await expect(runWorkflow(workflow(), stringify(workflow()), project, adapter, new Map(), undefined, undefined, undefined, brief)).rejects.toThrow(path);
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it.each([
    ['terminal_states: {parked: result.md}', 'terminal_states.parked'],
    ['terminal_states: {complete: {paths: [result.md], floor: {stage_glob: receipts/*}}}', 'terminal_states.complete.floor.stage_glob'],
    ['inputs: [{path: data.csv, frozen: yes}]', 'inputs.0.frozen'],
    ['reality_checks: [{name: x, type: exec-script-exit-zero, reads: [], params: {script: echo, typo: 1}}]', 'reality_checks.0.params.typo'],
    ['reality_checks: [{name: x, type: json-schema-match, reads: [], params: {file: x.json, schema: {properties: {x: {typo: true}}}}}]', 'reality_checks.0.params.schema.properties.x.typo'],
    ['inputs: &paths [one]\noutputs: *paths', 'outputs'],
    ['inputs: [{path: data, type: directory, sha256: '+ '0'.repeat(64) +'}]', 'inputs.0.sha256'],
    ['outputs: [/absolute/report]', 'outputs.0.type'],
    ['outputs: [{path: /absolute/../report, type: directory}]', 'outputs.0.path'],
    ['reality_checks: [{name: x, type: exec-script-exit-zero, reads: [], params: {script: echo, timeout_seconds: 0.5}}]', 'reality_checks.0.params.timeout_seconds'],
    ['reality_checks: [{name: x, type: exec-script-exit-zero, reads: [], params: {script: echo, timeout_seconds: 2147483.648}}]', 'reality_checks.0.params.timeout_seconds'],
    ['terminal_states: {complete: {paths: [result.md], post_terminate_hook: {command: echo, timeout_seconds: 2147483.648}}}', 'terminal_states.complete.post_terminate_hook.timeout_seconds'],
    ['validation: {commands: {test: {command: node, args: [], typo: true}}}', 'validation.commands.test.typo'],
  ])('closes nested keys and aliases: %s', (yaml, path) => {
    expect(() => parseBriefDeclarations(envelope(yaml))).toThrow(path);
  });

  it('hashes canonical paths and key order while retaining the exact byte digest', () => {
    const a = createBriefAdmission(inspectBrief(envelope('inputs: [./data/]\noutputs: [result.md]')), { kind: 'not_required' });
    const b = createBriefAdmission(inspectBrief(envelope('outputs: [result.md]\ninputs: [data]')), { kind: 'not_required' });
    expect(a.contract!.contractHash).toBe(b.contract!.contractHash); expect(a.digest).not.toBe(b.digest);
  });
});

function parked() {
  const brief = envelope('outputs: [original.md]\ncriteria: [{id: original, text: Original criterion.}]\nstage_duration_ms: 5000\ninput_limit_chars: 1000\nmax_continuations: 3\nterminal_states: {complete: original.md}');
  const w = workflow(), created = createRun(project, w.name, stringify(w), ['work'], brief);
  updateRunState(project, created.runId, state => { state.status = 'parked'; state.maxIterations = 2; state.currentIteration = 1; });
  writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), brief);
  return { ...created, brief, w };
}

describe('frozen run declaration', () => {
  it('uses task admission for a reserved daemon first launch', () => {
    const brief = envelope('outputs: [first.md]');
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const reservation = reserveRun(project);
    const admission = createBriefAdmission(inspectBrief(brief), { kind: 'not_required' });
    const task = registry.create({ name: 'first', projectDir: project, run_id: reservation.runId, brief_text: brief, brief_admission: admission });
    expect(buildCommand(task, join(process.cwd(), 'dist/cli.js'))).toContain('--brief-admission-record');
  });

  it.each(['changed', 'deleted'])('daemon first launch uses its admitted text when a brief export is %s', change => {
    const brief = envelope('outputs: [first.md]'), path = join(root, 'queued.md');
    writeFileSync(path, brief);
    const admission = createBriefAdmission(inspectBrief(brief), { kind: 'not_required' });
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const daemon = new Orchestrator({ registry, now: () => new Date() });
    const task = daemon.enqueue({ name: 'first', projectDir: project, brief_path: path, brief_admission: admission });
    if (change === 'deleted') rmSync(path); else writeFileSync(path, envelope('outputs: [other.md]'));
    expect(buildCommand(task, join(process.cwd(), 'dist/cli.js'))).toContain(Buffer.from(brief).toString('base64url'));
  });

  it('preserves the admitted contract in the first-event to first-snapshot crash gap', () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(join(engineDirectory(created.runDirPath), '.run-reservation.json'), JSON.stringify({
      version: 1, storageLayout: 2, runId: created.runId, projectDir: project, reservedAt: new Date().toISOString(),
      lifecycleAuthority: raw.lifecycleAuthority, startedAt: raw.startedAt, workflowName: created.w.name,
      briefAdmission: raw.briefAdmission,
    }));
    rmSync(path);
    expect(readAdmittedContract(created.runDirPath).brief).toBe(created.brief);
    const other = createBriefAdmission(inspectBrief('Other contract'), { kind: 'not_required' });
    expect(() => initializeReservedRun(project, created.runId, created.w.name, stringify(created.w), ['work'], other)).toThrow('contract_hash_mismatch');
  });

  it('records daemon changed-brief receipts before queueing and can explicitly restore original instructions', () => {
    const created = parked();
    updateRunState(project, created.runId, state => { state.recovery = { cause: 'process_death', kind: 'resumable', reason: 'Fixture recovery', at: new Date().toISOString(), interruptedStages: [] }; });
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const original = readRunState(project, created.runId).briefAdmission!;
    const task = registry.create({ name: 'continue', projectDir: project, run_id: created.runId, brief_text: created.brief, brief_admission: original });
    const daemon = new Orchestrator({ registry, now: () => new Date() });
    for (const brief of ['Changed model instructions.', created.brief]) {
      const receipt = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_digest_flag', at: new Date().toISOString() });
      expect(daemon.enqueue({ name: 'continue', projectDir: project, run_id: created.runId, brief_text: brief, brief_admission: receipt }).id).toBe(task.id);
      const state = readRunState(project, created.runId);
      expect(state.briefContinuationAdmission?.digest).toBe(receipt.digest);
      expect(state.briefAdmission).toEqual(original);
      expect(readAdmittedBriefContract(created.runDirPath).outputs.map(o => o.path)).toEqual(['original.md']);
    }
  });

  it('derives obligations from the checked contract after projections are altered or removed', () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.maxContinuations = 900; raw.terminalStates = {}; raw.declaredOutputs = [];
    delete raw.stageDurationLimitMs; raw.inputLimitChars = 900000;
    writeFileSync(path, JSON.stringify(raw));
    const state = readRunState(project, created.runId);
    expect(state).toMatchObject({ maxContinuations: 3, stageDurationLimitMs: 5000, inputLimitChars: 1000,
      terminalStates: { complete: { paths: ['original.md'] } }, declaredOutputs: [{ path: 'original.md' }] });
  });

  it.each(['ordinary', 'operational'])('refuses replacing the admitted contract through a %s writer', writer => {
    const created = parked();
    const change = (state: ReturnType<typeof readRunState>) => { state.briefAdmission = createBriefAdmission(inspectBrief('Replacement'), { kind: 'not_required' }); };
    expect(() => writer === 'ordinary' ? updateRunState(project, created.runId, change)
      : updateOperationalRunState(created.runDirPath, change)).toThrow('contract_hash_mismatch');
    expect(readAdmittedContract(created.runDirPath).brief).toBe(created.brief);
  });

  it('refuses a mismatched changed-brief receipt before any resume write', () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const receipt = createBriefAdmission(inspectBrief('Acknowledged'), { kind: 'explicit', source: 'cli_digest_flag', at: new Date().toISOString() });
    const before = readFileSync(path, 'utf8');
    expect(() => prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId, 'Other bytes', receipt)).toThrow('digest_mismatch');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each(['changed', 'deleted'] as const)('resumes with admitted obligations when the brief file is %s', change => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'task_brief.md');
    if (change === 'deleted') rmSync(path); else writeFileSync(path, envelope('outputs: [replacement.md]', 'Different body.'));
    const launch = prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId, 'Arbitrary caller text.');
    expect(launch.kind).toBe('ready');
    try {
      configureWorkflowBrief(created.w, project, created.runId, created.runDirPath, 2,
        { resumingExistingRun: true, briefWasAdmitted: true });
      expect(readAdmittedBriefContract(created.runDirPath).outputs.map(o => o.path)).toEqual(['original.md']);
      const state = readRunState(project, created.runId);
      expect(state.maxContinuations).toBe(3); expect(state.terminalStates?.complete?.paths).toEqual(['original.md']);
      expect(readAdmittedContract(created.runDirPath).brief).toBe(created.brief);
      expect(readBriefCriteriaForAdmission(created.runDirPath)?.criteria.map(c => c.id)).toEqual(['original']);
      expect(ensureAttemptValidationPlan(project, created.runId).version).toBe(1);
    } finally { removeSchedulerPidIfOwned(runRecordPath(created.runDirPath, 'scheduler.pid')); releaseLaunchIntent(project, created.runId); }
  });

  it('refuses a tampered recorded declaration before resume, recovery or contract consumption', () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')); raw.briefAdmission.contract.declaration.max_continuations = 9;
    writeFileSync(path, JSON.stringify(raw));
    for (const consume of [() => readAdmittedContract(created.runDirPath), () => assertContinuationCompatible(project, created.runId),
      () => reconcileHostInterruptedRun(project, created.runId), () => prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId)]) {
      expect(consume).toThrow('contract_hash_mismatch');
    }
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('parked');
  });

  it('refuses a tampered stored continuation receipt before changing run state', () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.briefContinuationAdmission = createBriefAdmission(inspectBrief('Explicit continuation'), {
      kind: 'explicit', source: 'cli_digest_flag', at: new Date().toISOString(),
    });
    raw.briefContinuationAdmission.contract.contractHash = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(raw));
    const before = readFileSync(path, 'utf8');
    expect(() => prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId)).toThrow('contract_hash_mismatch');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('keeps old records readable and refuses hashless resume without importing anything', async () => {
    const created = parked(), path = runRecordPath(created.runDirPath, 'run.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')); delete raw.briefAdmission.contract; writeFileSync(path, JSON.stringify(raw));
    const before = readFileSync(path, 'utf8'); expect(readRunState(project, created.runId).status).toBe('parked');
    expect(() => assertContinuationCompatible(project, created.runId)).toThrow('contract_hash_missing');
    expect(() => prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId)).toThrow('contract_hash_missing');
    await expect(evaluateRealityGate(project, created.runId, 'complete')).rejects.toThrow('contract_hash_missing');
    expect(() => readBriefCriteriaForAdmission(created.runDirPath)).toThrow('contract_hash_missing');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('records changed-brief acknowledgement by digest and keeps original obligations', () => {
    const created = parked(), changed = envelope('outputs: [replacement.md]', 'Explicit new instructions.');
    const acknowledgement = createBriefAdmission(inspectBrief(changed), { kind: 'explicit', source: 'cli_digest_flag', at: new Date().toISOString() });
    expect(verifyBriefAdmission(changed + '\n', acknowledgement).status).toBe('digest_mismatch');
    const launch = prepareWorkflowLaunch(created.w, stringify(created.w), project, created.runId, changed, acknowledgement);
    try {
      expect(launch.kind).toBe('ready');
      expect(readRunState(project, created.runId).briefContinuationAdmission?.digest).toBe(acknowledgement.digest);
      expect(admittedContract(readRunState(project, created.runId).briefAdmission).declaration.outputs).toEqual(['original.md']);
    } finally { removeSchedulerPidIfOwned(runRecordPath(created.runDirPath, 'scheduler.pid')); releaseLaunchIntent(project, created.runId); }
  });
});
