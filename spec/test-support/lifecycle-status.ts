import { resolveRunStatus, type RunStatus } from '../../src/lifecycle-status.js';

export function isActiveRunStatus(status: unknown): status is RunStatus {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known'
    && (resolution.semantics.lifecycle === 'executing' || resolution.semantics.lifecycle === 'paused');
}

export function isRunMutationBlockedStatus(status: unknown): boolean {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'unknown' || resolution.semantics.mutationBlocked;
}
