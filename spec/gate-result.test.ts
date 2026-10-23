import './test-support/policy-runtime.js';
import { writeCampaignEntry, parseDispatchedStageConfig } from '../src/scheduler.js';
import { collectGateRuntimeFacts, findGateRecoveryStages } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { findCampaignPhaseMetadata } from '../src/scheduler/sched_policy/campaign.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from './test-support/create-run.js';
import { campaignsRoot, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState, writeStageStatus, type GateVerdict } from '../src/store.js';
import { readRunEvents, recordStageOutcome } from '../src/run-events.js';
import { classifyGateRecoveryFact } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { readGateEvaluation, settleGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { validationExecutionId } from '../src/scheduler/sched_settlement/gate-validation.js';
import * as gateValidation from '../src/scheduler/sched_settlement/gate-validation.js';
import * as projectValidation from '../src/project-validation.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
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
  writeFileSync(join(runDirPath, `verdict_${gateId}.json`), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

function writeValidation(state: 'pass' | 'regression' | 'unresolved'): void {
  const baselineBytes = JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline: {
    version: 1, projectDir, discovery: { state: 'configured', configPath: 'fixture', commands: [], missingRoles: [] }, results: [], gateCriteria: [],
  } });
  writeFileSync(join(runDirPath, 'validation_baseline.json'), baselineBytes);
  const reason = state === 'unresolved'
    ? 'Green baseline no longer passes, but current failure identity/count is unavailable'
    : state === 'regression' ? 'A green baseline no longer passes' : 'Green baseline remains green';
  writeFileSync(join(runDirPath, `validation_delta_${gateId}.json`), JSON.stringify({
    version: 2, stageId: gateId, checkedAt: completedAt, pass: state === 'pass',
    baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
    attemptIndex: 1, attemptStartedAt: startedAt, attemptCompletedAt: completedAt,
    executionId: validationExecutionId(runId, gateId, 1, startedAt, completedAt),
    current: [{ role: 'test', display: 'npm run test', state: state === 'pass' ? 'passed' : 'failed',
      exitCode: state === 'pass' ? 0 : 1, durationMs: 1, output: '',
      failureIdentifiers: state === 'regression' ? ['spec/retained-failure.test.ts'] : [],
      failureIdentity: state === 'unresolved' ? 'unknown' : state === 'pass' ? 'none' : 'known' }],
    delta: [{ role: 'test', display: 'npm run test', state, reason,
      newFailureIdentifiers: state === 'regression' ? ['spec/retained-failure.test.ts'] : [] }],
  }));
}

