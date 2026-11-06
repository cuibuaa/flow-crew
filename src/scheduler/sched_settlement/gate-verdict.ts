// Boundary: Select and evaluate authored verdict carriers, project terminal-study evidence, derive digest-bound criterion discharges; no stage launching.
import { captureProjectTree, readEvidence } from '../../evidence-ledger.js';
import { validationMeasurement } from '../../project-validation.js';
import { readResearchGateCandidate } from '../../research-candidate.js';
import { assessFindings, AuditFindingsSchema, projectLegacyFindings } from '../../scoped-audit-repair.js';
import { CriterionDischargeRecord, GateVerdict, STAGE_STATUS, StageEvidenceRecord, StoreState, readRunState, readStageStatus, writeStageStatus, runDir, stageDir } from '../../store.js';
import { declaredOutputFacts } from '../../run-state-access.js';
import { scopeContainsPath } from '../sched_scope/path-capabilities.js';
import { StageConfig, isTerminalStudyCompletionArtifact } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract, validateVerdictAgainstContract } from './gate-contract.js';
import { projectGateVerdict, readGateVerdictDocument, GateVerdictDocument, validateSettledGateVerdict, explicitPassContradiction, validateGateCriterionEvidence, validateGateRepairability } from './gate-evidence.js';
import { archivedGateRejections, confirmedRepairFindings } from './gate-archives.js';
import { currentAuthorValidationRefusal, readRunValidationBaseline, gateValidationRefusal } from './gate-validation.js';

export function readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null {
  const base = runDir(projectDir, runId);
  try {
    const parsed = JSON.parse(readFileSync(join(base, `verdict_${stageId}.json`), 'utf-8')) as Record<string, unknown>;
    if (isTerminalStudyCompletionArtifact(parsed) && !('repairability' in parsed)) return parsed;
  } catch { /* optional */ }
  return null;
}

