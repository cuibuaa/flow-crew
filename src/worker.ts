// Module: worker
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { buildStagePrompt } from './handoff.js';
import {
  writeStageInput,
  writeStageOutput,
  writeStageStatus,
} from './store.js';
import type { StageStatus } from './store.js';

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
  taskDescription?: string;
  isGate?: boolean;
}

const ADAPTER_ERROR_PATTERNS = ['403 Forbidden', 'connection refused', 'ECONNRESET', 'rate limit', 'ETIMEDOUT'];
const ADAPTER_RETRY_DELAYS = [30_000, 60_000, 120_000];

function isAdapterError(output: string): boolean {
  return ADAPTER_ERROR_PATTERNS.some(p => output.includes(p));
}

const SCAN_DIRS = ['src', 'config', 'tests', 'ui/src', 'docs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fc']);

function snapshotMtimes(projectDir: string): Map<string, number> {
  const snap = new Map<string, number>();
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else snap.set(full, st.mtimeMs);
      } catch { /* skip */ }
    }
  }
  for (const d of SCAN_DIRS) {
    const full = join(projectDir, d);
    if (existsSync(full)) walk(full);
  }
  return snap;
}

function diffArtifacts(before: Map<string, number>, projectDir: string): string[] {
  const after = snapshotMtimes(projectDir);
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
    taskDescription: opts.taskDescription,
    isGate: opts.isGate,
    stageId: opts.stageId,
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
    .replace(/\{run_dir\}/g, opts.runDir)
    .replace(/\{project\}/g, opts.projectDir)
  };

  const beforeSnapshot = snapshotMtimes(opts.projectDir);

  let result = await adapter.run(prompt, resolvedRole, {
    timeout_ms: opts.timeout_ms,
    workDir: opts.projectDir,
    runDir: opts.runDir,
    stageId: opts.stageId,
  });

  // Adapter error detection + exponential backoff retry
  if (result.exitCode !== 0 && isAdapterError(result.output)) {
    for (let attempt = 0; attempt < ADAPTER_RETRY_DELAYS.length; attempt++) {
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

  const artifacts = diffArtifacts(beforeSnapshot, opts.projectDir);
  const final: StageStatus = {
    status: result.exitCode === 0 ? 'complete' : 'failed',
    exitCode: result.exitCode,
    duration_ms: result.duration_ms,
    artifacts,
    retries: opts.retries,
    startedAt: running.startedAt,
    completedAt: new Date().toISOString(),
    error: result.exitCode !== 0 ? (result.adapterError ? 'adapter connection failed' : `Exit code ${result.exitCode}`) : undefined,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
  };
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, final);

  return result;
}
