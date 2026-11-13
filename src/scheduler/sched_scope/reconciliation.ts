import { runRecordPath } from '../../run-layout.js';
// Project the settlement content decision into the durable audit and stage summary.
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { type StageConfig } from '../sched_admission/configuration.js';
import { attachStageConstraintAudit, readStageStatus, runDir, writeStageStatus, isRunningStageStatus } from '../../store.js';
import { type ContentSettlementContext, isReadOnlyStage } from './frozen-inputs.js';
import { settleProjectWrites } from './write-enforcement.js';
import { canonicalProjectWriteUnion } from './path-capabilities.js';

export function createScopeReconciler() {
  function reconcileStageScope(input: {
    stage: StageConfig; projectDir: string; runId: string; context: ContentSettlementContext; attemptIndex: number;
  }) {
    const status = readStageStatus(input.projectDir, input.runId, input.stage.id);
    const attempt = status.attempts?.find(candidate => candidate.index === input.attemptIndex);
    if (!attempt) return { status, violation: false };
    const rawWrites = canonicalProjectWriteUnion(attempt.writes ?? []);
    const enforcement = settleProjectWrites({ projectDir: input.projectDir, context: input.context,
      rawWrites, appliedWrites: attempt.appliedWrites ?? null, readOnly: isReadOnlyStage(input.stage) });
    attempt.writes = canonicalProjectWriteUnion(rawWrites, enforcement.rawWrites);
    // Retain the existing non-retryable integrity disposition when forbidden
    // content remains. A clean retry cannot adopt an unrestored review write.
    if (enforcement.rollbackFailures.length || enforcement.violations.some(item => item.kind === 'read_only_project_violation')) {
      attempt.engineVoid = true;
      attempt.terminationCause = 'engine_void';
    }
    writeStageStatus(input.projectDir, input.runId, input.stage.id, status);
    const root = runDir(input.projectDir, input.runId);
    const path = `stages/${input.stage.id}/constraint_audit_attempt_${attempt.index}.json`;
    publishJsonCreateOnly(runRecordPath(root, path), { version: 1, stageId: input.stage.id, attemptIndex: attempt.index,
      ...enforcement,
      writes: attempt.writes ?? [], writeAttribution: attempt.writeAttribution ?? 'unknown',
      timeout: attempt.timeout, completedAt: new Date().toISOString() });
    const violation = enforcement.violations.length > 0;
    return { status: attachStageConstraintAudit(input.projectDir, input.runId, input.stage.id, attempt.index, {
      path, violationCount: enforcement.violations.length,
      unresolvedViolationCount: enforcement.violations.length,
      unverifiedCount: enforcement.violations.filter(item => item.certainty === 'unverified').length,
      rawWriteCount: enforcement.rawWrites.length, appliedWriteCount: enforcement.appliedWrites?.length,
      rolledBackWriteCount: enforcement.rolledBackWrites.length,
    }, violation ? `${[...new Set(enforcement.violations.map(item => item.kind))].join(', ')}: ${canonicalProjectWriteUnion(enforcement.violations.map(item => item.path)).join(', ')}` : undefined), violation };
  }
  function reconcileCompletedStageAttempts(input: {
    stage: StageConfig; projectDir: string; runId: string; context: ContentSettlementContext;
  }) {
    let status = readStageStatus(input.projectDir, input.runId, input.stage.id), violation = false;
    for (const attempt of status.attempts ?? []) {
      if (isRunningStageStatus(attempt.status) || attempt.constraintAudit) continue;
      const result = reconcileStageScope({ ...input, attemptIndex: attempt.index });
      status = result.status;
      violation ||= result.violation;
    }
    return { status, violation };
  }
  return { reconcileStageScope, reconcileCompletedStageAttempts };
}
