import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjectValidation, evaluateValidationDelta, reconcileProjectValidation, runProjectValidationBaseline } from '../src/project-validation.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { createDaemonReconciler } from '../src/daemon-reconciliation.js';
import * as recovery from '../src/restart-recovery.js';
import * as runLock from '../src/run-lock.js';
import { TaskRegistry } from '../src/task-registry.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';
import { readGateEvaluation } from '../src/scheduler.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { removeSchedulerPidIfOwned } from '../src/scheduler/sched_policy/identity.js';
import { bindReviewedGateValidation, recordGateValidationDelta, settleGateValidationEvidence } from '../src/scheduler/sched_settlement/gate-validation.js';

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-settlement-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function interrupted(checkpoint = true) {
  const workflow = { name: 'fixture', stages: [{ id: 'work', role: 'coder', scope: [], artifact_contract: { version: 1, produces: [], reads: [] } }] };
  const id = createRun(project, 'fixture', JSON.stringify(workflow), ['work']).runId;
  writeStageStatus(project, id, 'work', { status: 'pending', retries: 0 });
  beginStageAttempt(project, id, 'work', 0, '2026-01-01T00:00:00.000Z');
  if (checkpoint) updateRunState(project, id, state => {
    state.engineCheckpoint = { version: 2, runId: id, projectDir: project, bootId: 'same-boot', generation: 'fixture-generation', pid: 2147483647, at: '2026-01-01T00:00:00.000Z', processes: [] };
  });
  return id;
}

