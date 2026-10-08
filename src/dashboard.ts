import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { readFileSync,readdirSync,writeFileSync,existsSync,statSync,mkdirSync,unlinkSync,renameSync,openSync,readSync,closeSync } from "node:fs";
import { join,extname,dirname,resolve } from "node:path";
import { createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import { createServer, type Server } from 'node:http';
import { homedir, networkInterfaces, userInfo, type NetworkInterfaceInfo } from 'node:os';
import { parse as parseYaml } from "yaml";
import {
campaignsRoot,extractTaskTitle,
isAwaitingApprovalRunStatus,
isPausedRunStatus,isTerminalRunStatus,isRunningStageStatus,isPendingStageStatus,
listRuns,
readRunState,readStageStatus,resolveRunStatus,updateRunState,
runDir,
RUN_STATUS,
runsRoot,
fcGlobalDir,
STAGE_STATUS
} from "./store.js";
import type { RunStatus,StoreState } from "./store.js";
import { countStandaloneRunsFromIndex,readRunIndexRecordsByCampaign,readRunIndexRecords,listStandaloneRunIdsFromIndex,getMaxUpdatedAt } from './run-index.js';
import {
listCampaigns,readCampaignEntries,
readAllCampaignEntries
} from "./campaigns.js";
import type { CampaignHistoryEntry } from "./campaigns.js";
import { loadProjectDefaults as loadCanonicalProjectDefaults } from './config.js';
import { readActiveSchedulerLoopStall } from './scheduler-heartbeat.js';
import {
describeLiveRunOwner,
findLiveRunOwnerForProject,
invalidateRunLockCache,
isLiveFlowcrewSchedulerForRun,
isProjectBusy,
parseSchedulerPidMarker
} from "./run-lock.js";
import {
defaultSocketPath,
RpcOutcomeUnknownError,
sendRpc,
type RegisterRpcResponse,
type TaskListRpcResponse,
type TaskShowEntry,
} from './orchestrator-rpc.js';
import type { CancellationResult } from './run-control.js';
import {
cancelRunThroughControlPlane,
type CancellationClientOptions,
} from './cancellation-client.js';
import {
TASK_STATUS,
type TaskCreateInput,
type TaskListFilter,
} from './task-registry.js';
import { readKGSafe } from './knowledge-graph.js';
import { consumePendingReview,readPendingReviews,ReviewConflictError,summarizePatch } from './campaign-review.js';
import type { PendingReviewEntry } from './campaign-review.js';
import { readOperatorEvents,readOperationalProjection,type EventLike } from './cli-events.js';
import { approvalArtifactPath,approvalResumeArgs,isValidApprovalRequestId } from './approval-artifacts.js';
import {
getItem as getInboxItem,
INBOX_FILTER_STATE,
listAll as listInboxItems,
resolveRequest,type InboxItem
} from './inbox.js';
import { inspectApprovalRunStanding } from './run-standing.js';
import { readOptionalJsonlFile as readJsonlFile } from './jsonl.js';
import { z } from "zod";
import pino from "pino";
import { computeBuildFingerprint,isOperatorStateRoot,type DaemonBuildFingerprint } from './daemon-identity.js';
import {
CampaignNotFoundError,readCampaignOperatorIndex,
readCampaignOperatorView,
readCampaignRunPage,
type CampaignPageSources
} from './campaign-page.js';
import {
createBriefAdmission,
inspectBrief,
verifyBriefAdmission,
type BriefAdmissionRecord,
type BriefPreflightReport,
} from './brief-preflight.js';

const log = pino({ name: 'dashboard' });

export type DashboardFreshness = 'fresh' | 'stale' | 'unverified';

export interface DashboardStatusResponse {
  freshness: DashboardFreshness;
  pid: number;
  startedAt: string;
  loadedBuild: DaemonBuildFingerprint | null;
  diskBuild: DaemonBuildFingerprint | null;
  diskIsNewer: boolean | null;
  reason?: string;
}

interface DashboardStartupIdentity {
  pid: number;
  startedAt: string;
  loadedBuild: DaemonBuildFingerprint | null;
  fingerprintError?: string;
}

function readDashboardStatus(identity: DashboardStartupIdentity, distDir: string): DashboardStatusResponse {
  let diskBuild: DaemonBuildFingerprint | null = null;
  let diskError: string | undefined;
  try {
    diskBuild = computeBuildFingerprint(distDir);
  } catch (error) {
    diskError = error instanceof Error ? error.message : String(error);
  }

  const common = {
    pid: identity.pid,
    startedAt: identity.startedAt,
    loadedBuild: identity.loadedBuild,
    diskBuild,
    diskIsNewer: identity.loadedBuild && diskBuild
      ? diskBuild.newestMtimeMs > identity.loadedBuild.newestMtimeMs
      : null,
  };
  if (!identity.loadedBuild || !diskBuild) {
    return {
      freshness: 'unverified',
      ...common,
      reason: identity.fingerprintError
        ? `startup build could not be fingerprinted: ${identity.fingerprintError}`
        : `disk build could not be fingerprinted: ${diskError ?? 'unknown error'}`,
    };
  }
  if (identity.loadedBuild.hash !== diskBuild.hash) {
    return {
      freshness: 'stale',
      ...common,
      reason: 'disk dist does not match the build loaded by this dashboard process',
    };
  }
  return { freshness: 'fresh', ...common };
}

const CAMPAIGN_PRESENTATION_STATUS = {
  RUNNING: RUN_STATUS.RUNNING,
  PARKED: RUN_STATUS.PARKED,
  SHIPPED: RUN_STATUS.SHIPPED,
  VALID_SHIP: 'valid_ship',
  STALE: 'stale',
  IDLE: 'idle',
} as const;

interface DashboardRunPresentation {
  campaignOutcome: string;
  taskStatus: string;
}

/** Dashboard projections are distinct public consequences and are exhaustive. */
const DASHBOARD_RUN_PRESENTATION = {
  [RUN_STATUS.PENDING]: { campaignOutcome: 'pending', taskStatus: 'pending' },
  [RUN_STATUS.RUNNING]: { campaignOutcome: 'running', taskStatus: 'running' },
  [RUN_STATUS.PARKED]: { campaignOutcome: 'parked', taskStatus: 'parked' },
  [RUN_STATUS.COMPLETE]: { campaignOutcome: 'shipped', taskStatus: 'completed' },
  [RUN_STATUS.FAILED]: { campaignOutcome: 'failed', taskStatus: 'failed' },
  [RUN_STATUS.AWAITING_APPROVAL]: { campaignOutcome: 'awaiting_approval', taskStatus: 'awaiting_approval' },
  [RUN_STATUS.SHIPPED]: { campaignOutcome: 'shipped', taskStatus: 'shipped' },
  [RUN_STATUS.CEILING_HIT]: { campaignOutcome: 'ceiling_hit', taskStatus: 'ceiling_hit' },
  [RUN_STATUS.ESCALATED]: { campaignOutcome: 'escalated', taskStatus: 'escalated' },
  [RUN_STATUS.REALITY_GATE_FAILED]: { campaignOutcome: 'reality_gate_failed', taskStatus: 'reality_gate_failed' },
  [RUN_STATUS.PHASE_COMPLETE]: { campaignOutcome: 'phase_complete', taskStatus: 'phase_complete' },
  [RUN_STATUS.STOPPED]: { campaignOutcome: 'stopped', taskStatus: 'stopped' },
  [RUN_STATUS.INCOMPLETE]: { campaignOutcome: 'incomplete', taskStatus: 'incomplete' },
} as const satisfies Record<RunStatus, DashboardRunPresentation>;

function dashboardRunPresentation(status: unknown): DashboardRunPresentation {
  const resolution = resolveRunStatus(status);
  if (resolution.kind === 'known') return DASHBOARD_RUN_PRESENTATION[resolution.status];
  const unrecognized = `unrecognized ${resolution.display}`;
  return { campaignOutcome: unrecognized, taskStatus: unrecognized };
}
const COMPLETE_METRIC_NAME_FRAGMENT = 'complete';

// --- Shared helpers ---

const _stageRolesCache = new Map<string, { mtime: number; roles: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> }>();
const DEFAULT_STAGE_OUTPUT_TAIL_BYTES = 200 * 1024; // 5s TTL

function invalidateTaskListCache(): void {
  _campaignListCache = null;
}

// --- Performance: campaign list cache ---
// Building the campaign list reads every campaign's state + iteration log and
// joins in run summaries; it's the heaviest dashboard query and gets polled
// every 15s by the UI. Cache it per projectDir with a short TTL, and bust it
// whenever a run/task changes (shared invalidation with the task-list cache).
let _campaignListCache: { projectDir: string; data: WorkspaceCampaign[]; timestamp: number; maxUpdatedAt: number } | null = null;
// Above the UI's 15s poll interval so a steady poll usually hits the cache;
// real changes still bust it immediately via the shared invalidation hook.
const CAMPAIGN_LIST_CACHE_TTL_MS = 20_000;

function parseTailBytes(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return DEFAULT_STAGE_OUTPUT_TAIL_BYTES;
  if (value === 'full' || value === '0') return undefined;
  const n = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STAGE_OUTPUT_TAIL_BYTES;
  return Math.min(Math.floor(n), 5 * 1024 * 1024);
}

function readTextTail(filePath: string, tailBytes?: number): { content: string; totalBytes: number; truncated: boolean; tailBytes?: number } {
  const totalBytes = statSync(filePath).size;
  if (!tailBytes || totalBytes <= tailBytes) {
    return { content: readFileSync(filePath, 'utf-8'), totalBytes, truncated: false };
  }
  const fd = openSync(filePath, 'r');
  try {
    const bytesToRead = Math.min(totalBytes, tailBytes);
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, totalBytes - bytesToRead);
    return { content: buffer.toString('utf-8'), totalBytes, truncated: true, tailBytes: bytesToRead };
  } finally {
    closeSync(fd);
  }
}

function sendStageOutput(
  reply: { header: (name: string, value: string) => unknown; type: (value: string) => { send: (payload: string) => unknown } },
  filePath: string,
  tailBytes: number | undefined,
) {
  const result = readTextTail(filePath, tailBytes);
  reply.header('X-Output-Total-Bytes', String(result.totalBytes));
  reply.header('X-Output-Truncated', result.truncated ? 'true' : 'false');
  if (result.tailBytes !== undefined) reply.header('X-Output-Tail-Bytes', String(result.tailBytes));
  return reply.type("text/markdown").send(result.content);
}


function loadStageRoles(projectDir: string, runId: string): Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> {
  try {
    const wfPath = join(runsRoot(), runId, 'workflow.yaml');
    const mtime = statSync(wfPath).mtimeMs;
    const cached = _stageRolesCache.get(runId);
    if (cached && cached.mtime === mtime) return cached.roles;
    const raw = readFileSync(wfPath, 'utf-8');
    const wf = parseYaml(raw) as { stages?: { id: string; role?: string; depends_on?: string[]; is_gate?: boolean }[] };
    const map: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> = {};
    for (const s of wf.stages ?? []) {
      map[s.id] = { role: s.role ?? '', dependsOn: s.depends_on ?? [], isGate: s.is_gate };
    }
    // Evict oldest entries when cache exceeds limit
    if (_stageRolesCache.size >= 200) {
      const first = _stageRolesCache.keys().next().value;
      if (first !== undefined) _stageRolesCache.delete(first);
    }
    _stageRolesCache.set(runId, { mtime, roles: map });
    return map;
  } catch { /* non-critical */
    return {};
  }
}

