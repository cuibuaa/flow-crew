import type {
  CampaignOperatorIndex,
  CampaignOperatorView,
  CampaignRunPage,
  SourceResult,
} from "./types";

const BASE = "/api/campaigns";
const SOURCE_STATUSES = new Set(["complete", "partial", "unavailable"]);
const RUN_STATUSES = new Set([
  "pending", "running", "parked", "complete", "failed", "awaiting_approval", "shipped",
  "ceiling_hit", "escalated", "reality_gate_failed", "phase_complete", "stopped", "incomplete",
]);
const EVIDENCE_STATES = new Set(["present", "absent", "unknown"]);
const CLASSIFICATION_KINDS = new Set(["research", "engineering", "mixed", "unknown"]);
const DIRECTIONS = new Set(["higher", "lower", "unknown"]);

export class CampaignPageRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CampaignPageRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isCoverage(value: unknown): boolean {
  return isRecord(value)
    && [value.succeeded, value.failed, value.total].every(isCount);
}

function isRunReference(value: unknown): boolean {
  return isRecord(value)
    && isString(value.runId)
    && isString(value.shortName) && value.shortName.length > 0
    && isString(value.href);
}

function isSourceIssue(value: unknown): boolean {
  return isRecord(value)
    && isString(value.code) && value.code.length > 0
    && isString(value.summary) && value.summary.length > 0
    && Array.isArray(value.affectedRuns) && value.affectedRuns.every(isRunReference)
    && (value.details === undefined || isStringArray(value.details));
}

function isSource(value: unknown, validateValue: (candidate: unknown) => boolean): boolean {
  if (!isRecord(value) || !SOURCE_STATUSES.has(String(value.status))) return false;
  const issues = value.issues;
  const issuesValid = issues === undefined || (Array.isArray(issues) && issues.every(isSourceIssue));
  return value.error === undefined
    && isCoverage(value.coverage)
    && issuesValid
    && (value.status === "complete" || (Array.isArray(issues) && issues.length > 0))
    && validateValue(value.value);
}

function isClassification(value: unknown): boolean {
  return isRecord(value)
    && CLASSIFICATION_KINDS.has(String(value.kind))
    && (value.status === "complete" || value.status === "partial")
    && EVIDENCE_STATES.has(String(value.research))
    && EVIDENCE_STATES.has(String(value.engineering))
    && isCount(value.acceptedPointCount)
    && isCount(value.engineeringRunCount)
    && isStringArray(value.reasons)
    && Array.isArray(value.issues) && value.issues.every(isSourceIssue);
}

function isIdentity(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id) && value.id.length > 0
    && isString(value.name) && value.name.length > 0
    && isString(value.storageKey) && value.storageKey.length > 0
    && isCount(value.runCount)
    && isNullableString(value.startedAt)
    && new Set(["runs", "legacy", "unknown"]).has(String(value.startedAtSource))
    && isClassification(value.classification);
}

function isAttentionItem(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && new Set(["approval", "brief_review", "deferred", "parked", "worker_missing", "campaign_alert", "stale"]).has(String(value.kind))
    && isString(value.title)
    && isString(value.reason)
    && (value.runId === undefined || isString(value.runId))
    && isString(value.href)
    && new Set(["high", "medium", "low"]).has(String(value.priority))
    && (value.source === undefined || isString(value.source))
    && (value.simulated === undefined || typeof value.simulated === "boolean");
}

function isAttention(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.items) && value.items.every(isAttentionItem)
    && isCount(value.total) && isCount(value.shown);
}

function isActivityItem(value: unknown): boolean {
  return isRecord(value)
    && isString(value.runId)
    && isString(value.shortName)
    && isString(value.fullTitle)
    && RUN_STATUSES.has(String(value.status))
    && isString(value.statusExplanation)
    && (value.durationMs === null || (isFiniteNumber(value.durationMs) && value.durationMs >= 0))
    && typeof value.durationPartial === "boolean"
    && new Set(["live", "missing", "none", "unknown"]).has(String(value.worker))
    && (value.anomaly === undefined || isString(value.anomaly))
    && isString(value.href);
}

function isActivity(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.items) && value.items.every(isActivityItem)
    && isCount(value.total) && isCount(value.shown);
}

function isCost(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.wallMs) && value.wallMs >= 0
    && isFiniteNumber(value.tokens) && value.tokens >= 0
    && isFiniteNumber(value.supervisorTokens) && value.supervisorTokens >= 0
    && isCoverage(value.runCoverage)
    && isCoverage(value.wallCoverage)
    && isCoverage(value.tokenCoverage);
}

