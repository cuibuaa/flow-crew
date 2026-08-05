import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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
  /** Bounded re-plan budget for a plan (dynamic_dispatch) stage that exits 0 but emits zero valid injected stages. See defaults.yaml. */
  plan_stage_retries: number;
  /** Max times a supervisor REJECT verdict can force a single deliverable to be re-worked before the engine stops re-rejecting. See defaults.yaml. */
  supervisor_max_rejects: number;
  model: string;
  reasoning_effort: string;
  adapter: string;
  /** UUID-scoped cross-stage Codex resume. Defaults off until measured benefit justifies enabling. */
  sessionReuse: boolean;
  paths: FlowCrewPaths;
  /** Default campaign name for runs in this project; can be overridden by `flowcrew quick --campaign <name>`. */
  campaign?: string;
}

export interface SupervisorConfig {
  enabled: boolean;
  adapter: string;
  model: string;
  reasoningEffort: string;
  /** Cheap state/output heartbeat cadence. */
  pollIntervalMs: number;
  /** Minimum cadence between ordinary semantic LLM assessments. */
  routineAssessmentIntervalMs: number;
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

const DEFAULT_SUPERVISOR: SupervisorConfig = {
  enabled: false,
  adapter: '',
  // 'default' resolves through the adapter chain (project pin > user's global
  // codex config > CLI built-in). Never hardcode a vendor model here: this
  // fallback previously said 'sonnet', which the codex backend would 400 on
  // if the defaults.yaml fallback chain ever failed to supply a model.
  model: 'default',
  // ROLE default, deliberately NOT inherited from the work-agent/global effort:
  // assess() runs under a 30s adapter timeout and verdicts are simple
  // WAIT/ABORT judgments — an inherited global 'max' would risk timing out
  // every tick and silently un-steering the run. This is a role property, not
  // a mirror of external config, so it cannot go stale; override with
  // supervisor.reasoning_effort in defaults.yaml if you want a smarter judge.
  reasoningEffort: 'low',
  pollIntervalMs: 30000,
  // Historical GUIDE→ABORT case lasted 2789s. Even allowing 30s per call,
  // 180s routine spacing yields floor(2789/210)=13 opportunities for the
  // observed 10 GUIDE decisions plus final ABORT.
  routineAssessmentIntervalMs: 180000,
  cooldownAfterActionMs: 60000,
  // Budget: refills each time the campaign advances to a new iteration.
  // Sized so a typical iteration (plan→implement→qa→fix loop, often 1-3h)
  // gets steady-state coverage; adaptive backoff handles quiet phases.
  maxAssessmentsPerIteration: 20,
  tailBytes: 16384,
  minDeltaBytes: 4096,
  // 10-min idle threshold before supervisor is allowed to ABORT. Codex agents
  // often spend several minutes silently editing files via tool calls; the
  // older 5-min default produced false-positive aborts mid-implementation.
  stuckThresholdMs: 600_000,
};

// --- Cache ---

let _cache: ProjectDefaults | null = null;
let _cacheMtime = 0;
let _cachePath = '';
let _sourceDefaultsRaw: Record<string, unknown> | null = null;

function defaultsPath(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), 'config', 'defaults.yaml');
}

function flowCrewDefaultsPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, '..', 'config', 'defaults.yaml'),
    join(process.cwd(), 'config', 'defaults.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`FlowCrew default config template not found. Expected one of: ${candidates.join(', ')}`);
}

