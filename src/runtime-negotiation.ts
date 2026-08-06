import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export const RUNTIME_NEGOTIATION_VERSION = 1 as const;

export type NegotiationKind = 'scope_revision' | 'timeout_extension';
export type NegotiationRequester = 'stage' | 'supervisor' | 'operator';
export type NegotiationDecider = 'scheduler-policy' | 'worker-policy';
export type ScopeStageKind = 'ordinary' | 'gate';
export type ScopePresence = 'missing' | 'present';

interface RuntimeConstraintRequestBaseV1 {
  version: typeof RUNTIME_NEGOTIATION_VERSION;
  requestId: string;
  kind: NegotiationKind;
  stageId: string;
  attemptIndex: number;
  requestedBy: NegotiationRequester;
  reason: string;
  /** Producer wall-clock time sampled immediately before persisting the request. */
  requestedAt?: string;
}

export interface ScopeRevisionRequestV1 extends RuntimeConstraintRequestBaseV1 {
  kind: 'scope_revision';
  /** Scheduler-bound run identity; a transport proposal cannot choose another run. */
  runId: string;
  requestedPaths: string[];
  /** Digest of the canonical, normalized requestedPaths set. */
  pathDigest: string;
}

export interface TimeoutExtensionRequestV1 extends RuntimeConstraintRequestBaseV1 {
  kind: 'timeout_extension';
  requestedExtensionMs: number;
}

export type RuntimeConstraintRequestV1 = ScopeRevisionRequestV1 | TimeoutExtensionRequestV1;

export interface RuntimeConstraintDecisionV1 {
  version: typeof RUNTIME_NEGOTIATION_VERSION;
  requestId: string;
  kind: NegotiationKind;
  stageId: string;
  attemptIndex: number;
  identityDigest: string;
  requestDigest: string;
  requestedBy: NegotiationRequester;
  reason: string;
  decision: 'accepted' | 'rejected';
  accepted: boolean;
  decidedBy: NegotiationDecider;
  decidedAt: string;
  policyBasis: string;
  runId?: string;
  pathDigest?: string;
  [key: string]: unknown;
}

export interface ScopeNegotiationTransitionV1 {
  from: 'initial' | 'ready' | 'requested' | 'accepted' | 'rejected';
  event: 'scope_missing_closed' | 'declared_scope_loaded' | 'request_produced' | 'policy_accepted' | 'policy_rejected' | 'writes_enforced';
  to: 'ready' | 'requested' | 'accepted' | 'rejected' | 'settled';
  /** Complete project-write capability after this transition. */
  capability: string[];
  /** Only the request delta granted by the policy decision. */
  authorizedRequestPaths: string[];
  durableWrites?: string[];
}

export interface ScopeNegotiationTraceV1 {
  version: typeof RUNTIME_NEGOTIATION_VERSION;
  stageKind: ScopeStageKind;
  scopePresence: ScopePresence;
  decision: 'accepted' | 'rejected';
  transitions: ScopeNegotiationTransitionV1[];
}

export interface ConstraintRequestMismatchV1 {
  version: typeof RUNTIME_NEGOTIATION_VERSION;
  kind: 'constraint_request_mismatch';
  negotiationKind: NegotiationKind;
  requestId: string;
  stageId: string;
  attemptIndex: number;
  identityDigest: string;
  existingRequestDigest: string;
  conflictingRequestDigest: string;
  existingDecisionPath: string;
  observedAt: string;
  observedBy: NegotiationDecider;
  mismatchReason?: 'request_body_mismatch' | 'decision_policy_mismatch';
  existingDecisionDigest?: string;
  authoritativeDecisionDigest?: string;
}

export type ConstraintDecisionPublication =
  | { kind: 'published' | 'replayed'; decision: RuntimeConstraintDecisionV1; path: string }
  | { kind: 'mismatch'; path: string; existingPath: string; mismatch: ConstraintRequestMismatchV1 };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function negotiationIdentity(request: RuntimeConstraintRequestV1): string {
  return request.kind === 'scope_revision'
    ? sha256Canonical([request.kind, request.runId, request.stageId, request.attemptIndex, request.pathDigest, request.requestId])
    : sha256Canonical([request.kind, request.stageId, request.attemptIndex, request.requestId]);
}

