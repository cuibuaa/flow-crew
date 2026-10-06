/** Reconcile recorded supervisor signals and assess attempt/evidence freshness; no execution or mutable service registration. */
import { type RunEvent } from '../../run-events.js';
import { createHash } from 'node:crypto';
import { type StageConfig } from './configuration.js';

export interface SupervisorReplanSignalV2 {
  version: 2;
  assessmentId: string;
  targetStage: string;
  attemptIndex: number;
  attemptStartedAt: string;
  evidenceIds: string[];
  reason: string;
  timestamp: string;
}

export interface SupervisorReplanFreshness {
  decision: 'replay' | 'discard';
  signalVersion: 'legacy' | 'legacy_resolved' | 2 | 'malformed_v2';
  reason: string;
  supersedingAssessmentIds: string[];
  completedTarget: boolean;
  relatedAcceptedGateIds: string[];
}

interface SupervisorActionRecord {
  timestamp: string;
  verdict: string;
  targetStage?: string;
  reason: string;
  targetAttemptIndex?: number;
  attemptStartedAt?: string;
  assessmentId?: string;
  supersedesAssessmentId?: string;
  evidenceIds?: string[];
}

export interface ReconciledSupervisorReplan {
  signal: unknown;
  events: RunEvent[];
  identitySource: 'structured_signal' | 'supervisor_state' | 'supervisor_log' | 'unresolved_legacy';
}

