// Boundary: Select and evaluate authored verdict carriers, project terminal-study evidence, derive digest-bound criterion discharges; no stage launching.
import { readResearchGateCandidate } from '../../research-candidate.js';
import { readRunEvents, recordRunEvent } from '../../run-events.js';
import { AuditFindingsSchema } from '../../scoped-audit-repair.js';
import { CriterionDischargeRecord, STAGE_STATUS, StageEvidenceRecord, StoreState, runDir, stageDir } from '../../store.js';
import { validateGateControls } from '../../verdict-controls.js';
import { StageConfig, isTerminalStudyCompletionArtifact } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract, validateVerdictAgainstContract, validateVerdictAgainstMetricFile } from './gate-contract.js';
import { readWrittenGateVerdict, assignedGateCriterionRefs, explicitPassContradiction, validateGateCriterionEvidence } from './gate-evidence.js';
import { GateValidationDeltaArtifact, settledGateValidationExecution } from './gate-validation.js';

export function readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null {
  const base = runDir(projectDir, runId);
  for (const file of [`verdict_${stageId}.json`, `pre_gate_verdict_${stageId}.json`]) {
    try {
      const parsed = JSON.parse(readFileSync(join(base, file), 'utf-8')) as Record<string, unknown>;
      if (isTerminalStudyCompletionArtifact(parsed)) return parsed;
    } catch { /* optional */ }
  }
  return null;
}

