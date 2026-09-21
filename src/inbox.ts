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
 * A request-time `--always` grant remains restricted to an EXTERNAL-risk action
 * bound to an exact target. Separately, an operator may explicitly create a
 * project-bound action-pattern rule. That broader grant is never inferred from
 * a request; it exists only after an operator names both the project and action
 * pattern through the rules CLI.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { isValidApprovalRequestId } from './approval-artifacts.js';
import { readJsonlFile } from './jsonl.js';
import { fcGlobalDir, runDir, runsRoot } from './store.js';

/** Risk classes a brief may declare on a request. Only `external` is eligible for request-time `--always`. */
export type ApprovalRisk = 'external' | 'exec' | 'write' | 'unknown';

export interface ApprovalRequest {
  kind: 'request';
  runId: string;
  projectDir: string;
  /** Agent-supplied, stable within a run. The (runId, requestId) idempotency key. */
  requestId: string;
  /** What the agent wants to do, e.g. "deploy" / "spend" / "send_order". */
  action: string;
  /** The exact object of the action, e.g. "binance-mainnet" — required for request-time `--always`. */
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

/**
 * A broader grant that can only be authored by an explicit operator command.
 * `actionPattern` is an anchored glob where `*` is the sole metacharacter.
 */
export interface ProjectActionStandingRule {
  version: 1;
  kind: 'standing_rule';
  id: string;
  projectDir: string;
  actionPattern: string;
  decision: 'approve';
  grantedBy: string;
  grantedAt: string;
}

export type ApprovalStandingRule = StandingRule | ProjectActionStandingRule;

/** Compatibility shape for existing consumers, plus a stable audit identity. */
export interface StandingRuleMatch extends StandingRule {
  id: string;
  actionPattern: string;
  decision: 'approve';
  source: 'legacy_exact' | 'project_action';
}

const approvalsPath = (projectDir: string, runId: string) => join(runDir(projectDir, runId), 'approvals.jsonl');
const rulesPath = () => join(fcGlobalDir(), 'approval-rules.jsonl');

function canonicalProjectDir(projectDir: string): string {
  const absolute = resolve(projectDir);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

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
    return {
      ok: false,
      reason: `request-time --always rules are only allowed for risk=external (this request is risk=${item.risk}); approve it once, or explicitly add a project action rule with flowcrew inbox rules add`,
    };
  }
  if (!item.target) {
    return {
      ok: false,
      reason: 'request-time --always rules require an exact target; approve it once, or explicitly add a project action rule with flowcrew inbox rules add',
    };
  }
  return { ok: true };
}

export function addStandingRule(rule: StandingRule): void {
  appendJsonl(rulesPath(), { ...rule, projectDir: canonicalProjectDir(rule.projectDir) });
}

/** Legacy exact action→target rules minted by `approve --always`. */
export function listStandingRules(): StandingRule[] {
  return listApprovalStandingRules().filter(isLegacyStandingRule);
}

/** Every supported on-disk rule, preserving JSONL order for first-match semantics. */
export function listApprovalStandingRules(): ApprovalStandingRule[] {
  return readJsonl<unknown>(rulesPath()).filter(isApprovalStandingRule);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLegacyStandingRule(value: ApprovalStandingRule | unknown): value is StandingRule {
  return isRecord(value)
    && typeof value.projectDir === 'string'
    && typeof value.action === 'string'
    && typeof value.target === 'string'
    && typeof value.grantedBy === 'string'
    && typeof value.grantedAt === 'string';
}

export function isProjectActionStandingRule(
  value: ApprovalStandingRule | unknown,
): value is ProjectActionStandingRule {
  return isRecord(value)
    && value.version === 1
    && value.kind === 'standing_rule'
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.projectDir === 'string'
    && typeof value.actionPattern === 'string'
    && value.actionPattern.length > 0
    && value.decision === 'approve'
    && typeof value.grantedBy === 'string'
    && typeof value.grantedAt === 'string';
}

function isApprovalStandingRule(value: unknown): value is ApprovalStandingRule {
  return isLegacyStandingRule(value) || isProjectActionStandingRule(value);
}

function normalizeActionPattern(actionPattern: string): string {
  const normalized = actionPattern.trim();
  if (!normalized) throw new Error('standing rule action pattern must not be empty');
  if (normalized.length > 256) throw new Error('standing rule action pattern must be at most 256 characters');
  if (/\r|\n|\0/u.test(normalized)) throw new Error('standing rule action pattern must be one line');
  return normalized;
}

function actionMatchesPattern(action: string, actionPattern: string): boolean {
  const escapedParts = actionPattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`^${escapedParts.join('.*')}$`, 'u').test(action);
}

