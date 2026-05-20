import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, unlinkSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { listRuns, readRunState, readStageInput, createRun, writeRunState, runsRoot } from "./store.js";
import type { StoreState } from "./store.js";
import { deleteRunIndex, readRunIndexRecordsByCampaign } from './run-index.js';
import {
  collapseEntriesForHealth,
  listCampaigns,
  nextCampaignSeq,
  readCampaignEntries,
  resolveCampaignSelection,
  resolveCampaignStorageKey,
  summarizeCampaignPhaseProgress,
} from "./campaigns.js";
import { loadWorkflow, runWorkflow, WorkflowConfigSchema, findDownstream, StageConfigSchema, loadBasePrompt, applyBasePrompt } from "./scheduler.js";
import type { StageConfig } from "./scheduler.js";
import type { AgentConfig, Adapter } from "./adapters/base.js";
import { readAttemptSummaryRefreshState } from "./run-events.js";
import { readKG, addNode, updateNode, removeNode, addEdge, summarizeKG } from './knowledge-graph.js';
import { readTraceEvents, readAllTraceEvents, summarizeTrace } from './trace.js';
import { z } from "zod";
import pino from "pino";
import type { KGNodeType, KGEdgeType } from './knowledge-graph.js';

const log = pino({ name: 'dashboard' });

// --- Dynamic adapter loading ---
let _cachedResolvedAdapter: Adapter | null = null;
let _cachedAdapterMtime = 0;
async function resolveAdapter(configDir: string): Promise<Adapter> {
  const defaultsPath = join(configDir, "defaults.yaml");
  // Invalidate cache when defaults.yaml changes
  try {
    const mtime = statSync(defaultsPath).mtimeMs;
    if (_cachedResolvedAdapter && mtime === _cachedAdapterMtime) return _cachedResolvedAdapter;
    _cachedAdapterMtime = mtime;
  } catch { /* non-critical */
    if (_cachedResolvedAdapter) return _cachedResolvedAdapter;
  }
  const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, "utf-8")) as Record<string, unknown> : {};
  let name = (defaults.adapter as string) || "codex";
  const map: Record<string, string> = { codex: "./adapters/codex.js", claude: "./adapters/claude.js" };

  // Verify the configured adapter CLI is available; auto-detect if not
  const cliMap: Record<string, string> = { codex: 'codex', claude: 'claude' };
  const { execSync } = await import('node:child_process');
  const cliCmd = cliMap[name];
  if (cliCmd) {
    try { execSync(`which ${cliCmd}`, { stdio: 'ignore' }); } catch { /* non-critical */
      // Configured adapter not found — try to find any available one
      const configured = name;
      let found = false;
      for (const [adapterName, cmd] of Object.entries(cliMap)) {
        if (adapterName === name) continue;
        try { execSync(`which ${cmd}`, { stdio: 'ignore' }); name = adapterName; found = true; break; } catch { /* not found */ }
      }
      if (!found) {
        throw new Error(`Configured adapter "${configured}" (${cliCmd}) not found and no fallback available. Install Codex or Claude. See \`flowcrew doctor\` for details.`);
      }
      log.warn(`Configured adapter "${configured}" not found — using "${name}" instead`);
    }
  }

  const mod = await import(map[name] || map.codex);
  const adapter: Adapter = mod.createAdapter();
  _cachedResolvedAdapter = adapter;
  return adapter;
}

