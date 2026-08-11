import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  canonicalCampaignId,
  canonicalCampaignStorageKey,
  listCampaigns,
  readCampaignEntries,
  resolveCampaignStorageKey,
  type CampaignHistoryEntry,
  type CampaignSummaryRecord,
} from './campaigns.js';
import {
  campaignsRoot,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isRunningRunStatus,
  isTerminalRunStatus,
  readRunState,
  RUN_STATUS,
  runsRoot,
  STAGE_STATUS,
  type RunStatus,
  type StageStatus,
  type StoreState,
} from './store.js';
import {
  readRunIndexRecords,
  readRunIndexRecordsByCampaign,
  type RunIndexRecord,
} from './run-index.js';
import type { PendingReviewEntry } from './campaign-review.js';
import type { InboxItem } from './inbox.js';
import type { TaskShowEntry } from './orchestrator-rpc.js';

export const CAMPAIGN_SOURCE_STATUS = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
} as const;

export type CampaignSourceStatus = typeof CAMPAIGN_SOURCE_STATUS[keyof typeof CAMPAIGN_SOURCE_STATUS];

export interface CampaignSourceCoverage {
  succeeded: number;
  failed: number;
  total: number;
}

export interface CampaignRunReference {
  runId: string;
  shortName: string;
  href: string;
}

export interface CampaignSourceIssue {
  code: string;
  summary: string;
  affectedRuns: CampaignRunReference[];
  details?: string[];
}

export interface CampaignSource<T> {
  status: CampaignSourceStatus;
  value: T;
  coverage: CampaignSourceCoverage;
  issues?: CampaignSourceIssue[];
}

export const CAMPAIGN_CLASSIFICATION = {
  RESEARCH: 'research',
  ENGINEERING: 'engineering',
  MIXED: 'mixed',
  UNKNOWN: 'unknown',
} as const;

export type CampaignClassificationKind = typeof CAMPAIGN_CLASSIFICATION[keyof typeof CAMPAIGN_CLASSIFICATION];

export const CAMPAIGN_EVIDENCE_STATE = {
  PRESENT: 'present',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
} as const;

export type CampaignEvidenceState = typeof CAMPAIGN_EVIDENCE_STATE[keyof typeof CAMPAIGN_EVIDENCE_STATE];

export interface CampaignClassification {
  kind: CampaignClassificationKind;
  status: Exclude<CampaignSourceStatus, typeof CAMPAIGN_SOURCE_STATUS.UNAVAILABLE>;
  research: CampaignEvidenceState;
  engineering: CampaignEvidenceState;
  acceptedPointCount: number;
  engineeringRunCount: number;
  reasons: string[];
  issues: CampaignSourceIssue[];
}

export interface CampaignIdentity {
  id: string;
  name: string;
  storageKey: string;
  runCount: number;
  startedAt: string | null;
  startedAtSource: 'runs' | 'legacy' | 'unknown';
  classification: CampaignClassification;
}

export type CampaignAttentionKind =
  | 'approval'
  | 'brief_review'
  | 'deferred'
  | 'parked'
  | 'worker_missing'
  | 'campaign_alert'
  | 'stale';

export interface CampaignAttentionItem {
  id: string;
  kind: CampaignAttentionKind;
  title: string;
  reason: string;
  runId?: string;
  href: string;
  priority: 'high' | 'medium' | 'low';
  source?: string;
  simulated?: boolean;
}

export interface CampaignAttention {
  items: CampaignAttentionItem[];
  total: number;
  shown: number;
}

export interface CampaignActivityItem {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  durationMs: number | null;
  durationPartial: boolean;
  worker: 'live' | 'missing' | 'none' | 'unknown';
  anomaly?: string;
  href: string;
}

export interface CampaignActivity {
  items: CampaignActivityItem[];
  total: number;
  shown: number;
}

export interface CampaignCost {
  wallMs: number;
  tokens: number;
  supervisorTokens: number;
  runCoverage: CampaignSourceCoverage;
  wallCoverage: CampaignSourceCoverage;
  tokenCoverage: CampaignSourceCoverage;
}

export interface AcceptedMeasurementPoint {
  runId: string;
  round: string;
  metric: string;
  metricKey: string;
  value: number;
  timestamp: string | null;
  direction: 'higher' | 'lower' | 'unknown';
  evidence: 'research_journal' | 'campaign_ledger' | 'outer_campaign';
}

export interface ResearchMetricGroup {
  metric: string;
  metricKey: string;
  points: AcceptedMeasurementPoint[];
  hasTrend: boolean;
  direction: 'higher' | 'lower' | 'unknown' | 'conflict';
  best: AcceptedMeasurementPoint | null;
}

export interface ResearchNarrative {
  selected: ResearchMetricGroup | null;
  otherMetrics: ResearchMetricGroup[];
  acceptedPointCount: number;
  confirmNotes: string[];
  latestCanonicalStatus: RunStatus | null;
}

export interface EngineeringDelivery {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  conclusion: string;
  commits: string[];
  filesChanged: string[];
  gates: string[];
  href: string;
}

export interface EngineeringNarrative {
  latest: EngineeringDelivery | null;
  deliveryCount: number;
}

export interface CampaignRunRow {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  conclusion: string;
  durationMs: number | null;
  durationPartial: boolean;
  commits: string[];
  gates: string[];
  zeroWork: boolean;
  zeroWorkReason?: string;
  startedAt: string | null;
  completedAt: string | null;
  href: string;
}

export interface CampaignRunPage {
  items: CampaignRunRow[];
  shown: number;
  total: number;
  nextCursor: string | null;
  truncated: boolean;
}

export interface CampaignOperatorView {
  generatedAt: string;
  identity: CampaignIdentity;
  cost: CampaignSource<CampaignCost>;
  attention: CampaignSource<CampaignAttention>;
  activity: CampaignSource<CampaignActivity>;
  research: CampaignSource<ResearchNarrative | null>;
  engineering: CampaignSource<EngineeringNarrative | null>;
  runs: CampaignSource<CampaignRunPage>;
}

export interface CampaignIndexRow {
  id: string;
  name: string;
  runCount: number;
  latestStartedAt: string | null;
  attention: { status: CampaignSourceStatus; count: number | null };
  activity: {
    status: CampaignSourceStatus;
    running: number;
    waiting: number;
    summary: string;
    needsIntervention: boolean;
  };
  recent: {
    status: CampaignSourceStatus;
    runStatus: RunStatus | null;
    statusExplanation: string | null;
    conclusion: string;
  };
  href: string;
}

export interface CampaignOperatorIndex {
  generatedAt: string;
  campaigns: CampaignSource<{ items: CampaignIndexRow[]; total: number }>;
}

type InboxEnvelope<T> = {
  status: CampaignSourceStatus;
  items: T[];
  error?: string;
  coverage?: { succeeded: number; failed: number };
};

export interface CampaignInboxOverviewLike {
  approvals: InboxEnvelope<InboxItem & { campaignId?: string; campaignName?: string }>;
  deferred: InboxEnvelope<{
    id: string | number;
    name?: string;
    runId?: string | null;
    deferReason: string;
  }>;
  stale: InboxEnvelope<{ id: string; name: string; staleRunId?: string }>;
  patches: InboxEnvelope<PendingReviewEntry & {
    index: number;
    campaignName?: string;
    patchSummary?: string;
  }>;
}

export interface CampaignPageSources {
  listCampaigns(projectDir: string): CampaignSummaryRecord[];
  listRunRecords(projectDir: string): RunIndexRecord[] | null;
  listRunRecordsByCampaign(projectDir: string, storageKey: string): RunIndexRecord[] | null;
  readRunState(projectDir: string, runId: string): StoreState;
  readCampaignEntries(projectDir: string, campaignId: string): CampaignHistoryEntry[];
  readInbox(): Promise<CampaignInboxOverviewLike>;
  readTasks(): Promise<TaskShowEntry[]>;
  hasLiveWorker(projectDir: string, runId: string): boolean | null;
  now(): Date;
}

export class CampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`Campaign not found: ${id}`);
    this.name = 'CampaignNotFoundError';
  }
}

interface WorkflowEvidence {
  name?: string;
  roles: Map<string, { role: string; isGate: boolean }> | null;
  issue?: CampaignIssueSeed;
}

interface JournalRound {
  label?: unknown;
  result?: unknown;
  confirmFailed?: unknown;
}

interface JournalEvidence {
  rounds: JournalRound[];
  issue?: CampaignIssueSeed;
}

interface MetricArtifact {
  stageId: string;
  metric: string;
  value: number;
  higherIsBetter?: boolean;
}

interface RunEvidence {
  state: StoreState;
  workflow: WorkflowEvidence;
  journal: JournalEvidence;
  metricArtifacts: MetricArtifact[];
  metricIssues: CampaignIssueSeed[];
  summary: string | null;
  summaryIssue?: CampaignIssueSeed;
  confirm: Record<string, unknown> | null;
  confirmIssue?: CampaignIssueSeed;
  tasks: TaskShowEntry[];
  history: CampaignHistoryEntry[];
  commits: string[];
}

interface LoadedCampaign {
  summary: CampaignSummaryRecord;
  runIds: string[];
  runs: RunEvidence[];
  discoveryIssues: CampaignIssueSeed[];
  stateIssues: CampaignIssueSeed[];
  entries: CampaignHistoryEntry[];
  entriesIssue?: CampaignIssueSeed;
  tasks: TaskShowEntry[];
  taskIssue?: CampaignIssueSeed;
  inbox: CampaignInboxOverviewLike | null;
  inboxIssue?: CampaignIssueSeed;
  legacyStartedAt: string | null;
  legacyState: Record<string, unknown> | null;
  outerIterations: Record<string, unknown>[];
  outerIssues: CampaignIssueSeed[];
}

interface CampaignRunDiscovery {
  runIds: string[];
  issues: CampaignIssueSeed[];
}

interface CampaignIssueSeed {
  code: string;
  summary: string;
  runId?: string;
  detail?: string;
}

const VALID_SHIP = 'valid_ship';
const RESEARCH_CONFIRM_STATUS = {
  FAILED: 'failed',
  NOT_RUN: 'not_run',
} as const;
const ACCEPTED_TERMINALS = new Set<string>([
  RUN_STATUS.SHIPPED,
  RUN_STATUS.CEILING_HIT,
  VALID_SHIP,
]);
const EXECUTED_STAGE_STATUSES = new Set<string>([
  STAGE_STATUS.RUNNING,
  STAGE_STATUS.COMPLETE,
  STAGE_STATUS.FAILED,
]);
const NON_EXECUTION_ROLES = new Set(['planner', 'supervisor']);
const DEFAULT_PAGE_SIZE = 12;
const INITIAL_VISIBLE_ITEMS = 3;

function defaultInbox(): Promise<CampaignInboxOverviewLike> {
  return Promise.reject(new Error('campaign inbox reader is unavailable'));
}

function defaultTasks(): Promise<TaskShowEntry[]> {
  return Promise.reject(new Error('task registry reader is unavailable'));
}

