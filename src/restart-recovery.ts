import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { sha256Canonical as digest } from './runtime-negotiation.js';
import { z } from 'zod';
import { readBuildManifest } from './build-manifest.js';
import { processStartToken, type ProcessStartToken } from './run-lock.js';

import { RUN_STATUS, STAGE_STATUS, completedStageAttemptStatus, readRunState, readStageStatus, rependStageStatus, updateRunState, updateStageStatusUnderRunLock, type StageAttempt, type StageStatus, type StoreState } from './store.js';
import { recordRunEvent } from './run-events.js';
import { planDigest } from './plan-revisions.js';
import { canonicalRunId } from './cancellation-policy.js';
import { runsRoot } from './store.js';

export interface EngineCheckpoint {
  version: 1; runId: string; projectDir: string; bootId?: string; generation?: string;
  pid: number; processStart?: ProcessStartToken; at: string;
}
export interface RestartRecovery {
  kind: 'resumable' | 'blocked' | 'resuming'; reason: string; at: string;
  fromBoot?: string; toBoot?: string; generation?: string; interruptedStages: string[];
}
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RecoveryIntentSchema = z.object({
  version: z.literal(1), phase: z.enum(['prepared', 'committed']), at: z.string().datetime(),
  binding: z.object({
    runId: z.string().min(1), projectDir: z.string().min(1), checkpoint: digestSchema,
    planRevision: z.object({ revision: z.number().int().nonnegative(), digest: digestSchema }).strict().optional(),
    currentIteration: z.number().int().nonnegative().optional(),
    maxIterations: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
  }).strict(),
  stages: z.array(z.object({
    stageId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), retries: z.number().int().nonnegative(),
    attempt: z.object({ index: z.number().int().positive(), startedAt: z.string().datetime(), status: z.literal('running') }).passthrough(),
    prefixDigest: digestSchema, completedAt: z.string().datetime(), durationMs: z.number().nonnegative(),
  }).strict()).min(1),
}).strict().superRefine((intent, context) => {
  if (new Set(intent.stages.map((stage) => stage.stageId)).size !== intent.stages.length) context.addIssue({ code: 'custom', path: ['stages'], message: 'interrupted stage IDs must be unique' });
  for (const [index, stage] of intent.stages.entries()) {
    if (stage.completedAt !== intent.at || stage.durationMs !== Math.max(0, Date.parse(intent.at) - Date.parse(stage.attempt.startedAt))) context.addIssue({ code: 'custom', path: ['stages', index], message: 'interruption timing must derive from the bound attempt start and intent timestamp' });
  }
});
export type RecoveryIntent = z.infer<typeof RecoveryIntentSchema>;
function binding(state: StoreState): RecoveryIntent['binding'] {
  const revision = state.queryState?.planRevision;
  return {
    runId: state.runId, projectDir: resolve(state.projectDir), checkpoint: digest(state.engineCheckpoint),
    planRevision: revision ? { revision: revision.revision, digest: revision.digest } : undefined,
    currentIteration: state.currentIteration, maxIterations: state.maxIterations, maxRetries: state.maxRetries,
  };
}
function interruptionError(previous: EngineCheckpoint): string {
  return `HOST_RESTART_INTERRUPTED: prior boot ${previous.bootId}; no authored product rejection or successful completion is inferred`;
}
/** Match the persisted closed attempt, including fields completeStageAttempt clears. */
function closedAttempt(stage: RecoveryIntent['stages'][number], previous: EngineCheckpoint): StageAttempt {
  return {
    ...stage.attempt, status: 'failed', completedAt: stage.completedAt, duration_ms: stage.durationMs,
    exitCode: 143, tokenUsage: 'unknown', error: interruptionError(previous),
    tokens_in: undefined, tokens_out: undefined, adapterFailureKind: undefined, writes: undefined,
    writeAttribution: undefined, validationGeneratedWrites: undefined, constraintAudit: undefined, timeout: undefined,
  };
}
function matchesStage(current: StageStatus | undefined, stage: RecoveryIntent['stages'][number], previous: EngineCheckpoint): boolean {
  const attempts = current?.attempts, attempt = attempts?.at(-1);
  if (!attempt || current?.retries !== stage.retries || digest(attempts!.slice(0, -1)) !== stage.prefixDigest) return false;
  if (current.status === STAGE_STATUS.RUNNING) return digest(attempt) === digest(stage.attempt);
  return ([STAGE_STATUS.FAILED, STAGE_STATUS.PENDING] as readonly string[]).includes(current.status)
    && digest(attempt) === digest(closedAttempt(stage, previous));
}
export function readHostBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}


export function engineGeneration(): string | undefined {
  return (readBuildManifest(import.meta.dirname) ?? readBuildManifest(join(import.meta.dirname, '..', 'dist')))?.generation;
}
export function captureEngineCheckpoint(projectDir: string, runId: string): EngineCheckpoint {
  runId = canonicalRunId(runsRoot(projectDir), runId);
  return { version: 1, runId, projectDir: resolve(projectDir), bootId: readHostBootId(), generation: engineGeneration(), pid: process.pid, processStart: processStartToken(process.pid), at: new Date().toISOString() };
}

