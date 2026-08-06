import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const HARD_CAP_OBSERVATION_TOLERANCE_MS = 500;

export interface TechnicalChainEvent {
  type: string;
  chainId: string;
  observedAt: string;
  elapsedMs: number;
  remainingMs: number;
  [key: string]: unknown;
}

export interface TechnicalChainSnapshot {
  chainId: string;
  initialBudgetMs: number;
  hardTotalMs: number;
  chainStartedAt: string;
  hardDeadlineAt: string;
  chargedElapsedMs: number;
  hardRemainingMs: number;
  hardDeadlineReachedAt?: string;
  terminationCause?: 'hard_cap_timeout' | 'hard_cap_clock_uncertain';
}

export interface TechnicalChainClock {
  monotonicNow(): number;
  wallNow(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: TechnicalChainClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export class TechnicalChainController {
  readonly chainId: string;
  readonly initialBudgetMs: number;
  readonly hardTotalMs: number;
  readonly chainStartedAt: string;
  readonly hardDeadlineAt: string;
  readonly signal: AbortSignal;
  readonly ledgerPath?: string;

  private readonly clock: TechnicalChainClock;
  private readonly startedMono: number;
  private readonly deadlineMono: number;
  private readonly baseChargedMs: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private deadlineReachedWall?: number;
  private cause?: 'hard_cap_timeout' | 'hard_cap_clock_uncertain';

  constructor(input: {
    initialBudgetMs: number;
    hardTotalMs?: number;
    ledgerDir?: string;
    chainId?: string;
    clock?: TechnicalChainClock;
    /** Conservative recovery projection. A backwards clock aborts instead of replenishing. */
    recovery?: { hardDeadlineAt: string; lastObservedAt: string; persistedChargedMs: number; chainStartedAt?: string };
  }) {
    this.initialBudgetMs = positiveSafeInteger(input.initialBudgetMs, 'initial timeout');
    this.hardTotalMs = positiveSafeInteger(input.hardTotalMs ?? this.initialBudgetMs * 3, 'hard total timeout');
    if (this.hardTotalMs < this.initialBudgetMs) throw new Error('hard total timeout must be at least the initial timeout');
    this.clock = input.clock ?? SYSTEM_CLOCK;
    this.chainId = input.chainId ?? randomBytes(16).toString('hex');
    this.startedMono = this.clock.monotonicNow();
    const wallStarted = this.clock.wallNow();
    let available = this.hardTotalMs;
    if (input.recovery) {
      const deadlineWall = Date.parse(input.recovery.hardDeadlineAt);
      const lastObservedWall = Date.parse(input.recovery.lastObservedAt);
      if (!Number.isFinite(deadlineWall) || !Number.isFinite(lastObservedWall) || wallStarted < lastObservedWall) {
        available = 0;
        this.cause = 'hard_cap_clock_uncertain';
      } else {
        available = Math.max(0, Math.min(
          this.hardTotalMs - Math.max(0, input.recovery.persistedChargedMs),
          deadlineWall - wallStarted,
        ));
      }
    }
    this.baseChargedMs = Math.max(0, this.hardTotalMs - available);
    const recoveredStart = input.recovery?.chainStartedAt ? Date.parse(input.recovery.chainStartedAt) : Number.NaN;
    this.chainStartedAt = Number.isFinite(recoveredStart)
      ? new Date(recoveredStart).toISOString()
      : new Date(wallStarted - this.baseChargedMs).toISOString();
    this.deadlineMono = this.startedMono + available;
    this.hardDeadlineAt = new Date(wallStarted + available).toISOString();
    this.signal = this.controller.signal;
    if (input.ledgerDir) {
      mkdirSync(input.ledgerDir, { recursive: true });
      this.ledgerPath = join(input.ledgerDir, `technical_chain_${this.chainId}.jsonl`);
    }
    this.append('chain_created', {
      initialBudgetMs: this.initialBudgetMs,
      hardTotalMs: this.hardTotalMs,
      chainStartedAt: this.chainStartedAt,
      hardDeadlineAt: this.hardDeadlineAt,
      recovered: input.recovery !== undefined,
    });
    this.timer = this.clock.setTimer(() => this.abortAtHardDeadline(), Math.max(0, available));
    if (available <= 0) this.abortAtHardDeadline();
  }

  elapsedMs(): number {
    return Math.max(0, Math.min(this.hardTotalMs, this.baseChargedMs + this.clock.monotonicNow() - this.startedMono));
  }

  /** Correlated attempt-start samples from the controller's injected clock. */
  sampleTime(): { elapsedMs: number; wallNowMs: number } {
    return { elapsedMs: this.elapsedMs(), wallNowMs: this.clock.wallNow() };
  }

  scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.clock.setTimer(callback, delayMs);
  }

  clearScheduledTimer(timer: ReturnType<typeof setTimeout>): void {
    this.clock.clearTimer(timer);
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMono - this.clock.monotonicNow());
  }