function sourcesWithDefaults(overrides: Partial<CampaignPageSources> = {}): CampaignPageSources {
  return {
    listCampaigns,
    listRunRecords: readRunIndexRecords,
    listRunRecordsByCampaign: readRunIndexRecordsByCampaign,
    readRunState,
    readCampaignEntries,
    readInbox: defaultInbox,
    readTasks: defaultTasks,
    hasLiveWorker: () => null,
    now: () => new Date(),
    ...overrides,
  };
}

function coverage(succeeded: number, failed: number, total = succeeded + failed): CampaignSourceCoverage {
  return { succeeded, failed, total };
}

const MAX_ISSUE_DETAILS = 6;

function issue(
  code: string,
  summary: string,
  options: { runId?: string; detail?: string } = {},
): CampaignIssueSeed {
  return { code, summary, ...options };
}

function uniqueIssueSeeds(seeds: CampaignIssueSeed[]): CampaignIssueSeed[] {
  return [...new Map(seeds.map((seed) => [
    `${seed.code}\u0000${seed.summary}\u0000${seed.runId ?? ''}\u0000${seed.detail ?? ''}`,
    seed,
  ])).values()];
}

function safeIssueDetail(detail: string, runRefs: CampaignRunReference[]): string {
  let safe = detail;
  for (const ref of runRefs) safe = safe.replaceAll(ref.runId, ref.shortName);
  return safe;
}

