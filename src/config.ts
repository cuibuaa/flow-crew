import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Preserve the numeric budget contract: unrestricted numbers retain their value;
// only the existing positive time bounds require finite values and floor them.
const numeric = z.custom<number>((value) => typeof value === 'number');
const positive = numeric.refine((value) => Number.isFinite(value) && value > 0).transform(Math.floor);
const nonempty = z.string().min(1);
const EngineDefaultsSchema = z.object({
  default_timeout_ms: numeric,
  stage_idle_timeout_ms: positive,
  validation_timeout_ms: numeric,
  scheduler_heartbeat_interval_ms: positive,
  scheduler_stall_threshold_ms: positive,
  scheduler_stall_observer_poll_ms: positive,
  git_worktree_add_timeout_ms: positive,
  max_iterations: numeric,
  gate_retry_loops: numeric,
  stage_technical_retries: numeric,
  plan_stage_retries: numeric,
  model: nonempty,
  reasoning_effort: nonempty,
  adapter: nonempty,
  session_reuse: z.boolean(),
});
export type EngineDefaults = z.infer<typeof EngineDefaultsSchema>;

/** The installed engine owns configuration; the working directory is irrelevant. */
export const engineConfigDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config');

let _cache: EngineDefaults | null = null;
let _cacheMtime = 0;

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

  const parsed = EngineDefaultsSchema.parse(parseYaml(readFileSync(p, 'utf-8')));
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
  return loadEngineDefaults().session_reuse;
}