// --- Project defaults for agent config fallback ---
function loadProjectDefaults(configDir: string): { model: string; reasoning_effort: string } {
  try {
    const raw = readFileSync(join(configDir, 'defaults.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return {
      model: typeof parsed.model === 'string' ? parsed.model : 'default',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'default',
    };
  } catch { return { model: 'default', reasoning_effort: 'default' }; }
}

const DashboardAgentSchema = z.object({ name: z.string(), description: z.string().default(''), model: z.string().default('default'), reasoning_effort: z.string().default('default'), tools: z.array(z.string()).default([]), prompt: z.string(), adapter: z.string().optional() });

function parseAgentConfig(raw: unknown, configDir?: string): AgentConfig {
  const defaults = loadProjectDefaults(configDir ?? join(process.cwd(), 'config'));
  const agent = DashboardAgentSchema.parse(raw);
  if (agent.model === 'default') agent.model = defaults.model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = defaults.reasoning_effort;
  return agent;
}

// --- Shared helpers ---

const _stageRolesCache = new Map<string, { mtime: number; roles: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> }>();
const DEFAULT_STAGE_OUTPUT_TAIL_BYTES = 200 * 1024;

// --- Performance: task list cache (P0) ---
let _taskListCache: { data: unknown[]; timestamp: number; runsDir: string; dirMtime: number } | null = null;
const TASK_LIST_CACHE_TTL_MS = 5_000; // 5s TTL

function invalidateTaskListCache(): void {
  _taskListCache = null;
}

function isTaskListCacheValid(runsDir: string): boolean {
  if (!_taskListCache || _taskListCache.runsDir !== runsDir) return false;
  if ((Date.now() - _taskListCache.timestamp) >= TASK_LIST_CACHE_TTL_MS) return false;
  // Also check if any run.json was modified since cache was built
  try {
    const dirMtime = statSync(runsDir).mtimeMs;
    if (dirMtime !== _taskListCache.dirMtime) return false;
  } catch { /* non-critical */ return false; }
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

function hasLiveDirectRunner(projectDir: string, runId: string): boolean {
  for (const prefix of ['direct-resume', 'direct-rerun']) {
    try {
      const pidPath = join(projectDir, '.fc', `${prefix}-${runId}.pid`);
      if (!existsSync(pidPath)) continue;
      const pid = readFileSync(pidPath, 'utf-8').trim();
      if (!/^\d+$/.test(pid)) continue;
      const cmdlinePath = `/proc/${pid}/cmdline`;
      const environPath = `/proc/${pid}/environ`;
      if (!existsSync(cmdlinePath) || !existsSync(environPath)) continue;
      const cmdline = readFileSync(cmdlinePath, 'utf-8');
      const environ = readFileSync(environPath, 'utf-8');
      if (cmdline.includes('.fc/direct-') && environ.split('\0').includes(`RUN_ID=${runId}`)) {
        return true;
      }
    } catch { /* non-critical */
      // Stale PID files or inaccessible /proc entries are treated as not alive.
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
    // /proc/<pid> is the canonical Linux liveness probe; FlowCrew is WSL/Linux only.
    return existsSync(`/proc/${pid}`);
  } catch { /* non-critical */
    return false;
  }
}

function markDetachedRunFailed(projectDir: string, runId: string, reason: string): void {
  try {
    const state = readRunState(projectDir, runId);
    if (state.status !== 'running') return;
    state.status = 'failed';
    state.failureReason = reason;
    state.completedAt = new Date().toISOString();
    for (const [, stage] of Object.entries(state.stages)) {
      if (stage.status === 'running') stage.status = 'failed';
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
function spawnDetachedRun(opts: {
  runId: string;
  projectDir: string;
  campaignId?: string | undefined;
  supervise?: boolean | undefined;
  workflow?: string | undefined;
  maxIterations?: number | undefined;
  timeoutMs?: number | undefined;
  adapter?: string | undefined;
}): void {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args: string[] = ['quick', '--existing-run-id', opts.runId, '--project', opts.projectDir];
  if (opts.workflow) args.push('--workflow', opts.workflow);
  if (typeof opts.maxIterations === 'number') args.push('--max-iterations', String(opts.maxIterations));
  if (typeof opts.timeoutMs === 'number') args.push('--timeout', String(opts.timeoutMs));
  if (opts.adapter) args.push('--adapter', opts.adapter);
  if (opts.supervise === false) args.push('--no-supervise');
  if (opts.campaignId) args.push('--campaign', opts.campaignId);
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
    if (logFd >= 0) try { closeSync(logFd); } catch { /* ignore */ }
    const reason = `Detached scheduler failed to spawn: ${err instanceof Error ? err.message : String(err)}`;
    markDetachedRunFailed(opts.projectDir, opts.runId, reason);
    throw err;
  }
  if (logFd >= 0) try { closeSync(logFd); } catch { /* ignore */ }
  child.once('error', (err) => {
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
    const runIds = Number.isFinite(limit) && limit > 0
      ? listRecentRunIdsForStartup(projectDir, limit)
      : [];
    for (const id of runIds) {
      try {
        const state = readRunState(projectDir, id);
        if (state.status === 'running') {
          if (hasLiveDirectRunner(projectDir, id)) continue;
          if (hasLiveScheduler(projectDir, id)) continue;
          state.status = 'failed';
          state.failureReason = 'Server restarted while task was running';
          state.completedAt = new Date().toISOString();
          for (const [, s] of Object.entries(state.stages)) {
            if (s.status === 'running') s.status = 'failed';
          }
          writeRunState(projectDir, id, state);
        }
      } catch { /* skip unreadable runs */ }
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

export function buildCampaignContext(projectDir: string, campaignId: string, currentRunId: string, campaignDisplayName?: string): string {
  const runsDir = runsRoot();
  const targetCampaignStorageKey = resolveCampaignStorageKey({ campaignId }) ?? campaignId;

  const entries = readCampaignEntries(projectDir, targetCampaignStorageKey);
  const campaignName = campaignDisplayName ?? entries[0]?.campaignName ?? campaignId;

  // Find sibling runs
  interface SiblingRun { runId: string; taskDescription?: string; startedAt?: string; briefPath: string; currentIteration?: number; campaignSeq?: number }
  const siblings: SiblingRun[] = [];
  const indexedSiblings = readRunIndexRecordsByCampaign(projectDir, targetCampaignStorageKey);
  if (indexedSiblings) {
    for (const rState of indexedSiblings) {
      if (rState.runId === currentRunId) continue;
      siblings.push({
        runId: rState.runId,
        taskDescription: rState.taskDescription,
        startedAt: rState.startedAt,
        briefPath: join(runsDir, rState.runId, 'task_brief.md'),
        currentIteration: rState.campaignIteration,
        campaignSeq: rState.campaignSeq,
      });
    }
  } else {
    try {
      for (const dir of readdirSync(runsDir)) {
        if (dir === currentRunId) continue;
        const runJsonPath = join(runsDir, dir, 'run.json');
        try {
          const rState = JSON.parse(readFileSync(runJsonPath, 'utf-8'));
          const siblingStorageKey = resolveCampaignStorageKey({
            campaignId: rState.campaignId,
            campaignStorageKey: rState.campaignStorageKey,
            campaignName: rState.campaignName,
          });
          if (siblingStorageKey === targetCampaignStorageKey) {
            siblings.push({
              runId: dir,
              taskDescription: rState.taskDescription,
              startedAt: rState.startedAt,
              briefPath: join(runsDir, dir, 'task_brief.md'),
              currentIteration: rState.currentIteration,
              campaignSeq: rState.campaignSeq,
            });
          }
        } catch { /* skip */ }
      }
    } catch { /* no runs dir */ }
  }

  if (entries.length === 0 && siblings.length === 0) return '';

  let ctx = `# Campaign Context\n\nCampaign: ${campaignName}\n\nThis task belongs to a campaign. Use the information below to answer questions about previous explorations — do NOT search the filesystem for this information.\n\n`;

  const scoredEntries = collapseEntriesForHealth(entries);
  const phaseProgress = summarizeCampaignPhaseProgress(entries);

  // Score history table
  if (scoredEntries.length > 0) {
    ctx += '## Score History\n\n| # | Run | Score | Metric | Gate | Pass |\n|---|-----|-------|--------|------|------|\n';
    for (const e of scoredEntries) {
      ctx += `| ${e.seq ?? '-'} | ${e.runId?.slice(0, 8) ?? '-'} | ${e.score ?? '-'} | ${e.metric ?? '-'} | ${e.gate ?? '-'} | ${e.pass ? '✅' : '❌'} |\n`;
    }
    ctx += '\n';
  }

  if (phaseProgress.entries.length > 0) {
    ctx += '## Phase Progress\n\n';
    ctx += `- Completed phases: ${phaseProgress.completedPhases.length > 0 ? phaseProgress.completedPhases.join(', ') : 'none'}\n`;
    ctx += `- Current recommended phase: ${phaseProgress.currentPhase ?? 'not specified'}\n`;
    if (phaseProgress.latest) {
      ctx += `- Latest: run ${phaseProgress.latest.runId.slice(0, 8)}, iteration ${phaseProgress.latest.iteration ?? 1}, phase ${phaseProgress.latest.phase ?? '-'}, complete ${phaseProgress.latest.phaseComplete === true ? 'true' : 'false'}, next ${phaseProgress.latest.nextPhase ?? '-'}, outcome ${phaseProgress.latest.outcome ?? '-'}\n`;
      if (phaseProgress.latest.artifactSummary) ctx += `- Artifact summary: ${phaseProgress.latest.artifactSummary}\n`;
      if (phaseProgress.latest.reason) ctx += `- Reason: ${phaseProgress.latest.reason}\n`;
    }
    ctx += '\nPlanner instruction: for multi-phase campaigns, continue from the current recommended phase and avoid dispatching future phases in the same iteration unless explicitly requested.\n\n';
  }

  // Sort siblings by startedAt descending
  siblings.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  // Recent 2-3: full task brief; older: one-line summary
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    if (i < 3) {
      try {
        const brief = readFileSync(s.briefPath, 'utf-8');
        ctx += `## Run ${s.runId.slice(0, 8)} — Seq ${s.campaignSeq ?? '?'} / Iteration ${s.currentIteration ?? 1}\n\n${brief}\n\n`;
      } catch { /* non-critical */
        ctx += `- Run ${s.runId.slice(0, 8)}: ${s.taskDescription ?? 'no description'}\n`;
      }
    } else {
      ctx += `- Run ${s.runId.slice(0, 8)}: ${s.taskDescription ?? 'no description'}\n`;
    }
  }

  return ctx;
}

export function buildCampaignContextInjection(campaignContext: string): string {
  return [
    'System-provided campaign context for this discussion session.',
    'Use this background context when answering campaign questions. Do not generate a plan unless the user explicitly asks for plan generation.',
    '',
    campaignContext.trim(),
  ].filter(Boolean).join('\n\n');
}

export function withCampaignContextPrompt(role: AgentConfig, campaignContext: string): AgentConfig {
  if (!campaignContext.trim()) return role;
  return {
    ...role,
    prompt: [
      role.prompt,
      buildCampaignContextInjection(campaignContext),
    ].filter(Boolean).join('\n\n'),
  };
}

export function injectInitialTuiMessage(session: import('./adapters/base.js').InteractiveSession, message: string): void {
  if (!message.trim()) return;
  session.write(`\x1b[200~${message}\x1b[201~`);
  session.write('\r');
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
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; dependsOn: string[] }[];
}

function stateToApi(state: StoreState, projectDir: string): RunApiShape {
  const roles = loadStageRoles(projectDir, state.runId);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    startedAt: state.startedAt,
    stages: Object.entries(state.stages).map(([id, s]) => ({
      id,
      role: roles[id]?.role ?? "",
      status: s.status,
      duration_ms: s.duration_ms,
      retries: s.retries,
      dependsOn: roles[id]?.dependsOn ?? [],
    })),
  };
}

interface TaskShape {
  id: string;
  name: string;
  type: string;
  workflow: string;
  status: string;
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; artifacts?: string[]; dependsOn: string[]; dispatched: boolean; startedAt?: string; completedAt?: string; isGate?: boolean; tokens_in?: number; tokens_out?: number; error?: string; kgChanged?: boolean }[];
  startedAt: string;
  elapsed_ms: number;
  tokens: number;
  bestScore?: number;
  metricName?: string;
  discussion: unknown[];
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

let _cachedExecutionDefaults: { timeoutMs: number; maxIterations: number; gateRetryLoops: number; stageTechnicalRetries: number } | null = null;
let _executionDefaultsMtime = 0;

function readExecutionDefaults(configDir?: string): { timeoutMs: number; maxIterations: number; gateRetryLoops: number; stageTechnicalRetries: number } {
  const defaultsPath = join(configDir ?? join(process.cwd(), 'config'), 'defaults.yaml');
  try {
    const mtime = statSync(defaultsPath).mtimeMs;
    if (_cachedExecutionDefaults && mtime === _executionDefaultsMtime) return _cachedExecutionDefaults;
    const defaults = parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>;
    _executionDefaultsMtime = mtime;
    _cachedExecutionDefaults = {
      timeoutMs: typeof defaults.default_timeout_ms === 'number' ? defaults.default_timeout_ms : 300000,
      maxIterations: typeof defaults.default_max_iterations === 'number' ? defaults.default_max_iterations : 3,
      gateRetryLoops: typeof defaults.default_gate_retry_loops === 'number' ? defaults.default_gate_retry_loops : 1,
      stageTechnicalRetries: typeof defaults.default_stage_technical_retries === 'number' ? defaults.default_stage_technical_retries : 1,
    };
    return _cachedExecutionDefaults;
  } catch { /* non-critical */
    return _cachedExecutionDefaults ?? { timeoutMs: 300000, maxIterations: 3, gateRetryLoops: 1, stageTechnicalRetries: 1 };
  }
}

function extractTaskTitle(desc?: string): string {
  if (!desc) return '';
  // Find first non-empty line, strip markdown heading markers, truncate
  const lines = desc.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed && trimmed.length > 2) {
      return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
    }
  }
  return desc.slice(0, 80);
}

function stateToTask(state: StoreState, projectDir: string, configDir?: string, opts?: { includeIterationLog?: boolean }): TaskShape {
  const defaults = readExecutionDefaults(configDir);
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
  const stages = Object.entries(state.stages).map(([id, s]) => ({
    id,
    role: roles[id]?.role ?? "",
    status: s.status,
    duration_ms: s.duration_ms,
    retries: s.retries,
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
  const elapsed_ms = state.status === 'running' || state.status === 'awaiting_approval'
    ? Math.max(0, Date.now() - Date.parse(state.startedAt)) || 0
    : state.completedAt
      ? Math.max(0, Date.parse(state.completedAt) - Date.parse(state.startedAt)) || 0
      : stages.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  const totalTokens = Object.values(state.stages).reduce((sum, s) => sum + (s.tokens_in ?? 0) + (s.tokens_out ?? 0), 0);
  const { bestScore, metricName } = readBestScore(projectDir, state.runId);
  const task: TaskShape = {
    id: state.runId,
    name: extractTaskTitle(state.taskDescription) || state.workflowName,
    type: '',
    workflow: state.workflowName,
    status: state.status === 'complete' ? 'completed' : state.status,
    stages,
    startedAt: state.startedAt,
    elapsed_ms,
    tokens: totalTokens,
    bestScore,
    metricName,
    discussion: state.discussion ?? [],
    plan: state.plan ?? [],
    currentIteration: state.currentIteration ?? 1,
    maxIterations: state.maxIterations ?? defaults.maxIterations,
    maxRetries: state.maxRetries ?? defaults.gateRetryLoops,
    autoApproveRetries: state.autoApproveRetries ?? true,
    timeoutMs: state.timeoutMs,
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

interface DashboardOptions {
  adapter?: Adapter;
  agentConfig?: AgentConfig;
  skillContent?: string;
  onPlanPollingStart?: (taskId: string) => void;
}

export async function startDashboard(projectDir: string, port = 3000, options: DashboardOptions = {}) {
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
        if (state.status !== 'running') continue;
        const taskTimeout = state.timeoutMs ?? readExecutionDefaults(configDir).timeoutMs;
        const staleThreshold = taskTimeout + 5 * 60_000;
        if (age < staleThreshold) continue;
        state.status = 'failed';
        state.failureReason = `Task appears stale (no progress for ${Math.round(staleThreshold / 60_000)}+ minutes). It may have crashed.`;
        state.completedAt = new Date().toISOString();
        for (const [, s] of Object.entries(state.stages)) {
          if (s.status === 'running') s.status = 'failed';
        }
        writeRunState(projectDir, id, state);
        activeExecutions.delete(id);
      } catch { /* skip */ }
    }
  }, staleCheckMs);

  const app = Fastify({ logger: false });

  await app.register(websocket);

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

  // --- PTY session persistence ---
  interface PtySession {
    session: import('./adapters/base.js').InteractiveSession;
    outputBuffer: string[];
    alive: boolean;
    planPolling: boolean;
    activeSocket: { send: (data: Buffer | Uint8Array) => void } | null;
    planPollCleanup?: () => void;
  }
  const ptySessions = new Map<string, PtySession>();

  // --- Static file serving ---
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist');
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', wildcard: false });
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
      return stateToApi(readRunState(projectDir, req.params.runId), projectDir);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
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
    _taskListCache = { data, timestamp: Date.now(), runsDir, dirMtime };
    return data;
  });

  // 2. POST /api/tasks
  app.post<{ Body: { name: string; workflow: string; discussion?: unknown[]; plan?: unknown[]; planFile?: string; campaignId?: string; campaignName?: string; campaignSeq?: number } }>("/api/tasks", async (req, reply) => {
    if (!req.body || typeof req.body !== 'object') return reply.code(400).send({ error: 'missing body' });
    const { name, workflow, discussion, plan, planFile, campaignId, campaignName } = req.body;
    const workflowName = workflow || 'default';
    if (!isSafeId(workflowName)) {
      return reply.code(400).send({ error: 'invalid workflow name' });
    }
    const wfPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(wfPath)) {
      return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
    }
    const safeName = typeof name === 'string' ? name : (name != null ? String(name) : undefined);
    const yamlName = typeof name === 'string' ? name : String(name ?? 'untitled');
    const minimalYaml = stringifyYaml({ name: yamlName, stages: [] });
    const { runId } = createRun(projectDir, workflow || 'default', minimalYaml, []);
    const state = readRunState(projectDir, runId);
    state.status = 'pending';
    state.taskDescription = safeName;
    state.autoApproveRetries = true;
    state.autoApprove = true;
    if (discussion) state.discussion = discussion;
    if (plan) state.plan = plan;
    const campaign = resolveCampaignSelection(projectDir, { campaignId, campaignName });
    if (campaign) {
      state.campaignId = campaign.id;
      state.campaignStorageKey = campaign.storageKey;
      state.campaignName = campaign.name;
      state.campaignSeq = nextCampaignSeq(projectDir, campaign.storageKey);
      state.campaignIteration = 1;
    }
    writeRunState(projectDir, runId, state);
    if (planFile) {
      const runPath = join(runsRoot(), runId);
      mkdirSync(runPath, { recursive: true });
      writeFileSync(join(runPath, 'task_brief.md'), planFile, 'utf-8');
    }
    return { id: runId };
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
  app.put<{ Params: { id: string }; Body: { plan?: unknown[]; discussion?: unknown[]; name?: string; workflow?: string } }>("/api/tasks/:id", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    const { plan, discussion, name, workflow } = req.body ?? {};
    if (plan !== undefined) state.plan = plan;
    if (discussion !== undefined) state.discussion = discussion;
    if (name !== undefined) state.taskDescription = typeof name === 'string' ? name : String(name);
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
    if (body.name !== undefined) state.taskDescription = body.name != null ? String(body.name) : undefined;
    if (body.timeoutMs !== undefined) {
      const t = Number(body.timeoutMs);
      if (isFinite(t) && t >= 0) state.timeoutMs = t;
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
    if (state.status === 'awaiting_approval' && state.dispatchedStages) {
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
  app.post<{ Params: { id: string }; Body: { autoApproveRetries?: boolean; maxIterations?: number; timeoutMs?: number } }>("/api/tasks/:id/approve", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    if (state.status !== 'awaiting_approval') {
      return reply.code(400).send({ error: 'not awaiting approval' });
    }
    if (req.body?.autoApproveRetries !== undefined) state.autoApproveRetries = !!req.body.autoApproveRetries;
    if (req.body?.maxIterations !== undefined) {
      const m = Number(req.body.maxIterations);
      if (isFinite(m) && m >= 0) state.maxIterations = m;
    }
    if (req.body?.timeoutMs !== undefined) {
      const t = Number(req.body.timeoutMs);
      if (isFinite(t) && t >= 0) state.timeoutMs = t;
    }
    state.status = 'running';
    writeRunState(projectDir, req.params.id, state);

    // If no active execution loop (e.g. server restarted while awaiting approval),
    // resume workflow execution so the task doesn't get stuck.
    if (!activeExecutions.has(req.params.id)) {
      spawnDetachedRun({
        runId: req.params.id,
        projectDir: state.projectDir ?? projectDir,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: state.workflowName || 'default',
      });
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
  app.post<{ Params: { id: string } }>("/api/tasks/:id/execute", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch { /* non-critical */
      return reply.code(404).send({ error: "not found" });
    }
    if (state.status === 'running') {
      return reply.code(409).send({ error: 'task is already running' });
    }
    if (activeExecutions.has(req.params.id)) {
      return reply.code(409).send({ error: 'task is already running' });
    }
    // Kill discussion PTY session — it's no longer needed once execution starts
    const pty = ptySessions.get(req.params.id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } pty.alive = false; }
    pty?.planPollCleanup?.();
    ptySessions.delete(req.params.id);
    // Allow re-execute from awaiting_approval: user went back to discussion,
    // refined the brief, and wants a fresh plan. Reset dispatched stages.
    if (state.status === 'awaiting_approval') {
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
        s.status = 'pending';
        s.retries = 0;
        s.duration_ms = undefined;
        s.error = undefined;
        s.exitCode = undefined;
        s.artifacts = undefined;
        s.startedAt = undefined;
        s.completedAt = undefined;
        s.tokens_in = undefined;
        s.tokens_out = undefined;
      }
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
    if (state.status === 'complete' || state.status === 'failed') {
      return reply.code(409).send({ error: 'task already finished — use rerun instead' });
    }
    // Warn if no task brief and no task description — planner will get an empty prompt
    const briefPath = join(runsRoot(), req.params.id, 'task_brief.md');
    if (!state.taskDescription?.trim() && !existsSync(briefPath)) {
      return reply.code(400).send({ error: 'No task description or task brief found. Complete the discussion first.' });
    }
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      return reply.code(404).send({ error: `workflow not found: ${workflowName}` });
    }
    state.status = 'running';
    state.completedAt = undefined;
    state.failureReason = undefined;
    state.startedAt = state.startedAt ?? new Date().toISOString();
    writeRunState(projectDir, req.params.id, state);
    spawnDetachedRun({
      runId: req.params.id,
      projectDir: state.projectDir ?? projectDir,
      campaignId: state.campaignId,
      supervise: state.supervise ?? true,
      workflow: workflowName,
    });
    return { ok: true };
  });

  // 5. POST /api/tasks/:id/stop — removed (use cancel instead)

  // DELETE /api/tasks/:id
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params;
    // Kill PTY if active
    const pty = ptySessions.get(id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } }
    pty?.planPollCleanup?.();
    ptySessions.delete(id);
    _stageRolesCache.delete(id);
    _bestScoreCache.delete(id);
    // Cancel running workflow so background execution stops gracefully
    try {
      const state = readRunState(projectDir, id);
      if (state.status === 'running' || state.status === 'awaiting_approval') {
        state.status = 'failed';
        state.failureReason = 'Deleted by user';
        state.completedAt = new Date().toISOString();
        for (const [, s] of Object.entries(state.stages)) {
          if (s.status === 'running') s.status = 'failed';
          if (s.status === 'pending') s.status = 'skipped';
        }
        writeRunState(projectDir, id, state);
      }
    } catch { /* run state may not exist */ }
    // Remove from active executions so the background loop stops cleanly
    activeExecutions.delete(id);
    // Remove run directory
    const runPath = join(runsRoot(), id);
    try { rmSync(runPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { deleteRunIndex(projectDir, id); } catch { /* index is best-effort */ }
    return { ok: true };
  });

  // POST /api/tasks/:id/cancel
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (state.status === 'complete' || state.status === 'failed') {
      return { ok: true };
    }
    // Kill PTY if active and remove from map so rerun gets a clean session
    const pty = ptySessions.get(id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } pty.alive = false; }
    pty?.planPollCleanup?.();
    ptySessions.delete(id);
    state.status = 'failed';
    state.failureReason = 'Cancelled by user';
    state.completedAt = new Date().toISOString();
    for (const [, s] of Object.entries(state.stages)) {
      if (s.status === 'running') s.status = 'failed';
      if (s.status === 'pending') s.status = 'skipped';
    }
    writeRunState(projectDir, id, state);
    // Remove from active executions so rerun is immediately available
    activeExecutions.delete(id);
    return { ok: true };
  });

  // POST /api/tasks/:id/rerun
  app.post<{ Params: { id: string } }>("/api/tasks/:id/rerun", async (req, reply) => {
    const { id } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }

    // Reject rerun if task is still actively running
    if (state.status === 'running' || state.status === 'awaiting_approval') {
      return reply.code(409).send({ error: 'Cancel the task before rerunning' });
    }
    if (activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'Cancel the task before rerunning' });
    }
    if (state.status === 'pending') {
      return reply.code(400).send({ error: 'Task has not been executed yet — use execute instead' });
    }

    // Kill PTY session if active
    const pty = ptySessions.get(id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } pty.alive = false; }
    ptySessions.delete(id);

    for (const [, s] of Object.entries(state.stages)) {
      s.status = 'pending';
      s.duration_ms = undefined;
      s.error = undefined;
      s.retries = 0;
      s.exitCode = undefined;
      s.artifacts = undefined;
      s.startedAt = undefined;
      s.completedAt = undefined;
      s.tokens_in = undefined;
      s.tokens_out = undefined;
    }
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

    // Check if task_brief.md exists to decide route
    const briefPath = join(runsRoot(), id, 'task_brief.md');
    if (existsSync(briefPath)) {
      // Trigger workflow (same pattern as stage-level rerun)
      const workflowName = state.workflowName || 'default';
      const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
      if (!existsSync(yamlPath)) {
        state.status = 'failed';
        state.failureReason = `Workflow not found: ${workflowName}`;
        state.completedAt = new Date().toISOString();
        writeRunState(projectDir, id, state);
        return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
      }
      state.status = 'running';
      writeRunState(projectDir, id, state);
      spawnDetachedRun({
        runId: id,
        projectDir: state.projectDir ?? projectDir,
        campaignId: state.campaignId,
        supervise: state.supervise ?? true,
        workflow: workflowName,
      });
      return { ok: true, route: 'monitor' };
    } else {
      // Clean discuss session directory so new discussion starts fresh
      const discussDir = join(runPath, 'discuss');
      if (existsSync(discussDir)) rmSync(discussDir, { recursive: true, force: true });
      state.status = 'pending';
      writeRunState(projectDir, id, state);
      return { ok: true, route: 'discuss' };
    }
  });

  // POST /api/tasks/:id/stages/:stageId/rerun — stage-level rerun
  app.post<{ Params: { id: string; stageId: string } }>("/api/tasks/:id/stages/:stageId/rerun", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });
    if (state.status === 'running' || state.status === 'awaiting_approval') {
      return reply.code(409).send({ error: 'task is still running' });
    }
    if (activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'task is still running' });
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
      state.stages[sid] = { status: 'pending', retries: 0 };
      // Clear verdict files for gate stages
      const vp = join(runPath, `verdict_${sid}.json`);
      if (existsSync(vp)) unlinkSync(vp);
      // Clear stale stage files so they don't leak into API or agent context
      for (const fname of ['status.json', 'metric.json', 'live.log', 'output.md', 'input.md']) {
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
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      state.status = 'failed';
      state.failureReason = `Workflow not found: ${workflowName}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, id, state);
      return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
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
      const adapter = await resolveAdapter(configDir);
      activeExecutions.add(id);
      runWorkflow(config, raw, projectDir, adapter, agents, undefined, agentsDir, id, state.taskDescription, true, state.supervise ?? true).catch((err) => { log.error({ err }, 'Workflow failed'); try { const s = readRunState(projectDir, id); if (s.status === 'running') { s.status = 'failed'; s.failureReason = `Workflow error: ${err instanceof Error ? err.message : String(err)}`; s.completedAt = new Date().toISOString(); writeRunState(projectDir, id, s); } } catch {} }).finally(() => activeExecutions.delete(id));
    } catch (err) {
      state.status = 'failed';
      state.failureReason = `Workflow load error: ${err instanceof Error ? err.message : String(err)}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, id, state);
    }

    return { ok: true, reset: resetIds };
  });

  // POST /api/tasks/:id/stages/:stageId/reeval — gate re-evaluation only
  app.post<{ Params: { id: string; stageId: string } }>("/api/tasks/:id/stages/:stageId/reeval", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });
    if (state.status === 'running' || state.status === 'awaiting_approval' || activeExecutions.has(id)) {
      return reply.code(409).send({ error: 'task is still running' });
    }
    // Validate the stage is actually a gate — reeval only makes sense for gate stages
    const roles = loadStageRoles(projectDir, id);
    if (!roles[stageId]?.isGate) {
      return reply.code(400).send({ error: 'stage is not a gate — use rerun instead' });
    }

    const runPath = join(runsRoot(), id);
    // Clear verdict
    const vp = join(runPath, `verdict_${stageId}.json`);
    if (existsSync(vp)) unlinkSync(vp);
    // Clear shared verdict.json (legacy fallback)
    const svp = join(runPath, 'verdict.json');
    if (existsSync(svp)) unlinkSync(svp);
    // Clear stale stage files so they don't leak into API or agent context
    for (const fname of ['status.json', 'metric.json', 'live.log', 'output.md', 'input.md']) {
      const fp = join(runPath, 'stages', stageId, fname);
      if (existsSync(fp)) unlinkSync(fp);
    }

    // Reset just this stage
    state.stages[stageId] = { status: 'pending', retries: 0 };
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
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(configDir, 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      state.status = 'failed';
      state.failureReason = `Workflow not found: ${workflowName}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, id, state);
      return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
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
      const adapter = await resolveAdapter(configDir);
      activeExecutions.add(id);
      runWorkflow(config, raw, projectDir, adapter, agents, undefined, agentsDir, id, state.taskDescription, true, state.supervise ?? true).catch((err) => { log.error({ err }, 'Workflow failed'); try { const s = readRunState(projectDir, id); if (s.status === 'running') { s.status = 'failed'; s.failureReason = `Workflow error: ${err instanceof Error ? err.message : String(err)}`; s.completedAt = new Date().toISOString(); writeRunState(projectDir, id, s); } } catch {} }).finally(() => activeExecutions.delete(id));
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
          if (ss.status && ss.status !== 'running' && ss.status !== 'pending') {
            stageFinished = true;
            clearInterval(interval);
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
          if (state.status === 'complete' || state.status === 'failed') {
            terminalSent = true;
            clearInterval(interval);
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

  // GET /api/campaigns
  app.get("/api/campaigns", async () => {
    return listCampaigns(projectDir).map(({ id, name, runCount, bestScore, latestRun }) => ({
      id,
      name,
      runCount,
      bestScore,
      latestRun,
    }));
  });

  // GET /api/campaigns/:id
  app.get<{ Params: { id: string } }>("/api/campaigns/:id", async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const entries = readCampaignEntries(projectDir, req.params.id);
    if (entries.length === 0) return reply.code(404).send({ error: 'not found' });
    return entries;
  });

  // POST /api/campaigns/rename — rename a campaign (POST because campaign IDs can be very long)
  app.post<{ Body: { campaignId: string; name: string } }>("/api/campaigns/rename", async (req, reply) => {
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
            model: parsed.model ?? '',
            tools: parsed.tools ?? [],
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
  app.post<{ Params: { id: string }; Body: { name: string; workflow?: string; budget?: { totalTokens?: number; totalTimeMs?: number } } }>('/api/tasks/:id/subtasks', async (req, reply) => {
    try {
      const parentState = readRunState(projectDir, req.params.id);
      const { name, workflow, budget } = req.body;
      if (!name) return reply.code(400).send({ error: 'name required' });
      const workflowName = workflow || parentState.workflowName || 'default';
      const wfPath = join(configDir, 'workflows', `${workflowName}.yaml`);
      if (!existsSync(wfPath)) return reply.code(400).send({ error: `workflow not found: ${workflowName}` });
      const minimalYaml = stringifyYaml({ name, stages: [] });
      const { runId } = createRun(projectDir, workflowName, minimalYaml, []);
      const state = readRunState(projectDir, runId);
      state.status = 'pending';
      state.taskDescription = name;
      state.parentTaskId = req.params.id;
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

  // 11. Discuss setup (cached with mtime invalidation)
  let cachedAdapter: Adapter | null = null;
  let cachedAgentConfig: AgentConfig | null = null;
  let cachedAgentConfigMtime = 0;
  let cachedBaseMdMtime = 0;
  let cachedSkillContent: string | null = null;

  async function ensureDiscussSetup(): Promise<{ adapter: Adapter; agentConfig: AgentConfig; skillContent: string }> {
    if (!cachedAdapter) {
      if (options.adapter) {
        cachedAdapter = options.adapter;
      } else {
        cachedAdapter = await resolveAdapter(configDir);
      }
    }
    // Invalidate agent config cache when discussion.yaml or _base.md change
    let needsReload = !cachedAgentConfig;
    if (cachedAgentConfig && !options.agentConfig) {
      try {
        const agentMtime = statSync(join(agentsDir, 'discussion.yaml')).mtimeMs;
        if (agentMtime !== cachedAgentConfigMtime) needsReload = true;
      } catch { /* file missing — reload to pick up fallback */ needsReload = true; }
      try {
        const baseMtime = statSync(join(agentsDir, '_base.md')).mtimeMs;
        if (baseMtime !== cachedBaseMdMtime) needsReload = true;
      } catch { /* no _base.md */ }
    }
    if (needsReload) {
      if (options.agentConfig) {
        cachedAgentConfig = options.agentConfig;
      } else {
        const agentPath = join(agentsDir, 'discussion.yaml');
        let parsed: any;
        try {
          parsed = parseYaml(readFileSync(agentPath, 'utf-8'));
          cachedAgentConfigMtime = statSync(agentPath).mtimeMs;
        } catch { parsed = null; }
        if (!parsed) {
          const fallback = join(agentsDir, 'planner.yaml');
          try { parsed = parseYaml(readFileSync(fallback, 'utf-8')); } catch { parsed = null; }
        }
        if (!parsed) {
          throw new Error('No agent config found. Run `flowcrew init` to create config/agents/discussion.yaml');
        }
        cachedAgentConfig = parseAgentConfig(parsed, configDir);
        // Apply _base.md prompt to discussion agent (same as scheduler does for all agents)
        const basePrompt = loadBasePrompt(agentsDir);
        if (basePrompt) cachedAgentConfig = applyBasePrompt(cachedAgentConfig, basePrompt);
        try { cachedBaseMdMtime = statSync(join(agentsDir, '_base.md')).mtimeMs; } catch { cachedBaseMdMtime = 0; }
      }
    }
    if (!cachedSkillContent) {
      cachedSkillContent = options.skillContent ?? (() => { try { return readFileSync(join(configDir, 'skills', 'deep-interview.md'), 'utf-8'); } catch { return ''; } })();
    }
    return { adapter: cachedAdapter!, agentConfig: cachedAgentConfig!, skillContent: cachedSkillContent! };
  }

  // --- Binary framing helpers ---
  function sendData(socket: { send: (data: Buffer | Uint8Array) => void }, data: string) {
    const buf = Buffer.from(data, "utf-8");
    socket.send(Buffer.concat([Buffer.from([0x00]), buf]));
  }
  function sendControl(socket: { send: (data: Buffer | Uint8Array) => void }, obj: unknown) {
    socket.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(obj))]));
  }
  function parseFrame(raw: Buffer): { tag: number; payload: Buffer } {
    if (raw.length === 0) return { tag: -1, payload: Buffer.alloc(0) };
    return { tag: raw[0], payload: raw.slice(1) };
  }

  function isValidTaskBrief(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 50) return false;
    const requiredMarkers = [
      /task\s+summary|summary|objective|goals?|overview|purpose|what\s+to\s+(build|do|implement)|description|background|context/i,
      /requirements?|deliverables?|features?|what\s+we\s+need|expected\s+output|expected\s+behavior/i,
      /scope|boundaries|out\s+of\s+scope|in\s+scope|target\s+files?|affected\s+files?/i,
      /constraints?|limitations?|assumptions?|non[- ]?functional|technical\s+notes?|notes?/i,
      /acceptance\s+criteria|success\s+criteria|done\s+when|definition\s+of\s+done|how\s+to\s+verify|verification|test\s+plan/i,
    ];
    // Require at least 2 of 5 sections (lenient to avoid blocking valid briefs)
    const matched = requiredMarkers.filter((marker) => marker.test(trimmed)).length;
    return matched >= 2;
  }

  // 11a. WS /api/discuss/ws — interactive terminal session with reconnect + binary framing
  app.get<{ Querystring: { taskId: string } }>('/api/discuss/ws', { websocket: true }, async (socket, req) => {
    try {
    const taskId = req.query.taskId;
    const runDir = join(runsRoot(), taskId);
    const sessionDir = join(runDir, 'discuss');
    mkdirSync(sessionDir, { recursive: true });

    // WebSocket keepalive: ping every 30s, close if no pong within 10s
    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) { try { socket.close(); } catch { /* ignore */ } clearInterval(pingInterval); return; }
      pongReceived = false;
      try { socket.ping(); } catch { /* closed */ }
    }, 30_000);
    socket.on('pong', () => { pongReceived = true; });
    socket.on('close', () => { clearInterval(pingInterval); });

    let ptyEntry = ptySessions.get(taskId);

    // Reconnect to existing live session
    if (ptyEntry && ptyEntry.alive) {
      // Update active socket reference — old socket's sends will no-op
      ptyEntry.activeSocket = socket;
      // Replay buffered output as binary frames
      for (const chunk of ptyEntry.outputBuffer) {
        try { sendData(socket, chunk); } catch { /* closed */ }
      }

      socket.on('message', (raw: Buffer | string) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, 'binary');
        const { tag, payload } = parseFrame(buf);
        if (tag === 0x01) {
          try {
            const parsed = JSON.parse(payload.toString());
            if (parsed.type === 'generate_plan') {
              startPlanPolling(ptyEntry!, taskId, runDir, socket);
              return;
            }
            if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
              ptyEntry!.session.resize(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
              return;
            }
          } catch { /* malformed */ }
        } else if (tag === 0x00) {
          if (ptyEntry!.alive) ptyEntry!.session.write(payload.toString('utf-8'));
        }
      });

      socket.on('close', () => {
        // Clear active socket on disconnect so stale sends don't error
        if (ptyEntry?.activeSocket === socket) {
          ptyEntry.activeSocket = null;
          ptyEntry.planPollCleanup?.();
        }
      });
      return;
    }

    // New session — deferred PTY spawn (wait for first resize)
    const oldBuffer = ptyEntry ? ptyEntry.outputBuffer : [];

    let spawned = false;

    async function spawnPty(cols: number, rows: number) {
      if (spawned) return;
      spawned = true;
      let adapter: Adapter;
      let agentConfig: AgentConfig;
      try {
        ({ adapter, agentConfig } = await ensureDiscussSetup());
      } catch (err) {
        spawned = false; // allow retry on next resize
        throw err;
      }
      let discussAgent: AgentConfig = agentConfig;
      try {
        const runState = readRunState(projectDir, taskId);
        if (runState.campaignId || runState.campaignStorageKey || runState.campaignName) {
          const storageKey = runState.campaignStorageKey ?? runState.campaignId ?? runState.campaignName;
          const campCtx = buildCampaignContext(projectDir, storageKey!, taskId, runState.campaignName ?? runState.campaignId);
          discussAgent = withCampaignContextPrompt(discussAgent, campCtx);
        }
      } catch { /* no run state yet */ }
      let session: import('./adapters/base.js').InteractiveSession;
      try {
        session = await adapter.spawnInteractive(discussAgent, { workDir: projectDir, sessionDir, cols, rows });
      } catch (err) {
        spawned = false; // allow retry on next resize
        throw err;
      }
      ptyEntry = { session, outputBuffer: [...oldBuffer], alive: true, planPolling: false, activeSocket: socket };
      ptySessions.set(taskId, ptyEntry);

      for (const chunk of oldBuffer) {
        try { sendData(socket, chunk); } catch { /* closed */ }
      }

      // Inject task name as initial message so the discussion agent has context
      try {
        const runState = readRunState(projectDir, taskId);
        if (runState.taskDescription?.trim()) {
          // Small delay to let the agent's prompt render first
          setTimeout(() => injectInitialTuiMessage(session, runState.taskDescription!.trim()), 1500);
        }
      } catch { /* no run state yet */ }

      let ptyBufferBytes = 0;
      const PTY_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2MB cap
      session.onData((data: string) => {
        ptyEntry!.outputBuffer.push(data);
        ptyBufferBytes += data.length;
        // Cap buffer by total bytes to prevent unbounded memory growth
        while (ptyBufferBytes > PTY_BUFFER_MAX_BYTES && ptyEntry!.outputBuffer.length > 1) {
          const removed = ptyEntry!.outputBuffer.shift()!;
          ptyBufferBytes -= removed.length;
        }
        // Send to active socket only — avoids duplicate sends on reconnect
        const sock = ptyEntry!.activeSocket;
        if (sock) { try { sendData(sock, data); } catch { /* closed */ } }
      });
      session.onExit((exitCode) => {
        ptyEntry!.alive = false;
        const sock = ptyEntry!.activeSocket;
        if (sock) { try { sendControl(sock, { type: 'done', exitCode }); } catch { /* closed */ } }
      });
    }

    socket.on('message', async (raw: Buffer | string) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, 'binary');
      const { tag, payload } = parseFrame(buf);
      if (tag === 0x01) {
        let parsed: any;
        try { parsed = JSON.parse(payload.toString()); } catch { return; }
        try {
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            if (!spawned) {
              await spawnPty(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
            } else if (ptyEntry?.alive) {
              ptyEntry.session.resize(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
            }
            return;
          }
          if (parsed.type === 'generate_plan') {
            if (ptyEntry) startPlanPolling(ptyEntry, taskId, runDir, socket);
            else try { sendControl(socket, { type: 'brief_not_ready', message: 'Discussion session is still starting. Wait for the terminal to load, then try again.' }); } catch { /* closed */ }
            return;
          }
        } catch (err) {
          try { sendControl(socket, { type: 'error', message: String(err) }); } catch { /* ignore */ }
          socket.close();
        }
      } else if (tag === 0x00) {
        if (ptyEntry?.alive) ptyEntry.session.write(payload.toString('utf-8'));
      }
    });

    socket.on('close', () => {
      if (ptyEntry?.activeSocket === socket) {
        ptyEntry.activeSocket = null;
        ptyEntry.planPollCleanup?.();
      }
    });
    } catch (err) {
      try { sendControl(socket, { type: 'error', message: String(err) }); } catch { /* ignore */ }
      socket.close();
    }
  });

  function startPlanPolling(ptyEntry: PtySession, taskId: string, runDir: string, socket: { send: (data: Buffer | Uint8Array) => void }) {
    if (ptyEntry.planPolling) return;
    if (!ptyEntry.alive) {
      try { sendControl(socket, { type: 'brief_not_ready', message: 'Discussion session has ended. Start a new discussion first.' }); } catch { /* closed */ }
      return;
    }
    ptyEntry.planPolling = true;
    options.onPlanPollingStart?.(taskId);
    mkdirSync(runDir, { recursive: true });
    const briefPath = join(runDir, 'task_brief.md');
    try {
      if (existsSync(briefPath)) unlinkSync(briefPath);
    } catch { /* ignore stale brief cleanup failure */ }
    const requestStartMs = Date.now();
    const cmd = `Generate a plan only if ready. Review the current discussion and decide whether it contains a sufficiently clear, user-confirmed task brief or clearly agreed final scope. If it is ready, write a new task brief to ${runDir}/task_brief.md with these sections: Task Summary, Requirements, Scope, Constraints, and Acceptance Criteria. If it is unclear or not confirmed, do not write task_brief.md; instead ask the missing clarifying questions in the terminal.`;
    injectInitialTuiMessage(ptyEntry.session, cmd);
    let stableCount = 0;
    let lastSize = -1;
    let finished = false;
    let pollInterval: ReturnType<typeof setInterval>;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const finish = (type: 'plan_ready' | 'brief_not_ready', message?: string) => {
      if (finished) return;
      finished = true;
      ptyEntry.planPolling = false;
      ptyEntry.planPollCleanup = undefined;
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
      try { sendControl(socket, message ? { type, message } : { type }); } catch { /* closed */ }
    };
    let invalidAttempts = 0;
    pollInterval = setInterval(() => {
      // Stop polling if PTY session died
      if (!ptyEntry.alive) {
        finish('brief_not_ready', 'Discussion session ended before the task brief was written.');
        return;
      }
      try {
        if (existsSync(briefPath)) {
          const stat = statSync(briefPath);
          if (stat.mtimeMs < requestStartMs) return;
          if (stat.size > 0 && stat.size === lastSize) {
            stableCount++;
            if (stableCount >= 2) {
              const briefContent = readFileSync(briefPath, 'utf-8');
              if (isValidTaskBrief(briefContent)) {
                finish('plan_ready');
              } else {
                try { unlinkSync(briefPath); } catch { /* ignore invalid brief cleanup failure */ }
                stableCount = 0;
                lastSize = -1;
                invalidAttempts++;
                if (invalidAttempts >= 2) {
                  finish('brief_not_ready', 'The task brief is missing required sections (need at least 2 of: Summary, Requirements, Scope, Constraints, Acceptance Criteria). Clarify these in Discussion and try again.');
                } else if (ptyEntry.alive) {
                  // Tell the agent the brief was rejected so it can fix it
                  const retryMsg = `The task brief you wrote was rejected — it needs at least 2 of these sections: Task Summary, Requirements, Scope, Constraints, Acceptance Criteria. Please rewrite ${briefPath} with the missing sections.`;
                  injectInitialTuiMessage(ptyEntry.session, retryMsg);
                }
              }
            }
          } else { stableCount = 0; lastSize = stat.size; }
        }
      } catch { /* file doesn't exist yet */ }
    }, 1000);
    timeoutHandle = setTimeout(() => finish('brief_not_ready', 'No confirmed task brief was produced. Continue discussion until the task brief is clear and confirmed, then try Generate Plan again.'), 120000);
    ptyEntry.planPollCleanup = () => {
      if (finished) return;
      finished = true;
      ptyEntry.planPolling = false;
      ptyEntry.planPollCleanup = undefined;
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
    };
  }

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
        timeout_ms: s.timeout_ms ?? config.defaults.timeout_ms ?? defaults.timeoutMs,
        max_retries: s.max_retries ?? config.defaults.max_retries ?? defaults.stageTechnicalRetries,
      }));
    } catch (err) {
      return reply.code(404).send({ error: `workflow not found: ${workflow}` });
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
    return { projectDir, adapter: defaults.adapter ?? 'codex', workflows, skills, port, ...defaults };
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE')) {
      console.error(`❌ Port ${port} is already in use. Either stop the other process or use a different port:`);
      console.error(`   PORT=${port + 1} flowcrew start`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Dashboard running at http://localhost:${port}/`);

  // Graceful shutdown: kill all PTY sessions and stop timers
  const cleanup = () => {
    clearInterval(staleTimer);
    for (const [, pty] of ptySessions) {
      pty.planPollCleanup?.();
      if (pty.alive) { try { pty.session.kill(); } catch { /* ignore */ } }
    }
    ptySessions.clear();
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return app;
}
