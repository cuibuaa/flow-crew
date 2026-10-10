import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBrief, lintInstrumentCriteria } from '../src/brief-preflight.js';
import { discoverProjectValidation, evaluateValidationDelta, reconcileProjectValidation, runProjectValidationBaseline } from '../src/project-validation.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { createDaemonReconciler } from '../src/daemon-reconciliation.js';
import * as recovery from '../src/restart-recovery.js';
import * as runLock from '../src/run-lock.js';
import { TaskRegistry } from '../src/task-registry.js';
import { beginStageAttempt, createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';
import { readGateVerdict } from '../src/scheduler.js';
import { buildSupervisorRolePrompt } from '../src/supervisor.js';
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
  const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runId;
  writeStageStatus(project, id, 'work', { status: 'pending', retries: 0 });
  beginStageAttempt(project, id, 'work', 0, '2026-01-01T00:00:00.000Z');
  if (checkpoint) updateRunState(project, id, state => {
    state.engineCheckpoint = { version: 1, runId: id, projectDir: project, bootId: 'same-boot', generation: 'fixture-generation', pid: 2147483647, at: '2026-01-01T00:00:00.000Z' };
  });
  return id;
}

describe('interrupted runs have a durable outcome without takeover', () => {
  it.each([
    ['same-boot', 'same-boot', 'fixture-generation', 'RECOVERY_FATE_UNKNOWN'],
    ['changed-generation', 'next-boot', 'changed-generation', 'RECOVERY_GENERATION_MISMATCH'],
    ['same-boot-and-changed-generation', 'same-boot', 'changed-generation', 'RECOVERY_FATE_UNKNOWN'],
    ['previous-boot', 'next-boot', 'fixture-generation', undefined],
  ])('audits first existing-run continuation (%s)', (kind, currentBootId, currentGeneration, refusal) => {
    const id = interrupted(), base = runDir(project, id), ledger = join(base, 'stages/work/status.json');
    updateRunState(project, id, state => { state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4; });
    const before = readFileSync(ledger, 'utf8');
    // No process is launched or signalled: only the recovery inputs differ.
    vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'dead', pid: 2147483647 });
    const reconcile = recovery.reconcileHostInterruptedRun;
    vi.spyOn(recovery, 'reconcileHostInterruptedRun').mockImplementation((directory, runId) => reconcile(directory, runId, { currentBootId, currentGeneration }));
    vi.spyOn(recovery, 'engineGeneration').mockReturnValue(currentGeneration);
    const launch = () => prepareWorkflowLaunch({ name: 'fixture', description: '', defaults: { max_iterations: 1, max_retries: 0 }, stages: [] }, 'name: fixture\nstages: []\n', project, id);
    try {
      if (refusal) {
        expect(launch).toThrow(refusal);
        expect(readRunState(project, id)).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' }, currentIteration: 2, maxIterations: 3, maxRetries: 4 });
        expect(readRunState(project, id).completedAt).toBeTruthy();
        expect(readFileSync(ledger, 'utf8')).toBe(before);
        const reason = readRunState(project, id).failureReason!;
        if (kind === 'same-boot-and-changed-generation') expect(reason).toContain('RECOVERY_GENERATION_MISMATCH');
        expect(readFileSync(join(base, 'events.jsonl'), 'utf8')).toContain(reason);
        expect(launch).toThrow(refusal);
        expect(readFileSync(ledger, 'utf8')).toBe(before);
      } else {
        expect(launch()).toMatchObject({ kind: 'ready', runId: id, resumingFromPark: true, resumeAtIteration: 2, maxIterations: 3 });
        expect(readRunState(project, id)).toMatchObject({ recovery: { kind: 'resumable' }, currentIteration: 2, maxIterations: 3, maxRetries: 4 });
        expect(readRunState(project, id).stages.work).toMatchObject({ status: 'pending', retries: 0, attempts: [{ status: 'failed', exitCode: 143 }] });
      }
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
    const checkpoint = { version: 1 as const, runId: id, projectDir: project, bootId: proof.currentBootId, generation: proof.currentGeneration, pid: process.pid, at: new Date().toISOString() };
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
    if (kind === 'previous-boot') {
      expect(failure).toBeUndefined(); expect(launch?.kind).toBe('ready');
      expect(launch?.kind === 'ready' && launch.resumingFromPark).toBe(true);
      expect(after).toMatchObject({ status: 'running', recovery: { kind: 'resumable' }, currentIteration: 1 });
      expect(after.stages.work).toMatchObject({ status: 'pending', retries: 1 });
      expect(after.stages.work.attempts).toHaveLength(2);
      expect(after.stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143 });
    } else {
      expect(launch).toBeUndefined();
      expect(String(failure)).toContain(kind === 'different-generation' ? 'RECOVERY_GENERATION_MISMATCH' : 'RECOVERY_FATE_UNKNOWN');
      expect(readFileSync(ledger, 'utf8')).toBe(before);
      if (kind === 'live-owner') expect(readFileSync(join(base, 'run.json'), 'utf8')).toBe(stateBefore);
      else {
        expect(after).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
        expect(after.completedAt).toBeTruthy();
        expect(readFileSync(join(base, 'events.jsonl'), 'utf8')).toContain(after.failureReason!);
      }
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
    expect(readRunState(project, id).status).toBe('failed');
  });
});

