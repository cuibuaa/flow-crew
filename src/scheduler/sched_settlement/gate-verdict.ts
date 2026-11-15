import { readAdmittedContract } from '../../brief-criteria.js';
import { gateCriterionRefs } from '../../handoff.js';
import { runRecordPath, stageWorkPath } from '../../run-layout.js';
// Boundary: Select and evaluate authored verdict carriers, project terminal-study evidence, derive digest-bound criterion discharges; no stage launching.
import { projectValidationResult } from '../../project-validation.js';
import { GATE_OUTCOMES, projectLegacyFindings, validateFindingVerdict, readArchivedAuditFindings } from '../../scoped-audit-repair.js';
import { CriterionDischargeRecord, GateVerdict, STAGE_STATUS, StageEvidenceRecord, StoreState, readRunState, readStageStatus, writeStageStatus, runDir, stageDir } from '../../store.js';
import { declaredOutputFacts } from '../../run-state-access.js';
import { StageConfig, isTerminalStudyCompletionArtifact } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract, validateVerdictAgainstContract } from './gate-contract.js';
import { projectGateVerdict, readGateVerdictDocument, GateVerdictDocument, validateSettledGateVerdict, explicitPassContradiction, validateGateCriterionEvidence, validateGateRepairability, assignedGateCriterionRefs } from './gate-evidence.js';
import { archivedGateRejections } from './gate-archives.js';
import { currentValidationResults, currentValidationFailures } from './gate-validation.js';

export function readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null {
  const base = runDir(projectDir, runId);
  try {
    const parsed = JSON.parse(readFileSync(runRecordPath(base, `verdict_${stageId}.json`), 'utf-8')) as Record<string, unknown>;
    const verdict = projectGateVerdict(parsed);
    if ((!verdict.outcome || verdict.pass) && isTerminalStudyCompletionArtifact(parsed) && !('repairability' in parsed)) return parsed;
  } catch { /* optional */ }
  return null;
}

