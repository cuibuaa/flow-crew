import { normalizeNativeEvent } from './adapters/native-events.js';
import { stageLiveLogPath } from './stage-live-log.js';
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { unlinkSync, openSync, closeSync } from './engine-fs.js';
import { readFileSync, readdirSync, existsSync, statSync, readSync } from 'node:fs';
import { join,extname,resolve } from "node:path";
import { createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import { createServer, type Server } from 'node:http';
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { parse as parseYaml } from "yaml";
import {
campaignsRoot,extractTaskTitle,
isPausedRunStatus, isResumableRunStatus,isRunningStageStatus,isPendingStageStatus,
listRuns,
readRunState,readStageStatus,resolveRunStatus,updateRunState,
runDir,
RUN_STATUS,
runsRoot,
fcGlobalDir,
} from "./store.js";
import type { StoreState } from "./store.js";
import { budgetView, projectRunStageHistory } from './run-state-view.js';
import { countStandaloneRunsFromIndex,readRunIndexRecordsByCampaign,readRunIndexRecords,listStandaloneRunIdsFromIndex,getMaxUpdatedAt } from './run-index.js';
import {
listCampaigns,readCampaignEntries,resolveCampaignStorageKey,
readAllCampaignEntries
} from "./campaigns.js";
import type { CampaignHistoryEntry } from "./campaigns.js";
import { engineConfigDir, loadEngineDefaults } from './config.js';
import { readActiveSchedulerLoopStall } from './scheduler-heartbeat.js';
import {
describeLiveRunOwner,
findLiveRunOwnerForProject,
invalidateRunLockCache,
inspectRunScheduler,
isProjectBusy,
} from "./run-lock.js";
import {
commandSocketPath,
RpcRemoteError,
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
import { readOperatorEvents,readOperationalProjection,type EventLike } from './cli-events.js';
import { approvalResumeLaunch,isValidApprovalRequestId } from './approval-artifacts.js';
import {
getItem as getInboxItem,
INBOX_FILTER_STATE,
listAll as listInboxItems,
resolveRequest,type InboxItem
} from './inbox.js';
import { inspectApprovalRunStanding } from './run-standing.js';
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
}

function dashboardRunPresentation(status: unknown): DashboardRunPresentation {
  const resolution = resolveRunStatus(status);
  if (resolution.kind === 'known') return {
    campaignOutcome: resolution.status === RUN_STATUS.COMPLETE ? RUN_STATUS.SHIPPED : resolution.status,
  };
  const unrecognized = `unrecognized ${resolution.display}`;
  return { campaignOutcome: unrecognized };
}
// --- Shared helpers ---

const _stageRolesCache = new Map<string, { mtime: number; roles: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> }>();
const DEFAULT_STAGE_OUTPUT_TAIL_BYTES = 200 * 1024; // 5s TTL

function invalidateTaskListCache(): void {
  _campaignListCache = null;
}

// --- Performance: campaign list cache ---
// Inbox attention reads campaign state/history and run liveness. Cache these
// facts briefly per project and invalidate them when a run/task changes.
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

/** Only the facts consumed by inbox attention. Campaign presentation belongs to campaign-page. */
interface WorkspaceCampaign {
  id: string;
  name: string;
  status: string;
  started_at?: string;
  staleRunId?: string;
}

function isSafeId(id: string): boolean {
  return !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

function campaignFsRoot(): string {
  return campaignsRoot();
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
    return inspectRunScheduler(runId, runDir(projectDir, runId)).kind === 'live';
  } catch {
    return false;
  }
}

export function schedulerLoopIsStalled(projectDir: string, runId: string): boolean {
  if (!projectDir || !runId) return false;
  try { return readActiveSchedulerLoopStall(runDir(projectDir, runId)) !== undefined; }
  catch { return false; }
}

function runMatchesCampaign(state: StoreState, id: string): boolean {
  const key = resolveCampaignStorageKey({ campaignId: id, projectDir: state.projectDir });
  return [state.campaignId, state.campaignStorageKey, state.campaignName].some(value =>
    typeof value === 'string' && (value === id
      || key !== undefined && resolveCampaignStorageKey({ campaignId: value, projectDir: state.projectDir }) === key));
}

/** Operator publications must not replace records owned by a live scheduler. */
function assertRunEditable(runId: string): void {
  const scheduler = inspectRunScheduler(runId, join(runsRoot(), runId));
  if (scheduler.kind === 'live' || scheduler.kind === 'corrupt' || scheduler.kind === 'unverifiable') {
    throw new Error(`Cannot edit run ${runId} with ${scheduler.kind} scheduler ownership`);
  }
}

function editableCampaignRuns(projectDir: string, campaignId: string): { runId: string; state: StoreState }[] {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const runs: { runId: string; state: StoreState }[] = [];
  for (const runId of readdirSync(root)) {
    const state = readRunStateSafe(projectDir, runId);
    if (!state || !runMatchesCampaign(state, campaignId)) continue;
    assertRunEditable(runId);
    runs.push({ runId, state });
  }
  return runs;
}

function summarizeRunOutcome(status?: string): string {
  return status === undefined ? 'unknown' : dashboardRunPresentation(status).campaignOutcome;
}

/** True when the run has a generated summary.md the dashboard can display. */
function runHasSummary(runId: string): boolean {
  return existsSync(join(runsRoot(), runId, 'summary.md'));
}

function runSummaryFromState(state: StoreState): CampaignRunSummary {
  return { id: state.runId, outcome: summarizeRunOutcome(state.status) };
}

type CampaignRunSummary = { id: string; outcome: string };
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
    return readdirSync(dir).filter((name) => name !== 'output.md' && name !== 'status.json').length;
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
  const runDirectory = join(runsRoot(), state.runId);
  const stageHistoryDiagnostics: Array<{ code: string; path?: string; detail: string }> = [];
  const stageHistory = projectRunStageHistory(state, diagnostic => stageHistoryDiagnostics.push(diagnostic));
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
    stages,
    stageEvidence: state.stageEvidence ?? [],
    stageHistory,
    stageHistoryDiagnostics,
    budget: budgetView(state, new Date().toISOString()),
    events: readRunEvents(state.runId),
    operational: readOperationalProjection(runDirectory, { state }),
    stage_outputs: readStageOutputPreviews(state.runId),
  };
}