export function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(join(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');
  // Generic: the score comes from the verdict's own `value`/`metric` (no domain
  // field names or default metric baked in). higher_is_better is read from the
  // evidence when present, defaulting to true.
  const value = typeof evidence.value === 'number' ? evidence.value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    writeFileSync(join(stageDir(projectDir, runId, stageId), 'metric.json'), JSON.stringify({
      hasMetric: true,
      metric: typeof evidence.metric === 'string' ? evidence.metric : 'study_score',
      value,
      higherIsBetter: typeof evidence.higher_is_better === 'boolean' ? evidence.higher_is_better : true,
      threshold: typeof evidence.threshold === 'number' ? evidence.threshold : null,
      pass: false,
      source: {
        path: typeof evidence.final_candidate_artifact === 'string'
          ? evidence.final_candidate_artifact
          : join(base, `pre_gate_verdict_${stageId}.json`),
        evidence: `value=${value}`,
      },
      notes: 'Recovered from terminal study completion evidence.',
    }, null, 2) + '\n', 'utf-8');
  }
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
): { pass: boolean; reason?: string } | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const v = readWrittenGateVerdict(base, stageId, allowSharedFallback);
  if (!v && runId && allowSharedFallback) {
    const terminalEvidence = readTerminalStudyCompletionEvidence(projectDir, runId, stageId);
    if (terminalEvidence) {
      writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, terminalEvidence);
      return { pass: true, reason: 'study_complete_without_model_success' };
    }
  }
  if (!v) return null;
  if (v.audit_findings !== undefined) {
    const findings = AuditFindingsSchema.safeParse(v.audit_findings);
    if (!findings.success) return { pass: false, reason: `AUDIT_FINDINGS_INVALID: ${findings.error.message}` };
    if (v.pass === true && findings.data.findings.length) return { pass: false, reason: 'AUDIT_FINDINGS_OPEN: a passing verdict cannot contain unresolved structured findings' };
  }
  if (runId && v.pass === true) {
    const candidate = readResearchGateCandidate(base, stageId);
    if (candidate && (candidate.kind === 'invalid' || candidate.kind === 'absent')) {
      return { pass: false, reason: `Research round outcome is ${candidate.kind}: ${candidate.reason ?? 'no usable evidence'}` };
    }
  }
  // The validation delta is recorded only when a declared gate completes, so it
  // can bind only a declared gate. A non-gate stage that merely wrote a verdict
  // file (a qa baseline capture) would otherwise read as failed forever and
  // strand every dependent, ending the iteration early (#2260, #2269).
  if (runId && v.pass === true && requireValidationDelta) {
    const baselinePath = join(base, RUN_VALIDATION_BASELINE_FILE);
    if (existsSync(baselinePath)) {
      let delta: GateValidationDeltaArtifact | undefined;
      try {
        delta = JSON.parse(readFileSync(join(base, `validation_delta_${stageId}.json`), 'utf-8')) as GateValidationDeltaArtifact;
      } catch { /* rejected below */ }
      const expectedDigest = createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
      const currentExecution = settledGateValidationExecution(projectDir, runId, stageId);
      if (!currentExecution) {
        return {
          pass: false,
          reason: `Validation baseline delta for gate ${stageId} cannot be matched to a settled gate execution; run configured validation for the current gate attempt`,
        };
      }
      if (!delta) {
        return {
          pass: false,
          reason: `Validation baseline delta for gate ${stageId} is missing for current execution ${currentExecution.executionId}; run configured validation for this gate attempt`,
        };
      }
      if (delta.version !== 2 || delta.stageId !== stageId
          || delta.executionId !== currentExecution.executionId
          || delta.attemptIndex !== currentExecution.attemptIndex
          || delta.attemptStartedAt !== currentExecution.attemptStartedAt
          || delta.attemptCompletedAt !== currentExecution.attemptCompletedAt) {
        return {
          pass: false,
          reason: `Validation baseline delta for gate ${stageId} belongs to execution ${delta.executionId ?? 'unknown'} (attempt ${String(delta.attemptIndex ?? 'unknown')}), not current execution ${currentExecution.executionId} (attempt ${currentExecution.attemptIndex}); run configured validation for the current gate attempt`,
        };
      }
      if (delta.baselineSha256 !== expectedDigest) {
        return {
          pass: false,
          reason: `Validation baseline delta for gate ${stageId} used a different setup baseline for current execution ${currentExecution.executionId}; rerun configured validation against the admitted setup baseline`,
        };
      }
      if (delta.pass !== true) {
        const regressions = delta.delta.filter((entry) => entry.state === 'regression');
        if (regressions.length > 0) {
          const named = regressions.map((entry) => `${entry.role}: ${entry.newFailureIdentifiers.join(', ') || entry.reason}`).join('; ');
          return {
            pass: false,
            reason: `Validation baseline delta for gate ${stageId} recorded regressions for current execution ${currentExecution.executionId} (${named}); repair the named failures, then rerun the gate and configured validation`,
          };
        }
        const unresolved = delta.delta.filter((entry) => entry.state !== 'pass')
          .map((entry) => `${entry.role}: ${entry.reason}`).join('; ');
        return {
          pass: false,
          reason: `Validation baseline delta for gate ${stageId} recorded no regression but could not be resolved for current execution ${currentExecution.executionId} (${unresolved}); this is not a code failure to repair`,
        };
      }
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
    return { pass: false, reason: criterionViolation };
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
      return { pass: false, reason: controls.violation };
    }
  }
  if (runId && isTerminalStudyCompletionArtifact(v)) {
    writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, v);
    return { pass: true, reason: 'study_complete_without_model_success' };
  }
  if (runId) {
    const metricPath = join(stageDir(projectDir, runId, stageId), 'metric.json');
    try {
      const metric = JSON.parse(readFileSync(metricPath, 'utf-8')) as Record<string, unknown>;
      const applicableContract = contract
        && (!contract.appliesToGates || contract.appliesToGates.includes(stageId))
        ? contract
        : null;
      const violation = validateVerdictAgainstMetricFile(v, metric, applicableContract);
      if (violation) {
        log.warn({ stageId, runId, violation }, 'Gate verdict rejected by metric.json consistency check');
        return { pass: false, reason: violation };
      }
    } catch { /* optional/back-compat */ }
  }
  // Contract enforcement: if a contract is provided, validate the verdict against it.
  if (contract && runId) {
    const metricPath = join(stageDir(projectDir, runId, stageId), 'metric.json');
    let metric: Record<string, unknown> | null = null;
    try { metric = JSON.parse(readFileSync(metricPath, 'utf-8')); } catch { /* optional */ }
    const violation = validateVerdictAgainstContract(v, metric, contract, stageId);
    if (violation) {
      log.warn({ stageId, runId, violation }, 'Gate verdict rejected by contract');
      return { pass: false, reason: `Gate contract violation: ${violation}` };
    }
  }
  return v as { pass: boolean; reason?: string };
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