export function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(runRecordPath(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');

}

/** Read the settled engine result; legacy runs without it use the same evaluator. */
export function readGateEvaluation(
  projectDir: string, stageId: string, runId?: string, contract?: GateContract | null,
  _requireValidationDelta = true,
): GateVerdict | null {
  let state: StoreState | undefined;
  try { state = runId ? readRunState(projectDir, runId) : undefined; }
  catch { /* Legacy authored verdicts remain readable without run state. */ }
  const accepted = state?.stages[stageId];
  if (contract === undefined && state && runId) contract = state.research ? null : loadGateContract(projectDir, runId, state.campaignStorageKey);
  if (accepted?.continuation) return null;
  if (accepted?.status === STAGE_STATUS.COMPLETE || accepted?.status === STAGE_STATUS.FAILED) {
    if (accepted.gate) return projectLegacyGateAssessment(projectDir, runId!, stageId, accepted.gate);
    if (accepted.status === STAGE_STATUS.COMPLETE && accepted.acceptedFrom) return projectLegacyGateAssessment(projectDir, runId!, stageId, accepted.acceptedFrom.verdict);
  }
  if (accepted?.status === STAGE_STATUS.FAILED) return null;
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const document = readGateVerdictDocument(base, stageId);
  if (!document && runId && accepted?.status === STAGE_STATUS.COMPLETE) {
    const archived = archivedGateRejections(base, stageId).at(-1);
    try {
      const record = JSON.parse(readFileSync(archived!.effectiveVerdictPath, 'utf8'));
      if (record.kind === 'validation_regression' || record.kind === 'validation_unresolved') {
        const bytes = readFileSync(archived!.verdictPath);
        const authored = new GateVerdictDocument(bytes);
        return settleDeclaredValidation(evaluateGateVerdict(authored, projectDir, stageId, runId, contract, true), authored, projectDir, stageId, runId);
      }
      if (typeof record.engine_effective_pass === 'boolean') return { pass: record.engine_effective_pass,
        reason: record.engine_rejection_reason,
        ...(GATE_OUTCOMES.includes(record.outcome) ? { outcome: record.outcome } : {}),
        ...(record.kind && !['pass', 'repairable', 'irreparable'].includes(record.kind) ? { refusal: { kind: record.kind } } : {}),
        ...(record.repairability ? { repairability: record.repairability } : {}),
        ...(record.findings ? { findings: record.findings } : {}) };
    } catch { /* No live verdict or readable archived conclusion. */ }
  }
  return settleDeclaredValidation(evaluateGateVerdict(document, projectDir, stageId, runId, contract, true), document, projectDir, stageId, runId);
}

/** Old settled verdicts predate the derived projection. Read it without
 * rewriting their authored bytes or historical engine conclusion. */
export function projectLegacyGateAssessment(projectDir: string, runId: string, stageId: string, verdict: GateVerdict): GateVerdict {
  const document = readGateVerdictDocument(runDir(projectDir, runId), stageId);
  const kind = verdict.refusal?.kind ?? ('kind' in verdict ? verdict.kind : undefined);
  if ((kind === 'validation_regression' || kind === 'validation_unresolved') && !verdict.validation) {
    return settleDeclaredValidation(evaluateGateVerdict(document, projectDir, stageId, runId, undefined, true), document, projectDir, stageId, runId)
      ?? { pass: false, refusal: { kind: 'missing_verdict' }, reason: 'Historical validation refusal has no independent gate verdict' };
  }
  if (verdict.outcome) return verdict;
  return projectLegacyFindings({ ...verdict, ...(verdict.validation ? { validation: verdict.validation.map(result => ({
    ...result, storedState: result.storedState ?? result.state, ...projectValidationResult(result),
  })) } : {}) }, document?.value.audit_findings);
}

/** Publish once, after the group has bound its post-write validation receipt. */
export function settleGateEvaluation(projectDir: string, runId: string, stageId: string): void {
  const status = readStageStatus(projectDir, runId, stageId);
  if ((status.status !== STAGE_STATUS.COMPLETE && status.status !== STAGE_STATUS.FAILED) || status.continuation || status.gate) return;
  const state = readRunState(projectDir, runId);
  const document = readGateVerdictDocument(runDir(projectDir, runId), stageId);
  const rawVerdict = evaluateGateVerdict(document, projectDir, stageId, runId, state.research ? null : loadGateContract(projectDir, runId, state.campaignStorageKey))
    ?? { pass: false, refusal: { kind: 'missing_verdict' as const }, reason: 'Gate did not produce a verdict' };
  const verdict = settleDeclaredValidation(rawVerdict, document, projectDir, stageId, runId)!;
  if (status.status === STAGE_STATUS.FAILED) return;
  status.gate = { ...verdict, kind: verdict.refusal?.kind ?? (verdict.pass ? 'pass' : verdict.outcome === 'rejected_irreparable' ? 'irreparable' : verdict.repairability?.disposition ?? 'repairable'), verdictSha256: document?.digest ?? null };
  writeStageStatus(projectDir, runId, stageId, status);
}

/** Preserve the gate outcome; declared validation exits supply the operator floor. */
function settleDeclaredValidation(verdict: GateVerdict | null, document: GateVerdictDocument | null,
  projectDir: string, stageId: string, runId?: string): GateVerdict | null {
  if (!verdict || !document || !runId) return verdict;
  const findings = document.project().outcome ? undefined : projectLegacyFindings(verdict, document.value.audit_findings).findings;
  const regressions = currentValidationFailures(projectDir, runId);
  const results = currentValidationResults(projectDir, runId);
  const validation = results.map(result => ({
    role: result.role, display: result.display, command: result.command, args: result.args, env: result.env, totals: result.totals, testsRun: result.testsRun, failureCount: result.failureCount, exitCode: result.exitCode, error: result.error, unfinished: result.unfinished, dependencyPreparationFailed: result.dependencyPreparationFailed,
    load: result.load, sourceBound: result.sourceBound, storedState: result.storedState ?? result.state, ...projectValidationResult(result),
  }));
  const unverified = validation.filter(result => result.measurement === 'unverified');
  const validationNote = unverified.length ? ` Validation unverified: ${unverified.map(result => `${result.display ?? result.role} (exit ${result.exitCode ?? 'absent'})`).join('; ')}.` : '';
  const { findings: _findings, validation: _validation, ...authored } = verdict;
  const reason = `${verdict.reason ?? ''}${regressions.length ? ` Engine validation rejected: ${regressions.map(command => command.display ?? command.command).join('; ')}.` : ''}${validationNote}`;
  return { ...authored,
    ...(regressions.length ? { pass: false, refusal: { kind: 'validation_regression' as const } } : {}),
    ...(findings ? { findings } : {}), ...(validation.length ? { validation } : {}), ...(reason ? { reason } : {}) };
}

function evaluateGateVerdict(document: GateVerdictDocument | null, projectDir: string, stageId: string, runId?: string,
  contract?: GateContract | null, recorded = false): GateVerdict | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const raw = document?.value;
  if (!raw) return null;
  const projected = projectGateVerdict(raw), currentOutcome = projected.outcome;
  const v: Record<string, unknown> = { ...raw, ...projected };

  if (runId && v.pass === true && existsSync(runRecordPath(base, 'run.json'))) {
    const state = readRunState(projectDir, runId);
    const outputs = declaredOutputFacts(projectDir, runId, state);
    const stages = state.planControl?.stages ?? [];
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    for (const output of outputs ?? []) {
      // A product explicitly assigned to later ordinary work is not due at an
      // intermediate gate. Repair wiring cannot postpone a missing product.
      if (stages.some(stage => stage.id !== stageId && !stage.is_gate && !stage.dynamic_dispatch && !stage.retry_to?.length
          && state.stages[stage.id]?.status !== STAGE_STATUS.COMPLETE && !transitivelyDependsOn(stageId, stage.id, byId)
          && stage.artifact_contract?.produces.some(product => product.root === 'project'
            && (product.path === output.path || product.kind === 'directory' && output.path.startsWith(`${product.path}/`))))) continue;
      if (state.research && (state.research.publication !== undefined && state.research.publication === output.path || Object.values(state.terminalStates ?? {}).some(entry => entry.paths.includes(output.path)))) continue;
      if (!output.available) return { pass: false, refusal: { kind: 'declared_output' }, reason: `DECLARED_OUTPUT_REQUIRED: ${output.path}: ${output.reason}; restore the required product before gate acceptance; Guidance cannot override the brief` };
    }
  }
  const repairabilityViolation = validateGateRepairability(raw);
  if (repairabilityViolation) return { pass: false, reason: repairabilityViolation, refusal: { kind: 'repairability' } };
  if (!currentOutcome && raw.repairability && isTerminalStudyCompletionArtifact(raw)) {
    return { pass: false, reason: 'Gate contract violation: rejected repairability and terminal study completion success are incompatible outcome declarations; remove one conflicting declaration', refusal: { kind: 'repairability' } };
  }
  // A secondary refusal cannot turn an irreversible rejected fact into repair
  // work. Keep the disposition and parsed-byte identity while retaining failure.
  const reject = (kind: NonNullable<GateVerdict['refusal']>['kind'], reason: string): GateVerdict => ({ ...document!.refuse(reason), refusal: { kind } });
  // Read-only compatibility for pre-class authored archives. New settlement
  // and worker publication always require current classes.
  const archived = recorded ? readArchivedAuditFindings(v.audit_findings) : undefined;
  const classless = archived?.length && archived.every(finding => finding.class === undefined);
  const violation = classless
    ? v.pass === true ? 'AUDIT_FINDINGS_INVALID: historical findings reject under the original contract' : undefined
    : validateFindingVerdict(raw, gateCriterionRefs(base, assignedGateCriterionRefs(base, stageId)),
      !!runId && currentOutcome && readAdmittedContract(base).declaration.allow_blocked_acceptance === true);
  if (violation) return reject('audit_findings', violation);
  const contradiction = !currentOutcome && explicitPassContradiction(raw, 'verdict');
  if (contradiction) return reject('contradiction', contradiction);
  const criterionViolation = validateGateCriterionEvidence(base, stageId, raw);
  if (criterionViolation) {
    log.warn({ stageId, runId, criterionViolation }, 'Gate verdict rejected by canonical criterion coverage contract');
    return reject('criterion_evidence', criterionViolation);
  }
  if (!currentOutcome && runId && isTerminalStudyCompletionArtifact(v)) {
    writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, v);
    return { pass: true, reason: 'study_complete_without_model_success' };
  }
  const accepted = (currentOutcome !== undefined || raw.repairability !== undefined) && runId && existsSync(runRecordPath(base, 'run.json')) ? readRunState(projectDir, runId).stages[stageId] : undefined;
  if ((currentOutcome || raw.repairability) && accepted && (!runId || validateSettledGateVerdict(base, runId, stageId, accepted.attempts?.at(-1), document.digest))) {
    return { pass: false, refusal: { kind: 'repairability' }, reason: 'Gate contract violation: outcome requires the unchanged canonical verdict and protected receipt of the current settled completed gate execution; rerun the gate' };
  }
  // Contract enforcement: if a contract is provided, validate the verdict against it.
  if (contract && runId) {
    const metricPath = stageWorkPath(base, 'stages', stageId, 'metric.json');
    let metric: Record<string, unknown> | null = null;
    try { metric = JSON.parse(readFileSync(metricPath, 'utf-8')); } catch { /* optional */ }
    const violation = validateVerdictAgainstContract(v, metric, contract, stageId);
    if (violation) {
      log.warn({ stageId, runId, violation }, 'Gate verdict rejected by contract');
      return reject(violation.kind, `Gate contract violation: ${violation.reason}`);
    }
  }
  // Preserve the public reader's legacy fields; only engine refusals can carry
  // the private classification marker into runtime facts.
  const verdict = { ...v };
  if (!currentOutcome) delete verdict.outcome;
  delete verdict.contractViolation;
  delete verdict.refusal;
  delete verdict.findings;
  delete verdict.validation;
  return verdict as unknown as GateVerdict;
}

