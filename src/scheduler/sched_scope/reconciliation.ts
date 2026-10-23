// Project the settlement content decision into the durable audit and stage summary.
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { type StageConfig } from '../sched_admission/configuration.js';
import { attachStageConstraintAudit, readStageStatus, runDir, writeStageStatus, isRunningStageStatus } from '../../store.js';
import { join } from 'node:path';
import { normalizedProjectPath } from '../sched_admission/scope-services.js';
import { type ScopeBatchContext } from './scope-batch.js';
import { settleProjectWrites } from './write-enforcement.js';
import { canonicalProjectWriteUnion } from './path-capabilities.js';
import { trackedGitlinkAncestor } from './rollback-baseline.js';

export function createScopeReconciler() {
  function reconcileStageScope(input: {
    stage: StageConfig; projectDir: string; runId: string; context: ScopeBatchContext; attemptIndex: number;
  }) {
    const status = readStageStatus(input.projectDir, input.runId, input.stage.id);
    const attempt = status.attempts?.find(candidate => candidate.index === input.attemptIndex);
    if (!attempt) return { status, violation: false };
    const declaredScope = input.context.declaredScope(input.stage.id);
    // The worker captured this attempt's delta before settlement. Rewalking the
    // batch snapshot would attribute prior attempts and engine moves to it.
    const rawWrites = canonicalProjectWriteUnion((attempt.writes ?? []).map(raw => {
      const path = normalizedProjectPath(raw);
      return path ? trackedGitlinkAncestor(input.context.snapshot.rollbackBaseline, path) ?? path : raw;
    }));
    const definiteWrites = new Set(rawWrites);
    const enforcement = settleProjectWrites({ projectDir: input.projectDir, snapshot: input.context.snapshot,
      rawWrites, definiteWrites });
    attempt.writes = canonicalProjectWriteUnion(rawWrites, enforcement.rawWrites);
    writeStageStatus(input.projectDir, input.runId, input.stage.id, status);
    const root = runDir(input.projectDir, input.runId);
    const path = `stages/${input.stage.id}/constraint_audit_attempt_${attempt.index}.json`;
    publishJsonCreateOnly(join(root, path), { version: 1, stageId: input.stage.id, attemptIndex: attempt.index,
      declaredScope, ...enforcement,
      writes: attempt.writes ?? [], writeAttribution: attempt.writeAttribution ?? 'unknown',
      timeout: attempt.timeout, completedAt: new Date().toISOString() });
    const violation = enforcement.violations.length > 0;
    return { status: attachStageConstraintAudit(input.projectDir, input.runId, input.stage.id, attempt.index, {
      path, declaredScope, effectiveScope: declaredScope, violationCount: enforcement.violations.length,
      unresolvedViolationCount: enforcement.violations.length,
      unverifiedCount: enforcement.violations.filter(item => item.certainty === 'unverified').length,
      rawWriteCount: enforcement.rawWrites.length, appliedWriteCount: enforcement.appliedWrites.length,
      exemptedWriteCount: enforcement.exemptedWrites.length, rolledBackWriteCount: enforcement.rolledBackWrites.length,
    }, violation ? `immutable_evidence_violation: ${enforcement.violations.map(item => item.path).join(', ')}` : undefined), violation };
  }
  function reconcileCompletedStageAttempts(input: {
    stage: StageConfig; projectDir: string; runId: string; context: ScopeBatchContext;
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
