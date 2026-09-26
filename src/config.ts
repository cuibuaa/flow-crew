import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isRecognizedLiveConstraintExemptPattern } from './generated-path-policy.js';

// --- Types ---

export interface FlowCrewPaths {
  agents: string;
  workflows: string;
  skills: string;
  docs: string;
}

export interface ProjectDefaults {
  timeout_ms: number;
  /** Wall clock a single validation command (build/test/lint) may take before it
   * is killed. A project's suite grows as rounds add tests, and ship-setup runs
   * the suite twice -- source baseline and target baseline -- so this has to
   * exceed the slowest of them under whatever else the machine is doing. See
   * defaults.yaml. */
  validation_timeout_ms: number;
  /** Project-level regenerated-tool output ignored by the live guard only when untracked. */
  live_constraint_exempt_patterns: string[];
  /** Portable full-tree reconciliation cadence when recursive watching is unavailable. */
  live_constraint_fallback_scan_ms: number;
  /** Longest interval without a completed live-constraint scan. */
  live_constraint_monitor_deadline_ms: number;
  /** Scheduler-loop progress publication cadence. */
  scheduler_heartbeat_interval_ms: number;
  /** Nonadvancing duration before the independent observer warns. */
  scheduler_stall_threshold_ms: number;
  /** Independent observer polling cadence. */
  scheduler_stall_observer_poll_ms: number;
  /** Dedicated bound for potentially large `git worktree add` checkouts. */
  git_worktree_add_timeout_ms: number;
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
  /** Minimum gap after a successful WAIT on a concurrent-stage artifact event;
   * all other deterministic events remain immediate. */
  routineAssessmentIntervalMs: number;
  cooldownAfterActionMs: number;
  /** Per-iteration assessment count shown in telemetry; not a call limit. */
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
  // Accumulated stage output that triggers a content review. 4096 fired on
  // nearly every 30 s heartbeat of a busy stage (each reads up to tailBytes);
  // measured on 2026-09-26, runs at 98304 made about a quarter of the
  // supervisor calls per hour and a third of the uncached input. Kept equal to
  // config/defaults.yaml so a project that omits the key gets the same value.
  minDeltaBytes: 98304,
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

function positiveNumberValue(raw: Record<string, unknown>, template: Record<string, unknown>, key: string): number {
  const value = numberValue(raw, template, key);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`config/defaults.yaml ${key} must be a positive finite number`);
  }
  return Math.floor(value);
}

function liveConstraintExemptPatternsValue(
  raw: Record<string, unknown>,
  template: Record<string, unknown>,
): string[] {
  const key = 'live_constraint_exempt_patterns';
  const value = raw[key] ?? template[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new Error(`config/defaults.yaml ${key} must be an array of non-empty strings`);
  }
  const patterns = [...new Set(value.map((entry) => String(entry).trim().replace(/\\/g, '/')))];
  for (const pattern of patterns) {
    const segments = pattern.split('/');
    const recognizedGeneratedPattern = isRecognizedLiveConstraintExemptPattern(pattern);
    if (
      pattern.startsWith('/')
      || /^[A-Za-z]:\//.test(pattern)
      || segments.includes('..')
      || !recognizedGeneratedPattern
    ) {
      throw new Error(
        `config/defaults.yaml ${key} contains unsafe non-cache pattern ${JSON.stringify(pattern)}`,
      );
    }
  }
  return patterns;
}

// --- Public API: Project Defaults ---

/**
 * Directory whose basename names the default campaign.
 *
 * A linked git worktree has its own basename, so deriving the campaign from
 * projectDir gave every worktree a campaign of its own and split one line of
 * work across as many campaigns as there were worktrees — auditing "what did
 * this project actually try" then meant opening all of them. Worktrees of one
 * repository are one project, so they resolve to the main worktree.
 *
 * The rule is therefore "the campaign of a repository is the repository": any
 * directory inside one resolves to its main worktree. A checkout's own root is
 * unchanged, and so is the common case of running from it. Two cases do move:
 * a linked worktree (the bug this fixes) and a subdirectory of a repository,
 * which previously took the subdirectory's name — `repo/src/deep` gave
 * `deep`, and now gives `repo`.
 *
 * A non-repository, or any git failure, falls back to projectDir. An explicit
 * --campaign or defaults.yaml::campaign still wins over all of this.
 *
 * `readCommonDir` exists so tracked tests can drive the path arithmetic without
 * building real repositories on the host — the project forbids host
 * child-process use in tracked tests. Real-git behaviour is what the default
 * encodes: `--git-common-dir` prints a relative `.git` from an ordinary
 * checkout and an absolute path to the main repository's `.git` from a linked
 * worktree.
 */
export interface CampaignBaseDirectoryOptions {
  readCommonDir?: (projectDir: string) => string;
}

export function campaignBaseDirectory(
  projectDir: string,
  options: CampaignBaseDirectoryOptions = {},
): string {
  const readCommonDir = options.readCommonDir ?? ((cwd: string) => execFileSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
  ));
  try {
    const commonDir = readCommonDir(projectDir).trim();
    if (!commonDir) return projectDir;
    // `--git-common-dir` is relative to cwd when the repo is not a worktree.
    const absoluteCommonDir = resolve(projectDir, commonDir);
    const mainWorktree = dirname(absoluteCommonDir);
    return mainWorktree && mainWorktree !== '.' ? mainWorktree : projectDir;
  } catch {
    return projectDir;
  }
}