const _bestScoreCache = new Map<string, { mtime: number; bestScore?: number; metricName?: string }>();

function readBestScore(projectDir: string, runId: string): { bestScore?: number; metricName?: string } {
  const runPath = join(runsRoot(), runId);
  // Use run.json mtime as cache key — it changes whenever the run state updates
  try {
    const mtime = statSync(join(runPath, 'run.json')).mtimeMs;
    const cached = _bestScoreCache.get(runId);
    if (cached && cached.mtime === mtime) return { bestScore: cached.bestScore, metricName: cached.metricName };
  } catch { /* no run.json */ }

  let best: number | undefined;
  let name: string | undefined;
  try {
    // Check legacy metrics_*.json files at run root
    const files = readdirSync(runPath).filter(f => f.startsWith('metrics_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const m = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
        if (typeof m.score === 'number' && (best === undefined || m.score > best)) {
          best = m.score;
          name = m.metric_name;
        }
      } catch { /* skip */ }
    }
    // Check per-stage metric.json files (written by gate agents)
    const stagesPath = join(runPath, 'stages');
    try {
      for (const sid of readdirSync(stagesPath)) {
        const mp = join(stagesPath, sid, 'metric.json');
        try {
          const m = JSON.parse(readFileSync(mp, 'utf-8'));
          if (m.hasMetric && typeof m.value === 'number' && (best === undefined || m.value > best)) {
            best = m.value;
            name = m.metric;
          }
        } catch { /* skip */ }
      }
    } catch { /* no stages dir */ }
    // Fallback: check verdict files for scores (legacy format)
    if (best === undefined) {
      const verdictFiles = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
      for (const f of verdictFiles) {
        try {
          const v = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
          if (typeof v.score === 'number' && (best === undefined || v.score > best)) {
            best = v.score;
            name = typeof v.metric === 'string' ? v.metric : undefined;
          }
        } catch { /* skip */ }
      }
    }
    // Check knowledge graph bestScore
    try {
      const kgPath = join(runPath, 'knowledge_graph.json');
      const kgData = JSON.parse(readFileSync(kgPath, 'utf-8'));
      if (typeof kgData?.metadata?.bestScore === 'number' && (best === undefined || kgData.metadata.bestScore > best)) {
        best = kgData.metadata.bestScore;
        name = kgData.metadata.metricName ?? name;
      }
    } catch { /* no KG or parse error */ }
    // Cache result
    try {
      const mtime = statSync(join(runPath, 'run.json')).mtimeMs;
      if (_bestScoreCache.size >= 200) {
        const first = _bestScoreCache.keys().next().value;
        if (first !== undefined) _bestScoreCache.delete(first);
      }
      _bestScoreCache.set(runId, { mtime, bestScore: best, metricName: name });
    } catch { /* ignore */ }
    return { bestScore: best, metricName: name };
  } catch { return {}; }
}

type MetricFormat = 'currency_usd' | 'rating_0_to_10' | 'pct' | 'count' | 'duration_min' | 'raw';

interface WorkspaceMetric {
  name: string;
  value: number | null;
  format: MetricFormat;
  target?: { min: number; max?: number } | null;
  sublabel?: string;
}

interface WorkspaceCampaign {
  id: string;
  name: string;
  status: string;
  badges: { text: string; kind: string }[];
  metric: WorkspaceMetric | null;
  iterations: { label: string; value: number; verdict: string }[] | null;
  phases: { name: string; status?: string; elapsed_min?: number; attempt?: number; commit?: string; commit_chain: string[]; notes?: string | null; direction?: string | null; result?: number | null; runId?: string | null }[] | null;
  brief_revisions: { version: string; reason: string; shipped?: boolean }[] | null;
  runs: { id: string; iter: string; metric: number | null; summary: string; duration: string; outcome: string }[];
  runs_total: number;
  latest_outcome?: string | null;
  latestOutcome?: string | null;
  started_at?: string;
  projectDir?: string | null;
  briefDir?: string | null;
  goal?: unknown;
  budget?: unknown;
  /** Underlying run to inspect/mark failed when the synthesized campaign status is stale. */
  staleRunId?: string;
}

export function readExecutionDefaults(configDir?: string): { timeoutMs: number; maxIterations: number; gateRetryLoops: number; stageTechnicalRetries: number } {
  const projectDir = dirname(configDir ?? join(process.cwd(), 'config'));
  const defaults = loadCanonicalProjectDefaults(projectDir);
  return {
    timeoutMs: defaults.timeout_ms,
    maxIterations: defaults.max_iterations,
    gateRetryLoops: defaults.gate_retry_loops,
    stageTechnicalRetries: defaults.stage_technical_retries,
  };
}