function supervisorActionRecordsFromState(value: unknown): SupervisorActionRecord[] {
  if (!value || typeof value !== 'object') return [];
  const actions = (value as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((raw): SupervisorActionRecord[] => {
    if (!raw || typeof raw !== 'object') return [];
    const action = raw as Record<string, unknown>;
    const direction = action.directionEvidence && typeof action.directionEvidence === 'object'
      ? action.directionEvidence as Record<string, unknown>
      : undefined;
    if (typeof action.timestamp !== 'string'
      || !Number.isFinite(Date.parse(action.timestamp))
      || typeof action.verdict !== 'string'
      || typeof action.reason !== 'string') return [];
    const evidenceIds = Array.isArray(action.evidenceIds)
      ? action.evidenceIds.filter((id): id is string => typeof id === 'string' && /^ev_[0-9a-f]{20}$/.test(id))
      : undefined;
    return [{
      timestamp: action.timestamp,
      verdict: action.verdict,
      reason: action.reason,
      ...(typeof action.targetStage === 'string' && action.targetStage ? { targetStage: action.targetStage } : {}),
      ...(Number.isSafeInteger(action.targetAttemptIndex)
        ? { targetAttemptIndex: Number(action.targetAttemptIndex) }
        : Number.isSafeInteger(direction?.attemptIndex)
          ? { targetAttemptIndex: Number(direction?.attemptIndex) }
          : {}),
      ...(typeof direction?.attemptStartedAt === 'string' && Number.isFinite(Date.parse(direction.attemptStartedAt))
        ? { attemptStartedAt: direction.attemptStartedAt }
        : {}),
      ...(typeof action.assessmentId === 'string' && /^sa_[0-9a-f]{20}$/.test(action.assessmentId)
        ? { assessmentId: action.assessmentId }
        : {}),
      ...(typeof action.supersedesAssessmentId === 'string' && /^sa_[0-9a-f]{20}$/.test(action.supersedesAssessmentId)
        ? { supersedesAssessmentId: action.supersedesAssessmentId }
        : {}),
      ...(evidenceIds?.length ? { evidenceIds } : {}),
    }];
  });
}

function supervisorActionRecordsFromLog(value: string): SupervisorActionRecord[] {
  const sections = value.split(/(?=^## Tick \d+ — )/m);
  return sections.flatMap((section): SupervisorActionRecord[] => {
    const timestamp = /^## Tick \d+ — (\S+)$/m.exec(section)?.[1];
    const verdict = /^Verdict: \*\*([A-Z]+)\*\*(?: → (.+))?$/m.exec(section);
    const reason = /^Reason: (.*)$/m.exec(section)?.[1];
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || !verdict || reason === undefined) return [];
    const attempt = /^Direction evidence: attempt (\d+) · [0-9a-f]{64}$/m.exec(section)?.[1];
    const assessmentId = /^Assessment id: (sa_[0-9a-f]{20})$/m.exec(section)?.[1];
    const supersedesAssessmentId = /^Supersedes: (sa_[0-9a-f]{20})$/m.exec(section)?.[1];
    const cited = /^Cited evidence: (.+)$/m.exec(section)?.[1]
      ?.split(', ')
      .filter((id) => /^ev_[0-9a-f]{20}$/.test(id));
    return [{
      timestamp,
      verdict: verdict[1],
      reason,
      ...(verdict[2]?.trim() ? { targetStage: verdict[2].trim() } : {}),
      ...(attempt ? { targetAttemptIndex: Number(attempt) } : {}),
      ...(assessmentId ? { assessmentId } : {}),
      ...(supersedesAssessmentId ? { supersedesAssessmentId } : {}),
      ...(cited?.length ? { evidenceIds: cited } : {}),
    }];
  });
}

/** Reconcile the old one-shot `{reason,timestamp}` signal with the structured
 * supervisor action record that created it. The match is exact on reason and
 * bounded to one minute around publication; ambiguous or incomplete matches
 * remain legacy and cannot acquire discard authority. */
export function reconcileSupervisorReplan(input: {
  signal: unknown;
  events: readonly RunEvent[];
  supervisorState?: unknown;
  supervisorLog?: string;
}): ReconciledSupervisorReplan {
  const stateActions = supervisorActionRecordsFromState(input.supervisorState);
  const logActions = supervisorActionRecordsFromLog(input.supervisorLog ?? '');
  const actionKey = (action: SupervisorActionRecord): string => JSON.stringify([
    action.timestamp, action.verdict, action.targetStage ?? null, action.reason,
  ]);
  const stateActionKeys = new Set(stateActions.map(actionKey));
  const actionByKey = new Map<string, SupervisorActionRecord>();
  for (const action of logActions) actionByKey.set(actionKey(action), action);
  // The bounded JSON state carries attempt identity that the Markdown log does
  // not, so it wins when both serialize the same assessment.
  for (const action of stateActions) actionByKey.set(actionKey(action), action);
  const actions = [...actionByKey.values()];
  const actionEvents: RunEvent[] = actions.flatMap((action): RunEvent[] => (
    action.assessmentId
      ? [{
          type: 'supervisor_assessment',
          runId: input.events[0]?.runId ?? 'unknown',
          timestamp: action.timestamp,
          stageId: action.targetStage,
          attemptIndex: action.targetAttemptIndex,
          attemptStartedAt: action.attemptStartedAt,
          assessmentId: action.assessmentId,
          supersedesAssessmentId: action.supersedesAssessmentId,
          supervisorVerdict: action.verdict,
          evidenceIds: action.evidenceIds,
          detail: action.reason,
          source: 'supervisor',
        }]
      : []
  ));
  const events = [...input.events, ...actionEvents].filter((event, index, all) => (
    all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(event)) === index
  ));
  if (supervisorReplanSignalV2(input.signal)) {
    return { signal: input.signal, events, identitySource: 'structured_signal' };
  }
  const legacy = input.signal && typeof input.signal === 'object'
    ? input.signal as { version?: unknown; reason?: unknown; timestamp?: unknown }
    : undefined;
  if (legacy?.version === 2
    || typeof legacy?.reason !== 'string'
    || typeof legacy.timestamp !== 'string'
    || !Number.isFinite(Date.parse(legacy.timestamp))) {
    return { signal: input.signal, events, identitySource: 'unresolved_legacy' };
  }
  const signalAt = Date.parse(legacy.timestamp);
  const candidates = actions
    .filter((action) => (
      action.verdict === 'REPLAN'
      && action.reason === legacy.reason
      && action.targetStage
      && Math.abs(Date.parse(action.timestamp) - signalAt) <= 60_000
    ))
    .sort((left, right) => (
      Math.abs(Date.parse(left.timestamp) - signalAt) - Math.abs(Date.parse(right.timestamp) - signalAt)
    ));
  if (candidates.length === 0) {
    return { signal: input.signal, events, identitySource: 'unresolved_legacy' };
  }
  const closestDistance = Math.abs(Date.parse(candidates[0].timestamp) - signalAt);
  if (candidates.length > 1
    && Math.abs(Date.parse(candidates[1].timestamp) - signalAt) === closestDistance) {
    return { signal: input.signal, events, identitySource: 'unresolved_legacy' };
  }
  const action = candidates[0];
  const started = [...events]
    .filter((event) => (
      event.type === 'attempt_started'
      && event.stageId === action.targetStage
      && (action.targetAttemptIndex === undefined || event.attemptIndex === action.targetAttemptIndex)
      && Date.parse(event.timestamp) <= signalAt
      && typeof event.attemptIndex === 'number'
      && typeof event.attemptStartedAt === 'string'
    ))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
  const attemptIndex = action.targetAttemptIndex ?? started?.attemptIndex;
  const attemptStartedAt = action.attemptStartedAt ?? started?.attemptStartedAt;
  if (typeof attemptIndex !== 'number'
    || !Number.isSafeInteger(attemptIndex)
    || typeof attemptStartedAt !== 'string'
    || !Number.isFinite(Date.parse(attemptStartedAt))) {
    return { signal: input.signal, events, identitySource: 'unresolved_legacy' };
  }
  const assessmentId = action.assessmentId ?? `sa_${createHash('sha256').update(JSON.stringify([
    action.timestamp,
    action.targetStage,
    action.targetAttemptIndex,
    action.reason,
  ])).digest('hex').slice(0, 20)}`;
  return {
    signal: {
      version: 2,
      assessmentId,
      targetStage: action.targetStage!,
      attemptIndex,
      attemptStartedAt,
      evidenceIds: action.evidenceIds ?? [],
      reason: legacy.reason,
      timestamp: legacy.timestamp,
    } satisfies SupervisorReplanSignalV2,
    events,
    identitySource: stateActionKeys.has(actionKey(action)) ? 'supervisor_state' : 'supervisor_log',
  };
}

export function supervisorReplanSignalV2(value: unknown): SupervisorReplanSignalV2 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const signal = value as Partial<SupervisorReplanSignalV2>;
  if (signal.version !== 2
    || typeof signal.assessmentId !== 'string' || !/^sa_[0-9a-f]{20}$/.test(signal.assessmentId)
    || typeof signal.targetStage !== 'string' || !signal.targetStage
    || !Number.isSafeInteger(signal.attemptIndex)
    || typeof signal.attemptStartedAt !== 'string' || !Number.isFinite(Date.parse(signal.attemptStartedAt))
    || !Array.isArray(signal.evidenceIds) || !signal.evidenceIds.every((id) => typeof id === 'string')
    || typeof signal.reason !== 'string'
    || typeof signal.timestamp !== 'string' || !Number.isFinite(Date.parse(signal.timestamp))) return undefined;
  return signal as SupervisorReplanSignalV2;
}

