import { runRecordPath } from './run-layout.js';
/** Read-only decoding of historical approval logs for dashboard and campaign readers. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlFile } from './jsonl.js';
import { runsRoot } from './store.js';

function readJsonl<T>(path: string): T[] {
  try { return readJsonlFile<T>(path); } catch { return []; }
}

/** Only external authority needs a human. Other risks are legacy transport metadata. */
export type ApprovalRisk = 'external' | 'exec' | 'write' | 'unknown';

export interface ApprovalRequest {
  category?: string;
  amountUsd?: number;
  host?: string;
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
  /** Information request carried by the same durable inbox, grants no authority. */
  questions?: Array<{ missing: string; question: string }>;
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
  /** Exact frontmatter declaration that supplied this authority. */
  viaDeclaration?: string;
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

/**
 * Fold one run's append-only log into current items: first request wins
 * (idempotency), first resolution wins (first-responder-wins).
 *
 * Keyed by runId alone — the runs root is global, so projectDir is carried
 * INSIDE the records rather than being needed to locate them.
 */
export function foldItems(runId: string): Map<string, InboxItem> {
  const out = new Map<string, InboxItem>();
  for (const rec of readJsonl<ApprovalRequest | ApprovalResolution>(runRecordPath(join(runsRoot(), runId), 'approvals.jsonl'))) {
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
    if (!existsSync(runRecordPath(join(runsRoot(), runId), 'approvals.jsonl'))) continue;
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

