/** Validate persisted execution contracts before any continuation is queued or
 * claimed. Build identity is provenance; supported state, not hash equality,
 * decides compatibility. Proven-dead cancelled executions can settle on admission. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { sha256Canonical as digest } from './runtime-negotiation.js';
import { WorkflowConfigSchema } from './scheduler/sched_admission/configuration.js';
import { persistedPlanErrors, checkpointCommandFateKnown, checkpointConsumers, engineGeneration, readHostBootId } from './restart-recovery.js';
import { inspectRunScheduler, processIsAlive, processStartToken, processStartTokensMatch, type ProcessStartToken } from './run-lock.js';
import { interruptedStageStatus, settleInterruptedRunStagesAtPath, readRunState, readStageStatus, requireKnownRunStatus, runDir, RUN_STATUS, STAGE_STATUS, updateOperationalRunStateAtPath, type StoreState } from './store.js';

export function recordContinuationRefusal(projectDir: string, runId: string, reason: string): void {
  try {
    updateOperationalRunStateAtPath(runDir(projectDir, runId), state => {
      if (state.status !== RUN_STATUS.STOPPED) state.continuationFailure = { at: new Date().toISOString(), reason, generation: engineGeneration() };
    });
  } catch { /* A corrupt carrier may be unwritable; the control RPC still reports the refusal. */ }
}

/** Cancellation's historical projection is repairable only with positive owner
 * death evidence. Missing ownership, unreadable identity and live consumers
 * remain incompatible, just as they do in host interruption recovery. */
function validStartToken(token: ProcessStartToken): boolean {
  return typeof token.value === 'string' && (token.kind === 'linux' ? /^\d+$/.test(token.value)
    : token.kind === 'posix-lstart' && token.value.trim().length > 0);
}

function assertCancelledOwnerAbsent(state: StoreState, projectDir: string, runId: string): void {
  const checkpoint = state.engineCheckpoint;
  if (!checkpoint || !checkpointCommandFateKnown(state)) throw new Error('cancelled attempt ownership is unknown');
  const owner = inspectRunScheduler(runId, runDir(projectDir, runId));
  if (!['missing', 'dead', 'reused'].includes(owner.kind)) throw new Error(`cancelled attempt scheduler identity is ${owner.kind}`);
  const boot = readHostBootId();
  if (checkpoint.bootId && boot && checkpoint.bootId !== boot) return;
  if (!Array.isArray(checkpoint.processes) || !Number.isSafeInteger(checkpoint.pid) || checkpoint.pid <= 0) throw new Error('cancelled attempt ownership is unknown');
  if (processIsAlive(checkpoint.pid)) {
    const current = processStartToken(checkpoint.pid);
    if (!current || !checkpoint.processStart || checkpoint.processStart.kind !== current.kind
        || !validStartToken(checkpoint.processStart)
        || processStartTokensMatch(checkpoint.processStart, current)) throw new Error('cancelled attempt controller may still be alive');
  }
  for (const group of checkpoint.processes) {
    if (!group.processStart) continue;
    const current = processStartToken(group.pid);
    if (!validStartToken(group.processStart) || (current && current.kind !== group.processStart.kind)) throw new Error('cancelled attempt command identity is unknown');
  }
  if (checkpointConsumers(checkpoint).length) throw new Error('cancelled attempt commands are still active');
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
    const settlements: string[] = [];
    const ledgers = new Map<string, string>();
    for (const id of stageIds) {
      let stage = state.stages[id];
      if (!stage) {
        if (checkpoint || existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'))) errors.push(`missing stage projection for ${id}; admitted execution state must not be reset`);
        continue;
      }
      if (!Object.values(STAGE_STATUS).includes(stage.status)
          || !Number.isSafeInteger(stage.retries) || stage.retries < 0) errors.push(`invalid stage projection ${id}`);
      const ledgerExists = existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'));
      const ledger = ledgerExists ? readStageStatus(projectDir, runId, id) : undefined;
      if (ledger) ledgers.set(id, digest(ledger));
      const attempts = stage.attempts ?? [];
      // The old cancellation changed only running -> failed in the projection.
      // Compare the entire retained record so no other disagreement is repaired.
      if (state.status === RUN_STATUS.STOPPED && state.failureReason === 'Cancelled by user'
          && Number.isFinite(Date.parse(state.completedAt ?? '')) && stage.status === STAGE_STATUS.FAILED
          && ['running', 'closed'].includes(attempts.at(-1)?.status ?? '')
          && attempts.slice(0, -1).every(attempt => [STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(attempt.status))
          && ledger && (digest({ ...stage, status: STAGE_STATUS.RUNNING }) === digest(ledger)
            // A split publication may already have written exactly this settlement.
            || digest(interruptedStageStatus(stage, state.completedAt!, 'CANCELLED_INTERRUPTED: Cancelled by user')) === digest(ledger))) {
        if (Date.parse(state.completedAt!) < Date.parse(attempts.at(-1)!.startedAt)) errors.push(`invalid cancellation timing in ${id}`);
        stage = interruptedStageStatus(stage, state.completedAt!, 'CANCELLED_INTERRUPTED: Cancelled by user');
        settlements.push(id);
      }
      const checkedAttempts = stage.attempts ?? [];
      if (stage.status === STAGE_STATUS.RUNNING || checkedAttempts.some(attempt => ![STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(attempt.status))) errors.push(`unsettled attempt in ${id}; restart recovery is required`);
      if (attempts.some((attempt, index) => attempt.index !== index + 1 || !Number.isFinite(Date.parse(attempt.startedAt)))) errors.push(`invalid attempt history in ${id}`);
      if (attempts.length || existsSync(join(runDir(projectDir, runId), 'stages', id, 'status.json'))) {
        const checkedLedger = settlements.includes(id) ? stage : ledger!;
        // The existing iteration driver can repend a projection while its
        // ledger still describes the preceding settled execution. Its immutable
        // attempts and retry counter must still agree; pending is not success.
        if ((checkedLedger.status !== stage.status && stage.status !== STAGE_STATUS.PENDING) || checkedLedger.retries !== stage.retries || digest(checkedLedger.attempts ?? []) !== digest(checkedAttempts)) errors.push(`stage projection and attempt ledger disagree for ${id}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    if (settlements.length) {
      const snapshot = digest(state);
      settleInterruptedRunStagesAtPath(runDir(projectDir, runId), settlements, state.completedAt!, 'CANCELLED_INTERRUPTED: Cancelled by user', current => {
        if (digest(readRunState(projectDir, runId)) !== snapshot) throw new Error('cancelled run changed before settlement');
        for (const [id, expected] of ledgers) if (digest(readStageStatus(projectDir, runId, id)) !== expected) throw new Error(`stage ledger changed before settlement for ${id}`);
        assertCancelledOwnerAbsent(current, projectDir, runId);
      });
      return readRunState(projectDir, runId);
    }
    return state;
  } catch (error) {
    const reason = `CONTINUATION_INCOMPATIBLE: ${error instanceof Error ? error.message : String(error)}`;
    recordContinuationRefusal(projectDir, runId, reason);
    throw new Error(reason, { cause: error });
  }
}
