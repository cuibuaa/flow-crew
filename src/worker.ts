// Module: worker
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { buildStagePrompt } from './handoff.js';
import { loadProjectDefaults } from './config.js';
import { loadAdapterByName } from './scheduler.js';
import {
  writeStageInput,
  writeStageOutput,
  writeStageStatus,
} from './store.js';
import type { StageStatus } from './store.js';

function getDefaultTimeout(projectDir: string): string {
  try {
    const raw = readFileSync(join(projectDir, 'config', 'defaults.yaml'), 'utf-8');
    const match = raw.match(/default_timeout_ms:\s*(\d+)/);
    if (match) return match[1];
  } catch { /* fallback */ }
  return '300000';
}

interface StageOpts {
  stageId: string;
  role: AgentConfig;
  dependsOn: string[];
  promptTemplate: string;
  timeout_ms: number;
  projectDir: string;
  runId: string;
  runDir: string;
  retries: number;
  skills?: string;
  stageSkills?: string[];
  availableRoles?: string;
  availableSkills?: string;
  taskDescription?: string;
  isGate?: boolean;
}

const ADAPTER_ERROR_PATTERNS = ['403 Forbidden', 'connection refused', 'ECONNREFUSED', 'ECONNRESET', 'rate limit', 'ETIMEDOUT', '429 Too Many', '502 Bad Gateway', '503 Service Unavailable', 'overloaded'];
const ADAPTER_RETRY_DELAYS = [30_000, 60_000, 120_000];

function isAdapterError(output: string): boolean {
  return ADAPTER_ERROR_PATTERNS.some(p => output.includes(p));
}

function inferAdapterName(adapter: Adapter): string | undefined {
  const name = adapter.constructor?.name;
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return lower.endsWith('adapter') ? lower.slice(0, -'adapter'.length) : lower;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fc', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.tox', 'target', 'out', '.gradle']);

function snapshotMtimes(projectDir: string, extraFiles: string[] = []): Map<string, number> {
  const snap = new Map<string, number>();
  function walk(dir: string, depth: number) {
    if (depth > 5) return; // limit depth to avoid scanning huge trees
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else snap.set(full, st.mtimeMs);
      } catch { /* skip */ }
    }
  }
  walk(projectDir, 0);
  for (const file of extraFiles) {
    try {
      const st = statSync(file);
      if (st.isFile()) snap.set(file, st.mtimeMs);
    } catch { /* optional file may not exist yet */ }
  }
  return snap;
}

function diffArtifacts(before: Map<string, number>, projectDir: string, extraFiles: string[] = []): string[] {
  const after = snapshotMtimes(projectDir, extraFiles);
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || mtime > prev) {
      changed.push(relative(projectDir, path));
    }
  }
  return changed;
}

