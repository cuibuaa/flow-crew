import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ATTEMPT_TERMINATION_GRACE_MS } from './adapters/base.js';

/** Extra time for the child close event after a signal or hard escalation. */
export const ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS = 500;
/** Five-second group escalation plus close observation; this is not execution time. */
export const ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS =
  ATTEMPT_TERMINATION_GRACE_MS + ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AttemptDeadlineEvent {
  type: string;
  attemptId: string;
  observedAt: string;
  elapsedMs: number;
  remainingMs: number;
  [key: string]: unknown;
}

export interface AttemptDeadlineSnapshot {
  attemptId: string;
  budgetMs: number;
  attemptStartedAt: string;
  deadlineAt: string;
  elapsedMs: number;
  remainingMs: number;
  deadlineReachedAt?: string;
  terminationCause?: 'attempt_timeout';
}

export interface AttemptDeadlineClock {
  monotonicNow(): number;
  wallNow(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: AttemptDeadlineClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

/**
 * One controller owns one execution attempt. Adapter retries, backoff,
 * fallback loading, and child settlement all observe this same deadline.
 */
export class AttemptDeadlineController {
  readonly attemptId: string;
  readonly budgetMs: number;
  readonly attemptStartedAt: string;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
  readonly ledgerPath?: string;

  private readonly clock: AttemptDeadlineClock;
  private readonly startedMono: number;
  private readonly deadlineMono: number;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private deadlineReachedWall?: number;

  constructor(input: {
    budgetMs: number;
    ledgerDir?: string;
    attemptId?: string;
    clock?: AttemptDeadlineClock;
  }) {
    this.budgetMs = positiveSafeInteger(input.budgetMs, 'attempt timeout');
    this.clock = input.clock ?? SYSTEM_CLOCK;
    this.attemptId = input.attemptId ?? randomBytes(16).toString('hex');
    this.startedMono = this.clock.monotonicNow();
    const wallStarted = this.clock.wallNow();
    this.deadlineMono = this.startedMono + this.budgetMs;
    this.attemptStartedAt = new Date(wallStarted).toISOString();
    this.deadlineAt = new Date(wallStarted + this.budgetMs).toISOString();
    this.signal = this.controller.signal;
    if (input.ledgerDir) {
      mkdirSync(input.ledgerDir, { recursive: true });
      this.ledgerPath = join(input.ledgerDir, `attempt_deadline_${this.attemptId}.jsonl`);
    }
    this.append('attempt_deadline_created', {
      budgetMs: this.budgetMs,
      attemptStartedAt: this.attemptStartedAt,
      deadlineAt: this.deadlineAt,
    });
    this.scheduleDeadlineCheck();
  }

  elapsedMs(): number {
    return Math.max(0, this.clock.monotonicNow() - this.startedMono);
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMono - this.clock.monotonicNow());
  }

  wallNow(): number {
    return this.clock.wallNow();
  }

  scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.clock.setTimer(callback, delayMs);
  }

  clearScheduledTimer(timer: ReturnType<typeof setTimeout>): void {
    this.clock.clearTimer(timer);
  }

  isExpired(): boolean {
    return this.signal.aborted || this.remainingMs() <= 0;
  }

  terminationCause(): 'attempt_timeout' | undefined {
    return this.signal.aborted ? 'attempt_timeout' : undefined;
  }

  deadlineReachedAt(): string | undefined {
    return this.deadlineReachedWall === undefined ? undefined : new Date(this.deadlineReachedWall).toISOString();
  }

  deadlineOverrunMs(): number {
    // The deadline itself is immutable. Measure settlement beyond that
    // boundary with the same monotonic clock that created it, rather than from
    // a possibly late timer callback or an adjustable wall clock. Millisecond
    // records round any positive sub-millisecond overrun up to one.
    const overrun = this.clock.monotonicNow() - this.deadlineMono;
    return overrun > 0 ? Math.max(1, Math.ceil(overrun)) : 0;
  }

  snapshot(): AttemptDeadlineSnapshot {
    return {
      attemptId: this.attemptId,
      budgetMs: this.budgetMs,
      attemptStartedAt: this.attemptStartedAt,
      deadlineAt: this.deadlineAt,
      elapsedMs: Math.round(this.elapsedMs()),
      remainingMs: Math.max(0, Math.floor(this.remainingMs())),
      deadlineReachedAt: this.deadlineReachedAt(),
      terminationCause: this.terminationCause(),
    };
  }

  append(type: string, detail: Record<string, unknown> = {}): void {
    if (!this.ledgerPath) return;
    const event: AttemptDeadlineEvent = {
      type,
      attemptId: this.attemptId,
      observedAt: new Date(this.clock.wallNow()).toISOString(),
      elapsedMs: Math.round(this.elapsedMs()),
      remainingMs: Math.max(0, Math.floor(this.remainingMs())),
      ...detail,
    };
    try { appendFileSync(this.ledgerPath, `${JSON.stringify(event)}\n`, 'utf-8'); } catch { /* status also records the deadline result */ }
  }