export function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(join(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');

}

/** Read the settled engine result; legacy runs without it use the same evaluator. */
export function readGateEvaluation(
  projectDir: string, stageId: string, runId?: string, contract?: GateContract | null,
  requireValidationDelta = true,
): GateVerdict | null {
  let accepted;
  try { accepted = runId ? readRunState(projectDir, runId).stages[stageId] : undefined; }
  catch { /* Legacy authored verdicts remain readable without run state. */ }
  if (accepted?.continuation) return null;
  if (accepted?.status === STAGE_STATUS.COMPLETE || accepted?.status === STAGE_STATUS.FAILED) {
    if (accepted.gate) return projectLegacyGateAssessment(projectDir, runId!, stageId, accepted.gate.pass && runId && requireValidationDelta
      ? (accepted.gate.validationRequired === true ? currentAuthorValidationRefusal(projectDir, runId)
        : accepted.gate.validationRequired === false ? undefined : gateValidationRefusal(projectDir, runId, stageId)) ?? accepted.gate : accepted.gate);
    if (accepted.status === STAGE_STATUS.COMPLETE && accepted.acceptedFrom) return projectLegacyGateAssessment(projectDir, runId!, stageId, accepted.acceptedFrom.verdict.pass && runId && requireValidationDelta
      ? gateValidationRefusal(projectDir, runId, stageId) ?? accepted.acceptedFrom.verdict : accepted.acceptedFrom.verdict);
  }
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const document = readGateVerdictDocument(base, stageId);
  if (!document && runId && accepted?.status === STAGE_STATUS.COMPLETE) {
    const archived = archivedGateRejections(base, stageId).at(-1);
    try {
      const record = JSON.parse(readFileSync(archived!.effectiveVerdictPath, 'utf8'));
      if (typeof record.engine_effective_pass === 'boolean') return { pass: record.engine_effective_pass,
        reason: record.engine_rejection_reason,
        ...(record.kind && !['pass', 'repairable', 'irreparable'].includes(record.kind) ? { refusal: { kind: record.kind } } : {}),
        ...(record.repairability ? { repairability: record.repairability } : {}) };
    } catch { /* No live verdict or readable archived conclusion. */ }
  }
  return settleFindingAssessment(evaluateGateVerdict(document, projectDir, stageId, runId, contract, requireValidationDelta), document, projectDir, stageId, runId);
}

/** Old settled verdicts predate the derived projection. Read it without
 * rewriting their authored bytes or historical engine conclusion. */
export function projectLegacyGateAssessment(projectDir: string, runId: string, stageId: string, verdict: GateVerdict): GateVerdict {
  return projectLegacyFindings(verdict, readGateVerdictDocument(runDir(projectDir, runId), stageId)?.value.audit_findings);
}

/** Publish once, after the group has bound its post-write validation receipt. */
export function settleGateEvaluation(projectDir: string, runId: string, stageId: string): void {
  const status = readStageStatus(projectDir, runId, stageId);
  if ((status.status !== STAGE_STATUS.COMPLETE && status.status !== STAGE_STATUS.FAILED) || status.continuation || status.gate) return;
  const state = readRunState(projectDir, runId);
  const document = readGateVerdictDocument(runDir(projectDir, runId), stageId);
  const rawVerdict = (status.status === STAGE_STATUS.FAILED ? gateValidationRefusal(projectDir, runId, stageId)
    : evaluateGateVerdict(document, projectDir, stageId, runId, loadGateContract(projectDir, runId, state.campaignStorageKey)))
    ?? { pass: false, refusal: { kind: 'missing_verdict' as const }, reason: 'Gate did not produce a verdict' };
  const verdict = settleFindingAssessment(rawVerdict, document, projectDir, stageId, runId)!;
  if (status.status === STAGE_STATUS.FAILED && verdict.refusal?.kind !== 'validation_regression') return;
  status.gate = { validationRequired: Boolean(readRunValidationBaseline(runDir(projectDir, runId))?.baseline.discovery.commands.length), ...projectGateVerdict(verdict as unknown as Record<string, unknown>), ...(verdict.refusal ? { refusal: verdict.refusal } : {}), ...(verdict.findings ? { findings: verdict.findings } : {}), ...(verdict.validation ? { validation: verdict.validation } : {}), kind: verdict.refusal?.kind ?? (verdict.pass ? 'pass' : verdict.repairability?.disposition ?? 'repairable'), verdictSha256: document?.digest ?? null };
  writeStageStatus(projectDir, runId, stageId, status);
}

/** The authored verdict remains intact; this projection owns confirmation and
 * receipt interpretation in run.json, the public facts view and reports. */
function settleFindingAssessment(verdict: GateVerdict | null, document: GateVerdictDocument | null,
  projectDir: string, stageId: string, runId?: string): GateVerdict | null {
  if (!verdict || !document || !runId) return verdict;
  const base = runDir(projectDir, runId), ledger = readEvidence(base);
  const parsed = AuditFindingsSchema.safeParse(document.value.audit_findings);
  let attemptIndex = 0;
  try { attemptIndex = readStageStatus(projectDir, runId, stageId).attempts?.at(-1)?.index ?? 0; } catch { /* legacy verdict without stage status: no confirmed finding */ }
  let brief = ''; try { brief = readFileSync(join(base, 'task_brief.md'), 'utf8'); } catch { /* legacy */ }
  const treeHash = captureProjectTree(projectDir, brief).hash;
  const findings = assessFindings(parsed.success ? parsed.data.findings : [], ledger, { stageId, attemptIndex, treeHash });
  const fact = ledger.filter(entry => entry.kind === 'validation').at(-1);
  const validation = fact?.kind === 'validation' ? fact.executions.find(entry => entry.target === 'attempt')?.commands.map(result => ({
    role: result.role, display: result.display, measurement: validationMeasurement(result),
  })) : undefined;
  const unmeasured = validation?.filter(result => result.measurement === 'not_measured') ?? [];
  const loadNote = unmeasured.length ? ` Validation not measured (${unmeasured.map(result => result.display ?? result.role).join(', ')}): neither pass nor failure; no author action required.` : '';
  const { findings: _findings, validation: _validation, ...authored } = verdict;
  // The rejection archive owns obligations across a repair's review choices;
  // unrelated later gates do not reopen an already completed repair.
  const state = verdict.pass && existsSync(join(base, 'run.json')) ? readRunState(projectDir, runId) : undefined;
  const gateIds = [stageId, ...(state?.planControl?.stages ?? []).flatMap(stage => stage.retry_to?.includes(stageId) ? stage.retry_to : [])];
  const required = verdict.pass ? confirmedRepairFindings(base, [...new Set(gateIds)]) : [];
  const closureFailed = required.some(finding => {
    const original = ledger.find(entry => entry.sequence === finding.record.sequence);
    const closure = ledger.filter(entry => entry.kind === 'command' && entry.reproductionOf === finding.record.sequence).at(-1);
    return original?.kind !== 'command' || !original.context || closure?.kind !== 'command' || closure.owner !== 'code'
      || closure.exitCode !== 0 || !closure.outputDigest || !treeHash || closure.treeHash !== treeHash || closure.treeAfterHash !== treeHash
      || closure.command !== original.command || closure.context?.cwd !== original.context.cwd || closure.context?.shell !== original.context.shell;
  });
  const reason = `${closureFailed ? 'Repair reproduction remains open or does not cover the repaired tree; a passing verdict cannot close it. ' : ''}${verdict.reason ?? ''}${findings.unconfirmed.length ? ` Unconfirmed observations: ${findings.unconfirmed.map(finding => finding.id).join(', ')}; no repair requested for these.` : ''}${loadNote}`;
  return { ...authored, ...(closureFailed ? { pass: false, refusal: { kind: 'audit_findings' as const } } : {}),
    ...(parsed.success ? { findings } : {}), ...(validation ? { validation } : {}), ...(reason ? { reason } : {}) };
}

function evaluateGateVerdict(document: GateVerdictDocument | null, projectDir: string, stageId: string, runId?: string,
  contract?: GateContract | null, requireValidationDelta = true): GateVerdict | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const raw = document?.value;
  if (!raw) return null;
  const criteria = raw.criteria;
  const criteriaPass = criteria && typeof criteria === 'object' && !Array.isArray(criteria) && Object.keys(criteria).length > 0
    && Object.values(criteria).every(entry => entry && typeof entry === 'object' && (entry as { status?: string }).status === 'pass');
  const observed = raw.pass === false && criteriaPass
    ? settleFindingAssessment(raw as unknown as GateVerdict, document, projectDir, stageId, runId)?.findings : undefined;
  // Do not turn observations into demands; apply the ordinary pass checks to
  // this candidate acceptance, including required products and metric floors.
  let v = raw;
  if (observed && !observed.confirmed.length && observed.unconfirmed.length) {
    const { repairability: _repairability, ...accepted } = raw;
    v = { ...accepted, pass: true };
  }
  // Mechanical validation precedes semantic acceptance. A regression remains
  // rejected; only a confirmed reviewer finding can authorize product repair.
  if (runId && requireValidationDelta && (raw.repairability as GateVerdict['repairability'])?.disposition !== 'irreparable') {
    const refusal = gateValidationRefusal(projectDir, runId, stageId);
    if (refusal) return refusal;
  }

  const accepted = raw.repairability !== undefined && runId && existsSync(join(base, 'run.json')) ? readRunState(projectDir, runId).stages[stageId] : undefined;
  if (document?.value.repairability && accepted && (!runId || validateSettledGateVerdict(base, runId, stageId, accepted.attempts?.at(-1), document.digest))) {
    return { pass: false, refusal: { kind: 'repairability' }, reason: 'Gate contract violation: repairability requires the unchanged canonical verdict and protected receipt of the current settled completed gate execution; rerun the gate' };
  }

  if (runId && v.pass === true && existsSync(join(base, 'run.json'))) {
    const state = readRunState(projectDir, runId);
    const outputs = declaredOutputFacts(projectDir, runId, state);
    const stages = state.planControl?.stages ?? [];
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    for (const output of outputs ?? []) {
      // A product explicitly assigned to later ordinary work is not due at an
      // intermediate gate. Repair wiring cannot postpone a missing product.
      if (stages.some(stage => stage.id !== stageId && !stage.is_gate && !stage.dynamic_dispatch && !stage.retry_to?.length
          && state.stages[stage.id]?.status !== STAGE_STATUS.COMPLETE && !transitivelyDependsOn(stageId, stage.id, byId)
          && scopeContainsPath(stage.scope ?? [], output.path))) continue;
      if (!output.available) return { pass: false, refusal: { kind: 'declared_output' }, reason: `DECLARED_OUTPUT_REQUIRED: ${output.path}: ${output.reason}; restore the required product before gate acceptance; Guidance cannot override the brief` };
    }
  }
  const repairabilityViolation = validateGateRepairability(raw);
  if (repairabilityViolation) return { pass: false, reason: repairabilityViolation, refusal: { kind: 'repairability' } };
  if (raw.repairability && isTerminalStudyCompletionArtifact(raw)) {
    return { pass: false, reason: 'Gate contract violation: rejected repairability and terminal study completion success are incompatible outcome declarations; remove one conflicting declaration', refusal: { kind: 'repairability' } };
  }
  // A secondary refusal cannot turn an irreversible rejected fact into repair
  // work. Keep the disposition and parsed-byte identity while retaining failure.
  const reject = (kind: NonNullable<GateVerdict['refusal']>['kind'], reason: string): GateVerdict => ({ ...document!.refuse(reason), refusal: { kind } });
  if (v.audit_findings !== undefined) {
    const findings = AuditFindingsSchema.safeParse(v.audit_findings);
    if (!findings.success) return reject('audit_findings', `AUDIT_FINDINGS_INVALID: ${findings.error.message}`);
    if (raw.pass === true && findings.data.findings.length) return { pass: false, refusal: { kind: 'audit_findings' }, reason: 'AUDIT_FINDINGS_OPEN: a passing verdict cannot contain unresolved structured findings' };
  }
  if (runId && v.pass === true) {
    const candidate = readResearchGateCandidate(base, stageId);
    if (candidate && (candidate.kind === 'invalid' || candidate.kind === 'absent')) {
      return { pass: false, refusal: { kind: candidate.kind === 'absent' ? 'research_outcome_absent' : 'research_outcome_invalid' }, reason: `Research round outcome is ${candidate.kind}: ${candidate.reason ?? 'no usable evidence'}` };
    }
  }
  const contradiction = explicitPassContradiction(v, 'verdict');
  if (contradiction) {
    log.warn({ stageId, runId, contradiction }, 'Gate verdict rejected because its structured fields contradict pass=true');
    return { pass: false, refusal: { kind: 'contradiction' }, reason: contradiction };
  }
  const criterionViolation = validateGateCriterionEvidence(base, stageId, v);
  if (criterionViolation) {
    log.warn({ stageId, runId, criterionViolation }, 'Gate verdict rejected by canonical criterion coverage contract');
    return reject('criterion_evidence', criterionViolation);
  }
  if (runId && isTerminalStudyCompletionArtifact(v)) {
    writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, v);
    return { pass: true, reason: 'study_complete_without_model_success' };
  }
  // Contract enforcement: if a contract is provided, validate the verdict against it.
  if (contract && runId) {
    const metricPath = join(stageDir(projectDir, runId, stageId), 'metric.json');
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
    admission = JSON.parse(readFileSync(join(input.runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return [];
  }
  if (!admission.pass || !admission.criteriaDigest) return [];

  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const terminalOwnerIds = new Set(Object.values(admission.terminalOwners));
  const contract = loadGateContract(input.projectDir, input.runId, input.state.campaignStorageKey);
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
      verdictBytes = readFileSync(join(input.runDirPath, immutable.verdictPath));
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
          || criterionRecord.status !== 'pass') continue;
      const worker = input.stages.find((stage) =>
        !stage.is_gate
        && !stage.retry_to?.length
        && !terminalOwnerIds.has(stage.id)
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
