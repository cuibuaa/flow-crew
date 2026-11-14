import './test-support/policy-runtime.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { runRecordPath } from '../src/run-layout.js';
import { seedAttemptValidation } from './test-support/attempt-validation.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { captureProjectTree, projectCommit, readEvidence } from '../src/evidence-ledger.js';
import { writeCampaignEntry, parseDispatchedStageConfig } from '../src/scheduler.js';
import { collectGateRuntimeFacts, findGateRecoveryStages } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { findCampaignPhaseMetadata } from '../src/scheduler/sched_policy/campaign.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from './test-support/create-run.js';
import { campaignsRoot, fcGlobalDir, readRunState, readStageStatus, runDir, setFcGlobalDir, writeRunState, writeStageStatus, type GateVerdict } from '../src/store.js';
import { readRunEvents, recordStageOutcome } from '../src/run-events.js';
import { classifyGateRecoveryFact } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { readGateEvaluation, settleGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { validationExecutionId } from '../src/scheduler/sched_settlement/gate-validation.js';
import * as gateValidation from '../src/scheduler/sched_settlement/gate-validation.js';
import * as projectValidation from '../src/project-validation.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { createScopeSafeStageRunner, settleStageGroup } from '../src/scheduler/sched_scope/stage-group.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

const previousHome = fcGlobalDir();
const gateId = 'review';
const startedAt = '2026-10-22T09:38:00.000Z';
const completedAt = '2026-10-22T09:39:00.000Z';
let root: string;
let projectDir: string;
let runId: string;
let runDirPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-result-'));
  projectDir = join(root, 'project');
  mkdirSync(projectDir);
  setFcGlobalDir(join(root, 'store'));
  ({ runId, runDirPath } = createRun(projectDir, 'gate-result', 'name: gate-result\nstages: []\n', [gateId]));
  writeStageStatus(projectDir, runId, gateId, {
    status: 'complete', retries: 0, exitCode: 0, completedAt,
    attempts: [{ index: 1, status: 'complete', startedAt, completedAt, exitCode: 0 }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setFcGlobalDir(previousHome);
  rmSync(root, { recursive: true, force: true });
});

function writeVerdict(verdict: Record<string, unknown>): string {
  const bytes = JSON.stringify(verdict) + '\n';
  writeFileSync(runRecordPath(runDirPath, `verdict_${gateId}.json`), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

function writeValidation(state: 'pass' | 'regression' | 'unresolved', seed = true, validationVersion?: number): void {
  const baselineBytes = JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline: {
    version: 1, projectDir, discovery: { state: 'configured', configPath: 'fixture', commands: [{ role: 'test', command: 'fixture', args: [], display: 'npm run test' }], missingRoles: [] }, results: [],
  } });
  writeFileSync(runRecordPath(runDirPath, 'validation_baseline.json'), baselineBytes);
  const reason = state === 'unresolved'
    ? 'Green baseline no longer passes, but current failure identity/count is unavailable'
    : state === 'regression' ? 'A green baseline no longer passes' : 'Green baseline remains green';
  const fact = seed ? seedAttemptValidation(projectDir, runId, [{ role: 'test', display: 'npm run test', state: state === 'pass' ? 'passed' : 'failed', exitCode: state === 'unresolved' ? null : state === 'pass' ? 0 : 1, durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'unknown' }], { validationVersion, delta: [{ role: 'test', display: 'npm run test', state, reason, newFailureIdentifiers: state === 'regression' ? ['spec/retained-failure.test.ts'] : [] }] }) : undefined;
  writeFileSync(runRecordPath(runDirPath, `validation_delta_${gateId}.json`), JSON.stringify({
    treeHash: captureProjectTree(projectDir).hash, ...(fact ? { ledgerSequence: fact.sequence } : {}),
    version: 2, stageId: gateId, checkedAt: completedAt, pass: state === 'pass',
    baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
    attemptIndex: 1, attemptStartedAt: startedAt, attemptCompletedAt: completedAt,
    executionId: validationExecutionId(runId, gateId, 1, startedAt, completedAt),
    current: [{ role: 'test', display: 'npm run test', state: state === 'pass' ? 'passed' : 'failed',
      exitCode: state === 'unresolved' ? null : state === 'pass' ? 0 : 1, durationMs: 1, output: '',
      failureIdentifiers: state === 'regression' ? ['spec/retained-failure.test.ts'] : [],
      failureIdentity: state === 'unresolved' ? 'unknown' : state === 'pass' ? 'none' : 'known' }],
    delta: [{ role: 'test', display: 'npm run test', state, reason,
      newFailureIdentifiers: state === 'regression' ? ['spec/retained-failure.test.ts'] : [] }],
  }));
}

describe('typed gate recovery routes', () => {
  it.each([
    ['validation_regression', 'Gate contract violation: unrelated wording', 'engine_contract_or_evidence_rejection'],
    ['validation_unresolved', 'Review omitted the research outcome', 'engine_contract_or_evidence_rejection'],
    ['research_outcome_absent', 'No prefix is required to describe this refusal', 'engine_contract_or_evidence_rejection'],
  ] as const)('routes %s by the engine refusal type', (kind, reason, rejectionKind) => {
    expect(classifyGateRecoveryFact(gateId, { pass: true }, { pass: false, reason, refusal: { kind } }).rejectionKind)
      .toBe(rejectionKind);
  });

  it.each([
    'The review omitted the research outcome',
    'Research round outcome is absent: no usable evidence',
    'Gate contract violation: this is the author describing a repairable defect',
  ])('keeps the declared repairability independent of its prose: %s', reason => {
    const verdict: GateVerdict = { pass: false, reason,
      repairability: { version: 1, disposition: 'repairable', evidence: 'A retained reproduction can be repaired' } };
    expect(classifyGateRecoveryFact(gateId, verdict, verdict).rejectionKind).toBe('repairable_failure');
  });

  it.each(['criterion_evidence', 'audit_findings'] as const)(
    'does not admit uncited authored FAIL to repair after a secondary %s refusal', kind => {
      const authored: GateVerdict = { pass: false,
        repairability: { version: 1, disposition: 'repairable', evidence: 'Reproducible product defect' } };
      const docs = join(projectDir, 'docs');
      mkdirSync(docs);
      writeFileSync(runRecordPath(docs, 'dispatch_admission.json'), JSON.stringify({ criterionGateRefs: { [gateId]: ['C1'] } }));
      const verdictPath = join(docs, `verdict_${gateId}.json`);
      writeFileSync(verdictPath, JSON.stringify({ ...authored,
        ...(kind === 'audit_findings' ? { audit_findings: { version: 1, findings: 'invalid' } } : {}) }));
      const effective = readGateEvaluation(projectDir, gateId)!;
      expect(effective).toMatchObject({ pass: false, refusal: { kind }, repairability: authored.repairability });
      const fact = classifyGateRecoveryFact(gateId, authored, effective);
      const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
      const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', retry_to: [gateId] });
      expect(fact.rejectionKind).toBe('repairable_failure');
      expect(findGateRecoveryStages([gate, repair], [gateId], { [gateId]: fact })
        .map(stage => stage.id)).toEqual([]);
      const irreparable: GateVerdict = { ...effective,
        repairability: { version: 1, disposition: 'irreparable', evidence: 'Required GPU unavailable' } };
      expect(classifyGateRecoveryFact(gateId, authored, irreparable).rejectionKind).toBe('irreparable_rejection');
      // Legacy author FAILs remain readable but do not establish confirmation.
      expect(classifyGateRecoveryFact(gateId, { pass: false }, { pass: false, refusal: { kind } }).rejectionKind)
        .toBe('repairable_failure');
    },
  );

  it('keeps an authored irreparable rejection terminal despite omission wording', () => {
    const verdict: GateVerdict = { pass: false, reason: 'The research outcome was omitted because the required GPU is unavailable',
      repairability: { version: 1, disposition: 'irreparable', evidence: 'The authorized environment cannot provide the required GPU' } };
    expect(classifyGateRecoveryFact(gateId, verdict, verdict).rejectionKind).toBe('irreparable_rejection');
  });
});

describe('settled gate results', () => {
  it('publishes an authored FAIL on a completed review in both the stage and its completion event', () => {
    // b7295c: the review process completed with exit 0 while its verdict rejected the work.
    const verdictSha256 = writeVerdict({ pass: false, reason: 'Required controller behavior remains incomplete' });
    settleGateEvaluation(projectDir, runId, gateId);
    const status = readStageStatus(projectDir, runId, gateId);
    expect(status).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: false, kind: 'repairable', verdictSha256 } });
    expect(readRunState(projectDir, runId).stages[gateId].gate).toEqual(status.gate);
    recordStageOutcome(projectDir, runId, gateId, 1, status);
    expect(readRunEvents(projectDir, runId).filter(event => event.type === 'stage_complete'))
      .toEqual([expect.objectContaining({ stageId: gateId, status: 'complete', gate: status.gate })]);
  });

  it('projects independent acceptance with stated unknown validation into campaign metadata', () => {
    writeVerdict({ pass: true, phase: 'delivery', phaseComplete: true, reason: 'Authored pass' });
    writeValidation('unresolved');
    settleGateEvaluation(projectDir, runId, gateId);
    expect(findCampaignPhaseMetadata(projectDir, readRunState(projectDir, runId)))
      .toMatchObject({ gate: gateId, pass: true, phase: 'delivery' });
    expect(readEvidence(runDirPath).filter(fact => fact.kind === 'validation').at(-1)?.pass).toBe(false);
  });

  it.each(['pass', 'unresolved'] as const)('publishes an independently accepted terminal study outcome with validation %s stated separately', validation => {
    writeVerdict({ pass: false, study_complete: true, model_success: false, reason: 'study_complete_without_model_success' });
    writeValidation(validation);
    settleGateEvaluation(projectDir, runId, gateId);
    const state = readRunState(projectDir, runId);
    state.campaignStorageKey = 'study-receipt';
    writeCampaignEntry(projectDir, state);
    const row = JSON.parse(readFileSync(join(campaignsRoot(), 'study-receipt.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ pass: true, gates: '1/1' });
    expect(row.terminalStudyComplete).toBe(true);
  });

  it('blocks acceptance on a completed nonzero exit without changing the completed process result', () => {
    const verdictSha256 = writeVerdict({ pass: true, reason: 'Independent product comparison passed' });
    writeValidation('regression');
    settleGateEvaluation(projectDir, runId, gateId);
    const status = readStageStatus(projectDir, runId, gateId);
    expect(status).toMatchObject({ status: 'complete', exitCode: 0,
      attempts: [{ status: 'complete', exitCode: 0 }],
      gate: { pass: false, kind: 'audit_findings', verdictSha256, refusal: { kind: 'audit_findings' } } });
    expect(classifyGateRecoveryFact(gateId, { pass: true }, status.gate!).rejectionKind)
      .toBe('repairable_failure');
  });

  it('retains unknown evidence without vetoing an independent acceptance or relabeling validation as passing', () => {
    const verdictSha256 = writeVerdict({ pass: true, reason: 'The independent gate accepted the stated limits' });
    writeValidation('unresolved');
    settleGateEvaluation(projectDir, runId, gateId);
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: true, kind: 'pass', verdictSha256 } });
    expect(readStageStatus(projectDir, runId, gateId).gate?.refusal).toBeUndefined();
    expect(readEvidence(runDirPath).filter(fact => fact.kind === 'validation').at(-1)?.pass).toBe(false);
  });

  it.each(['pass', 'regression'] as const)('keeps a failed reviewer with validation %s on its existing recovery route without an authored verdict', validation => {
    const status = readStageStatus(projectDir, runId, gateId);
    status.status = 'failed'; status.exitCode = 1;
    status.attempts![0].status = 'failed'; status.attempts![0].exitCode = 1;
    writeStageStatus(projectDir, runId, gateId, status);
    writeValidation(validation);
    settleGateEvaluation(projectDir, runId, gateId);
    const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
    const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: [gateId], retry_to: [gateId] });
    const facts = collectGateRuntimeFacts([gate, repair], readRunState(projectDir, runId), projectDir, runId);
    expect(facts.allPass).toBe(false);
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(readStageStatus(projectDir, runId, gateId).gate).toBeUndefined();
    expect(facts.rejectedGateIds).toEqual([]);
  });

  it.each(['pass', 'regression'] as const)('retains a settled %s decision when the authored and validation aliases change', initial => {
    const verdictSha256 = writeVerdict({ pass: true, reason: 'Original authored bytes' });
    writeValidation(initial);
    settleGateEvaluation(projectDir, runId, gateId);
    const original = readStageStatus(projectDir, runId, gateId).gate;
    expect(original).toMatchObject({ pass: initial === 'pass', verdictSha256 });
    writeVerdict({ pass: initial !== 'pass', reason: 'Later alias replacement' });
    writeValidation(initial === 'pass' ? 'regression' : 'pass', false);
    expect(readGateEvaluation(projectDir, gateId, runId)).toEqual(original);
    settleGateEvaluation(projectDir, runId, gateId);
    expect(readStageStatus(projectDir, runId, gateId).gate).toEqual(original);
    expect(readRunState(projectDir, runId).stages[gateId].gate).toEqual(original);
  });

  it.each([false, true])('reads a legacy authored pass=%s when the stage has no persisted gate result', pass => {
    const verdict = { pass, reason: 'Retained legacy verdict' };
    writeVerdict(verdict);
    expect(readStageStatus(projectDir, runId, gateId).gate).toBeUndefined();
    expect(readGateEvaluation(projectDir, gateId, runId)).toEqual(verdict);
  });

  it('reads the archived effective rejection for a legacy completed review without a live verdict', () => {
    const archive = runRecordPath(runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'rejected_verdict_review.json'), JSON.stringify({ pass: true }));
    writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({
      gateId, written_verdict_pass: true, engine_effective_pass: false,
      engine_rejection_reason: 'Retained validation regression',
      repairability: { version: 1, disposition: 'repairable', evidence: 'Retained validation receipt' },
    }));
    expect(readStageStatus(projectDir, runId, gateId).gate).toBeUndefined();
    expect(readGateEvaluation(projectDir, gateId, runId)).toEqual({ pass: false,
      reason: 'Retained validation regression',
      repairability: { version: 1, disposition: 'repairable', evidence: 'Retained validation receipt' } });
  });

  it.each([undefined, 'validation_regression'] as const)(
    'preserves archived author PASS / engine FAIL recovery with kind=%s', kind => {
      const archive = runRecordPath(runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'rejected_verdict_review.json'), JSON.stringify({ pass: true }));
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({
        gateId, written_verdict_pass: true, engine_effective_pass: false, kind,
        engine_rejection_reason: 'Archived engine rejection',
      }));
      const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
      const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', retry_to: [gateId] });
      const facts = collectGateRuntimeFacts([gate, repair], readRunState(projectDir, runId), projectDir, runId);
      const entry = facts.evaluations[0];
      expect(entry.authoredVerdict).toEqual({ pass: true });
      expect(entry.rejectionKind).toBe(kind ? undefined : 'engine_contract_or_evidence_rejection');
      if (kind) expect(entry.effectiveVerdict?.pass).toBe(true);
      const fact = classifyGateRecoveryFact(gateId, entry.authoredVerdict, entry.effectiveVerdict);
      expect(findGateRecoveryStages([gate, repair], facts.rejectedGateIds, { [gateId]: fact })
        .map(stage => stage.id)).toEqual([]);
    },
  );

  it.each(['validation_regression', 'validation_unresolved'] as const)('reads a kind-only historical %s as facts without overriding the independent gate', kind => {
    const digest = writeVerdict({ pass: true, reason: 'Independent acceptance of the unverified command' });
    writeValidation('regression', true, 3);
    const status = readStageStatus(projectDir, runId, gateId);
    status.gate = { pass: false, kind, verdictSha256: digest, reason: 'Historical code-owned validation veto' };
    writeStageStatus(projectDir, runId, gateId, status);
    const verdict = readGateEvaluation(projectDir, gateId, runId)!;
    expect(verdict.pass).toBe(true);
    expect(verdict.validation?.[0]).toMatchObject({ exitCode: 1, measurement: 'unverified' });
    expect(readStageStatus(projectDir, runId, gateId).gate?.pass).toBe(false);
  });

  it('does not accept an engine refusal classification supplied by the author', () => {
    writeVerdict({ pass: false, reason: 'Author rejected the output', refusal: { kind: 'validation_unresolved' } });
    expect(readGateEvaluation(projectDir, gateId, runId))
      .toEqual({ pass: false, reason: 'Author rejected the output' });
  });
});