function isSafeId(id: string): boolean {
  return !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

function isSafeCampaignVersion(version: string): boolean {
  return /^v\d+$/.test(version);
}

function campaignFsRoot(): string {
  return campaignsRoot();
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { /* non-critical */
    return null;
  }
}

function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso) return '';
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const minutes = Math.max(0, Math.floor((end - start) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Parse the "5m" / "1h2m" duration string back into minutes for the phase timeline bar. */
function parseDurationMin(duration?: string): number | undefined {
  if (!duration) return undefined;
  const h = /(\d+)h/.exec(duration);
  const m = /(\d+)m/.exec(duration);
  if (!h && !m) return undefined;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

/**
 * The winning research direction for a run: the round (label + result) from its
 * research_journal that the run treated as best. Prefers the round whose result equals the
 * canonical bestScore; otherwise the max-result round (higher-is-better default). Detail-view
 * only — returns null with no journal so the caller falls back to the cheap run summary.
 */
function bestRoundForRun(runId: string, prefer?: number | null): { label: string; result: number | null } | null {
  try {
    const path = join(runsRoot(), runId, 'research_journal.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { rounds?: { label?: unknown; result?: unknown }[] };
    const rounds = (parsed.rounds ?? []).filter(
      (round): round is { label: string; result: number } => typeof round?.label === 'string' && typeof round?.result === 'number',
    );
    if (!rounds.length) return null;
    if (typeof prefer === 'number') {
      const hit = rounds.find((round) => round.result === prefer);
      if (hit) return { label: hit.label, result: hit.result };
    }
    const best = rounds.reduce((a, c) => (c.result > a.result ? c : a));
    return { label: best.label, result: best.result };
  } catch {
    return null;
  }
}

function deriveMetricFormat(metricName?: string, score?: number | null, _threshold?: number | null): MetricFormat {
  const name = (metricName ?? '').toLowerCase();
  if ((name.includes('audience') || name.includes('rating') || name.includes('gate'))
    && score != null && score >= -1 && score <= 10) {
    return 'rating_0_to_10';
  }
  if (name.includes('pct') || name.includes('percent')) return 'pct';
  if (name.includes('count') || name.includes(COMPLETE_METRIC_NAME_FRAGMENT) || name.endsWith('_n')) return 'count';
  if (name.includes('duration') || name.includes('minute') || name.endsWith('_min')) return 'duration_min';
  if (name.includes('pnl') || name.includes('usd') || name.includes('oos')) return 'currency_usd';
  if (score != null && Number.isFinite(score)) {
    if (score > 100) return 'currency_usd';
    if (score >= 0 && score <= 10) return 'rating_0_to_10';
  }
  return 'raw';
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readRunStateSafe(projectDir: string, runId: string): StoreState | null {
  try {
    return readRunState(projectDir, runId);
  } catch {
    return null;
  }
}

/**
 * Death evidence for stale detection. Quiet output is not death: a single stage
 * can run far longer than STALE_MS without touching state.json or
 * iteration_log.jsonl — a long test suite, a fetch, a research backtest. The
 * process holding the run is the authority on whether it is still working.
 *
 * Fails closed in the direction that matters. An unreadable or absent
 * scheduler.pid returns false, so a run with no identifiable owner can still be
 * called stale; only a live process bound to *this* run suppresses the warning,
 * which is why the run-bound check is used rather than bare PID liveness — a
 * recycled PID must not keep a dead run looking alive.
 *
 */
export function schedulerIsAliveForRun(projectDir: string, runId: string): boolean {
  if (!projectDir || !runId) return false;
  try {
    const runPath = runDir(projectDir, runId);
    const pid = parseSchedulerPidMarker(readFileSync(join(runPath, 'scheduler.pid'), 'utf-8'));
    if (pid === null) return false;
    return isLiveFlowcrewSchedulerForRun(pid, runId, runPath);
  } catch {
    return false;
  }
}

export function schedulerLoopIsStalled(projectDir: string, runId: string): boolean {
  if (!projectDir || !runId) return false;
  try { return readActiveSchedulerLoopStall(runDir(projectDir, runId)) !== undefined; }
  catch { return false; }
}

function campaignStorageAliases(id: string): Set<string> {
  const aliases = new Set<string>([id]);
  const normalized = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized) aliases.add(normalized);
  return aliases;
}

function runMatchesCampaign(state: StoreState, id: string): boolean {
  const aliases = campaignStorageAliases(id);
  return [state.campaignId, state.campaignStorageKey, state.campaignName]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => aliases.has(value) || aliases.has(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')));
}

function summarizeRunOutcome(status?: string): string {
  return status === undefined ? 'unknown' : dashboardRunPresentation(status).campaignOutcome;
}

/** True when the run has a generated summary.md the dashboard can display. */
function runHasSummary(runId: string): boolean {
  return existsSync(join(runsRoot(), runId, 'summary.md'));
}

function runSummaryFromState(state: StoreState, metric?: number | null): CampaignRunSummary {
  const best = readBestScore(state.projectDir, state.runId).bestScore;
  return {
    id: state.runId,
    iter: state.campaignIteration != null || state.currentIteration != null ? `iter ${state.campaignIteration ?? state.currentIteration}` : '',
    metric: metric ?? best ?? null,
    summary: (extractTaskTitle(state.taskDescription) || state.workflowName || '').slice(0, 90),
    duration: formatDuration(state.startedAt, state.completedAt),
    outcome: summarizeRunOutcome(state.status),
    hasSummary: runHasSummary(state.runId),
  };
}

type CampaignRunSummary = { id: string; iter: string; metric: number | null; summary: string; duration: string; outcome: string; hasSummary: boolean };
type CampaignRunSlice = { runs: CampaignRunSummary[]; total: number };
type StandaloneRunSummary = { id: string; projectDir: string; summary: string; duration: string; outcome: string; hasSummary: boolean };

function readCampaignRuns(projectDir: string, id: string): CampaignRunSlice {
  // Fast path: query the SQLite run index by campaign storage key instead of
  // scanning every run.json on disk. This turns the per-campaign cost from
  // O(all runs) into O(matching runs) and is what keeps the campaign list
  // responsive as the number of campaigns/runs grows.
  const indexed = readCampaignRunsFromIndex(projectDir, id);
  if (indexed) return indexed;
  // Fallback (SQLite unavailable): legacy full scan.
  const runs: CampaignRunSummary[] = [];
  let total = 0;
  for (const runId of listRuns(projectDir).reverse()) {
    const state = readRunStateSafe(projectDir, runId);
    if (!state || !runMatchesCampaign(state, id)) continue;
    total++;
    if (runs.length < 12) runs.push(runSummaryFromState(state));
  }
  return { runs, total };
}

function readCampaignRunsFromIndex(projectDir: string, id: string): CampaignRunSlice | null {
  // The index is keyed by canonical campaign storage key; campaign ids on disk
  // are usually already canonical, but normalize defensively and try both.
  const normalized = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const keys = new Set<string>([id, normalized].filter(Boolean));
  const records: { runId: string }[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const rows = readRunIndexRecordsByCampaign(projectDir, key);
    if (rows === null) return null; // SQLite unavailable → signal fallback
    for (const row of rows) {
      if (seen.has(row.runId)) continue;
      seen.add(row.runId);
      records.push({ runId: row.runId });
    }
  }
  // Records come back ordered by run_id ASC; newest run ids sort last.
  const runs: CampaignRunSummary[] = [];
  let total = 0;
  for (const { runId } of records.sort((a, b) => b.runId.localeCompare(a.runId))) {
    const state = readRunStateSafe(projectDir, runId);
    if (!state || !runMatchesCampaign(state, id)) continue;
    total++;
    if (runs.length < 12) runs.push(runSummaryFromState(state));
  }
  return { runs, total };
}

function readStandaloneRuns(projectDir: string): { runs: StandaloneRunSummary[]; total: number } {
  const runs: StandaloneRunSummary[] = [];
  // Prefer the index: query only run ids with no campaign attached (newest first),
  // so we read at most ~LIMIT run.json files instead of scanning toward all ~9900
  // when the workspace is dominated by campaign runs. Over-fetch a little to absorb
  // any rows whose state no longer matches, then re-verify and cap.
  const LIMIT = 30;
  const indexedIds = listStandaloneRunIdsFromIndex(projectDir, LIMIT * 2);
  const indexedTotal = indexedIds === null ? null : countStandaloneRunsFromIndex(projectDir);
  const hasExactIndexResult = indexedIds !== null && indexedTotal !== null;
  const candidateIds = hasExactIndexResult ? indexedIds : listRuns(projectDir).reverse();
  let fallbackTotal = 0;
  for (const runId of candidateIds) {
    const state = readRunStateSafe(projectDir, runId);
    if (!state) continue;
    if (state.campaignId || state.campaignStorageKey || state.campaignName) continue;
    fallbackTotal++;
    if (runs.length < LIMIT) {
      runs.push({
        id: state.runId,
        projectDir: state.projectDir.split(/[\\/]/).filter(Boolean).at(-1) ?? state.projectDir,
        summary: (extractTaskTitle(state.taskDescription) || state.workflowName || '').slice(0, 80),
        duration: formatDuration(state.startedAt, state.completedAt),
        outcome: summarizeRunOutcome(state.status),
        hasSummary: runHasSummary(state.runId),
      });
    }
  }
  return { runs, total: hasExactIndexResult ? indexedTotal : fallbackTotal };
}

function stageArtifactCount(projectDir: string, runId: string, stageId: string): number {
  const dir = join(runsRoot(), runId, 'stages', stageId);
  try {
    return readdirSync(dir).filter((name) => name !== 'input.md' && name !== 'output.md' && name !== 'status.json').length;
  } catch {
    return 0;
  }
}

function readRunEvents(runId: string): EventLike[] {
  try { return readOperatorEvents(join(runsRoot(), runId), 200); } catch { return []; }
}

function readStageOutputPreviews(runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stagesDir = join(runsRoot(), runId, 'stages');
  try {
    for (const stageId of readdirSync(stagesDir)) {
      const outputPath = join(stagesDir, stageId, 'output.md');
      if (!existsSync(outputPath)) continue;
      out[stageId] = readFileSync(outputPath, 'utf-8').slice(0, 2048);
    }
  } catch {
    // Stage output previews are optional.
  }
  return out;
}

function stateToRunDetail(state: StoreState, projectDir: string) {
  const roles = loadStageRoles(projectDir, state.runId);
  const dispatched = new Map<string, Record<string, unknown>>();
  for (const stage of Array.isArray(state.dispatchedStages) ? state.dispatchedStages : []) {
    if (stage && typeof stage === 'object' && typeof (stage as Record<string, unknown>).id === 'string') {
      dispatched.set((stage as Record<string, unknown>).id as string, stage as Record<string, unknown>);
    }
  }
  const stageIds = new Set<string>([
    ...Object.keys(state.stages),
    ...Object.keys(roles).filter((id) =>
      state.stages[id] !== undefined
      || dispatched.has(id)
      || !state.stageEvidence?.some((entry) => entry.stageId === id)),
    ...dispatched.keys(),
  ]);
  const stages = [...stageIds].map((id) => {
    let status = state.stages[id];
    // status.json is written by the worker at attempt boundaries. Prefer that
    // fresh ledger if run.json briefly lags, so the live page never reports an
    // old attempt as the current one.
    try { status = readStageStatus(projectDir, state.runId, id); } catch { /* aggregate-only legacy run */ }
    const dyn = dispatched.get(id);
    const depends = roles[id]?.dependsOn
      ?? (Array.isArray(dyn?.depends_on) ? dyn.depends_on.filter((v): v is string => typeof v === 'string') : []);
    const retryTo = Array.isArray(dyn?.retry_to) ? dyn.retry_to.filter((v): v is string => typeof v === 'string') : [];
    return {
      id,
      role: roles[id]?.role ?? stringValue(dyn?.role) ?? '',
      depends_on: depends,
      dependsOn: depends,
      is_gate: roles[id]?.isGate ?? dyn?.is_gate === true,
      retry_to: retryTo,
      status: status?.status ?? 'pending',
      duration_ms: status?.duration_ms,
      retries: status?.retries ?? 0,
      reruns: status?.reruns ?? 0,
      attempts: status?.attempts ?? [],
      artifact_count: status?.artifacts?.length ?? stageArtifactCount(projectDir, state.runId, id),
      calls: undefined as number | undefined,
      tokens_in: status?.tokens_in,
      tokens_out: status?.tokens_out,
    };
  });
  if (state.supervisor) {
    stages.push({
      id: '_supervisor',
      role: 'supervisor',
      depends_on: [],
      dependsOn: [],
      is_gate: false,
      retry_to: [],
      status: state.supervisor.status,
      duration_ms: state.supervisor.duration_ms,
      retries: 0,
      reruns: Math.max(0, state.supervisor.calls - 1),
      attempts: state.supervisor.attempts,
      artifact_count: 0,
      calls: state.supervisor.calls,
      tokens_in: state.supervisor.tokens_in,
      tokens_out: state.supervisor.tokens_out,
    });
  }
  const kg = readKGSafe(projectDir, state.runId);
  const runDirectory = join(runsRoot(), state.runId);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    startedAt: state.startedAt,
    projectDir: state.projectDir,
    iteration: state.currentIteration ?? state.campaignIteration,
    maxIterations: state.maxIterations,
    completedAt: state.completedAt,
    duration_min: (() => {
      const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
      const end = Date.parse(state.completedAt ?? new Date().toISOString());
      const mins = Math.floor((end - start) / 60000);
      return Number.isFinite(mins) ? mins : null; // guard unparseable timestamps → NaN
    })(),
    taskDescriptionPreview: (state.taskDescription ?? '').slice(0, 300),
    campaignId: state.campaignId ?? state.campaignStorageKey,
    failureReason: state.failureReason,
    realityGate: state.realityGate,
    supervisor: state.supervisor,
    stages,
    stageEvidence: state.stageEvidence ?? [],
    kg: { nodes: kg.nodes ?? [], edges: kg.edges ?? [] },
    events: readRunEvents(state.runId),
    operational: readOperationalProjection(runDirectory, { state }),
    stage_outputs: readStageOutputPreviews(state.runId),
  };
}

function campaignDirOr404(id: string): string | null {
  if (!isSafeId(id)) return null;
  const dir = join(campaignFsRoot(), id);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch { /* not found */
    return null;
  }
}

function getStringAt(obj: unknown, path: string[]): string | undefined {
  let cursor: unknown = obj;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor : undefined;
}

function getNumberAt(obj: unknown, path: string[]): number | undefined {
  let cursor: unknown = obj;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

function resolveBriefDir(state: Record<string, unknown> | null): string | undefined {
  const briefDir = getStringAt(state, ['briefDir'])
    ?? getStringAt(state, ['brief_dir'])
    ?? getStringAt(state, ['config', 'briefDir'])
    ?? getStringAt(state, ['config', 'brief_dir'])
    ?? getStringAt(state, ['campaign', 'briefDir'])
    ?? getStringAt(state, ['campaign', 'brief_dir']);
  if (briefDir) return briefDir;
  const briefPath = getStringAt(state, ['briefPath'])
    ?? getStringAt(state, ['brief_path'])
    ?? getStringAt(state, ['config', 'briefPath'])
    ?? getStringAt(state, ['config', 'brief_path']);
  return briefPath ? dirname(briefPath) : undefined;
}

function latestIterationOutcome(iterations: unknown[]): string | undefined {
  for (let i = iterations.length - 1; i >= 0; i--) {
    const entry = iterations[i];
    if (entry && typeof entry === 'object') {
      const outcome = (entry as Record<string, unknown>).outcome;
      if (typeof outcome === 'string') return outcome;
    }
  }
  return undefined;
}

export function campaignSummary(id: string, dir: string): WorkspaceCampaign {
  const state = readJsonFile(join(dir, 'state.json'));
  const iterations = readJsonlFile(join(dir, 'iteration_log.jsonl'));
  const stat = statSync(dir);
  const latest = iterations.at(-1) as Record<string, unknown> | undefined;
  const latestRunId = stringValue(latest?.runId)
    ?? stringValue(latest?.run_id)
    ?? getStringAt(state, ['runId'])
    ?? getStringAt(state, ['run_id']);
  let status = getStringAt(state, ['status'])
    ?? getStringAt(state, ['state'])
    ?? latestIterationOutcome(iterations)
    ?? 'unknown';
  // STALE DETECTION: if status='running' but neither state.json nor
  // iteration_log.jsonl has been touched in >30min, the daemon likely
  // exited without writing terminal status (framework bug or crash).
  // Override to 'stale' so the dashboard stops showing it as RUNNING.
  if (status === CAMPAIGN_PRESENTATION_STATUS.RUNNING) {
    const projectDir = getStringAt(state, ['projectDir']) ?? '';
    if (latestRunId && schedulerLoopIsStalled(projectDir, latestRunId)) {
      status = CAMPAIGN_PRESENTATION_STATUS.STALE;
    }
    const STALE_MS = 30 * 60 * 1000;
    let lastMtime = 0;
    try { lastMtime = Math.max(lastMtime, statSync(join(dir, 'state.json')).mtimeMs); } catch { /* ignore */ }
    try { lastMtime = Math.max(lastMtime, statSync(join(dir, 'iteration_log.jsonl')).mtimeMs); } catch { /* ignore */ }
    if (status === CAMPAIGN_PRESENTATION_STATUS.RUNNING
        && lastMtime > 0 && Date.now() - lastMtime > STALE_MS) {
      const underlying = latestRunId ? readRunStateSafe(projectDir, latestRunId) : null;
      status = underlying && (
        isTerminalRunStatus(underlying.status)
        || isPausedRunStatus(underlying.status)
        || isAwaitingApprovalRunStatus(underlying.status)
      )
        ? underlying.status
        // Silence is not death. Only demote to stale once no live scheduler
        // process is bound to the run; a long stage is quiet, not lost.
        : latestRunId && schedulerIsAliveForRun(projectDir, latestRunId)
          ? status
          : CAMPAIGN_PRESENTATION_STATUS.STALE;
    }
  }
  const latestScore = numericValue(latest?.score);
  const latestMetric = stringValue(latest?.metric)
    ?? getStringAt(state, ['goal', 'metric'])
    ?? getStringAt(state, ['config', 'goal', 'metric']);
  const threshold = numericValue(latest?.threshold)
    ?? getNumberAt(state, ['goal', 'threshold'])
    ?? getNumberAt(state, ['threshold']);
  const formattedIterations = iterations
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const value = numericValue(row.score) ?? numericValue(row.value);
      if (value == null) return null;
      const iter = row.iter ?? row.iteration ?? index + 1;
      const passed = row.pass === true
        || row.outcome === CAMPAIGN_PRESENTATION_STATUS.VALID_SHIP
        || row.outcome === CAMPAIGN_PRESENTATION_STATUS.SHIPPED;
      return {
        label: `iter ${iter}`,
        value,
        verdict: passed ? CAMPAIGN_PRESENTATION_STATUS.SHIPPED : threshold != null && value >= threshold ? 'unstable' : 'interim',
      };
    })
    .filter((entry): entry is { label: string; value: number; verdict: string } => entry !== null);
  const revisionsRaw = readJsonlFile(join(resolveBriefDir(state) ?? '', 'revisions.jsonl'));
  const briefRevisions = revisionsRaw
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const to = stringValue(row.to_version) ?? stringValue(row.version) ?? `v${index + 2}`;
      const reason = stringValue(row.rule) ?? stringValue(row.reason) ?? (row.patch ? JSON.stringify(row.patch).slice(0, 120) : 'revision');
      return { version: to, reason };
    })
    .filter((entry): entry is { version: string; reason: string } => entry !== null);
  const phaseEntries: { name: string; status?: string; elapsed_min?: number; attempt?: number; commit?: string; commit_chain: string[]; notes?: string }[] = [];
  for (const entry of iterations) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const phase = stringValue(row.phase) ?? stringValue(row.nextPhase);
    if (!phase) continue;
    const phaseEntry: { name: string; status?: string; elapsed_min?: number; attempt?: number; commit?: string; commit_chain: string[]; notes?: string } = {
      name: phase,
      commit_chain: Array.isArray(row.commit_chain) ? row.commit_chain.filter((v): v is string => typeof v === 'string') : [],
    };
    const phaseStatus = row.phaseComplete === true ? 'complete' : stringValue(row.outcome) ?? stringValue(row.status);
    const elapsed = numericValue(row.elapsed_min);
    const attempt = numericValue(row.iteration) ?? numericValue(row.iter);
    const commit = stringValue(row.completing_commit);
    const notes = stringValue(row.reason) ?? stringValue(row.artifactSummary);
    if (phaseStatus !== undefined) phaseEntry.status = phaseStatus;
    if (elapsed !== undefined) phaseEntry.elapsed_min = elapsed;
    if (attempt !== undefined) phaseEntry.attempt = attempt;
    if (commit !== undefined) phaseEntry.commit = commit;
    if (notes !== undefined) phaseEntry.notes = notes;
    phaseEntries.push(phaseEntry);
  }
  const latestOutcome = latestIterationOutcome(iterations) ?? null;
  const staleRunId = status === CAMPAIGN_PRESENTATION_STATUS.STALE
    ? latestRunId
    : undefined;
  const metric = latestMetric && latestScore != null
    ? {
      name: latestMetric,
      value: latestScore,
      format: deriveMetricFormat(latestMetric, latestScore, threshold),
      target: threshold != null ? { min: threshold } : null,
      sublabel: threshold != null ? `threshold ${threshold}` : undefined,
    }
    : null;
  return {
    id,
    name: getStringAt(state, ['name']) ?? id,
    status,
    badges: [
      { text: `${iterations.length} runs`, kind: 'default' },
      status === CAMPAIGN_PRESENTATION_STATUS.RUNNING ? { text: 'RUNNING', kind: 'accent' } : null,
      status === CAMPAIGN_PRESENTATION_STATUS.SHIPPED || status === CAMPAIGN_PRESENTATION_STATUS.VALID_SHIP ? { text: 'SHIPPED', kind: 'success' } : null,
    ].filter((badge): badge is { text: string; kind: string } => badge !== null),
    metric,
    iterations: formattedIterations.length ? formattedIterations : null,
    phases: phaseEntries.length ? phaseEntries : null,
    brief_revisions: briefRevisions.length ? briefRevisions : null,
    runs: [],
    runs_total: 0,
    started_at: getStringAt(state, ['started_at']) ?? getStringAt(state, ['startedAt']) ?? stat.birthtime.toISOString(),
    latest_outcome: latestOutcome,
    latestOutcome,
    projectDir: getStringAt(state, ['projectDir']) ?? getStringAt(state, ['project_dir']) ?? getStringAt(state, ['config', 'projectDir']) ?? null,
    briefDir: resolveBriefDir(state) ?? null,
    goal: (state?.goal ?? (state?.config as Record<string, unknown> | undefined)?.goal ?? null) as unknown,
    budget: state?.budget ?? (state?.config as Record<string, unknown> | undefined)?.budget ?? {
      max_iters: getNumberAt(state, ['max_iters']) ?? getNumberAt(state, ['maxIterations']) ?? null,
    },
    ...(staleRunId ? { staleRunId } : {}),
  };
}

