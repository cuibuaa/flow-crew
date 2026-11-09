import { runRecordPath } from '../../src/run-layout.js';
/** Fixture construction only. Production has no approval writer or resolver. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../../src/store.js';
import { foldItems, type ApprovalRequest, type ApprovalResolution } from '../../src/inbox.js';
export * from '../../src/inbox.js';
export function recordRequest(req: Omit<ApprovalRequest, 'kind'>) {
  const existing = foldItems(req.runId).get(req.requestId);
  if (!existing) {
    const directory = runDir(req.projectDir, req.runId); mkdirSync(directory, { recursive: true });
    appendFileSync(runRecordPath(directory, 'approvals.jsonl'), JSON.stringify({ ...req, kind: 'request' }) + '\n');
  }
  return { item: foldItems(req.runId).get(req.requestId)!, created: !existing };
}
export function resolveRequest(project: string, run: string, request: string, decision: 'approve' | 'deny', opts: { by?: string; reason?: string; now?: () => Date } = {}) {
  const item = foldItems(run).get(request);
  if (!item || item.resolution) return { item: item!, won: false, error: 'absent or already resolved' };
  const resolution: ApprovalResolution = { kind: 'resolution', runId: run, requestId: request, decision,
    by: opts.by ?? 'fixture', reason: opts.reason, at: (opts.now?.() ?? new Date()).toISOString() };
  appendFileSync(runRecordPath(runDir(project, run), 'approvals.jsonl'), JSON.stringify(resolution) + '\n');
  return { item: foldItems(run).get(request)!, won: true };
}
export function getItem(run: string, request: string) { return foldItems(run).get(request); }
