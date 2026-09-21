export const ABORT_SIGNAL_VERSION = 1 as const;

export type AbortSignalSource = 'supervisor' | 'watchdog' | 'scheduler';

/** One-shot cancellation envelope owned by one concrete stage execution. */
export interface StageAbortSignal {
  version: typeof ABORT_SIGNAL_VERSION;
  stageId: string;
  attemptIndex: number;
  reason: string;
  timestamp: string;
  source: AbortSignalSource;
  /** Present only for scheduler-owned approval suspension. */
  requestId?: string;
  /** Stage that created the approval request; peers may be suspended with it. */
  requestingStageId?: string;
  /** The model's text is retained for audit only; consumers must use `reason`. */
  unverifiedAssessmentReason?: string;
}

export type ParsedStageAbortSignal =
  | { ok: true; signal: StageAbortSignal }
  | { ok: false; error: string; observedStageId?: string; observedAttemptIndex?: number };

/** Strict parsing prevents legacy, malformed, or unowned files from killing a stage. */
export function parseStageAbortSignal(raw: string): ParsedStageAbortSignal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'signal is not an object' };
  }
  const candidate = value as Record<string, unknown>;
  const observedStageId = typeof candidate.stageId === 'string' ? candidate.stageId : undefined;
  const observedAttemptIndex = typeof candidate.attemptIndex === 'number'
    ? candidate.attemptIndex
    : undefined;
  const invalid = (error: string): ParsedStageAbortSignal => ({
    ok: false,
    error,
    observedStageId,
    observedAttemptIndex,
  });
  if (candidate.version !== ABORT_SIGNAL_VERSION) return invalid('unsupported or missing version');
  if (!observedStageId) return invalid('missing stage ownership');
  if (!Number.isSafeInteger(observedAttemptIndex) || (observedAttemptIndex ?? 0) < 1) {
    return invalid('missing or invalid attempt ownership');
  }
  if (typeof candidate.reason !== 'string') return invalid('missing reason');
  if (typeof candidate.timestamp !== 'string' || !candidate.timestamp) return invalid('missing timestamp');
  if (candidate.source !== 'supervisor' && candidate.source !== 'watchdog' && candidate.source !== 'scheduler') {
    return invalid('invalid source');
  }
  if (candidate.requestId !== undefined && (typeof candidate.requestId !== 'string' || !candidate.requestId)) {
    return invalid('invalid approval request id');
  }
  if (
    candidate.requestingStageId !== undefined
    && (typeof candidate.requestingStageId !== 'string' || !candidate.requestingStageId)
  ) {
    return invalid('invalid requesting stage id');
  }
  if (candidate.source === 'scheduler' && typeof candidate.requestId !== 'string') {
    return invalid('scheduler signal is missing approval request id');
  }
  if (
    candidate.unverifiedAssessmentReason !== undefined
    && typeof candidate.unverifiedAssessmentReason !== 'string'
  ) {
    return invalid('invalid unverified assessment reason');
  }
  return {
    ok: true,
    signal: {
      version: ABORT_SIGNAL_VERSION,
      stageId: observedStageId,
      attemptIndex: observedAttemptIndex!,
      reason: candidate.reason,
      timestamp: candidate.timestamp,
      source: candidate.source,
      ...(typeof candidate.requestId === 'string' ? { requestId: candidate.requestId } : {}),
      ...(typeof candidate.requestingStageId === 'string'
        ? { requestingStageId: candidate.requestingStageId }
        : {}),
      unverifiedAssessmentReason: candidate.unverifiedAssessmentReason,
    },
  };
}
