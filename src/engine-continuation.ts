/** Validate persisted execution contracts before any continuation is queued or
 * claimed. Build identity is provenance; supported state, not hash equality,
 * decides compatibility. Interrupted executions require settled ledgers. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { RecordedWorkflowConfigSchema } from './scheduler/sched_admission/configuration.js';
import { persistedPlanErrors, checkpointConsumers, engineGeneration } from './restart-recovery.js';
import { readRunState, readStageStatus, requireKnownRunStatus, runDir, RUN_STATUS, STAGE_STATUS, updateOperationalRunStateAtPath, type StoreState } from './store.js';

export function recordContinuationRefusal(projectDir: string, runId: string, reason: string): void {
  try {
    updateOperationalRunStateAtPath(runDir(projectDir, runId), state => {
      if (state.status !== RUN_STATUS.CANCELLED) state.continuationFailure = { at: new Date().toISOString(), reason, generation: engineGeneration() };
    });
  } catch { /* A corrupt carrier may be unwritable; the control RPC still reports the refusal. */ }
}

export function assertContinuationCompatible(projectDir: string, runId: string): StoreState {
  try {
    const state = readRunState(projectDir, runId);
    requireKnownRunStatus(state.status, `continue run ${runId}`);
    if (state.runId !== runId || resolve(state.projectDir) !== resolve(projectDir)) throw new Error('run/project binding mismatch');
    if (state.recovery?.kind === 'blocked') throw new Error(state.recovery.reason);
    const workflow = RecordedWorkflowConfigSchema.parse(parse(readFileSync(join(runDir(projectDir, runId), 'workflow.yaml'), 'utf8')));
    const errors = persistedPlanErrors(state);
    const checkpoint = state.engineCheckpoint;
    if (checkpoint && (checkpoint.version !== 2 || checkpoint.runId !== runId
        || typeof checkpoint.projectDir !== 'string' || resolve(checkpoint.projectDir) !== resolve(projectDir))) errors.push('unsupported or unbound engine checkpoint');
    if (state.deploymentHold && (state.deploymentHold.version !== 1 || !checkpoint)) errors.push('unsupported deployment boundary or missing engine checkpoint');
    if (checkpoint && checkpointConsumers(checkpoint).length) errors.push('owned commands are still active');
    for (const key of ['currentIteration', 'maxIterations', 'maxRetries'] as const) {
      if (state[key] !== undefined && (!Number.isSafeInteger(state[key]) || state[key]! < (key === 'maxRetries' ? 0 : 1))) errors.push(`invalid ${key} budget`);
    }
    // A missing projection must not hide a retained execution ledger. Include
    // dynamically admitted duties as well as the base workflow; launch may
    // initialize only checkpoint-free, ledger-free legacy preparations.
    const stageIds = new Set([...workflow.stages.map(stage => stage.id),
      ...(state.planControl?.stages ?? []).map(stage => stage.id), ...Object.keys(state.stages)]);
    for (const id of stageIds) {
      const stage = state.stages[id];
      if (!stage) {
        if (checkpoint || existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'))) errors.push(`missing stage projection for ${id}; admitted execution state must not be reset`);
        continue;
      }
      if (!Number.isSafeInteger(stage.retries) || stage.retries < 0) errors.push(`invalid stage projection ${id}`);
      const ledgerExists = existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'));
      const ledger = ledgerExists ? readStageStatus(projectDir, runId, id) : undefined;
      const attempts = stage.attempts ?? [];
      const settled = (status: string) => [STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(status);
      const unsettled = (record: typeof stage) => record.status === STAGE_STATUS.RUNNING
        || (record.attempts ?? []).some(attempt => !settled(attempt.status));
      if (unsettled(stage) || (ledger && unsettled(ledger))) {
        errors.push(`unsettled attempt in ${id}; restart recovery is required`);
      }
      for (const record of [state.stages[id], ...(ledgerExists ? [ledger!] : [])]) {
        if (!record || !Object.values(STAGE_STATUS).includes(record.status)) {
          errors.push(`invalid stage record ${id}`);
          continue;
        }
        if ((record.attempts ?? []).some((attempt, index) => attempt.index !== index + 1
            || ![STAGE_STATUS.RUNNING, 'closed', STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(attempt.status)
            || !Number.isFinite(Date.parse(attempt.startedAt)))) errors.push(`invalid attempt history in ${id}`);
      }
      if (attempts.length && !ledger) errors.push(`missing attempt ledger for ${id}`);
      // Repend resets projection status and retry budgets without erasing work.
      // Refuse only settled execution outcomes missing from the projection, not
      // incidental counters, timing, usage, or the stage's scheduling status.
      if (ledger?.attempts?.some(attempt => settled(attempt.status)
          && !stage.attempts?.some(projected => projected.index === attempt.index
            && projected.status === attempt.status && projected.exitCode === attempt.exitCode))) {
        errors.push(`attempt ledger is ahead of stage projection for ${id}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return state;
  } catch (error) {
    const reason = `CONTINUATION_INCOMPATIBLE: ${error instanceof Error ? error.message : String(error)}`;
    recordContinuationRefusal(projectDir, runId, reason);
    throw new Error(reason, { cause: error });
  }
}
