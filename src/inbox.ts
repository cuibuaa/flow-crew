import { appendFileSync, mkdirSync } from './engine-fs.js';

/**
 * Approval inbox — a durable, idempotent, resolve-from-anywhere queue for the
 * consequential actions an unattended run must NOT take on its own.
 *
 * Why: before this, a campaign that reached a consequential action had exactly
 * two outcomes — do it (full autonomy) or escalate (kill the whole run). The
 * operator's real rule ("ask me before spending production money") lived only
 * as prose in a brief, i.e. enforced by the agent's goodwill. This makes it an
 * engine mechanism: the run PARKS (suspends, exits, frees the project), the
 * request waits durably, and the run resumes on the same runId after a human
 * resolves it.
 *
 * Storage: append-only JSONL at `<runDir>/approvals.jsonl`. Two record kinds —
 * `request` and `resolution`. The fold is deliberately order-based:
 *   - FIRST request per requestId wins  → re-ingesting the same agent-written
 *     request file is a no-op, so a resumed run cannot double-create it. The
 *     idempotency key is (runId, requestId).
 *   - FIRST resolution per requestId wins → first-responder-wins across every
 *     surface (CLI, dashboard, another operator) with no lock and no
 *     read-modify-write, because append order IS the arbiter.
 * There is no second source of truth to rebuild or keep in sync.
 *
 */
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { approvalArtifactPath, isStageOwnedApprovalTarget, isValidApprovalRequestId } from './approval-artifacts.js';
import { readJsonlFile } from './jsonl.js';
import { runDir, runsRoot, withRunStateLock } from './store.js';
import { appendRunEventAtRunDir, readRunEvents } from './run-events.js';
import { inspectRunScheduler } from './run-lock.js';
import { publishJsonCreateOnly } from './runtime-negotiation.js';

/** Only external authority needs a human. Other risks are legacy transport metadata. */
export type ApprovalRisk = 'external' | 'exec' | 'write' | 'unknown';

export interface ApprovalRequest {
  kind: 'request';
  runId: string;
  projectDir: string;
  /** Agent-supplied, stable within a run. The (runId, requestId) idempotency key. */
  requestId: string;
  /** What the agent wants to do, e.g. "deploy" / "spend" / "send_order". */
  action: string;
  /** The exact object of the action, e.g. "binance-mainnet" */
  target?: string;
  risk: ApprovalRisk;
  title: string;
  body?: string;
  createdAt: string;
  atIteration?: number;
  stageId?: string;
}

export interface ApprovalResolution {
  kind: 'resolution';
  runId: string;
  requestId: string;
  /** Unique append identity used to determine which concurrent resolution won. */
  resolutionId?: string;
  decision: 'approve' | 'deny';
  by: string;
  at: string;
  reason?: string;
  source?: 'operator' | 'scheduler';
  /** True when this resolution ALSO minted a standing rule. */
  always?: boolean;
  /** Set when the decision came from a pre-existing standing rule rather than a human. */
  viaRule?: string;
}

export interface InboxItem extends ApprovalRequest {
  state: InboxItemState;
  resolution?: ApprovalResolution;
}

export const INBOX_ITEM_STATE = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
} as const;
export type InboxItemState = typeof INBOX_ITEM_STATE[keyof typeof INBOX_ITEM_STATE];

export const INBOX_FILTER_STATE = {
  PENDING: INBOX_ITEM_STATE.PENDING,
  RESOLVED: 'resolved',
  ALL: 'all',
} as const;
export type InboxFilterState = typeof INBOX_FILTER_STATE[keyof typeof INBOX_FILTER_STATE];

export function isPendingInboxItemState(state: string): boolean {
  return state === INBOX_ITEM_STATE.PENDING;
}

const approvalsPath = (projectDir: string, runId: string) => join(runDir(projectDir, runId), 'approvals.jsonl');

function appendJsonl(path: string, rec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8');
}

/** Tolerates a torn final line (append-only files can be cut by a crash mid-write). */
function readJsonl<T>(path: string): T[] {
  try { return readJsonlFile<T>(path); } catch { return []; }
}

// ---------------------------------------------------------------- requests

/**
 * Record a request. Idempotent on (runId, requestId): a second call with the
 * same key retains the ORIGINAL request. Non-external requests settle once
 * under existing engine authority, including historical pending requests.
 */
export function recordRequest(req: Omit<ApprovalRequest, 'kind'>): { item: InboxItem; created: boolean } {
  if (!isValidApprovalRequestId(req.requestId)) {
    throw new Error(`unsafe approval request id: ${req.requestId}`);
  }
  const path = approvalsPath(req.projectDir, req.runId);
  const existing = foldItems(req.runId).get(req.requestId);
  const rec: ApprovalRequest = { kind: 'request', ...req };
  if (!existing) appendJsonl(path, rec);
  let item: InboxItem = existing ?? { ...rec, state: INBOX_ITEM_STATE.PENDING };
  if (isPendingInboxItemState(item.state) && item.risk !== 'external') {
    const owned = isStageOwnedApprovalTarget(runDir(item.projectDir, item.runId), item.stageId, item.target);
    item = resolveRequest(item.projectDir, item.runId, item.requestId, owned ? 'approve' : 'deny', {
      by: 'engine', source: 'scheduler',
      reason: owned
        ? 'Existing stage scratch authority; no human authorization required. This grants no external effects.'
        : 'This request grants no new authority; existing admitted work may proceed. Use execution/scope mechanisms; request risk external only for an effect outside the run.',
    }).item;
  }
  return { item, created: !existing };
}

