import { randomBytes } from 'node:crypto';

import { performance } from 'node:perf_hooks';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AttemptDeadlineSnapshot {
  attemptId: string;
  budgetMs?: number;
  attemptStartedAt: string;
  deadlineAt?: string;
  budgetDeadlineAt?: string;
  wrapUpAt?: string;
  finishingMs?: number;
  elapsedMs: number;
  remainingMs?: number;
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

/** Node timers have a signed 32-bit delay. Chunk the wait, never the allowance;
 * the deadline owner supplies the remaining time at every wake-up. */
export function scheduleDeadline(callback: () => void, remainingMs: () => number, clock = SYSTEM_CLOCK): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = remainingMs();
    if (remaining <= 0) callback();
    else timer = clock.setTimer(check, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining))));
  };
  check();
  return () => clock.clearTimer(timer);
}

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
  readonly budgetMs?: number;
  readonly attemptStartedAt: string;
  readonly deadlineAt?: string;
  readonly signal: AbortSignal;
  readonly budgetDeadlineAt?: string;

  private readonly clock: AttemptDeadlineClock;
  private readonly startedMono: number;
  private readonly deadlineMono: number;
  private readonly controller = new AbortController();
  private cancelTimer?: () => void;
  private deadlineReachedWall?: number;

  constructor(input: {
    budgetMs?: number;
    attemptId?: string;
    clock?: AttemptDeadlineClock;
  }) {
    this.budgetMs = input.budgetMs === undefined ? undefined : positiveSafeInteger(input.budgetMs, 'attempt allowance');
    this.clock = input.clock ?? SYSTEM_CLOCK;
    this.attemptId = input.attemptId ?? randomBytes(16).toString('hex');
    this.startedMono = this.clock.monotonicNow();
    const wallStarted = this.clock.wallNow();
    this.deadlineMono = this.budgetMs === undefined ? Infinity : this.startedMono + this.budgetMs;
    const wallDeadline = this.budgetMs === undefined ? undefined : new Date(wallStarted + this.budgetMs);
    this.budgetDeadlineAt = wallDeadline && Number.isFinite(wallDeadline.getTime()) ? wallDeadline.toISOString() : undefined;
    this.attemptStartedAt = new Date(wallStarted).toISOString();
    this.deadlineAt = this.budgetDeadlineAt;
    this.signal = this.controller.signal;
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
      remainingMs: this.budgetMs === undefined ? undefined : Math.max(0, Math.floor(this.remainingMs())),
      deadlineReachedAt: this.deadlineReachedAt(),
      terminationCause: this.terminationCause(),
    };
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

  /** Observe monotonic expiry even when the timer callback was starved. */
  observeSettlement(): boolean {
    if (!this.signal.aborted && this.remainingMs() <= 0) this.abortAtDeadline();
    return this.signal.aborted;
  }

  dispose(): void {
    this.cancelTimer?.();
  }

  private scheduleDeadlineCheck(): void {
    if (this.budgetMs === undefined) return;
    this.cancelTimer = scheduleDeadline(() => this.abortAtDeadline(), () => this.remainingMs(), this.clock);
  }

  private abortAtDeadline(): void {
    if (this.controller.signal.aborted) return;
    this.deadlineReachedWall = this.clock.wallNow();
    this.controller.abort('attempt_timeout');
  }
}

export type TechnicalRetryTerminalDecision = 'attempt_timeout';

export interface TechnicalRetryBudgetState {
  initialBudgetMs?: number;
  previousEffectiveBudgetMs?: number;
  timedOut: boolean;
  attemptsStarted: number;
}

export interface TechnicalRetryContext {
  previousBudgetMs?: number;
  nextBudgetMs?: number;
}

export type TechnicalRetryBudgetEvent =
  | { type: 'prepare_attempt' }
  | { type: 'attempt_finished'; effectiveBudgetMs?: number }
  | { type: 'attempt_timed_out'; effectiveBudgetMs?: number }
  | { type: 'retry_exhausted' };

export type TechnicalRetryBudgetTransition =
  | { type: 'attempt_prepared'; budgetMs?: number; retryContext?: TechnicalRetryContext }
  | { type: 'state_updated' }
  | { type: 'terminal'; terminalDecision: TechnicalRetryTerminalDecision };

export function createTechnicalRetryBudgetState(input: {
  initialBudgetMs?: number;
  previousEffectiveBudgetMs?: number;
  timedOut?: boolean;
  attemptsStarted?: number;
}): TechnicalRetryBudgetState {
  const initialBudgetMs = input.initialBudgetMs === undefined ? undefined : positiveSafeInteger(input.initialBudgetMs, 'initial attempt allowance');
  return {
    initialBudgetMs,
    previousEffectiveBudgetMs: input.previousEffectiveBudgetMs,
    timedOut: input.timedOut ?? false,
    attemptsStarted: input.attemptsStarted ?? 0,
  };
}

/** Every retry receives the admitted budget, independent of prior timeouts. */
export function transitionTechnicalRetryBudget(
  state: TechnicalRetryBudgetState,
  event: TechnicalRetryBudgetEvent,
): TechnicalRetryBudgetTransition {
  if (event.type === 'attempt_finished' || event.type === 'attempt_timed_out') {
    state.previousEffectiveBudgetMs = event.effectiveBudgetMs === undefined ? undefined : positiveSafeInteger(event.effectiveBudgetMs, 'effective attempt allowance');
    state.timedOut = event.type === 'attempt_timed_out';
    return { type: 'state_updated' };
  }

  if (event.type === 'retry_exhausted') {
    if (!state.timedOut) throw new Error('retry_exhausted requires a preceding attempt_timed_out event');
    state.timedOut = false;
    return { type: 'terminal', terminalDecision: 'attempt_timeout' };
  }

  const retryContext = state.timedOut && state.attemptsStarted > 0
    ? { previousBudgetMs: state.previousEffectiveBudgetMs ?? state.initialBudgetMs, nextBudgetMs: state.initialBudgetMs }
    : undefined;
  state.timedOut = false;
  state.attemptsStarted++;
  return { type: 'attempt_prepared', budgetMs: state.initialBudgetMs, ...(retryContext ? { retryContext } : {}) };
}