describe('interrupted runs have a durable outcome without takeover', () => {
  it('resumes the archived workflow contract after project configuration changes', () => {
    const id = interrupted(), base = runDir(project, id);
    const stage = StageConfigSchema.parse({ id: 'work', role: 'coder', scope: [], artifact_contract: { version: 1, produces: [], reads: [] } });
    writeFileSync(join(base, 'workflow.yaml'), JSON.stringify({ name: 'admitted', defaults: { max_iterations: 1 }, stages: [stage] }));
    vi.spyOn(recovery, 'readHostBootId').mockReturnValue('same-boot');
    vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'dead', pid: 2147483647 });
    try {
      const replacement = { name: 'replacement', description: '', defaults: {}, stages: [{ ...stage, id: 'replacement', dynamic_dispatch: true }], dispatch: [{ ...stage, id: 'replacement_plan' }] };
      const launch = prepareWorkflowLaunch(replacement, '', project, id);
      expect(launch.kind).toBe('ready');
      if (launch.kind === 'ready') expect(launch.baseStages.map(stage => stage.id)).toEqual(['work']);
      expect(replacement).not.toHaveProperty('dispatch');
      expect(readRunState(project, id).stages.replacement).toBeUndefined();
    } finally {
      removeSchedulerPidIfOwned(join(base, 'scheduler.pid')); runLock.releaseLaunchIntent(project, id);
    }
  });

  it.each([
    ['same-boot', 'same-boot', 'fixture-generation'],
    ['changed-generation', 'next-boot', 'changed-generation'],
    ['same-boot-and-changed-generation', 'same-boot', 'changed-generation'],
    ['previous-boot', 'next-boot', 'fixture-generation'],
  ])('audits first existing-run continuation (%s)', (_kind, currentBootId, currentGeneration) => {
    const id = interrupted(), base = runDir(project, id);
    updateRunState(project, id, state => { state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4; });
    // No process is launched or signalled: only the recovery inputs differ.
    vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'dead', pid: 2147483647 });
    const reconcile = recovery.reconcileHostInterruptedRun;
    vi.spyOn(recovery, 'reconcileHostInterruptedRun').mockImplementation((directory, runId) => reconcile(directory, runId, { currentBootId, currentGeneration }));
    vi.spyOn(recovery, 'engineGeneration').mockReturnValue(currentGeneration);
    const launch = () => prepareWorkflowLaunch({ name: 'fixture', description: '', defaults: { max_iterations: 1, max_retries: 0 }, stages: [] }, 'name: fixture\nstages: []\n', project, id);
    try {
      expect(launch()).toMatchObject({ kind: 'ready', runId: id, resumingExistingRun: true, resumeAtIteration: 2, maxIterations: 3 });
      expect(readRunState(project, id)).toMatchObject({ recovery: { kind: 'resumable' }, currentIteration: 2, maxIterations: 3, maxRetries: 4 });
      expect(readRunState(project, id).stages.work).toMatchObject({ status: 'pending', retries: 0, attempts: [{ status: 'failed', exitCode: 143 }] });
    } finally {
      removeSchedulerPidIfOwned(join(base, 'scheduler.pid'));
      runLock.releaseLaunchIntent(project, id);
    }
  });

  it.each(['same-boot', 'different-generation', 'previous-boot', 'live-owner'])('checks current proof after a second interruption (%s)', kind => {
    const id = interrupted(false), proof = { currentBootId: 'current-fixture-boot', currentGeneration: 'fixture-generation' };
    const reconcile = recovery.reconcileHostInterruptedRun;
    vi.spyOn(recovery, 'reconcileHostInterruptedRun').mockImplementation((directory, runId) => reconcile(directory, runId, proof));
    vi.spyOn(recovery, 'engineGeneration').mockReturnValue(proof.currentGeneration);
    const checkpoint = { version: 2 as const, runId: id, projectDir: project, bootId: proof.currentBootId, generation: proof.currentGeneration, pid: 2147483647, at: new Date().toISOString(), processes: [] };
    updateRunState(project, id, state => { state.engineCheckpoint = { ...checkpoint, bootId: 'first-fixture-boot' }; });
    expect(reconcile(project, id, proof).recovery?.kind).toBe('resumable');
    // A resumed scheduler claims a new checkpoint before dispatching again.
    updateRunState(project, id, state => {
      state.status = 'running';
      state.engineCheckpoint = { ...checkpoint, ...(kind === 'previous-boot' ? { bootId: 'second-fixture-boot' } : {}), ...(kind === 'different-generation' ? { generation: 'different-fixture-generation' } : {}) };
      state.recovery!.kind = 'resuming';
    });
    beginStageAttempt(project, id, 'work', 1);
    const base = runDir(project, id), ledger = join(base, 'stages/work/status.json');
    const before = readFileSync(ledger, 'utf8'), stateBefore = readFileSync(join(base, 'run.json'), 'utf8');
    if (kind === 'live-owner') vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'live', pid: process.pid });
    let launch: ReturnType<typeof prepareWorkflowLaunch> | undefined, failure: unknown;
    try {
      launch = prepareWorkflowLaunch({ name: 'fixture', description: '', defaults: { max_iterations: 2, max_retries: 1 }, stages: [] }, 'name: fixture\nstages: []\n', project, id);
    } catch (error) { failure = error; }
    finally { removeSchedulerPidIfOwned(join(base, 'scheduler.pid')); runLock.releaseLaunchIntent(project, id); }
    const after = readRunState(project, id);
    if (kind !== 'live-owner') {
      expect(failure).toBeUndefined(); expect(launch?.kind).toBe('ready');
      expect(launch?.kind === 'ready' && launch.resumingExistingRun).toBe(true);
      expect(after).toMatchObject({ status: 'running', recovery: { kind: 'resumable' }, currentIteration: 1 });
      expect(after.stages.work).toMatchObject({ status: 'pending', retries: 1 });
      expect(after.stages.work.attempts).toHaveLength(2);
      expect(after.stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143 });
    } else {
      expect(launch).toBeUndefined();
      expect(String(failure)).toContain('RECOVERY_FATE_UNKNOWN');
      expect(readFileSync(ledger, 'utf8')).toBe(before);
      expect(readFileSync(join(base, 'run.json'), 'utf8')).toBe(stateBefore);
    }
  });
  it('refuses direct continuation of closed legacy work without a bound checkpoint', () => {
    const id = interrupted(false);
    writeStageStatus(project, id, 'work', { status: 'failed', retries: 0, attempts: [{ index: 1, status: 'failed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', exitCode: 124 }] });
    const ledger = join(runDir(project, id), 'stages/work/status.json'), before = readFileSync(ledger, 'utf8');
    expect(() => prepareWorkflowLaunch({ name: 'fixture', description: '', defaults: { max_iterations: 1, max_retries: 0 }, stages: [] }, 'name: fixture\nstages: []\n', project, id)).toThrow(/RECOVERY_CHECKPOINT_MISSING/);
    expect(readRunState(project, id)).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });
  it.each([true, false])('ends unknown consumer fate (checkpoint=%s) with a reason, retaining attempt evidence', checkpoint => {
    const id = interrupted(checkpoint), ledger = join(runDir(project, id), 'stages/work/status.json');
    if (checkpoint) updateRunState(project, id, state => { delete state.engineCheckpoint!.processes; });
    const before = readFileSync(ledger, 'utf8');
    const state = reconcileHostInterruptedRun(project, id, { currentBootId: 'same-boot', currentGeneration: 'fixture-generation' });
    expect(state).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
    expect(state.completedAt).toBeTruthy();
    expect(state.failureReason).toMatch(checkpoint ? /RECOVERY_FATE_UNKNOWN/ : /RECOVERY_CHECKPOINT_MISSING/);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
    expect(readFileSync(join(runDir(project, id), 'events.jsonl'), 'utf8')).toContain('recovery_reconciled');
  });

  it.each([true, false])('daemon discovers same-boot/legacy stopped runs (checkpoint=%s)', checkpoint => {
    const id = interrupted(checkpoint);
    vi.spyOn(recovery, 'readHostBootId').mockReturnValue('same-boot');
    vi.spyOn(recovery, 'engineGeneration').mockReturnValue('fixture-generation');
    vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
    createDaemonReconciler(new TaskRegistry({ baseDir: join(root, 'registry') }), vi.fn())();
    expect(readRunState(project, id).status).toBe(checkpoint ? 'parked' : 'failed');
  });
});

