import { inspectRunScheduler, type RunSchedulerObservation } from './run-lock.js';
import {
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  readArchivedRunState,
  runDir,
} from './store.js';

interface RunStandingKnown<K extends 'live' | 'parked' | 'ended' | 'orphaned', L extends boolean> {
  kind: K;
  live: L;
  runId: string;
  runStatus: string;
  completedAt?: string;
  scheduler: RunSchedulerObservation;
  reason: string;
}

export type ApprovalRunStanding =
  | RunStandingKnown<'live', true>
  | RunStandingKnown<'parked', false>
  | RunStandingKnown<'ended', false>
  | RunStandingKnown<'orphaned', false>
  | {
      kind: 'unknown';
      live: null;
      runId: string;
      runStatus?: string;
      completedAt?: string;
      scheduler?: RunSchedulerObservation;
      reason: string;
    };

/**
 * Project an approval's owning run at read time. Approval state remains an
 * append-only human obligation; lifecycle/process evidence only says whether
 * the requester can still consume a decision without a separate restart.
 */
export function inspectApprovalRunStanding(projectDir: string, runId: string): ApprovalRunStanding {
  let archived: ReturnType<typeof readArchivedRunState>;
  try {
    archived = readArchivedRunState(projectDir, runId);
  } catch (error) {
    return {
      kind: 'unknown',
      live: null,
      runId,
      reason: `run state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const scheduler = inspectRunScheduler(runId, runDir(projectDir, runId));
  const completedAt = typeof archived.state.completedAt === 'string'
    ? archived.state.completedAt
    : undefined;
  if (archived.status.kind === 'unknown') {
    return {
      kind: 'unknown',
      live: null,
      runId,
      runStatus: archived.status.display,
      ...(completedAt ? { completedAt } : {}),
      scheduler,
      reason: archived.status.reason,
    };
  }

  const runStatus = archived.status.status;
  const common = {
    runId,
    runStatus,
    ...(completedAt ? { completedAt } : {}),
    scheduler,
  };
  if (archived.status.semantics.lifecycle === 'terminal') {
    return {
      ...common,
      kind: 'ended',
      live: false,
      reason: `originating run reached terminal status ${runStatus}`,
    };
  }
  if (isPausedRunStatus(runStatus) || isAwaitingApprovalRunStatus(runStatus)) {
    return {
      ...common,
      kind: 'parked',
      live: false,
      reason: `originating run is intentionally waiting in status ${runStatus}`,
    };
  }
  if (scheduler.kind === 'live') {
    return {
      ...common,
      kind: 'live',
      live: true,
      reason: `scheduler pid ${scheduler.pid} is identity-bound to the originating run`,
    };
  }
  if (scheduler.kind === 'missing' || scheduler.kind === 'dead' || scheduler.kind === 'reused') {
    return {
      ...common,
      kind: 'orphaned',
      live: false,
      reason: scheduler.kind === 'missing'
        ? 'originating run is nonterminal but has no scheduler process marker'
        : scheduler.kind === 'dead'
          ? `originating run is nonterminal but scheduler pid ${scheduler.pid} is gone`
          : `originating run is nonterminal but scheduler pid ${scheduler.pid} belongs to another process`,
    };
  }
  return {
    kind: 'unknown',
    live: null,
    runId,
    runStatus,
    ...(completedAt ? { completedAt } : {}),
    scheduler,
    reason: scheduler.detail,
  };
}