/** Decide whether a retained structured REPLAN is still current. Legacy
 * signals remain replayable because they carry no target/assessment identity
 * with which to prove staleness. */
function transitivelyDependsOnStage(
  stage: StageConfig,
  targetStage: string,
  byId: ReadonlyMap<string, StageConfig>,
  seen = new Set<string>(),
): boolean {
  if (stage.depends_on.includes(targetStage)) return true;
  if (seen.has(stage.id)) return false;
  seen.add(stage.id);
  return stage.depends_on.some((dependency) => {
    const parent = byId.get(dependency);
    return parent ? transitivelyDependsOnStage(parent, targetStage, byId, seen) : false;
  });
}

export function evaluateSupervisorReplanFreshness(input: {
  signal: unknown;
  events: readonly RunEvent[];
  stages: readonly StageConfig[];
  passedGateIds: readonly string[];
}): SupervisorReplanFreshness {
  const raw = input.signal && typeof input.signal === 'object'
    ? input.signal as { version?: unknown }
    : {};
  if (raw.version !== 2) {
    return {
      decision: 'replay',
      signalVersion: 'legacy',
      reason: 'legacy REPLAN has no structured identity with which to prove staleness',
      supersedingAssessmentIds: [],
      completedTarget: false,
      relatedAcceptedGateIds: [],
    };
  }
  const signal = supervisorReplanSignalV2(input.signal);
  if (!signal) {
    return {
      decision: 'discard',
      signalVersion: 'malformed_v2',
      reason: 'version-2 REPLAN is malformed and cannot authorize a pivot instruction',
      supersedingAssessmentIds: [],
      completedTarget: false,
      relatedAcceptedGateIds: [],
    };
  }
  const signalAt = Date.parse(signal.timestamp);
  const laterEvents = input.events.filter((event) => Date.parse(event.timestamp) > signalAt);
  const supersedingAssessmentIds = [...new Set(laterEvents.flatMap((event) => (
    event.type === 'supervisor_assessment'
    && event.supersedesAssessmentId === signal.assessmentId
    && event.assessmentId
      ? [event.assessmentId]
      : []
  )))].sort();
  const completedTarget = laterEvents.some((event) => (
    event.type === 'stage_complete'
    && event.stageId === signal.targetStage
    && (event.attemptIndex === undefined || event.attemptIndex === signal.attemptIndex)
    && (event.attemptStartedAt === undefined || event.attemptStartedAt === signal.attemptStartedAt)
  ));
  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const relatedGateIds = new Set(input.stages
    .filter((stage) => stage.is_gate && transitivelyDependsOnStage(stage, signal.targetStage, byId))
    .map((stage) => stage.id));
  const relatedAcceptedGateIds = [...new Set(input.passedGateIds.filter((gateId) => relatedGateIds.has(gateId)))].sort();
  const decidingFacts = [
    ...(supersedingAssessmentIds.length > 0 ? [`superseded by ${supersedingAssessmentIds.join(', ')}`] : []),
    ...(completedTarget ? [`target ${signal.targetStage} execution ${signal.attemptIndex} subsequently completed`] : []),
    ...(relatedAcceptedGateIds.length > 0 ? [`related gate(s) accepted: ${relatedAcceptedGateIds.join(', ')}`] : []),
  ];
  return {
    decision: decidingFacts.length > 0 ? 'discard' : 'replay',
    signalVersion: 2,
    reason: decidingFacts.length > 0
      ? decidingFacts.join('; ')
      : 'no later supersession, target completion, or related gate acceptance was recorded',
    supersedingAssessmentIds,
    completedTarget,
    relatedAcceptedGateIds,
  };
}
