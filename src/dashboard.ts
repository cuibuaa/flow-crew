import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, unlinkSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  campaignsRoot,
  createRun,
  extractTaskTitle,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isPendingRunStatus,
  isPendingStageStatus,
  isRunMutationBlockedStatus,
  isRunningRunStatus,
  isRunningStageStatus,
  isTerminalRunStatus,
  listRuns,
  readRunState,
  readStageInput,
  readStageStatus,
  rependStageStatus,
  resolveRunStatus,
  runDir,
  RUN_STATUS,
  runsRoot,
  STAGE_STATUS,
  writeRunState,
} from "./store.js";
import type { RunStatus, StageAttempt, StoreState, SupervisorAttempt } from "./store.js";
import { countStandaloneRunsFromIndex, deleteRunIndex, readRunIndexRecordsByCampaign, readRunIndexRecords, listStandaloneRunIdsFromIndex, listRunningRunIdsFromIndex, getMaxUpdatedAt } from './run-index.js';
import {
  listCampaigns,
  nextCampaignSeq,
  readCampaignEntries,
  readAllCampaignEntries,
  resolveCampaignSelection,
} from "./campaigns.js";
import type { CampaignHistoryEntry } from "./campaigns.js";
import { loadWorkflow, runWorkflow, WorkflowConfigSchema, findDownstream, StageConfigSchema } from "./scheduler.js";
import type { StageConfig } from "./scheduler.js";
import { loadProjectDefaults as loadCanonicalProjectDefaults } from './config.js';
import type { AgentConfig, Adapter } from "./adapters/base.js";
import { loadAdapterByName } from './adapters/loader.js';
import { resolveAdapterChoice } from './adapters/availability.js';
import { readAttemptSummaryRefreshState } from "./run-events.js";
import {
  claimLaunchIntent,
  describeLiveRunOwner,
  findLiveRunOwnerForProject,
  invalidateRunLockCache,
  isLiveFlowcrewSchedulerForRun,
  isProjectBusy,
  parseSchedulerPidMarker,
  releaseLaunchIntent,
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
import { readKG, readKGSafe, addNode, updateNode, removeNode, addEdge, summarizeKG } from './knowledge-graph.js';
import { readTraceEvents, readAllTraceEvents, summarizeTrace } from './trace.js';
import { appendPendingReview, consumePendingReview, readPendingReviews, ReviewConflictError, summarizePatch } from './campaign-review.js';
import type { PendingReviewEntry } from './campaign-review.js';
import { readOperatorEvents, readOperationalProjection, type EventLike } from './cli-events.js';
import { getEdges as getCrossCampaignEdges, getNodes as getCrossCampaignNodes } from './cross-campaign-kg.js';
import { approvalArtifactPath, isValidApprovalRequestId } from './approval-artifacts.js';
import {
  getItem as getInboxItem,
  INBOX_FILTER_STATE,
  listAll as listInboxItems,
  resolveRequest,
  standingRuleEligible,
  type InboxFilterState,
  type InboxItem,
} from './inbox.js';
import { readJsonlFile as readTolerantJsonlFile } from './jsonl.js';
import { z } from "zod";
import pino from "pino";
import type { KGNodeType, KGEdgeType } from './knowledge-graph.js';
import { computeBuildFingerprint, type DaemonBuildFingerprint } from './daemon-identity.js';
import {
  CampaignNotFoundError,
  deriveRunTokenCost,
  readCampaignOperatorIndex,
  readCampaignOperatorView,
  readCampaignRunPage,
  type CampaignPageSources,
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
const INBOX_FILTER_STATES = new Set<string>(Object.values(INBOX_FILTER_STATE));
const COMPLETE_METRIC_NAME_FRAGMENT = 'complete';

// --- Dynamic adapter loading ---
async function resolveAdapter(configDir: string): Promise<Adapter> {
  const defaultsPath = join(configDir, "defaults.yaml");
  const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, "utf-8")) as Record<string, unknown> : {};
  const configured = typeof defaults.adapter === 'string' && defaults.adapter.trim()
    ? defaults.adapter.trim()
    : 'auto';
  if (configured === 'mock') return loadAdapterByName('mock');

  const resolution = resolveAdapterChoice({ configured });
  if (!resolution.ok) throw new Error(resolution.hint);
  if (configured !== 'auto' && configured !== resolution.adapter) {
    log.warn({ configured, selected: resolution.adapter }, resolution.reason);
  }
  return loadAdapterByName(resolution.adapter);
}

// --- Project defaults for agent config fallback ---
function loadAgentDefaults(configDir: string): { model: string; reasoning_effort: string } {
  try {
    const raw = readFileSync(join(configDir, 'defaults.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return {
      model: typeof parsed.model === 'string' ? parsed.model : 'default',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'default',
    };
  } catch { return { model: 'default', reasoning_effort: 'default' }; }
}

const DashboardAgentSchema = z.object({ name: z.string(), description: z.string().default(''), model: z.string().default('default'), reasoning_effort: z.string().default('default'), tools: z.array(z.string()).default([]), prompt: z.string(), adapter: z.string().optional(), handoff_visibility: z.enum(['full', 'minimal', 'none']).optional() });

function parseAgentConfig(raw: unknown, configDir?: string): AgentConfig {
  const defaults = loadAgentDefaults(configDir ?? join(process.cwd(), 'config'));
  const agent = DashboardAgentSchema.parse(raw);
  if (agent.model === 'default') agent.model = defaults.model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = defaults.reasoning_effort;
  return agent;
}

// --- Shared helpers ---

const _stageRolesCache = new Map<string, { mtime: number; roles: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> }>();
const DEFAULT_STAGE_OUTPUT_TAIL_BYTES = 200 * 1024;

// --- Performance: task list cache (P0) ---
let _taskListCache: { data: unknown[]; timestamp: number; runsDir: string; dirMtime: number; projectDir: string; maxUpdatedAt: number } | null = null;
const TASK_LIST_CACHE_TTL_MS = 5_000; // 5s TTL

function invalidateTaskListCache(): void {
  _taskListCache = null;
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

function isTaskListCacheValid(runsDir: string): boolean {
  if (!_taskListCache || _taskListCache.runsDir !== runsDir) return false;
  if ((Date.now() - _taskListCache.timestamp) >= TASK_LIST_CACHE_TTL_MS) return false;
  // Also check if any run.json was modified since cache was built. On drvfs the
  // subdir-file change may not bump the runs/ dir mtime and other processes don't
  // call our invalidator, so ALSO compare the index's MAX(updated_at) — any
  // upsert by any process busts the cache.
  try {
    const dirMtime = statSync(runsDir).mtimeMs;
    if (dirMtime !== _taskListCache.dirMtime) return false;
  } catch { /* non-critical */ return false; }
  const maxUpdatedAt = getMaxUpdatedAt(_taskListCache.projectDir);
  if (maxUpdatedAt !== null && maxUpdatedAt !== _taskListCache.maxUpdatedAt) return false;
  return true;
}

// --- Performance: SSE mtime tracking (P0) ---
const _sseRunMtimes = new Map<string, number>();

function parseTailBytes(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return DEFAULT_STAGE_OUTPUT_TAIL_BYTES;
  if (value === 'full' || value === '0') return undefined;
  const n = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STAGE_OUTPUT_TAIL_BYTES;
  return Math.min(Math.floor(n), 5 * 1024 * 1024);
}

// Parse Claude stream-json into human-readable output for live display.
// Falls through to raw text for non-JSON lines (codex stdout) or JSON lines
// that don't match a known Claude stream-json type — so any adapter's
// live.log is renderable without a per-adapter parser.
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

export interface DirectRunnerLivenessOptions {
  procRoot?: string;
  killProcess?: (pid: number, signal: 0) => void;
}

export function hasLiveDirectRunner(
  projectDir: string,
  runId: string,
  options: DirectRunnerLivenessOptions = {},
): boolean {
  const procRoot = options.procRoot ?? '/proc';
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  for (const prefix of ['direct-resume', 'direct-rerun']) {
    try {
      const pidPath = join(projectDir, '.fc', `${prefix}-${runId}.pid`);
      if (!existsSync(pidPath)) continue;
      const rawPid = readFileSync(pidPath, 'utf-8').trim();
      if (!/^\d+$/.test(rawPid)) continue;
      const pid = Number(rawPid);
      // PID 0 targets the caller's process group on POSIX and is never a
      // process identity. Reject it before the signal-0 liveness probe.
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        killProcess(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue;
      }

      // Signal 0 is the portable liveness proof. On Linux, readable procfs
      // metadata additionally rejects a recycled pid; missing or inaccessible
      // procfs must not turn a proven-live process into a dead one on macOS or
      // in a Linux container without procfs.
      if (process.platform !== 'linux') return true;
      const cmdlinePath = join(procRoot, rawPid, 'cmdline');
      const environPath = join(procRoot, rawPid, 'environ');
      if (!existsSync(cmdlinePath) || !existsSync(environPath)) return true;
      try {
        const cmdline = readFileSync(cmdlinePath, 'utf-8');
        const environ = readFileSync(environPath, 'utf-8');
        if (cmdline.includes('.fc/direct-') && environ.split('\0').includes(`RUN_ID=${runId}`)) {
          return true;
        }
      } catch {
        return true;
      }
    } catch { /* non-critical */
      // A malformed marker is not liveness evidence; inaccessible procfs is
      // handled above only after signal 0 has established that the pid exists.
    }
  }
  return false;
}

/**
 * Checks whether the scheduler subprocess for a run is still alive by validating
 * the scheduler.pid file written by runWorkflow. Survives dashboard restarts so
 * the startup-recovery sweep doesn't mislabel live runs as failed.
 */
export function hasLiveScheduler(_projectDir: string, runId: string): boolean {
  try {
    const pidPath = join(runsRoot(), runId, 'scheduler.pid');
    if (!existsSync(pidPath)) return false;
    const pid = readFileSync(pidPath, 'utf-8').trim();
    if (!/^\d+$/.test(pid)) return false;
    // Signal 0 is the portable liveness probe and is what run-lock.ts:189 and
    // task-registry.ts already use. Reading /proc/<pid> here meant that on any
    // platform without procfs this returned false for a provably live scheduler,
    // and performStartupRecovery then rewrote the healthy run to `failed`.
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user — still alive.
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  } catch { /* non-critical */
    return false;
  }
}

function markDetachedRunFailed(projectDir: string, runId: string, reason: string): void {
  try {
    const state = readRunState(projectDir, runId);
    if (!isRunningRunStatus(state.status)) return;
    state.status = RUN_STATUS.FAILED;
    state.failureReason = reason;
    state.completedAt = new Date().toISOString();
    for (const [, stage] of Object.entries(state.stages)) {
      if (isRunningStageStatus(stage.status)) stage.status = STAGE_STATUS.FAILED;
    }
    writeRunState(projectDir, runId, state);
  } catch (err) {
    log.warn({ err, runId, reason }, 'Could not mark detached scheduler run failed');
  }
}

/**
 * Spawn a fully-detached `flowcrew quick --existing-run-id <id>` child process
 * for a dashboard-initiated execute/rerun/approve. The scheduler then lives
 * outside the daemon's process, so daemon restarts no longer kill in-flight
 * runs. The child writes scheduler.pid, captures its own logs, and `unref()`
 * lets the daemon exit independently if needed.
 */
interface DetachedRunOptions {
  runId: string;
  projectDir: string;
  exactBrief: string;
  briefAdmission: BriefAdmissionRecord;
  campaignId?: string | undefined;
  supervise?: boolean | undefined;
  workflow?: string | undefined;
  maxIterations?: number | undefined;
  adapter?: string | undefined;
}

type DetachedRunStarter = () => void;
type DetachedRunSpawner = (opts: DetachedRunOptions) => DetachedRunStarter | void;

function spawnDetachedRun(opts: DetachedRunOptions): DetachedRunStarter {
  const verification = verifyBriefAdmission(opts.exactBrief, opts.briefAdmission);
  if (verification.status !== 'valid') {
    throw new Error(
      `Brief admission ${verification.status}; detached run ${opts.runId} was not spawned `
      + `(current digest ${verification.report.digest.slice(0, 12)}).`,
    );
  }
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const encodedAdmission = Buffer.from(JSON.stringify(opts.briefAdmission), 'utf8').toString('base64url');
  const args: string[] = [
    'quick',
    '--task', opts.exactBrief,
    '--brief-admission-record', encodedAdmission,
    '--existing-run-id', opts.runId,
    '--project', opts.projectDir,
  ];
  if (opts.workflow) args.push('--workflow', opts.workflow);
  if (typeof opts.maxIterations === 'number') args.push('--max-iterations', String(opts.maxIterations));
  if (opts.adapter) args.push('--adapter', opts.adapter);
  if (opts.supervise === false) args.push('--no-supervise');
  if (opts.campaignId) args.push('--campaign', opts.campaignId);
  return () => {
    const claim = claimLaunchIntent(opts.projectDir, opts.runId);
    if (!claim.claimed) {
      throw new Error(`Project launch already in progress (${claim.blockingOwnerRunId ?? 'unknown'})`);
    }
    const logDir = join(opts.projectDir, '.fc', 'logs');
    try { mkdirSync(logDir, { recursive: true }); } catch { /* non-critical */ }
    const logPath = join(logDir, `run-${opts.runId}.log`);
    let logFd = -1;
    try {
      logFd = openSync(logPath, 'a');
    } catch {
      logFd = -1;
    }
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        detached: true,
        stdio: ['ignore', logFd >= 0 ? logFd : 'ignore', logFd >= 0 ? logFd : 'ignore'],
        cwd: opts.projectDir,
        env: { ...process.env },
      });
    } catch (err) {
      releaseLaunchIntent(opts.projectDir, opts.runId);
      if (logFd >= 0) try { closeSync(logFd); } catch { /* ignore */ }
      const reason = `Detached scheduler failed to spawn: ${err instanceof Error ? err.message : String(err)}`;
      markDetachedRunFailed(opts.projectDir, opts.runId, reason);
      throw err;
    }
    if (logFd >= 0) try { closeSync(logFd); } catch { /* ignore */ }
    child.once('error', (err) => {
      releaseLaunchIntent(opts.projectDir, opts.runId);
      markDetachedRunFailed(opts.projectDir, opts.runId, `Detached scheduler failed: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      if ((code ?? 0) !== 0 || signal) {
        markDetachedRunFailed(opts.projectDir, opts.runId, `Detached scheduler exited early: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      }
    });
    const watchdog = setTimeout(() => {
      if (!hasLiveScheduler(opts.projectDir, opts.runId)) {
        markDetachedRunFailed(opts.projectDir, opts.runId, 'Detached scheduler did not start within 10s');
      }
    }, 10_000);
    watchdog.unref?.();
    child.unref();
    log.info({ runId: opts.runId, pid: child.pid, logPath }, 'Spawned detached scheduler');
  };
}

