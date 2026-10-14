// Boundary: Select and evaluate authored verdict carriers, project terminal-study evidence, derive digest-bound criterion discharges; no stage launching.
import { readResearchGateCandidate } from '../../research-candidate.js';
import { readRunEvents, recordRunEvent } from '../../run-events.js';
import { AuditFindingsSchema } from '../../scoped-audit-repair.js';
import { CriterionDischargeRecord, GateVerdict, STAGE_STATUS, StageEvidenceRecord, StoreState, readRunState, runDir, stageDir } from '../../store.js';
import { declaredOutputFacts } from '../../run-state-access.js';
import { scopeContainsPath } from '../sched_scope/path-capabilities.js';
import { validateGateControls } from '../../verdict-controls.js';
import { StageConfig, isTerminalStudyCompletionArtifact } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract, validateVerdictAgainstContract } from './gate-contract.js';
import { readGateVerdictDocument, GateVerdictDocument, validateSettledGateVerdict, assignedGateCriterionRefs, explicitPassContradiction, validateGateCriterionEvidence, validateGateRepairability } from './gate-evidence.js';
import { gateValidationRefusal } from './gate-validation.js';

export function readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null {
  const base = runDir(projectDir, runId);
  for (const file of [`verdict_${stageId}.json`, `pre_gate_verdict_${stageId}.json`]) {
    try {
      const parsed = JSON.parse(readFileSync(join(base, file), 'utf-8')) as Record<string, unknown>;
      // Legacy success recovery cannot adopt a new rejected-run disposition.
      if (isTerminalStudyCompletionArtifact(parsed) && !('repairability' in parsed)) return parsed;
    } catch { /* optional */ }
  }
  return null;
}

export function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(join(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');

}

/**
 * Read a gate verdict. Legacy callers may fall back to the shared verdict.json;
 * dependency readiness disables that fallback because only the producer's own
 * declared output can satisfy its edge.
 */
export function readGateVerdict(
  projectDir: string,
  stageId: string,
  runId?: string,
  contract?: GateContract | null,
  allowSharedFallback = true,
  requireValidationDelta = true,
): GateVerdict | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  return evaluateGateVerdict(readGateVerdictDocument(base, stageId, allowSharedFallback), projectDir, stageId,
    runId, contract, allowSharedFallback, requireValidationDelta);
}

/** Both authored and effective facts come from the same selected document. The
 * settlement owner also checks new dispositions against their protected receipt. */
export function readGateEvaluation(projectDir: string, stage: StageConfig, state: StoreState, runId?: string, contract?: GateContract | null): {
  authoredVerdict: GateVerdict | null; effectiveVerdict: GateVerdict | null;
} {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const document = readGateVerdictDocument(base, stage.id);
  const authoredVerdict = document?.project() ?? null;
  let effectiveVerdict = evaluateGateVerdict(document, projectDir, stage.id, runId, contract);
  if (authoredVerdict?.repairability && (!runId || validateSettledGateVerdict(base, runId, stage.id, state.stages[stage.id]?.attempts?.at(-1), document?.digest))) {
    effectiveVerdict = { pass: false, contractViolation: 'repairability', reason: 'Gate contract violation: repairability requires the unchanged canonical verdict and protected receipt of the current settled completed gate execution; rerun the gate' };
  }
  return { authoredVerdict, effectiveVerdict };
}