describe('declared products are part of gate admission', () => {
  it.each([false, true])('keeps later report ownership distinct from repair wiring (repair=%s)', repair => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['review', 'report']).runId;
    const base = runDir(project, id);
    const stage = (name: string, extra: object) => StageConfigSchema.parse({ id: name, role: 'coder', scope: [], depends_on: [], prompt_template: 'fixture', artifact_contract: { version: 1, produces: [], reads: [] }, ...extra });
    updateRunState(project, id, state => {
      state.declaredOutputs = [{ path: 'report.md', expectedType: 'file' }];
      state.planControl = { version: 1, capabilities: ['report.md'], stages: [stage('review', { is_gate: true }), stage('report', { scope: ['report.md'], depends_on: ['review'], ...(repair ? { retry_to: ['review'] } : {}) })] };
    });
    writeFileSync(join(base, 'verdict_review.json'), '{"pass":true}');
    expect(readGateEvaluation(project, 'review', id, undefined, false)?.pass).toBe(!repair);
    if (!repair) {
      writeStageStatus(project, id, 'report', { status: 'complete', retries: 0 });
      expect(readGateEvaluation(project, 'review', id, undefined, false)?.reason).toContain('DECLARED_OUTPUT_REQUIRED');
    }
  });

  it('accepts a delivered link object without treating its target as the product', () => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    writeFileSync(join(runDir(project, id), 'task_brief.md'), '---\noutputs: [report.md]\n---\n# Goal\nDeliver the report.');
    writeFileSync(join(root, 'outside.md'), 'fixture'); symlinkSync(join(root, 'outside.md'), join(project, 'report.md'));
    writeFileSync(join(runDir(project, id), 'verdict_review.json'), '{"pass":true}');
    expect(readGateEvaluation(project, 'review', id, undefined, false)?.pass).toBe(true);
  });

  it('retains declared products and an actual conflicting constraint after frontmatter stripping', () => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    const configured = configureWorkflowBrief({ name: 'fixture', description: '', defaults: {}, stages: [] }, project, id, runDir(project, id), 1, false, '---\noutputs: [report.md]\n---\n# Goal\nChange code and tests only.');
    expect(configured.kind).toBe('configured');
    if (configured.kind !== 'configured') throw new Error('fixture did not configure');
    expect(configured.taskDescription).toContain('report.md');
    expect(configured.taskDescription).toContain('Change code and tests only.');
  });

  it.each(['missing', 'wrong-type', 'present'])('checks a required %s output before accepting PASS', kind => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    const base = runDir(project, id);
    writeFileSync(join(base, 'task_brief.md'), '---\noutputs: [report.md]\n---\n# Goal\nDeliver the product and report.\n');
    writeFileSync(join(base, 'verdict_review.json'), '{"pass":true}');
    if (kind === 'present') writeFileSync(join(project, 'report.md'), 'Required product');
    if (kind === 'wrong-type') mkdirSync(join(project, 'report.md'));
    const verdict = readGateEvaluation(project, 'review', id, undefined, false);
    expect(verdict?.pass).toBe(kind === 'present');
    if (kind !== 'present') expect(verdict?.reason).toContain('DECLARED_OUTPUT');
  });
});