describe('typed gate recovery routes', () => {
  it.each([
    ['validation_regression', 'Gate contract violation: unrelated wording', 'repairable_failure'],
    ['validation_unresolved', 'Review omitted the research outcome', 'engine_contract_or_evidence_rejection'],
    ['research_outcome_absent', 'No prefix is required to describe this refusal', 'omitted_research_outcome'],
  ] as const)('routes %s by the engine refusal type', (kind, reason, rejectionKind) => {
    expect(classifyGateRecoveryFact(gateId, { pass: true }, { pass: false, reason, refusal: { kind } }).rejectionKind)
      .toBe(rejectionKind);
  });

  it.each([
    'The review omitted the research outcome',
    'Research round outcome is absent: no usable evidence',
    'Gate contract violation: this is the author describing a repairable defect',
  ])('keeps an authored repairable rejection independent of its prose: %s', reason => {
    const verdict: GateVerdict = { pass: false, reason,
      repairability: { version: 1, disposition: 'repairable', evidence: 'A retained reproduction can be repaired' } };
    expect(classifyGateRecoveryFact(gateId, verdict, verdict).rejectionKind).toBe('repairable_failure');
  });

  it.each(['criterion_evidence', 'audit_findings'] as const)(
    'keeps an authored FAIL repairable after a secondary %s refusal', kind => {
      const authored: GateVerdict = { pass: false,
        repairability: { version: 1, disposition: 'repairable', evidence: 'Reproducible product defect' } };
      const docs = join(projectDir, 'docs');
      mkdirSync(docs);
      writeFileSync(join(docs, 'dispatch_admission.json'), JSON.stringify({ criterionGateRefs: { [gateId]: ['C1'] } }));
      const verdictPath = join(docs, `verdict_${gateId}.json`);
      writeFileSync(verdictPath, JSON.stringify({ ...authored,
        ...(kind === 'audit_findings' ? { audit_findings: { version: 1, findings: 'invalid' } } : {}) }));
      const effective = readGateEvaluation(projectDir, gateId)!;
      expect(effective).toMatchObject({ pass: false, refusal: { kind }, repairability: authored.repairability });
      const fact = classifyGateRecoveryFact(gateId, authored, effective);
      const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
      const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', retry_to: [gateId] });
      expect(fact.rejectionKind).toBe('repairable_failure');
      expect(findGateRecoveryStages([gate, repair], [gateId], undefined, { [gateId]: fact })
        .map(stage => stage.id)).toEqual(['repair']);
      const irreparable: GateVerdict = { ...effective,
        repairability: { version: 1, disposition: 'irreparable', evidence: 'Required GPU unavailable' } };
      expect(classifyGateRecoveryFact(gateId, authored, irreparable).rejectionKind).toBe('irreparable_rejection');
      // Legacy author FAILs without a disposition keep the same repair route.
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

  it('projects a failed effective gate into campaign metadata despite an authored PASS', () => {
    writeVerdict({ pass: true, phase: 'delivery', phaseComplete: true, reason: 'Authored pass' });
    writeValidation('unresolved');
    settleGateEvaluation(projectDir, runId, gateId);
    expect(findCampaignPhaseMetadata(projectDir, readRunState(projectDir, runId)))
      .toMatchObject({ gate: gateId, pass: false, phase: 'delivery' });
  });

  it.each(['pass', 'unresolved'] as const)('publishes a terminal study campaign outcome only when its settled validation is %s', validation => {
    writeVerdict({ pass: false, study_complete: true, model_success: false, reason: 'study_complete_without_model_success' });
    writeValidation(validation);
    settleGateEvaluation(projectDir, runId, gateId);
    const state = readRunState(projectDir, runId);
    state.campaignStorageKey = 'study-receipt';
    writeCampaignEntry(projectDir, state);
    const row = JSON.parse(readFileSync(join(campaignsRoot(), 'study-receipt.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ pass: validation === 'pass', gates: validation === 'pass' ? '1/1' : '0/1' });
    expect(row.terminalStudyComplete).toBe(validation === 'pass' ? true : undefined);
  });

  it.each(['unresolved', 'regression'] as const)('records validation %s as a rejected gate without changing the completed process result', state => {
    const verdictSha256 = writeVerdict({ pass: true, reason: 'The model accepted the output' });
    writeValidation(state);
    settleGateEvaluation(projectDir, runId, gateId);
    const status = readStageStatus(projectDir, runId, gateId);
    expect(status).toMatchObject({ status: 'complete', exitCode: 0,
      attempts: [{ status: 'complete', exitCode: 0 }],
      gate: { pass: false, kind: `validation_${state}`, verdictSha256, refusal: { kind: `validation_${state}` } } });
    expect(classifyGateRecoveryFact(gateId, { pass: true }, status.gate!).rejectionKind)
      .toBe(state === 'regression' ? 'repairable_failure' : 'engine_contract_or_evidence_rejection');
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
    if (validation === 'regression') {
      const result = readStageStatus(projectDir, runId, gateId).gate;
      expect(result).toMatchObject({ pass: false, kind: 'validation_regression', verdictSha256: null });
      expect(readGateEvaluation(projectDir, gateId, runId)).toEqual(result);
      expect(facts.rejectedGateIds).toEqual([gateId]);
      const fact = classifyGateRecoveryFact(gateId, null, result!);
      expect(findGateRecoveryStages([gate, repair], [gateId], undefined, { [gateId]: fact }).map(stage => stage.id)).toEqual(['repair']);
    } else {
      expect(readStageStatus(projectDir, runId, gateId).gate).toBeUndefined();
      expect(facts.rejectedGateIds).toEqual([]);
    }
  });

  it.each(['pass', 'regression'] as const)('retains a settled %s decision when the authored and validation aliases change', initial => {
    const verdictSha256 = writeVerdict({ pass: true, reason: 'Original authored bytes' });
    writeValidation(initial);
    settleGateEvaluation(projectDir, runId, gateId);
    const original = readStageStatus(projectDir, runId, gateId).gate;
    expect(original).toMatchObject({ pass: initial === 'pass', verdictSha256 });
    writeVerdict({ pass: initial !== 'pass', reason: 'Later alias replacement' });
    writeValidation(initial === 'pass' ? 'regression' : 'pass');
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
    const archive = join(runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
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
      const archive = join(runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
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
      expect(entry.rejectionKind).toBe(kind ? 'repairable_failure' : 'engine_contract_or_evidence_rejection');
      const fact = classifyGateRecoveryFact(gateId, entry.authoredVerdict, entry.effectiveVerdict);
      expect(findGateRecoveryStages([gate, repair], facts.rejectedGateIds, undefined, { [gateId]: fact })
        .map(stage => stage.id)).toEqual(kind ? ['repair'] : []);
    },
  );

  it('does not accept an engine refusal classification supplied by the author', () => {
    writeVerdict({ pass: false, reason: 'Author rejected the output', refusal: { kind: 'validation_unresolved' } });
    expect(readGateEvaluation(projectDir, gateId, runId))
      .toEqual({ pass: false, reason: 'Author rejected the output' });
  });
});


describe('stage group settlement boundaries', () => {
  it.each(['initial', 'retry'] as const)('contains a validation launch exception during %s settlement', async phase => {
    writeVerdict({ pass: true });
    writeValidation('pass');
    unlinkSync(join(runDirPath, `validation_delta_${gateId}.json`));
    vi.spyOn(gateValidation, 'bindReviewedGateValidation').mockReturnValue(false);
    const record = vi.spyOn(gateValidation, 'recordGateValidationDelta');
    const retry = vi.spyOn(gateValidation, 'settleGateValidationEvidence');
    if (phase === 'initial') record.mockRejectedValue(new Error('fixture validation launch exception'));
    else {
      record.mockResolvedValue(undefined);
      retry.mockRejectedValue(new Error('fixture validation retry launch exception'));
    }
    const gate = parseDispatchedStageConfig({ id: gateId, role: 'qa', is_gate: true });
    await expect(settleStageGroup(projectDir, runId, [gate])).resolves.toBeUndefined();
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: false, kind: 'validation_unresolved' } });
    expect(record).toHaveBeenCalledOnce();
  });

  function interruptedGroup(control: 'parked' | 'paused') {
    const stages = ['first', gateId, 'deferred'].map(id => parseDispatchedStageConfig({
      id, role: id === gateId ? 'qa' : 'coder', scope: ['product.ts'], is_gate: id === gateId,
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
      gateCriteria: [],
    };
    writeFileSync(join(runDirPath, 'validation_baseline.json'), JSON.stringify({
      version: 1, source: 'ship-setup-ready-record', baseline,
    }));
    const commands = vi.spyOn(projectValidation, 'runValidationCommand').mockImplementation(() =>
      existsSync(join(projectDir, 'product.ts'))
        ? { exitCode: 1, stdout: 'FAILED tests/test_product.py::test_missing_result\n1 failed' }
        : { exitCode: 0 });
    const bind = vi.spyOn(gateValidation, 'bindReviewedGateValidation');
    const retry = vi.spyOn(gateValidation, 'settleGateValidationEvidence');
    let wave = 0;
    const runner = createScopeSafeStageRunner({
      // Both controls use the wave's interruption result. Literal `paused` is
      // deliberately retained here rather than relabelled as `parked`.
      monitorApprovalRequests: async () => ++wave === 2
        ? { ...readRunState(projectDir, runId), status: control as typeof state.status } : null,
      reconcileCompletedStageAttempts: () => ({ violation: false }),
    });
    const executed: string[] = [];
    const execute = async (stage: typeof stages[number]) => {
      // On resume the caller continues unfinished attempts in the same group.
      if (executed.includes(stage.id)) return;
      executed.push(stage.id);
      if (stage.is_gate) writeVerdict({ pass: true });
      if (stage.id === 'deferred') writeFileSync(join(projectDir, 'product.ts'), 'regressed');
      writeStageStatus(projectDir, runId, stage.id, {
        status: 'complete', retries: 0, exitCode: 0, completedAt,
        attempts: [{ index: 1, status: 'complete', startedAt, completedAt, exitCode: 0,
          writes: stage.id === 'deferred' ? ['product.ts'] : [], writeAttribution: 'snapshot' }],
      });
    };
    return { stages, runner, execute, executed, commands, bind, retry };
  }

  it.each(['parked', 'paused'] as const)('records finished stages without settling a %s group', async control => {
    const f = interruptedGroup(control);
    await f.runner.runScopeSafeStageGroup(f.stages, projectDir, runId, 1, f.execute);
    expect(f.executed).toEqual(['first', gateId]);
    const events = readRunEvents(projectDir, runId).filter(event => event.type === 'stage_complete');
    expect(events.map(event => event.stageId)).toEqual(['first', gateId]);
    expect(events.every(event => event.gate === undefined)).toBe(true);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
    expect(f.commands).not.toHaveBeenCalled();
    expect(readStageStatus(projectDir, runId, gateId).gate).toBeUndefined();
    expect(readRunState(projectDir, runId).stages[gateId]).toMatchObject({ status: 'complete', exitCode: 0 });
    expect(readRunState(projectDir, runId).stages[gateId].gate).toBeUndefined();
    expect(existsSync(join(runDirPath, `validation_delta_${gateId}.json`))).toBe(false);
    expect(readRunState(projectDir, runId).stages.deferred).toEqual({ status: 'pending', retries: 0 });
    expect(existsSync(join(runDirPath, 'stages', 'deferred', 'status.json'))).toBe(false);
  });

  it.each(['parked', 'paused'] as const)('settles a resumed %s group using its deferred author writes', async control => {
    const f = interruptedGroup(control);
    await f.runner.runScopeSafeStageGroup(f.stages, projectDir, runId, 1, f.execute);
    expect(f.executed).toEqual(['first', gateId]);
    await f.runner.runScopeSafeStageGroup(f.stages, projectDir, runId, 1, f.execute);
    expect(f.executed).toEqual(['first', gateId, 'deferred']);
    expect(readFileSync(join(projectDir, 'product.ts'), 'utf8')).toBe('regressed');
    expect(readStageStatus(projectDir, runId, gateId)).toMatchObject({ status: 'complete', exitCode: 0,
      gate: { pass: false, kind: 'validation_regression' } });
    expect(readRunState(projectDir, runId).stages[gateId].gate).toMatchObject({ pass: false, kind: 'validation_regression' });
    expect(f.bind).toHaveBeenCalledOnce();
    expect(f.retry).toHaveBeenCalledOnce();
    expect(f.commands).toHaveBeenCalledOnce();
  });
});

describe('validation at the review boundary', () => {
  it.each(['repaired', 'exhausted', 'launch_error'] as const)('routes a green baseline failure through the bounded gate loop: %s', async outcome => {
    const baseline: projectValidation.ProjectValidationBaseline = {
      version: 1, projectDir,
      discovery: { state: 'partial', configPath: 'fixture', missingRoles: ['build', 'lint'],
        commands: [{ role: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], display: 'opaque validation' }] },
      results: [{ role: 'test', display: 'opaque validation', state: 'passed', exitCode: 0,
        durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'none' }],
      gateCriteria: [],
    };
    vi.spyOn(gateValidation, 'snapshotShipSetupValidationBaseline').mockImplementation((_project, _brief, directory) => {
      const artifact: gateValidation.RunValidationBaselineArtifact = {
        version: 1, source: 'ship-setup-ready-record', capturedAt: startedAt, baseline,
      };
      writeFileSync(join(directory, 'validation_baseline.json'), JSON.stringify(artifact));
      return artifact;
    });
    const commands = vi.spyOn(projectValidation, 'runValidationCommand')
      .mockImplementation(() => outcome === 'launch_error'
        ? { exitCode: null, error: 'spawn validation ENOENT' }
        : outcome === 'repaired' && adapter.calls.some(call => call.stageId === 'repair')
          ? { exitCode: 0 }
          : { exitCode: 1, stderr: 'Serialized Error: { code: \'ENOENT\', syscall: \'open\', path: \'fixture.json\' }' });
    const workflow = WorkflowConfigSchema.parse({ name: 'validation-review',
      defaults: { max_iterations: 2, max_retries: 0 },
      stages: [
        { id: 'work', role: 'coder', scope: [], artifact_contract: fixtureArtifactContract('work') },
        { id: gateId, role: 'qa', scope: [], depends_on: ['work'], is_gate: true,
          artifact_contract: fixtureArtifactContract(gateId, true) },
        { id: 'repair', role: 'coder', scope: [], depends_on: [gateId], retry_to: [gateId],
          artifact_contract: fixtureArtifactContract('repair') },
      ],
    });
    const adapter = new ScriptedAdapter({ work: { output: 'Work completed' },
      [gateId]: { output: 'Independent review accepted', runFiles: { 'verdict_review.json': JSON.stringify({ pass: true, reason: 'Semantic review passed' }) } },
      repair: { output: 'Repair the missing fixture' },
      _summary: { output: 'summary' },
    });
    const final = await runWorkflow(workflow, '', projectDir, adapter, new Map(), undefined, join(import.meta.dirname, '..', 'config', 'agents'), undefined,
      'Review the completed fixture using its configured validation.', true);
    const repairs = adapter.calls.filter(call => call.stageId === 'repair');
    if (outcome === 'launch_error') {
      expect(final.status, final.failureReason).toBe('failed');
      expect(final.stages[gateId]).toMatchObject({ status: 'complete', exitCode: 0,
        gate: { pass: false, kind: 'validation_unresolved' } });
      expect(repairs).toHaveLength(0);
      expect(commands).toHaveBeenCalledTimes(2);
    } else {
      expect(final.status, final.failureReason).toBe(outcome === 'repaired' ? 'complete' : 'incomplete');
      expect(repairs).toHaveLength(outcome === 'repaired' ? 1 : 3);
      const gateEvents = readRunEvents(projectDir, final.runId)
        .filter(event => event.type === 'stage_complete' && event.stageId === gateId);
      expect(gateEvents[0]).toMatchObject({ gate: { pass: false, kind: 'validation_regression' } });
      if (outcome === 'repaired') expect(final.stages[gateId].gate).toMatchObject({ pass: true });
      else expect(final.stages[gateId].gate).toMatchObject({ pass: false, kind: 'validation_regression' });
    }
  });
});
