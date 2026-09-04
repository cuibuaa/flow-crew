import { createHash } from 'node:crypto';

export const SUPERVISOR_EVENT_VERSION = 1;
export const SUPERVISOR_DEADLINE_MIN_MARGIN_MS = 60_000;

export type SupervisorEventType =
  | 'stage_transition'
  | 'gate_verdict'
  | 'artifact_change'
  | 'deadline_margin'
  | 'guidance_arrival'
  | 'scope_request'
  | 'adapter_failure';

export interface SupervisorActiveAttemptQuantity {
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  elapsedMs: number;
  remainingMs?: number;
  deadlineAt?: string;
}

export interface SupervisorEventQuantities {
  iteration: number;
  runningStageCount: number;
  activeAttempts: SupervisorActiveAttemptQuantity[];
  minArtifactDeltaBytes: number;
  deadlineMarginMs: number;
  pollIntervalMs: number;
  changedBytes: number;
  changedPathCount: number;
  supervisorAssessmentBudget: {
    used: number;
    maximum: number;
    remaining: number;
  };
  supervisorRejectBudget: {
    maximum: number;
  };
  gateRetryBudget: {
    maximum: number;
  };
  [key: string]: unknown;
}

export interface SupervisorEvent {
  version: 1;
  eventId: string;
  type: SupervisorEventType;
  observedAt: string;
  source: string;
  stageId?: string;
  quantities: SupervisorEventQuantities;
}

export interface SupervisorEventCandidate {
  type: SupervisorEventType;
  observedAt: string;
  source: string;
  stageId?: string;
  /** Immutable identity fields; observedAt is intentionally not implicit. */
  fingerprint: unknown;
  quantities: SupervisorEventQuantities;
}

export interface SupervisorEventCursorSnapshot {
  version: 1;
  seenEventIds: string[];
  pendingEvents: SupervisorEvent[];
}

const EVENT_PRIORITY: Record<SupervisorEventType, number> = {
  guidance_arrival: 0,
  scope_request: 1,
  adapter_failure: 2,
  gate_verdict: 3,
  deadline_margin: 4,
  stage_transition: 5,
  artifact_change: 6,
};
const EVENT_TYPES = new Set<SupervisorEventType>(Object.keys(EVENT_PRIORITY) as SupervisorEventType[]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function supervisorEventFingerprint(candidate: Pick<
  SupervisorEventCandidate,
  'type' | 'source' | 'stageId' | 'fingerprint'
>): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue({
    version: SUPERVISOR_EVENT_VERSION,
    type: candidate.type,
    source: candidate.source,
    stageId: candidate.stageId,
    fingerprint: candidate.fingerprint,
  }))).digest('hex');
}

export function createSupervisorEvent(candidate: SupervisorEventCandidate): SupervisorEvent {
  return {
    version: SUPERVISOR_EVENT_VERSION,
    eventId: supervisorEventFingerprint(candidate),
    type: candidate.type,
    observedAt: candidate.observedAt,
    source: candidate.source,
    ...(candidate.stageId ? { stageId: candidate.stageId } : {}),
    quantities: candidate.quantities,
  };
}

export function resolveSupervisorDeadlineMarginMs(pollIntervalMs: number): number {
  const poll = Number.isFinite(pollIntervalMs) ? Math.max(0, Math.floor(pollIntervalMs)) : 0;
  return Math.max(SUPERVISOR_DEADLINE_MIN_MARGIN_MS, poll * 2);
}

export function isCompleteSupervisorEvent(event: SupervisorEvent): boolean {
  const quantities = event.quantities;
  return event.version === SUPERVISOR_EVENT_VERSION
    && /^[0-9a-f]{64}$/.test(event.eventId)
    && EVENT_TYPES.has(event.type)
    && Number.isFinite(Date.parse(event.observedAt))
    && Boolean(event.source)
    && Number.isFinite(quantities.iteration)
    && Number.isFinite(quantities.runningStageCount)
    && Array.isArray(quantities.activeAttempts)
    && Number.isFinite(quantities.minArtifactDeltaBytes)
    && Number.isFinite(quantities.deadlineMarginMs)
    && Number.isFinite(quantities.pollIntervalMs)
    && Number.isFinite(quantities.changedBytes)
    && Number.isFinite(quantities.changedPathCount)
    && quantities.activeAttempts.every((attempt) => (
      Boolean(attempt.stageId)
      && Number.isSafeInteger(attempt.attemptIndex)
      && Number.isFinite(Date.parse(attempt.attemptStartedAt))
      && Number.isFinite(attempt.elapsedMs)
      && (attempt.remainingMs === undefined || Number.isFinite(attempt.remainingMs))
      && (attempt.deadlineAt === undefined || Number.isFinite(Date.parse(attempt.deadlineAt)))
    ))
    && Number.isFinite(quantities.supervisorAssessmentBudget?.used)
    && Number.isFinite(quantities.supervisorAssessmentBudget?.maximum)
    && Number.isFinite(quantities.supervisorAssessmentBudget?.remaining)
    && Number.isFinite(quantities.supervisorRejectBudget?.maximum)
    && Number.isFinite(quantities.gateRetryBudget?.maximum);
}