/** The caller has already excluded a live scheduler/direct runner. PID absence alone is insufficient. */
export function reconcileHostInterruptedRun(projectDir: string, runId: string, evidence: { currentBootId?: string; currentGeneration?: string; expectedCheckpoint?: EngineCheckpoint; assertSchedulerAbsent?: () => void } = {}): StoreState {
  runId = canonicalRunId(runsRoot(projectDir), runId);
  let state = readRunState(projectDir, runId);
  if (state.status !== RUN_STATUS.RUNNING || (!state.engineCheckpoint && !state.recoveryIntent)) return state;
  if (state.runId !== runId || resolve(state.projectDir) !== resolve(projectDir) || !state.engineCheckpoint || state.engineCheckpoint.version !== 1 || state.engineCheckpoint.runId !== runId || resolve(state.engineCheckpoint.projectDir) !== resolve(projectDir)) throw new Error('RECOVERY_RUN_BINDING: checkpoint is not bound to this run/project');
  if (evidence.expectedCheckpoint && digest(state.engineCheckpoint) !== digest(evidence.expectedCheckpoint)) throw new Error('RECOVERY_STATE_CHANGED: checkpoint changed since daemon observation');
  const boot = evidence.currentBootId ?? readHostBootId();
  const generation = evidence.currentGeneration ?? engineGeneration();
  const previous = state.engineCheckpoint;
  const errors: string[] = [];
  if (!previous.bootId || !boot || previous.bootId === boot) errors.push('RECOVERY_FATE_UNKNOWN: no proven previous-boot death; a missing controller may leave consumers alive');
  if (!previous.generation || !generation || previous.generation !== generation) errors.push('RECOVERY_GENERATION_MISMATCH: resume requires the same verified engine generation');
  if (Boolean(state.planControl) !== Boolean(state.queryState?.planRevision) || (state.planControl && planDigest(state.planControl.stages) !== state.queryState?.planRevision?.digest)) errors.push('RECOVERY_PLAN_UNBOUND: admitted plan revision is unavailable or does not match the persisted plan');
  let intent: RecoveryIntent | undefined;
  if (state.recoveryIntent) {
    const parsed = RecoveryIntentSchema.safeParse(state.recoveryIntent);
    if (!parsed.success) errors.push(`RECOVERY_INTENT_INVALID: ${parsed.error.message}`);
    // A claimed new checkpoint supersedes a completed recovery, never unfinished intent.
    else if (!(parsed.data.phase === 'committed' && state.recovery?.kind === 'resuming' && parsed.data.binding.checkpoint !== digest(previous))) intent = parsed.data;
  }
  const running = Object.entries(state.stages).filter(([, stage]) => stage.status === STAGE_STATUS.RUNNING).map(([id]) => id);
  const interruptedStages = intent?.stages.map((stage) => stage.stageId) ?? running;
  // Call only inside the same run-local lock as native cancellation. Check the
  // whole interrupted set again before each publication, including crash-split
  // ledgers/projections. No text marker supplies interruption authority.
  function assertIntentAuthority(current: StoreState, authority: RecoveryIntent): void {
    if (digest(current.recoveryIntent) !== digest(authority) || digest(binding(current)) !== digest(authority.binding)) throw new Error('RECOVERY_INTENT_UNBOUND: interruption authority changed during reconciliation');
    if (Object.entries(current.stages).some(([id, status]) => status.status === STAGE_STATUS.RUNNING && !interruptedStages.includes(id))) throw new Error('RECOVERY_ATTEMPT_UNBOUND: running stage is absent from the durable interruption set');
    for (const stage of authority.stages) {
      if (!matchesStage(current.stages[stage.stageId], stage, previous) || !matchesStage(readStageStatus(projectDir, runId, stage.stageId), stage, previous)) throw new Error(`RECOVERY_ATTEMPT_UNBOUND: ${stage.stageId} changed during reconciliation`);
    }
  }
  if (intent && digest(intent.binding) !== digest(binding(state))) errors.push('RECOVERY_INTENT_UNBOUND: run, checkpoint, plan revision or iteration/retry budget differs from interruption intent');
  if (!errors.length) {
    if (running.some((stageId) => !interruptedStages.includes(stageId))) errors.push('RECOVERY_ATTEMPT_UNBOUND: running stage is absent from the durable interruption set');
    for (const stageId of interruptedStages) {
      try {
        const current = readStageStatus(projectDir, runId, stageId);
        const stage = intent?.stages.find((stage) => stage.stageId === stageId);
        if (stage ? !matchesStage(current, stage, previous) || !matchesStage(state.stages[stageId], stage, previous)
          : current.status !== STAGE_STATUS.RUNNING || current.attempts?.at(-1)?.status !== STAGE_STATUS.RUNNING || digest(current) !== digest(state.stages[stageId])) errors.push(`RECOVERY_ATTEMPT_UNBOUND: ${stageId} has no matching interrupted execution ledger`);
      } catch (error) { errors.push(`RECOVERY_ATTEMPT_UNBOUND: ${stageId}: ${String(error)}`); }
    }
    if (!intent && Object.values(state.stages).some((stage) => stage.status === STAGE_STATUS.FAILED && stage.attempts?.at(-1)?.exitCode === 143 && stage.attempts.at(-1)?.error?.startsWith('HOST_RESTART_INTERRUPTED:'))) {
      errors.push('RECOVERY_INTENT_REQUIRED: failed143 interruption has no durable engine intent; retain the failure and migrate with authenticated attempt evidence');
    }
  }
  if (!errors.length && !intent && interruptedStages.length) {
    const at = new Date().toISOString();
    const parsed = RecoveryIntentSchema.safeParse({ version: 1, phase: 'prepared', at, binding: binding(state), stages: interruptedStages.map((stageId) => {
      const current = readStageStatus(projectDir, runId, stageId), attempts = current.attempts!;
      return { stageId, retries: current.retries, attempt: attempts.at(-1), prefixDigest: digest(attempts.slice(0, -1)), completedAt: at, durationMs: Math.max(0, Date.parse(at) - Date.parse(attempts.at(-1)!.startedAt)) };
    }) });
    if (!parsed.success) errors.push(`RECOVERY_INTENT_INVALID: ${parsed.error.message}`);
    else {
      intent = parsed.data;
      const snapshot = digest(state);
      // Persist authority before either stage-ledger or run-projection publication.
      state = updateRunState(projectDir, runId, (current) => {
        if (current.status !== RUN_STATUS.RUNNING) return;
        evidence.assertSchedulerAbsent?.();
        if (digest(current) !== snapshot) throw new Error('RECOVERY_STATE_CHANGED: run changed before interruption intent was committed');
        current.recoveryIntent = intent;
      });
      if (state.status !== RUN_STATUS.RUNNING) return state;
    }
  }
  if (!errors.length && intent) for (const stage of intent.stages) {
    const authority = intent;
    state = updateStageStatusUnderRunLock(projectDir, runId, stage.stageId, (current, ledger) => {
      if (current.status !== RUN_STATUS.RUNNING) return undefined;
      evidence.assertSchedulerAbsent?.();
      assertIntentAuthority(current, authority);
      // A closed failed143 attempt is retained, never completed a second time.
      return ledger.attempts!.at(-1)!.status === STAGE_STATUS.RUNNING
        ? completedStageAttemptStatus(ledger, stage.retries, {
          exitCode: 143, duration_ms: stage.durationMs, completedAt: stage.completedAt, error: interruptionError(previous),
        }) : ledger;
    });
    if (state.status !== RUN_STATUS.RUNNING) return state;
    state = updateStageStatusUnderRunLock(projectDir, runId, stage.stageId, (current, ledger) => {
      if (current.status !== RUN_STATUS.RUNNING) return undefined;
      evidence.assertSchedulerAbsent?.();
      assertIntentAuthority(current, authority);
      return rependStageStatus(ledger, stage.retries);
    });
    if (state.status !== RUN_STATUS.RUNNING) return state;
  }
  const reason = errors.length ? errors.join('; ') : 'HOST_RESTART_RESUMABLE: interrupted executions retained; completed work and iteration budget preserved';
  let published = false;
  updateRunState(projectDir, runId, (current) => {
    published = false;
    // This also fences the blocked/error route and the no-interrupted-work case.
    if (current.status !== RUN_STATUS.RUNNING) return;
    evidence.assertSchedulerAbsent?.();
    if (digest(binding(current)) !== digest(binding(state))) throw new Error('RECOVERY_STATE_CHANGED: checkpoint, plan or budgets changed before recovery commit');
    if (!errors.length && intent) {
      assertIntentAuthority(current, intent);
      if (intent.stages.some((stage) => current.stages[stage.stageId]?.status !== STAGE_STATUS.PENDING || !matchesStage(current.stages[stage.stageId], stage, previous))) throw new Error('RECOVERY_NOT_RUNNABLE: interrupted work must be pending before resumable publication');
      current.recoveryIntent = { ...intent, phase: 'committed' };
    }
    current.status = 'parked';
    delete current.completedAt;
    current.failureReason = reason;
    current.recovery = { kind: errors.length ? 'blocked' : 'resumable', reason, at: new Date().toISOString(), fromBoot: previous.bootId, toBoot: boot, generation: previous.generation, interruptedStages };
    published = true;
  }, (current) => {
    if (published) recordRunEvent(projectDir, runId, { type: 'recovery_reconciled', runId, timestamp: current.recovery!.at, detail: reason, source: 'scheduler', level: errors.length ? 'warning' : 'info' });
  });
  // A native cancellation may commit immediately after our lock is released.
  return readRunState(projectDir, runId);
}