function campaignFromHistory(
  projectDir: string,
  id: string,
  name?: string,
  prefetchedEntries?: CampaignHistoryEntry[],
  prefetchedRuns?: CampaignRunSlice,
): WorkspaceCampaign | null {
  const entries = prefetchedEntries ?? readCampaignEntries(projectDir, id);
  const runSlice = prefetchedRuns ?? readCampaignRuns(projectDir, id);
  const runs = runSlice.runs;
  if (!entries.length && runSlice.total === 0) return null;
  const latest = entries.at(-1);
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
    started_at: latest?.timestamp,
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

function rpcHttpStatus(error: unknown): number {
  return error instanceof RpcRemoteError ? (error.code.endsWith('_NOT_FOUND') ? 404 : 409) : 503;
}

type DashboardTaskRegistrar = (task: TaskCreateInput) => Promise<RegisterRpcResponse>;
type DashboardTaskLister = (filter: TaskListFilter) => Promise<TaskShowEntry[]>;
type DashboardRunCanceller = (runId: string) => Promise<CancellationResult>;

async function registerTaskWithDaemon(task: TaskCreateInput): Promise<RegisterRpcResponse> {
  return sendRpc<RegisterRpcResponse>(commandSocketPath(), { cmd: 'register', task, ...(task.run_id ? {} : { acknowledgement: 'persisted' as const }) });
}

async function listTasksFromDaemon(filter: TaskListFilter): Promise<TaskShowEntry[]> {
  const response = await sendRpc<TaskListRpcResponse>(commandSocketPath(), { cmd: 'list', filter });
  return response.tasks;
}

export async function cancelRunWithControlPlane(
  runId: string,
  options: CancellationClientOptions = {},
): Promise<CancellationResult> {
  return cancelRunThroughControlPlane(runId, undefined, {
    socketPath: commandSocketPath(),
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
    listStale?: (campaigns: WorkspaceCampaign[]) => InboxStaleItem[];
  };
  /** Campaign-page read seams keep aggregation/source-isolation specs off live operator data. */
  campaignPageSources?: Partial<CampaignPageSources>;
  /** Runtime JavaScript directory; injectable so status tests never mutate real dist/. */
  distDir?: string;
}

const DashboardTaskCreateSchema = z.object({
  brief: z.string().refine((value) => value.trim().length > 0, 'brief must not be blank'),
  projectDir: z.string().trim().min(1).optional(),
  workflow: z.string().trim().min(1).optional(),
  maxIterations: z.number().int().min(1).optional(),
  noCampaign: z.boolean().optional(),
  campaign: z.string().trim().min(1).optional(),
  campaignId: z.string().trim().min(1).optional(),
  campaignName: z.string().trim().min(1).optional(),
  briefPreflightDigest: z.string().optional(),
  briefPreflightReceipt: z.string().optional(),
});

const InboxResolveBodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
  by: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
  always: z.never({ error: 'Standing approval rules were retired; approve this request once.' }).optional(),
  briefPreflightDigest: z.string().optional(),
  briefPreflightReceipt: z.string().optional(),
});