export function negotiationRequestDigest(request: RuntimeConstraintRequestV1): string {
  return sha256Canonical(request);
}

function normalizedRequestPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

export function scopePathDigest(requestedPaths: string[]): string {
  const canonicalPaths = [...new Set(requestedPaths.map(normalizedRequestPath))].sort();
  return sha256Canonical(canonicalPaths);
}

/** Stable across attempts/iterations so one unresolved rejection has one planning identity. */
export function rejectedScopeDigest(input: { stageKind: ScopeStageKind; requestedPaths: string[] }): string {
  return sha256Canonical({
    kind: 'scope_revision_rejected',
    stageKind: input.stageKind,
    requestedPaths: [...new Set(input.requestedPaths.map(normalizedRequestPath))].sort(),
  });
}

export function buildScopeNegotiationTrace(input: {
  stageKind: ScopeStageKind;
  scopePresence: ScopePresence;
  declaredScope: string[];
  requestedPaths: string[];
  decision: 'accepted' | 'rejected';
  effectiveScope: string[];
  durableWrites: string[];
}): ScopeNegotiationTraceV1 {
  const initialCapability = input.scopePresence === 'present' ? [...input.declaredScope] : [];
  const accepted = input.decision === 'accepted';
  const decisionCapability = accepted ? [...input.effectiveScope] : initialCapability;
  const authorizedRequestPaths = accepted ? [...input.requestedPaths] : [];
  return {
    version: RUNTIME_NEGOTIATION_VERSION,
    stageKind: input.stageKind,
    scopePresence: input.scopePresence,
    decision: input.decision,
    transitions: [
      {
        from: 'initial',
        event: input.scopePresence === 'missing' ? 'scope_missing_closed' : 'declared_scope_loaded',
        to: 'ready',
        capability: initialCapability,
        authorizedRequestPaths: [],
      },
      {
        from: 'ready', event: 'request_produced', to: 'requested',
        capability: initialCapability, authorizedRequestPaths: [],
      },
      {
        from: 'requested', event: accepted ? 'policy_accepted' : 'policy_rejected',
        to: input.decision, capability: decisionCapability, authorizedRequestPaths,
      },
      {
        from: input.decision, event: 'writes_enforced', to: 'settled',
        capability: decisionCapability, authorizedRequestPaths, durableWrites: [...input.durableWrites],
      },
    ],
  };
}

function parseCommonRequest(
  raw: unknown,
  kind: NegotiationKind,
  requestedBy: NegotiationRequester,
): { ok: true; raw: Record<string, unknown>; common: RuntimeConstraintRequestBaseV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'request must be a JSON object' };
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== RUNTIME_NEGOTIATION_VERSION) return { ok: false, error: 'unsupported or missing request version' };
  if (candidate.kind !== undefined && candidate.kind !== kind) return { ok: false, error: `request kind must be ${kind}` };
  if (typeof candidate.requestId !== 'string' || !candidate.requestId.trim()) return { ok: false, error: 'requestId must be non-empty' };
  if (typeof candidate.stageId !== 'string' || !candidate.stageId.trim()) return { ok: false, error: 'stageId must be non-empty' };
  if (!Number.isSafeInteger(candidate.attemptIndex) || Number(candidate.attemptIndex) < 1) return { ok: false, error: 'attemptIndex must be a positive safe integer' };
  if (typeof candidate.reason !== 'string') return { ok: false, error: 'reason must be a string' };
  if (
    candidate.requestedAt !== undefined
    && (
      typeof candidate.requestedAt !== 'string'
      || !candidate.requestedAt.trim()
      || !Number.isFinite(Date.parse(candidate.requestedAt.trim()))
    )
  ) {
    return { ok: false, error: 'requestedAt must be a valid timestamp when provided' };
  }
  return {
    ok: true,
    raw: candidate,
    common: {
      version: RUNTIME_NEGOTIATION_VERSION,
      requestId: candidate.requestId.trim(),
      kind,
      stageId: candidate.stageId.trim(),
      attemptIndex: Number(candidate.attemptIndex),
      requestedBy,
      reason: candidate.reason.trim(),
      ...(typeof candidate.requestedAt === 'string' ? { requestedAt: candidate.requestedAt.trim() } : {}),
    },
  };
}