function listRecentRunIdsForStartup(projectDir: string, limit = 50): string[] {
  try {
    const root = runsRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
      .sort()
      .slice(-limit);
  } catch { /* non-critical */
    return [];
  }
}

export function performStartupRecovery(projectDir: string, limit = 50): void {
  try {
    // Prefer the index: it lets us reconcile EVERY orphaned 'running' run cheaply,
    // not just the most-recent `limit`. Fall back to the recent-N fs scan only when
    // the index is unavailable. This is also safe to call periodically (not just at
    // startup) so a run whose scheduler died mid-flight self-heals without a restart.
    const runningIds = listRunningRunIdsFromIndex(projectDir);
    const runIds = runningIds ?? (Number.isFinite(limit) && limit > 0 ? listRecentRunIdsForStartup(projectDir, limit) : []);
    for (const id of runIds) {
      try {
        const state = readRunState(projectDir, id);
        if (isRunningRunStatus(state.status)) {
          if (hasLiveDirectRunner(projectDir, id)) continue;
          if (hasLiveScheduler(projectDir, id)) continue;
          state.status = RUN_STATUS.FAILED;
          state.failureReason = 'Scheduler process gone while task was running (orphan reconciled)';
          state.completedAt = new Date().toISOString();
          for (const [, s] of Object.entries(state.stages)) {
            if (isRunningStageStatus(s.status)) s.status = STAGE_STATUS.FAILED;
          }
          writeRunState(projectDir, id, state);
        }
      } catch { /* skip unreadable runs (e.g. dir deleted) */ }
    }
  } catch { /* no runs dir */ }
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

interface RunApiShape {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; reruns?: number; attempts?: StageAttempt[] | SupervisorAttempt[]; dependsOn: string[] }[];
  stageEvidence?: StoreState['stageEvidence'];
}

function stateToApi(state: StoreState, projectDir: string): RunApiShape {
  const roles = loadStageRoles(projectDir, state.runId);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    startedAt: state.startedAt,
    ...(state.stageEvidence ? { stageEvidence: state.stageEvidence } : {}),
    stages: [
      ...Object.entries(state.stages).map(([id, s]) => ({
      id,
      role: roles[id]?.role ?? "",
      status: s.status,
      duration_ms: s.duration_ms,
      retries: s.retries,
      reruns: s.reruns,
      attempts: s.attempts,
      dependsOn: roles[id]?.dependsOn ?? [],
      })),
      ...(state.supervisor ? [{
        id: '_supervisor', role: 'supervisor', status: state.supervisor.status,
        duration_ms: state.supervisor.duration_ms, retries: 0,
        reruns: Math.max(0, state.supervisor.calls - 1), attempts: state.supervisor.attempts,
        dependsOn: [],
      }] : []),
    ],
  };
}

interface TaskShape {
  id: string;
  name: string;
  type: string;
  workflow: string;
  status: string;
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; reruns?: number; attempts?: StageAttempt[] | SupervisorAttempt[]; artifacts?: string[]; dependsOn: string[]; dispatched: boolean; startedAt?: string; completedAt?: string; isGate?: boolean; tokens_in?: number; tokens_out?: number; error?: string; kgChanged?: boolean; calls?: number }[];
  startedAt: string;
  elapsed_ms: number;
  tokens: number;
  bestScore?: number;
  metricName?: string;
  plan: unknown[];
  dispatchedStages?: unknown[];
  currentIteration: number;
  maxIterations: number;
  maxRetries: number;
  autoApproveRetries: boolean;
  timeoutMs?: number;
  campaignTriggers?: StoreState['campaignTriggers'];
  iterationLog: string | null;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
  failureReason?: string;
  completedAt?: string;
  campaignAlert?: StoreState['campaignAlert'];
  researchInjection?: StoreState['researchInjection'];
  parentTaskId?: string;
  budget?: StoreState['budget'];
  attemptSummaryRefresh?: ReturnType<typeof readAttemptSummaryRefreshState>;
  supervisor?: StoreState['supervisor'];
  stageEvidence?: StoreState['stageEvidence'];
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