/**
 * Resolve a request. First resolution wins: a later call returns the winning
 * resolution and appends nothing, so two operators racing on two surfaces can
 * never produce two decisions for one action.
 */
export function resolveRequest(
  projectDir: string,
  runId: string,
  requestId: string,
  decision: 'approve' | 'deny',
  opts: { by?: string; reason?: string; now?: () => Date; source?: 'operator' | 'scheduler' } = {},
): { item: InboxItem; won: boolean; error?: string } {
  if (!isValidApprovalRequestId(requestId)) {
    return { item: undefined as unknown as InboxItem, won: false, error: `unsafe request id: ${requestId}` };
  }
  const items = foldItems(runId);
  const item = items.get(requestId);
  if (!item) return { item: undefined as unknown as InboxItem, won: false, error: `unknown request: ${requestId}` };
  if (!isPendingInboxItemState(item.state)) return { item, won: false, error: `already ${item.state} by ${item.resolution?.by ?? 'unknown'}` };
  if (item.risk !== 'external' && opts.source !== 'scheduler') {
    return { item: recordRequest(item).item, won: false, error: 'this request has an engine-owned decision' };
  }

  const at = (opts.now ?? (() => new Date()))().toISOString();
  const res: ApprovalResolution = {
    kind: 'resolution', runId, requestId, resolutionId: randomUUID(), decision,
    by: opts.by ?? 'operator', at,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };
  appendJsonl(approvalsPath(projectDir, runId), res);
  // Re-fold so the returned state reflects who actually won the append race.
  const settled = foldItems(runId).get(requestId)!;
  const won = settled.resolution?.resolutionId === res.resolutionId;
  if (won) publishApprovalResolution(settled);
  return { item: settled, won };
}

/** The inbox accepts cross-process decisions. Only its resident scheduler may
 * publish canonical records while children are still running; a parked status
 * can precede their closure. With no resident, the operator publishes directly. */
export function publishApprovalResolution(item: InboxItem): void {
  const resolution = item.resolution;
  if (!resolution) return;
  const directory = runDir(item.projectDir, item.runId);
  const decisionPath = approvalArtifactPath(directory, item.requestId, 'decision');
  // A settled poll must not mutate the directory that wakes the monitor.
  if (existsSync(decisionPath) && readRunEvents(item.projectDir, item.runId).some(event => event.type === 'approval_resolved' && event.requestId === item.requestId)) return;
  withRunStateLock(directory, () => {
    const scheduler = inspectRunScheduler(item.runId, directory);
    if (scheduler.kind === 'corrupt' || scheduler.kind === 'unverifiable'
      || (scheduler.kind === 'live' && scheduler.pid !== process.pid)) return;
    publishJsonCreateOnly(decisionPath, {
      requestId: item.requestId, decision: resolution.decision, by: resolution.by,
      reason: resolution.reason ?? '', at: resolution.at,
    });
    if (!readRunEvents(item.projectDir, item.runId).some(event => event.type === 'approval_resolved' && event.requestId === item.requestId)) {
      appendRunEventAtRunDir(directory, {
        type: 'approval_resolved', runId: item.runId, timestamp: resolution.at, requestId: item.requestId,
        stageId: item.stageId, decision: resolution.decision === 'approve' ? 'accepted' : 'rejected',
        detail: `${resolution.decision} ${item.action}${item.target ? ' → ' + item.target : ''} (${item.requestId})`,
        source: resolution.source ?? 'operator',
      });
    }
  });
}

/**
 * Fold one run's append-only log into current items: first request wins
 * (idempotency), first resolution wins (first-responder-wins).
 *
 * Keyed by runId alone — the runs root is global, so projectDir is carried
 * INSIDE the records rather than being needed to locate them.
 */
export function foldItems(runId: string): Map<string, InboxItem> {
  const out = new Map<string, InboxItem>();
  for (const rec of readJsonl<ApprovalRequest | ApprovalResolution>(join(runsRoot(), runId, 'approvals.jsonl'))) {
    if (rec.kind === 'request') {
      if (!out.has(rec.requestId)) out.set(rec.requestId, { ...rec, state: INBOX_ITEM_STATE.PENDING });
    } else if (rec.kind === 'resolution') {
      const item = out.get(rec.requestId);
      if (!item || !isPendingInboxItemState(item.state)) continue;   // first resolution wins
      item.state = rec.decision === 'approve' ? INBOX_ITEM_STATE.APPROVED : INBOX_ITEM_STATE.DENIED;
      item.resolution = rec;
    }
  }
  return out;
}

export function getItem(runId: string, requestId: string): InboxItem | undefined {
  return foldItems(runId).get(requestId);
}

/**
 * Every item across all runs, newest run first. Enumeration walks run dirs but
 * only opens `approvals.jsonl` — runs that never requested anything cost one
 * failed stat, so the common case (no approvals anywhere) stays cheap.
 */
export function listAll(filter: { state?: InboxFilterState; runId?: string } = {}): InboxItem[] {
  const want = filter.state ?? INBOX_FILTER_STATE.PENDING;
  const runIds = filter.runId ? [filter.runId] : safeReaddir(runsRoot()).sort().reverse();
  const out: InboxItem[] = [];
  for (const runId of runIds) {
    if (!existsSync(join(runsRoot(), runId, 'approvals.jsonl'))) continue;
    for (const item of foldItems(runId).values()) {
      if (want === INBOX_FILTER_STATE.PENDING && !isPendingInboxItemState(item.state)) continue;
      if (want === INBOX_FILTER_STATE.RESOLVED && isPendingInboxItemState(item.state)) continue;
      out.push(item);
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

