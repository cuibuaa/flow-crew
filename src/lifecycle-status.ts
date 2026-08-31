/** Exact run lifecycle vocabulary. Semantic groups and guards derive from this table. */
export const RUN_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PARKED: 'parked',
  COMPLETE: 'complete',
  FAILED: 'failed',
  AWAITING_APPROVAL: 'awaiting_approval',
  SHIPPED: 'shipped',
  CEILING_HIT: 'ceiling_hit',
  ESCALATED: 'escalated',
  REALITY_GATE_FAILED: 'reality_gate_failed',
  PHASE_COMPLETE: 'phase_complete',
  STOPPED: 'stopped',
  INCOMPLETE: 'incomplete',
} as const;
export type RunStatus = typeof RUN_STATUS[keyof typeof RUN_STATUS];

export type RunLifecycleBucket =
  | 'queued'
  | 'executing'
  | 'paused'
  | 'legacy_approval'
  | 'terminal';

export interface RunStatusSemantics {
  /** Exactly one lifecycle bucket; callers must not reconstruct this partition. */
  lifecycle: RunLifecycleBucket;
  /** Process-level success, including an honest research ceiling. */
  successful: boolean;
  /** Dashboard/history mutations must not race this lifecycle owner. */
  mutationBlocked: boolean;
}

/** A new status cannot compile until its lifecycle, outcome, and mutation behavior are chosen. */
export const RUN_STATUS_SEMANTICS = {
  [RUN_STATUS.PENDING]: { lifecycle: 'queued', successful: false, mutationBlocked: false },
  [RUN_STATUS.RUNNING]: { lifecycle: 'executing', successful: false, mutationBlocked: true },
  [RUN_STATUS.PARKED]: { lifecycle: 'paused', successful: false, mutationBlocked: true },
  [RUN_STATUS.COMPLETE]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.FAILED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.AWAITING_APPROVAL]: { lifecycle: 'legacy_approval', successful: false, mutationBlocked: true },
  [RUN_STATUS.SHIPPED]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.CEILING_HIT]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.ESCALATED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.REALITY_GATE_FAILED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.PHASE_COMPLETE]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.STOPPED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.INCOMPLETE]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
} as const satisfies Record<RunStatus, RunStatusSemantics>;

export type RunStatusResolution =
  | {
      kind: 'known';
      status: RunStatus;
      semantics: RunStatusSemantics;
    }
  | {
      kind: 'unknown';
      /** Original parsed JSON value. It is evidence and is never coerced. */
      raw: unknown;
      display: string;
      reason: string;
    };

function displayUnknownRunStatus(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
  } catch { /* fall through to a type-safe description */ }
  return Object.prototype.toString.call(value);
}

/** Resolve untrusted run.json text without inventing a lifecycle meaning. */
export function resolveRunStatus(value: unknown): RunStatusResolution {
  if (typeof value === 'string'
      && Object.prototype.hasOwnProperty.call(RUN_STATUS_SEMANTICS, value)) {
    const status = value as RunStatus;
    return { kind: 'known', status, semantics: RUN_STATUS_SEMANTICS[status] };
  }
  const display = displayUnknownRunStatus(value);
  return {
    kind: 'unknown',
    raw: value,
    display,
    reason: `Unrecognized archived run status ${display}; lifecycle meaning was not inferred`,
  };
}

export class UnknownRunStatusError extends Error {
  readonly resolution: Extract<RunStatusResolution, { kind: 'unknown' }>;

  constructor(value: unknown, action: string) {
    const resolution = resolveRunStatus(value);
    if (resolution.kind !== 'unknown') {
      throw new Error(`UnknownRunStatusError requires an unrecognized status, received ${resolution.status}`);
    }
    super(`Refusing to ${action}: ${resolution.reason}`);
    this.name = 'UnknownRunStatusError';
    this.resolution = resolution;
  }
}

/** Require known semantics before a consequential action. */
export function requireKnownRunStatus(value: unknown, action: string): RunStatus {
  const resolution = resolveRunStatus(value);
  if (resolution.kind === 'unknown') throw new UnknownRunStatusError(value, action);
  return resolution.status;
}

/** Single source of truth for terminal run statuses. */
export const TERMINAL_STATUSES = [
  ...Object.values(RUN_STATUS).filter((status) => (
    RUN_STATUS_SEMANTICS[status].lifecycle === 'terminal'
  )),
] as readonly RunStatus[];

export function isTerminalRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.lifecycle === 'terminal';
}

export const PAUSED_STATUSES = [
  ...Object.values(RUN_STATUS).filter((status) => (
    RUN_STATUS_SEMANTICS[status].lifecycle === 'paused'
  )),
] as readonly RunStatus[];

export function isPausedRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.lifecycle === 'paused';
}

export function isPendingRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.lifecycle === 'queued';
}

export function isActiveRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known'
    && (resolution.semantics.lifecycle === 'executing' || resolution.semantics.lifecycle === 'paused');
}

export function isRunningRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.lifecycle === 'executing';
}

export function isAwaitingApprovalRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.lifecycle === 'legacy_approval';
}

export function isRunMutationBlockedStatus(status: unknown): boolean {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'unknown' || resolution.semantics.mutationBlocked;
}

export function isSuccessfulRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' && resolution.semantics.successful;
}

export const TASK_STATUS = {
  PENDING: 'pending',
  DEFERRED: 'deferred',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  DONE: 'done',
  STUCK: 'stuck',
  NEEDS_SUMMARY: 'needs_summary',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  REALITY_GATE_FAILED: 'reality_gate_failed',
} as const;
export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS];

const ACTIVE_TASK_STATUSES = [
  TASK_STATUS.PENDING,
  TASK_STATUS.DEFERRED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.CANCELLING,
] as const;

export function isKnownTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string'
    && (Object.values(TASK_STATUS) as readonly string[]).includes(status);
}

export function isActiveTaskStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}