function campaignFromHistory(
  projectDir: string,
  id: string,
  name?: string,
  prefetchedEntries?: CampaignHistoryEntry[],
  prefetchedRuns?: CampaignRunSlice,
  // detailed=true is the single-campaign detail view (/api/campaigns/:id): it may read each
  // phase-run's research_journal to surface the winning direction. The campaign LIST keeps
  // detailed=false so it never pays O(campaigns × runs) journal reads.
  detailed = false,
): WorkspaceCampaign | null {
  const entries = prefetchedEntries ?? readCampaignEntries(projectDir, id);
  const runSlice = prefetchedRuns ?? readCampaignRuns(projectDir, id);
  const runs = runSlice.runs;
  if (!entries.length && runSlice.total === 0) return null;
  const latest = entries.at(-1);
  const scoreEntries = entries.filter((entry) => typeof entry.score === 'number');
  const latestScore = [...scoreEntries].at(-1);
  const threshold = undefined;
  const metric = latestScore?.metric && latestScore.score != null
    ? {
      name: latestScore.metric,
      value: latestScore.score,
      format: deriveMetricFormat(latestScore.metric, latestScore.score, threshold),
      target: null,
      sublabel: undefined,
    }
    : null;
  const iterations = scoreEntries.map((entry) => ({
    label: `r${entry.seq} i${entry.iteration ?? 1}`,
    value: entry.score as number,
    verdict: entry.pass ? 'shipped' : 'interim',
  }));
  const phaseEntries = entries.filter((entry) => entry.phase || entry.nextPhase || entry.outcome);
  // Each phase row is one research attempt (a run). Enrich it from the run summary (duration +
  // best score — both already loaded, no extra IO) and, on the detail view only, the winning
  // direction (round label) from that run's research_journal. This turns an opaque
  // "seq N · ?m · att K · failed" row into "round23_bao_owner_split → 0.31 · 18m".
  const runById = new Map((runs ?? []).map((run) => [run.id, run] as const));
  const directionByRun = new Map<string, { label: string; result: number | null }>();
  if (detailed) {
    for (const runId of new Set(phaseEntries.map((entry) => entry.runId).filter((v): v is string => !!v))) {
      const best = bestRoundForRun(runId, runById.get(runId)?.metric ?? null);
      if (best) directionByRun.set(runId, best);
    }
  }
  const phases = phaseEntries.map((entry) => {
    const run = entry.runId ? runById.get(entry.runId) : undefined;
    const direction = entry.runId ? directionByRun.get(entry.runId) : undefined;
    const result = direction?.result ?? run?.metric ?? (typeof entry.score === 'number' ? entry.score : null);
    return {
      name: entry.phase ?? entry.nextPhase ?? `seq ${entry.seq}`,
      status: entry.phaseComplete ? STAGE_STATUS.COMPLETE : entry.status ?? entry.outcome,
      elapsed_min: parseDurationMin(run?.duration),
      attempt: entry.iteration,
      commit: undefined,
      commit_chain: [],
      notes: entry.reason || entry.artifactSummary || entry.outcome || null,
      direction: direction?.label ?? null,
      result,
      runId: entry.runId ?? null,
    };
  });
  // Stale-detect "running" outcome: if last iteration entry is >30min old,
  // the daemon likely exited without terminal status (framework bug).
  let rawStatus = entries.some((entry) => entry.pass)
    ? CAMPAIGN_PRESENTATION_STATUS.SHIPPED
    : runs.some((run) => run.outcome === RUN_STATUS.RUNNING)
      ? CAMPAIGN_PRESENTATION_STATUS.RUNNING
      : runs.some((run) => run.outcome === RUN_STATUS.PARKED)
        ? CAMPAIGN_PRESENTATION_STATUS.PARKED
        : latest?.status ?? CAMPAIGN_PRESENTATION_STATUS.IDLE;
  if (rawStatus === CAMPAIGN_PRESENTATION_STATUS.RUNNING) {
    const STALE_MS = 30 * 60 * 1000;
    const lastActivity = latest?.timestamp ? Date.parse(latest.timestamp) || 0 : 0;
    // Silence is not death — check the process before demoting. See
    // schedulerIsAliveForRun.
    const quietRunId = runs.find((run) => run.outcome === RUN_STATUS.RUNNING)?.id ?? latest?.runId;
    if (quietRunId && schedulerLoopIsStalled(projectDir, quietRunId)) {
      rawStatus = CAMPAIGN_PRESENTATION_STATUS.STALE;
    } else if (
      lastActivity > 0
      && Date.now() - lastActivity > STALE_MS
      && !(quietRunId && schedulerIsAliveForRun(projectDir, quietRunId))
    ) rawStatus = CAMPAIGN_PRESENTATION_STATUS.STALE;
  }
  const status = rawStatus;
  const staleRunId = status === CAMPAIGN_PRESENTATION_STATUS.STALE
    ? runs.find((run) => run.outcome === RUN_STATUS.RUNNING)?.id ?? latest?.runId
    : undefined;
  return {
    id,
    name: name ?? latest?.campaignName ?? id,
    status,
    badges: [
      { text: `${runSlice.total} runs`, kind: 'default' },
      status === CAMPAIGN_PRESENTATION_STATUS.SHIPPED ? { text: 'SHIPPED', kind: 'success' } : null,
    ].filter((badge): badge is { text: string; kind: string } => badge !== null),
    metric,
    iterations: iterations.length ? iterations : null,
    phases: phases.length ? phases : null,
    brief_revisions: null,
    runs,
    runs_total: runSlice.total,
    latest_outcome: latest?.outcome ?? null,
    latestOutcome: latest?.outcome ?? null,
    started_at: latest?.timestamp,
    projectDir: projectDir,
    briefDir: null,
    goal: null,
    budget: null,
    ...(staleRunId ? { staleRunId } : {}),
  };
}

function listWorkspaceCampaigns(projectDir: string): WorkspaceCampaign[] {
  const maxUpdatedAt = getMaxUpdatedAt(projectDir);
  if (
    _campaignListCache &&
    _campaignListCache.projectDir === projectDir &&
    Date.now() - _campaignListCache.timestamp < CAMPAIGN_LIST_CACHE_TTL_MS &&
    (maxUpdatedAt === null || maxUpdatedAt === _campaignListCache.maxUpdatedAt)
  ) {
    return _campaignListCache.data;
  }
  const data = computeWorkspaceCampaigns(projectDir);
  _campaignListCache = { projectDir, data, timestamp: Date.now(), maxUpdatedAt: maxUpdatedAt ?? 0 };
  return data;
}