  maxAttemptBudgetMs(): number {
    return Math.max(0, this.hardTotalMs - this.elapsedMs());
  }

  isHardExpired(): boolean {
    return this.signal.aborted || this.remainingMs() <= 0;
  }

  terminationCause(): 'hard_cap_timeout' | 'hard_cap_clock_uncertain' | undefined {
    return this.cause;
  }

  hardDeadlineReachedAt(): string | undefined {
    return this.deadlineReachedWall === undefined ? undefined : new Date(this.deadlineReachedWall).toISOString();
  }

  deadlineOverrunMs(observedWall = this.clock.wallNow()): number {
    if (this.deadlineReachedWall === undefined) return 0;
    return Math.max(0, observedWall - this.deadlineReachedWall);
  }

  snapshot(): TechnicalChainSnapshot {
    return {
      chainId: this.chainId,
      initialBudgetMs: this.initialBudgetMs,
      hardTotalMs: this.hardTotalMs,
      chainStartedAt: this.chainStartedAt,
      hardDeadlineAt: this.hardDeadlineAt,
      chargedElapsedMs: Math.round(this.elapsedMs()),
      hardRemainingMs: Math.max(0, Math.floor(this.remainingMs())),
      hardDeadlineReachedAt: this.hardDeadlineReachedAt(),
      terminationCause: this.cause,
    };
  }

  append(type: string, detail: Record<string, unknown> = {}): void {
    if (!this.ledgerPath) return;
    const event: TechnicalChainEvent = {
      type,
      chainId: this.chainId,
      observedAt: new Date(this.clock.wallNow()).toISOString(),
      elapsedMs: Math.round(this.elapsedMs()),
      remainingMs: Math.max(0, Math.floor(this.remainingMs())),
      ...detail,
    };
    try { appendFileSync(this.ledgerPath, `${JSON.stringify(event)}\n`, 'utf-8'); } catch { /* audit is also copied into attempt status */ }
  }

  nextTimeoutBudget(previousEffectiveBudgetMs: number): number | undefined {
    const remaining = Math.max(0, Math.floor(this.remainingMs()));
    const next = Math.min(previousEffectiveBudgetMs * 2, remaining);
    if (!Number.isSafeInteger(next) || next <= previousEffectiveBudgetMs) {
      this.append('retry_rejected', { previousEffectiveBudgetMs, remainingMs: remaining, reason: 'hard_cap_exhausted' });
      return undefined;
    }
    this.append('retry_budget_selected', { previousEffectiveBudgetMs, nextBudgetMs: next, remainingMs: remaining });
    return next;
  }

  async boundedSleep(delayMs: number, externalAbortSignal?: AbortSignal): Promise<boolean> {
    const duration = Math.min(Math.max(0, delayMs), Math.max(0, this.remainingMs()));
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
    this.clock.clearTimer(this.timer);
  }