/**
 * Derive cross-iteration criterion coverage exclusively from scheduler facts:
 * completed ordinary work, a downstream completed gate, an effective passing
 * verdict, and a passing per-ID evidence entry. The immutable archived verdict
 * is digest-bound so later live aliases cannot manufacture a discharge.
 */
export function deriveCriterionDischarges(input: {
  projectDir: string;
  runId: string;
  runDirPath: string;
  iteration: number;
  stages: StageConfig[];
  state: StoreState;
  evidence: StageEvidenceRecord[];
}): CriterionDischargeRecord[] {
  let admission: DispatchAdmissionReport;
  try {
    admission = JSON.parse(readFileSync(runRecordPath(input.runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return [];
  }
  if (!admission.pass || !admission.criteriaDigest) return [];

  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const contract = input.state.research ? null : loadGateContract(input.projectDir, input.runId, input.state.campaignStorageKey);
  const records = new Map<string, CriterionDischargeRecord>();
  for (const gate of input.stages) {
    const refs = admission.criterionGateRefs?.[gate.id] ?? [];
    if (!gate.is_gate || refs.length === 0 || input.state.stages[gate.id]?.status !== STAGE_STATUS.COMPLETE) continue;
    const immutable = input.evidence.find((entry) => entry.stageId === gate.id && entry.iteration === input.iteration);
    if (!immutable?.verdictPath) continue;
    const effective = readGateEvaluation(input.projectDir, gate.id, input.runId, contract);
    if (effective?.pass !== true) continue;

    let verdictBytes: Buffer;
    let verdict: Record<string, unknown>;
    try {
      verdictBytes = readFileSync(runRecordPath(input.runDirPath, immutable.verdictPath));
      verdict = JSON.parse(verdictBytes.toString('utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const perCriterion = verdict.criteria;
    if (!perCriterion || typeof perCriterion !== 'object' || Array.isArray(perCriterion)) continue;
    for (const criterionId of refs) {
      if (records.has(criterionId)) continue;
      const criterionEvidence = (perCriterion as Record<string, unknown>)[criterionId];
      if (!criterionEvidence || typeof criterionEvidence !== 'object' || Array.isArray(criterionEvidence)) continue;
      const criterionRecord = criterionEvidence as Record<string, unknown>;
      if (typeof criterionRecord.evidence !== 'string' || !criterionRecord.evidence.trim()
          || !['pass', 'carried'].includes(criterionRecord.status as string)) continue;
      const worker = input.stages.find((stage) =>
        !stage.is_gate
        && !stage.retry_to?.length
        && stage.criterion_refs.includes(criterionId)
        && input.state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE
        && transitivelyDependsOn(gate.id, stage.id, byId));
      if (!worker) continue;
      records.set(criterionId, {
        criterionId,
        briefDigest: admission.criteriaDigest,
        iteration: input.iteration,
        workStageId: worker.id,
        gateStageId: gate.id,
        verdictPath: immutable.verdictPath,
        verdictSha256: createHash('sha256').update(verdictBytes).digest('hex'),
      });
    }
  }
  return [...records.values()];
}