  async boundedSleep(delayMs: number, externalAbortSignal?: AbortSignal): Promise<boolean> {
    const duration = Math.min(Math.max(0, delayMs), this.remainingMs());
    if (duration <= 0 || this.signal.aborted || externalAbortSignal?.aborted) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener('abort', onAbort);
        externalAbortSignal?.removeEventListener('abort', onAbort);
        this.clock.clearTimer(timer);
        resolve(completed);
      };
      const onAbort = () => finish(false);
      const timer = this.clock.setTimer(() => finish(!this.signal.aborted && !externalAbortSignal?.aborted), duration);
      this.signal.addEventListener('abort', onAbort, { once: true });
      externalAbortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  dispose(): void {
    if (this.timer) this.clock.clearTimer(this.timer);
  }

  private scheduleDeadlineCheck(): void {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      this.abortAtDeadline();
      return;
    }
    this.timer = this.clock.setTimer(() => {
      if (this.remainingMs() > 0) this.scheduleDeadlineCheck();
      else this.abortAtDeadline();
    }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining))));
  }

  private abortAtDeadline(): void {
    if (this.controller.signal.aborted) return;
    this.deadlineReachedWall = this.clock.wallNow();
    this.append('attempt_deadline_reached', { terminationCause: 'attempt_timeout' });
    this.controller.abort('attempt_timeout');
  }
}

export type TechnicalRetryTerminalDecision = 'attempt_timeout';

export interface TechnicalRetryBudgetState {
  initialBudgetMs: number;
  currentBudgetMs: number;
  previousEffectiveBudgetMs?: number;
  increaseAfterTimeout: boolean;
  attemptsStarted: number;
}

export interface TechnicalRetryContext {
  previousBudgetMs: number;
  nextBudgetMs: number;
}

export type TechnicalRetryBudgetEvent =
  | { type: 'prepare_attempt' }
  | { type: 'attempt_finished'; effectiveBudgetMs: number }
  | { type: 'attempt_timed_out'; effectiveBudgetMs: number }
  | { type: 'retry_exhausted' };

export type TechnicalRetryBudgetTransition =
  | { type: 'attempt_prepared'; budgetMs: number; retryContext?: TechnicalRetryContext }
  | { type: 'state_updated' }
  | { type: 'terminal'; terminalDecision: TechnicalRetryTerminalDecision };

export function nextTechnicalRetryBudget(previousBudgetMs: number): number {
  positiveSafeInteger(previousBudgetMs, 'previous attempt timeout');
  const next = previousBudgetMs * 2;
  if (!Number.isSafeInteger(next) || next <= previousBudgetMs) {
    throw new Error('configured stage timeout cannot produce the required strictly larger technical retry budget');
  }
  return next;
}

export function createTechnicalRetryBudgetState(input: {
  initialBudgetMs: number;
  currentBudgetMs?: number;
  previousEffectiveBudgetMs?: number;
  increaseAfterTimeout?: boolean;
  attemptsStarted?: number;
}): TechnicalRetryBudgetState {
  const initialBudgetMs = positiveSafeInteger(input.initialBudgetMs, 'initial attempt timeout');
  return {
    initialBudgetMs,
    currentBudgetMs: input.currentBudgetMs ?? initialBudgetMs,
    previousEffectiveBudgetMs: input.previousEffectiveBudgetMs,
    increaseAfterTimeout: input.increaseAfterTimeout ?? false,
    attemptsStarted: input.attemptsStarted ?? 0,
  };
}

/** Retry growth is independent of elapsed wall time and has no aggregate balance. */
export function transitionTechnicalRetryBudget(
  state: TechnicalRetryBudgetState,
  event: TechnicalRetryBudgetEvent,
): TechnicalRetryBudgetTransition {
  if (event.type === 'attempt_finished' || event.type === 'attempt_timed_out') {
    state.previousEffectiveBudgetMs = positiveSafeInteger(event.effectiveBudgetMs, 'effective attempt timeout');
    state.increaseAfterTimeout = event.type === 'attempt_timed_out';
    return { type: 'state_updated' };
  }

  if (event.type === 'retry_exhausted') {
    if (!state.increaseAfterTimeout) throw new Error('retry_exhausted requires a preceding attempt_timed_out event');
    state.increaseAfterTimeout = false;
    return { type: 'terminal', terminalDecision: 'attempt_timeout' };
  }

  if (state.attemptsStarted === 0) {
    state.attemptsStarted++;
    return { type: 'attempt_prepared', budgetMs: state.currentBudgetMs };
  }
  if (state.increaseAfterTimeout) {
    const previous = state.previousEffectiveBudgetMs ?? state.currentBudgetMs;
    const next = nextTechnicalRetryBudget(previous);
    state.currentBudgetMs = next;
    state.increaseAfterTimeout = false;
    state.attemptsStarted++;
    return {
      type: 'attempt_prepared',
      budgetMs: next,
      retryContext: { previousBudgetMs: previous, nextBudgetMs: next },
    };
  }
  state.attemptsStarted++;
  return { type: 'attempt_prepared', budgetMs: state.currentBudgetMs };
}