describe('mixed language validation retains all measured commands', () => {
  function mixed(python: string) {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ packageManager: 'npm@10', scripts: { test: 'vitest run' } }));
    writeFileSync(join(project, 'setup.py'), 'from setuptools import setup\nsetup(name="fixture")\n');
    if (python === 'pyproject') writeFileSync(join(project, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    else writeFileSync(join(project, 'tox.ini'), python === 'tox' ? '[testenv]\ncommands = python tests/runtests.py\n' : '[pytest]\ntestpaths = tests\n');
  }
  it.each(['pyproject', 'pytest', 'tox'])('runs Python and JS from %s without hiding a Python regression', async kind => {
    mixed(kind);
    const discovery = discoverProjectValidation(project);
    const tests = discovery.commands.filter(c => c.role === 'test');
    expect(tests).toHaveLength(2);
    expect(tests.map(c => c.command)).toContain('npm');
    expect(tests.map(c => c.command)).toContain(kind === 'tox' ? 'tox' : 'python');
    const baseline = await runProjectValidationBaseline(project, { runCommand: () => ({ exitCode: 0, stdout: '1 passed' }) });
    const calls: string[] = [];
    const current = await runProjectValidationBaseline(project, { runCommand: request => {
      calls.push(request.command);
      return request.command === 'npm' ? { exitCode: 0, stdout: '1 passed' } : { exitCode: 1, stdout: 'FAILED tests/test_fixture.py::test_regression\n1 failed' };
    } });
    expect(calls).toHaveLength(2);
    expect(evaluateValidationDelta(baseline, current.results).some(d => d.state === 'regression')).toBe(true);
    expect(reconcileProjectValidation(project, [{ role: 'test', command: 'npm', args: ['run', 'test'], evidencePath: 'brief' }]).commands.filter(c => c.role === 'test')).toHaveLength(2);
  });
  it('does not guess an executable test command from setup.py alone', () => {
    writeFileSync(join(project, 'setup.py'), 'from setuptools import setup\nsetup(name="fixture")\n');
    expect(discoverProjectValidation(project).commands).toEqual([]);
  });
  it('adopts a durable mixed-command review receipt without rerunning or collapsing its checks', async () => {
    mixed('pyproject');
    const baseline = await runProjectValidationBaseline(project, { runCommand: () => ({ exitCode: 0 }) });
    const { runId, runDirPath } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['review']);
    writeFileSync(join(runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline }));
    const attempt = { index: 1, startedAt: 'fixture-start', writes: [], writeAttribution: 'structured' as const };
    writeStageStatus(project, runId, 'review', { status: 'running', retries: 0, attempts: [{ ...attempt, status: 'running' }] });
    const receipt = await recordGateValidationDelta(project, runId, 'review', { runCommand: () => ({ exitCode: 0 }) });
    expect(receipt?.delta.filter(result => result.role === 'test').map(result => result.display)).toEqual(['npm run test', 'python -m pytest']);
    writeStageStatus(project, runId, 'review', { status: 'complete', retries: 0, attempts: [{ ...attempt, status: 'complete', completedAt: 'fixture-end' }] });
    expect(bindReviewedGateValidation(project, runId, 'review')).toBe(true);
    expect(await settleGateValidationEvidence(project, runId, 'review', { runCommand: () => { throw new Error('settled read-only review must not rerun'); } })).toEqual({ kind: 'unchanged' });
    const durable = JSON.parse(readFileSync(join(runDirPath, 'validation_delta_review.json'), 'utf8'));
    expect(durable.delta).toHaveLength(baseline.results.length);
    expect(durable.current.filter((result: { role: string }) => result.role === 'test')).toHaveLength(2);
  });
  it('does not let a passing JS result substitute for an absent or renamed Python command', async () => {
    mixed('pyproject');
    const baseline = await runProjectValidationBaseline(project, { runCommand: () => ({ exitCode: 0 }) });
    const js = baseline.results.find(result => result.display === 'npm run test')!;
    const otherRoles = baseline.results.filter(result => result.role !== 'test');
    expect(evaluateValidationDelta(baseline, [...otherRoles, js]).filter(result => result.state === 'unresolved')).toHaveLength(1);
    expect(evaluateValidationDelta(baseline, [...otherRoles, js, { ...js, display: 'different test command' }]).filter(result => result.state === 'unresolved')).toHaveLength(1);
    expect(baseline.gateCriteria.filter(criterion => criterion.role === 'test').map(criterion => criterion.display)).toEqual(['npm run test', 'python -m pytest']);
  });
});
