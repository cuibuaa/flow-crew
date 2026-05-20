import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// --- Types ---

export interface FlowCrewPaths {
  agents: string;
  workflows: string;
  skills: string;
  docs: string;
}

export interface ProjectDefaults {
  timeout_ms: number;
  max_iterations: number;
  gate_retry_loops: number;
  stage_technical_retries: number;
  model: string;
  reasoning_effort: string;
  adapter: string;
  paths: FlowCrewPaths;
  /** Default campaign name for runs in this project; can be overridden by `flowcrew quick --campaign <name>`. */
  campaign?: string;
}

export interface SupervisorConfig {
  enabled: boolean;
  adapter: string;
  model: string;
  reasoningEffort: string;
  pollIntervalMs: number;
  cooldownAfterActionMs: number;
  /** Budget: assessments per campaign iteration. Refills when state.currentIteration advances. */
  maxAssessmentsPerIteration: number;
  tailBytes: number;
  minDeltaBytes: number;
  /** Minimum idle duration (ms) before the supervisor is allowed to ABORT a stuck stage. Injected into the supervisor system prompt. */
  stuckThresholdMs: number;
}

// --- Defaults ---

const DEFAULT_PATHS: FlowCrewPaths = {
  agents: 'config/agents',
  workflows: 'config/workflows',
  skills: 'config/skills',
  docs: 'docs',
};

const FALLBACK_DEFAULTS: ProjectDefaults = {
  timeout_ms: 300000,
  max_iterations: 3,
  gate_retry_loops: 1,
  stage_technical_retries: 1,
  model: 'default',
  reasoning_effort: 'default',
  adapter: 'claude',
  paths: DEFAULT_PATHS,
};

const DEFAULT_SUPERVISOR: SupervisorConfig = {
  enabled: false,
  adapter: '',
  model: 'sonnet',
  reasoningEffort: 'default',
  pollIntervalMs: 30000,
  cooldownAfterActionMs: 60000,
  // Budget: refills each time the campaign advances to a new iteration.
  // Sized so a typical iteration (plan→implement→qa→fix loop, often 1-3h)
  // gets steady-state coverage; adaptive backoff handles quiet phases.
  maxAssessmentsPerIteration: 50,
  tailBytes: 16384,
  minDeltaBytes: 200,
  // 10-min idle threshold before supervisor is allowed to ABORT. Codex agents
  // often spend several minutes silently editing files via tool calls; the
  // older 5-min default produced false-positive aborts mid-implementation.
  stuckThresholdMs: 600_000,
};

// --- Cache ---

let _cache: ProjectDefaults | null = null;
let _cacheMtime = 0;
let _cachePath = '';

function defaultsPath(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), 'config', 'defaults.yaml');
}

function readRaw(projectDir?: string): Record<string, unknown> {
  const p = defaultsPath(projectDir);
  if (!existsSync(p)) return {};
  try {
    return parseYaml(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch { /* expected - optional resource */
    return {};
  }
}

// --- Public API: Project Defaults ---

export function loadProjectDefaults(projectDir?: string): ProjectDefaults {
  const p = defaultsPath(projectDir);
  try {
    const mtime = statSync(p).mtimeMs;
    if (_cache && mtime === _cacheMtime && p === _cachePath) return _cache;
    _cacheMtime = mtime;
    _cachePath = p;
  } catch { /* expected - optional resource */
    return FALLBACK_DEFAULTS;
  }

  const raw = readRaw(projectDir);
  const rawPaths = raw.paths as Partial<FlowCrewPaths> | undefined;
  _cache = {
    timeout_ms: typeof raw.default_timeout_ms === 'number' ? raw.default_timeout_ms : FALLBACK_DEFAULTS.timeout_ms,
    max_iterations: typeof raw.default_max_iterations === 'number' ? raw.default_max_iterations : FALLBACK_DEFAULTS.max_iterations,
    gate_retry_loops: typeof raw.default_gate_retry_loops === 'number' ? raw.default_gate_retry_loops : FALLBACK_DEFAULTS.gate_retry_loops,
    stage_technical_retries: typeof raw.default_stage_technical_retries === 'number' ? raw.default_stage_technical_retries : FALLBACK_DEFAULTS.stage_technical_retries,
    model: typeof raw.model === 'string' ? raw.model : FALLBACK_DEFAULTS.model,
    reasoning_effort: typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : FALLBACK_DEFAULTS.reasoning_effort,
    adapter: typeof raw.adapter === 'string' ? raw.adapter : FALLBACK_DEFAULTS.adapter,
    paths: { ...DEFAULT_PATHS, ...rawPaths },
    campaign: typeof raw.campaign === 'string' && raw.campaign ? raw.campaign : undefined,
  };
  return _cache;
}

export function getDefaultTimeout(projectDir?: string): string {
  return String(loadProjectDefaults(projectDir).timeout_ms);
}

// --- Public API: Supervisor Config ---

export function loadSupervisorConfig(projectDir?: string): SupervisorConfig {
  const raw = readRaw(projectDir);
  const sup = (raw.supervisor as Record<string, unknown> | undefined) ?? {};
  const projectDefaults = loadProjectDefaults(projectDir);
  const fallbackString = (v: unknown, fb: string) => (typeof v === 'string' && v ? v : fb);
  return {
    enabled: sup.enabled === true,
    // adapter / model / reasoning_effort fall back to top-level defaults.yaml when
    // not explicitly set under the `supervisor:` block.
    adapter: fallbackString(sup.adapter, projectDefaults.adapter),
    model: fallbackString(sup.model, projectDefaults.model),
    reasoningEffort: fallbackString(sup.reasoning_effort, projectDefaults.reasoning_effort),
    pollIntervalMs: (sup.poll_interval_ms as number) ?? DEFAULT_SUPERVISOR.pollIntervalMs,
    cooldownAfterActionMs: (sup.cooldown_after_action_ms as number) ?? DEFAULT_SUPERVISOR.cooldownAfterActionMs,
    maxAssessmentsPerIteration: (sup.max_assessments_per_iteration as number) ?? DEFAULT_SUPERVISOR.maxAssessmentsPerIteration,
    tailBytes: (sup.tail_bytes as number) ?? DEFAULT_SUPERVISOR.tailBytes,
    minDeltaBytes: (sup.min_delta_bytes as number) ?? DEFAULT_SUPERVISOR.minDeltaBytes,
    stuckThresholdMs: (sup.stuck_threshold_ms as number) ?? DEFAULT_SUPERVISOR.stuckThresholdMs,
  };
}

// --- Public API: Path Helpers ---

export function getAgentsDir(projectDir?: string): string {
  const d = loadProjectDefaults(projectDir);
  return join(projectDir ?? process.cwd(), d.paths.agents);
}

export function getWorkflowsDir(projectDir?: string): string {
  const d = loadProjectDefaults(projectDir);
  return join(projectDir ?? process.cwd(), d.paths.workflows);
}

export function getSkillsDir(projectDir?: string): string {
  const d = loadProjectDefaults(projectDir);
  return join(projectDir ?? process.cwd(), d.paths.skills);
}

export function getDocsDir(projectDir: string): string {
  const d = loadProjectDefaults(projectDir);
  return join(projectDir, d.paths.docs);
}

export function resetConfigCache(): void {
  _cache = null;
  _cacheMtime = 0;
  _cachePath = '';
}