describe('declared products are part of gate admission', () => {
  it.each([false, true])('keeps later report ownership distinct from repair wiring (repair=%s)', repair => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['review', 'report']).runId;
    const base = runDir(project, id);
    const stage = (name: string, extra: object) => StageConfigSchema.parse({ id: name, role: 'coder', scope: [], depends_on: [], prompt_template: 'fixture', artifact_contract: { version: 1, produces: [], reads: [], replays: [] }, ...extra });
    updateRunState(project, id, state => {
      state.declaredOutputs = [{ path: 'report.md', expectedType: 'file' }];
      state.planControl = { version: 1, capabilities: ['report.md'], stages: [stage('review', { is_gate: true }), stage('report', { scope: ['report.md'], depends_on: ['review'], ...(repair ? { retry_to: ['review'] } : {}) })] };
    });
    writeFileSync(join(base, 'verdict_review.json'), '{"pass":true}');
    expect(readGateVerdict(project, 'review', id, undefined, false, false)?.pass).toBe(!repair);
    if (!repair) {
      writeStageStatus(project, id, 'report', { status: 'complete', retries: 0 });
      expect(readGateVerdict(project, 'review', id, undefined, false, false)?.reason).toContain('DECLARED_OUTPUT_REQUIRED');
    }
  });

  it('refuses a linked declared product using the same path precondition as archival', () => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    writeFileSync(join(runDir(project, id), 'task_brief.md'), '---\noutputs: [report.md]\n---\n# Goal\nDeliver the report.');
    writeFileSync(join(root, 'outside.md'), 'fixture'); symlinkSync(join(root, 'outside.md'), join(project, 'report.md'));
    writeFileSync(join(runDir(project, id), 'verdict_review.json'), '{"pass":true}');
    expect(readGateVerdict(project, 'review', id, undefined, false, false)?.reason).toMatch(/DECLARED_OUTPUT_REQUIRED.*symlink/);
  });

  it('retains declared products and an actual conflicting constraint after frontmatter stripping', () => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    const configured = configureWorkflowBrief({ name: 'fixture', description: '', defaults: {}, stages: [] }, project, id, runDir(project, id), 1, false, '---\noutputs: [report.md]\n---\n# Goal\nChange code and tests only.');
    expect(configured.kind).toBe('configured');
    if (configured.kind !== 'configured') throw new Error('fixture did not configure');
    expect(configured.taskDescription).toContain('report.md');
    expect(configured.taskDescription).toContain('Change code and tests only.');
    expect(buildSupervisorRolePrompt(1000, configured.taskDescription!)).toMatch(/conflict|contradict/i);
  });

  it.each(['missing', 'wrong-type', 'present'])('checks a required %s output before accepting PASS', kind => {
    const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []).runId;
    const base = runDir(project, id);
    writeFileSync(join(base, 'task_brief.md'), '---\noutputs: [report.md]\n---\n# Goal\nDeliver the product and report.\n');
    writeFileSync(join(base, 'verdict_review.json'), '{"pass":true}');
    if (kind === 'present') writeFileSync(join(project, 'report.md'), 'Required product');
    if (kind === 'wrong-type') mkdirSync(join(project, 'report.md'));
    const verdict = readGateVerdict(project, 'review', id, undefined, false, false);
    expect(verdict?.pass).toBe(kind === 'present');
    if (kind !== 'present') expect(verdict?.reason).toContain('DECLARED_OUTPUT');
  });

  it('makes declared outputs and contradictory guidance authority explicit to the supervisor', () => {
    const prompt = buildSupervisorRolePrompt(1000, '---\noutputs: [report.md]\n---\n# Goal\nChange code and tests only.');
    expect(prompt).toContain('report.md');
    expect(prompt).toMatch(/GUIDE.*(?:override|remove)|(?:override|remove).*GUIDE/);
    expect(prompt).toMatch(/conflict|contradict/i);
  });
});

describe('statistics and instrument policy is sentence-local', () => {
  it.each([
    '# Goal\nUpdate the headline in the README.\n\n# Evidence\nThe numeric rate in unrelated logs remains an input.',
    '# Goal\nUpdate the headline in the README. Retain the numeric rate in unrelated logs.',
  ])('does not combine unrelated headline and numeric requirements', brief => {
    expect(inspectBrief(brief).findings.some(f => f.code === 'headline_distribution_missing')).toBe(false);
  });
  it('still refuses a headline statistic without distribution evidence', () => {
    expect(inspectBrief('# Goal\nReport the headline statistic.').findings.some(f => f.code === 'headline_distribution_missing')).toBe(true);
  });
  it('does not combine a data inclusion directive with a neighboring implementation citation', () => {
    expect(lintInstrumentCriteria('The report must include the observed result. The source `src/reader.ts` is read-only evidence.')).toEqual([]);
    expect(lintInstrumentCriteria('The source must import `src/reader.ts`.')).toHaveLength(1);
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
