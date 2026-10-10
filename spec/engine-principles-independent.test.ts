/**
 * Independent audit controls. Run: npm test -- spec/engine-principles-independent.test.ts
 * Safety assertions restored after the three audited mechanisms were repaired.
 * Original constructions and the historical failing verdict are retained.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { inspectDeclaredStageReads } from '../src/declared-artifact-audit.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { inspectDispatchAdmission, parseDispatchedStageConfig, runWorkflow, StageConfigSchema, WorkflowConfigSchema, type StageConfig } from '../src/scheduler.js';
import { applyPlanRevision, planDigest, recordAdmittedPlan } from '../src/plan-revisions.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { readInvocationInput, readRunStateView, recordInvocationInput } from '../src/run-state-view.js';
import { classifyDeclarationAdmissionChange } from '../src/recorded-replay-policy.js';
import { RUN_HISTORY_FILE, RUN_STATUS, beginStageAttempt, captureStageEvidence, completeStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus, runDir, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
const startedAt = '2026-10-03T00:00:00.000Z';
const contract = () => ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [] });
const stage = (id: string, extra: Partial<StageConfig> = {}) => StageConfigSchema.parse({ criterion_refs: [], id, role: 'coder', scope: ['docs/**'], depends_on: [], dependency_reasons: {}, prompt_template: 'Execute the declared fixture.', artifact_contract: contract(), ...extra });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-independent-audit-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work', 'writer', 'pending']).runId;
  directory = runDir(project, runId);
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

describe('independent declaration and decision controls', () => {

  it('keeps an incomplete producer from satisfying a declared read through a stale file', () => {
    writeFileSync(join(project, 'old.md'), 'stale output');
    const artifactContract = ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [{ id: 'old', root: 'project', path: 'old.md', source: { kind: 'stage', stage: 'pending', artifact: 'old' } }] });
    expect(inspectDeclaredStageReads({ artifactContract, projectDir: project, runDir: directory, statuses: { pending: { status: 'skipped', retries: 0 } } })[0]).toContain('ARTIFACT_READ_NOT_PRODUCED');
  });

  it('refuses an input that exists with the wrong filesystem kind at full admission', () => {
    mkdirSync(join(project, 'input.md'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [{ id: 'input', root: 'project', path: 'input.md', source: { kind: 'input' } }] }) });
    expect(inspectArtifactDeclarations({ stages: [writer], projectDir: project, runDir: directory, scopeOwns: () => true })[0]).toContain('ARTIFACT_INPUT_ABSENT');
  });

  it('does not let required-format classification hide a newly lost warning', () => {
    const before = { pass: true, errors: [], warnings: ['serialize overlapping writers'], terminalOwners: ['owner'] };
    const required = ['ARTIFACT_DECLARATION_REQUIRED: work'];
    expect(classifyDeclarationAdmissionChange({ baseline: { status: 'returned', value: before }, candidate: { status: 'returned', value: { ...before, pass: false, errors: required, warnings: [] } }, requiredErrors: required })).toBe('ambiguous_unpredicted');
  });

  it('refuses a typed run output shared by two unordered directory and file writers', () => {
    const a = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'dir', root: 'run', path: 'deliverables', kind: 'directory' }], reads: [] }) });
    const b = stage('pending', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'file', root: 'run', path: 'deliverables/result.md' }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [a, b], baseStages: [], dispatchStageId: 'plan' });
    expect(admission.errors.join(';')).toContain('ARTIFACT_OUTPUT_CONCURRENT_OWNERS');
  });

  it('refuses the actual engine history carrier as a stage-produced run artifact', () => {
    const evidence = captureStageEvidence(project, runId, 1, 'writer', { status: 'complete', retries: 0 });
    updateRunState(project, runId, state => { state.stageEvidence = [evidence]; });
    const projection = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    const historyPath = projection.stateFormat.history.path as string;
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'history', root: 'run', path: historyPath }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(historyPath).toBe('run-history.v1.jsonl');
    expect(admission.pass).toBe(false);
    expect(admission.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    expect(readRunState(project, runId).stageEvidence).toHaveLength(1);
    const ordinary = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'history', root: 'run', path: 'ordinary-history.jsonl' }], reads: [] }) });
    expect(inspectDispatchAdmission({ dispatched: [ordinary], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).pass).toBe(true);
  });

  it.each(['symlink', 'hardlink', 'container'])('refuses an existing %s alias to acknowledged history', kind => {
    const evidence = captureStageEvidence(project, runId, 1, 'writer', { status: 'complete', retries: 0 });
    updateRunState(project, runId, state => { state.stageEvidence = [evidence]; });
    const before = readFileSync(join(directory, RUN_HISTORY_FILE));
    const alias = join(directory, 'alias');
    if (kind === 'hardlink') linkSync(join(directory, RUN_HISTORY_FILE), alias);
    else symlinkSync(kind === 'container' ? directory : join(directory, RUN_HISTORY_FILE), alias);
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'history', root: 'run', path: 'alias', kind: kind === 'container' ? 'directory' : 'file' }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(admission.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    expect(readFileSync(join(directory, RUN_HISTORY_FILE))).toEqual(before);
    expect(readRunState(project, runId).stageEvidence).toHaveLength(1);
  });

  it.each(['relative', 'absolute', 'multihop', 'parent', 'component_dotdot'])('refuses a pre-existing %s alias before history is created', kind => {
    expect(existsSync(join(directory, RUN_HISTORY_FILE))).toBe(false);
    if (kind === 'multihop') symlinkSync(RUN_HISTORY_FILE, join(directory, 'hop'));
    if (kind === 'parent') symlinkSync(directory, join(directory, 'parent'));
    if (kind === 'component_dotdot') {
      mkdirSync(join(directory, 'nested')); symlinkSync('nested', join(directory, 'part'));
    }
    symlinkSync(kind === 'absolute' ? join(directory, RUN_HISTORY_FILE)
      : kind === 'multihop' ? 'hop' : kind === 'parent' ? `parent/${RUN_HISTORY_FILE}`
        : kind === 'component_dotdot' ? `part/../${RUN_HISTORY_FILE}` : RUN_HISTORY_FILE, join(directory, 'alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'alias' }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(admission.pass).toBe(false);
    expect(admission.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    const evidence = captureStageEvidence(project, runId, 1, 'writer', { status: 'complete', retries: 0 });
    updateRunState(project, runId, state => { state.stageEvidence = [evidence]; });
    expect(readRunState(project, runId).stageEvidence).toHaveLength(1);
  });

  it.each([
    'run.json', 'events.jsonl', 'workflow.yaml', 'task_brief.md', 'brief_criteria.json',
    'validation_baseline.json', 'validation_delta_writer.json', 'dispatch_admission.json',
    'plan_history/next.json', 'audit_findings/next.json', 'signals/replan.json',
    'supervisor_state.json', 'supervisor_usage.json', 'stage_evidence/iteration_1/receipt.json',
    'scheduler.pid', 'scheduler-heartbeat.json', 'scheduler-loop-stall.json', 'approvals.jsonl',
    '.reality-gate.json', '.reality-gate.failures.md', 'declared_outputs/next.json',
    'guidance_history/injected.md', '.rollback-preimages/next.json', 'gate_reevaluation/next.json',
    'dispatch_rejections/next.json', 'plan_retry/next.json', 'supervisor_rejections/next.json',
    'discarded/next.json', 'iteration_log.md', 'run_event_status.json', 'attempt_summary_refresh.json',
    'criterion_discharges.json', 'supervisor_guidance.md', 'supervisor_log.md', 'summary.md', 'progress.md',
    'blockage_ledger.json', 'repeated_blockage.json', 'plan_retry_state.json', 'rollback_change_journal.jsonl',
    'gate_contract.json', 'user_input.md', 'verdict.json',
    'research_round_input_error.json', 'research_round_contract_repair.json', 'research_integrity_rejections.json',
    'research_terminal_ready.json', 'research_continue.json', 'research_gate_exhausted.json',
    'goal_met.json', 'repair_diff.json', 'campaign_revision_request.jsonl', 'post_terminate_hook.log',
    '.run-state.lock', '.run-reservation.json', 'stages/writer/status.json',
    'stages/writer/input.md', 'stages/writer/invocations/future.json',
    'stages/writer/attempt_generation.json', 'stages/writer/plan_revision_decision_future.json',
    'stages/writer/scope_revision_decision_future.json', 'stages/writer/approval_resolution.json',
    'stages/writer/attempt_deadline_execution_1_budget.jsonl', 'stages/writer/constraint_audit_attempt_1.json',
    'stages/writer/command_activity.json', 'stages/writer/session.json', 'stages/writer/artifact_contract.json',
    'stages/writer/guidance_consumed.md', 'stages/writer/guidance.md', 'stages/writer/live.log', 'stages/writer/trace.jsonl',
    'stages/work/output.md', 'verdict_other.json',
  ])('refuses a prospective symlink alias to engine carrier %s', carrier => {
    symlinkSync(join(directory, carrier), join(directory, 'alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'alias' }], reads: [] }) });
    expect(inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
  });

  it.each(['run.json', 'events.jsonl', 'stages/writer/input.md', 'stages/writer/invocations/one.json'])('refuses an existing hardlink alias to engine carrier %s', carrier => {
    const path = join(directory, carrier); mkdirSync(join(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, 'Engine-owned bytes');
    const before = readFileSync(path); linkSync(path, join(directory, 'alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'alias' }], reads: [] }) });
    expect(inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).pass).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(['cycle', 'escape'])('refuses a dangling alias with %s even without its final target', kind => {
    symlinkSync(kind === 'cycle' ? 'alias' : join(root, 'outside-future.md'), join(directory, 'alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'alias' }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(admission.pass).toBe(false);
    expect(admission.errors.join(';')).toContain(kind === 'cycle' ? 'ARTIFACT_PATH_SYMLINK_LOOP:' : 'ARTIFACT_PATH_ESCAPE:');
  });

  it('keeps a normal future alias and own stage request/output and gate verdict capabilities', () => {
    symlinkSync('future.md', join(directory, 'alias'));
    for (const path of ['alias', 'stages/writer/notes/report.md', 'stages/writer/scope_revision_request.json', 'stages/writer/plan_revision_request.json', 'stages/writer/approval_request.json']) {
      const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path }], reads: [] }) });
      expect(inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).pass).toBe(true);
    }
    const gate = stage('writer', { role: 'qa', is_gate: true, artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_writer.json' }], reads: [] }) });
    expect(inspectArtifactDeclarations({ stages: [gate], scopeOwns: () => true, projectDir: project, runDir: directory })).toEqual([]);
  });

  it('rechecks replacement and renamed aliases at live revision admission', () => {
    symlinkSync('ordinary-future.md', join(directory, 'alias'));
    const base = stage('work');
    writeStageStatus(project, runId, 'work', { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt, status: 'complete', exitCode: 0 }] });
    updateRunState(project, runId, state => { recordAdmittedPlan(state, [base], directory, 'Alias fixture', true, { pass: true, errors: [] }); });
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'alias' }], reads: [] }) });
    symlinkSync(RUN_HISTORY_FILE, join(directory, 'replacement')); renameSync(join(directory, 'replacement'), join(directory, 'alias'));
    const previousHistory = readRunState(project, runId).queryState!.planHistory;
    const { decision } = applyPlanRevision({ projectDir: project, runId, request: { version: 1, requestId: 'replace_alias', runId, stageId: 'work', attemptIndex: 1, attemptStartedAt: startedAt, baseRevision: 0, baseDigest: planDigest([base]), reason: 'Exercise replacement under full admission', stages: [base, writer] }, parseStage: parseDispatchedStageConfig, scopeContained: (scope, capabilities) => capabilities.includes(scope), admit: (stages) => inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }) });
    expect(decision.accepted).toBe(false);
    expect(decision.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    expect(readRunState(project, runId).queryState!.planHistory).toEqual(previousHistory);
  });

  it.each(['dangling_symlink', 'existing_symlink', 'existing_hardlink'])('refuses a directory containing an engine history %s member', kind => {
    const evidence = () => { const record = captureStageEvidence(project, runId, 1, 'writer', { status: 'complete', retries: 0 }); updateRunState(project, runId, state => { state.stageEvidence = [record]; }); };
    if (kind !== 'dangling_symlink') evidence();
    const notes = join(directory, 'notes'); mkdirSync(notes);
    if (kind === 'existing_hardlink') linkSync(join(directory, RUN_HISTORY_FILE), join(notes, 'alias'));
    else symlinkSync(join(directory, RUN_HISTORY_FILE), join(notes, 'alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'notes', kind: 'directory' }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(admission.pass).toBe(false);
    expect(admission.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    if (kind === 'dangling_symlink') evidence();
    expect(readRunState(project, runId).stageEvidence).toHaveLength(1);
  });

  it('allows an ordinary directory with a confined future member and a finite directory link', () => {
    mkdirSync(join(directory, 'notes')); symlinkSync('future.md', join(directory, 'notes/alias'));
    symlinkSync('.', join(directory, 'notes/self'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'run', path: 'notes', kind: 'directory' }], reads: [] }) });
    expect(inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).pass).toBe(true);
  });

  it.each(['file', 'directory'])('refuses a project %s output hardlinked to acknowledged engine history', kind => {
    const evidence = captureStageEvidence(project, runId, 1, 'writer', { status: 'complete', retries: 0 });
    updateRunState(project, runId, state => { state.stageEvidence = [evidence]; });
    const before = readFileSync(join(directory, RUN_HISTORY_FILE));
    mkdirSync(join(project, 'docs'));
    linkSync(join(directory, RUN_HISTORY_FILE), join(project, 'docs/alias'));
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'project', path: kind === 'file' ? 'docs/alias' : 'docs', kind }], reads: [] }) });
    const admission = inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(admission.pass).toBe(false);
    expect(admission.errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH:');
    expect(readFileSync(join(directory, RUN_HISTORY_FILE))).toEqual(before);
    expect(readRunState(project, runId).stageEvidence).toHaveLength(1);
  });

  it('allows an ordinary project output named run.json', () => {
    const writer = stage('writer', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'out', root: 'project', path: 'docs/run.json' }], reads: [] }) });
    expect(inspectDispatchAdmission({ dispatched: [writer], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }).pass).toBe(true);
  });
});

describe('independent revision and exact-input controls', () => {
  function admitted() {
    const stages = [stage('writer'), stage('pending')];
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt, completedAt: startedAt, status: 'complete', exitCode: 0 }] });
    updateRunState(project, runId, s => { recordAdmittedPlan(s, stages, directory, 'Independent admitted construction', true); });
    return stages;
  }
  function revise(stages: StageConfig[], proposed: StageConfig[], requestId = 'independent') {
    return applyPlanRevision({ projectDir: project, runId,
      request: { version: 1, requestId, runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, baseRevision: 0, baseDigest: planDigest(stages), reason: 'Independent outcome proposal', stages: proposed },
      parseStage: parseDispatchedStageConfig,
      admit: candidate => inspectDispatchAdmission({ dispatched: candidate, baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }),
      scopeContained: (scope, capabilities) => capabilities.includes(scope),
    });
  }
  it('refuses removal of pending work and leaves its admitted history intact', () => {
    const stages = admitted();
    expect(revise(stages, stages.slice(0, 1)).decision.errors.join(';')).toContain('PLAN_REVISION_OBLIGATION_REMOVED');
    expect(readRunState(project, runId).queryState?.planHistory).toHaveLength(1);
  });
  it('refuses a second proposal against a stale revision without admitting it', () => {
    const stages = admitted();
    expect(revise(stages, [...stages, stage('extra')]).decision.accepted).toBe(true);
    expect(revise(stages, [...stages, stage('other')], 'stale').decision.errors.join(';')).toContain('PLAN_REVISION_STALE');
    expect(readRunState(project, runId).planControl?.stages.map(s => s.id)).not.toContain('other');
  });
  it('marks corrupted exact-input bytes invalid instead of treating the alias as exact', () => {
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt, status: 'complete', exitCode: 0 }] });
    const captured = recordInvocationInput(directory, { runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, invocationIndex: 1, boundary: 'adapter', adapter: 'fixture', model: 'fixture', systemPrompt: 'system', userPrompt: 'original' });
    const mutated = readInvocationInput(captured.path); mutated.userPrompt = 'replacement'; writeFileSync(captured.path, JSON.stringify(mutated));
    const view = readRunStateView(project, runId, { includePromptText: true });
    expect(view.prompts.invocations[0].integrity).toBe('invalid');
    expect(view.prompts.missingAttemptInputs).toHaveLength(1);
  });
});

describe('independent restart crash-window falsifier', () => {
  function prepare() {
    beginStageAttempt(project, runId, 'work', 0, startedAt);
    updateRunState(project, runId, s => { s.status = 'running'; s.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: 'boot_before', generation: 'fixture_generation', pid: process.pid, at: startedAt }; });
  }
  function recover() { return reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_after', currentGeneration: 'fixture_generation' }); }
  it('resumes a prior-boot attempt without a crash during reconciliation', () => {
    prepare(); const state = recover();
    expect(state.stages.work.status).toBe('pending');
    expect(state.stages.work.attempts?.[0].exitCode).toBe(143);
  });
  it('preserves a genuine authored failure rather than automatically retrying it', () => {
    prepare(); completeStageAttempt(project, runId, 'work', 0, { exitCode: 1, duration_ms: 1, error: 'Authored validation rejected the product' });
    expect(recover().stages.work.status).toBe('failed');
  });
  it('blocks unknown same-boot fate without closing the running attempt', () => {
    prepare(); const state = reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_before', currentGeneration: 'fixture_generation' });
    expect(state.recovery?.kind).toBe('blocked');
    expect(readStageStatus(project, runId, 'work').attempts?.[0].status).toBe('running');
  });
  function crash(point: string) {
    const source = `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
      const [dist, project, fc, runId, point] = process.argv.slice(1);
      const rename = fs.renameSync;
      fs.renameSync = function (from, to) {
        const result = rename(from, to);
        if (String(to).endsWith(point.endsWith('ledger') ? '/stages/work/status.json' : '/run.json')) {
          const record = JSON.parse(fs.readFileSync(to, 'utf8'));
          const stage = point.endsWith('ledger') ? record : record.stages.work;
          const interrupted = stage.attempts.at(-1).error?.startsWith('HOST_RESTART_INTERRUPTED:');
          const hit = point === 'intent' ? record.recoveryIntent?.phase === 'prepared' && !interrupted
            : point === 'commit' ? record.recoveryIntent?.phase === 'committed'
            : point.startsWith('pending_') ? stage.status === 'pending' && interrupted
            : stage.status === 'failed' && interrupted;
          if (hit) process.kill(process.pid, 'SIGKILL');
        }
        return result;
      };
      syncBuiltinESMExports();
      const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
      const recovery = await import(pathToFileURL(join(dist, 'restart-recovery.js')));
      recovery.reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_after', currentGeneration: 'fixture_generation' });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, resolve('dist'), project, fcGlobalDir(), runId, point], { cwd: project, encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') } });
    expect(child.signal).toBe('SIGKILL');
    expect(child.error).toBeUndefined();
  }
  it.each(['stage_ledger', 'run_projection', 'intent', 'pending_ledger', 'pending_projection', 'commit'])('resumes after an actual child crash at %s publication during recovery', point => {
    prepare(); crash(point);
    if (point !== 'intent') expect(readStageStatus(project, runId, 'work').attempts?.[0].error).toContain('HOST_RESTART_INTERRUPTED:');
    const second = recover();
    const observed = { kind: second.recovery?.kind, stage: second.stages.work.status };
    expect(observed).toEqual({ kind: 'resumable', stage: 'pending' });
    expect(second.recovery?.interruptedStages).toEqual(['work']);
    expect(readStageStatus(project, runId, 'work').attempts?.[0].exitCode).toBe(143);
    expect(readStageStatus(project, runId, 'work').attempts).toHaveLength(1);
    const beforeRepeat = [readFileSync(join(directory, 'run.json')), readFileSync(join(directory, 'stages/work/status.json'))];
    expect(recover().recovery).toEqual(second.recovery);
    expect([readFileSync(join(directory, 'run.json')), readFileSync(join(directory, 'stages/work/status.json'))]).toEqual(beforeRepeat);
    expect(existsSync(join(directory, 'stages/work/status.json'))).toBe(true);
  });

  it('validates all interrupted executions before partially closing any of them', () => {
    prepare(); beginStageAttempt(project, runId, 'writer', 0, startedAt);
    const ledger = readStageStatus(project, runId, 'writer'); ledger.attempts![0].index++;
    writeFileSync(join(directory, 'stages/writer/status.json'), JSON.stringify(ledger));
    expect(recover().recovery?.reason).toContain('RECOVERY_ATTEMPT_UNBOUND:');
    expect(readStageStatus(project, runId, 'work').attempts![0].status).toBe('running');
    expect(readRunState(project, runId).recoveryIntent).toBeUndefined();
  });

  it.each(['run', 'checkpoint', 'plan', 'iteration', 'attempt', 'prefix', 'malformed', 'completion_time', 'duration'])('blocks %s intent mismatch without changing the execution ledger', kind => {
    prepare(); crash('intent');
    const before = readFileSync(join(directory, 'stages/work/status.json'));
    updateRunState(project, runId, state => {
      const intent = state.recoveryIntent!;
      if (kind === 'run') intent.binding.runId = 'unrelated';
      if (kind === 'checkpoint') state.engineCheckpoint!.pid++;
      if (kind === 'plan') intent.binding.planRevision = { revision: 9, digest: '0'.repeat(64) };
      if (kind === 'iteration') state.currentIteration = 2;
      if (kind === 'attempt') intent.stages[0].attempt.index++;
      if (kind === 'prefix') intent.stages[0].prefixDigest = '0'.repeat(64);
      if (kind === 'malformed') Reflect.set(intent, 'version', 2);
      if (kind === 'completion_time') intent.stages[0].completedAt = startedAt;
      if (kind === 'duration') intent.stages[0].durationMs++;
    });
    const state = recover();
    expect(state.recovery?.kind).toBe('blocked');
    expect(state.recovery?.reason).toMatch(/RECOVERY_(INTENT_INVALID|INTENT_UNBOUND|ATTEMPT_UNBOUND):/);
    expect(readFileSync(join(directory, 'stages/work/status.json'))).toEqual(before);
  });

  it('preserves an authored rejection published after prepared interruption intent', () => {
    prepare(); crash('intent');
    completeStageAttempt(project, runId, 'work', 0, { exitCode: 1, duration_ms: 1, error: 'Authored validation rejected the product' });
    const before = readFileSync(join(directory, 'stages/work/status.json'));
    const state = recover();
    expect(state.recovery?.reason).toContain('RECOVERY_ATTEMPT_UNBOUND:');
    expect(state.stages.work.status).toBe('failed');
    expect(readFileSync(join(directory, 'stages/work/status.json'))).toEqual(before);
  });

  it('blocks the entire interruption set if another execution appears after intent', () => {
    prepare(); crash('intent');
    beginStageAttempt(project, runId, 'writer', 0, startedAt);
    expect(recover().recovery?.reason).toContain('RECOVERY_ATTEMPT_UNBOUND:');
    expect(readStageStatus(project, runId, 'work').attempts![0].status).toBe('running');
    expect(readStageStatus(project, runId, 'writer').attempts![0].status).toBe('running');
  });

  it('does not authenticate a failed143 attempt from an authored marker string', () => {
    prepare();
    completeStageAttempt(project, runId, 'work', 0, { exitCode: 143, duration_ms: 1, error: 'HOST_RESTART_INTERRUPTED: authored imitation' });
    const before = readFileSync(join(directory, 'stages/work/status.json'));
    const state = recover();
    expect(state.recovery?.reason).toContain('RECOVERY_INTENT_REQUIRED:');
    expect(state.stages.work.status).toBe('failed');
    expect(readFileSync(join(directory, 'stages/work/status.json'))).toEqual(before);
  });

  it('preserves cancellation even with prepared interruption intent', () => {
    prepare(); crash('intent');
    updateRunState(project, runId, state => { state.status = RUN_STATUS.STOPPED; });
    expect(recover().status).toBe(RUN_STATUS.STOPPED);
    expect(readStageStatus(project, runId, 'work').attempts![0].status).toBe('running');
  });

  it('blocks an incompatible generation before completing an interrupted attempt', () => {
    prepare(); crash('intent');
    expect(reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_after', currentGeneration: 'other_generation' }).recovery?.reason).toContain('RECOVERY_GENERATION_MISMATCH:');
    expect(readStageStatus(project, runId, 'work').attempts![0].status).toBe('running');
  });

  it('binds a later interruption to the claimed new checkpoint and attempt', () => {
    prepare(); recover();
    beginStageAttempt(project, runId, 'work', 0, '2026-10-03T00:01:00.000Z');
    updateRunState(project, runId, state => { state.status = 'running'; state.recovery!.kind = 'resuming'; state.engineCheckpoint!.bootId = 'boot_after'; state.engineCheckpoint!.at = '2026-10-03T00:01:00.000Z'; });
    const second = reconcileHostInterruptedRun(project, runId, { currentBootId: 'third_boot', currentGeneration: 'fixture_generation' });
    expect(second.stages.work.status).toBe('pending');
    expect(second.stages.work.attempts?.map(attempt => attempt.exitCode)).toEqual([143, 143]);
    expect(second.recoveryIntent?.stages[0].attempt.index).toBe(2);
  });

  it.each(['none', 'blocked', 'resumable'])('preserves stopped startup with %s recovery metadata before any execution', async kind => {
    prepare();
    if (kind !== 'none') recover();
    mkdirSync(join(directory, 'signals'));
    writeFileSync(join(directory, 'signals/abort.json'), 'Retain acknowledged cancellation');
    updateRunState(project, runId, state => {
      state.status = RUN_STATUS.STOPPED;
      state.failureReason = 'Cancelled by user';
      state.completedAt = startedAt;
      if (state.recovery && kind === 'blocked') state.recovery.kind = 'blocked';
    });
    const stopped = readRunState(project, runId);
    const paths = ['run.json', 'workflow.yaml', 'signals/abort.json', 'stages/work/status.json'];
    const before = paths.map(path => readFileSync(join(directory, path)));
    let executions = 0;
    const adapter = { run: async () => { executions++; throw new Error('Cancelled work executed'); } };
    const workflow = WorkflowConfigSchema.parse({ name: 'replacement', defaults: { max_iterations: 9 }, stages: [stage('work')] });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runWorkflow(workflow, '', project, adapter, new Map(), undefined, undefined, runId)).toEqual(stopped);
      expect(paths.map(path => readFileSync(join(directory, path)))).toEqual(before);
    }
    expect(executions).toBe(0);
    expect(existsSync(join(directory, 'scheduler.pid'))).toBe(false);
  });

  const cancellationPoints = [
    'before_entry', 'intent_release', 'closed_release', 'pending_release', 'between_stages',
    'commit_release', 'blocked_release', 'final_lock_before', 'blocked_lock_before',
    'intent_before', 'intent_after', 'closed_ledger_before', 'closed_ledger_after',
    'closed_projection_before', 'closed_projection_after', 'pending_ledger_before',
    'pending_ledger_after', 'pending_projection_before', 'pending_projection_after',
    'commit_before', 'commit_after', 'blocked_before', 'blocked_after', 'event_before', 'event_after',
  ];
  it.each(cancellationPoints)('preserves native separately acknowledged cancellation at %s', point => {
    prepare();
    if (point === 'between_stages') beginStageAttempt(project, runId, 'writer', 0, startedAt);
    const source = `
      import fs from 'node:fs'; import { spawn, spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [dist, project, fc, runId, point, output] = process.argv.slice(1);
      const directory = join(fc, 'runs', runId), lock = join(directory, '.run-state.lock');
      const ack = output + '.ack', waiting = output + '.waiting';
      const canceller = ${JSON.stringify(`
        import fs from 'node:fs'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
        import { syncBuiltinESMExports } from 'node:module';
        const [dist, project, fc, runId, ack, waiting] = process.argv.slice(1);
        const lock = join(fc, 'runs', runId, '.run-state.lock'), open = fs.openSync;
        fs.openSync = function(file, ...args) {
          try { return open(file, ...args); }
          catch (error) { if (String(file) === lock && error.code === 'EEXIST') fs.writeFileSync(waiting, 'queued on live recovery lock'); throw error; }
        }; syncBuiltinESMExports();
        const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
        const { RunCancellationCoordinator } = await import(pathToFileURL(join(dist, 'run-control.js')));
        const coordinator = new RunCancellationCoordinator({ registry: { list: () => [] }, units: { getStatus: async () => ({ kind: 'absent' }), stopUnit: async () => {}, listUnits: async () => [] }, runsDir: join(fc, 'runs') });
        const result = await coordinator.cancelRun(runId);
        const state = store.readRunState(project, runId);
        const ledgers = Object.fromEntries(Object.keys(state.stages).map(id => { const path = join(fc, 'runs', runId, 'stages', id, 'status.json'); return [id, fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null]; }));
        fs.writeFileSync(ack + '.tmp', JSON.stringify({ result, state, ledgers, at: new Date().toISOString(), waitedOnRecoveryLock: fs.existsSync(waiting) }));
        fs.renameSync(ack + '.tmp', ack);
      `)};
      const wait = file => { const end = Date.now() + 7000; while (!fs.existsSync(file)) { if (Date.now() >= end) throw new Error('Cancellation barrier not reached: ' + file); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };
      let hit = false, child, cancellationExit, eventHadRecoveryLock;
      function cancel(held) {
        if (hit) return; hit = true;
        const argv = ['--input-type=module', '-e', canceller, dist, project, fc, runId, ack, waiting];
        if (held) { child = spawn(process.execPath, argv, { stdio: 'ignore' }); wait(waiting); }
        else { const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 9000 }); cancellationExit = result.status; if (result.status !== 0) throw new Error('Native cancellation failed: ' + result.stderr); }
      }
      const rename = fs.renameSync, unlink = fs.unlinkSync, open = fs.openSync, nativeWrite = fs.writeSync;
      const descriptorPaths = new Map();
      function matches(file, record) {
        if (String(file) === join(directory, 'stages/work/status.json')) {
          return (point.startsWith('closed_ledger_') && record.status === 'failed') || (point.startsWith('pending_ledger_') && record.status === 'pending');
        }
        if (String(file) !== join(directory, 'run.json')) return false;
        const stage = record.stages.work;
        return (point.startsWith('intent_') && record.recoveryIntent?.phase === 'prepared' && stage.status === 'running')
          || (point.startsWith('closed_projection_') && stage.status === 'failed')
          || (point.startsWith('pending_projection_') && stage.status === 'pending')
          || (point.startsWith('commit_') && record.recoveryIntent?.phase === 'committed')
          || (point.startsWith('blocked_') && record.recovery?.kind === 'blocked');
      }
      fs.renameSync = function(from, to) {
        if (!hit && point.endsWith('_before') && matches(to, JSON.parse(fs.readFileSync(from, 'utf8')))) cancel(true);
        const result = rename(from, to);
        if (!hit && point.endsWith('_after') && matches(to, JSON.parse(fs.readFileSync(to, 'utf8')))) cancel(true);
        return result;
      };
      fs.openSync = function(file, ...args) {
        if (!hit && String(file) === lock && ['final_lock_before', 'blocked_lock_before'].includes(point)) {
          const state = JSON.parse(fs.readFileSync(join(directory, 'run.json')));
          if (point === 'blocked_lock_before' || state.stages.work.status === 'pending') cancel(false);
        }
        const descriptor = open(file, ...args);
        descriptorPaths.set(descriptor, String(file));
        return descriptor;
      };
      fs.unlinkSync = function(file) {
        const result = unlink(file);
        if (String(file) === lock) {
          if (hit && child) wait(ack);
          if (!hit) {
            const state = JSON.parse(fs.readFileSync(join(directory, 'run.json'))), stage = state.stages.work;
            const match = point === 'intent_release' ? state.recoveryIntent?.phase === 'prepared' && stage.status === 'running'
              : point === 'closed_release' ? stage.status === 'failed'
              : ['pending_release', 'between_stages'].includes(point) ? stage.status === 'pending'
              : point === 'commit_release' ? state.recoveryIntent?.phase === 'committed'
              : point === 'blocked_release' ? state.recovery?.kind === 'blocked' : false;
            if (match) cancel(false);
          }
        }
        return result;
      };
      fs.writeSync = function(descriptor, bytes, ...args) {
        const event = descriptorPaths.get(descriptor) === join(directory, 'events.jsonl') && String(bytes).includes('"type":"recovery_reconciled"');
        if (!hit && event && point === 'event_before') { eventHadRecoveryLock = fs.existsSync(lock); cancel(eventHadRecoveryLock); }
        const result = nativeWrite(descriptor, bytes, ...args);
        if (!hit && event && point === 'event_after') { eventHadRecoveryLock = fs.existsSync(lock); cancel(eventHadRecoveryLock); }
        return result;
      }; syncBuiltinESMExports();
      const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
      const recovery = await import(pathToFileURL(join(dist, 'restart-recovery.js')));
      if (point === 'before_entry') cancel(false);
      let error;
      try { recovery.reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_after', currentGeneration: point.startsWith('blocked_') ? 'different_generation' : 'fixture_generation' }); } catch (cause) { error = cause.message; }
      if (child) {
        cancellationExit = await new Promise(done => { child.once('exit', done); child.once('error', () => done(-1)); });
      }
      const acknowledged = fs.existsSync(ack) ? JSON.parse(fs.readFileSync(ack)) : undefined;
      const final = store.readRunState(project, runId);
      const ledgers = Object.fromEntries(Object.keys(final.stages).map(id => { const path = join(directory, 'stages', id, 'status.json'); return [id, fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null]; }));
      const beforeRepeat = fs.readFileSync(join(directory, 'run.json'), 'utf8');
      recovery.reconcileHostInterruptedRun(project, runId, { currentBootId: 'boot_after', currentGeneration: 'fixture_generation' });
      fs.writeFileSync(output, JSON.stringify({ hit, cancellationExit, eventHadRecoveryLock, acknowledged, final, ledgers, error, repeatUnchanged: beforeRepeat === fs.readFileSync(join(directory, 'run.json'), 'utf8') }));
    `;
    const output = join(root, 'cancellation.json');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, resolve('dist'), project, fcGlobalDir(), runId, point, output], { cwd: project, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.error).toBeUndefined();
    const observed = JSON.parse(readFileSync(output, 'utf8'));
    expect(observed.hit).toBe(true);
    expect(observed.cancellationExit).toBe(0);
    expect(observed.acknowledged.result.status).toBe('cancelled');
    expect(observed.acknowledged.state.status).toBe('stopped');
    expect(observed.final).toEqual(observed.acknowledged.state);
    expect(observed.ledgers).toEqual(observed.acknowledged.ledgers);
    expect(observed.final.failureReason).toBe('Cancelled by user');
    expect(observed.final.completedAt).toBe(observed.acknowledged.state.completedAt);
    expect(observed.repeatUnchanged).toBe(true);
    if (point.startsWith('event_')) {
      expect(observed.eventHadRecoveryLock).toBe(true);
      expect(observed.error).toBeUndefined();
      expect(observed.acknowledged.waitedOnRecoveryLock).toBe(true);
    } else if ((point.endsWith('_before') && !point.endsWith('lock_before')) || point.endsWith('_after')) expect(observed.acknowledged.waitedOnRecoveryLock).toBe(true);
  });
});