function isMeasurementPoint(value: unknown): boolean {
  return isRecord(value)
    && isString(value.runId)
    && isString(value.round)
    && isString(value.metric)
    && isString(value.metricKey)
    && isFiniteNumber(value.value)
    && isNullableString(value.timestamp)
    && DIRECTIONS.has(String(value.direction))
    && new Set(["research_journal", "campaign_ledger", "outer_campaign"]).has(String(value.evidence));
}

function isMetricGroup(value: unknown): boolean {
  return isRecord(value)
    && isString(value.metric)
    && isString(value.metricKey)
    && Array.isArray(value.points) && value.points.every(isMeasurementPoint)
    && typeof value.hasTrend === "boolean"
    && new Set(["higher", "lower", "unknown", "conflict"]).has(String(value.direction))
    && (value.best === null || isMeasurementPoint(value.best));
}

function isResearch(value: unknown): boolean {
  return value === null || (isRecord(value)
    && (value.selected === null || isMetricGroup(value.selected))
    && Array.isArray(value.otherMetrics) && value.otherMetrics.every(isMetricGroup)
    && isCount(value.acceptedPointCount)
    && isStringArray(value.confirmNotes)
    && (value.latestCanonicalStatus === null || RUN_STATUSES.has(String(value.latestCanonicalStatus))));
}

function isDelivery(value: unknown): boolean {
  return isRecord(value)
    && isString(value.runId)
    && isString(value.shortName)
    && isString(value.fullTitle)
    && RUN_STATUSES.has(String(value.status))
    && isString(value.statusExplanation)
    && isString(value.conclusion)
    && isStringArray(value.commits)
    && isStringArray(value.filesChanged)
    && isStringArray(value.gates)
    && isString(value.href);
}

function isEngineering(value: unknown): boolean {
  return value === null || (isRecord(value)
    && (value.latest === null || isDelivery(value.latest))
    && isCount(value.deliveryCount));
}

function isRunRow(value: unknown): boolean {
  return isRecord(value)
    && isString(value.runId)
    && isString(value.shortName)
    && isString(value.fullTitle)
    && RUN_STATUSES.has(String(value.status))
    && isString(value.statusExplanation)
    && isString(value.conclusion)
    && (value.durationMs === null || (isFiniteNumber(value.durationMs) && value.durationMs >= 0))
    && typeof value.durationPartial === "boolean"
    && isStringArray(value.commits)
    && isStringArray(value.gates)
    && typeof value.zeroWork === "boolean"
    && (value.zeroWorkReason === undefined || isString(value.zeroWorkReason))
    && isNullableString(value.startedAt)
    && isNullableString(value.completedAt)
    && isString(value.href);
}

function isRunPage(value: unknown): value is CampaignRunPage {
  return isRecord(value)
    && Array.isArray(value.items) && value.items.every(isRunRow)
    && isCount(value.shown) && isCount(value.total)
    && isNullableString(value.nextCursor)
    && typeof value.truncated === "boolean";
}

function isIndexRow(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.attention) || !isRecord(value.activity) || !isRecord(value.recent)) return false;
  return isString(value.id) && isString(value.name) && isCount(value.runCount)
    && isNullableString(value.latestStartedAt)
    && SOURCE_STATUSES.has(String(value.attention.status))
    && (value.attention.count === null || isCount(value.attention.count))
    && SOURCE_STATUSES.has(String(value.activity.status))
    && isCount(value.activity.running) && isCount(value.activity.waiting)
    && isString(value.activity.summary) && typeof value.activity.needsIntervention === "boolean"
    && SOURCE_STATUSES.has(String(value.recent.status))
    && (value.recent.runStatus === null || RUN_STATUSES.has(String(value.recent.runStatus)))
    && isNullableString(value.recent.statusExplanation)
    && isString(value.recent.conclusion)
    && isString(value.href);
}

function isIndexValue(value: unknown): value is CampaignOperatorIndex["campaigns"]["value"] {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isIndexRow) && isCount(value.total);
}

async function request(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = await response.clone().json() as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch { /* HTTP status remains the useful error. */ }
    throw new CampaignPageRequestError(message, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new CampaignPageRequestError("Campaign response is not valid JSON", response.status);
  }
}

async function requestText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = await response.clone().json() as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch { /* HTTP status remains the useful error. */ }
    throw new CampaignPageRequestError(message, response.status);
  }
  return response.text();
}

function assertIndex(value: unknown): CampaignOperatorIndex {
  if (!isRecord(value) || typeof value.generatedAt !== "string" || !isSource(value.campaigns, isIndexValue)) {
    throw new CampaignPageRequestError("Campaign index response does not match the page contract", 200);
  }
  return value as unknown as CampaignOperatorIndex;
}