function readYamlFile(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function sourceDefaultsRaw(): Record<string, unknown> {
  if (_sourceDefaultsRaw) return _sourceDefaultsRaw;
  _sourceDefaultsRaw = readYamlFile(flowCrewDefaultsPath());
  return _sourceDefaultsRaw;
}

export function ensureProjectDefaultsFile(projectDir?: string): string {
  const target = defaultsPath(projectDir);
  if (existsSync(target)) return target;

  const source = flowCrewDefaultsPath();
  try {
    mkdirSync(dirname(target), { recursive: true });
    if (resolve(source) !== resolve(target)) {
      // The repository may carry a local default campaign while it is being
      // developed. That operator-specific choice is not part of the package
      // template: a new project should derive its campaign from its own
      // directory unless the user explicitly configures one.
      const publicDefaults = readYamlFile(source);
      delete publicDefaults.campaign;
      writeFileSync(target, stringifyYaml(publicDefaults), 'utf-8');
    }
    return target;
  } catch {
    // Unwritable project dir (read-only / sandboxed). This is a READ path
    // (getDefaultTimeout → buildStagePrompt) — fall back to the packaged defaults
    // rather than crashing prompt assembly.
    return source;
  }
}

function readRaw(projectDir?: string): Record<string, unknown> {
  return readYamlFile(ensureProjectDefaultsFile(projectDir));
}

function numberValue(raw: Record<string, unknown>, template: Record<string, unknown>, key: string): number {
  const value = raw[key] ?? template[key];
  if (typeof value !== 'number') throw new Error(`config/defaults.yaml missing numeric ${key}`);
  return value;
}

function stringValue(raw: Record<string, unknown>, template: Record<string, unknown>, key: string): string {
  const value = raw[key] ?? template[key];
  if (typeof value !== 'string' || !value) throw new Error(`config/defaults.yaml missing string ${key}`);
  return value;
}

function booleanValue(raw: Record<string, unknown>, template: Record<string, unknown>, key: string): boolean {
  const value = raw[key] ?? template[key];
  if (typeof value !== 'boolean') throw new Error(`config/defaults.yaml missing boolean ${key}`);
  return value;
}

// --- Public API: Project Defaults ---

export function loadProjectDefaults(projectDir?: string): ProjectDefaults {
  const p = ensureProjectDefaultsFile(projectDir);
  const mtime = statSync(p).mtimeMs;
  if (_cache && mtime === _cacheMtime && p === _cachePath) return _cache;
  _cacheMtime = mtime;
  _cachePath = p;

  const raw = readRaw(projectDir);
  const template = sourceDefaultsRaw();
  const rawPaths = raw.paths as Partial<FlowCrewPaths> | undefined;
  const templatePaths = template.paths as Partial<FlowCrewPaths> | undefined;
  _cache = {
    timeout_ms: numberValue(raw, template, 'default_timeout_ms'),
    max_iterations: numberValue(raw, template, 'default_max_iterations'),
    gate_retry_loops: numberValue(raw, template, 'default_gate_retry_loops'),
    stage_technical_retries: numberValue(raw, template, 'default_stage_technical_retries'),
    plan_stage_retries: numberValue(raw, template, 'default_plan_stage_retries'),
    supervisor_max_rejects: numberValue(raw, template, 'default_supervisor_max_rejects'),
    model: stringValue(raw, template, 'model'),
    reasoning_effort: stringValue(raw, template, 'reasoning_effort'),
    adapter: stringValue(raw, template, 'adapter'),
    sessionReuse: booleanValue(raw, template, 'session_reuse'),
    paths: { ...DEFAULT_PATHS, ...templatePaths, ...rawPaths },
    campaign: typeof raw.campaign === 'string' && raw.campaign ? raw.campaign : undefined,
  };
  return _cache;
}

/** Per-process measurement override; only literal 0/1 are accepted. */
export function isSessionReuseEnabled(projectDir?: string): boolean {
  const override = process.env.FC_SESSION_REUSE;
  if (override === '0') return false;
  if (override === '1') return true;
  return loadProjectDefaults(projectDir).sessionReuse;
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
    // adapter / model fall back to top-level defaults.yaml when not explicitly
    // set under the `supervisor:` block. reasoning_effort deliberately does NOT
    // inherit the work-agent effort — it falls to the supervisor's own role
    // default (see DEFAULT_SUPERVISOR.reasoningEffort): the 30s assess timeout
    // makes an inherited global 'max' a silent supervisor-killer.
    adapter: fallbackString(sup.adapter, projectDefaults.adapter),
    model: fallbackString(sup.model, projectDefaults.model),
    reasoningEffort: fallbackString(sup.reasoning_effort, DEFAULT_SUPERVISOR.reasoningEffort),
    pollIntervalMs: (sup.poll_interval_ms as number) ?? DEFAULT_SUPERVISOR.pollIntervalMs,
    routineAssessmentIntervalMs: (sup.routine_assessment_interval_ms as number) ?? DEFAULT_SUPERVISOR.routineAssessmentIntervalMs,
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
  _sourceDefaultsRaw = null;
}