function normalizeCampaignTriggers(value: unknown): StoreState['campaignTriggers'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const triggers: StoreState['campaignTriggers'] = {};
  if (typeof input.enabled === 'boolean') triggers.enabled = input.enabled;
  for (const key of ['regressionAfter', 'plateauAfter', 'plateauThreshold', 'repeatedFailureAfter'] as const) {
    if (input[key] === undefined) continue;
    const parsed = Number(input[key]);
    if (Number.isFinite(parsed) && parsed >= 0) triggers[key] = parsed;
  }
  return triggers;
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


function stateToTask(state: StoreState, projectDir: string, configDir?: string, opts?: { includeIterationLog?: boolean }): TaskShape {
  const defaults = readExecutionDefaults(configDir);
  const runPresentation = dashboardRunPresentation(state.status);
  // Fast path: use stored campaign fields directly to avoid O(n) listCampaigns scan per task
  const campaign = state.campaignStorageKey
    ? { id: state.campaignId ?? state.campaignStorageKey, name: extractTaskTitle(state.campaignName) || state.campaignId || state.campaignStorageKey, storageKey: state.campaignStorageKey }
    : state.campaignId || state.campaignName
      ? resolveCampaignSelection(projectDir, { campaignId: state.campaignId, campaignStorageKey: state.campaignStorageKey, campaignName: state.campaignName })
      : undefined;
  const roles = loadStageRoles(projectDir, state.runId);
  const dsArr = Array.isArray(state.dispatchedStages) ? (state.dispatchedStages as { id?: string; is_gate?: boolean }[]).filter(Boolean) : [];
  const dispatchedIds = new Set(
    dsArr.map((s) => s.id).filter(Boolean),
  );
  const dispatchedGates = new Map(dsArr.filter(s => s.id).map(s => [s.id!, s.is_gate]));
  const stages: TaskShape['stages'] = Object.entries(state.stages).map(([id, s]) => ({
    id,
    role: roles[id]?.role ?? "",
    status: s.status,
    duration_ms: s.duration_ms,
    retries: s.retries,
    reruns: s.reruns,
    attempts: s.attempts,
    artifacts: s.artifacts ?? [],
    dependsOn: roles[id]?.dependsOn ?? [],
    dispatched: dispatchedIds.has(id),
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    isGate: dispatchedGates.get(id) ?? roles[id]?.isGate,
    tokens_in: s.tokens_in,
    tokens_out: s.tokens_out,
    error: s.error,
    kgChanged: s.kgChanged,
  }));
  if (state.supervisor) {
    stages.push({
      id: '_supervisor',
      role: 'supervisor',
      status: state.supervisor.status,
      duration_ms: state.supervisor.duration_ms,
      retries: 0,
      reruns: Math.max(0, state.supervisor.calls - 1),
      attempts: state.supervisor.attempts,
      artifacts: [],
      dependsOn: [],
      dispatched: false,
      startedAt: state.supervisor.startedAt,
      completedAt: state.supervisor.completedAt,
      tokens_in: state.supervisor.tokens_in,
      tokens_out: state.supervisor.tokens_out,
      calls: state.supervisor.calls,
    });
  }
  // A parked run is waiting on a human: freeze its clock at the park instant so a
  // day-long approval wait does not render as a 24-hour hang.
  const parkedElapsed = isPausedRunStatus(state.status) && state.startedAt && state.parked?.pausedAt
    ? Math.max(0, Date.parse(state.parked.pausedAt) - Date.parse(state.startedAt)) || 0
    : undefined;
  const elapsed_ms = parkedElapsed !== undefined ? parkedElapsed
    : isRunningRunStatus(state.status) || isAwaitingApprovalRunStatus(state.status)
    ? Math.max(0, Date.now() - Date.parse(state.startedAt)) || 0
    : state.completedAt
      ? Math.max(0, Date.parse(state.completedAt) - Date.parse(state.startedAt)) || 0
      : stages.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  const totalTokens = deriveRunTokenCost(state).tokens;
  const { bestScore, metricName } = readBestScore(projectDir, state.runId);
  const task: TaskShape = {
    id: state.runId,
    name: extractTaskTitle(state.taskDescription) || state.workflowName,
    type: '',
    workflow: state.workflowName,
    status: runPresentation.taskStatus,
    stages,
    startedAt: state.startedAt,
    elapsed_ms,
    tokens: totalTokens,
    bestScore,
    metricName,
    plan: state.plan ?? [],
    currentIteration: state.currentIteration ?? 1,
    maxIterations: state.maxIterations ?? defaults.maxIterations,
    maxRetries: state.maxRetries ?? defaults.gateRetryLoops,
    autoApproveRetries: state.autoApproveRetries ?? true,
    timeoutMs: state.timeoutMs ?? defaults.timeoutMs,
    campaignTriggers: state.campaignTriggers,
    iterationLog: null,
    campaignId: campaign?.id,
    campaignStorageKey: campaign?.storageKey,
    campaignName: campaign?.name,
    campaignSeq: state.campaignSeq,
    campaignIteration: state.campaignIteration ?? state.currentIteration,
    failureReason: state.failureReason,
    completedAt: state.completedAt,
    campaignAlert: state.campaignAlert,
    researchInjection: state.researchInjection,
    parentTaskId: state.parentTaskId,
    budget: state.budget,
    attemptSummaryRefresh: readAttemptSummaryRefreshState(projectDir, state.runId),
    supervisor: state.supervisor,
    ...(state.stageEvidence ? { stageEvidence: state.stageEvidence } : {}),
  };
  if (state.dispatchedStages) task.dispatchedStages = state.dispatchedStages;
  if (opts?.includeIterationLog) {
    const logPath = join(runsRoot(), state.runId, 'iteration_log.md');
    try { task.iterationLog = readFileSync(logPath, 'utf-8'); } catch { /* not found */ }
  }
  return task;
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

function readJsonlFile(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return readTolerantJsonlFile<unknown>(filePath);
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

interface KgRawNode { id?: string; type?: string; label?: string; text?: string; details?: string; source?: string; score?: number }
interface KgRawEdge { from?: string; to?: string; source?: string; target?: string; type?: string }

/**
 * Campaign-level knowledge graph: the union of the campaign's per-run KGs. Per-run KGs are rich
 * but isolated (and shown on the run detail page); this synthesizes them so the campaign panel is
 * not empty. Nodes are deduped by (type + substance) so the shared goal and repeated findings
 * collapse, namespaced by run so ids never collide across runs, and capped newest-run-first so the
 * mini graph stays legible. Each node is tagged with the campaign id to satisfy the panel's filter.
 */
function aggregateCampaignKG(projectDir: string, id: string): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const runIds = readCampaignRuns(projectDir, id).runs.map((run) => run.id).filter((value): value is string => !!value);
  const ordered = [...new Set(runIds)].sort().reverse(); // newest run first → it wins the node budget
  // The consumer is the campaign knowledge digest (ranked text lists), not a force graph, so the
  // legibility cap can be high: include every run's learnings, just bound payload for huge campaigns.
  const NODE_CAP = 500;
  const canonicalByKey = new Map<string, string>(); // (type+substance) → the node id that represents it
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const seenEdge = new Set<string>();
  for (const runId of ordered) {
    let graph: { nodes?: KgRawNode[]; edges?: KgRawEdge[] };
    try {
      const path = join(runsRoot(), runId, 'knowledge_graph.json');
      if (!existsSync(path)) continue;
      graph = JSON.parse(readFileSync(path, 'utf-8')) as { nodes?: KgRawNode[]; edges?: KgRawEdge[] };
    } catch {
      continue;
    }
    const localToCanon = new Map<string, string>(); // this run's local id → the canonical id in `nodes`
    for (const node of graph.nodes ?? []) {
      const localId = String(node.id ?? '');
      if (!localId) continue;
      const nsId = `${runId}::${localId}`;
      const substance = String(node.text ?? node.label ?? '').trim().toLowerCase();
      const key = `${String(node.type)}::${substance}`;
      if (substance && canonicalByKey.has(key)) { localToCanon.set(localId, canonicalByKey.get(key)!); continue; }
      if (nodes.length >= NODE_CAP) continue; // over budget: drop (its edges get pruned below)
      if (substance) canonicalByKey.set(key, nsId);
      localToCanon.set(localId, nsId);
      nodes.push({ id: nsId, type: node.type, label: node.label, text: node.text, details: node.details, source: node.source, score: node.score, runId, meta: runId.slice(0, 16), campaign: id });
    }
    for (const edge of graph.edges ?? []) {
      const source = localToCanon.get(String(edge.from ?? edge.source ?? ''));
      const target = localToCanon.get(String(edge.to ?? edge.target ?? ''));
      if (!source || !target || source === target) continue;
      const edgeKey = `${source}->${target}::${String(edge.type ?? '')}`;
      if (seenEdge.has(edgeKey)) continue;
      seenEdge.add(edgeKey);
      edges.push({ id: edgeKey, source, target, kind: edge.type });
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  return { nodes, edges: edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
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
 * Deliberately NOT hasLiveScheduler(), and the two must not be merged: they
 * fail safe in opposite directions because they guard opposite actions.
 * hasLiveScheduler decides whether performStartupRecovery may rewrite a run to
 * `failed` — destroying state — so it must over-report liveness; tightening it
 * once already caused healthy runs to be marked failed (see the note at its
 * definition). This one only decides whether to suppress a warning, where
 * over-reporting liveness hides a genuinely lost run, so it must under-report.
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

function adaptCrossCampaignNode(node: ReturnType<typeof getCrossCampaignNodes>[number]) {
  const metadata = node.metadata ?? {};
  const type = node.type;
  const countsTotal = metadata.counts && typeof metadata.counts === 'object'
    ? Object.values(metadata.counts).reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
    : undefined;
  const label = type === 'symptom'
    ? (countsTotal !== undefined ? `x${countsTotal}` : stringValue(metadata.kind) ?? 'symptom')
    : type === 'diagnosis'
      ? (stringValue(metadata.rule_signal)?.split('.').at(-1)?.slice(0, 12) ?? 'diagnosis')
      : type === 'patch'
        ? `${metadata.brief_version_before ?? '?'}->${metadata.brief_version_after ?? '?'}`
        : stringValue(metadata.kind)?.slice(0, 10) ?? type;
  return {
    id: node.id,
    type,
    label,
    meta: JSON.stringify(metadata).slice(0, 120),
    campaign: node.campaignId,
    campaignId: node.campaignId,
    metadata,
  };
}

function adaptCrossCampaignEdge(edge: ReturnType<typeof getCrossCampaignEdges>[number]) {
  const relToKind: Record<string, string> = {
    caused_by: 'causal',
    fixed_by: 'causal',
    resulted_in: 'causal',
    related_to: 'similarity',
  };
  return {
    source: edge.from,
    target: edge.to,
    from: edge.from,
    to: edge.to,
    kind: relToKind[edge.relation] ?? 'causal',
    relation: edge.relation,
    weight: edge.weight,
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
    const STALE_MS = 30 * 60 * 1000;
    let lastMtime = 0;
    try { lastMtime = Math.max(lastMtime, statSync(join(dir, 'state.json')).mtimeMs); } catch { /* ignore */ }
    try { lastMtime = Math.max(lastMtime, statSync(join(dir, 'iteration_log.jsonl')).mtimeMs); } catch { /* ignore */ }
    if (lastMtime > 0 && Date.now() - lastMtime > STALE_MS) {
      const projectDir = getStringAt(state, ['projectDir']) ?? '';
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
    if (
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

function getWorkspaceCampaign(projectDir: string, id: string): WorkspaceCampaign | null {
  const dir = campaignDirOr404(id);
  if (dir) {
    const campaign = campaignSummary(id, dir);
    const runSlice = readCampaignRuns(projectDir, id);
    campaign.runs = runSlice.runs;
    campaign.runs_total = runSlice.total;
    campaign.badges[0] = { text: `${runSlice.total} runs`, kind: 'default' };
    if (campaign.status === CAMPAIGN_PRESENTATION_STATUS.STALE && !campaign.staleRunId) {
      campaign.staleRunId = runSlice.runs.find((run) => run.outcome === RUN_STATUS.RUNNING)?.id;
    }
    return campaign;
  }
  return campaignFromHistory(projectDir, id, undefined, undefined, undefined, true);
}

function listM3Campaigns(projectDir?: string) {
  return projectDir ? listWorkspaceCampaigns(projectDir) : [];
}

function countBy(items: string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return Array.from(counts, ([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 10);
}

function crossCampaignSummary() {
  const nodes = getCrossCampaignNodes();
  const edges = getCrossCampaignEdges();
  const symptomLabels = nodes
    .filter((node) => node.type === 'symptom')
    .map((node) => {
      const topCount = node.metadata?.counts && typeof node.metadata.counts === 'object'
        ? Object.entries(node.metadata.counts as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
          .sort((a, b) => b[1] - a[1])[0]?.[0]
        : undefined;
      return [node.metadata?.kind, topCount].filter(Boolean).join(':') || 'unknown';
    });
  const patchLabels = nodes
    .filter((node) => node.type === 'patch')
    .map((node) => [node.metadata?.section, node.metadata?.op].filter(Boolean).join(':') || 'unknown');
  return {
    total_nodes: nodes.length,
    total_edges: edges.length,
    top_symptoms: countBy(symptomLabels),
    top_patches: countBy(patchLabels),
  };
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
  return sendRpc<RegisterRpcResponse>(defaultSocketPath(), { cmd: 'register', task });
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
  adapter?: Adapter;
  agentConfig?: AgentConfig;
  skillContent?: string;
  onPlanPollingStart?: (taskId: string) => void;
  /** Launch seams cover every dashboard path that can start existing-run work. */
  spawnDetachedRun?: DetachedRunSpawner;
  runWorkflow?: typeof runWorkflow;
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

function containsRemovedStageTimeout(input: unknown): boolean {
  if (Array.isArray(input)) return input.some(containsRemovedStageTimeout);
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  if (Object.hasOwn(record, 'timeoutMs') || Object.hasOwn(record, 'timeout_ms') || Object.hasOwn(record, 'timeout_total_ms')) return true;
  return Object.values(record).some(containsRemovedStageTimeout);
}

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
  always: z.boolean().optional(),
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
    standingRuleEligible: standingRuleEligible(item),
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

  // Track tasks with active runWorkflow background loops so we can detect
  // orphaned awaiting_approval tasks after a server restart.
  const activeExecutions = new Set<string>();

  // Startup recovery: mark stale running tasks as failed
  // Tasks awaiting_approval are preserved — they're waiting for user input, not actively running
  performStartupRecovery(projectDir, Number(process.env.FLOWCREW_STARTUP_RECOVERY_LIMIT ?? 50));

  // Runtime stale task recovery: periodically check active executions for tasks stuck in "running"
  // with no run.json updates for longer than the configured timeout + buffer.
  // Only checks tasks tracked in activeExecutions — startup recovery already handles server restarts.
  const staleCheckMs = 60_000; // check every 60s
  const staleTimer = setInterval(() => {
    for (const id of activeExecutions) {
      try {
        const runJsonPath = join(runsRoot(), id, 'run.json');
        const mtime = statSync(runJsonPath).mtimeMs;
        const age = Date.now() - mtime;
        if (age < 5 * 60_000) continue;
        const state = readRunState(projectDir, id);
        if (!isRunningRunStatus(state.status)) continue;
        const taskTimeout = state.timeoutMs ?? readExecutionDefaults(configDir).timeoutMs;
        const staleThreshold = taskTimeout + 5 * 60_000;
        if (age < staleThreshold) continue;
        // Staleness is not stop authority. A live scheduler may be in a long
        // adapter call; only reconcile after both known runner probes are dead.
        if (hasLiveDirectRunner(projectDir, id) || hasLiveScheduler(projectDir, id)) continue;
        state.status = RUN_STATUS.FAILED;
        state.failureReason = `Task appears stale (no progress for ${Math.round(staleThreshold / 60_000)}+ minutes). It may have crashed.`;
        state.completedAt = new Date().toISOString();
        for (const [, s] of Object.entries(state.stages)) {
          if (isRunningStageStatus(s.status)) s.status = STAGE_STATUS.FAILED;
        }
        writeRunState(projectDir, id, state);
        activeExecutions.delete(id);
      } catch { /* skip */ }
    }
  }, staleCheckMs);

  // Orphan reconciliation: the staleTimer above only covers runs THIS process
  // launched (activeExecutions). Runs launched by other processes (e.g. the
  // daemons) whose scheduler died leave run.json='running' forever and were only
  // healed at dashboard startup. Periodically reconcile ALL 'running' runs via the
  // index + pid-liveness so cross-process orphans self-heal without a restart.
  const orphanReconcileTimer = setInterval(() => {
    try { performStartupRecovery(projectDir, Number(process.env.FLOWCREW_STARTUP_RECOVERY_LIMIT ?? 50)); } catch { /* non-critical */ }
  }, 5 * 60_000);

  const app = Fastify({ logger: false });
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
  type DetachedRunPreparation =
    | { ok: true; launch?: DetachedRunStarter }
    | { ok: false; conflict: DashboardBriefAdmissionResult };
  const prepareDetachedRun = (opts: DetachedRunOptions): DetachedRunPreparation => {
    try {
      const launch = (options.spawnDetachedRun ?? spawnDetachedRun)(opts);
      return launch ? { ok: true, launch } : { ok: true };
    } catch (error) {
      // A test seam or future preparer can expose a last-moment sidecar edit.
      // Re-report that exact current input while every durable mutation is still
      // pending. Production launchers consume opts.exactBrief and never reread.
      const latest = readRunStateSafe(opts.projectDir, opts.runId);
      if (latest) {
        const current = admitExistingRunBrief(latest, opts.runId, {});
        if (!current.ok) return { ok: false, conflict: current };
      }
      throw error;
    }
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
    clearInterval(staleTimer);
    clearInterval(orphanReconcileTimer);
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

  // ===================== Existing /api/runs endpoints =====================

  app.get("/api/runs", async () => {
    const ids = listRuns(projectDir);
    return ids.map((id) => {
      try { return stateToApi(readRunState(projectDir, id), projectDir); } catch { return null; }
    }).filter(Boolean);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
    try {
      return stateToRunDetail(readRunState(projectDir, req.params.runId), projectDir);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
  });

  // ===================== Durable approval inbox =====================

  app.get<{ Querystring: { state?: string; runId?: string } }>("/api/inbox", async (req, reply) => {
    const state = req.query.state ?? INBOX_FILTER_STATE.PENDING;
    if (!INBOX_FILTER_STATES.has(state)) {
      return reply.code(400).send({ error: 'state must be pending, resolved, or all' });
    }
    if (req.query.runId !== undefined && (!req.query.runId || !isSafeId(req.query.runId))) {
      return reply.code(400).send({ error: 'invalid runId' });
    }
    return listInboxItems({ state: state as InboxFilterState, runId: req.query.runId }).map(dashboardInboxItem);
  });

  app.get("/api/inbox/overview", async () => inboxOverview(projectDir, options));

  app.get("/api/inbox/deferred", async (_req, reply) => {
    try {
      return await deferredInboxItems(options.listTasks ?? listTasksFromDaemon);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: `could not load deferred tasks: ${detail}` });
    }
  });

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
      return reply.code(400).send({ ok: false, won: false, error: 'decision must be approve or deny' });
    }
    if (body.data.always && body.data.decision !== 'approve') {
      return reply.code(400).send({ ok: false, won: false, error: 'always is only valid with approve' });
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
    if (body.data.always) {
      const eligibility = standingRuleEligible(existing);
      if (!eligibility.ok) {
        return reply.code(400).send({ ok: false, won: false, error: eligibility.reason });
      }
    }

    // Resolving a parked request normally resumes that same run (approve and
    // deny both need the agent to consume the decision). Admission therefore
    // precedes resolveRequest: a 409 must not secretly consume the request.
    const parkedState = readRunStateSafe(existing.projectDir, runId);
    let resumePrepared = false;
    let launchPreparedResume: DetachedRunStarter | undefined;
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
      const adapter = (parkedState as StoreState & { adapter?: unknown }).adapter;
      const preparation = prepareDetachedRun({
        runId,
        projectDir: parkedState.projectDir || existing.projectDir,
        exactBrief: briefAdmission.exactBrief,
        briefAdmission: briefAdmission.admission,
        campaignId: parkedState.campaignId ?? parkedState.campaignStorageKey,
        supervise: parkedState.supervise ?? true,
        workflow: parkedState.workflowName || 'default',
        maxIterations: parkedState.maxIterations,
        adapter: typeof adapter === 'string' ? adapter : undefined,
      });
      if (!preparation.ok) {
        return reply.code(409).send({
          ok: false,
          won: false,
          error: preparation.conflict.error,
          report: preparation.conflict.report,
          receipt: preparation.conflict.receipt,
        });
      }
      resumePrepared = true;
      launchPreparedResume = preparation.launch;
      if (parkedState.briefAdmission !== briefAdmission.admission) {
        parkedState.briefAdmission = briefAdmission.admission;
        writeRunState(existing.projectDir, runId, parkedState);
      }
    }

    const result = resolveRequest(existing.projectDir, runId, requestId, body.data.decision, {
      by: body.data.by,
      reason: body.data.reason,
      always: body.data.always,
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

    let resumed = false;
    const runState = readRunStateSafe(existing.projectDir, runId);
    if (resumePrepared && runState && isPausedRunStatus(runState.status)) {
      launchPreparedResume?.();
      resumed = true;
    }

    return { ok: true, won: true, item, resumed };
  });

  app.get<{ Params: { runId: string; stageId: string } }>(
    "/api/runs/:runId/stages/:stageId/input",
    async (req, reply) => {
      const p = join(runsRoot(), req.params.runId, 'stages', req.params.stageId, 'input.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      reply.type("text/markdown").send(readStageInput(projectDir, req.params.runId, req.params.stageId));
    },
  );

  app.get<{ Params: { runId: string; stageId: string }; Querystring: { tailBytes?: string } }>(
    "/api/runs/:runId/stages/:stageId/output",
    async (req, reply) => {
      const p = join(runsRoot(), req.params.runId, 'stages', req.params.stageId, 'output.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      return sendStageOutput(reply, p, parseTailBytes(req.query.tailBytes));
    },
  );

  // ===================== Task endpoints =====================

  // 1. GET /api/tasks (cached for performance — avoids re-reading all run.json files)
  app.get<{ Querystring: { limit?: string } }>("/api/tasks", async (req) => {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit ?? '50', 10) || 50));
    const runsDir = runsRoot();
    if (isTaskListCacheValid(runsDir)) {
      return _taskListCache!.data.slice(0, limit);
    }
    const ids = listRuns(projectDir);
    const recent = ids.reverse().slice(0, limit);
    const data = recent.map((id) => {
      try { return stateToTask(readRunState(projectDir, id), projectDir, configDir); } catch { /* non-critical */ return null; }
    }).filter(Boolean);
    let dirMtime = 0;
    try { dirMtime = statSync(runsDir).mtimeMs; } catch { /* non-critical */ }
    _taskListCache = { data, timestamp: Date.now(), runsDir, dirMtime, projectDir, maxUpdatedAt: getMaxUpdatedAt(projectDir) ?? 0 };
    return data;
  });

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

  // 3. GET /api/tasks/:id
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    try {
      return stateToTask(readRunState(projectDir, req.params.id), projectDir, configDir, { includeIterationLog: true });
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
  });

  // GET /api/tasks/:id/iteration-log
  app.get<{ Params: { id: string } }>("/api/tasks/:id/iteration-log", async (req, reply) => {
    const logPath = join(runsRoot(), req.params.id, 'iteration_log.md');
    if (!existsSync(logPath)) return reply.code(404).send({ error: 'not found' });
    reply.type('text/markdown').send(readFileSync(logPath, 'utf-8'));
  });

  // 3b. PUT /api/tasks/:id
  app.put<{ Params: { id: string }; Body: { plan?: unknown[]; name?: string; workflow?: string } }>("/api/tasks/:id", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    const { plan, name, workflow } = req.body ?? {};
    if (plan !== undefined && containsRemovedStageTimeout(plan)) {
      return reply.code(400).send({ error: DASHBOARD_TIMEOUT_MIGRATION });
    }
    if (plan !== undefined) state.plan = plan;
    if (name !== undefined) {
      const nextDescription = typeof name === 'string' ? name : String(name);
      if (nextDescription !== state.taskDescription) state.briefAdmission = undefined;
      state.taskDescription = nextDescription;
    }
    if (workflow && isSafeId(workflow)) state.workflowName = workflow;
    writeRunState(projectDir, req.params.id, state);
    return { ok: true };
  });

  // PATCH /api/tasks/:id — update task settings
  app.patch<{ Params: { id: string }; Body: { name?: string; timeoutMs?: number; maxIterations?: number; maxRetries?: number; autoApproveRetries?: boolean; campaignTriggers?: unknown; campaignId?: string; campaignName?: string; campaignSeq?: number } }>("/api/tasks/:id", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    const body = req.body ?? {};
    if (Object.hasOwn(body, 'timeoutMs')) {
      return reply.code(400).send({ error: DASHBOARD_TIMEOUT_MIGRATION });
    }
    if (body.name !== undefined) {
      const nextDescription = body.name != null ? String(body.name) : undefined;
      if (nextDescription !== state.taskDescription) state.briefAdmission = undefined;
      state.taskDescription = nextDescription;
    }
    if (body.maxIterations !== undefined) {
      const m = Number(body.maxIterations);
      if (isFinite(m) && m >= 0) state.maxIterations = m;
    }
    if (body.maxRetries !== undefined) {
      const r = Number(body.maxRetries);
      if (isFinite(r) && r >= 0) state.maxRetries = r;
    }
    if (body.autoApproveRetries !== undefined) state.autoApproveRetries = !!body.autoApproveRetries;
    if (body.campaignTriggers !== undefined) state.campaignTriggers = normalizeCampaignTriggers(body.campaignTriggers);
    if (body.campaignId !== undefined || body.campaignName !== undefined) {
      const campaign = resolveCampaignSelection(projectDir, { campaignId: body.campaignId, campaignName: body.campaignName });
      if (campaign) {
        state.campaignId = campaign.id;
        state.campaignStorageKey = campaign.storageKey;
        state.campaignName = campaign.name;
        state.campaignSeq = typeof state.campaignSeq === 'number' ? state.campaignSeq : nextCampaignSeq(projectDir, campaign.storageKey);
        state.campaignIteration = state.currentIteration ?? state.campaignIteration ?? 1;
      } else {
        state.campaignId = undefined;
        state.campaignStorageKey = undefined;
        state.campaignName = undefined;
        state.campaignSeq = undefined;
        state.campaignIteration = undefined;
      }
    } else if (body.campaignSeq !== undefined) {
      state.campaignSeq = body.campaignSeq;
    }
    writeRunState(projectDir, req.params.id, state);
    return { ok: true };
  });

  // GET /api/tasks/:id/dispatch
  // GET /api/tasks/:id/supervisor — returns supervisor activity (or null if no supervisor)
  app.get<{ Params: { id: string } }>("/api/tasks/:id/supervisor", async (req, reply) => {
    const p = join(runsRoot(), req.params.id, 'supervisor_state.json');
    if (!existsSync(p)) return reply.send({ enabled: false });
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      return reply.send({ enabled: true, ...data });
    } catch {
      return reply.send({ enabled: false });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/dispatch", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    if (isAwaitingApprovalRunStatus(state.status) && state.dispatchedStages) {
      return { stages: state.dispatchedStages, status: state.status };
    }
    // Also try reading dispatch.yaml file directly
    const dispatchPath = join(runsRoot(), req.params.id, 'dispatch.yaml');
    if (existsSync(dispatchPath)) {
      try {
        let items = parseYaml(readFileSync(dispatchPath, 'utf-8'));
        // Accept both bare list and {stages: [...]} wrapper
        if (!Array.isArray(items) && items && typeof items === 'object' && Array.isArray((items as Record<string, unknown>).stages)) {
          items = (items as Record<string, unknown>).stages;
        }
        if (Array.isArray(items)) {
          // Normalize task: → prompt_template: for UI consistency
          for (const item of items) {
            if (item && typeof item === 'object' && item.task && !item.prompt_template) {
              item.prompt_template = item.task;
            }
          }
          return { stages: items, status: state.status };
        }
      } catch { /* ignore */ }
    }
    return { stages: [], status: state.status };
  });

  // POST /api/tasks/:id/approve
  app.post<{
    Params: { id: string };
    Body: DashboardBriefAdmissionFields & { autoApproveRetries?: boolean; maxIterations?: number; timeoutMs?: number };
  }>("/api/tasks/:id/approve", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    if (!isAwaitingApprovalRunStatus(state.status)) {
      return reply.code(400).send({ error: 'not awaiting approval' });
    }
    if (Object.hasOwn(req.body ?? {}, 'timeoutMs')) {
      return reply.code(400).send({ error: DASHBOARD_TIMEOUT_MIGRATION });
    }
    const shouldSpawn = !activeExecutions.has(req.params.id);
    if (shouldSpawn) {
      const targetProjectDir = state.projectDir ?? projectDir;
      const blocker = projectAdmissionBlocker(
        targetProjectDir,
        req.params.id,
        options.isProjectBusy ?? isProjectBusy,
      );
      if (blocker) return reply.code(409).send({ error: projectBusyMessage(blocker) });
    }
    const briefAdmission = admitExistingRunBrief(state, req.params.id, req.body ?? {});
    if (!briefAdmission.ok || !briefAdmission.admission) {
      return reply.code(409).send({
        error: briefAdmission.error,
        report: briefAdmission.report,
        receipt: briefAdmission.receipt,
      });
    }
    let launchApprovedRun: DetachedRunStarter | undefined;
    if (shouldSpawn) {
      const preparation = prepareDetachedRun({
        runId: req.params.id,
        projectDir: state.projectDir ?? projectDir,
        exactBrief: briefAdmission.exactBrief,
        briefAdmission: briefAdmission.admission,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: state.workflowName || 'default',
      });
      if (!preparation.ok) {
        return reply.code(409).send({
          error: preparation.conflict.error,
          report: preparation.conflict.report,
          receipt: preparation.conflict.receipt,
        });
      }
      launchApprovedRun = preparation.launch;
    }
    state.briefAdmission = briefAdmission.admission;
    if (req.body?.autoApproveRetries !== undefined) state.autoApproveRetries = !!req.body.autoApproveRetries;
    if (req.body?.maxIterations !== undefined) {
      const m = Number(req.body.maxIterations);
      if (isFinite(m) && m >= 0) state.maxIterations = m;
    }
    state.status = RUN_STATUS.RUNNING;
    writeRunState(projectDir, req.params.id, state);

    // If no active execution loop (e.g. server restarted while awaiting approval),
    // resume workflow execution so the task doesn't get stuck.
    if (shouldSpawn) {
      launchApprovedRun?.();
    }

    return { ok: true };
  });

  // GET /api/tasks/:id/stages/:stageId/output
  app.get<{ Params: { id: string; stageId: string }; Querystring: { tailBytes?: string } }>(
    "/api/tasks/:id/stages/:stageId/output",
    async (req, reply) => {
      const p = join(runsRoot(), req.params.id, 'stages', req.params.stageId, 'output.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      return sendStageOutput(reply, p, parseTailBytes(req.query.tailBytes));
    },
  );

  // 4. POST /api/tasks/:id/execute
  app.post<{ Params: { id: string }; Body: DashboardBriefAdmissionFields }>("/api/tasks/:id/execute", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    if (isRunningRunStatus(state.status)) {
      return reply.code(409).send({ error: 'task is already running' });
    }
    if (isPausedRunStatus(state.status)) {
      return reply.code(409).send({ error: 'task is awaiting approval — resolve the inbox request before executing it' });
    }
    if (isTerminalRunStatus(state.status)) {
      return reply.code(409).send({ error: 'task already finished — use rerun instead' });
    }
    if (activeExecutions.has(req.params.id)) {
      return reply.code(409).send({ error: 'task is already running' });
    }
    // Validate every non-mutating prerequisite before admission and cleanup.
    const briefPath = join(runsRoot(), req.params.id, 'task_brief.md');
    if (!state.taskDescription?.trim() && !existsSync(briefPath)) {
      return reply.code(400).send({ error: 'No task description or task brief found.' });
    }
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      return reply.code(404).send({ error: `workflow not found: ${workflowName}` });
    }
    const targetProjectDir = state.projectDir ?? projectDir;
    const blocker = projectAdmissionBlocker(
      targetProjectDir,
      req.params.id,
      options.isProjectBusy ?? isProjectBusy,
    );
    if (blocker) return reply.code(409).send({ error: projectBusyMessage(blocker) });

    const briefAdmission = admitExistingRunBrief(state, req.params.id, req.body ?? {});
    if (!briefAdmission.ok || !briefAdmission.admission) {
      return reply.code(409).send({
        error: briefAdmission.error,
        report: briefAdmission.report,
        receipt: briefAdmission.receipt,
      });
    }
    const executionPreparation = prepareDetachedRun({
      runId: req.params.id,
      projectDir: targetProjectDir,
      exactBrief: briefAdmission.exactBrief,
      briefAdmission: briefAdmission.admission,
      campaignId: state.campaignId,
      supervise: state.supervise ?? true,
      workflow: workflowName,
    });
    if (!executionPreparation.ok) {
      return reply.code(409).send({
        error: executionPreparation.conflict.error,
        report: executionPreparation.conflict.report,
        receipt: executionPreparation.conflict.receipt,
      });
    }
    state.briefAdmission = briefAdmission.admission;

    // Allow re-execute from awaiting_approval: user refined the brief and
    // wants a fresh plan. Reset dispatched stages.
    if (isAwaitingApprovalRunStatus(state.status)) {
      const dispatchedIds = new Set(
        (Array.isArray(state.dispatchedStages) ? state.dispatchedStages as { id?: string }[] : []).map(s => s.id).filter((x): x is string => !!x),
      );
      for (const sid of dispatchedIds) {
        delete state.stages[sid];
        const stageDir = join(runsRoot(), req.params.id, 'stages', sid);
        if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
      }
      state.dispatchedStages = undefined;
      for (const [, s] of Object.entries(state.stages)) {
        s.status = STAGE_STATUS.PENDING;
        s.retries = 0;
        s.duration_ms = undefined;
        s.error = undefined;
        s.exitCode = undefined;
        s.artifacts = undefined;
        s.startedAt = undefined;
        s.completedAt = undefined;
        s.tokens_in = undefined;
        s.tokens_out = undefined;
        s.attempts = undefined;
        s.reruns = undefined;
        s.writes = undefined;
        s.writeAttribution = undefined;
      }
      state.supervisor = undefined;
      state.status = 'pending';
      state.completedAt = undefined;
      state.failureReason = undefined;
      state.campaignAlert = undefined;
      state.researchInjection = undefined;
      state.currentIteration = 1;
      state.startedAt = new Date().toISOString();
      state.campaignIteration = state.campaignId || state.campaignStorageKey ? 1 : undefined;
      // Clean stale artifacts
      const runPath = join(runsRoot(), req.params.id);
      const dp = join(runPath, 'dispatch.yaml');
      if (existsSync(dp)) unlinkSync(dp);
      const ts = join(runPath, 'tech_solution.md');
      if (existsSync(ts)) unlinkSync(ts);
      const iterLog = join(runPath, 'iteration_log.md');
      if (existsSync(iterLog)) unlinkSync(iterLog);
      const eventsLog = join(runPath, 'events.jsonl');
      if (existsSync(eventsLog)) unlinkSync(eventsLog);
      const refreshJson = join(runPath, 'attempt_summary_refresh.json');
      if (existsSync(refreshJson)) unlinkSync(refreshJson);
      try { for (const f of readdirSync(runPath)) { if (f.startsWith('verdict') && f.endsWith('.json')) unlinkSync(join(runPath, f)); } } catch { /* ignore */ }
      // Clean stale base stage files so re-plan starts fresh
      for (const sid of Object.keys(state.stages)) {
        for (const fname of ['status.json', 'metric.json', 'live.log', 'output.md', 'input.md']) {
          const fp = join(runPath, 'stages', sid, fname);
          if (existsSync(fp)) unlinkSync(fp);
        }
      }
      // Reset workflow.yaml to base stages only (remove stale dispatched entries)
      const wfPath = join(runPath, 'workflow.yaml');
      if (dispatchedIds.size > 0) {
        try {
          const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
          if (Array.isArray(wf.stages)) {
            wf.stages = wf.stages.filter((item: any) => {
              try { return !dispatchedIds.has(StageConfigSchema.parse(item).id); } catch { return true; }
            });
            writeFileSync(wfPath, stringifyYaml(wf), 'utf-8');
          }
        } catch { /* best effort */ }
      }
      writeRunState(projectDir, req.params.id, state);
    }
    state.status = RUN_STATUS.RUNNING;
    state.completedAt = undefined;
    state.failureReason = undefined;
    state.startedAt = state.startedAt ?? new Date().toISOString();
    writeRunState(projectDir, req.params.id, state);
    executionPreparation.launch?.();
    return { ok: true };
  });

  // 5. POST /api/tasks/:id/stop — removed (use cancel instead)

  // DELETE /api/tasks/:id
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params;
    if (!isSafeId(id)) return reply.code(400).send({ error: 'invalid task id' });
    const runPath = join(runsRoot(), id);
    // A live/nonterminal run must complete the shared stop-and-confirm path
    // before any durable history is removed.
    if (existsSync(runPath)) {
      try {
        readRunState(projectDir, id);
        const cancellation = await (options.cancelRun ?? cancelRunWithControlPlane)(id);
        if (!cancellation.ok) {
          return reply.code(409).send({ error: cancellation.message, cancellation });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return reply.code(503).send({ error: `could not confirm cancellation; run was preserved: ${detail}` });
      }
    }
    _stageRolesCache.delete(id);
    _bestScoreCache.delete(id);
    activeExecutions.delete(id);
    try { rmSync(runPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { deleteRunIndex(projectDir, id); } catch { /* index is best-effort */ }
    return { ok: true };
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
    activeExecutions.delete(id);
    return cancellation;
  });

  // POST /api/tasks/:id/rerun
  app.post<{ Params: { id: string }; Body: DashboardBriefAdmissionFields }>("/api/tasks/:id/rerun", async (req, reply) => {
    const { id } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }

    // Reject rerun if task is still actively running
    if (isRunMutationBlockedStatus(state.status)) {
      return reply.code(409).send({ error: 'Cancel the task before rerunning' });
    }
    if (activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'Cancel the task before rerunning' });
    }
    if (isPendingRunStatus(state.status)) {
      return reply.code(400).send({ error: 'Task has not been executed yet — use execute instead' });
    }
    const targetProjectDir = state.projectDir ?? projectDir;
    const blocker = projectAdmissionBlocker(
      targetProjectDir,
      id,
      options.isProjectBusy ?? isProjectBusy,
    );
    if (blocker) return reply.code(409).send({ error: projectBusyMessage(blocker) });

    const briefAdmission = admitExistingRunBrief(state, id, req.body ?? {});
    if (!briefAdmission.ok || !briefAdmission.admission) {
      return reply.code(409).send({
        error: briefAdmission.error,
        report: briefAdmission.report,
        receipt: briefAdmission.receipt,
      });
    }
    const rerunHasBriefSidecar = briefAdmission.hasBriefSidecar === true;
    const rerunWorkflowName = state.workflowName || 'default';
    let rerunPreparation: DetachedRunPreparation | undefined;
    if (rerunHasBriefSidecar) {
      const yamlPath = join(configDir, 'workflows', `${rerunWorkflowName}.yaml`);
      if (!existsSync(yamlPath)) {
        return reply.code(400).send({ error: `workflow not found: ${rerunWorkflowName}` });
      }
      rerunPreparation = prepareDetachedRun({
        runId: id,
        projectDir: targetProjectDir,
        exactBrief: briefAdmission.exactBrief,
        briefAdmission: briefAdmission.admission,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: rerunWorkflowName,
      });
      if (!rerunPreparation.ok) {
        return reply.code(409).send({
          error: rerunPreparation.conflict.error,
          report: rerunPreparation.conflict.report,
          receipt: rerunPreparation.conflict.receipt,
        });
      }
    }
    state.briefAdmission = briefAdmission.admission;

    for (const [, s] of Object.entries(state.stages)) {
      s.status = STAGE_STATUS.PENDING;
      s.duration_ms = undefined;
      s.error = undefined;
      s.retries = 0;
      s.exitCode = undefined;
      s.artifacts = undefined;
      s.startedAt = undefined;
      s.completedAt = undefined;
      s.tokens_in = undefined;
      s.tokens_out = undefined;
      s.attempts = undefined;
      s.reruns = undefined;
      s.writes = undefined;
      s.writeAttribution = undefined;
    }
    state.supervisor = undefined;
    state.completedAt = undefined;
    state.startedAt = new Date().toISOString();

    // Reset iteration state on rerun
    state.currentIteration = 1;
    state.campaignIteration = state.campaignId || state.campaignStorageKey ? 1 : undefined;
    state.failureReason = undefined;
    state.campaignAlert = undefined;
    state.researchInjection = undefined;

    // Issue 61: clean up orphaned dispatched stages
    // First, remove any stages listed in dispatchedStages (these were dynamically added)
    const dispatchedIds = new Set<string>(
      (Array.isArray(state.dispatchedStages) ? state.dispatchedStages as { id?: string }[] : []).map(s => s.id).filter((x): x is string => !!x),
    );
    for (const sid of dispatchedIds) {
      delete state.stages[sid];
    }
    // Then, also remove stages not in workflow.yaml base stages
    // (exclude dispatched IDs from the base set since workflow.yaml may include them)
    const baseStageIds = new Set<string>();
    const wfPath = join(runsRoot(), id, 'workflow.yaml');
    try {
      const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
      if (Array.isArray(wf.stages)) {
        for (const item of wf.stages) {
          try {
            const sc = StageConfigSchema.parse(item);
            if (!dispatchedIds.has(sc.id)) baseStageIds.add(sc.id);
          } catch { /* skip */ }
        }
        // Reset workflow.yaml to base stages only
        wf.stages = wf.stages.filter((item: any) => {
          try { return !dispatchedIds.has(StageConfigSchema.parse(item).id); } catch { return true; }
        });
        writeFileSync(wfPath, stringifyYaml(wf), 'utf-8');
      }
    } catch { /* no workflow */ }
    if (baseStageIds.size > 0) {
      for (const sid of Object.keys(state.stages)) {
        if (!baseStageIds.has(sid)) delete state.stages[sid];
      }
    }
    state.dispatchedStages = undefined;

    // Clear stale artifacts from previous run
    const runPath = join(runsRoot(), id);
    const supervisorStagePath = join(runPath, 'stages', '_supervisor');
    if (existsSync(supervisorStagePath)) rmSync(supervisorStagePath, { recursive: true, force: true });
    for (const fname of ['supervisor_state.json', 'supervisor_log.md']) {
      const path = join(runPath, fname);
      if (existsSync(path)) unlinkSync(path);
    }
    // Remove dispatched stage directories entirely
    for (const sid of dispatchedIds) {
      const stageDir = join(runPath, 'stages', sid);
      if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    }
    // Clear stale stage files so they don't leak into API responses or agent context
    for (const sid of Object.keys(state.stages)) {
      for (const fname of ['status.json', 'metric.json', 'live.log', 'output.md', 'input.md']) {
        const p = join(runPath, 'stages', sid, fname);
        if (existsSync(p)) unlinkSync(p);
      }
    }
    const iterLogPath = join(runPath, 'iteration_log.md');
    if (existsSync(iterLogPath)) unlinkSync(iterLogPath);
    const dispatchPath = join(runPath, 'dispatch.yaml');
    if (existsSync(dispatchPath)) unlinkSync(dispatchPath);
    const refreshPath = join(runPath, 'attempt_summary_refresh.json');
    if (existsSync(refreshPath)) unlinkSync(refreshPath);
    // Clean stale events log so the events feed starts fresh on rerun
    const eventsPath = join(runPath, 'events.jsonl');
    if (existsSync(eventsPath)) unlinkSync(eventsPath);
    // Clean stale planner artifacts so re-plan starts fresh
    const techSolPath = join(runPath, 'tech_solution.md');
    if (existsSync(techSolPath)) unlinkSync(techSolPath);
    try {
      for (const f of readdirSync(runPath)) {
        if (f.startsWith('verdict') && f.endsWith('.json')) unlinkSync(join(runPath, f));
      }
    } catch { /* ignore */ }

    // Preserve the source decision captured with the exact admitted bytes.
    if (rerunHasBriefSidecar) {
      // Trigger workflow (same pattern as stage-level rerun)
      state.status = 'running';
      writeRunState(projectDir, id, state);
      if (rerunPreparation?.ok) rerunPreparation.launch?.();
      return { ok: true, route: 'monitor' };
    } else {
      state.status = 'pending';
      writeRunState(projectDir, id, state);
      return { ok: true, route: 'pending' };
    }
  });

  // POST /api/tasks/:id/stages/:stageId/rerun — stage-level rerun
  app.post<{ Params: { id: string; stageId: string }; Body: DashboardBriefAdmissionFields }>("/api/tasks/:id/stages/:stageId/rerun", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });
    if (isRunMutationBlockedStatus(state.status)) {
      return reply.code(409).send({ error: 'task is still running' });
    }
    if (activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'task is still running' });
    }
    const targetProjectDir = state.projectDir ?? projectDir;
    const blocker = projectAdmissionBlocker(
      targetProjectDir,
      id,
      options.isProjectBusy ?? isProjectBusy,
    );
    if (blocker) return reply.code(409).send({ error: projectBusyMessage(blocker) });
    const briefAdmission = admitExistingRunBrief(state, id, req.body ?? {});
    if (!briefAdmission.ok || !briefAdmission.admission) {
      return reply.code(409).send({
        error: briefAdmission.error,
        report: briefAdmission.report,
        receipt: briefAdmission.receipt,
      });
    }
    state.briefAdmission = briefAdmission.admission;
    const exactBrief = briefAdmission.exactBrief;
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
    }
    const inProcessWorkflow = options.runWorkflow;
    let launchStageRerun: DetachedRunStarter | undefined;
    if (!inProcessWorkflow) {
      const preparation = prepareDetachedRun({
        runId: id,
        projectDir: targetProjectDir,
        exactBrief,
        briefAdmission: briefAdmission.admission,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: workflowName,
      });
      if (!preparation.ok) {
        return reply.code(409).send({
          error: preparation.conflict.error,
          report: preparation.conflict.report,
          receipt: preparation.conflict.receipt,
        });
      }
      launchStageRerun = preparation.launch;
    }

    // Build StageConfig[] from workflow.yaml for dependency graph
    const wfPath = join(runsRoot(), id, 'workflow.yaml');
    let stages: StageConfig[] = [];
    try {
      const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
      if (Array.isArray(wf.stages)) {
        for (const item of wf.stages) {
          try { stages.push(StageConfigSchema.parse(item)); } catch { /* skip */ }
        }
      }
    } catch { /* no workflow */ }

    const downstream = findDownstream(stageId, stages);
    const resetIds = [stageId, ...downstream];

    // If rerunning a dynamic_dispatch stage (e.g. plan), clean up old dispatched stages
    const targetStage = stages.find(s => s.id === stageId);
    if (targetStage?.dynamic_dispatch) {
      const dispatchedIds = new Set(
        (Array.isArray(state.dispatchedStages) ? state.dispatchedStages as { id?: string }[] : [])
          .map(s => s.id).filter((x): x is string => !!x),
      );
      // Remove dispatched stages from state and clean up their directories
      for (const sid of dispatchedIds) {
        delete state.stages[sid];
        const stageDir = join(runsRoot(), id, 'stages', sid);
        if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
        const vp = join(runsRoot(), id, `verdict_${sid}.json`);
        if (existsSync(vp)) unlinkSync(vp);
      }
      state.dispatchedStages = undefined;
      // Clear dispatch.yaml so planner starts fresh
      const dp = join(runsRoot(), id, 'dispatch.yaml');
      if (existsSync(dp)) unlinkSync(dp);
      // Clear planner artifacts so it starts fresh
      const techSolPath = join(runsRoot(), id, 'tech_solution.md');
      if (existsSync(techSolPath)) unlinkSync(techSolPath);
      const iterLogPath = join(runsRoot(), id, 'iteration_log.md');
      if (existsSync(iterLogPath)) unlinkSync(iterLogPath);
      // Reset iteration state so planner and auto-approve logic start fresh
      state.currentIteration = 1;
      state.campaignIteration = state.campaignId || state.campaignStorageKey ? 1 : undefined;
      // Reset workflow.yaml to base stages only
      try {
        const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
        if (Array.isArray(wf.stages)) {
          wf.stages = wf.stages.filter((item: any) => {
            try { return !dispatchedIds.has(StageConfigSchema.parse(item).id); } catch { return true; }
          });
          writeFileSync(wfPath, stringifyYaml(wf), 'utf-8');
        }
      } catch { /* best effort */ }
    }

    // Reset target + downstream
    const runPath = join(runsRoot(), id);
    for (const sid of resetIds) {
      if (!state.stages[sid]) continue; // already removed (dispatched stage cleanup above)
      state.stages[sid] = rependStageStatus(state.stages[sid], 0);
      // Clear verdict files for gate stages
      const vp = join(runPath, `verdict_${sid}.json`);
      if (existsSync(vp)) unlinkSync(vp);
      // Clear stale stage files so they don't leak into API or agent context
      for (const fname of ['metric.json', 'live.log', 'output.md', 'input.md', 'session.json']) {
        const fp = join(runPath, 'stages', sid, fname);
        if (existsSync(fp)) unlinkSync(fp);
      }
    }
    // Clear shared verdict.json (legacy fallback)
    const svp = join(runPath, 'verdict.json');
    if (existsSync(svp)) unlinkSync(svp);
    // Clean stale events so the events feed starts fresh for the rerun
    const stageRerunEventsPath = join(runPath, 'events.jsonl');
    if (existsSync(stageRerunEventsPath)) unlinkSync(stageRerunEventsPath);
    const stageRerunRefreshPath = join(runPath, 'attempt_summary_refresh.json');
    if (existsSync(stageRerunRefreshPath)) unlinkSync(stageRerunRefreshPath);
    state.status = 'running';
    state.completedAt = undefined;
    state.failureReason = undefined;
    state.campaignAlert = undefined;
    state.researchInjection = undefined;
    state.startedAt = new Date().toISOString();
    writeRunState(projectDir, id, state);

    // Resume execution
    if (!inProcessWorkflow) {
      launchStageRerun?.();
      return { ok: true, reset: resetIds };
    }
    try {
      const { config, raw } = loadWorkflow(yamlPath);
      const agents = new Map<string, AgentConfig>();
      try {
        const allFiles = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
        for (const f of allFiles) {
          const parsed = parseYaml(readFileSync(join(agentsDir, f), 'utf-8'));
          agents.set(f.replace('.yaml', ''), parseAgentConfig(parsed, configDir));
        }
      } catch { /* ignore */ }
      const adapter = options.adapter ?? await resolveAdapter(configDir);
      activeExecutions.add(id);
      inProcessWorkflow(
        config, raw, targetProjectDir, adapter, agents, undefined, agentsDir, id,
        exactBrief, true, state.supervise ?? true, undefined, true, state.briefAdmission,
      )
        .catch((err) => {
          log.error({ err }, 'Workflow failed');
          try {
            const s = readRunState(projectDir, id);
            if (isRunningRunStatus(s.status)) {
              s.status = RUN_STATUS.FAILED;
              s.failureReason = `Workflow error: ${err instanceof Error ? err.message : String(err)}`;
              s.completedAt = new Date().toISOString();
              writeRunState(projectDir, id, s);
            }
          } catch { /* run may have been removed */ }
        })
        .finally(() => activeExecutions.delete(id));
    } catch (err) {
      state.status = 'failed';
      state.failureReason = `Workflow load error: ${err instanceof Error ? err.message : String(err)}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, id, state);
    }

    return { ok: true, reset: resetIds };
  });

  // POST /api/tasks/:id/stages/:stageId/reeval — gate re-evaluation only
  app.post<{ Params: { id: string; stageId: string }; Body: DashboardBriefAdmissionFields }>("/api/tasks/:id/stages/:stageId/reeval", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });
    if (isRunMutationBlockedStatus(state.status) || activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'task is still running' });
    }
    // Validate the stage is actually a gate — reeval only makes sense for gate stages
    const roles = loadStageRoles(projectDir, id);
    if (!roles[stageId]?.isGate) {
      return reply.code(400).send({ error: 'stage is not a gate — use rerun instead' });
    }
    const targetProjectDir = state.projectDir ?? projectDir;
    const blocker = projectAdmissionBlocker(
      targetProjectDir,
      id,
      options.isProjectBusy ?? isProjectBusy,
    );
    if (blocker) return reply.code(409).send({ error: projectBusyMessage(blocker) });
    const briefAdmission = admitExistingRunBrief(state, id, req.body ?? {});
    if (!briefAdmission.ok || !briefAdmission.admission) {
      return reply.code(409).send({
        error: briefAdmission.error,
        report: briefAdmission.report,
        receipt: briefAdmission.receipt,
      });
    }
    state.briefAdmission = briefAdmission.admission;
    const exactBrief = briefAdmission.exactBrief;
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
    }
    const inProcessWorkflow = options.runWorkflow;
    let launchReevaluation: DetachedRunStarter | undefined;
    if (!inProcessWorkflow) {
      const preparation = prepareDetachedRun({
        runId: id,
        projectDir: targetProjectDir,
        exactBrief,
        briefAdmission: briefAdmission.admission,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: workflowName,
      });
      if (!preparation.ok) {
        return reply.code(409).send({
          error: preparation.conflict.error,
          report: preparation.conflict.report,
          receipt: preparation.conflict.receipt,
        });
      }
      launchReevaluation = preparation.launch;
    }

    const runPath = join(runsRoot(), id);
    // Clear verdict
    const vp = join(runPath, `verdict_${stageId}.json`);
    if (existsSync(vp)) unlinkSync(vp);
    // Clear shared verdict.json (legacy fallback)
    const svp = join(runPath, 'verdict.json');
    if (existsSync(svp)) unlinkSync(svp);
    // Clear stale stage files so they don't leak into API or agent context
    for (const fname of ['metric.json', 'live.log', 'output.md', 'input.md', 'session.json']) {
      const fp = join(runPath, 'stages', stageId, fname);
      if (existsSync(fp)) unlinkSync(fp);
    }

    // Reset just this stage
    state.stages[stageId] = rependStageStatus(state.stages[stageId], 0);
    // Clean stale events so the events feed starts fresh for the re-evaluation
    const reevalEventsPath = join(runPath, 'events.jsonl');
    if (existsSync(reevalEventsPath)) unlinkSync(reevalEventsPath);
    const reevalRefreshPath = join(runPath, 'attempt_summary_refresh.json');
    if (existsSync(reevalRefreshPath)) unlinkSync(reevalRefreshPath);
    state.status = 'running';
    state.completedAt = undefined;
    state.failureReason = undefined;
    state.campaignAlert = undefined;
    state.researchInjection = undefined;
    state.startedAt = new Date().toISOString();
    writeRunState(projectDir, id, state);

    // Resume execution
    if (!inProcessWorkflow) {
      launchReevaluation?.();
      return { ok: true };
    }
    try {
      const { config, raw } = loadWorkflow(yamlPath);
      const agents = new Map<string, AgentConfig>();
      try {
        const allFiles = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
        for (const f of allFiles) {
          const parsed = parseYaml(readFileSync(join(agentsDir, f), 'utf-8'));
          agents.set(f.replace('.yaml', ''), parseAgentConfig(parsed, configDir));
        }
      } catch { /* ignore */ }
      const adapter = options.adapter ?? await resolveAdapter(configDir);
      activeExecutions.add(id);
      inProcessWorkflow(
        config, raw, targetProjectDir, adapter, agents, undefined, agentsDir, id,
        exactBrief, true, state.supervise ?? true, undefined, true, state.briefAdmission,
      )
        .catch((err) => {
          log.error({ err }, 'Workflow failed');
          try {
            const s = readRunState(projectDir, id);
            if (isRunningRunStatus(s.status)) {
              s.status = RUN_STATUS.FAILED;
              s.failureReason = `Workflow error: ${err instanceof Error ? err.message : String(err)}`;
              s.completedAt = new Date().toISOString();
              writeRunState(projectDir, id, s);
            }
          } catch { /* run may have been removed */ }
        })
        .finally(() => activeExecutions.delete(id));
    } catch (err) {
      state.status = 'failed';
      state.failureReason = `Workflow load error: ${err instanceof Error ? err.message : String(err)}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, id, state);
    }

    return { ok: true };
  });

  // 6. GET /api/tasks/:id/stages/:stageId
  app.get<{ Params: { id: string; stageId: string } }>(
    "/api/tasks/:id/stages/:stageId",
    async (req, reply) => {
      try {
        const state = readRunState(projectDir, req.params.id);
        if (req.params.stageId === '_supervisor' && state.supervisor) {
          return {
            id: '_supervisor',
            role: 'supervisor',
            status: state.supervisor.status,
            duration_ms: state.supervisor.duration_ms,
            retries: 0,
            reruns: Math.max(0, state.supervisor.calls - 1),
            attempts: state.supervisor.attempts,
            artifacts: [],
            dependsOn: [],
            input: '',
            output: '',
            tokens_in: state.supervisor.tokens_in,
            tokens_out: state.supervisor.tokens_out,
            calls: state.supervisor.calls,
          };
        }
        const s = state.stages[req.params.stageId];
        if (!s) return reply.code(404).send({ error: "stage not found" });
        const roles = loadStageRoles(projectDir, req.params.id);
        const input = readStageInput(projectDir, req.params.id, req.params.stageId);
        // Merge detailed fields from status.json but keep run.json status as authoritative
        let detailed = s;
        try {
          const fromDisk = JSON.parse(readFileSync(join(runsRoot(), req.params.id, 'stages', req.params.stageId, 'status.json'), 'utf-8'));
          detailed = { ...s, ...fromDisk, status: s.status };
        } catch { /* use run state */ }
        return {
          id: req.params.stageId,
          role: roles[req.params.stageId]?.role ?? "",
          status: detailed.status,
          duration_ms: detailed.duration_ms,
          retries: detailed.retries,
          reruns: detailed.reruns ?? 0,
          attempts: detailed.attempts ?? [],
          artifacts: detailed.artifacts ?? [],
          dependsOn: roles[req.params.stageId]?.dependsOn ?? [],
          input,
          output: '',
          tokens_in: detailed.tokens_in ?? 0,
          tokens_out: detailed.tokens_out ?? 0,
          error: detailed.error,
        };
      } catch { /* non-critical */
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

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

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/events",
    async (req, reply) => {
      const runPath = join(runsRoot(), req.params.id, 'run.json');
      if (!existsSync(runPath)) return reply.code(404).send({ error: 'not found' });

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      let lastPayload = '';
      let terminalSent = false;
      let lastMtime = 0;
      const send = () => {
        if (terminalSent) return;
        try {
          // P0: Check mtime before expensive full read
          const mtime = statSync(runPath).mtimeMs;
          if (mtime === lastMtime && lastPayload) return; // no change since last check
          lastMtime = mtime;
          const state = readRunState(projectDir, req.params.id);
          const payload = JSON.stringify(stateToTask(state, projectDir, configDir));
          if (payload === lastPayload) return;
          lastPayload = payload;
          invalidateTaskListCache(); // task changed, bust list cache
          reply.raw.write(`data: ${payload}\n\n`);
          if (isTerminalRunStatus(state.status)) {
            terminalSent = true;
            clearInterval(interval);
            if (!reply.raw.writableEnded) reply.raw.end();
          }
        } catch { /* non-critical */
          // Task disappeared (deleted) — stop polling to avoid resource leak
          terminalSent = true;
          clearInterval(interval);
        }
      };

      send();
      const interval = setInterval(send, 1000);

      req.raw.on('close', () => {
        clearInterval(interval);
        if (!reply.raw.writableEnded) reply.raw.end();
      });
    },
  );

  // ===================== Campaign endpoints =====================

  // Legacy run-campaign endpoints back existing task import/dashboard controls.
  // M3 owns /api/campaigns for filesystem campaign inspection.
  app.get("/api/run-campaigns", async () => {
    return listCampaigns(projectDir).map(({ id, name, runCount, bestScore, latestRun }) => ({
      id,
      name,
      runCount,
      bestScore,
      latestRun,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/run-campaigns/:id", async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const entries = readCampaignEntries(projectDir, req.params.id);
    if (entries.length === 0) return reply.code(404).send({ error: 'not found' });
    return entries;
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
          const state = JSON.parse(readFileSync(runJsonPath, 'utf-8'));
          if (state.campaignId === campaignId || state.campaignStorageKey === campaignId) {
            state.campaignName = newName;
            writeFileSync(runJsonPath, JSON.stringify(state, null, 2), 'utf-8');
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
          const state = JSON.parse(readFileSync(runJsonPath, 'utf-8')) as StoreState;
          if (!runMatchesCampaign(state, campaignId)) continue;
          state.campaignId = '';
          state.campaign_id = '';
          state.campaignStorageKey = '';
          state.campaignName = '';
          writeFileSync(runJsonPath, JSON.stringify(state, null, 2), 'utf-8');
          orphaned++;
        } catch { /* non-critical */ }
      }
    } catch { /* no run root */ }
    invalidateTaskListCache();
    return { ok: true, orphaned, removedHistory };
  });

  // GET /api/campaigns
  app.get("/api/campaigns", async () => {
    return listM3Campaigns(projectDir);
  });

  const campaignPageSources: Partial<CampaignPageSources> = {
    readInbox: () => inboxOverview(projectDir, options),
    readTasks: () => (options.listTasks ?? listTasksFromDaemon)({}),
    hasLiveWorker: (runProjectDir, runId) => hasLiveScheduler(runProjectDir, runId) || hasLiveDirectRunner(runProjectDir, runId),
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

  // GET /api/campaigns/:id
  app.get<{ Params: { id: string } }>("/api/campaigns/:id", async (req, reply) => {
    const campaign = getWorkspaceCampaign(projectDir, req.params.id);
    if (!campaign) return reply.code(404).send({ error: 'not found' });
    return campaign;
  });

  // GET /api/campaigns/:id/kg — campaign-level KG synthesized from the campaign's per-run graphs.
  app.get<{ Params: { id: string } }>("/api/campaigns/:id/kg", async (req) => {
    return aggregateCampaignKG(projectDir, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/campaigns/:id/iterations", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    return readJsonlFile(join(dir, 'iteration_log.jsonl'));
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

  app.get<{ Params: { id: string } }>("/api/campaigns/:id/revisions", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const state = readJsonFile(join(dir, 'state.json'));
    const briefDir = resolveBriefDir(state);
    return briefDir ? readJsonlFile(join(briefDir, 'revisions.jsonl')) : [];
  });

  app.get<{ Params: { id: string } }>("/api/campaigns/:id/pending-review", async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const dir = campaignDirOr404(req.params.id);
    if (!dir && !getWorkspaceCampaign(projectDir, req.params.id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return readPendingReviews(req.params.id).map((entry, index) => ({
      ...entry,
      index,
      patchSummary: summarizePatch(entry.patch),
    }));
  });

  app.get<{ Params: { id: string } }>("/api/campaigns/:id/kg-hints", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const hints = readJsonFile(join(dir, 'kg_hints.json'));
    return Array.isArray(hints) ? hints : [];
  });

  app.post<{ Params: { id: string; index: string } }>("/api/campaigns/:id/kg-hints/:index/review", async (req, reply) => {
    const dir = campaignDirOr404(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not found' });
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) return reply.code(400).send({ error: 'index must be a non-negative integer' });
    const hints = readJsonFile(join(dir, 'kg_hints.json'));
    if (!Array.isArray(hints) || index >= hints.length) return reply.code(404).send({ error: 'hint not found' });
    const hint = hints[index] as Record<string, unknown>;
    const suggestedPatch = hint.suggestedPatch && typeof hint.suggestedPatch === 'object'
      ? (hint.suggestedPatch as Record<string, unknown>)
      : undefined;
    const metadata = suggestedPatch?.metadata && typeof suggestedPatch.metadata === 'object'
      ? suggestedPatch.metadata as Record<string, unknown>
      : undefined;
    const patch = metadata
      ? { type: 'brief_patch', section: metadata.section, op: metadata.op, value: metadata.value }
      : undefined;
    const parsedPatch = z.object({
      type: z.literal('brief_patch'),
      section: z.string().min(1),
      op: z.enum(['append', 'replace_value', 'edit']),
      value: z.string(),
    }).safeParse(patch);
    if (!parsedPatch.success) return reply.code(400).send({ error: 'hint does not contain an applicable brief patch' });
    const state = readJsonFile(join(dir, 'state.json'));
    appendPendingReview(req.params.id, {
      reason: `Cross-campaign KG suggestion from ${typeof (hint.symptomNode as Record<string, unknown> | undefined)?.campaignId === 'string' ? (hint.symptomNode as Record<string, unknown>).campaignId : 'prior campaign'}`,
      severity: 'medium',
      patch: parsedPatch.data,
      source: 'cross_campaign_kg',
      briefDir: resolveBriefDir(state),
      briefVersion: getStringAt(state, ['briefVersion']) ?? getStringAt(state, ['initialBriefVersion']),
      rule: typeof hint.reason === 'string' ? hint.reason : undefined,
    });
    return { ok: true };
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

  app.get("/api/cross-campaign-kg/summary", async () => {
    return crossCampaignSummary();
  });

  app.get("/api/cross-campaign-kg/nodes", async () => {
    return getCrossCampaignNodes().map(adaptCrossCampaignNode);
  });

  app.get("/api/cross-campaign-kg/edges", async () => {
    return getCrossCampaignEdges().map(adaptCrossCampaignEdge);
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

  // 9. GET /api/agents/:name
  app.get<{ Params: { name: string } }>("/api/agents/:name", async (req, reply) => {
    if (req.params.name.includes('..') || req.params.name.includes('/')) return reply.code(400).send({ error: 'invalid name' });
    const filePath = join(agentsDir, `${req.params.name}.yaml`);
    try {
      reply.type('text/yaml').send(readFileSync(filePath, 'utf-8'));
    } catch { /* non-critical */
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // --- Knowledge Graph API ---

  // GET /api/tasks/:id/knowledge-graph
  app.get<{ Params: { id: string } }>('/api/tasks/:id/knowledge-graph', async (req, reply) => {
    try {
      return readKG(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // POST /api/tasks/:id/knowledge-graph/nodes
  app.post<{ Params: { id: string }; Body: { type: string; label: string; details?: string; source?: string; score?: number } }>('/api/tasks/:id/knowledge-graph/nodes', async (req, reply) => {
    try {
      const { type, label, details, source, score } = req.body;
      if (!type || !label) return reply.code(400).send({ error: 'type and label required' });
      const node = addNode(projectDir, req.params.id, { type: type as KGNodeType, label, details, source, score });
      return node;
    } catch { /* non-critical */
      return reply.code(500).send({ error: 'failed to add node' });
    }
  });

  // PATCH /api/tasks/:id/knowledge-graph/nodes/:nodeId
  app.patch<{ Params: { id: string; nodeId: string }; Body: { type?: string; label?: string; details?: string; score?: number } }>('/api/tasks/:id/knowledge-graph/nodes/:nodeId', async (req, reply) => {
    try {
      const updates: any = {};
      const body = req.body;
      if (body.type !== undefined) updates.type = body.type;
      if (body.label !== undefined) updates.label = body.label;
      if (body.details !== undefined) updates.details = body.details;
      if (body.score !== undefined) updates.score = body.score;
      const node = updateNode(projectDir, req.params.id, req.params.nodeId, updates);
      if (!node) return reply.code(404).send({ error: 'node not found' });
      return node;
    } catch { /* non-critical */
      return reply.code(500).send({ error: 'failed to update node' });
    }
  });

  // DELETE /api/tasks/:id/knowledge-graph/nodes/:nodeId
  app.delete<{ Params: { id: string; nodeId: string } }>('/api/tasks/:id/knowledge-graph/nodes/:nodeId', async (req, reply) => {
    try {
      const removed = removeNode(projectDir, req.params.id, req.params.nodeId);
      if (!removed) return reply.code(404).send({ error: 'node not found' });
      return { ok: true };
    } catch { /* non-critical */
      return reply.code(500).send({ error: 'failed to remove node' });
    }
  });

  // POST /api/tasks/:id/knowledge-graph/edges
  app.post<{ Params: { id: string }; Body: { from: string; to: string; type: string; label?: string } }>('/api/tasks/:id/knowledge-graph/edges', async (req, reply) => {
    try {
      const { from, to, type, label } = req.body;
      if (!from || !to || !type) return reply.code(400).send({ error: 'from, to, and type required' });
      const edge = addEdge(projectDir, req.params.id, { from, to, type: type as KGEdgeType, label });
      return edge;
    } catch { /* non-critical */
      return reply.code(500).send({ error: 'failed to add edge' });
    }
  });

  // --- Execution Trace API ---

  // GET /api/tasks/:id/trace — all trace events for a run
  app.get<{ Params: { id: string } }>('/api/tasks/:id/trace', async (req, reply) => {
    try {
      const events = readAllTraceEvents(projectDir, req.params.id);
      const summary = summarizeTrace(events);
      return { events, summary };
    } catch { /* non-critical */
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // GET /api/tasks/:id/stages/:stageId/trace — trace events for a specific stage
  app.get<{ Params: { id: string; stageId: string } }>('/api/tasks/:id/stages/:stageId/trace', async (req, reply) => {
    try {
      const events = readTraceEvents(projectDir, req.params.id, req.params.stageId);
      return { events, summary: summarizeTrace(events) };
    } catch { /* non-critical */
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // ===================== Sub-task endpoints =====================

  // POST /api/tasks/:id/subtasks — spawn a sub-task
  app.post<{
    Params: { id: string };
    Body: DashboardBriefAdmissionFields & {
      name?: string;
      brief?: string;
      workflow?: string;
      budget?: { totalTokens?: number; totalTimeMs?: number };
    };
  }>('/api/tasks/:id/subtasks', async (req, reply) => {
    try {
      const parentState = readRunState(projectDir, req.params.id);
      const { name, brief, workflow, budget } = req.body ?? {};
      const exactBrief = brief ?? name ?? '';
      if (!exactBrief.trim()) return reply.code(400).send({ error: 'brief or name required' });
      const admission = admitDashboardBrief(exactBrief, req.body ?? {});
      if (!admission.ok || !admission.admission) {
        return reply.code(409).send({ error: admission.error, report: admission.report, receipt: admission.receipt });
      }
      const workflowName = workflow || parentState.workflowName || 'default';
      const wfPath = join(configDir, 'workflows', `${workflowName}.yaml`);
      if (!existsSync(wfPath)) return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
      const displayName = name?.trim() || exactBrief.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').slice(0, 80) || 'Sub-task';
      const minimalYaml = stringifyYaml({ name: displayName, stages: [] });
      const { runId } = createRun(projectDir, workflowName, minimalYaml, []);
      const state = readRunState(projectDir, runId);
      state.status = 'pending';
      state.taskDescription = exactBrief;
      state.briefAdmission = admission.admission;
      state.parentTaskId = req.params.id;
      writeFileSync(join(runsRoot(), runId, 'task_brief.md'), exactBrief, 'utf-8');
      // Inherit budget from parent, split if specified
      if (budget) {
        state.budget = {
          totalTokens: budget.totalTokens,
          totalTimeMs: budget.totalTimeMs,
          usedTokens: 0,
          usedTimeMs: 0,
        };
      } else if (parentState.budget) {
        // Default: give child half of parent's remaining budget
        const remainingTokens = (parentState.budget.totalTokens ?? 0) - (parentState.budget.usedTokens ?? 0);
        const remainingTime = (parentState.budget.totalTimeMs ?? 0) - (parentState.budget.usedTimeMs ?? 0);
        state.budget = {
          totalTokens: Math.max(0, Math.floor(remainingTokens / 2)),
          totalTimeMs: Math.max(0, Math.floor(remainingTime / 2)),
          usedTokens: 0,
          usedTimeMs: 0,
        };
      }
      // Inherit campaign from parent
      if (parentState.campaignId) {
        state.campaignId = parentState.campaignId;
        state.campaignStorageKey = parentState.campaignStorageKey;
        state.campaignName = parentState.campaignName;
      }
      writeRunState(projectDir, runId, state);
      return { id: runId, parentTaskId: req.params.id };
    } catch { /* non-critical */
      return reply.code(500).send({ error: 'failed to create sub-task' });
    }
  });

  // GET /api/tasks/:id/subtasks — list sub-tasks
  app.get<{ Params: { id: string } }>('/api/tasks/:id/subtasks', async (req) => {
    const parentId = req.params.id;
    const ids = listRuns(projectDir);
    const subtasks: { id: string; name?: string; status: string }[] = [];
    for (const id of ids) {
      try {
        const state = readRunState(projectDir, id);
        if (state.parentTaskId === parentId) {
          subtasks.push({ id: state.runId, name: state.taskDescription, status: state.status });
        }
      } catch { /* skip */ }
    }
    return subtasks;
  });

  // ===================== Mock endpoints =====================


  // 12. POST /api/plan
  app.post<{ Body: { taskId: string; workflow?: string } }>("/api/plan", async (req, reply) => {
    const workflow = req.body?.workflow || 'default';
    if (!isSafeId(workflow)) {
      return reply.code(400).send({ error: 'invalid workflow name' });
    }
    const yamlPath = join(configDir, 'workflows', `${workflow}.yaml`);
    try {
      const defaults = readExecutionDefaults(configDir);
      const raw = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(raw);
      const config = WorkflowConfigSchema.parse(parsed);
      return config.stages.map((s) => ({
        id: s.id,
        role: s.role,
        prompt_template: s.prompt_template,
        depends_on: s.depends_on,
        attempt_budget_ms: defaults.timeoutMs,
        max_retries: s.max_retries ?? config.defaults.max_retries ?? defaults.stageTechnicalRetries,
      }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: `workflow not found or invalid: ${workflow}: ${detail}` });
    }
  });

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

  // 13b. PATCH /api/settings — persist settings changes to defaults.yaml
  app.patch<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
    const defaultsPath = join(configDir, 'defaults.yaml');
    let existing: Record<string, unknown> = {};
    if (existsSync(defaultsPath)) {
      try { existing = parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>; } catch { /* non-critical */ }
    }
    const updates = req.body ?? {};
    const allowedKeys = ['adapter', 'model', 'reasoning_effort', 'default_timeout_ms', 'default_max_iterations', 'default_gate_retry_loops', 'default_stage_technical_retries'];
    for (const key of allowedKeys) {
      if (key in updates) existing[key] = updates[key];
    }
    const { stringify } = await import('yaml');
    writeFileSync(defaultsPath, stringify(existing), 'utf-8');
    log.info({ keys: Object.keys(updates).filter(k => allowedKeys.includes(k)) }, 'Settings updated');
    return { ok: true };
  });

  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err: unknown) {
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
