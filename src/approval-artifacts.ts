import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isEngineOwnedRunPath, prospectivePhysicalPath } from './engine-owned-carriers.js';

export const APPROVAL_REQUEST_FILE = 'approval_request.json';
export const APPROVALS_DIR = 'approvals';

const APPROVAL_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidApprovalRequestId(requestId: string): boolean {
  return APPROVAL_REQUEST_ID.test(requestId);
}

/** Existing stage scratch authority cannot authorize engine records, another
 * stage's work, or effects outside the run. Resolve links before deciding. */
export function isStageOwnedApprovalTarget(runDirPath: string, stageId?: string, target?: string): boolean {
  if (!stageId || !target) return false;
  try {
    const run = prospectivePhysicalPath(resolve(runDirPath));
    const path = prospectivePhysicalPath(isAbsolute(target) ? target : `${run}${sep}${target}`);
    const local = relative(run, path).split(sep).join('/');
    return local.startsWith(`stages/${stageId}/`) && !isEngineOwnedRunPath(local, { id: stageId });
  } catch { return false; }
}

/**
 * Resolve an agent-addressable approval artifact under the run's approvals
 * directory. Separator-free IDs form a basename with a fixed suffix.
 */
export function approvalArtifactPath(
  runDirPath: string,
  requestId: string,
  kind: 'request' | 'decision',
): string {
  if (!isValidApprovalRequestId(requestId)) {
    throw new Error(`unsafe approval request id: ${requestId}`);
  }
  return resolve(runDirPath, APPROVALS_DIR, `${requestId}.${kind}.json`);
}

/** Existing-run approval resumes are registered with the daemon, with the same run identity. */
export function approvalResumeLaunch(state: {
  workflowName?: string; maxIterations?: number;
  campaignId?: string; campaignStorageKey?: string; adapter?: unknown;
}): import('./task-registry.js').TaskLaunchOptions {
  const workflow = state.workflowName === 'default' ? 'planner' : state.workflowName;
  const campaign = state.campaignId ?? state.campaignStorageKey;
  return {
    workflow: workflow || 'planner', maxIterations: state.maxIterations,
    ...(typeof state.adapter === 'string' ? { adapter: state.adapter } : {}),
    ...(campaign ? { campaign } : { noCampaign: true }),
  };
}