/** Validate with this module's schema/template without delegating to a
 * candidate worktree. Exported for the isolated candidate-validator process. */
export function loadProjectDefaultsLocally(projectDir?: string): ProjectDefaults {
  const p = ensureProjectDefaultsFile(projectDir);
  const mtime = statSync(p).mtimeMs;
  if (_cache && mtime === _cacheMtime && p === _cachePath) return _cache;

  const raw = readRaw(projectDir);
  const template = sourceDefaultsRaw();
  const rawPaths = raw.paths as Partial<FlowCrewPaths> | undefined;
  const templatePaths = template.paths as Partial<FlowCrewPaths> | undefined;
  const parsed: ProjectDefaults = {
    timeout_ms: numberValue(raw, template, 'default_timeout_ms'),
    validation_timeout_ms: numberValue(raw, template, 'default_validation_timeout_ms'),
    live_constraint_exempt_patterns: liveConstraintExemptPatternsValue(raw, template),
    live_constraint_fallback_scan_ms: positiveNumberValue(raw, template, 'live_constraint_fallback_scan_ms'),
    live_constraint_monitor_deadline_ms: positiveNumberValue(raw, template, 'live_constraint_monitor_deadline_ms'),
    scheduler_heartbeat_interval_ms: positiveNumberValue(raw, template, 'scheduler_heartbeat_interval_ms'),
    scheduler_stall_threshold_ms: positiveNumberValue(raw, template, 'scheduler_stall_threshold_ms'),
    scheduler_stall_observer_poll_ms: positiveNumberValue(raw, template, 'scheduler_stall_observer_poll_ms'),
    git_worktree_add_timeout_ms: positiveNumberValue(raw, template, 'git_worktree_add_timeout_ms'),
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
  // Commit the cache key only after the file has parsed and validated. If an
  // edit is malformed, every read must keep reporting that error rather than
  // treating a previous value as the cache entry for the broken mtime.
  _cache = parsed;
  _cacheMtime = mtime;
  _cachePath = p;
  return parsed;
}

function compatibleCandidateDefaults(value: unknown): value is ProjectDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<ProjectDefaults>;
  const positiveNumbers = [
    item.timeout_ms, item.validation_timeout_ms, item.live_constraint_fallback_scan_ms,
    item.live_constraint_monitor_deadline_ms, item.scheduler_heartbeat_interval_ms,
    item.scheduler_stall_threshold_ms, item.scheduler_stall_observer_poll_ms,
    item.git_worktree_add_timeout_ms,
  ];
  const nonnegativeNumbers = [
    item.max_iterations, item.gate_retry_loops, item.stage_technical_retries,
    item.plan_stage_retries, item.supervisor_max_rejects,
  ];
  return positiveNumbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
    && nonnegativeNumbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
    && typeof item.model === 'string' && item.model.length > 0
    && typeof item.reasoning_effort === 'string' && item.reasoning_effort.length > 0
    && typeof item.adapter === 'string' && item.adapter.length > 0
    && typeof item.sessionReuse === 'boolean'
    && Array.isArray(item.live_constraint_exempt_patterns)
    && item.live_constraint_exempt_patterns.every((entry) => typeof entry === 'string')
    && Boolean(item.paths && Object.values(item.paths).every((entry) => typeof entry === 'string' && entry.length > 0));
}

function candidateDefaults(projectDir: string): ProjectDefaults | undefined {
  if (process.env.FC_CONFIG_VALIDATOR_HANDSHAKE === '1') return undefined;
  const root = resolve(projectDir);
  const candidateConfig = join(root, 'src', 'config.ts');
  const validator = join(root, 'scripts', 'validate-project-defaults.ts');
  if (!existsSync(candidateConfig) || !existsSync(validator)) return undefined;
  if (resolve(fileURLToPath(import.meta.url)) === resolve(candidateConfig)) return undefined;
  let response: unknown;
  try {
    const tsxLoader = createRequire(import.meta.url).resolve('tsx');
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, validator, root], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, FC_CONFIG_VALIDATOR_HANDSHAKE: '1' },
    });
    response = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`Candidate configuration validator failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const envelope = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined;
  if (!envelope || envelope.version !== 1 || envelope.ok !== true || !compatibleCandidateDefaults(envelope.defaults)) {
    const reason = typeof envelope?.error === 'string' ? envelope.error : 'candidate returned an incompatible defaults payload';
    throw new Error(`Candidate configuration validator refused config/defaults.yaml: ${reason}`);
  }
  return envelope.defaults;
}

/** Engine worktrees validate their coupled defaults with their own candidate
 * module in a bounded child process; ordinary projects retain deployed-schema
 * validation. */
export function loadProjectDefaults(projectDir?: string): ProjectDefaults {
  if (projectDir) {
    const fromCandidate = candidateDefaults(projectDir);
    if (fromCandidate) return fromCandidate;
  }
  return loadProjectDefaultsLocally(projectDir);
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