function assertRunPage(value: unknown): SourceResult<CampaignRunPage> {
  if (!isSource(value, isRunPage)) {
    throw new CampaignPageRequestError("Run history response does not match the page contract", 200);
  }
  return value as SourceResult<CampaignRunPage>;
}

function assertView(value: unknown): CampaignOperatorView {
  if (!isRecord(value) || typeof value.generatedAt !== "string" || !isIdentity(value.identity)) {
    throw new CampaignPageRequestError("Campaign identity does not match the page contract", 200);
  }
  if (!isSource(value.cost, isCost)) throw new CampaignPageRequestError("Campaign cost source does not match the page contract", 200);
  if (!isSource(value.attention, isAttention)) throw new CampaignPageRequestError("Campaign attention source does not match the page contract", 200);
  if (!isSource(value.activity, isActivity)) throw new CampaignPageRequestError("Campaign activity source does not match the page contract", 200);
  if (!isSource(value.research, isResearch)) throw new CampaignPageRequestError("Campaign research source does not match the page contract", 200);
  if (!isSource(value.engineering, isEngineering)) throw new CampaignPageRequestError("Campaign engineering source does not match the page contract", 200);
  if (!isSource(value.runs, isRunPage)) throw new CampaignPageRequestError("Campaign run history source does not match the page contract", 200);
  return value as unknown as CampaignOperatorView;
}

export async function fetchCampaignOperatorIndex(): Promise<CampaignOperatorIndex> {
  return assertIndex(await request(`${BASE}/operator-index`));
}

export async function fetchCampaignOperatorView(id: string): Promise<CampaignOperatorView> {
  return assertView(await request(`${BASE}/${encodeURIComponent(id)}/operator-view`));
}

export async function fetchOlderCampaignRuns(id: string, cursor: string): Promise<SourceResult<CampaignRunPage>> {
  return assertRunPage(await request(`${BASE}/${encodeURIComponent(id)}/operator-runs?cursor=${encodeURIComponent(cursor)}`));
}

export interface CampaignBriefRevision {
  from: string;
  to: string;
  reason: string;
}

export async function fetchCampaignBriefRevisions(id: string): Promise<CampaignBriefRevision[]> {
  const value = await request(`${BASE}/${encodeURIComponent(id)}/revisions`);
  if (!Array.isArray(value)) throw new CampaignPageRequestError("Brief revisions response is not an array", 200);
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const from = typeof item.from === "string" ? item.from : typeof item.from_version === "string" ? item.from_version : "";
    const to = typeof item.to === "string" ? item.to : typeof item.to_version === "string" ? item.to_version : typeof item.version === "string" ? item.version : "";
    if (!/^v[1-9][0-9]*$/.test(from) || !/^v[1-9][0-9]*$/.test(to)) return [];
    const reason = typeof item.reason === "string" ? item.reason : typeof item.rule === "string" ? item.rule : "Revision reason not recorded";
    return [{ from, to, reason }];
  });
}

export function fetchCampaignBriefDiff(id: string, from: string, to: string): Promise<string> {
  return requestText(`${BASE}/${encodeURIComponent(id)}/brief-diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export interface CampaignResearchKnowledgeItem {
  id: string;
  type: "finding" | "dead_end" | "insight";
  text: string;
  runId?: string;
}

export async function fetchCampaignResearchKnowledge(id: string): Promise<CampaignResearchKnowledgeItem[]> {
  const value = await request(`${BASE}/${encodeURIComponent(id)}/kg`);
  if (!isRecord(value) || !Array.isArray(value.nodes)) throw new CampaignPageRequestError("Research knowledge summary response has no nodes", 200);
  const acceptedTypes = new Set<CampaignResearchKnowledgeItem["type"]>(["finding", "dead_end", "insight"]);
  const seen = new Set<string>();
  const items: CampaignResearchKnowledgeItem[] = [];
  for (const raw of value.nodes) {
    if (!isRecord(raw) || !acceptedTypes.has(raw.type as CampaignResearchKnowledgeItem["type"])) continue;
    const type = raw.type as CampaignResearchKnowledgeItem["type"];
    const itemText = typeof raw.text === "string" ? raw.text.trim() : typeof raw.label === "string" ? raw.label.trim() : "";
    if (!itemText) continue;
    const key = `${type}\u0000${itemText.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const runId = typeof raw.runId === "string" ? raw.runId : typeof raw.meta === "string" ? raw.meta : undefined;
    items.push({ id: typeof raw.id === "string" ? raw.id : key, type, text: itemText, ...(runId ? { runId } : {}) });
  }
  return items;
}
