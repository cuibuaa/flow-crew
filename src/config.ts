import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isRecognizedLiveConstraintExemptPattern } from './generated-path-policy.js';

// --- Types ---

export interface EngineDefaults {
  timeout_ms: number;
  /** Longest interval without attempt-bound output, artifact, or process progress. */
  stage_idle_timeout_ms: number;
  /** Wall clock a single validation command (build/test/lint) may take before it
   * is killed. A project's suite grows as rounds add tests, and ship-setup runs
   * the suite twice -- source baseline and target baseline -- so this has to
   * exceed the slowest of them under whatever else the machine is doing. See
   * defaults.yaml. */
  validation_timeout_ms: number;
  /** Untracked tool output excluded from input content and write enforcement. */
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
  model: string;
  reasoning_effort: string;
  adapter: string;
  /** UUID-scoped cross-stage Codex resume. Defaults off until measured benefit justifies enabling. */
  sessionReuse: boolean;
}

/** The installed engine owns configuration; the working directory is irrelevant. */
export const engineConfigDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config');

let _cache: EngineDefaults | null = null;
let _cacheMtime = 0;

function numberValue(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number') throw new Error(`config/defaults.yaml missing numeric ${key}`);
  return value;
}

function stringValue(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value) throw new Error(`config/defaults.yaml missing string ${key}`);
  return value;
}

function booleanValue(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') throw new Error(`config/defaults.yaml missing boolean ${key}`);
  return value;
}

function positiveNumberValue(raw: Record<string, unknown>, key: string): number {
  const value = numberValue(raw, key);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`config/defaults.yaml ${key} must be a positive finite number`);
  }
  return Math.floor(value);
}

function liveConstraintExemptPatternsValue(
  raw: Record<string, unknown>,
): string[] {
  const key = 'live_constraint_exempt_patterns';
  const value = raw[key];
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

// --- Campaign identity ---

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
 * --campaign still wins over all of this.
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

/** Read and validate only the engine's installed defaults. */
export function loadEngineDefaults(): EngineDefaults {
  const p = join(engineConfigDir, 'defaults.yaml');
  const mtime = statSync(p).mtimeMs;
  if (_cache && mtime === _cacheMtime) return _cache;

  const raw = parseYaml(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  const parsed: EngineDefaults = {
    timeout_ms: numberValue(raw, 'default_timeout_ms'),
    stage_idle_timeout_ms: positiveNumberValue(raw, 'default_stage_idle_timeout_ms'),
    validation_timeout_ms: numberValue(raw, 'default_validation_timeout_ms'),
    live_constraint_exempt_patterns: liveConstraintExemptPatternsValue(raw),
    live_constraint_fallback_scan_ms: positiveNumberValue(raw, 'live_constraint_fallback_scan_ms'),
    live_constraint_monitor_deadline_ms: positiveNumberValue(raw, 'live_constraint_monitor_deadline_ms'),
    scheduler_heartbeat_interval_ms: positiveNumberValue(raw, 'scheduler_heartbeat_interval_ms'),
    scheduler_stall_threshold_ms: positiveNumberValue(raw, 'scheduler_stall_threshold_ms'),
    scheduler_stall_observer_poll_ms: positiveNumberValue(raw, 'scheduler_stall_observer_poll_ms'),
    git_worktree_add_timeout_ms: positiveNumberValue(raw, 'git_worktree_add_timeout_ms'),
    max_iterations: numberValue(raw, 'default_max_iterations'),
    gate_retry_loops: numberValue(raw, 'default_gate_retry_loops'),
    stage_technical_retries: numberValue(raw, 'default_stage_technical_retries'),
    plan_stage_retries: numberValue(raw, 'default_plan_stage_retries'),
    model: stringValue(raw, 'model'),
    reasoning_effort: stringValue(raw, 'reasoning_effort'),
    adapter: stringValue(raw, 'adapter'),
    sessionReuse: booleanValue(raw, 'session_reuse'),
  };
  // Commit the cache key only after the file has parsed and validated. If an
  // edit is malformed, every read must keep reporting that error rather than
  // treating a previous value as the cache entry for the broken mtime.
  _cache = parsed;
  _cacheMtime = mtime;
  return parsed;
}

/** Per-process measurement override; only literal 0/1 are accepted. */
export function isSessionReuseEnabled(): boolean {
  const override = process.env.FC_SESSION_REUSE;
  if (override === '0') return false;
  if (override === '1') return true;
  return loadEngineDefaults().sessionReuse;
}

export function getDefaultTimeout(): string {
  return String(loadEngineDefaults().timeout_ms);
}

export function resetConfigCache(): void {
  _cache = null;
  _cacheMtime = 0;
}
