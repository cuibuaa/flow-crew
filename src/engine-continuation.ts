/** Validate persisted execution contracts before any continuation is queued or
 * claimed. Build identity is provenance; supported state, not hash equality,
 * decides compatibility. Restart recovery owns interrupted running attempts. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { sha256Canonical as digest } from './runtime-negotiation.js';
import { WorkflowConfigSchema } from './scheduler/sched_admission/configuration.js';
import { persistedPlanErrors, checkpointCommandFateKnown, checkpointConsumers, engineGeneration } from './restart-recovery.js';
import { readRunState, readStageStatus, requireKnownRunStatus, runDir, RUN_STATUS, STAGE_STATUS, updateOperationalRunStateAtPath, type StoreState } from './store.js';

export function recordContinuationRefusal(projectDir: string, runId: string, reason: string): void {
  try {
    updateOperationalRunStateAtPath(runDir(projectDir, runId), state => {
      if (state.status !== RUN_STATUS.STOPPED) state.continuationFailure = { at: new Date().toISOString(), reason, generation: engineGeneration() };
    });
  } catch { /* A corrupt carrier may be unwritable; the control RPC still reports the refusal. */ }
}

export function assertContinuationCompatible(projectDir: string, runId: string): StoreState {
  try {
    const state = readRunState(projectDir, runId);
    requireKnownRunStatus(state.status, `continue run ${runId}`);
    if (state.runId !== runId || resolve(state.projectDir) !== resolve(projectDir)) throw new Error('run/project binding mismatch');
    if (state.recovery?.kind === 'blocked') throw new Error(state.recovery.reason);
    const workflow = WorkflowConfigSchema.parse(parse(readFileSync(join(runDir(projectDir, runId), 'workflow.yaml'), 'utf8')));
    const errors = persistedPlanErrors(state);
    const checkpoint = state.engineCheckpoint;
    if (checkpoint && (![1, 2].includes(checkpoint.version) || checkpoint.runId !== runId
        || typeof checkpoint.projectDir !== 'string' || resolve(checkpoint.projectDir) !== resolve(projectDir))) errors.push('unsupported or unbound engine checkpoint');
    if (state.deploymentHold && (state.deploymentHold.version !== 1 || !checkpoint)) errors.push('unsupported deployment boundary or missing engine checkpoint');
    if (checkpoint && (!checkpointCommandFateKnown(state) || checkpointConsumers(checkpoint).length)) errors.push('owned command fate is unknown or commands are still active');
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
      if (!Object.values(STAGE_STATUS).includes(stage.status)
          || !Number.isSafeInteger(stage.retries) || stage.retries < 0) errors.push(`invalid stage projection ${id}`);
      const attempts = stage.attempts ?? [];
      if (stage.status === STAGE_STATUS.RUNNING || attempts.some(attempt => ![STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(attempt.status))) errors.push(`unsettled attempt in ${id}; restart recovery is required`);
      if (attempts.some((attempt, index) => attempt.index !== index + 1 || !Number.isFinite(Date.parse(attempt.startedAt)))) errors.push(`invalid attempt history in ${id}`);
      if (attempts.length || existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'))) {
        const ledger = readStageStatus(projectDir, runId, id);
        // The existing iteration driver can repend a projection while its
        // ledger still describes the preceding settled execution. Its immutable
        // attempts and retry counter must still agree; pending is not success.
        if ((ledger.status !== stage.status && stage.status !== STAGE_STATUS.PENDING) || ledger.retries !== stage.retries || digest(ledger.attempts ?? []) !== digest(attempts)) errors.push(`stage projection and attempt ledger disagree for ${id}`);
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