function computeWorkspaceCampaigns(projectDir: string): WorkspaceCampaign[] {
  const campaigns = new Map<string, WorkspaceCampaign>();
  try {
    for (const id of readdirSync(campaignFsRoot())
      .filter((id) => isSafeId(id))
    ) {
      const dir = join(campaignFsRoot(), id);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const campaign = campaignSummary(id, dir);
        const runSlice = readCampaignRuns(projectDir, id);
        campaign.runs = runSlice.runs;
        campaign.runs_total = runSlice.total;
        campaign.badges[0] = { text: `${runSlice.total} runs`, kind: 'default' };
        campaigns.set(id, campaign);
      } catch { /* skip */ }
    }
  } catch { /* no campaign root */
    // Optional global campaign directory may not exist.
  }
  // Prefetch ALL history entries and campaign runs in a single pass each, keyed
  // by canonical storage key. Previously campaignFromHistory re-scanned every
  // history file (and the SQLite index) once PER campaign — O(campaigns × all
  // history), which made the list take ~70s at 500+ campaigns. Now it's O(all
  // history) once, with per-campaign lookups against the prefetched maps.
  const entriesByKey = readAllCampaignEntries(projectDir);
  const runsByKey = readAllCampaignRunsByKey(projectDir);
  for (const summary of listCampaigns(projectDir)) {
    if (campaigns.has(summary.id)) continue;
    const entries = entriesByKey.get(summary.storageKey) ?? [];
    const runs = runsByKey?.get(summary.storageKey) ?? readCampaignRuns(projectDir, summary.id);
    const campaign = campaignFromHistory(projectDir, summary.id, summary.name, entries, runs);
    if (campaign) campaigns.set(summary.id, campaign);
  }
  // Sidebar order: running campaigns first, then most-recently-started.
  return [...campaigns.values()].sort((a, b) => {
    const rank = (status: string) => status === CAMPAIGN_PRESENTATION_STATUS.RUNNING
      ? 0
      : status === CAMPAIGN_PRESENTATION_STATUS.PARKED ? 1 : 2;
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return (b.started_at ?? '').localeCompare(a.started_at ?? '');
  });
}

/**
 * Read the run index ONCE and group campaign-run summaries by canonical storage
 * key. Each group keeps its exact valid-run total while materializing only the
 * newest 12 summaries. Returns null when SQLite is unavailable so callers fall
 * back to the per-campaign scan.
 */
function readAllCampaignRunsByKey(projectDir: string): Map<string, CampaignRunSlice> | null {
  const records = readRunIndexRecords(projectDir);
  if (records === null) return null;
  const idsByKey = new Map<string, string[]>();
  for (const r of records) {
    if (!r.campaignStorageKey) continue;
    const list = idsByKey.get(r.campaignStorageKey);
    if (list) list.push(r.runId);
    else idsByKey.set(r.campaignStorageKey, [r.runId]);
  }
  const out = new Map<string, CampaignRunSlice>();
  for (const [key, runIds] of idsByKey) {
    runIds.sort((a, b) => b.localeCompare(a));
    const runs: CampaignRunSummary[] = [];
    let total = 0;
    for (const runId of runIds) {
      const state = readRunStateSafe(projectDir, runId);
      if (!state) continue;
      total++;
      if (runs.length < 12) runs.push(runSummaryFromState(state));
    }
    out.set(key, { runs, total });
  }
  return out;
}

function readBriefFileForCampaign(dir: string, version: string): string | null {
  if (!isSafeCampaignVersion(version)) return null;
  const state = readJsonFile(join(dir, 'state.json'));
  const briefDir = resolveBriefDir(state);
  if (!briefDir) return null;
  const filePath = join(briefDir, `${version}.md`);
  try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function unifiedDiff(fromName: string, fromText: string, toName: string, toText: string): string {
  const a = fromText.split('\n');
  const b = toText.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [`--- ${fromName}`, `+++ ${toName}`, '@@ -1 +1 @@'];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      lines.push(`+${b[j++]}`);
    } else if (i < a.length) {
      lines.push(`-${a[i++]}`);
    }
  }
  return lines.join('\n');
}

type DashboardTaskRegistrar = (task: TaskCreateInput) => Promise<RegisterRpcResponse>;
type DashboardTaskLister = (filter: TaskListFilter) => Promise<TaskShowEntry[]>;
type DashboardRunCanceller = (runId: string) => Promise<CancellationResult>;

async function registerTaskWithDaemon(task: TaskCreateInput): Promise<RegisterRpcResponse> {
  return sendRpc<RegisterRpcResponse>(defaultSocketPath(), { cmd: 'register', task, ...(task.run_id ? {} : { acknowledgement: 'persisted' as const }) });
}

async function listTasksFromDaemon(filter: TaskListFilter): Promise<TaskShowEntry[]> {
  const response = await sendRpc<TaskListRpcResponse>(defaultSocketPath(), { cmd: 'list', filter });
  return response.tasks;
}

export async function cancelRunWithControlPlane(
  runId: string,
  options: CancellationClientOptions = {},
): Promise<CancellationResult> {
  return cancelRunThroughControlPlane(runId, undefined, {
    socketPath: defaultSocketPath(),
    rpcTimeoutMs: 5_000,
    ...options,
  });
}

function projectAdmissionBlocker(
  targetProjectDir: string,
  selfRunId: string | undefined,
  probe: typeof isProjectBusy,
): string | null {
  // The daemon deliberately caches its directory walk within a sweep. A user
  // mutation is a launch boundary, so it must force a fresh observation.
  invalidateRunLockCache();
  if (selfRunId) {
    const liveOwner = findLiveRunOwnerForProject(targetProjectDir);
    if (liveOwner?.runId === selfRunId) return describeLiveRunOwner(liveOwner);
  }
  return probe(targetProjectDir, selfRunId);
}

function projectBusyMessage(blockingRunId: string): string {
  return `project busy (run ${blockingRunId}); waiting for that run to finish`;
}

export interface DashboardOptions {
  /** Control-plane seams keep tests away from the real daemon and run probe. */
  registerTask?: DashboardTaskRegistrar;
  listTasks?: DashboardTaskLister;
  cancelRun?: DashboardRunCanceller;
  isProjectBusy?: typeof isProjectBusy;
  /** Inbox read seams let source-failure tests stay isolated from real operator data. */
  inboxSources?: {
    listApprovals?: () => InboxItem[];
    listCampaigns?: (projectDir: string) => WorkspaceCampaign[];
    readPendingReviews?: (campaignId: string) => PendingReviewEntry[];
    listStale?: (campaigns: WorkspaceCampaign[]) => InboxStaleItem[];
  };
  /** Campaign-page read seams keep aggregation/source-isolation specs off live operator data. */
  campaignPageSources?: Partial<CampaignPageSources>;
  /** Runtime JavaScript directory; injectable so status tests never mutate real dist/. */
  distDir?: string;
}

const DASHBOARD_TIMEOUT_MIGRATION = 'Stage timeout overrides were removed; edit config/defaults.yaml::default_timeout_ms instead.';
const RemovedDashboardTimeoutSchema = z.unknown().refine(() => false, {
  message: DASHBOARD_TIMEOUT_MIGRATION,
});

const DashboardTaskCreateSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, 'name must not be blank').optional(),
  brief: z.string().refine((value) => value.trim().length > 0, 'brief must not be blank').optional(),
  // Compatibility with the old form contract while callers migrate to `brief`.
  planFile: z.string().refine((value) => value.trim().length > 0, 'planFile must not be blank').optional(),
  projectDir: z.string().trim().min(1).optional(),
  workflow: z.string().trim().min(1).optional(),
  supervise: z.boolean().optional(),
  maxIterations: z.number().int().min(1).optional(),
  maxIter: z.number().int().min(1).optional(),
  timeoutMs: RemovedDashboardTimeoutSchema.optional(),
  timeout_ms: RemovedDashboardTimeoutSchema.optional(),
  timeout_total_ms: RemovedDashboardTimeoutSchema.optional(),
  noCampaign: z.boolean().optional(),
  campaign: z.string().trim().min(1).optional(),
  campaignId: z.string().trim().min(1).optional(),
  campaignName: z.string().trim().min(1).optional(),
  briefPreflightDigest: z.string().optional(),
  briefPreflightReceipt: z.string().optional(),
  acknowledgeBriefWarnings: z.boolean().optional(),
}).refine((body) => Boolean(body.brief ?? body.planFile ?? body.name), {
  message: 'brief is required',
});

const InboxResolveBodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
  by: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
  always: z.never({ error: 'Standing approval rules were retired; approve this request once.' }).optional(),
  briefPreflightDigest: z.string().optional(),
  briefPreflightReceipt: z.string().optional(),
  acknowledgeBriefWarnings: z.boolean().optional(),
});

interface DashboardBriefAdmissionFields {
  briefPreflightDigest?: string;
  briefPreflightReceipt?: string;
  acknowledgeBriefWarnings?: boolean;
}

interface DashboardBriefAdmissionResult {
  ok: boolean;
  exactBrief: string;
  hasBriefSidecar?: boolean;
  report: BriefPreflightReport;
  receipt: string;
  error?: string;
  admission?: BriefAdmissionRecord;
}

function dashboardInboxItem(item: InboxItem) {
  const state = readRunStateSafe(item.projectDir, item.runId);
  return {
    ...item,
    runStanding: inspectApprovalRunStanding(item.projectDir, item.runId),
    ...(state?.campaignId || state?.campaignStorageKey
      ? { campaignId: state.campaignId ?? state.campaignStorageKey }
      : {}),
    ...(state?.campaignName ? { campaignName: state.campaignName } : {}),
  };
}

interface InboxSourceCoverage {
  succeeded: number;
  failed: number;
}

type InboxSource<T> =
  | { status: 'complete'; items: T[]; error?: never; coverage?: InboxSourceCoverage }
  | { status: 'partial'; items: T[]; error: string; coverage: InboxSourceCoverage }
  | { status: 'unavailable'; items: []; error: string; coverage?: InboxSourceCoverage };

interface DeferredInboxItem {
  id: number;
  name?: string;
  projectDir: string;
  runId: string | null;
  status: typeof TASK_STATUS.DEFERRED;
  deferReason: string;
  notBefore: string | null;
}

interface InboxStaleItem {
  id: string;
  name: string;
  status: typeof CAMPAIGN_PRESENTATION_STATUS.STALE;
  staleRunId?: string;
}

interface InboxPatchItem {
  index: number;
  ts: string;
  campaignId: string;
  campaignName: string;
  reason: string;
  severity?: PendingReviewEntry['severity'];
  patch: PendingReviewEntry['patch'];
  patchSummary: string;
  source?: string;
  briefVersion?: string;
  latestVersion?: string;
  runId?: string;
}

export interface InboxOverviewResponse {
  approvals: InboxSource<ReturnType<typeof dashboardInboxItem>>;
  deferred: InboxSource<DeferredInboxItem>;
  stale: InboxSource<InboxStaleItem>;
  patches: InboxSource<InboxPatchItem>;
  campaignCount: number | null;
}

function inboxError(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}

async function deferredInboxItems(lister: DashboardTaskLister): Promise<DeferredInboxItem[]> {
  const tasks = await lister({ status: TASK_STATUS.DEFERRED });
  return tasks
    .filter((task) => task.status === TASK_STATUS.DEFERRED)
    .map((task) => ({
      id: task.id,
      name: task.name,
      projectDir: task.projectDir,
      runId: task.run_id ?? null,
      status: TASK_STATUS.DEFERRED,
      deferReason: task.defer_reason ?? 'waiting for the next daemon retry window',
      notBefore: task.not_before ?? null,
    }));
}

