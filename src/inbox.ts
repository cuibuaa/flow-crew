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
 * Standing rules ("allow this every time") are restricted the same way
 * openworker restricts them: only for an EXTERNAL-risk action bound to an exact
 * target. A shell/write/unbounded action asks forever — an "always" grant is
 * only safe when the thing it authorizes is pinned to a specific target.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isValidApprovalRequestId } from './approval-artifacts.js';
import { readJsonlFile } from './jsonl.js';
import { fcGlobalDir, runDir, runsRoot } from './store.js';

/** Risk classes a brief may declare on a request. Only `external` is eligible for a standing rule. */
export type ApprovalRisk = 'external' | 'exec' | 'write' | 'unknown';

export interface ApprovalRequest {
  kind: 'request';
  runId: string;
  projectDir: string;
  /** Agent-supplied, stable within a run. The (runId, requestId) idempotency key. */
  requestId: string;
  /** What the agent wants to do, e.g. "deploy" / "spend" / "send_order". */
  action: string;
  /** The exact object of the action, e.g. "binance-mainnet" — required for a standing rule. */
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

export interface StandingRule {
  projectDir: string;
  action: string;
  target: string;
  grantedBy: string;
  grantedAt: string;
  /** requestId that occasioned the rule — audit trail only. */
  fromRequestId?: string;
}

const approvalsPath = (projectDir: string, runId: string) => join(runDir(projectDir, runId), 'approvals.jsonl');
const rulesPath = () => join(fcGlobalDir(), 'approval-rules.jsonl');

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
 * same key returns the ORIGINAL record and appends nothing, which is what makes
 * a resumed run safe to re-scan the same request file.
 */
export function recordRequest(req: Omit<ApprovalRequest, 'kind'>): { item: InboxItem; created: boolean } {
  if (!isValidApprovalRequestId(req.requestId)) {
    throw new Error(`unsafe approval request id: ${req.requestId}`);
  }
  const path = approvalsPath(req.projectDir, req.runId);
  const existing = foldItems(req.runId).get(req.requestId);
  if (existing) return { item: existing, created: false };
  const rec: ApprovalRequest = { kind: 'request', ...req };
  appendJsonl(path, rec);
  return { item: { ...rec, state: INBOX_ITEM_STATE.PENDING }, created: true };
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
  opts: { by?: string; reason?: string; always?: boolean; viaRule?: string; now?: () => Date } = {},
): { item: InboxItem; won: boolean; error?: string } {
  if (!isValidApprovalRequestId(requestId)) {
    return { item: undefined as unknown as InboxItem, won: false, error: `unsafe request id: ${requestId}` };
  }
  const items = foldItems(runId);
  const item = items.get(requestId);
  if (!item) return { item: undefined as unknown as InboxItem, won: false, error: `unknown request: ${requestId}` };
  if (!isPendingInboxItemState(item.state)) return { item, won: false, error: `already ${item.state} by ${item.resolution?.by ?? 'unknown'}` };

  if (opts.always) {
    const eligible = standingRuleEligible(item);
    if (!eligible.ok) return { item, won: false, error: eligible.reason };
  }
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const res: ApprovalResolution = {
    kind: 'resolution', runId, requestId, resolutionId: randomUUID(), decision,
    by: opts.by ?? 'operator', at,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.always ? { always: true } : {}),
    ...(opts.viaRule ? { viaRule: opts.viaRule } : {}),
  };
  appendJsonl(approvalsPath(projectDir, runId), res);
  // Re-fold so the returned state reflects who actually won the append race.
  const settled = foldItems(runId).get(requestId)!;
  const won = settled.resolution?.resolutionId === res.resolutionId;
  if (won && decision === 'approve' && opts.always && item.target) {
    addStandingRule({
      projectDir, action: item.action, target: item.target,
      grantedBy: res.by, grantedAt: at, fromRequestId: requestId,
    });
  }
  return { item: settled, won };
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

// ------------------------------------------------------------ standing rules

/**
 * An "always allow" grant is only offered where it is machine-checkably bounded:
 * an EXTERNAL-risk action with an exact target. Exec/write actions and untargeted
 * actions ask every time — their blast radius is not pinned by the grant.
 */
export function standingRuleEligible(item: ApprovalRequest): { ok: boolean; reason?: string } {
  if (item.risk !== 'external') {
    return { ok: false, reason: `standing rules are only allowed for risk=external (this request is risk=${item.risk}); approve it once instead` };
  }
  if (!item.target) {
    return { ok: false, reason: 'standing rules require an exact target on the request; approve it once instead' };
  }
  return { ok: true };
}

export function addStandingRule(rule: StandingRule): void {
  appendJsonl(rulesPath(), rule);
}

export function listStandingRules(): StandingRule[] {
  return readJsonl<StandingRule>(rulesPath());
}

/** The rule that pre-authorizes this request, if any. */
export function matchStandingRule(req: Omit<ApprovalRequest, 'kind'>): StandingRule | undefined {
  if (req.risk !== 'external' || !req.target) return undefined;
  return listStandingRules().find((r) =>
    r.projectDir === req.projectDir && r.action === req.action && r.target === req.target);
}

export function revokeStandingRule(projectDir: string, action: string, target: string): boolean {
  const rules = listStandingRules();
  const keep = rules.filter((r) => !(r.projectDir === projectDir && r.action === action && r.target === target));
  if (keep.length === rules.length) return false;
  // Rewrite is safe here: rules are operator-scale (tens), and a revoke MUST
  // remove history rather than append a tombstone the matcher could miss.
  mkdirSync(fcGlobalDir(), { recursive: true });
  const tmp = rulesPath() + '.tmp';
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf-8');
  try { renameSync(tmp, rulesPath()); } catch { rmSync(tmp, { force: true }); return false; }
  return true;
}