function groupIssues(
  rawSeeds: CampaignIssueSeed[],
  runRefs: CampaignRunReference[] = [],
): CampaignSourceIssue[] {
  const seeds = uniqueIssueSeeds(rawSeeds);
  const order = new Map(runRefs.map((ref, index) => [ref.runId, index]));
  const refs = new Map(runRefs.map((ref) => [ref.runId, ref]));
  const grouped = new Map<string, { code: string; summary: string; seeds: CampaignIssueSeed[] }>();
  for (const seed of seeds) {
    const key = `${seed.code}\u0000${seed.summary}`;
    const current = grouped.get(key) ?? { code: seed.code, summary: seed.summary, seeds: [] };
    current.seeds.push(seed);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((group) => {
    const orderedSeeds = [...group.seeds].sort((a, b) => (
      (order.get(a.runId ?? '') ?? Number.MAX_SAFE_INTEGER)
      - (order.get(b.runId ?? '') ?? Number.MAX_SAFE_INTEGER)
    ));
    const affectedRuns = runRefs.filter((ref) => orderedSeeds.some((seed) => seed.runId === ref.runId));
    const allDetails = orderedSeeds.flatMap((seed) => {
      if (!seed.detail) return [];
      const detail = safeIssueDetail(seed.detail, runRefs);
      const ref = seed.runId ? refs.get(seed.runId) : undefined;
      return [ref ? `${ref.shortName}: ${detail}` : detail];
    });
    const details = [...new Set(allDetails)];
    const boundedDetails = details.length > MAX_ISSUE_DETAILS
      ? [
          ...details.slice(0, MAX_ISSUE_DETAILS),
          `${details.length - MAX_ISSUE_DETAILS} additional diagnostics remain in the run records.`,
        ]
      : details;
    return {
      code: group.code,
      summary: group.summary,
      affectedRuns,
      ...(boundedDetails.length ? { details: boundedDetails } : {}),
    };
  });
}

function source<T>(
  value: T,
  succeeded: number,
  rawIssues: CampaignIssueSeed[],
  total = succeeded + rawIssues.length,
  runRefs: CampaignRunReference[] = [],
): CampaignSource<T> {
  const seeds = uniqueIssueSeeds(rawIssues);
  const failed = seeds.length;
  const status = failed === 0
    ? CAMPAIGN_SOURCE_STATUS.COMPLETE
    : succeeded > 0
      ? CAMPAIGN_SOURCE_STATUS.PARTIAL
      : CAMPAIGN_SOURCE_STATUS.UNAVAILABLE;
  return {
    status,
    value,
    coverage: coverage(succeeded, failed, total),
    ...(failed ? { issues: groupIssues(seeds, runRefs) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function readOptionalText(path: string): { value: string | null; error?: string } {
  if (!existsSync(path)) return { value: null };
  try {
    return { value: readFileSync(path, 'utf-8') };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function readOptionalJson(path: string): { value: Record<string, unknown> | null; error?: string } {
  const text = readOptionalText(path);
  if (text.error || text.value === null) return { value: null, error: text.error };
  try {
    const parsed = asRecord(JSON.parse(text.value));
    return parsed ? { value: parsed } : { value: null, error: `${path} is not a JSON object` };
  } catch (error) {
    return { value: null, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readOptionalJsonl(path: string): { value: Record<string, unknown>[]; error?: string } {
  const text = readOptionalText(path);
  if (text.error || text.value === null) return { value: [], error: text.error };
  const values: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const [index, line] of text.value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed) values.push(parsed);
      else errors.push(`line ${index + 1} is not an object`);
    } catch (error) {
      errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { value: values, ...(errors.length ? { error: `${path}: ${errors.join(', ')}` } : {}) };
}

function safeCampaignDirectory(id: string): string | null {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) return null;
  const path = join(campaignsRoot(), id);
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function storedCampaignDirectories(): CampaignSummaryRecord[] {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = readdirSync(campaignsRoot(), { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const rows: CampaignSummaryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = readOptionalJson(join(campaignsRoot(), entry.name, 'state.json')).value;
    const id = canonicalCampaignId(nonEmptyString(state?.id) ?? entry.name) ?? entry.name;
    const storageKey = canonicalCampaignStorageKey(entry.name) ?? entry.name;
    rows.push({
      id,
      name: nonEmptyString(state?.name) ?? id,
      storageKey,
      runCount: 0,
      bestScore: null,
      latestTimestamp: validIso(state?.updatedAt) ?? validIso(state?.startedAt) ?? undefined,
    });
  }
  return rows;
}

function allCampaignSummaries(projectDir: string, readers: CampaignPageSources): CampaignSummaryRecord[] {
  const byKey = new Map<string, CampaignSummaryRecord>();
  for (const item of [...readers.listCampaigns(projectDir), ...storedCampaignDirectories()]) {
    const key = canonicalCampaignStorageKey(item.storageKey ?? item.id) ?? item.storageKey ?? item.id;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...item, storageKey: key });
      continue;
    }
    byKey.set(key, {
      ...previous,
      ...item,
      id: previous.id || item.id,
      name: previous.name === previous.id && item.name ? item.name : previous.name,
      runCount: Math.max(previous.runCount, item.runCount),
      latestRun: previous.latestTimestamp && previous.latestTimestamp >= (item.latestTimestamp ?? '')
        ? previous.latestRun
        : item.latestRun ?? previous.latestRun,
      latestTimestamp: [previous.latestTimestamp, item.latestTimestamp].filter(Boolean).sort().at(-1),
    });
  }
  return [...byKey.values()].sort((a, b) => (b.latestTimestamp ?? '').localeCompare(a.latestTimestamp ?? '') || a.name.localeCompare(b.name));
}

function findCampaign(projectDir: string, id: string, readers: CampaignPageSources): CampaignSummaryRecord | null {
  const wanted = canonicalCampaignStorageKey(id);
  return allCampaignSummaries(projectDir, readers).find((item) =>
    item.id === id || item.storageKey === id || canonicalCampaignStorageKey(item.id) === wanted,
  ) ?? null;
}

function recordBelongsToCampaign(record: RunIndexRecord, campaign: CampaignSummaryRecord): boolean {
  const key = resolveCampaignStorageKey({
    campaignId: record.campaignId,
    campaignStorageKey: record.campaignStorageKey,
    campaignName: record.campaignName,
  });
  return key === campaign.storageKey;
}

function stateBelongsToCampaign(state: StoreState, campaign: CampaignSummaryRecord): boolean {
  const key = resolveCampaignStorageKey({
    campaignId: state.campaignId,
    campaignStorageKey: state.campaignStorageKey,
    campaignName: state.campaignName,
  });
  return key === campaign.storageKey;
}

function filesystemRunIds(
  projectDir: string,
  campaign: CampaignSummaryRecord,
  readers: CampaignPageSources,
): CampaignRunDiscovery {
  const root = runsRoot(projectDir);
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch (error) {
    if (!existsSync(root)) return { runIds: [], issues: [] };
    return {
      runIds: [],
      issues: [issue(
        'run-directory-unavailable',
        'The run directory could not be read',
        { detail: error instanceof Error ? error.message : String(error) },
      )],
    };
  }
  const runIds: string[] = [];
  const issues: CampaignIssueSeed[] = [];
  for (const runId of ids) {
    try {
      if (stateBelongsToCampaign(readers.readRunState(projectDir, runId), campaign)) runIds.push(runId);
    } catch (error) {
      issues.push(issue(
        'run-state-unreadable',
        'A run record could not be read during discovery',
        { runId, detail: error instanceof Error ? error.message : String(error) },
      ));
    }
  }
  return { runIds, issues };
}

function campaignRunIds(
  projectDir: string,
  campaign: CampaignSummaryRecord,
  entries: CampaignHistoryEntry[],
  readers: CampaignPageSources,
): CampaignRunDiscovery {
  const ids = new Set<string>();
  const indexIssues: CampaignIssueSeed[] = [];
  let indexComplete = false;
  try {
    const records = readers.listRunRecordsByCampaign(projectDir, campaign.storageKey);
    if (records === null) {
      indexIssues.push(issue('run-index-unavailable', 'The run index is unavailable'));
    } else {
      indexComplete = true;
    }
    for (const record of records ?? []) {
      if (recordBelongsToCampaign(record, campaign)) ids.add(record.runId);
    }
  } catch (error) {
    indexIssues.push(issue(
      'run-index-unavailable',
      'The run index is unavailable',
      { detail: error instanceof Error ? error.message : String(error) },
    ));
  }
  for (const entry of entries) {
    if (nonEmptyString(entry.runId)) ids.add(entry.runId);
  }

  const issues: CampaignIssueSeed[] = [];
  if (!indexComplete || ids.size < campaign.runCount) {
    const filesystem = filesystemRunIds(projectDir, campaign, readers);
    for (const runId of filesystem.runIds) ids.add(runId);
    if (filesystem.issues.length || ids.size < campaign.runCount) {
      issues.push(...indexIssues, ...filesystem.issues);
    }
  }
  if (ids.size < campaign.runCount) {
    issues.push(issue(
      'run-discovery-incomplete',
      'Some recorded runs could not be discovered',
      { detail: `${ids.size} of ${campaign.runCount} recorded runs were found` },
    ));
  }
  return { runIds: [...ids], issues: uniqueIssueSeeds(issues) };
}

export function deriveCampaignRunTitle(taskDescription?: string, workflowName?: string): { fullTitle: string; shortName: string } {
  let body = taskDescription?.replace(/^\uFEFF/, '') ?? '';
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (frontmatter) body = body.slice(frontmatter[0].length);
  let fullTitle = '';
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*#+\s*/, '').trim();
    if (cleaned && cleaned !== '---') {
      fullTitle = cleaned;
      break;
    }
  }
  fullTitle ||= nonEmptyString(workflowName) ?? 'Untitled task';
  fullTitle = fullTitle.replace(/^TASK\s*(?:—|–|-|:|：)\s*/iu, '').trim() || fullTitle;

  const separator = fullTitle.search(/[:：]/u);
  if (separator >= 0) {
    const candidate = fullTitle.slice(0, separator).trim();
    const width = Array.from(candidate).length;
    if (width >= 2 && width <= 32) return { fullTitle, shortName: candidate };
  }
  const chars = Array.from(fullTitle);
  return { fullTitle, shortName: chars.length > 32 ? `${chars.slice(0, 32).join('')}…` : fullTitle };
}

function workflowEvidence(projectDir: string, state: StoreState): WorkflowEvidence {
  const path = join(runsRoot(projectDir), state.runId, 'workflow.yaml');
  const text = readOptionalText(path);
  if (text.error) return {
    roles: null,
    issue: issue('workflow-unreadable', 'Workflow evidence could not be read', { runId: state.runId, detail: text.error }),
  };
  if (text.value === null) return {
    roles: null,
    issue: issue('workflow-missing', 'Workflow evidence is missing', { runId: state.runId }),
  };
  try {
    const raw = asRecord(parseYaml(text.value));
    const stages = Array.isArray(raw?.stages) ? raw.stages : null;
    if (!stages) return {
      roles: null,
      issue: issue('workflow-invalid', 'Workflow evidence has no stages list', { runId: state.runId }),
    };
    const roles = new Map<string, { role: string; isGate: boolean }>();
    for (const item of stages) {
      const stage = asRecord(item);
      const id = nonEmptyString(stage?.id);
      const role = nonEmptyString(stage?.role);
      if (id && role) roles.set(id, { role: role.toLowerCase(), isGate: stage?.is_gate === true });
    }
    return { name: nonEmptyString(raw?.name), roles };
  } catch (error) {
    return {
      roles: null,
      issue: issue(
        'workflow-invalid',
        'Workflow evidence is invalid',
        { runId: state.runId, detail: error instanceof Error ? error.message : String(error) },
      ),
    };
  }
}

function journalEvidence(projectDir: string, state: StoreState): JournalEvidence {
  const path = join(runsRoot(projectDir), state.runId, 'research_journal.json');
  const json = readOptionalJson(path);
  if (json.error) return {
    rounds: [],
    issue: issue('research-journal-unreadable', 'The research journal could not be read', { runId: state.runId, detail: json.error }),
  };
  if (!json.value) return { rounds: [] };
  return Array.isArray(json.value.rounds)
    ? { rounds: json.value.rounds as JournalRound[] }
    : {
        rounds: [],
        issue: issue('research-journal-invalid', 'The research journal has no rounds list', { runId: state.runId }),
      };
}

function metricArtifacts(projectDir: string, state: StoreState): { values: MetricArtifact[]; issues: CampaignIssueSeed[] } {
  const values: MetricArtifact[] = [];
  const issues: CampaignIssueSeed[] = [];
  for (const stageId of Object.keys(state.stages)) {
    const path = join(runsRoot(projectDir), state.runId, 'stages', stageId, 'metric.json');
    if (!existsSync(path)) continue;
    const json = readOptionalJson(path);
    if (json.error || !json.value) {
      issues.push(issue(
        'metric-artifact-unreadable',
        'A metric artifact could not be read',
        { runId: state.runId, detail: `${stageId}: ${json.error ?? 'invalid object'}` },
      ));
      continue;
    }
    if (json.value.hasMetric === false) continue;
    const metric = nonEmptyString(json.value.metric) ?? nonEmptyString(json.value.metric_name);
    const value = finiteNumber(json.value.value) ?? finiteNumber(json.value.score) ?? finiteNumber(json.value.result);
    if (!metric || value === undefined) continue;
    values.push({
      stageId,
      metric,
      value,
      higherIsBetter: typeof json.value.higherIsBetter === 'boolean'
        ? json.value.higherIsBetter
        : typeof json.value.higher_is_better === 'boolean'
          ? json.value.higher_is_better
          : undefined,
    });
  }
  return { values, issues };
}

function structuredCommits(history: CampaignHistoryEntry[], tasks: TaskShowEntry[]): string[] {
  const commits = new Set<string>();
  for (const entry of history) {
    const raw = entry as unknown as Record<string, unknown>;
    const commit = nonEmptyString(raw.completing_commit);
    if (commit) commits.add(commit);
    if (Array.isArray(raw.commit_chain)) {
      for (const value of raw.commit_chain) {
        const item = nonEmptyString(value);
        if (item) commits.add(item);
      }
    }
  }
  for (const task of tasks) {
    const commit = nonEmptyString(task.completing_commit);
    if (commit) commits.add(commit);
  }
  return [...commits];
}

function outerStructuredCommits(rows: Record<string, unknown>[], runId: string): string[] {
  const commits = new Set<string>();
  for (const row of rows) {
    if ((nonEmptyString(row.runId) ?? nonEmptyString(row.run_id)) !== runId) continue;
    const commit = nonEmptyString(row.completing_commit);
    if (commit) commits.add(commit);
    if (Array.isArray(row.commit_chain)) {
      for (const value of row.commit_chain) {
        const item = nonEmptyString(value);
        if (item) commits.add(item);
      }
    }
  }
  return [...commits];
}

function createRunEvidence(
  projectDir: string,
  state: StoreState,
  entries: CampaignHistoryEntry[],
  tasks: TaskShowEntry[],
): RunEvidence {
  const runHistory = entries.filter((entry) => entry.runId === state.runId);
  const runTasks = tasks.filter((task) => task.run_id === state.runId);
  const workflow = workflowEvidence(projectDir, state);
  const journal = journalEvidence(projectDir, state);
  const artifacts = metricArtifacts(projectDir, state);
  const summary = readOptionalText(join(runsRoot(projectDir), state.runId, 'summary.md'));
  const confirm = readOptionalJson(join(runsRoot(projectDir), state.runId, 'research_confirm.json'));
  return {
    state,
    workflow,
    journal,
    metricArtifacts: artifacts.values,
    metricIssues: artifacts.issues,
    summary: summary.value,
    summaryIssue: summary.error
      ? issue('run-summary-unreadable', 'The run summary could not be read', { runId: state.runId, detail: summary.error })
      : undefined,
    confirm: confirm.value,
    confirmIssue: confirm.error
      ? issue('research-confirm-unreadable', 'Research confirmation evidence could not be read', { runId: state.runId, detail: confirm.error })
      : undefined,
    tasks: runTasks,
    history: runHistory,
    commits: structuredCommits(runHistory, runTasks),
  };
}

function legacyCampaignData(campaign: CampaignSummaryRecord): {
  startedAt: string | null;
  state: Record<string, unknown> | null;
  iterations: Record<string, unknown>[];
  issues: CampaignIssueSeed[];
} {
  const dir = safeCampaignDirectory(campaign.storageKey) ?? safeCampaignDirectory(campaign.id);
  if (!dir) return { startedAt: null, state: null, iterations: [], issues: [] };
  const state = readOptionalJson(join(dir, 'state.json'));
  const iterations = readOptionalJsonl(join(dir, 'iteration_log.jsonl'));
  const issues = [
    state.error ? issue('campaign-state-unreadable', 'Campaign metadata could not be read', { detail: state.error }) : undefined,
    iterations.error ? issue('campaign-iterations-unreadable', 'Campaign iteration history could not be read', { detail: iterations.error }) : undefined,
  ].filter((value): value is CampaignIssueSeed => Boolean(value));
  const startedAt = validIso(state.value?.startedAt)
    ?? validIso(state.value?.started_at)
    ?? (() => {
      try { return statSync(dir).birthtime.toISOString(); } catch { return null; }
    })();
  return { startedAt, state: state.value, iterations: iterations.value, issues };
}

async function loadCampaign(
  projectDir: string,
  id: string,
  readers: CampaignPageSources,
  options: { includeInbox: boolean },
): Promise<LoadedCampaign> {
  const summary = findCampaign(projectDir, id, readers);
  if (!summary) throw new CampaignNotFoundError(id);
  let entries: CampaignHistoryEntry[] = [];
  let entriesIssue: CampaignIssueSeed | undefined;
  try {
    entries = readers.readCampaignEntries(projectDir, summary.storageKey);
  } catch (error) {
    entriesIssue = issue(
      'campaign-history-unreadable',
      'Campaign history could not be read',
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  const discovery = campaignRunIds(projectDir, summary, entries, readers);
  const runIds = discovery.runIds;
  const [taskResult, inboxResult] = await Promise.allSettled([
    readers.readTasks(),
    options.includeInbox ? readers.readInbox() : Promise.resolve(null),
  ]);
  const tasks = taskResult.status === 'fulfilled' ? taskResult.value : [];
  const taskIssue = taskResult.status === 'rejected'
    ? issue(
        'task-registry-unavailable',
        'Task delivery records could not be read',
        { detail: taskResult.reason instanceof Error ? taskResult.reason.message : String(taskResult.reason) },
      )
    : undefined;
  const inbox = inboxResult.status === 'fulfilled' ? inboxResult.value : null;
  const inboxIssue = inboxResult.status === 'rejected'
    ? issue(
        'campaign-inbox-unavailable',
        'Campaign inbox items could not be read',
        { detail: inboxResult.reason instanceof Error ? inboxResult.reason.message : String(inboxResult.reason) },
      )
    : undefined;
  const runs: RunEvidence[] = [];
  const stateIssues: CampaignIssueSeed[] = [];
  for (const runId of runIds) {
    try {
      const state = readers.readRunState(projectDir, runId);
      if (state.runId !== runId) {
        stateIssues.push(issue(
          'run-state-identity-mismatch',
          'A run record has a mismatched identity',
          { runId, detail: 'The indexed identity does not match the stored run record' },
        ));
        continue;
      }
      if (!stateBelongsToCampaign(state, summary) && !entries.some((entry) => entry.runId === runId)) {
        stateIssues.push(issue(
          'run-campaign-mismatch',
          'A run record has conflicting campaign ownership',
          { runId },
        ));
        continue;
      }
      runs.push(createRunEvidence(projectDir, state, entries, tasks));
    } catch (error) {
      stateIssues.push(issue(
        'run-state-unreadable',
        'A run record could not be read',
        { runId, detail: error instanceof Error ? error.message : String(error) },
      ));
    }
  }
  const legacy = legacyCampaignData(summary);
  for (const run of runs) {
    run.commits = [...new Set([...run.commits, ...outerStructuredCommits(legacy.iterations, run.state.runId)])];
  }
  return {
    summary,
    runIds,
    runs,
    discoveryIssues: discovery.issues,
    stateIssues,
    entries,
    entriesIssue,
    tasks,
    taskIssue,
    inbox,
    inboxIssue,
    legacyStartedAt: legacy.startedAt,
    legacyState: legacy.state,
    outerIterations: legacy.iterations,
    outerIssues: legacy.issues,
  };
}

function campaignRunIssues(loaded: LoadedCampaign): CampaignIssueSeed[] {
  return uniqueIssueSeeds([...loaded.discoveryIssues, ...loaded.stateIssues]);
}

function campaignRunTotal(loaded: LoadedCampaign): number {
  const unknownDiscovery = loaded.discoveryIssues.length ? loaded.runs.length + 1 : 0;
  return Math.max(
    loaded.summary.runCount,
    loaded.runIds.length,
    loaded.runs.length + loaded.stateIssues.length,
    unknownDiscovery,
  );
}

function metricKey(metric: string): string {
  return metric.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function runDirection(run: RunEvidence, metric: string): 'higher' | 'lower' | 'unknown' {
  if (run.state.research) return run.state.research.higherIsBetter === false ? 'lower' : 'higher';
  const directions = run.metricArtifacts
    .filter((item) => run.workflow.roles?.get(item.stageId)?.isGate && metricKey(item.metric) === metricKey(metric))
    .map((item) => item.higherIsBetter)
    .filter((item): item is boolean => typeof item === 'boolean');
  if (!directions.length) return 'unknown';
  return directions.every(Boolean) ? 'higher' : directions.every((item) => !item) ? 'lower' : 'unknown';
}

function acceptedLedgerEntry(entry: CampaignHistoryEntry): boolean {
  const raw = entry as unknown as Record<string, unknown>;
  return entry.pass === true
    || entry.terminalStudyComplete === true
    || raw.confirmed === true
    || raw.confirm_pass === true
    || ACCEPTED_TERMINALS.has(nonEmptyString(entry.status) ?? '')
    || ACCEPTED_TERMINALS.has(nonEmptyString(entry.outcome) ?? '');
}

function acceptedPointsFromRuns(
  runs: RunEvidence[],
  issues: CampaignIssueSeed[],
  campaignMetric?: string,
  campaignDirection: 'higher' | 'lower' | 'unknown' = 'unknown',
): AcceptedMeasurementPoint[] {
  const points: AcceptedMeasurementPoint[] = [];
  for (const run of runs) {
    const metricCandidates = new Map<string, string>();
    for (const entry of run.history) {
      const metric = nonEmptyString(entry.metric);
      if (metric) metricCandidates.set(metricKey(metric), metric);
    }
    if (campaignMetric) metricCandidates.set(metricKey(campaignMetric), campaignMetric);
    for (const artifact of run.metricArtifacts) {
      if (run.workflow.roles?.get(artifact.stageId)?.isGate) {
        metricCandidates.set(metricKey(artifact.metric), artifact.metric);
      }
    }
    if (run.journal.issue) issues.push(run.journal.issue);
    issues.push(...run.metricIssues);
    if (run.journal.rounds.length) {
      if (metricCandidates.size === 1) {
        const [key, metric] = [...metricCandidates.entries()][0];
        for (const [index, rawRound] of run.journal.rounds.entries()) {
          const value = finiteNumber(rawRound.result);
          if (value === undefined || rawRound.confirmFailed === true) continue;
          const round = nonEmptyString(rawRound.label) ?? `round ${index + 1}`;
          const runMetricDirection = runDirection(run, metric);
          points.push({
            runId: run.state.runId,
            round,
            metric,
            metricKey: key,
            value,
            timestamp: validIso(run.history.at(index)?.timestamp) ?? validIso(run.state.startedAt),
            direction: runMetricDirection === 'unknown' ? campaignDirection : runMetricDirection,
            evidence: 'research_journal',
          });
        }
      } else if (metricCandidates.size > 1) {
        issues.push(issue(
          'research-metric-conflict',
          'A research journal has conflicting metric sources',
          { runId: run.state.runId },
        ));
      } else {
        issues.push(issue(
          'research-metric-missing',
          'A research journal has no uniquely associated metric',
          { runId: run.state.runId },
        ));
      }
    }
    for (const entry of run.history) {
      const metric = nonEmptyString(entry.metric);
      const value = finiteNumber(entry.score);
      const roundValue = finiteNumber(entry.iteration) ?? finiteNumber(entry.seq);
      if (!metric || value === undefined || roundValue === undefined || !acceptedLedgerEntry(entry)) continue;
      const runMetricDirection = runDirection(run, metric);
      points.push({
        runId: run.state.runId,
        round: String(roundValue),
        metric,
        metricKey: metricKey(metric),
        value,
        timestamp: validIso(entry.timestamp),
        direction: runMetricDirection === 'unknown' && campaignMetric && metricKey(campaignMetric) === metricKey(metric)
          ? campaignDirection
          : runMetricDirection,
        evidence: 'campaign_ledger',
      });
    }
  }
  const unique = new Map<string, AcceptedMeasurementPoint>();
  const rank: Record<AcceptedMeasurementPoint['evidence'], number> = {
    research_journal: 3,
    outer_campaign: 2,
    campaign_ledger: 1,
  };
  for (const point of points) {
    const key = `${point.runId}\u0000${point.round}\u0000${point.metricKey}\u0000${point.value}`;
    const previous = unique.get(key);
    if (!previous || rank[point.evidence] > rank[previous.evidence]) unique.set(key, point);
  }
  return [...unique.values()];
}

function outerAcceptedPoints(loaded: LoadedCampaign, runs: RunEvidence[]): AcceptedMeasurementPoint[] {
  if (!loaded.outerIterations.length) return [];
  const state = loaded.legacyState;
  const goal = asRecord(state?.goal) ?? asRecord(asRecord(state?.config)?.goal);
  const metric = nonEmptyString(goal?.metric);
  if (!metric) return [];
  const higher = typeof goal?.higherIsBetter === 'boolean'
    ? goal.higherIsBetter
    : typeof goal?.higher_is_better === 'boolean'
      ? goal.higher_is_better
      : undefined;
  const journalValues = new Set(runs.flatMap((run) => run.journal.rounds.map((round) => finiteNumber(round.result))).filter((value): value is number => value !== undefined));
  const points: AcceptedMeasurementPoint[] = [];
  for (const [index, row] of loaded.outerIterations.entries()) {
    const outcome = asRecord(row.outcome);
    const value = finiteNumber(outcome?.result) ?? finiteNumber(row.score) ?? finiteNumber(row.value);
    const round = finiteNumber(row.iter) ?? finiteNumber(row.iteration) ?? index + 1;
    const runId = nonEmptyString(row.runId) ?? nonEmptyString(row.run_id);
    const accepted = row.pass === true
      || ACCEPTED_TERMINALS.has(nonEmptyString(row.outcome) ?? '')
      || ACCEPTED_TERMINALS.has(nonEmptyString(outcome?.status) ?? '')
      || (value !== undefined && journalValues.has(value));
    if (value === undefined || !runId || !accepted) continue;
    points.push({
      runId,
      round: String(round),
      metric,
      metricKey: metricKey(metric),
      value,
      timestamp: validIso(row.timestamp) ?? validIso(row.ts),
      direction: higher === true ? 'higher' : higher === false ? 'lower' : 'unknown',
      evidence: 'outer_campaign',
    });
  }
  return points;
}

function groupResearchPoints(points: AcceptedMeasurementPoint[]): ResearchMetricGroup[] {
  const groups = new Map<string, AcceptedMeasurementPoint[]>();
  for (const point of points) groups.set(point.metricKey, [...(groups.get(point.metricKey) ?? []), point]);
  return [...groups.entries()].map(([key, group]) => {
    const ordered = [...group].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.round.localeCompare(b.round));
    const known = new Set(ordered.map((point) => point.direction).filter((value) => value !== 'unknown'));
    const direction: ResearchMetricGroup['direction'] = known.size > 1
      ? 'conflict'
      : known.size === 0 || ordered.some((point) => point.direction === 'unknown')
        ? 'unknown'
        : [...known][0] as 'higher' | 'lower';
    const hasTrend = ordered.length >= 2 && direction !== 'conflict';
    const best = hasTrend && direction !== 'unknown'
      ? ordered.reduce((current, item) => direction === 'higher'
        ? item.value > current.value ? item : current
        : item.value < current.value ? item : current)
      : null;
    return { metric: ordered[0].metric, metricKey: key, points: ordered, hasTrend, direction, best };
  }).sort((a, b) => (b.points.at(-1)?.timestamp ?? '').localeCompare(a.points.at(-1)?.timestamp ?? ''));
}

function stageWasExecuted(stage: StageStatus): boolean {
  return EXECUTED_STAGE_STATUSES.has(stage.status)
    || (stage.attempts ?? []).some((attempt) => EXECUTED_STAGE_STATUSES.has(attempt.status));
}

function stageWasCompleted(stage: StageStatus): boolean {
  return stage.status === STAGE_STATUS.COMPLETE
    || (stage.attempts ?? []).some((attempt) => attempt.status === STAGE_STATUS.COMPLETE);
}

function isExecutionStage(run: RunEvidence, stageId: string): boolean {
  if (stageId === '_supervisor') return false;
  const metadata = run.workflow.roles?.get(stageId);
  if (metadata) return metadata.isGate || !NON_EXECUTION_ROLES.has(metadata.role);
  if (run.workflow.roles) return stageId !== 'plan';
  return stageId !== 'plan';
}

function actualEngineeringExecution(run: RunEvidence): boolean {
  if (!run.workflow.roles) return false;
  return Object.entries(run.state.stages)
    .some(([stageId, stage]) => isExecutionStage(run, stageId) && stageWasExecuted(stage));
}

function summarySectionLines(summary: string | null, headings: string[]): string[] {
  if (!summary) return [];
  const wanted = new Set(headings.map((heading) => heading.toLocaleLowerCase()));
  let active = false;
  const lines: string[] = [];
  for (const raw of summary.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      active = wanted.has(heading[1].trim().toLocaleLowerCase());
      continue;
    }
    if (!active) continue;
    const line = raw.replace(/^\s*[-*]\s*/, '').trim();
    if (line && !/^_.*_$/.test(line)) lines.push(line);
  }
  return lines;
}

function summaryHasDelivery(run: RunEvidence): boolean {
  return summarySectionLines(run.summary, ['Files changed']).length > 0
    || run.commits.length > 0;
}

function engineeringEvidence(
  runs: RunEvidence[],
  acceptedRunIds: Set<string>,
  sourceIssues: CampaignIssueSeed[] = [],
): { state: CampaignEvidenceState; evidenceRuns: RunEvidence[]; issues: CampaignIssueSeed[] } {
  const evidenceRuns: RunEvidence[] = [];
  const issues: CampaignIssueSeed[] = [...sourceIssues];
  for (const run of runs) {
    if (acceptedRunIds.has(run.state.runId) || run.journal.rounds.length > 0) continue;
    if (actualEngineeringExecution(run) || summaryHasDelivery(run)) evidenceRuns.push(run);
    if (run.workflow.issue && !summaryHasDelivery(run)) issues.push(run.workflow.issue);
    if (run.summaryIssue) issues.push(run.summaryIssue);
  }
  return {
    state: evidenceRuns.length
      ? CAMPAIGN_EVIDENCE_STATE.PRESENT
      : issues.length
        ? CAMPAIGN_EVIDENCE_STATE.UNKNOWN
        : CAMPAIGN_EVIDENCE_STATE.ABSENT,
    evidenceRuns,
    issues: uniqueIssueSeeds(issues),
  };
}

function classify(
  points: AcceptedMeasurementPoint[],
  runs: RunEvidence[],
  researchIssues: CampaignIssueSeed[],
  engineeringSourceIssues: CampaignIssueSeed[] = [],
  runRefs: CampaignRunReference[] = [],
): { classification: CampaignClassification; engineeringRuns: RunEvidence[]; engineeringIssues: CampaignIssueSeed[] } {
  const acceptedRunIds = new Set(points.map((point) => point.runId));
  const research = points.length
    ? CAMPAIGN_EVIDENCE_STATE.PRESENT
    : researchIssues.length
      ? CAMPAIGN_EVIDENCE_STATE.UNKNOWN
      : CAMPAIGN_EVIDENCE_STATE.ABSENT;
  const engineering = engineeringEvidence(runs, acceptedRunIds, engineeringSourceIssues);
  const kind = research === CAMPAIGN_EVIDENCE_STATE.PRESENT && engineering.state === CAMPAIGN_EVIDENCE_STATE.PRESENT
    ? CAMPAIGN_CLASSIFICATION.MIXED
    : research === CAMPAIGN_EVIDENCE_STATE.PRESENT && engineering.state === CAMPAIGN_EVIDENCE_STATE.ABSENT
      ? CAMPAIGN_CLASSIFICATION.RESEARCH
      : research === CAMPAIGN_EVIDENCE_STATE.ABSENT && engineering.state === CAMPAIGN_EVIDENCE_STATE.PRESENT
        ? CAMPAIGN_CLASSIFICATION.ENGINEERING
        : CAMPAIGN_CLASSIFICATION.UNKNOWN;
  const issues = uniqueIssueSeeds([...researchIssues, ...engineering.issues]);
  const reasons = [
    points.length
      ? `${points.length} accepted research measurement${points.length === 1 ? '' : 's'}`
      : research === CAMPAIGN_EVIDENCE_STATE.UNKNOWN
        ? 'Research evidence could not be read completely'
        : 'No accepted research measurements were found',
    engineering.evidenceRuns.length
      ? `${engineering.evidenceRuns.length} engineering run${engineering.evidenceRuns.length === 1 ? '' : 's'} with execution evidence`
      : engineering.state === CAMPAIGN_EVIDENCE_STATE.UNKNOWN
        ? 'Engineering evidence could not be read completely'
        : 'No engineering execution evidence was found',
  ];
  return {
    classification: {
      kind,
      status: issues.length ? CAMPAIGN_SOURCE_STATUS.PARTIAL : CAMPAIGN_SOURCE_STATUS.COMPLETE,
      research,
      engineering: engineering.state,
      acceptedPointCount: points.length,
      engineeringRunCount: engineering.evidenceRuns.length,
      reasons,
      issues: groupIssues(issues, runRefs),
    },
    engineeringRuns: engineering.evidenceRuns,
    engineeringIssues: engineering.issues,
  };
}

export function statusExplanation(status: RunStatus): string {
  switch (status) {
    case RUN_STATUS.PENDING: return 'Queued and waiting to execute';
    case RUN_STATUS.RUNNING: return 'Executing';
    case RUN_STATUS.PARKED: return 'No worker; waiting for an operator decision';
    case RUN_STATUS.AWAITING_APPROVAL: return 'Waiting for legacy plan approval';
    case RUN_STATUS.COMPLETE: return 'Engineering DAG completed';
    case RUN_STATUS.FAILED: return 'Execution failed';
    case RUN_STATUS.SHIPPED: return 'Research or declared gate confirmed delivery';
    case RUN_STATUS.CEILING_HIT: return 'Honest ceiling reached without a better result';
    case RUN_STATUS.ESCALATED: return 'Escalated and needs intervention';
    case RUN_STATUS.REALITY_GATE_FAILED: return 'Reality gate failed';
    case RUN_STATUS.PHASE_COMPLETE: return 'Stage complete; campaign can continue';
    case RUN_STATUS.STOPPED: return 'Stopped by the operator or system';
    case RUN_STATUS.INCOMPLETE: return 'Budget exhausted while work was in progress';
  }
}

function stageDurationLowerBound(state: StoreState): number {
  let total = 0;
  for (const [id, stage] of Object.entries(state.stages)) {
    if (id === '_supervisor') continue;
    if (finiteNumber(stage.duration_ms) !== undefined) total += Math.max(0, stage.duration_ms ?? 0);
    else for (const attempt of stage.attempts ?? []) total += Math.max(0, attempt.duration_ms ?? 0);
  }
  return total;
}

export function deriveRunWallClock(state: StoreState, nowMs: number): { milliseconds: number | null; partial: boolean } {
  const started = Date.parse(state.startedAt);
  if (isTerminalRunStatus(state.status)) {
    const completed = Date.parse(state.completedAt ?? '');
    return Number.isFinite(started) && Number.isFinite(completed)
      ? { milliseconds: Math.max(0, completed - started), partial: false }
      : { milliseconds: stageDurationLowerBound(state), partial: true };
  }
  if (isRunningRunStatus(state.status)) {
    return Number.isFinite(started)
      ? { milliseconds: Math.max(0, nowMs - started), partial: false }
      : { milliseconds: stageDurationLowerBound(state), partial: true };
  }
  if (isPausedRunStatus(state.status)) {
    const paused = Date.parse(state.parked?.pausedAt ?? '');
    return Number.isFinite(started) && Number.isFinite(paused)
      ? { milliseconds: Math.max(0, paused - started), partial: false }
      : { milliseconds: stageDurationLowerBound(state), partial: true };
  }
  if (state.status === RUN_STATUS.PENDING) {
    const attempted = Object.values(state.stages).some(stageWasExecuted) || Boolean(state.supervisor?.calls);
    return attempted
      ? { milliseconds: stageDurationLowerBound(state), partial: true }
      : { milliseconds: 0, partial: false };
  }
  if (isAwaitingApprovalRunStatus(state.status)) {
    return { milliseconds: stageDurationLowerBound(state), partial: true };
  }
  return { milliseconds: stageDurationLowerBound(state), partial: true };
}

export interface AttemptTokenEvidenceSummary {
  known: number;
  recordedUnknown: number;
  unrecorded: number;
}

export interface RunTokenCost {
  tokens: number;
  supervisorTokens: number;
  complete: boolean;
  attemptEvidence: AttemptTokenEvidenceSummary;
}

interface StageTokenCost {
  tokens: number;
  complete: boolean;
  attemptEvidence: AttemptTokenEvidenceSummary;
}

const EMPTY_ATTEMPT_TOKEN_EVIDENCE: AttemptTokenEvidenceSummary = {
  known: 0,
  recordedUnknown: 0,
  unrecorded: 0,
};

function attemptTokens(stage: StageStatus): StageTokenCost {
  const attempts = stage.attempts ?? [];
  if (attempts.length > 0) {
    const attemptEvidence = attempts.reduce<AttemptTokenEvidenceSummary>((summary, attempt) => {
      const hasBothCounters = finiteNumber(attempt.tokens_in) !== undefined
        && finiteNumber(attempt.tokens_out) !== undefined;
      if (hasBothCounters) summary.known++;
      else if (attempt.tokenUsage === 'unknown') summary.recordedUnknown++;
      else summary.unrecorded++;
      return summary;
    }, { ...EMPTY_ATTEMPT_TOKEN_EVIDENCE });
    return {
      tokens: attempts.reduce((total, attempt) => (
        total
        + (finiteNumber(attempt.tokens_in) ?? 0)
        + (finiteNumber(attempt.tokens_out) ?? 0)
      ), 0),
      complete: attempts.every((attempt) => (
        finiteNumber(attempt.tokens_in) !== undefined
        && finiteNumber(attempt.tokens_out) !== undefined
      )),
      attemptEvidence,
    };
  }
  if (!stageWasExecuted(stage)) {
    return { tokens: 0, complete: true, attemptEvidence: { ...EMPTY_ATTEMPT_TOKEN_EVIDENCE } };
  }
  const complete = finiteNumber(stage.tokens_in) !== undefined && finiteNumber(stage.tokens_out) !== undefined;
  return {
    // Historical adapters sometimes recorded only one side of token telemetry.
    // Preserve that known lower bound while keeping the completeness flag false.
    tokens: (finiteNumber(stage.tokens_in) ?? 0) + (finiteNumber(stage.tokens_out) ?? 0),
    complete,
    attemptEvidence: complete
      ? { known: 1, recordedUnknown: 0, unrecorded: 0 }
      : { known: 0, recordedUnknown: 0, unrecorded: 1 },
  };
}

export function deriveRunTokenCost(state: StoreState): RunTokenCost {
  let tokens = 0;
  let complete = true;
  const attemptEvidence = { ...EMPTY_ATTEMPT_TOKEN_EVIDENCE };
  const stageLedgers: Array<[string, StageStatus]> = [
    ...Object.entries(state.stages),
    ...(state.retiredStageUsage ?? []).map((entry): [string, StageStatus] => [entry.stageId, entry.status]),
  ];
  for (const [stageId, stage] of stageLedgers) {
    if (stageId === '_supervisor') continue;
    const value = attemptTokens(stage);
    tokens += value.tokens;
    if (!value.complete) complete = false;
    attemptEvidence.known += value.attemptEvidence.known;
    attemptEvidence.recordedUnknown += value.attemptEvidence.recordedUnknown;
    attemptEvidence.unrecorded += value.attemptEvidence.unrecorded;
  }
  let supervisorTokens = 0;
  if (state.supervisor) {
    supervisorTokens = state.supervisor.tokens_in + state.supervisor.tokens_out;
  } else if (state.supervise !== false) {
    complete = false;
  }
  return { tokens: tokens + supervisorTokens, supervisorTokens, complete, attemptEvidence };
}

export function isZeroWorkRun(run: Pick<RunEvidence, 'state' | 'workflow' | 'commits'>): boolean {
  if (!isTerminalRunStatus(run.state.status) || run.commits.length > 0) return false;
  return !Object.entries(run.state.stages)
    .some(([stageId, stage]) => isExecutionStage(run as RunEvidence, stageId) && stageWasCompleted(stage));
}

function firstSummaryConclusion(run: RunEvidence): string | null {
  const lines = summarySectionLines(run.summary, ['What was done', 'Outcome', 'What was tried & learned']);
  return lines[0] ?? null;
}

function taskConclusion(run: RunEvidence): string | null {
  return run.tasks.map((task) => nonEmptyString(task.summary_one_liner)).find(Boolean) ?? null;
}

function historyConclusion(run: RunEvidence): string | null {
  for (const entry of [...run.history].reverse()) {
    const result = nonEmptyString(entry.reason) ?? nonEmptyString(entry.artifactSummary) ?? nonEmptyString(entry.outcome);
    if (result) return result;
  }
  return null;
}

function runConclusion(run: RunEvidence, fullTitle: string): string {
  const realityFailure = run.state.realityGate?.results?.find((result) => !result.pass && !result.advisory);
  const candidate = nonEmptyString(run.state.failureReason)
    ?? (realityFailure ? `${realityFailure.name}: ${realityFailure.details ?? 'Reality Gate check failed'}` : undefined)
    ?? firstSummaryConclusion(run)
    ?? taskConclusion(run)
    ?? historyConclusion(run);
  return candidate && candidate !== fullTitle ? candidate : 'Outcome summary unavailable';
}

function gateEvidence(run: RunEvidence): string[] {
  const values: string[] = [];
  for (const [id, stage] of Object.entries(run.state.stages)) {
    if (run.workflow.roles?.get(id)?.isGate) values.push(`${id}: ${stage.status}`);
  }
  if (run.state.realityGate) values.push(`Reality Gate: ${run.state.realityGate.pass ? 'pass' : 'failed'}`);
  return values;
}

function filesChanged(run: RunEvidence): string[] {
  return summarySectionLines(run.summary, ['Files changed'])
    .map((line) => line.replace(/^`|`.*$/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function runRow(run: RunEvidence, nowMs: number, zeroWorkEvidenceComplete = true): CampaignRunRow {
  const title = deriveCampaignRunTitle(run.state.taskDescription, run.workflow.name ?? run.state.workflowName);
  const duration = deriveRunWallClock(run.state, nowMs);
  const zeroWork = zeroWorkEvidenceComplete && isZeroWorkRun(run);
  return {
    runId: run.state.runId,
    shortName: title.shortName,
    fullTitle: title.fullTitle,
    status: run.state.status,
    statusExplanation: statusExplanation(run.state.status),
    conclusion: runConclusion(run, title.fullTitle),
    durationMs: duration.milliseconds,
    durationPartial: duration.partial,
    commits: run.commits,
    gates: gateEvidence(run),
    zeroWork,
    ...(zeroWork ? { zeroWorkReason: 'No delivery evidence: no commits and no completed execution stage.' } : {}),
    startedAt: validIso(run.state.startedAt),
    completedAt: validIso(run.state.completedAt),
    href: `/run/${encodeURIComponent(run.state.runId)}`,
  };
}

function sortedRuns(runs: RunEvidence[]): RunEvidence[] {
  return [...runs].sort((a, b) => {
    const aTime = Date.parse(a.state.startedAt);
    const bTime = Date.parse(b.state.startedAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    return b.state.runId.localeCompare(a.state.runId);
  });
}

function campaignRunReferences(loaded: LoadedCampaign): CampaignRunReference[] {
  const known = sortedRuns(loaded.runs).map((run) => {
    const title = deriveCampaignRunTitle(run.state.taskDescription, run.workflow.name ?? run.state.workflowName);
    return {
      runId: run.state.runId,
      shortName: title.shortName,
      href: `/run/${encodeURIComponent(run.state.runId)}`,
    };
  });
  const knownIds = new Set(known.map((ref) => ref.runId));
  const unavailable = loaded.runIds
    .filter((runId) => !knownIds.has(runId))
    .sort((a, b) => b.localeCompare(a))
    .map((runId, index) => ({
      runId,
      shortName: `Unavailable run ${index + 1}`,
      href: `/run/${encodeURIComponent(runId)}`,
    }));
  return [...known, ...unavailable];
}

function pageRuns(loaded: LoadedCampaign, nowMs: number, cursor = 0, limit = DEFAULT_PAGE_SIZE): CampaignSource<CampaignRunPage> {
  const ordered = sortedRuns(loaded.runs);
  const runRefs = campaignRunReferences(loaded);
  const safeCursor = Math.max(0, Math.min(cursor, ordered.length));
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const deliverySourceIssues = [
    loaded.entriesIssue,
    loaded.taskIssue,
    ...loaded.outerIssues,
  ].filter((value): value is CampaignIssueSeed => Boolean(value));
  const items = ordered
    .slice(safeCursor, safeCursor + safeLimit)
    .map((run) => runRow(run, nowMs, deliverySourceIssues.length === 0));
  const next = safeCursor + safeLimit < ordered.length ? String(safeCursor + safeLimit) : null;
  const issues = [
    ...campaignRunIssues(loaded),
    ...deliverySourceIssues,
    ...ordered.flatMap((run) => [run.workflow.issue, run.summaryIssue].filter((value): value is CampaignIssueSeed => Boolean(value))),
  ];
  const value = {
    items,
    shown: items.length,
    total: Math.max(loaded.runIds.length, loaded.summary.runCount, ordered.length),
    nextCursor: next,
    truncated: next !== null,
  };
  return source(value, ordered.length, issues, campaignRunTotal(loaded), runRefs);
}

function campaignCost(loaded: LoadedCampaign, nowMs: number): CampaignSource<CampaignCost> {
  let wallMs = 0;
  let tokens = 0;
  let supervisorTokens = 0;
  let succeeded = 0;
  let wallSucceeded = 0;
  let tokenSucceeded = 0;
  const issues = campaignRunIssues(loaded);
  for (const run of loaded.runs) {
    const wall = deriveRunWallClock(run.state, nowMs);
    const token = deriveRunTokenCost(run.state);
    if (wall.milliseconds !== null) wallMs += wall.milliseconds;
    tokens += token.tokens;
    supervisorTokens += token.supervisorTokens;
    if (!wall.partial) wallSucceeded += 1;
    else issues.push(issue(
      'cost-timing-incomplete',
      'Wall-clock timing is incomplete',
      { runId: run.state.runId },
    ));
    if (token.complete) tokenSucceeded += 1;
    else {
      const causes = [
        token.attemptEvidence.recordedUnknown
          ? `${token.attemptEvidence.recordedUnknown} attempt${token.attemptEvidence.recordedUnknown === 1 ? '' : 's'} explicitly reported unavailable token counts`
          : '',
        token.attemptEvidence.unrecorded
          ? `${token.attemptEvidence.unrecorded} executed attempt${token.attemptEvidence.unrecorded === 1 ? '' : 's'} did not record complete token counts`
          : '',
        !run.state.supervisor && run.state.supervise !== false
          ? 'supervisor token counts were not recorded'
          : '',
      ].filter(Boolean);
      issues.push(issue(
        'cost-token-telemetry-incomplete',
        'Token or attempt telemetry is incomplete',
        { runId: run.state.runId, detail: causes.join('; ') || undefined },
      ));
    }
    if (!wall.partial && token.complete) succeeded += 1;
  }
  const total = campaignRunTotal(loaded);
  const runCoverage = coverage(succeeded, Math.max(0, total - succeeded), total);
  const wallCoverage = coverage(wallSucceeded, Math.max(0, total - wallSucceeded), total);
  const tokenCoverage = coverage(tokenSucceeded, Math.max(0, total - tokenSucceeded), total);
  const value = { wallMs, tokens, supervisorTokens, runCoverage, wallCoverage, tokenCoverage };
  const status = issues.length === 0
    ? CAMPAIGN_SOURCE_STATUS.COMPLETE
    : loaded.runs.length > 0
      ? CAMPAIGN_SOURCE_STATUS.PARTIAL
      : CAMPAIGN_SOURCE_STATUS.UNAVAILABLE;
  return {
    status,
    value,
    coverage: runCoverage,
    ...(issues.length ? { issues: groupIssues(issues, campaignRunReferences(loaded)) } : {}),
  };
}

function runTitleById(runs: RunEvidence[]): Map<string, { fullTitle: string; shortName: string }> {
  return new Map(runs.map((run) => [run.state.runId, deriveCampaignRunTitle(run.state.taskDescription, run.workflow.name ?? run.state.workflowName)]));
}

function isSimulatedSource(source: string | undefined): boolean {
  return Boolean(source && /(?:^|[:/_.-])(?:mock|test|fixture|simulation|simulated)(?:$|[:/_.-])/iu.test(source));
}

function attentionForCampaign(
  loaded: LoadedCampaign,
  readers: CampaignPageSources,
): CampaignSource<CampaignAttention> {
  const items: CampaignAttentionItem[] = [];
  const runIssues = campaignRunIssues(loaded);
  const issues: CampaignIssueSeed[] = [...runIssues];
  let succeeded = runIssues.length ? 0 : 1;
  let totalSources = 5;
  const runIds = new Set(loaded.runIds);
  const titles = runTitleById(loaded.runs);
  const approvalsByRun = new Set<string>();
  if (loaded.inboxIssue || !loaded.inbox) {
    issues.push(loaded.inboxIssue ?? issue('campaign-inbox-unavailable', 'Campaign inbox items could not be read'));
    totalSources = 2;
  } else {
    const envelopes = [loaded.inbox.approvals, loaded.inbox.deferred, loaded.inbox.stale, loaded.inbox.patches];
    for (const envelope of envelopes) {
      if (envelope.status === CAMPAIGN_SOURCE_STATUS.COMPLETE) succeeded += 1;
      else issues.push(issue(
        'campaign-inbox-incomplete',
        'A campaign inbox source is incomplete',
        { detail: envelope.error },
      ));
    }
    for (const approval of loaded.inbox.approvals.items) {
      if (approval.campaignId !== loaded.summary.id && approval.campaignId !== loaded.summary.storageKey && !runIds.has(approval.runId)) continue;
      approvalsByRun.add(approval.runId);
      items.push({
        id: `approval:${approval.runId}:${approval.requestId}`,
        kind: 'approval',
        title: approval.title || `Approval for ${titles.get(approval.runId)?.shortName ?? 'an unavailable run'}`,
        reason: approval.body ?? `${approval.action}${approval.target ? ` · ${approval.target}` : ''}`,
        runId: approval.runId,
        href: '/inbox',
        priority: 'high',
      });
    }
    for (const patch of loaded.inbox.patches.items) {
      if (patch.campaignId !== loaded.summary.id && patch.campaignId !== loaded.summary.storageKey) continue;
      items.push({
        id: `patch:${patch.campaignId}:${patch.index}`,
        kind: 'brief_review',
        title: 'Brief revision needs a decision',
        reason: patch.reason,
        runId: patch.runId,
        href: '/inbox',
        priority: patch.severity === 'high' ? 'high' : patch.severity === 'low' ? 'low' : 'medium',
        source: patch.source,
        simulated: isSimulatedSource(patch.source),
      });
    }
    for (const deferred of loaded.inbox.deferred.items) {
      if (!deferred.runId || !runIds.has(deferred.runId)) continue;
      if (approvalsByRun.has(deferred.runId)) continue;
      items.push({
        id: `deferred:${deferred.id}`,
        kind: 'deferred',
        title: `${titles.get(deferred.runId)?.shortName ?? deferred.name ?? 'An unavailable run'} is waiting to retry`,
        reason: deferred.deferReason,
        runId: deferred.runId,
        href: '/inbox',
        priority: 'medium',
      });
    }
    for (const stale of loaded.inbox.stale.items) {
      if (stale.id !== loaded.summary.id && stale.id !== loaded.summary.storageKey) continue;
      items.push({
        id: `stale:${stale.id}`,
        kind: 'stale',
        title: 'Campaign status has not updated',
        reason: stale.staleRunId
          ? `${titles.get(stale.staleRunId)?.shortName ?? 'A run'} may have lost its worker`
          : 'Inspect the execution process and terminal record',
        runId: stale.staleRunId,
        href: stale.staleRunId ? `/run/${encodeURIComponent(stale.staleRunId)}` : '/inbox',
        priority: 'high',
      });
    }
  }
  for (const run of loaded.runs) {
    const title = titles.get(run.state.runId)!;
    if (isPausedRunStatus(run.state.status) && !approvalsByRun.has(run.state.runId)) {
      items.push({
        id: `parked:${run.state.runId}`,
        kind: 'parked',
        title: `${title.shortName} is parked`,
        reason: run.state.parked?.reason ?? 'No worker; waiting for an operator decision',
        runId: run.state.runId,
        href: '/inbox',
        priority: 'high',
      });
    }
    if (isRunningRunStatus(run.state.status)) {
      try {
        if (readers.hasLiveWorker(run.state.projectDir, run.state.runId) === false) {
          items.push({
            id: `worker:${run.state.runId}`,
            kind: 'worker_missing',
            title: `${title.shortName} is running without a worker`,
            reason: 'Inspect the missing process or wait for automatic recovery',
            runId: run.state.runId,
            href: `/run/${encodeURIComponent(run.state.runId)}`,
            priority: 'high',
          });
        }
      } catch (error) {
        issues.push(issue(
          'worker-status-unavailable',
          'Worker status could not be verified',
          { runId: run.state.runId, detail: error instanceof Error ? error.message : String(error) },
        ));
      }
    }
    if (run.state.campaignAlert) {
      items.push({
        id: `alert:${run.state.runId}:${run.state.campaignAlert.triggeredAt}`,
        kind: 'campaign_alert',
        title: `${title.shortName} triggered a campaign alert`,
        reason: run.state.campaignAlert.message,
        runId: run.state.runId,
        href: `/run/${encodeURIComponent(run.state.runId)}`,
        priority: 'medium',
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const unique = [...new Map(items.map((item) => [item.id, item])).values()]
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.title.localeCompare(b.title));
  return source(
    { items: unique, total: unique.length, shown: Math.min(unique.length, INITIAL_VISIBLE_ITEMS) },
    succeeded,
    issues,
    totalSources,
    campaignRunReferences(loaded),
  );
}

function activityForCampaign(loaded: LoadedCampaign, readers: CampaignPageSources, nowMs: number): CampaignSource<CampaignActivity> {
  const items: CampaignActivityItem[] = [];
  const issues = campaignRunIssues(loaded);
  for (const run of sortedRuns(loaded.runs)) {
    if (isTerminalRunStatus(run.state.status)) continue;
    const title = deriveCampaignRunTitle(run.state.taskDescription, run.workflow.name ?? run.state.workflowName);
    const duration = deriveRunWallClock(run.state, nowMs);
    let worker: CampaignActivityItem['worker'] = 'none';
    let anomaly: string | undefined;
    if (isRunningRunStatus(run.state.status)) {
      try {
        const live = readers.hasLiveWorker(run.state.projectDir, run.state.runId);
        worker = live === null ? 'unknown' : live ? 'live' : 'missing';
        if (worker === 'missing') anomaly = 'Status is running, but no live worker can be verified';
      } catch (error) {
        worker = 'unknown';
        issues.push(issue(
          'worker-status-unavailable',
          'Worker status could not be verified',
          { runId: run.state.runId, detail: error instanceof Error ? error.message : String(error) },
        ));
      }
    }
    items.push({
      runId: run.state.runId,
      shortName: title.shortName,
      fullTitle: title.fullTitle,
      status: run.state.status,
      statusExplanation: statusExplanation(run.state.status),
      durationMs: duration.milliseconds,
      durationPartial: duration.partial,
      worker,
      anomaly,
      href: `/run/${encodeURIComponent(run.state.runId)}`,
    });
  }
  return source(
    { items, total: items.length, shown: Math.min(items.length, INITIAL_VISIBLE_ITEMS) },
    loaded.runs.length,
    issues,
    campaignRunTotal(loaded),
    campaignRunReferences(loaded),
  );
}

function researchNarrative(
  loaded: LoadedCampaign,
  groups: ResearchMetricGroup[],
  researchIssues: CampaignIssueSeed[],
): CampaignSource<ResearchNarrative | null> {
  const runRefs = campaignRunReferences(loaded);
  if (!groups.length) return source(null, researchIssues.length ? 0 : 1, researchIssues, 1, runRefs);
  const confirmNotes: string[] = [];
  const refsById = new Map(runRefs.map((ref) => [ref.runId, ref]));
  for (const run of loaded.runs) {
    if (!run.confirm) continue;
    const status = nonEmptyString(run.confirm.status);
    if (run.confirm.pass === false || status === RESEARCH_CONFIRM_STATUS.FAILED || status === RESEARCH_CONFIRM_STATUS.NOT_RUN) {
      confirmNotes.push(`${refsById.get(run.state.runId)?.shortName ?? 'A run'}: ${nonEmptyString(run.confirm.reason) ?? status ?? 'Confirmation did not pass'}`);
    }
  }
  const latestTerminal = sortedRuns(loaded.runs).find((run) => isTerminalRunStatus(run.state.status));
  const value: ResearchNarrative = {
    selected: groups[0] ?? null,
    otherMetrics: groups.slice(1),
    acceptedPointCount: groups.reduce((sum, group) => sum + group.points.length, 0),
    confirmNotes,
    latestCanonicalStatus: latestTerminal?.state.status ?? null,
  };
  return source(value, loaded.runs.length || 1, researchIssues, Math.max(1, loaded.runs.length), runRefs);
}

function delivery(run: RunEvidence): EngineeringDelivery {
  const title = deriveCampaignRunTitle(run.state.taskDescription, run.workflow.name ?? run.state.workflowName);
  return {
    runId: run.state.runId,
    shortName: title.shortName,
    fullTitle: title.fullTitle,
    status: run.state.status,
    statusExplanation: statusExplanation(run.state.status),
    conclusion: runConclusion(run, title.fullTitle),
    commits: run.commits,
    filesChanged: filesChanged(run),
    gates: gateEvidence(run),
    href: `/run/${encodeURIComponent(run.state.runId)}`,
  };
}

function engineeringNarrative(
  loaded: LoadedCampaign,
  engineeringRuns: RunEvidence[],
  issues: CampaignIssueSeed[],
): CampaignSource<EngineeringNarrative | null> {
  const runRefs = campaignRunReferences(loaded);
  if (!engineeringRuns.length) return source(null, issues.length ? 0 : 1, issues, 1, runRefs);
  const terminal = engineeringRuns
    .filter((run) => isTerminalRunStatus(run.state.status))
    .sort((a, b) => {
      const completed = (validIso(b.state.completedAt) ?? '').localeCompare(validIso(a.state.completedAt) ?? '');
      return completed || (b.state.startedAt ?? '').localeCompare(a.state.startedAt ?? '') || b.state.runId.localeCompare(a.state.runId);
    });
  return source(
    { latest: terminal[0] ? delivery(terminal[0]) : null, deliveryCount: terminal.length },
    engineeringRuns.length,
    issues,
    engineeringRuns.length + issues.length,
    runRefs,
  );
}

function campaignStartedAt(loaded: LoadedCampaign): { value: string | null; source: CampaignIdentity['startedAtSource'] } {
  if (campaignRunIssues(loaded).length) return { value: null, source: 'unknown' };
  const starts = loaded.runs.map((run) => validIso(run.state.startedAt)).filter((value): value is string => Boolean(value));
  if (starts.length) return { value: starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0], source: 'runs' };
  if (loaded.legacyStartedAt) return { value: loaded.legacyStartedAt, source: 'legacy' };
  return { value: null, source: 'unknown' };
}

export async function readCampaignOperatorView(
  projectDir: string,
  id: string,
  overrides: Partial<CampaignPageSources> = {},
): Promise<CampaignOperatorView> {
  const readers = sourcesWithDefaults(overrides);
  const now = readers.now();
  const loaded = await loadCampaign(projectDir, id, readers, { includeInbox: true });
  const runIssues = campaignRunIssues(loaded);
  const researchIssues = [
    ...runIssues,
    loaded.entriesIssue,
    ...loaded.outerIssues,
    ...loaded.runs.flatMap((run) => [run.workflow.issue, run.confirmIssue].filter((value): value is CampaignIssueSeed => Boolean(value))),
  ].filter((value): value is CampaignIssueSeed => Boolean(value));
  const engineeringSourceIssues = [
    ...runIssues,
    loaded.entriesIssue,
    loaded.taskIssue,
    ...loaded.outerIssues,
  ].filter((value): value is CampaignIssueSeed => Boolean(value));
  const goal = asRecord(loaded.legacyState?.goal) ?? asRecord(asRecord(loaded.legacyState?.config)?.goal);
  const campaignDirection = goal?.higherIsBetter === true || goal?.higher_is_better === true
    ? 'higher'
    : goal?.higherIsBetter === false || goal?.higher_is_better === false
      ? 'lower'
      : 'unknown';
  const points = acceptedPointsFromRuns(loaded.runs, researchIssues, nonEmptyString(goal?.metric), campaignDirection);
  for (const point of outerAcceptedPoints(loaded, loaded.runs)) {
    if (!points.some((candidate) => candidate.runId === point.runId && candidate.round === point.round && candidate.metricKey === point.metricKey && candidate.value === point.value)) points.push(point);
  }
  const groups = groupResearchPoints(points);
  const uniqueResearchIssues = uniqueIssueSeeds(researchIssues);
  const classificationResult = classify(
    points,
    loaded.runs,
    uniqueResearchIssues,
    uniqueIssueSeeds(engineeringSourceIssues),
    campaignRunReferences(loaded),
  );
  const started = campaignStartedAt(loaded);
  const identity: CampaignIdentity = {
    id: loaded.summary.id,
    name: loaded.summary.name,
    storageKey: loaded.summary.storageKey,
    runCount: Math.max(loaded.summary.runCount, loaded.runIds.length, loaded.runs.length),
    startedAt: started.value,
    startedAtSource: started.source,
    classification: classificationResult.classification,
  };
  return {
    generatedAt: now.toISOString(),
    identity,
    cost: campaignCost(loaded, now.getTime()),
    attention: attentionForCampaign(loaded, readers),
    activity: activityForCampaign(loaded, readers, now.getTime()),
    research: researchNarrative(loaded, groups, uniqueResearchIssues),
    engineering: engineeringNarrative(loaded, classificationResult.engineeringRuns, classificationResult.engineeringIssues),
    runs: pageRuns(loaded, now.getTime()),
  };
}

export async function readCampaignRunPage(
  projectDir: string,
  id: string,
  cursor: number,
  limit = DEFAULT_PAGE_SIZE,
  overrides: Partial<CampaignPageSources> = {},
): Promise<CampaignSource<CampaignRunPage>> {
  const readers = sourcesWithDefaults(overrides);
  const loaded = await loadCampaign(projectDir, id, readers, { includeInbox: false });
  return pageRuns(loaded, readers.now().getTime(), cursor, limit);
}

function inboxStatus(envelopes: InboxEnvelope<unknown>[]): CampaignSourceStatus {
  if (envelopes.every((item) => item.status === CAMPAIGN_SOURCE_STATUS.COMPLETE)) return CAMPAIGN_SOURCE_STATUS.COMPLETE;
  if (envelopes.every((item) => item.status === CAMPAIGN_SOURCE_STATUS.UNAVAILABLE)) return CAMPAIGN_SOURCE_STATUS.UNAVAILABLE;
  return CAMPAIGN_SOURCE_STATUS.PARTIAL;
}

function indexAttention(
  campaign: CampaignSummaryRecord,
  inbox: CampaignInboxOverviewLike | null,
  runIds: Set<string>,
  localRunAttention: Set<string>,
  localStatePartial: boolean,
): { status: CampaignSourceStatus; count: number | null } {
  if (!inbox) {
    return {
      status: localRunAttention.size ? CAMPAIGN_SOURCE_STATUS.PARTIAL : CAMPAIGN_SOURCE_STATUS.UNAVAILABLE,
      count: localRunAttention.size || null,
    };
  }
  const envelopes: InboxEnvelope<unknown>[] = [inbox.approvals, inbox.deferred, inbox.stale, inbox.patches];
  const keys = new Set(localRunAttention);
  for (const item of inbox.approvals.items) {
    if (item.campaignId === campaign.id || item.campaignId === campaign.storageKey || runIds.has(item.runId)) keys.add(`run:${item.runId}`);
  }
  for (const item of inbox.deferred.items) {
    if (item.runId && runIds.has(item.runId)) keys.add(`run:${item.runId}`);
  }
  for (const item of inbox.stale.items) {
    if (item.id === campaign.id || item.id === campaign.storageKey) keys.add(`stale:${item.id}`);
  }
  for (const item of inbox.patches.items) {
    if (item.campaignId === campaign.id || item.campaignId === campaign.storageKey) keys.add(`patch:${item.index}`);
  }
  const envelopeStatus = inboxStatus(envelopes);
  return {
    status: localStatePartial && envelopeStatus === CAMPAIGN_SOURCE_STATUS.COMPLETE
      ? CAMPAIGN_SOURCE_STATUS.PARTIAL
      : envelopeStatus,
    count: keys.size,
  };
}

function partialState(record: RunIndexRecord, projectDir: string): StoreState {
  return {
    runId: record.runId,
    workflowName: record.workflowName ?? '',
    projectDir,
    status: (Object.values(RUN_STATUS) as string[]).includes(record.status ?? '') ? record.status as RunStatus : RUN_STATUS.PENDING,
    stages: {},
    startedAt: record.startedAt ?? '',
    completedAt: record.completedAt,
    taskDescription: record.taskDescription,
    campaignId: record.campaignId,
    campaignStorageKey: record.campaignStorageKey,
    campaignName: record.campaignName,
  };
}

function activitySummary(states: StoreState[], readers: CampaignPageSources, incomplete = false): CampaignIndexRow['activity'] {
  const running = states.filter((state) => isRunningRunStatus(state.status));
  const waiting = states.filter((state) => state.status === RUN_STATUS.PENDING || isPausedRunStatus(state.status) || isAwaitingApprovalRunStatus(state.status));
  let needsIntervention = states.some((state) => isPausedRunStatus(state.status));
  let status: CampaignSourceStatus = incomplete ? CAMPAIGN_SOURCE_STATUS.PARTIAL : CAMPAIGN_SOURCE_STATUS.COMPLETE;
  for (const state of running) {
    try {
      if (readers.hasLiveWorker(state.projectDir, state.runId) === false) needsIntervention = true;
    } catch {
      status = CAMPAIGN_SOURCE_STATUS.PARTIAL;
    }
  }
  const summary = running.length
    ? `${running.length} run${running.length === 1 ? '' : 's'} executing${needsIntervention ? '; a worker anomaly needs intervention' : ''}`
    : waiting.length
      ? `${waiting.length} run${waiting.length === 1 ? '' : 's'} waiting or parked`
      : 'No run is executing or waiting';
  return { status, running: running.length, waiting: waiting.length, summary, needsIntervention };
}

export async function readCampaignOperatorIndex(
  projectDir: string,
  overrides: Partial<CampaignPageSources> = {},
): Promise<CampaignOperatorIndex> {
  const readers = sourcesWithDefaults(overrides);
  const now = readers.now();
  let campaigns: CampaignSummaryRecord[];
  try {
    campaigns = allCampaignSummaries(projectDir, readers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      generatedAt: now.toISOString(),
      campaigns: source(
        { items: [], total: 0 },
        0,
        [issue('campaign-index-unavailable', 'Campaigns could not be enumerated', { detail: message })],
        1,
      ),
    };
  }
  const [inboxResult, tasksResult] = await Promise.allSettled([readers.readInbox(), readers.readTasks()]);
  const inbox = inboxResult.status === 'fulfilled' ? inboxResult.value : null;
  const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
  const issues: CampaignIssueSeed[] = [];
  if (inboxResult.status === 'rejected') issues.push(issue(
    'campaign-inbox-unavailable',
    'Campaign inbox items could not be read',
    { detail: inboxResult.reason instanceof Error ? inboxResult.reason.message : String(inboxResult.reason) },
  ));
  if (tasksResult.status === 'rejected') issues.push(issue(
    'task-registry-unavailable',
    'Task delivery records could not be read',
    { detail: tasksResult.reason instanceof Error ? tasksResult.reason.message : String(tasksResult.reason) },
  ));

  let allRecords: RunIndexRecord[] | null = null;
  try {
    allRecords = readers.listRunRecords(projectDir);
  } catch (error) {
    issues.push(issue(
      'run-index-unavailable',
      'The run index is unavailable',
      { detail: error instanceof Error ? error.message : String(error) },
    ));
  }
  const recordsByCampaign = new Map<string, RunIndexRecord[]>();
  for (const record of allRecords ?? []) {
    const key = resolveCampaignStorageKey({
      campaignId: record.campaignId,
      campaignStorageKey: record.campaignStorageKey,
      campaignName: record.campaignName,
    });
    if (key) recordsByCampaign.set(key, [...(recordsByCampaign.get(key) ?? []), record]);
  }
  const rows: CampaignIndexRow[] = [];
  for (const campaign of campaigns) {
    let records = allRecords ? recordsByCampaign.get(campaign.storageKey) ?? [] : [];
    if (!allRecords) {
      try { records = readers.listRunRecordsByCampaign(projectDir, campaign.storageKey) ?? []; }
      catch (error) {
        issues.push(issue(
          'campaign-run-index-unavailable',
          'A campaign run index could not be read',
          { detail: `${campaign.name}: ${error instanceof Error ? error.message : String(error)}` },
        ));
      }
    }
    const runIds = new Set(records.map((record) => record.runId));
    const activeRecords = records.filter((record) => {
      const status = record.status ?? '';
      return isRunningRunStatus(status) || status === RUN_STATUS.PENDING || isPausedRunStatus(status) || isAwaitingApprovalRunStatus(status);
    });
    const latestRecord = [...records].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || b.runId.localeCompare(a.runId))[0];
    const wantedIds = new Set([...activeRecords.map((record) => record.runId), ...(latestRecord ? [latestRecord.runId] : []), ...tasks.filter((task) => task.run_id && runIds.has(task.run_id)).map((task) => task.run_id!)]);
    const fullStates = new Map<string, StoreState>();
    for (const runId of wantedIds) {
      try { fullStates.set(runId, readers.readRunState(projectDir, runId)); }
      catch (error) {
        issues.push(issue(
          'campaign-run-state-unavailable',
          'A campaign run record could not be read',
          { detail: `${campaign.name}: ${error instanceof Error ? error.message : String(error)}` },
        ));
      }
    }
    const activeStates = activeRecords.map((record) => fullStates.get(record.runId) ?? partialState(record, projectDir));
    const activeStatePartial = activeRecords.some((record) => !fullStates.has(record.runId));
    const localRunAttention = new Set(activeStates.filter((state) => isPausedRunStatus(state.status)).map((state) => `run:${state.runId}`));
    for (const state of activeStates.filter((item) => isRunningRunStatus(item.status))) {
      try { if (readers.hasLiveWorker(projectDir, state.runId) === false) localRunAttention.add(`run:${state.runId}`); } catch { /* activity marks partial */ }
    }
    for (const state of fullStates.values()) {
      if (state.campaignAlert) localRunAttention.add(`alert:${state.runId}`);
    }
    const recentState = latestRecord ? fullStates.get(latestRecord.runId) ?? partialState(latestRecord, projectDir) : null;
    const recentStatePartial = Boolean(latestRecord && !fullStates.has(latestRecord.runId));
    let conclusion = recentState ? 'Outcome summary unavailable' : 'No run records yet';
    if (recentState) {
      const task = tasks.find((item) => item.run_id === recentState.runId);
      const summaryText = readOptionalText(join(runsRoot(projectDir), recentState.runId, 'summary.md')).value;
      const minimalRun: RunEvidence = {
        state: recentState,
        workflow: { roles: null },
        journal: { rounds: [] },
        metricArtifacts: [],
        metricIssues: [],
        summary: summaryText,
        confirm: null,
        tasks: task ? [task] : [],
        history: [],
        commits: task?.completing_commit ? [task.completing_commit] : [],
      };
      conclusion = runConclusion(minimalRun, deriveCampaignRunTitle(recentState.taskDescription, recentState.workflowName).fullTitle);
    }
    rows.push({
      id: campaign.id,
      name: campaign.name,
      runCount: Math.max(campaign.runCount, records.length),
      latestStartedAt: validIso(latestRecord?.startedAt),
      attention: indexAttention(campaign, inbox, runIds, localRunAttention, activeStatePartial),
      activity: activitySummary(activeStates, readers, activeStatePartial),
      recent: {
        status: recentStatePartial ? CAMPAIGN_SOURCE_STATUS.PARTIAL : CAMPAIGN_SOURCE_STATUS.COMPLETE,
        runStatus: recentState?.status ?? null,
        statusExplanation: recentState ? statusExplanation(recentState.status) : null,
        conclusion,
      },
      href: `/campaign/${encodeURIComponent(campaign.id)}`,
    });
  }
  return {
    generatedAt: now.toISOString(),
    campaigns: source({ items: rows, total: rows.length }, rows.length || 1, issues, Math.max(1, rows.length + issues.length)),
  };
}
