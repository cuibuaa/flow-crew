import { isAbsolute, relative, resolve } from 'node:path';

export const APPROVAL_REQUEST_FILE = 'approval_request.json';
export const APPROVALS_DIR = 'approvals';

const APPROVAL_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidApprovalRequestId(requestId: string): boolean {
  return APPROVAL_REQUEST_ID.test(requestId);
}

function assertContained(baseDir: string, targetPath: string): void {
  const rel = relative(baseDir, targetPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`approval artifact escapes its directory: ${targetPath}`);
  }
}

/**
 * Resolve an agent-addressable approval artifact under the run's approvals
 * directory. The strict id check is the primary guard; the resolved containment
 * assertion is defense in depth for every caller that writes or moves a file.
 */
export function approvalArtifactPath(
  runDirPath: string,
  requestId: string,
  kind: 'request' | 'decision',
): string {
  if (!isValidApprovalRequestId(requestId)) {
    throw new Error(`unsafe approval request id: ${requestId}`);
  }
  const approvalsDir = resolve(runDirPath, APPROVALS_DIR);
  const target = resolve(approvalsDir, `${requestId}.${kind}.json`);
  assertContained(approvalsDir, target);
  return target;
}

/** Existing-run approval resumes are registered with the daemon, with the same run identity. */
export function approvalResumeArgs(state: {
  workflowName?: string; maxIterations?: number; supervise?: boolean;
  campaignId?: string; campaignStorageKey?: string; adapter?: unknown;
}): string[] {
  const args = ['--workflow', state.workflowName || 'default'];
  if (state.maxIterations !== undefined) args.push('--max-iterations', String(state.maxIterations));
  if (state.supervise === false) args.push('--no-supervise');
  if (typeof state.adapter === 'string') args.push('--adapter', state.adapter);
  const campaign = state.campaignId ?? state.campaignStorageKey;
  if (campaign) args.push('--campaign', campaign);
  else args.push('--no-campaign');
  return args;
}