  private abortAtHardDeadline(): void {
    if (this.controller.signal.aborted) return;
    this.deadlineReachedWall = this.clock.wallNow();
    this.cause ??= 'hard_cap_timeout';
    this.append('hard_deadline_reached', { terminationCause: this.cause });
    this.controller.abort(this.cause);
  }
}

export type TechnicalRetryTerminalDecision = 'soft_timeout' | 'hard_cap_exhausted';

export interface TechnicalRetryBudgetState {
  controller: TechnicalChainController;
  currentBudgetMs: number;
  previousEffectiveBudgetMs?: number;
  increaseAfterTimeout: boolean;
  attemptsStarted: number;
}

export interface TechnicalRetryContext {
  previousBudgetMs: number;
  nextBudgetMs: number;
  chargedElapsedMs: number;
  remainingHardTotalMs: number;
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

export function createTechnicalRetryBudgetState(input: {
  controller: TechnicalChainController;
  currentBudgetMs?: number;
  previousEffectiveBudgetMs?: number;
  increaseAfterTimeout?: boolean;
  attemptsStarted?: number;
}): TechnicalRetryBudgetState {
  return {
    controller: input.controller,
    currentBudgetMs: input.currentBudgetMs ?? input.controller.initialBudgetMs,
    previousEffectiveBudgetMs: input.previousEffectiveBudgetMs,
    increaseAfterTimeout: input.increaseAfterTimeout ?? false,
    attemptsStarted: input.attemptsStarted ?? 0,
  };
}

/**
 * Applies one scheduler-level retry event. Production and deterministic tests
 * share this transition; only the controller's explicitly supplied clock
 * differs. The production controller continues to default to SYSTEM_CLOCK.
 */
export function transitionTechnicalRetryBudget(
  state: TechnicalRetryBudgetState,
  event: TechnicalRetryBudgetEvent,
): TechnicalRetryBudgetTransition {
  if (event.type === 'attempt_finished' || event.type === 'attempt_timed_out') {
    state.previousEffectiveBudgetMs = event.effectiveBudgetMs;
    state.increaseAfterTimeout = event.type === 'attempt_timed_out';
    return { type: 'state_updated' };
  }

  if (event.type === 'retry_exhausted') {
    if (!state.increaseAfterTimeout) {
      throw new Error('retry_exhausted requires a preceding attempt_timed_out event');
    }
    state.increaseAfterTimeout = false;
    return { type: 'terminal', terminalDecision: 'soft_timeout' };
  }

  if (state.controller.isHardExpired()) {
    return { type: 'terminal', terminalDecision: 'hard_cap_exhausted' };
  }
  if (state.attemptsStarted === 0) {
    state.attemptsStarted++;
    return { type: 'attempt_prepared', budgetMs: state.currentBudgetMs };
  }
  if (state.increaseAfterTimeout) {
    const previous = state.previousEffectiveBudgetMs ?? state.currentBudgetMs;
    const remainingBefore = Math.max(0, Math.floor(state.controller.remainingMs()));
    const next = state.controller.nextTimeoutBudget(previous);
    if (next === undefined) {
      return { type: 'terminal', terminalDecision: 'hard_cap_exhausted' };
    }
    state.currentBudgetMs = next;
    state.increaseAfterTimeout = false;
    state.attemptsStarted++;
    return {
      type: 'attempt_prepared',
      budgetMs: next,
      retryContext: {
        previousBudgetMs: previous,
        nextBudgetMs: next,
        chargedElapsedMs: Math.round(state.controller.elapsedMs()),
        remainingHardTotalMs: remainingBefore,
      },
    };
  }
  const budgetMs = Math.min(
    state.currentBudgetMs,
    Math.max(0, Math.floor(state.controller.remainingMs())),
  );
  if (budgetMs <= 0) {
    return { type: 'terminal', terminalDecision: 'hard_cap_exhausted' };
  }
  state.attemptsStarted++;
  return { type: 'attempt_prepared', budgetMs };
}