describe('stage group settlement boundaries', () => {
  it('contains a validation launch exception during settlement', async () => {
    writeVerdict({ pass: true });
    writeValidation('pass');
    unlinkSync(runRecordPath(runDirPath, `validation_delta_${gateId}.json`));
    vi.spyOn(gateValidation, 'bindReviewedGateValidation').mockReturnValue(false);
    const record = vi.spyOn(gateValidation, 'recordGateValidationDelta');
    record.mockRejectedValue(new Error('fixture validation launch exception'));
    const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
    await expect(settleStageGroup(projectDir, runId, [gate])).resolves.toBeUndefined();
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: true, kind: 'pass' } });
    expect(record).toHaveBeenCalledOnce();
  });

  function serializedGroup() {
    const stages = ['first', gateId, 'deferred'].map(id => parseDispatchedStageConfig({
      id, role: id === gateId ? 'qa' : 'coder', scope: id === gateId ? [] : ['product.ts'], is_gate: id === gateId,
    }));
    const state = readRunState(projectDir, runId);
    for (const stage of stages) state.stages[stage.id] = { status: 'pending', retries: 0 };
    writeRunState(projectDir, runId, state);
    const baseline: projectValidation.ProjectValidationBaseline = {
      version: 1, projectDir,
      discovery: { state: 'configured', configPath: 'fixture', missingRoles: [],
        commands: [{ role: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], display: 'fixture test' }] },
      results: [{ role: 'test', display: 'fixture test', state: 'passed', exitCode: 0,
        durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'none' }],
    };
    writeFileSync(runRecordPath(runDirPath, 'validation_baseline.json'), JSON.stringify({
      version: 1, source: 'ship-setup-ready-record', baseline,
    }));
    const commands = vi.spyOn(projectValidation, 'runValidationCommand').mockImplementation(() =>
      existsSync(join(projectDir, 'product.ts'))
        ? { exitCode: 1, stdout: 'FAILED tests/test_product.py::test_missing_result\n1 failed' }
        : { exitCode: 0 });
    const bind = vi.spyOn(gateValidation, 'bindReviewedGateValidation');
    const runner = createScopeSafeStageRunner({
      reconcileCompletedStageAttempts: () => ({ violation: false }),
    });
    const executed: string[] = [];
    const execute = async (stage: typeof stages[number]) => {
      if (executed.includes(stage.id)) return;
      executed.push(stage.id);
      if (stage.is_gate) writeVerdict({ pass: true });
      if (stage.id === 'deferred') writeFileSync(join(projectDir, 'product.ts'), 'regressed');
      writeStageStatus(projectDir, runId, stage.id, {
        status: 'complete', retries: 0, exitCode: 0, completedAt,
        attempts: [{ index: 1, status: 'complete', startedAt, completedAt, exitCode: 0,
          writes: stage.id === 'deferred' ? ['product.ts'] : [], writeAttribution: 'snapshot' }],
      });
      if (stage.id === 'deferred') {
        const measured = await projectValidation.runProjectValidationBaseline(projectDir, { commands: baseline.discovery.commands, runCommand: request => projectValidation.runValidationCommand(request) });
        seedAttemptValidation(projectDir, runId, measured.results, { stageId: 'deferred' });
      }
    };
    return { stages, runner, execute, executed, commands, bind };
  }

  it('settles the complete serialized group using the later author writes', async () => {
    const f = serializedGroup();
    await f.runner.runScopeSafeStageGroup(f.stages, projectDir, runId, 1, f.execute);
    expect(f.executed).toEqual(['first', gateId, 'deferred']);
    expect(readFileSync(join(projectDir, 'product.ts'), 'utf8')).toBe('regressed');
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: false, kind: 'audit_findings' } });
    expect(readRunState(projectDir, runId).stages[gateId].gate).toMatchObject({ pass: false, kind: 'audit_findings' });
    const events = readRunEvents(projectDir, runId).filter(event => event.type === 'stage_complete');
    expect(events.map(event => event.stageId)).toEqual(['first', gateId, 'deferred']);
    expect(events.find(event => event.stageId === gateId)?.gate).toMatchObject({ pass: false, kind: 'audit_findings' });
    expect(f.bind).toHaveBeenCalledOnce();
    expect(f.commands).toHaveBeenCalledOnce();
  });

});