export function parseScopeRevisionRequest(
  raw: unknown,
  requestedBy: 'stage' = 'stage',
  binding?: { runId: string },
): { ok: true; request: ScopeRevisionRequestV1 } | { ok: false; error: string } {
  const common = parseCommonRequest(raw, 'scope_revision', requestedBy);
  if (!common.ok) return common;
  if (!Array.isArray(common.raw.requestedPaths)) return { ok: false, error: 'requestedPaths must be an array' };
  if (!common.raw.requestedPaths.every((value) => typeof value === 'string')) return { ok: false, error: 'every requested path must be a string' };
  const requestedPaths = [...new Set((common.raw.requestedPaths as string[]).map(normalizedRequestPath))].sort();
  const proposedRunId = common.raw.runId;
  if (proposedRunId !== undefined && (typeof proposedRunId !== 'string' || !proposedRunId.trim())) {
    return { ok: false, error: 'runId must be a non-empty string when provided' };
  }
  const runId = typeof proposedRunId === 'string' ? proposedRunId.trim() : binding?.runId.trim();
  if (!runId) return { ok: false, error: 'runId binding is required' };
  const proposedPathDigest = common.raw.pathDigest;
  if (proposedPathDigest !== undefined && (typeof proposedPathDigest !== 'string' || !proposedPathDigest.trim())) {
    return { ok: false, error: 'pathDigest must be a non-empty string when provided' };
  }
  const pathDigest = typeof proposedPathDigest === 'string' ? proposedPathDigest.trim() : scopePathDigest(requestedPaths);
  return {
    ok: true,
    request: { ...common.common, kind: 'scope_revision', runId, requestedPaths, pathDigest },
  };
}

export function parseTimeoutExtensionRequest(
  raw: unknown,
  requestedBy: NegotiationRequester,
): { ok: true; request: TimeoutExtensionRequestV1 } | { ok: false; error: string } {
  const common = parseCommonRequest(raw, 'timeout_extension', requestedBy);
  if (!common.ok) return common;
  if (typeof common.raw.requestedExtensionMs !== 'number') return { ok: false, error: 'requestedExtensionMs must be a number' };
  return {
    ok: true,
    request: {
      ...common.common,
      kind: 'timeout_extension',
      requestedExtensionMs: common.raw.requestedExtensionMs,
    },
  };
}

export function constraintDecisionPath(stagePath: string, request: RuntimeConstraintRequestV1): string {
  const prefix = request.kind === 'scope_revision' ? 'scope_revision_decision' : 'timeout_extension_decision';
  return join(stagePath, `${prefix}_attempt_${request.attemptIndex}_${negotiationIdentity(request)}.json`);
}

function mismatchPath(stagePath: string, request: RuntimeConstraintRequestV1): string {
  return join(
    stagePath,
    `constraint_request_mismatch_attempt_${request.attemptIndex}_${negotiationIdentity(request)}_${negotiationRequestDigest(request)}.json`,
  );
}

/** Publish JSON with create-only semantics. Existing content is never overwritten. */
export function publishJsonCreateOnly(target: string, value: unknown): 'published' | 'exists' {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      throw error;
    }
    try {
      const dirFd = openSync(dirname(target), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync is not supported on every platform */ }
    return 'published';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* already removed or never created */ }
  }
}

export function readConstraintDecision(path: string): RuntimeConstraintDecisionV1 | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as RuntimeConstraintDecisionV1;
    if (value.version !== RUNTIME_NEGOTIATION_VERSION) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function replayComparableDecision(decision: RuntimeConstraintDecisionV1): Record<string, unknown> {
  const { decidedAt: _decidedAt, ...comparable } = decision;
  return comparable;
}

function decisionMatchesAuthoritativePolicy(
  existing: RuntimeConstraintDecisionV1,
  authoritative: RuntimeConstraintDecisionV1,
): boolean {
  return canonicalJson(replayComparableDecision(existing)) === canonicalJson(replayComparableDecision(authoritative));
}