function evaluateGateVerdict(document: GateVerdictDocument | null, projectDir: string, stageId: string, runId?: string,
  contract?: GateContract | null, allowSharedFallback = true, requireValidationDelta = true): GateVerdict | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const v = document?.value;
  if (!v && runId && allowSharedFallback) {
    const terminalEvidence = readTerminalStudyCompletionEvidence(projectDir, runId, stageId);
    if (terminalEvidence) {
      writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, terminalEvidence);
      return { pass: true, reason: 'study_complete_without_model_success' };
    }
  }
  if (!v) return null;
  // Mechanical validation precedes semantic acceptance. Its bound receipt can
  // authorize repair even when the stage's authored outputs are incomplete.
  if (runId && v.pass === true && requireValidationDelta) {
    const refusal = gateValidationRefusal(projectDir, runId, stageId);
    if (refusal) return refusal;
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
      if (!output.available) return { pass: false, reason: `DECLARED_OUTPUT_REQUIRED: ${output.path}: ${output.reason}; restore the required product before gate acceptance; Guidance cannot override the brief` };
    }
  }
  const repairabilityViolation = validateGateRepairability(v);
  if (repairabilityViolation) return { pass: false, reason: repairabilityViolation, contractViolation: 'repairability' };
  if (v.repairability && isTerminalStudyCompletionArtifact(v)) {
    return { pass: false, reason: 'Gate contract violation: rejected repairability and terminal study completion success are incompatible outcome declarations; remove one conflicting declaration', contractViolation: 'repairability' };
  }
  // A secondary refusal cannot turn an irreversible rejected fact into repair
  // work. Keep the disposition and parsed-byte identity while retaining failure.
  const reject = (reason: string): GateVerdict => document!.refuse(reason);
  if (v.repairability && runId && document!.file !== `verdict_${stageId}.json`) {
    return { pass: false, reason: 'Gate contract violation: repairability must be written to the gate\'s canonical verdict_<stage_id>.json output', contractViolation: 'repairability' };
  }
  if (v.audit_findings !== undefined) {
    const findings = AuditFindingsSchema.safeParse(v.audit_findings);
    if (!findings.success) return reject(`AUDIT_FINDINGS_INVALID: ${findings.error.message}`);
    if (v.pass === true && findings.data.findings.length) return { pass: false, reason: 'AUDIT_FINDINGS_OPEN: a passing verdict cannot contain unresolved structured findings' };
  }
  if (runId && v.pass === true) {
    const candidate = readResearchGateCandidate(base, stageId);
    if (candidate && (candidate.kind === 'invalid' || candidate.kind === 'absent')) {
      return { pass: false, reason: `Research round outcome is ${candidate.kind}: ${candidate.reason ?? 'no usable evidence'}` };
    }
  }
  const contradiction = explicitPassContradiction(v, 'verdict');
  if (contradiction) {
    log.warn({ stageId, runId, contradiction }, 'Gate verdict rejected because its structured fields contradict pass=true');
    return { pass: false, reason: contradiction };
  }
  const criterionViolation = validateGateCriterionEvidence(base, stageId, v);
  if (criterionViolation) {
    log.warn({ stageId, runId, criterionViolation }, 'Gate verdict rejected by canonical criterion coverage contract');
    return reject(criterionViolation);
  }
  if (runId) {
    const controls = validateGateControls({
      projectDir,
      runDir: base,
      gateStageId: stageId,
      criterionRefs: assignedGateCriterionRefs(base, stageId),
      verdict: v,
    });
    if (controls.conflicts.length > 0) {
      const prior = readRunEvents(projectDir, runId);
      for (const conflict of controls.conflicts) {
        const duplicate = prior.some((event) => (
          event.type === 'criterion_check_conflict'
          && event.stageId === stageId
          && event.criterionId === conflict.criterionId
          && event.checkPath === conflict.path
          && event.guidanceId === conflict.guidanceId
        ));
        if (duplicate) continue;
        recordRunEvent(projectDir, runId, {
          type: 'criterion_check_conflict',
          runId,
          timestamp: new Date().toISOString(),
          stageId,
          criterionId: conflict.criterionId,
          checkPath: conflict.path,
          authorStageId: conflict.authorStageId,
          guidanceId: conflict.guidanceId,
          detail: conflict.reason,
          level: 'warning',
          source: 'scheduler',
        });
      }
    }
    if (controls.violation) {
      log.warn({ stageId, runId, violation: controls.violation }, 'Gate verdict rejected by guidance and feasibility controls');
      return reject(controls.violation);
    }
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
      return reject(`Gate contract violation: ${violation}`);
    }
  }
  // Preserve the public reader's legacy fields; only engine refusals can carry
  // the private classification marker into runtime facts.
  const verdict = { ...v };
  delete verdict.contractViolation;
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
    const effective = readGateVerdict(input.projectDir, gate.id, input.runId, contract, false);
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
