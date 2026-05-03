// Module: worker
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { buildStagePrompt } from './handoff.js';
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

  const resolvedRole = { ...opts.role, prompt: opts.role.prompt
    .replace(/\{available_roles\}/g, opts.availableRoles ?? '')
    .replace(/\{available_skills\}/g, opts.availableSkills ?? 'none')
    .replace(/\{run_dir\}/g, opts.runDir)
    .replace(/\{project\}/g, opts.projectDir)
    .replace(/\{default_timeout_ms\}/g, getDefaultTimeout(opts.projectDir))
  };

  const kgPath = join(opts.runDir, 'knowledge_graph.json');
  const beforeSnapshot = snapshotMtimes(opts.projectDir, [kgPath]);

  let result = await adapter.run(prompt, resolvedRole, {
    timeout_ms: opts.timeout_ms,
    workDir: opts.projectDir,
    runDir: opts.runDir,
    stageId: opts.stageId,
  });

  // Adapter error detection + exponential backoff retry
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
    if (result.exitCode !== 0 && isAdapterError(result.output)) {
      result.adapterError = true;
    }
  }

  // Detect timeout: exit 124 (timeout signal) or 137 (SIGKILL), or duration >= timeout
  const timedOut = result.exitCode === 124 || result.exitCode === 137 ||
    (result.duration_ms >= opts.timeout_ms && result.exitCode !== 0);
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
    error: result.exitCode !== 0 ? (result.adapterError ? 'adapter connection failed' : result.timedOut ? `timed out after ${Math.round(opts.timeout_ms / 1000)}s` : `Exit code ${result.exitCode}`) : undefined,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    kgChanged: artifacts.some(a => a.endsWith('knowledge_graph.json')),
  };
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, final);

  return result;
}