interface DashboardBriefAdmissionFields {
  briefPreflightDigest?: string;
  briefPreflightReceipt?: string;
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

interface InboxOverviewResponse {
  approvals: InboxSource<ReturnType<typeof dashboardInboxItem>>;
  deferred: InboxSource<DeferredInboxItem>;
  stale: InboxSource<InboxStaleItem>;
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
      campaignCount: null,
    };
  }

  const campaigns = campaignResult.value;
  const staleBuilder = options.inboxSources?.listStale
    ?? ((items: WorkspaceCampaign[]) => defaultStaleItems(projectDir, items));
  const [staleResult] = await Promise.allSettled([
    Promise.resolve().then(() => staleBuilder(campaigns)),
  ]);
  const stale: InboxOverviewResponse['stale'] = staleResult.status === 'fulfilled'
    ? { status: 'complete', items: staleResult.value }
    : { status: 'unavailable', items: [], error: inboxError('could not derive stale alerts', staleResult.reason) };
  return { approvals, deferred, stale, campaignCount: campaigns.length };
}

export function parseStreamJsonToText(raw: string, state?: { lineBuf: string; lastMessage?: string }, final = false): string {
  const buf = state || { lineBuf: '' };
  buf.lineBuf += raw;
  const lines = buf.lineBuf.split('\n');
  buf.lineBuf = lines.pop()!; // keep incomplete last line
  if (final && buf.lineBuf) { lines.push(buf.lineBuf); buf.lineBuf = ''; }
  const output: string[] = [];
  for (const line of lines) {
    if (!line.trim()) { output.push('\n'); continue; }
    let handled = false;
    try {
      const parsed = JSON.parse(line);
      // These native message envelopes were previously rendered from a second
      // text carrier. Keep other CLI streams on their existing passthrough path.
      if (['assistant', 'result', 'content_block_delta', 'stream_event'].includes(parsed.type)) {
        const event = normalizeNativeEvent(parsed);
        handled = true;
        if (event.delta) output.push(event.delta);
        if (event.message) {
          if (event.message !== buf.lastMessage) output.push(event.message);
          buf.lastMessage = event.message;
        }
        if (event.diagnostic) output.push(`\n${event.diagnostic}\n`);
      }
      if (parsed.type === 'user') handled = true;
      // Text content from assistant
      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
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
  if (!isOperatorStateRoot(input.home ?? homedir(), input.store ?? fcGlobalDir(), input.loginHome)) return hosts;
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
  const configDir = engineConfigDir;
  const agentsDir = join(configDir, 'agents');

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
    return {
      ok: true,
      exactBrief,
      report,
      receipt,
      admission: createBriefAdmission(
        report,
        { kind: 'explicit', source: 'dashboard_receipt', at: new Date().toISOString() },
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
      const report = inspectBrief(exactBrief);
      return {
        ok: true,
        exactBrief,
        hasBriefSidecar,
        report,
        receipt: issueBriefReceipt(report),
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
        launch_options: approvalResumeLaunch(parkedState),
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
    let resumeRegistered = false;
    const runState = readRunStateSafe(existing.projectDir, runId);
    if (resumeTask && runState && isPausedRunStatus(runState.status)) {
      try {
        // Preserve the operator's reviewed admission on the bound run before
        // the daemon verifies its task/run agreement. The daemon owns launch.
        if (JSON.stringify(runState.briefAdmission) !== JSON.stringify(resumeTask.brief_admission)) {
          updateRunState(existing.projectDir, runId, current => {
            assertRunEditable(runId);
            current.briefAdmission = resumeTask!.brief_admission;
          });
        }
        await (options.registerTask ?? registerTaskWithDaemon)(resumeTask);
        resumeRegistered = true;
      } catch (error) {
        const unknown = error instanceof RpcOutcomeUnknownError;
        return reply.code(rpcHttpStatus(error)).send({
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
    const brief = body.brief;
    const admission = admitDashboardBrief(brief, body);
    if (!admission.ok || !admission.admission) {
      return reply.code(409).send({
        error: admission.error,
        report: admission.report,
        receipt: admission.receipt,
      });
    }
    const workflowName = body.workflow;
    if (workflowName && !isSafeId(workflowName)) {
      return reply.code(400).send({ error: 'invalid workflow name' });
    }
    const targetProjectDir = body.projectDir ?? projectDir;

    const requestedCampaign = body.campaignId
      ?? (body.campaign !== 'standalone' && body.campaign !== 'new' ? body.campaign : undefined)
      ?? body.campaignName;

    const task: TaskCreateInput = {
      kind: 'quick',
      name: extractTaskTitle(brief) || 'Quick task',
      brief_text: brief,
      brief_admission: admission.admission,
      projectDir: targetProjectDir,
      launch_options: {
        workflow: workflowName,
        maxIterations: body.maxIterations,
        ...(body.noCampaign ? { noCampaign: true } : requestedCampaign ? { campaign: requestedCampaign } : {}),
      },
    };
    try {
      const registered = await (options.registerTask ?? registerTaskWithDaemon)(task);
      return reply.code(201).send({ id: registered.id, unit: registered.unit });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(rpcHttpStatus(err)).send({
        error: `task registration ${err instanceof RpcOutcomeUnknownError ? 'outcome is unknown' : 'failed'}: ${detail}`,
      });
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
      return reply.code(rpcHttpStatus(error)).send({ error: `could not request cancellation: ${detail}` });
    }
    invalidateTaskListCache();
    if (!cancellation.ok) {
      return reply.code(cancellation.status === 'outcome-unknown' ? 503 : 409).send({ error: cancellation.message, cancellation });
    }
    return cancellation;
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (req, reply) => {
    const { id } = req.params;
    if (!isSafeId(id)) return reply.code(400).send({ error: 'invalid task id' });
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!isResumableRunStatus(state.status) || isPausedRunStatus(state.status)) {
      return reply.code(409).send({ error: 'only cancelled, failed or incomplete runs can be resumed' });
    }
    try {
      const tasks = await (options.listTasks ?? listTasksFromDaemon)({ status: 'all' });
      if (!tasks.some(task => task.run_id === id && resolve(task.projectDir) === resolve(state.projectDir))) {
        return reply.code(409).send({ error: 'run has no registered task to resume' });
      }
      const resumed = await (options.registerTask ?? registerTaskWithDaemon)({ kind: 'quick', run_id: id, projectDir: state.projectDir });
      invalidateTaskListCache();
      return { new_attempt: resumed.new_attempt, unit: resumed.unit };
    } catch (error) {
      return reply.code(rpcHttpStatus(error)).send({ error: `could not request resume: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  app.post<{ Body: { campaignId: string; name: string } }>("/api/run-campaigns/rename", async (req, reply) => {
    const campaignId = req.body?.campaignId;
    const newName = req.body?.name;
    if (!campaignId || !newName) return reply.code(400).send({ error: 'campaignId and name are required' });
    let runs: { runId: string; state: StoreState }[];
    try { runs = editableCampaignRuns(projectDir, campaignId); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    let updated = 0;
    try {
      for (const { runId, state } of runs) {
        updateRunState(state.projectDir || projectDir, runId, current => {
          assertRunEditable(runId);
          current.campaignName = newName;
        });
        updated++;
      }
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    invalidateTaskListCache();
    return { ok: true, updated, name: newName };
  });

  app.delete<{ Params: { id: string } }>("/api/run-campaigns/:id", async (req, reply) => {
    const campaignId = req.params.id;
    if (!isSafeId(campaignId)) return reply.code(404).send({ error: 'not found' });
    let runs: { runId: string; state: StoreState }[];
    try { runs = editableCampaignRuns(projectDir, campaignId); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    let orphaned = 0;
    try {
      for (const { runId, state } of runs) {
        updateRunState(state.projectDir || projectDir, runId, current => {
          assertRunEditable(runId);
          current.campaignId = '';
          current.campaign_id = '';
          current.campaignStorageKey = '';
          current.campaignName = '';
        });
        orphaned++;
      }
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
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

      const runDirectory = join(runsRoot(), req.params.id);
      let logPath = '';
      let byteOffset = 0;
      let stageFinished = false;
      const streamParseState: { lineBuf: string; lastMessage?: string } = { lineBuf: '' };

      const send = () => {
        if (stageFinished) return;
        try {
          const currentLogPath = stageLiveLogPath(runDirectory, req.params.stageId);
          const stat = statSync(currentLogPath);
          if (currentLogPath !== logPath || stat.size < byteOffset) {
            logPath = currentLogPath;
            byteOffset = 0;
            streamParseState.lineBuf = '';
            delete streamParseState.lastMessage;
          }
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
            newContent = parseStreamJsonToText(newContent, streamParseState);
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
            const trailing = parseStreamJsonToText('', streamParseState, true);
            if (trailing) reply.raw.write(`data: ${JSON.stringify(trailing.replace(/\r?\n/g, '\r\n'))}\n\n`);
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
      return reply.code(404).send({ error: 'No summary available yet. Summary is generated after run completes.' });
    }
    return { content: readFileSync(summaryPath, 'utf-8'), runId: req.params.id };
  });

  // 13. GET /api/settings
  app.get("/api/settings", async () => {
    const defaults = loadEngineDefaults();
    const workflowsDir = join(configDir, 'workflows');
    const skillsDir = join(projectDir, 'config', 'skills');
    const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yaml')) : [];
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.endsWith('.md')) : [];
    return { projectDir, workflows, skills, port, ...defaults };
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