/** Stable identity for both versioned and pre-versioned rules. */
export function standingRuleId(rule: ApprovalStandingRule): string {
  if (isProjectActionStandingRule(rule)) return rule.id;
  return `legacy-${createHash('sha256')
    .update(JSON.stringify([
      canonicalProjectDir(rule.projectDir), rule.action, rule.target,
      rule.grantedBy, rule.grantedAt, rule.fromRequestId ?? '',
    ]))
    .digest('hex')
    .slice(0, 16)}`;
}

export function addProjectActionStandingRule(input: {
  projectDir: string;
  actionPattern: string;
  decision: 'approve';
  grantedBy: string;
  grantedAt?: string;
}): { rule: ProjectActionStandingRule; created: boolean } {
  const projectDir = canonicalProjectDir(input.projectDir);
  const actionPattern = normalizeActionPattern(input.actionPattern);
  const existing = listApprovalStandingRules().find((rule): rule is ProjectActionStandingRule =>
    isProjectActionStandingRule(rule)
      && canonicalProjectDir(rule.projectDir) === projectDir
      && rule.actionPattern === actionPattern
      && rule.decision === input.decision);
  if (existing) return { rule: existing, created: false };

  const rule: ProjectActionStandingRule = {
    version: 1,
    kind: 'standing_rule',
    id: randomUUID(),
    projectDir,
    actionPattern,
    decision: input.decision,
    grantedBy: input.grantedBy,
    grantedAt: input.grantedAt ?? new Date().toISOString(),
  };
  appendJsonl(rulesPath(), rule);
  return { rule, created: true };
}

/** The rule that pre-authorizes this request, if any. */
export function matchStandingRule(req: Omit<ApprovalRequest, 'kind'>): StandingRuleMatch | undefined {
  const projectDir = canonicalProjectDir(req.projectDir);
  for (const rule of listApprovalStandingRules()) {
    if (canonicalProjectDir(rule.projectDir) !== projectDir) continue;
    if (isProjectActionStandingRule(rule)) {
      if (!actionMatchesPattern(req.action, rule.actionPattern)) continue;
      return {
        projectDir,
        action: rule.actionPattern,
        target: '*',
        grantedBy: rule.grantedBy,
        grantedAt: rule.grantedAt,
        id: rule.id,
        actionPattern: rule.actionPattern,
        decision: rule.decision,
        source: 'project_action',
      };
    }
    if (req.risk !== 'external' || !req.target) continue;
    if (rule.action !== req.action || rule.target !== req.target) continue;
    return {
      ...rule,
      projectDir,
      id: standingRuleId(rule),
      actionPattern: rule.action,
      decision: 'approve',
      source: 'legacy_exact',
    };
  }
  return undefined;
}

export function revokeStandingRule(projectDir: string, action: string, target: string): boolean {
  const canonicalProject = canonicalProjectDir(projectDir);
  const rules = listApprovalStandingRules();
  const keep = rules.filter((rule) => {
    if (canonicalProjectDir(rule.projectDir) !== canonicalProject) return true;
    if (isProjectActionStandingRule(rule)) {
      return !(rule.actionPattern === action && target === '*');
    }
    return !(rule.action === action && rule.target === target);
  });
  if (keep.length === rules.length) return false;
  // Rewrite is safe here: rules are operator-scale (tens), and a revoke MUST
  // remove history rather than append a tombstone the matcher could miss.
  mkdirSync(fcGlobalDir(), { recursive: true });
  const tmp = rulesPath() + '.tmp';
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf-8');
  try { renameSync(tmp, rulesPath()); } catch { rmSync(tmp, { force: true }); return false; }
  return true;
}