export async function runStage(
  adapter: Adapter,
  opts: StageOpts,
): Promise<RunResult> {
  const skillNames = opts.stageSkills ?? [];
  const prompt = buildStagePrompt({
    dependsOn: opts.dependsOn,
    promptTemplate: opts.promptTemplate,
    projectDir: opts.projectDir,
    runId: opts.runId,
    runDir: opts.runDir,
    skills: opts.skills,
    skillNames,
    availableRoles: opts.availableRoles,
    availableSkills: opts.availableSkills,
    taskDescription: opts.taskDescription,
    isGate: opts.isGate,
    stageId: opts.stageId,
    role: opts.role.name,
  });

  writeStageInput(opts.projectDir, opts.runId, opts.stageId, prompt);

  const running: StageStatus = {
    status: 'running',
    retries: opts.retries,
    startedAt: new Date().toISOString(),
  };
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, running);

  // Auto-prepend task brief to the role's system prompt so the brief sits in
  // a stable prefix position across stages. This:
  //   - Frees `prompt_template` in dispatch.yaml from having to repeat the brief;
  //   - Anthropic prompt caching can deduplicate the brief across stages of the
  //     same role (cache_read_input_tokens benefits) because the system prompt
  //     prefix is byte-identical;
  //   - Codex `developer_instructions` similarly benefits from auto-caching.
  // The brief lives at <run_dir>/task_brief.md and is written by the dispatcher
  // (cli.ts cmdQuick or the dashboard). If absent, we skip prepending.
  let resolvedSystemPrompt = opts.role.prompt
    .replace(/\{available_roles\}/g, opts.availableRoles ?? '')
    .replace(/\{available_skills\}/g, opts.availableSkills ?? 'none')
    .replace(/\{run_dir\}/g, opts.runDir)
    .replace(/\{project\}/g, opts.projectDir)
    .replace(/\{default_timeout_ms\}/g, getDefaultTimeout(opts.projectDir));
  try {
    const taskBriefPath = join(opts.runDir, 'task_brief.md');
    if (existsSync(taskBriefPath)) {
      const brief = readFileSync(taskBriefPath, 'utf-8').trim();
      if (brief) {
        resolvedSystemPrompt = `# Task Brief\n\n${brief}\n\n---\n\n${resolvedSystemPrompt}`;
      }
    }
  } catch { /* non-critical */ }

  // Bug ② fix — planner-only: inject the most-recent archived supervisor
  // guidance from a prior iteration so cross-iteration GUIDE signals still
  // reach the planner even after the iteration-boundary archive in
  // scheduler.ts emptied `supervisor_guidance.md`. Safe by default: missing
  // history dir or empty archive file results in no injection.
  if (opts.role.name === 'planner') {
    try {
      const historyDir = join(opts.runDir, 'guidance_history');
      if (existsSync(historyDir)) {
        const archives = readdirSync(historyDir)
          .filter((f) => /^iter_\d+\.md$/.test(f))
          .sort((a, b) => {
            const na = parseInt(a.match(/\d+/)![0], 10);
            const nb = parseInt(b.match(/\d+/)![0], 10);
            return na - nb;
          });
        if (archives.length > 0) {
          const latest = archives[archives.length - 1];
          const prev = readFileSync(join(historyDir, latest), 'utf-8').trim();
          if (prev) {
            resolvedSystemPrompt = `# Previous iteration's supervisor guidance (cumulative)\n\nThe lines below were emitted by the supervisor across the prior iteration. They represent observations and course-corrections from before this re-plan. Use them to inform this iteration's plan — especially any "do not do X" constraints.\n\n${prev}\n\n---\n\n${resolvedSystemPrompt}`;
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Snapshot the current run-level supervisor guidance (if any) into this
  // stage's directory so we have an audit trail of what the stage saw when
  // it started, even if the live file is later appended to or archived.
  try {
    const guidancePath = join(opts.runDir, 'supervisor_guidance.md');
    if (existsSync(guidancePath)) {
      const stageDirPath = join(opts.runDir, 'stages', opts.stageId);
      mkdirSync(stageDirPath, { recursive: true });
      copyFileSync(guidancePath, join(stageDirPath, 'guidance_consumed.md'));
    }
  } catch { /* non-critical */ }

  const resolvedRole = { ...opts.role, prompt: resolvedSystemPrompt };

  const kgPath = join(opts.runDir, 'knowledge_graph.json');
  const beforeSnapshot = snapshotMtimes(opts.projectDir, [kgPath]);

  // Abort signal poller: supervisor writes signals/abort_<stageId>.json when it
  // emits an ABORT verdict. Worker polls it every 2s and triggers an
  // AbortController that the adapter forwards to the spawned child process.
  // exit code 137 + "[stage aborted by supervisor]" in output signals the
  // supervisor cancellation to downstream stages and the gate.
  //
  // Stale-signal cleanup: a prior attempt may have left the file behind. Without
  // this, retry attempt 2 would self-abort within 2 seconds of starting (read
  // the stale signal and kill itself). Only clean on retries; on the FIRST
  // attempt any present signal is fresh and must be honored.
  const abortController = new AbortController();
  const abortSignalPath = join(opts.runDir, 'signals', `abort_${opts.stageId}.json`);
  let supervisorAborted = false;
  let abortReason = '';
  if (opts.retries > 0) {
    try {
      if (existsSync(abortSignalPath)) unlinkSync(abortSignalPath);
    } catch { /* non-critical */ }
  }
  const abortPollTimer = setInterval(() => {
    try {
      if (existsSync(abortSignalPath) && !abortController.signal.aborted) {
        // Capture reason BEFORE triggering abort so error attribution is accurate.
        try {
          const sig = JSON.parse(readFileSync(abortSignalPath, 'utf-8')) as { reason?: string };
          abortReason = (sig.reason ?? '').slice(0, 240);
        } catch { /* signal file malformed; proceed with empty reason */ }
        supervisorAborted = true;
        abortController.abort();
        try {
          appendFileSync(
            join(opts.runDir, 'stages', opts.stageId, 'live.log'),
            `\nSupervisor ABORT signal observed at ${abortSignalPath}; killing stage child process.\n`,
          );
        } catch { /* ignore */ }
      }
    } catch { /* non-critical */ }
  }, 2000);

  let result: RunResult;
  try {
    result = await adapter.run(prompt, resolvedRole, {
      timeout_ms: opts.timeout_ms,
      workDir: opts.projectDir,
      runDir: opts.runDir,
      stageId: opts.stageId,
      abortSignal: abortController.signal,
    });
  } finally {
    clearInterval(abortPollTimer);
  }

  // Adapter error detection + exponential backoff retry on the SAME adapter
  if (result.exitCode !== 0 && isAdapterError(result.output)) {
    const liveLogPath = join(opts.runDir, 'stages', opts.stageId, 'live.log');
    for (let attempt = 0; attempt < ADAPTER_RETRY_DELAYS.length; attempt++) {
      const delaySec = Math.round(ADAPTER_RETRY_DELAYS[attempt] / 1000);
      try { appendFileSync(liveLogPath, `\n⏳ Adapter error detected — retrying in ${delaySec}s (attempt ${attempt + 2}/${ADAPTER_RETRY_DELAYS.length + 1})…\n`); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, ADAPTER_RETRY_DELAYS[attempt]));
      result = await adapter.run(prompt, resolvedRole, {
        timeout_ms: opts.timeout_ms,
        workDir: opts.projectDir,
        runDir: opts.runDir,
        stageId: opts.stageId,
      });
      if (result.exitCode === 0 || !isAdapterError(result.output)) break;
    }

    // Final escape hatch: if same-adapter retries still hit a rate-limit /
    // capacity error, automatically fall back to the project's default
    // adapter+model (from defaults.yaml). Only triggers when the default
    // adapter differs from the role's primary, so we don't pointlessly retry
    // the same one. Runs once — no further retry on the fallback.
    if (result.exitCode !== 0 && isAdapterError(result.output)) {
      try {
        const projectDefaults = loadProjectDefaults(opts.projectDir);
        const primaryName = opts.role.adapter ?? inferAdapterName(adapter) ?? projectDefaults.adapter;
        const fallbackName = projectDefaults.adapter;
        if (fallbackName && fallbackName !== primaryName) {
          try { appendFileSync(liveLogPath, `\n↩︎ Same-adapter retries exhausted (${primaryName}). Falling back to defaults.yaml adapter=${fallbackName} model=${projectDefaults.model}…\n`); } catch { /* ignore */ }
          const fallbackAdapter = await loadAdapterByName(fallbackName);
          const fallbackRole: AgentConfig = {
            ...resolvedRole,
            adapter: fallbackName,
            model: projectDefaults.model,
            reasoning_effort: projectDefaults.reasoning_effort,
          };
          result = await fallbackAdapter.run(prompt, fallbackRole, {
            timeout_ms: opts.timeout_ms,
            workDir: opts.projectDir,
            runDir: opts.runDir,
            stageId: opts.stageId,
          });
          try { appendFileSync(liveLogPath, `\n↪︎ Fallback ${fallbackName} returned exit=${result.exitCode}.\n`); } catch { /* ignore */ }
        }
      } catch (err) {
        try { appendFileSync(liveLogPath, `\n⚠️  Cross-adapter fallback failed to load: ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* ignore */ }
      }
    }

    if (result.exitCode !== 0 && isAdapterError(result.output)) {
      result.adapterError = true;
    }
  }

  // Detect timeout: exit 124 (timeout signal), or duration >= timeout. exit 137
  // (SIGKILL) is ambiguous; the adapter sends it for BOTH true wall-clock
  // timeouts and supervisor-initiated aborts. Distinguish them via the
  // `supervisorAborted` flag captured by the abort poller above.
  const timedOut = !supervisorAborted && (
    result.exitCode === 124 ||
    result.exitCode === 137 ||
    (result.duration_ms >= opts.timeout_ms && result.exitCode !== 0)
  );
  if (timedOut) result.timedOut = true;

  writeStageOutput(opts.projectDir, opts.runId, opts.stageId, result.output);

  const artifacts = diffArtifacts(beforeSnapshot, opts.projectDir, [kgPath]);
  const final: StageStatus = {
    status: result.exitCode === 0 ? 'complete' : 'failed',
    exitCode: result.exitCode,
    duration_ms: result.duration_ms,
    artifacts,
    retries: opts.retries,
    startedAt: running.startedAt,
    completedAt: new Date().toISOString(),
    error: result.exitCode !== 0
      ? (
        supervisorAborted
          ? (abortReason ? `aborted by supervisor: ${abortReason}` : 'aborted by supervisor')
          : result.adapterError ? 'adapter connection failed'
          : result.timedOut ? `timed out after ${Math.round(opts.timeout_ms / 1000)}s`
          : `Exit code ${result.exitCode}`
      )
      : undefined,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    kgChanged: artifacts.some(a => a.endsWith('knowledge_graph.json')),
  };
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, final);

  return result;
}