function isApprovalDeferredMirror(
  deferred: DeferredInboxItem,
  approvals: ReturnType<typeof dashboardInboxItem>[],
): boolean {
  const match = /^awaiting human approval \(run ([^,()]+), request ([^)]+)\); resolve with:/.exec(deferred.deferReason);
  if (!match || !deferred.runId || deferred.runId !== match[1]) return false;
  return approvals.some((approval) => approval.runId === match[1] && approval.requestId === match[2]);
}

function defaultStaleItems(projectDir: string, campaigns: WorkspaceCampaign[]): InboxStaleItem[] {
  return campaigns
    .filter((campaign) => (
      campaign.status === CAMPAIGN_PRESENTATION_STATUS.STALE
      && typeof campaign.staleRunId === 'string'
      && campaign.staleRunId.length > 0
      && existsSync(join(runDir(projectDir, campaign.staleRunId), 'run.json'))
    ))
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: CAMPAIGN_PRESENTATION_STATUS.STALE,
      ...(campaign.staleRunId ? { staleRunId: campaign.staleRunId } : {}),
    }));
}

function patchItems(
  campaigns: WorkspaceCampaign[],
  reader: (campaignId: string) => PendingReviewEntry[],
): InboxSource<InboxPatchItem> {
  const items: InboxPatchItem[] = [];
  const failures: string[] = [];
  let succeeded = 0;
  for (const campaign of campaigns) {
    try {
      const latestVersion = campaign.brief_revisions?.at(-1)?.version;
      const campaignItems: InboxPatchItem[] = [];
      for (const [index, entry] of reader(campaign.id).entries()) {
        campaignItems.push({
          index,
          ts: entry.ts,
          campaignId: campaign.id,
          campaignName: campaign.name,
          reason: entry.reason,
          severity: entry.severity,
          patch: entry.patch,
          patchSummary: summarizePatch(entry.patch),
          source: entry.source,
          briefVersion: entry.briefVersion,
          latestVersion,
          runId: entry.runId,
        });
      }
      items.push(...campaignItems);
      succeeded += 1;
    } catch (error) {
      failures.push(`${campaign.id} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const coverage = { succeeded, failed: failures.length };
  if (!failures.length) return { status: 'complete', items, coverage };
  const sample = failures.slice(0, 3).join(', ');
  const remainder = failures.length > 3 ? `, and ${failures.length - 3} more` : '';
  const error = `could not read all brief patches: ${sample}${remainder}`;
  return succeeded > 0
    ? { status: 'partial', items, error, coverage }
    : { status: 'unavailable', items: [], error, coverage };
}

async function inboxOverview(
  projectDir: string,
  options: DashboardOptions,
): Promise<InboxOverviewResponse> {
  const listApprovals = options.inboxSources?.listApprovals
    ?? (() => listInboxItems({ state: INBOX_FILTER_STATE.PENDING }));
  const listDeferred = () => deferredInboxItems(options.listTasks ?? listTasksFromDaemon);
  const listCampaignData = options.inboxSources?.listCampaigns ?? listWorkspaceCampaigns;

  const [approvalResult, deferredResult, campaignResult] = await Promise.allSettled([
    Promise.resolve().then(() => listApprovals().map(dashboardInboxItem)),
    Promise.resolve().then(listDeferred),
    Promise.resolve().then(() => listCampaignData(projectDir)),
  ]);

  let deferredItems = deferredResult.status === 'fulfilled' ? deferredResult.value : [];
  if (approvalResult.status === 'fulfilled' && deferredResult.status === 'fulfilled') {
    deferredItems = deferredItems.filter((item) => !isApprovalDeferredMirror(item, approvalResult.value));
  }
  const approvals: InboxOverviewResponse['approvals'] = approvalResult.status === 'fulfilled'
    ? { status: 'complete', items: approvalResult.value }
    : { status: 'unavailable', items: [], error: inboxError('could not load approvals', approvalResult.reason) };
  const deferred: InboxOverviewResponse['deferred'] = deferredResult.status === 'fulfilled'
    ? { status: 'complete', items: deferredItems }
    : { status: 'unavailable', items: [], error: inboxError('could not load deferred tasks', deferredResult.reason) };

  if (campaignResult.status === 'rejected') {
    const error = inboxError('could not enumerate campaigns', campaignResult.reason);
    return {
      approvals,
      deferred,
      stale: { status: 'unavailable', items: [], error },
      patches: { status: 'unavailable', items: [], error },
      campaignCount: null,
    };
  }

  const campaigns = campaignResult.value;
  const staleBuilder = options.inboxSources?.listStale
    ?? ((items: WorkspaceCampaign[]) => defaultStaleItems(projectDir, items));
  const reviewReader = options.inboxSources?.readPendingReviews ?? readPendingReviews;
  const [staleResult, patchesResult] = await Promise.allSettled([
    Promise.resolve().then(() => staleBuilder(campaigns)),
    Promise.resolve().then(() => patchItems(campaigns, reviewReader)),
  ]);
  const stale: InboxOverviewResponse['stale'] = staleResult.status === 'fulfilled'
    ? { status: 'complete', items: staleResult.value }
    : { status: 'unavailable', items: [], error: inboxError('could not derive stale alerts', staleResult.reason) };
  const patches: InboxOverviewResponse['patches'] = patchesResult.status === 'fulfilled'
    ? patchesResult.value
    : { status: 'unavailable', items: [], error: inboxError('could not load brief patches', patchesResult.reason) };

  return { approvals, deferred, stale, patches, campaignCount: campaigns.length };
}

function parseStreamJsonToText(raw: string, state?: { lineBuf: string }): string {
  const buf = state || { lineBuf: '' };
  buf.lineBuf += raw;
  const lines = buf.lineBuf.split('\n');
  buf.lineBuf = lines.pop()!; // keep incomplete last line
  const output: string[] = [];
  for (const line of lines) {
    if (!line.trim()) { output.push('\n'); continue; }
    let handled = false;
    try {
      const parsed = JSON.parse(line);
      // Text content from assistant
      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'text' && block.text) output.push(block.text);
          if (block.type === 'tool_use') {
            const name = block.name || 'tool';
            const desc = block.input?.description || block.input?.command || block.input?.file_path || '';
            output.push(`\n[${name}] ${typeof desc === 'string' ? desc.slice(0, 100) : ''}\n`);
          }
        }
        handled = true;
      }
      // Tool results
      if (parsed.type === 'tool_result' || parsed.type === 'system') {
        if (parsed.subtype === 'task_started') {
          output.push(`\n[Agent] ${parsed.description || 'subtask started'}\n`);
        }
        handled = true;
      }
    } catch { /* not JSON */ }
    if (!handled) output.push(line + '\n');
  }
  return output.join('');
}

/** Private dashboards have loopback authority only. The operator's dashboard
 * also serves addresses on a named Tailscale interface, never a LAN/wildcard
 * listener. Interface names are essential: CGNAT address space alone does not
 * prove a route is Tailscale. No external command or new CLI setting is needed. */
export function dashboardListenHosts(input: {
  home?: string;
  store?: string;
  loginHome?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
} = {}): string[] {
  const hosts = ['127.0.0.1'];
  if (!isOperatorStateRoot(input.home ?? homedir(), input.store ?? fcGlobalDir(), input.loginHome ?? userInfo().homedir)) return hosts;
  for (const [name, addresses] of Object.entries(input.interfaces ?? networkInterfaces())) {
    if (!/^tailscale\d+$/.test(name)) continue;
    for (const entry of addresses ?? []) {
      const octets = entry.address.split('.').map(Number);
      const tailscaleV4 = entry.family === 'IPv4' && octets.length === 4
        && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
        && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
      const tailscaleV6 = entry.family === 'IPv6' && /^fd7a:115c:a1e0:/i.test(entry.address);
      if (!entry.internal && (tailscaleV4 || tailscaleV6)) hosts.push(entry.address);
    }
  }
  return [...new Set(hosts)];
}

export async function startDashboard(projectDir: string, port = 3000, options: DashboardOptions = {}) {
  const runtimeDistDir = resolve(options.distDir ?? join(import.meta.dirname ?? '.', '..', 'dist'));
  let loadedBuild: DaemonBuildFingerprint | null = null;
  let fingerprintError: string | undefined;
  try {
    loadedBuild = computeBuildFingerprint(runtimeDistDir);
  } catch (error) {
    fingerprintError = error instanceof Error ? error.message : String(error);
  }
  const startupIdentity: DashboardStartupIdentity = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    loadedBuild,
    fingerprintError,
  };
  const configDir = join(projectDir, 'config');
  const agentsDir = join(configDir, 'agents');

  // Migration: rename .omx to .fc if needed
  const oldDir = join(projectDir, '.omx');
  const newDir = join(projectDir, '.fc');
  if (existsSync(oldDir) && !existsSync(newDir)) {
    renameSync(oldDir, newDir);
  }

  // One Fastify router owns all listeners and hooks. Separate server instances
  // are necessary to bind explicit addresses without a wildcard socket.
  let createListener: () => Server;
  const extraListeners: Server[] = [];
  const app = Fastify({ logger: false, serverFactory: (handler, options) => {
    // A serverFactory bypasses Fastify's HTTP defaults; keep those settings on
    // every explicit listener rather than reverting to Node's different ones.
    createListener = () => {
      const server = createServer(options.http ?? {}, handler);
      if (typeof options.keepAliveTimeout === 'number') server.keepAliveTimeout = options.keepAliveTimeout;
      if (typeof options.requestTimeout === 'number') server.requestTimeout = options.requestTimeout;
      if (typeof options.connectionTimeout === 'number') server.setTimeout(options.connectionTimeout);
      if (typeof options.maxRequestsPerSocket === 'number' && options.maxRequestsPerSocket > 0) server.maxRequestsPerSocket = options.maxRequestsPerSocket;
      return server;
    };
    return createListener();
  } });
  app.addHook('onClose', async () => {
    await Promise.all(extraListeners.map((server) => new Promise<void>((resolveClose, rejectClose) => {
      if (!server.listening) { resolveClose(); return; }
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    })));
  });
  const briefReceiptSecret = randomBytes(32);
  const issueBriefReceipt = (report: BriefPreflightReport): string => createHmac('sha256', briefReceiptSecret)
    .update(`flowcrew-dashboard-brief-preflight:v${report.version}:${report.digest}`, 'utf8')
    .digest('hex');
  const receiptMatches = (report: BriefPreflightReport, candidate: string | undefined): boolean => {
    if (!candidate || !/^[0-9a-f]{64}$/i.test(candidate)) return false;
    const expected = Buffer.from(issueBriefReceipt(report), 'hex');
    const actual = Buffer.from(candidate, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const admitDashboardBrief = (
    exactBrief: string,
    fields: DashboardBriefAdmissionFields,
  ): DashboardBriefAdmissionResult => {
    const report = inspectBrief(exactBrief);
    const receipt = issueBriefReceipt(report);
    if (fields.briefPreflightDigest !== report.digest) {
      return {
        ok: false,
        exactBrief,
        report,
        receipt,
        error: fields.briefPreflightDigest
          ? 'The brief changed after preflight; review the current report before starting.'
          : 'Brief preflight is required before starting a run.',
      };
    }
    if (!receiptMatches(report, fields.briefPreflightReceipt)) {
      return { ok: false, exactBrief, report, receipt, error: 'The brief preflight receipt is missing, invalid, or from an earlier dashboard process.' };
    }
    if (report.requiresAcknowledgement && fields.acknowledgeBriefWarnings !== true) {
      return { ok: false, exactBrief, report, receipt, error: 'Review and acknowledge the reported warnings or contract problems before starting.' };
    }
    return {
      ok: true,
      exactBrief,
      report,
      receipt,
      admission: createBriefAdmission(
        report,
        report.requiresAcknowledgement
          ? { kind: 'explicit', source: 'dashboard_receipt', at: new Date().toISOString() }
          : { kind: 'not_required' },
      ),
    };
  };
  const effectiveRunBrief = (state: StoreState, runId: string): { exactBrief: string; hasBriefSidecar: boolean } => {
    const briefPath = join(runsRoot(), runId, 'task_brief.md');
    const hasBriefSidecar = existsSync(briefPath);
    return {
      exactBrief: hasBriefSidecar ? readFileSync(briefPath, 'utf-8') : state.taskDescription ?? '',
      hasBriefSidecar,
    };
  };
  const admitExistingRunBrief = (
    state: StoreState,
    runId: string,
    fields: DashboardBriefAdmissionFields,
  ): DashboardBriefAdmissionResult => {
    const { exactBrief, hasBriefSidecar } = effectiveRunBrief(state, runId);
    const stored = verifyBriefAdmission(exactBrief, state.briefAdmission);
    if (stored.status === 'valid' && state.briefAdmission) {
      return {
        ok: true,
        exactBrief,
        hasBriefSidecar,
        report: stored.report,
        receipt: issueBriefReceipt(stored.report),
        admission: state.briefAdmission,
      };
    }
    return { ...admitDashboardBrief(exactBrief, fields), hasBriefSidecar };
  };
  let cleanupComplete = false;
  let signalShutdownStarted = false;
  const shutdownFromSignal = () => {
    if (signalShutdownStarted) return;
    signalShutdownStarted = true;
    void app.close().then(
      () => process.exit(0),
      (error) => {
        log.error({ error }, 'Dashboard shutdown failed');
        process.exit(1);
      },
    );
  };
  const cleanup = () => {
    if (cleanupComplete) return;
    cleanupComplete = true;
    process.off('SIGTERM', shutdownFromSignal);
    process.off('SIGINT', shutdownFromSignal);
  };
  app.addHook('onClose', async () => {
    cleanup();
  });

  // CORS
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.raw.headersSent) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    return payload;
  });

  // Path traversal protection for mutation routes
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') return;
    const params = req.params as Record<string, string> | undefined;
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (typeof val === 'string' && !isSafeId(val)) {
          return reply.code(400).send({ error: `invalid ${key}` });
        }
      }
    }
  });
  app.options('/*', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    reply.code(204).send();
  });

  app.get('/api/dashboard/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readDashboardStatus(startupIdentity, runtimeDistDir);
  });

  app.post<{ Body: unknown }>('/api/brief-preflight', async (req, reply) => {
    const parsed = z.object({
      brief: z.string().refine((value) => value.trim().length > 0, 'brief must not be blank'),
    }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'brief is required' });
    }
    const report = inspectBrief(parsed.data.brief);
    return { report, receipt: issueBriefReceipt(report) };
  });

  // --- Static file serving ---
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist');
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', wildcard: true });
  }

  // SPA fallback: non-API, non-file-extension GET requests serve index.html
  app.setNotFoundHandler(async (req, reply) => {
    // Reject mutation requests to unknown paths (likely path traversal attempts)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      return reply.code(400).send({ error: 'invalid path' });
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      return reply.code(204).send();
    }
    if (!req.url.startsWith('/api/') && !extname(req.url.split('?')[0])) {
      const indexPath = join(uiDist, 'index.html');
      if (existsSync(indexPath)) {
        reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
        return;
      }
    }
    reply.code(404).send({ error: 'not found' });
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
    try {
      return stateToRunDetail(readRunState(projectDir, req.params.runId), projectDir);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.get("/api/inbox/overview", async () => inboxOverview(projectDir, options));

  app.post<{
    Params: { runId: string; requestId: string };
    Body: { decision?: unknown; by?: unknown; reason?: unknown; always?: unknown };
  }>("/api/inbox/:runId/:requestId/resolve", async (req, reply) => {
    const { runId, requestId } = req.params;
    if (!isSafeId(runId)) return reply.code(400).send({ ok: false, won: false, error: 'invalid runId' });
    if (!isValidApprovalRequestId(requestId)) {
      return reply.code(400).send({ ok: false, won: false, error: 'unsafe approval request id' });
    }
    const body = InboxResolveBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, won: false, error: body.error.issues[0]?.message ?? 'decision must be approve or deny' });
    }
    const existing = getInboxItem(runId, requestId);
    if (!existing || typeof existing.projectDir !== 'string' || !existing.projectDir) {
      return reply.code(404).send({ ok: false, won: false, error: `unknown request: ${requestId}` });
    }
    if (existing.resolution) {
      return {
        ok: true,
        won: false,
        item: dashboardInboxItem(existing),
        winner: {
          decision: existing.resolution.decision,
          by: existing.resolution.by,
          at: existing.resolution.at,
        },
      };
    }
    // Resolving a parked request normally resumes that same run (approve and
    // deny both need the agent to consume the decision). Admission therefore
    // precedes resolveRequest: a 409 must not secretly consume the request.
    const parkedState = readRunStateSafe(existing.projectDir, runId);
    let resumeTask: TaskCreateInput | undefined;
    if (parkedState && isPausedRunStatus(parkedState.status)) {
      const targetProjectDir = parkedState.projectDir || existing.projectDir;
      const blocker = projectAdmissionBlocker(
        targetProjectDir,
        runId,
        options.isProjectBusy ?? isProjectBusy,
      );
      if (blocker) {
        return reply.code(409).send({
          ok: false,
          won: false,
          error: projectBusyMessage(blocker),
        });
      }
      const briefAdmission = admitExistingRunBrief(parkedState, runId, body.data);
      if (!briefAdmission.ok || !briefAdmission.admission) {
        return reply.code(409).send({
          ok: false,
          won: false,
          error: briefAdmission.error,
          report: briefAdmission.report,
          receipt: briefAdmission.receipt,
        });
      }
      resumeTask = {
        kind: 'quick',
        run_id: runId,
        projectDir: targetProjectDir,
        brief_text: briefAdmission.exactBrief,
        brief_admission: briefAdmission.admission,
        launch_args: approvalResumeArgs(parkedState),
      };
    }

    const result = resolveRequest(existing.projectDir, runId, requestId, body.data.decision, {
      by: body.data.by,
      reason: body.data.reason,
    });
    const item = result.item ? dashboardInboxItem(result.item) : undefined;
    if (result.won || result.item?.resolution) invalidateTaskListCache();
    if (!result.won) {
      const resolution = result.item?.resolution;
      if (resolution) {
        return {
          ok: true,
          won: false,
          item,
          winner: {
            decision: resolution.decision,
            by: resolution.by,
            at: resolution.at,
          },
        };
      }
      return reply.code(400).send({
        ok: false,
        won: false,
        error: result.error ?? 'approval request was not resolved',
        ...(item ? { item } : {}),
      });
    }

    const resolution = result.item.resolution;
    if (!resolution) {
      return reply.code(500).send({ ok: false, won: true, error: 'winning resolution is missing' });
    }
    const runDir = join(runsRoot(), runId);
    const decisionPath = approvalArtifactPath(runDir, requestId, 'decision');
    mkdirSync(dirname(decisionPath), { recursive: true });
    writeFileSync(decisionPath, JSON.stringify({
      requestId,
      decision: resolution.decision,
      by: resolution.by,
      reason: resolution.reason ?? '',
      at: resolution.at,
    }, null, 2) + '\n', 'utf-8');

    let resumeRegistered = false;
    const runState = readRunStateSafe(existing.projectDir, runId);
    if (resumeTask && runState && isPausedRunStatus(runState.status)) {
      try {
        // Preserve the operator's reviewed admission on the bound run before
        // the daemon verifies its task/run agreement. The daemon owns launch.
        if (JSON.stringify(runState.briefAdmission) !== JSON.stringify(resumeTask.brief_admission)) {
          updateRunState(existing.projectDir, runId, current => { current.briefAdmission = resumeTask!.brief_admission; });
        }
        await (options.registerTask ?? registerTaskWithDaemon)(resumeTask);
        resumeRegistered = true;
      } catch (error) {
        const unknown = error instanceof RpcOutcomeUnknownError;
        return reply.code(unknown ? 502 : 503).send({
          ok: false, won: true, item, resumeRegistered: false,
          error: `Approval was recorded; resume ${unknown ? 'outcome is unknown' : 'registration failed'}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return { ok: true, won: true, item, resumeRegistered };
  });

  app.get<{ Params: { runId: string; stageId: string }; Querystring: { tailBytes?: string } }>(
    "/api/runs/:runId/stages/:stageId/output",
    async (req, reply) => {
      const p = join(runsRoot(), req.params.runId, 'stages', req.params.stageId, 'output.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      return sendStageOutput(reply, p, parseTailBytes(req.query.tailBytes));
    },
  );

  // 2. POST /api/tasks — the dashboard is an RPC client, not a second
  // orchestrator. Registration is the same control-plane path as
  // `flowcrew quick --background`, including run binding, defer, and retries.
  app.post<{ Body: unknown }>("/api/tasks", async (req, reply) => {
    const parsed = DashboardTaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const error = parsed.error.issues[0]?.message ?? 'invalid task request';
      return reply.code(400).send({ error });
    }
    const body = parsed.data;
    const brief = body.brief ?? body.planFile ?? body.name!;
    const admission = admitDashboardBrief(brief, body);
    if (!admission.ok || !admission.admission) {
      return reply.code(409).send({
        error: admission.error,
        report: admission.report,
        receipt: admission.receipt,
      });
    }
    const workflowName = body.workflow ?? 'default';
    if (!isSafeId(workflowName)) {
      return reply.code(400).send({ error: 'invalid workflow name' });
    }
    const targetProjectDir = body.projectDir ?? projectDir;
    const maxIterations = body.maxIterations ?? body.maxIter;
    const launchArgs: string[] = ['--workflow', workflowName];
    if (maxIterations !== undefined) launchArgs.push('--max-iterations', String(maxIterations));
    if (body.supervise === false) launchArgs.push('--no-supervise');

    const requestedCampaign = body.campaignId
      ?? (body.campaign !== 'standalone' && body.campaign !== 'new' ? body.campaign : undefined)
      ?? body.campaignName;
    if (body.noCampaign) launchArgs.push('--no-campaign');
    else if (requestedCampaign) launchArgs.push('--campaign', requestedCampaign);

    const task: TaskCreateInput = {
      kind: 'quick',
      name: (body.name ?? extractTaskTitle(brief)) || 'Quick task',
      brief_text: brief,
      brief_admission: admission.admission,
      projectDir: targetProjectDir,
      launch_args: launchArgs,
    };
    try {
      const registered = await (options.registerTask ?? registerTaskWithDaemon)(task);
      return reply.code(201).send({ id: registered.id, unit: registered.unit });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof RpcOutcomeUnknownError) {
        return reply.code(502).send({ error: `task registration outcome is unknown: ${detail}` });
      }
      return reply.code(503).send({ error: `task registration failed: ${detail}` });
    }
  });

  // POST /api/tasks/:id/cancel
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params;
    if (!isSafeId(id)) return reply.code(400).send({ error: 'invalid task id' });
    try { readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    let cancellation: CancellationResult;
    try {
      cancellation = await (options.cancelRun ?? cancelRunWithControlPlane)(id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return reply.code(503).send({ error: `could not request cancellation: ${detail}` });
    }
    invalidateTaskListCache();
    if (!cancellation.ok) {
      return reply.code(409).send({ error: cancellation.message, cancellation });
    }
    return cancellation;
  });

  app.post<{ Body: { campaignId: string; name: string } }>("/api/run-campaigns/rename", async (req, reply) => {
    const campaignId = req.body?.campaignId;
    const newName = req.body?.name;
    if (!campaignId || !newName) return reply.code(400).send({ error: 'campaignId and name are required' });
    const root = runsRoot();
    let updated = 0;
    try {
      for (const runId of readdirSync(root)) {
        const runJsonPath = join(root, runId, 'run.json');
        if (!existsSync(runJsonPath)) continue;
        try {
          const state = readRunState(projectDir, runId);
          if (state.campaignId === campaignId || state.campaignStorageKey === campaignId) {
            updateRunState(state.projectDir || projectDir, runId, current => { current.campaignName = newName; });
            updated++;
          }
        } catch { /* non-critical */ }
      }
    } catch { /* non-critical */ }
    invalidateTaskListCache();
    return { ok: true, updated, name: newName };
  });

  app.delete<{ Params: { id: string } }>("/api/run-campaigns/:id", async (req, reply) => {
    const campaignId = req.params.id;
    if (!isSafeId(campaignId)) return reply.code(404).send({ error: 'not found' });
    const historyPath = join(campaignFsRoot(), `${campaignId}.jsonl`);
    let removedHistory = false;
    try {
      if (existsSync(historyPath)) {
        unlinkSync(historyPath);
        removedHistory = true;
      }
    } catch {
      return reply.code(500).send({ error: 'failed to remove campaign history' });
    }

    let orphaned = 0;
    const root = runsRoot();
    try {
      for (const runId of readdirSync(root)) {
        const runJsonPath = join(root, runId, 'run.json');
        if (!existsSync(runJsonPath)) continue;
        try {
          const state = readRunState(projectDir, runId);
          if (!runMatchesCampaign(state, campaignId)) continue;
          updateRunState(state.projectDir || projectDir, runId, current => {
            current.campaignId = '';
            current.campaign_id = '';
            current.campaignStorageKey = '';
            current.campaignName = '';
          });
          orphaned++;
        } catch { /* non-critical */ }
      }
    } catch { /* no run root */ }
    invalidateTaskListCache();
    return { ok: true, orphaned, removedHistory };
  });

  const campaignPageSources: Partial<CampaignPageSources> = {
    readInbox: () => inboxOverview(projectDir, options),
    readTasks: () => (options.listTasks ?? listTasksFromDaemon)({}),
    hasLiveWorker: (runProjectDir, runId) => schedulerIsAliveForRun(runProjectDir, runId),
    ...options.campaignPageSources,
  };

  app.get('/api/campaigns/operator-index', async () => {
    return readCampaignOperatorIndex(projectDir, campaignPageSources);
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/operator-view', async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    try {
      return await readCampaignOperatorView(projectDir, req.params.id, campaignPageSources);
    } catch (error) {
      if (error instanceof CampaignNotFoundError) return reply.code(404).send({ error: 'not found' });
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/api/campaigns/:id/operator-runs', async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const cursor = req.query.cursor === undefined ? 0 : Number(req.query.cursor);
    const limit = req.query.limit === undefined ? 12 : Number(req.query.limit);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: 'cursor must be a non-negative integer and limit must be between 1 and 100' });
    }
    try {
      return await readCampaignRunPage(projectDir, req.params.id, cursor, limit, campaignPageSources);
    } catch (error) {
      if (error instanceof CampaignNotFoundError) return reply.code(404).send({ error: 'not found' });
      throw error;
    }
  });

  app.get<{ Params: { id: string; version: string } }>("/api/campaigns/:id/brief/:version", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const text = readBriefFileForCampaign(dir, req.params.version);
    if (text === null) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/markdown').send(text);
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/campaigns/:id/brief-diff", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to || !isSafeCampaignVersion(from) || !isSafeCampaignVersion(to)) {
      return reply.code(400).send({ error: 'from and to must be vN versions' });
    }
    const fromText = readBriefFileForCampaign(dir, from);
    const toText = readBriefFileForCampaign(dir, to);
    if (fromText === null || toText === null) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/plain').send(unifiedDiff(from, fromText, to, toText));
  });

  app.post<{ Params: { id: string; index: string }; Body: { decision?: string } }>("/api/campaigns/:id/review/:index", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) return reply.code(400).send({ error: 'index must be a non-negative integer' });
    const decision = req.body?.decision;
    if (decision !== 'accept' && decision !== 'reject') return reply.code(400).send({ error: 'decision must be accept or reject' });
    try {
      return await consumePendingReview(req.params.id, index, decision);
    } catch (err) {
      if (err instanceof ReviewConflictError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/standalone-runs", async (_req, reply) => {
    const result = readStandaloneRuns(projectDir);
    reply.header('X-Total-Count', String(result.total));
    return result.runs;
  });

  // ===================== Agent endpoints =====================

  // 8. GET /api/agents
  app.get("/api/agents", async () => {
    try {
      const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
      return files.map((f) => {
        try {
          const raw = readFileSync(join(agentsDir, f), 'utf-8');
          const parsed = parseYaml(raw) as Record<string, unknown>;
          return {
            name: parsed.name ?? f.replace('.yaml', ''),
            description: parsed.description ?? '',
            tools: Array.isArray(parsed.tools) ? parsed.tools : [],
            adapter: typeof parsed.adapter === 'string' ? parsed.adapter : undefined,
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  });



  // 7. GET /api/tasks/:id/stages/:stageId/live — SSE
  app.get<{ Params: { id: string; stageId: string } }>(
    "/api/tasks/:id/stages/:stageId/live",
    async (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Prefer live.log.txt (clean text extracted from stream-json) over raw live.log
      const txtPath = join(runsRoot(), req.params.id, 'stages', req.params.stageId, 'live.log.txt');
      const rawPath = join(runsRoot(), req.params.id, 'stages', req.params.stageId, 'live.log');
      let logPath = existsSync(txtPath) ? txtPath : rawPath;
      let byteOffset = 0;
      let stageFinished = false;
      const streamParseState = { lineBuf: '' };

      const send = () => {
        if (stageFinished) return;
        // Switch to .txt if it appears (Claude adapter creates it mid-execution)
        if (logPath === rawPath && existsSync(txtPath)) {
          logPath = txtPath;
          byteOffset = 0;
        }
        try {
          const stat = statSync(logPath);
          if (stat.size > byteOffset) {
            const len = stat.size - byteOffset;
            const buf = Buffer.alloc(len);
            const fd = openSync(logPath, 'r');
            try {
              readSync(fd, buf, 0, len, byteOffset);
            } finally {
              closeSync(fd);
            }
            byteOffset = stat.size;
            let newContent = buf.toString('utf-8');
            // If reading raw stream-json (live.log), parse it into readable text
            if (logPath === rawPath) {
              newContent = parseStreamJsonToText(newContent, streamParseState);
            }
            if (newContent) {
              // Normalize line endings for xterm (\n → \r\n)
              newContent = newContent.replace(/\r?\n/g, '\r\n');
              reply.raw.write(`data: ${JSON.stringify(newContent)}\n\n`);
            }
          }
        } catch { /* non-critical */
          // live.log doesn't exist yet — that's fine
        }
        // Stop polling once the stage is no longer running (use per-stage status.json — much smaller than run.json)
        try {
          const statusPath = join(runsRoot(), req.params.id, 'stages', req.params.stageId, 'status.json');
          const raw = readFileSync(statusPath, 'utf-8');
          const ss = JSON.parse(raw) as { status?: string };
          if (ss.status && !isRunningStageStatus(ss.status) && !isPendingStageStatus(ss.status)) {
            stageFinished = true;
            clearInterval(interval);
            // Close the SSE socket now that the stage is done, instead of leaking
            // an idle open connection until the client happens to disconnect.
            if (!reply.raw.writableEnded) reply.raw.end();
          }
        } catch { /* status.json doesn't exist yet — stage hasn't started */ }
      };

      send();
      // Fast polling (500ms) while stage is actively producing output,
      // slow down (2s) when idle to reduce CPU on long-running stages
      let idleTicks = 0;
      let currentInterval = 500;
      const adaptiveSend = () => {
        const prevOffset = byteOffset;
        send();
        if (byteOffset > prevOffset) {
          idleTicks = 0;
          if (currentInterval !== 500) {
            currentInterval = 500;
            clearInterval(interval);
            interval = setInterval(adaptiveSend, currentInterval);
          }
        } else {
          idleTicks++;
          if (idleTicks > 6 && currentInterval !== 2000) {
            currentInterval = 2000;
            clearInterval(interval);
            interval = setInterval(adaptiveSend, currentInterval);
          }
        }
      };
      let interval = setInterval(adaptiveSend, currentInterval);

      req.raw.on('close', () => {
        clearInterval(interval);
        if (!reply.raw.writableEnded) reply.raw.end();
      });
    },
  );

  // 12b. GET /api/tasks/:id/summary
  app.get<{ Params: { id: string } }>("/api/tasks/:id/summary", async (req, reply) => {
    const summaryPath = join(runsRoot(), req.params.id, 'summary.md');
    if (!existsSync(summaryPath)) {
      const progressPath = join(runsRoot(), req.params.id, 'progress.md');
      if (existsSync(progressPath)) return { content: readFileSync(progressPath, 'utf-8'), runId: req.params.id };
      return reply.code(404).send({ error: 'No summary available yet. Summary is generated after run completes.' });
    }
    return { content: readFileSync(summaryPath, 'utf-8'), runId: req.params.id };
  });

  // 13. GET /api/settings
  app.get("/api/settings", async () => {
    const defaultsPath = join(configDir, 'defaults.yaml');
    const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown> : {};
    const workflowsDir = join(configDir, 'workflows');
    const skillsDir = join(configDir, 'skills');
    const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yaml')) : [];
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.endsWith('.md')) : [];
    return { projectDir, adapter: defaults.adapter ?? 'auto', workflows, skills, port, ...defaults };
  });

  try {
    const [localHost, ...remoteHosts] = dashboardListenHosts();
    await app.listen({ port, host: localHost });
    const address = app.server.address();
    const sharedPort = typeof address === 'object' && address ? address.port : port;
    for (const host of remoteHosts) {
      const server = createListener!();
      for (const handler of app.server.listeners('clientError')) server.on('clientError', handler);
      extraListeners.push(server);
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(sharedPort, host, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    }
  } catch (err: unknown) {
    await app.close();
    cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE')) {
      console.error(`❌ Port ${port} is already in use. Either stop the other process or use a different port:`);
      console.error(`   PORT=${port + 1} flowcrew start`);
      process.exit(1);
    }
    throw err;
  }
  const address = app.server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;

  // Signals own the server lifecycle: close Fastify first (which runs cleanup),
  // then terminate with a truthful zero exit. Normal app.close() calls only
  // release resources and never exit an embedding process or test runner.
  process.on('SIGTERM', shutdownFromSignal);
  process.on('SIGINT', shutdownFromSignal);
  // Publish readiness only after the handlers are installed. Callers commonly
  // send a signal as soon as they observe this line; logging first leaves a
  // stdout-flush race in which the process receives the default signal action.
  console.log(`Dashboard running at http://localhost:${listeningPort}/`);

  return app;
}