export function publishConstraintDecision(input: {
  stagePath: string;
  request: RuntimeConstraintRequestV1;
  decidedBy: NegotiationDecider;
  decision: {
    decision: 'accepted' | 'rejected';
    accepted: boolean;
    decidedAt: string;
    policyBasis: string;
    [key: string]: unknown;
  };
}): ConstraintDecisionPublication {
  const identityDigest = negotiationIdentity(input.request);
  const requestDigest = negotiationRequestDigest(input.request);
  const target = constraintDecisionPath(input.stagePath, input.request);
  const decision: RuntimeConstraintDecisionV1 = {
    version: RUNTIME_NEGOTIATION_VERSION,
    requestId: input.request.requestId,
    kind: input.request.kind,
    stageId: input.request.stageId,
    attemptIndex: input.request.attemptIndex,
    identityDigest,
    requestDigest,
    requestedBy: input.request.requestedBy,
    reason: input.request.reason,
    ...input.decision,
    decision: input.decision.decision,
    accepted: input.decision.accepted,
    decidedAt: input.decision.decidedAt,
    policyBasis: input.decision.policyBasis,
    decidedBy: input.decidedBy,
    ...(input.request.kind === 'scope_revision' ? {
      runId: input.request.runId,
      pathDigest: input.request.pathDigest,
      requestedPaths: input.request.requestedPaths,
    } : {}),
  };
  const existing = existsSync(target) ? readConstraintDecision(target) : undefined;
  if (existing) {
    if (
      existing.identityDigest === identityDigest
      && existing.requestDigest === requestDigest
      && decisionMatchesAuthoritativePolicy(existing, decision)
    ) {
      return { kind: 'replayed', decision: existing, path: target };
    }
    const sameRequest = existing.identityDigest === identityDigest && existing.requestDigest === requestDigest;
    const mismatch: ConstraintRequestMismatchV1 = {
      version: RUNTIME_NEGOTIATION_VERSION,
      kind: 'constraint_request_mismatch',
      negotiationKind: input.request.kind,
      requestId: input.request.requestId,
      stageId: input.request.stageId,
      attemptIndex: input.request.attemptIndex,
      identityDigest,
      existingRequestDigest: existing.requestDigest ?? 'unavailable',
      conflictingRequestDigest: requestDigest,
      existingDecisionPath: target,
      observedAt: new Date().toISOString(),
      observedBy: input.decidedBy,
      mismatchReason: sameRequest ? 'decision_policy_mismatch' : 'request_body_mismatch',
      ...(sameRequest ? {
        existingDecisionDigest: sha256Canonical(replayComparableDecision(existing)),
        authoritativeDecisionDigest: sha256Canonical(replayComparableDecision(decision)),
      } : {}),
    };
    const targetMismatch = mismatchPath(input.stagePath, input.request);
    publishJsonCreateOnly(targetMismatch, mismatch);
    return { kind: 'mismatch', path: targetMismatch, existingPath: target, mismatch };
  }

  const result = publishJsonCreateOnly(target, decision);
  if (result === 'published') return { kind: 'published', decision, path: target };

  const raced = readConstraintDecision(target);
  if (
    raced?.identityDigest === identityDigest
    && raced.requestDigest === requestDigest
    && decisionMatchesAuthoritativePolicy(raced, decision)
  ) {
    return { kind: 'replayed', decision: raced, path: target };
  }
  const sameRequest = raced?.identityDigest === identityDigest && raced.requestDigest === requestDigest;
  const mismatch: ConstraintRequestMismatchV1 = {
    version: RUNTIME_NEGOTIATION_VERSION,
    kind: 'constraint_request_mismatch',
    negotiationKind: input.request.kind,
    requestId: input.request.requestId,
    stageId: input.request.stageId,
    attemptIndex: input.request.attemptIndex,
    identityDigest,
    existingRequestDigest: raced?.requestDigest ?? 'unavailable',
    conflictingRequestDigest: requestDigest,
    existingDecisionPath: target,
    observedAt: new Date().toISOString(),
    observedBy: input.decidedBy,
    mismatchReason: sameRequest ? 'decision_policy_mismatch' : 'request_body_mismatch',
    ...(sameRequest && raced ? {
      existingDecisionDigest: sha256Canonical(replayComparableDecision(raced)),
      authoritativeDecisionDigest: sha256Canonical(replayComparableDecision(decision)),
    } : {}),
  };
  const targetMismatch = mismatchPath(input.stagePath, input.request);
  publishJsonCreateOnly(targetMismatch, mismatch);
  return { kind: 'mismatch', path: targetMismatch, existingPath: target, mismatch };
}