/** Durable-friendly FIFO with deterministic priority and duplicate suppression. */
export class SupervisorEventCursor {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, SupervisorEvent>();

  constructor(snapshot?: Partial<SupervisorEventCursorSnapshot>) {
    for (const id of snapshot?.seenEventIds ?? []) {
      if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) this.seen.add(id);
    }
    for (const event of snapshot?.pendingEvents ?? []) {
      if (isCompleteSupervisorEvent(event) && !this.seen.has(event.eventId)) {
        this.pending.set(event.eventId, event);
      }
    }
  }

  offer(candidates: readonly SupervisorEventCandidate[]): void {
    for (const candidate of candidates) {
      const event = createSupervisorEvent(candidate);
      if (this.seen.has(event.eventId)) continue;
      if (candidate.type === 'artifact_change') {
        // An artifact threshold is cumulative until assessed. Retain the most
        // recent aggregate instead of queuing one stale prefix per heartbeat.
        for (const [eventId, pending] of this.pending) {
          if (pending.type === 'artifact_change' && eventId !== event.eventId) this.pending.delete(eventId);
        }
      }
      if (this.pending.has(event.eventId)) continue;
      this.pending.set(event.eventId, event);
    }
  }

  next(): SupervisorEvent | undefined {
    const time = (value: string): number => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };
    const selected = [...this.pending.values()].sort((left, right) => (
      EVENT_PRIORITY[left.type] - EVENT_PRIORITY[right.type]
      || time(left.observedAt) - time(right.observedAt)
      || left.eventId.localeCompare(right.eventId)
    ))[0];
    if (!selected) return undefined;
    const coalesced = [...this.pending.values()];
    for (const event of coalesced) {
      this.pending.delete(event.eventId);
      this.seen.add(event.eventId);
    }
    return {
      ...selected,
      quantities: {
        ...selected.quantities,
        coalescedEventCount: coalesced.length,
        coalescedEventIds: coalesced.map((event) => event.eventId).sort(),
      },
    };
  }

  snapshot(): SupervisorEventCursorSnapshot {
    return {
      version: SUPERVISOR_EVENT_VERSION,
      seenEventIds: [...this.seen].slice(-4096),
      pendingEvents: [...this.pending.values()].slice(0, 512),
    };
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export interface HistoricalSupervisorReplayCall {
  index: number;
  verdict: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  selectedByReconstructableEvent: boolean;
  triggeringEvents: Array<{
    eventId: string;
    type: SupervisorEventType;
    timestamp: string;
    source: string;
    stageId?: string;
    quantities: Record<string, unknown>;
  }>;
}

export interface SupervisorReplayResult {
  beforeCalls: number;
  afterCalls: number;
  beforeTokensIn: number;
  afterTokensIn: number;
  beforeTokensOut: number;
  afterTokensOut: number;
  retained: Array<{
    callIndex: number;
    eventId: string;
    eventType: SupervisorEventType;
    tokensIn: number;
    tokensOut: number;
  }>;
  omittedCallIndexes: number[];
}

/** Counterfactual selector over the byte-anchored historical call/event binding. */
export function replayDeterministicSupervisorTimeline(
  calls: readonly HistoricalSupervisorReplayCall[],
): SupervisorReplayResult {
  const retained = calls.flatMap((call) => {
    if (!call.selectedByReconstructableEvent || call.triggeringEvents.length === 0) return [];
    const event = call.triggeringEvents[0];
    return [{
      callIndex: call.index,
      eventId: event.eventId,
      eventType: event.type,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
    }];
  });
  return {
    beforeCalls: calls.length,
    afterCalls: retained.length,
    beforeTokensIn: calls.reduce((sum, call) => sum + call.tokensIn, 0),
    afterTokensIn: retained.reduce((sum, call) => sum + call.tokensIn, 0),
    beforeTokensOut: calls.reduce((sum, call) => sum + call.tokensOut, 0),
    afterTokensOut: retained.reduce((sum, call) => sum + call.tokensOut, 0),
    retained,
    omittedCallIndexes: calls.filter((call) => !retained.some((row) => row.callIndex === call.index)).map((call) => call.index),
  };
}