describe('validation at the review boundary', () => {
  it.each(['repaired', 'exhausted', 'launch_error'] as const)('rejects nonzero exits, validates changed repair trees, and hands unfinished facts to review: %s', async outcome => {
    for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base']]) isolatedProjectCommand('git', args, projectDir, root);
    const baseline: projectValidation.ProjectValidationBaseline = {
      version: 1, projectDir,
      discovery: { state: 'partial', configPath: 'fixture', missingRoles: ['build', 'lint'],
        commands: [{ role: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], display: 'opaque validation' }] },
      results: [{ role: 'test', display: 'opaque validation', state: 'passed', exitCode: 0,
        durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'none' }],
    };
    vi.spyOn(gateValidation, 'snapshotShipSetupValidationBaseline').mockImplementation((_project, _brief, directory) => {
      const artifact: gateValidation.RunValidationBaselineArtifact = {
        version: 1, source: 'ship-setup-ready-record', capturedAt: startedAt, baseCommit: projectCommit(projectDir), baseline,
      };
      writeFileSync(runRecordPath(directory, 'validation_baseline.json'), JSON.stringify(artifact));
      return artifact;
    });
    const commands = vi.spyOn(projectValidation, 'runValidationCommand')
      .mockImplementation(request => outcome === 'launch_error'
        ? { exitCode: null, error: 'spawn validation ENOENT' }
        : request.cwd !== projectDir ? { exitCode: 0 } : outcome === 'repaired' && adapter.calls.some(call => call.stageId === 'repair')
          ? { exitCode: 0 }
          : { exitCode: 1, stderr: 'Serialized Error: { code: \'ENOENT\', syscall: \'open\', path: \'fixture.json\' }' });
    const workflow = WorkflowConfigSchema.parse({ name: 'validation-review',
      defaults: { max_iterations: 2, max_retries: 0 },
      stages: [
        { id: 'work', role: 'coder', scope: ['product.txt'], artifact_contract: fixtureArtifactContract('work') },
        { id: gateId, role: 'qa', scope: [], depends_on: ['work'], is_gate: true,
          artifact_contract: fixtureArtifactContract(gateId, true) },
        { id: 'repair', role: 'coder', scope: ['product.txt'], depends_on: [gateId], retry_to: [gateId],
          artifact_contract: fixtureArtifactContract('repair') },
      ],
    });
    const adapter = new ScriptedAdapter({ work: { output: 'Work completed', projectFiles: { 'product.txt': 'bad' } },
      [gateId]: { output: 'Independent review accepted', runFiles: { 'verdict_review.json': JSON.stringify({ pass: true, reason: 'Semantic review passed' }) } },
      repair: { output: 'Repair the missing fixture', ...(outcome === 'repaired' ? { projectFiles: { 'product.txt': 'good' } } : {}) },
      _summary: { output: 'summary' },
    });
    const final = await runWorkflow(workflow, '', projectDir, adapter, new Map(), undefined, join(import.meta.dirname, '..', 'config', 'agents'), undefined,
      'Review the completed fixture using its configured validation.', true);
    const repairs = adapter.calls.filter(call => call.stageId === 'repair');
    const confirmed = outcome !== 'launch_error';
    expect(final.status, final.failureReason).toBe(outcome === 'repaired' ? 'complete' : 'incomplete');
    const ledger = readEvidence(runDir(projectDir, final.runId));
    if (!confirmed) {
      expect(adapter.calls.map(call => call.stageId)).toEqual(['work', gateId]);
      expect(repairs).toHaveLength(0);
      expect(commands).toHaveBeenCalledTimes(3);
      const fact = ledger.filter(fact => fact.kind === 'validation').at(-1)!;
      expect(fact).toMatchObject({ resourceState: 'unfinished', executions: expect.any(Array) });
      expect(fact.executions).toHaveLength(3);
      expect(fact.executions.map(execution => execution.commands.map(command => command.exitCode))).toEqual([[null], [null], [null]]);
      expect(adapter.calls.find(call => call.stageId === gateId)!.prompt).toContain(JSON.stringify(fact));
      expect(final.reasonCode).toBe('validation_unresolved');
      expect(final.stages[gateId]).toMatchObject({ status: 'complete', gate: { pass: true, kind: 'pass' } });
      expect(readRunEvents(projectDir, final.runId).filter(event => event.type === 'stage_complete').map(event => event.stageId)).toEqual(['work', gateId]);
      expect(final.stages.work.attempts).toHaveLength(1);
    } else {
      expect(final.stages[gateId]).toMatchObject({ status: 'complete', exitCode: 0,
        gate: { pass: outcome === 'repaired', kind: outcome === 'repaired' ? 'pass' : 'audit_findings' } });
      expect(repairs).toHaveLength(outcome === 'repaired' ? 1 : 3);
      expect(commands).toHaveBeenCalledTimes(outcome === 'repaired' ? 2 : 1);
      // Engine nonzero facts are already reproductions. An unchanged repair
      // reuses them; only the actual source repair earns a new execution.
      expect(ledger.filter(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)).toEqual([]);
      expect(ledger.filter(fact => fact.kind === 'validation').at(-1)?.pass).toBe(outcome === 'repaired');
    }
  });
});
