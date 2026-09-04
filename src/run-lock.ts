/**
 * Project-level run liveness — the single-in-flight probe, extracted so the
 * DAEMON can ask "is this project busy?" before launching a unit, without
 * importing the scheduler (and its whole adapter graph).
 *
 * Before this existed, single-in-flight was enforced only INSIDE a launched
 * run: the daemon happily spawned a second unit for a busy project, the child
 * discovered the conflict ~300ms later and killed itself with a failed status,
 * systemd reported the unit failed, and the orchestrator counted that as a
 * crash worth retrying — burning the task's whole retry budget in seconds on a
 * conflict it only had to wait out (observed live: task #1817).
 *
 * Project occupancy is process truth: a run counts as active when its
 * scheduler.pid is a live process whose start-time identity is bound to that
 * run (with a narrow legacy CLI fallback). run.json status is deliberately not
 * part of this decision: a stale terminal record must not hide a live
 * scheduler, while a running orphan with a dead/recycled PID must never wedge
 * the project.
 *
 * A settled `parked` run has no scheduler PID and therefore frees the project.
 * Its resume process becomes visible as soon as it claims scheduler.pid, before
 * the durable status flips back to running, so the hand-off remains guarded.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getItem, isPendingInboxItemState } from './inbox.js';
import { fcGlobalDir, isPausedRunStatus, runsRoot } from './store.js';
import { listOperationalRunIdsFromIndex, setRunSchedulerActive } from './run-index.js';
export const LAUNCH_INTENT_TTL_MS = 60_000;

// Process identity is a control-plane primitive and must not disappear when a
// caller intentionally removes service-manager tools from PATH. macOS/BSD has
// no procfs fallback, so resolve the standard system ps independently of PATH.
const POSIX_PS_COMMAND = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path)) ?? 'ps';

export interface LaunchIntent {
  version: 1;
  projectDir: string;
  ownerRunId: string;
  claimedAt: string;
}

function normalizedProjectDir(projectDir: string): string {
  return resolve(projectDir);
}

function launchIntentDir(): string {
  return join(fcGlobalDir(), 'launch-intents');
}

function launchIntentPath(projectDir: string): string {
  const key = createHash('sha256').update(normalizedProjectDir(projectDir)).digest('hex');
  return join(launchIntentDir(), `${key}.json`);
}

/**
 * Read an unexpired cross-process launch claim. A fresh malformed claim is
 * treated as busy (fail closed); once its file age exceeds the TTL it is
 * discarded like any other abandoned launch.
 */
export function readLaunchIntent(
  projectDir: string,
  selfOwnerRunId?: string,
  nowMs = Date.now(),
): LaunchIntent | null {
  const path = launchIntentPath(projectDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    try {
      if (nowMs - statSync(path).mtimeMs >= LAUNCH_INTENT_TTL_MS) unlinkSync(path);
      else return {
        version: 1,
        projectDir: normalizedProjectDir(projectDir),
        ownerRunId: 'unreadable-launch-intent',
        claimedAt: new Date(statSync(path).mtimeMs).toISOString(),
      };
    } catch { /* missing or concurrently removed */ }
    return null;
  }
  const parsed = raw && typeof raw === 'object' ? raw as Partial<LaunchIntent> : {};
  const claimedAt = typeof parsed.claimedAt === 'string' ? Date.parse(parsed.claimedAt) : NaN;
  const valid = parsed.version === 1
    && parsed.projectDir === normalizedProjectDir(projectDir)
    && typeof parsed.ownerRunId === 'string'
    && parsed.ownerRunId.length > 0
    && Number.isFinite(claimedAt);
  if (!valid || claimedAt > nowMs + 5_000) {
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (nowMs - mtimeMs < LAUNCH_INTENT_TTL_MS) {
        return {
          version: 1,
          projectDir: normalizedProjectDir(projectDir),
          ownerRunId: 'unreadable-launch-intent',
          claimedAt: new Date(mtimeMs).toISOString(),
        };
      }
    } catch { return null; }
    try { unlinkSync(path); } catch { /* already removed */ }
    return null;
  }
  if (nowMs - claimedAt >= LAUNCH_INTENT_TTL_MS) {
    try { unlinkSync(path); } catch { /* already removed */ }
    return null;
  }
  if (parsed.ownerRunId === selfOwnerRunId) return null;
  return parsed as LaunchIntent;
}

/**
 * Atomically claim the project launch window. Separate per-project files avoid
 * lost updates between daemon instances.
 */
export function claimLaunchIntent(
  projectDir: string,
  ownerRunId: string,
  nowMs = Date.now(),
): { claimed: boolean; blockingOwnerRunId?: string } {
  const normalized = normalizedProjectDir(projectDir);
  const path = launchIntentPath(normalized);
  mkdirSync(launchIntentDir(), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const intent: LaunchIntent = {
        version: 1,
        projectDir: normalized,
        ownerRunId,
        claimedAt: new Date(nowMs).toISOString(),
      };
      writeFileSync(path, JSON.stringify(intent, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
      return { claimed: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const existing = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LaunchIntent>;
        const existingAt = typeof existing.claimedAt === 'string' ? Date.parse(existing.claimedAt) : NaN;
        if (
          existing.ownerRunId === ownerRunId &&
          existing.projectDir === normalized &&
          Number.isFinite(existingAt) &&
          existingAt <= nowMs + 5_000 &&
          nowMs - existingAt < LAUNCH_INTENT_TTL_MS
        ) {
          return { claimed: true };
        }
      } catch { /* readLaunchIntent below handles malformed/stale claims */ }
      const blocking = readLaunchIntent(normalized, ownerRunId, nowMs);
      if (blocking) return { claimed: false, blockingOwnerRunId: blocking.ownerRunId };
      // The prior claim expired and readLaunchIntent removed it; retry wx.
    }
  }
  return { claimed: false, blockingOwnerRunId: 'launch-intent-race' };
}

export function releaseLaunchIntent(projectDir: string, ownerRunId: string): void {
  const path = launchIntentPath(projectDir);
  try {
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LaunchIntent>;
    if (existing.ownerRunId !== ownerRunId) return;
    unlinkSync(path);
  } catch { /* absent, malformed, or already released */ }
}

/** Parse the complete scheduler.pid marker; numeric prefixes are not PIDs. */
export function parseSchedulerPidMarker(raw: string): number | null {
  const marker = raw.trim();
  if (!/^\d+$/.test(marker)) return null;
  const pid = Number(marker);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

const SCHEDULER_IDENTITY_FILE = 'scheduler.identity.json';

export type ProcessStartToken =
  | { kind: 'linux'; value: string }
  | { kind: 'posix-lstart'; value: string };

interface SchedulerProcessIdentityV1 {
  version: 1;
  pid: number;
  runId: string;
  linuxStartTimeTicks?: string;
}

interface SchedulerProcessIdentityV2 {
  version: 2;
  pid: number;
  runId: string;
  startToken?: ProcessStartToken;
  command?: string;
}

type SchedulerProcessIdentity = SchedulerProcessIdentityV1 | SchedulerProcessIdentityV2;

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // signal 0 has exactly one portable death proof: ESRCH. EPERM means the
    // process exists but this user cannot signal it; unfamiliar probe failures
    // must remain fail-closed rather than being upgraded into death evidence.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function linuxProcessStartTimeTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return undefined;
    const fieldsFromState = stat.slice(commEnd + 1).trim().split(/\s+/);
    const startTime = fieldsFromState[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function posixProcessStartToken(pid: number): ProcessStartToken | undefined {
  try {
    const rendered = execFileSync(
      POSIX_PS_COMMAND,
      ['-ww', '-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf-8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      },
    ).trim().replace(/\s+/g, ' ');
    return rendered ? { kind: 'posix-lstart', value: rendered } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A PID-reuse-resistant identity token on every supported POSIX platform.
 * Linux keeps the precise /proc field-22 token. A procfs-less Linux host and
 * Darwin/BSD use a locale- and timezone-stable `ps lstart` value instead.
 */
export function processStartToken(pid: number): ProcessStartToken | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    const ticks = linuxProcessStartTimeTicks(pid);
    if (ticks !== undefined) return { kind: 'linux', value: ticks };
  }
  if (process.platform !== 'win32') return posixProcessStartToken(pid);
  return undefined;
}

/** Backward-compatible Linux-only view for callers that have not migrated yet. */
export function processStartTimeTicks(pid: number): string | undefined {
  const token = processStartToken(pid);
  return token?.kind === 'linux' ? token.value : undefined;
}

export function processStartTokensMatch(
  recorded: ProcessStartToken | undefined,
  current: ProcessStartToken | undefined,
): boolean {
  return recorded !== undefined
    && current !== undefined
    && recorded.kind === current.kind
    && recorded.value === current.value;
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function processArgumentsFromPs(pid: number): string[] | null {
  try {
    const out = execFileSync(POSIX_PS_COMMAND, ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    if (!out) return null;
    const argv = out.split(/\s+/).filter(Boolean);
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
}

export type ProcessCommandBinding = 'bound' | 'unbound' | 'unreadable';

function processArguments(pid: number): string[] | null {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const argv = cmdline.split('\0').filter(Boolean);
    // A zombie (or an otherwise unreadable transition state) can expose an
    // empty cmdline while its PID still exists. Empty argv carries no binding
    // authority; classify it as unreadable instead of matching an empty text.
    return argv.length > 0 ? argv : null;
  } catch {
    // No procfs. `ps` is POSIX and reports the same argument vector, just
    // space-joined — good enough for the "is this a flowcrew scheduler" question,
    // which only inspects argv positions and never a path containing spaces.
    // Without this the caller used to answer "yes, any live pid is ours", which
    // was measured returning true for an unrelated shell.
    return processArgumentsFromPs(pid);
  }
}

function decodeShellJoinedCommand(command: string): string[] | null {
  if (!command.startsWith("'") || !command.endsWith("'")) return null;
  return command.slice(1, -1)
    .split("' '")
    .map((argument) => argument.replace(/'\\''/g, "'"));
}

function normalizedCommandText(command: string): string {
  return command
    .replace(/'\\''/g, "'")
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bind a persisted command to the currently-live argv. New scheduler identity
 * files store NUL-separated argv for an exact comparison. Fallback unit records
 * store FlowCrew's shellJoin form, which is decoded before comparison; the text
 * fallback covers BSD ps, whose `args=` output is necessarily space-joined.
 */
export function processCommandBinding(pid: number, recordedCommand: string): ProcessCommandBinding {
  const current = processArguments(pid);
  if (current === null) return 'unreadable';
  if (recordedCommand.includes('\0')) {
    return current.join('\0') === recordedCommand ? 'bound' : 'unbound';
  }
  // A shell that has not exec'd its only child keeps the complete shellJoin
  // command as one argv entry. Compare that representation before normalizing
  // it, particularly because embedded apostrophes use the `'\''` shell escape.
  if (current.some((argument) => argument === recordedCommand)) return 'bound';
  const decoded = decodeShellJoinedCommand(recordedCommand);
  if (decoded && current.length === decoded.length) {
    if (decoded.every((argument, index) => argument === current[index])) return 'bound';
  }
  const expectedText = normalizedCommandText(decoded?.join(' ') ?? recordedCommand);
  const currentText = normalizedCommandText(current.join(' '));
  const matches = expectedText.length > 0
    && (expectedText === currentText
      || currentText.includes(expectedText));
  return matches ? 'bound' : 'unbound';
}

export function processCommandMatches(pid: number, recordedCommand: string): boolean {
  return processCommandBinding(pid, recordedCommand) === 'bound';
}

function processCommandSnapshot(pid: number): string | undefined {
  return processArguments(pid)?.join('\0');
}

function processArgumentPath(pid: number, argument: string): string | null {
  if (!argument || argument.startsWith('-')) return null;
  try {
    const candidate = isAbsolute(argument)
      ? argument
      : resolve(realpathSync(`/proc/${pid}/cwd`), argument);
    return canonicalPath(candidate);
  } catch {
    return null;
  }
}

function schedulerCommandIndex(pid: number, args: string[]): number {
  const moduleDir = resolve(import.meta.dirname ?? '.');
  const entrypoints = new Set([
    join(moduleDir, 'cli.js'),
    join(moduleDir, 'cli.mjs'),
    join(moduleDir, 'cli.cjs'),
    join(moduleDir, 'cli.ts'),
  ].map(canonicalPath));
  return args.findIndex((argument) => {
    const path = processArgumentPath(pid, argument);
    return path !== null && entrypoints.has(path);
  });
}

function commandLooksLikeFlowcrewScheduler(pid: number, expectedRunId?: string): boolean {
  const args = processArguments(pid);
  // Unreadable argv used to mean "assume it is ours on any non-Linux platform",
  // which answered true for an unrelated live shell. processArguments now falls
  // back to `ps`, so reaching here means we genuinely cannot tell — and claiming
  // ownership of a process we cannot identify is what gates SIGTERM downstream.
  if (args === null) return false;
  const cliIndex = schedulerCommandIndex(pid, args);
  if (cliIndex < 0 || args[cliIndex + 1] !== 'quick') return false;
  if (expectedRunId === undefined) return true;
  return args.some((argument, index) => (
    (argument === '--existing-run-id' && args[index + 1] === expectedRunId)
    || argument === `--existing-run-id=${expectedRunId}`
  ));
}

function legacyDirectCommandBindsRun(pid: number, runPath: string): boolean {
  const args = processArguments(pid);
  if (args === null) return false;
  const cliIndex = schedulerCommandIndex(pid, args);
  if (cliIndex < 0 || args[cliIndex + 1] !== 'quick') return false;
  if (args.some((argument) => argument === '--existing-run-id' || argument.startsWith('--existing-run-id='))) {
    return false; // an explicit but different binding must never fall back to project metadata
  }
  try {
    const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as {
      projectDir?: unknown;
      startedAt?: unknown;
      taskDescription?: unknown;
    };
    if (typeof state.projectDir !== 'string' || typeof state.startedAt !== 'string') return false;
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    const projectIndex = args.lastIndexOf('--project');
    const commandProject = projectIndex >= 0 && args[projectIndex + 1]
      ? resolve(cwd, args[projectIndex + 1])
      : cwd;
    if (canonicalPath(commandProject) !== canonicalPath(state.projectDir)) return false;
    const taskIndex = args.lastIndexOf('--task');
    if (
      taskIndex >= 0
      && typeof state.taskDescription === 'string'
      && args[taskIndex + 1] !== state.taskDescription
    ) return false;
    const runStartedAt = Date.parse(state.startedAt);
    const processStartedAt = statSync(`/proc/${pid}`).ctimeMs;
    const initializationDelay = runStartedAt - processStartedAt;
    return Number.isFinite(runStartedAt)
      && initializationDelay >= -5_000
      && initializationDelay <= 10 * 60_000;
  } catch {
    return false;
  }
}

function schedulerIdentityPath(runPath: string): string {
  return join(runPath, SCHEDULER_IDENTITY_FILE);
}

function indexedRunId(runPath: string): string | undefined {
  return resolve(dirname(runPath)) === resolve(runsRoot()) ? basename(runPath) : undefined;
}

/** Record the scheduler/run binding after scheduler.pid has been claimed. */
export function writeSchedulerProcessIdentity(runPath: string, runId: string, pid = process.pid): void {
  if (!processIsAlive(pid)) throw new Error(`Cannot identify non-live scheduler pid ${pid}`);
  const startToken = processStartToken(pid);
  const command = processCommandSnapshot(pid);
  const identity: SchedulerProcessIdentity = {
    version: 2,
    pid,
    runId,
    ...(startToken ? { startToken } : {}),
    ...(command ? { command } : {}),
  };
  writeFileSync(schedulerIdentityPath(runPath), JSON.stringify(identity, null, 2) + '\n', 'utf-8');
  if (indexedRunId(runPath) === runId) {
    try { setRunSchedulerActive('', runId, true); } catch { /* index is a rebuildable accelerator */ }
  }
}

/** Remove only this process's identity, unless an unconditional stale cleanup is requested. */
export function removeSchedulerProcessIdentity(runPath: string, expectedPid?: number): void {
  const path = schedulerIdentityPath(runPath);
  if (expectedPid !== undefined) {
    try {
      const identity = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: unknown };
      if (identity.pid !== expectedPid) return;
    } catch { return; }
  }
  try { unlinkSync(path); } catch { /* missing or concurrently removed */ }
  const runId = indexedRunId(runPath);
  if (runId) {
    try { setRunSchedulerActive('', runId, false); } catch { /* best effort */ }
  }
}

type SchedulerIdentityBinding = 'absent' | 'bound' | 'reused' | 'corrupt' | 'unverifiable';

function identityBindsSchedulerToRun(
  pid: number,
  runId: string,
  runPath: string,
): SchedulerIdentityBinding {
  try {
    const identity = JSON.parse(
      readFileSync(schedulerIdentityPath(runPath), 'utf-8'),
    ) as {
      version?: unknown;
      pid?: unknown;
      runId?: unknown;
      linuxStartTimeTicks?: unknown;
      startToken?: unknown;
      command?: unknown;
    };
    if (identity.pid !== pid || identity.runId !== runId) return 'corrupt';
    const currentToken = processStartToken(pid);
    if (identity.version === 1) {
      const recorded = typeof identity.linuxStartTimeTicks === 'string'
        ? { kind: 'linux' as const, value: identity.linuxStartTimeTicks }
        : undefined;
      if (!recorded) return 'corrupt';
      if (!currentToken) return 'unverifiable';
      return processStartTokensMatch(recorded, currentToken) ? 'bound' : 'reused';
    }
    if (identity.version !== 2) return 'corrupt';
    const recorded = identity.startToken && typeof identity.startToken === 'object'
      ? identity.startToken as Partial<ProcessStartToken>
      : undefined;
    if (!recorded || (recorded.kind !== 'linux' && recorded.kind !== 'posix-lstart')) return 'corrupt';
    if (typeof recorded.value !== 'string') return 'corrupt';
    const validatedRecorded: ProcessStartToken = { kind: recorded.kind, value: recorded.value };
    if (!currentToken) return 'unverifiable';
    if (!processStartTokensMatch(validatedRecorded, currentToken)) return 'reused';
    // BSD lstart has only second precision, so the persisted command is a
    // required second factor. A missing/unreadable command is unbound, never a
    // reason to call the process dead.
    if (recorded.kind !== 'posix-lstart') return 'bound';
    if (typeof identity.command !== 'string') return 'corrupt';
    const command = processCommandBinding(pid, identity.command);
    return command === 'bound' ? 'bound' : command === 'unbound' ? 'reused' : 'unverifiable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'corrupt';
  }
}

export type RunSchedulerObservation =
  | { kind: 'missing' }
  | { kind: 'dead'; pid: number }
  | { kind: 'reused'; pid: number }
  | { kind: 'live'; pid: number }
  | { kind: 'corrupt'; detail: string; pid?: number }
  | { kind: 'unverifiable'; detail: string; pid: number };

/**
 * Classify the scheduler marker without treating an arbitrary live PID as the
 * run owner. Recovery may proceed only for missing/dead/reused observations;
 * corrupt or unreadable identity evidence remains fail-closed.
 */
export function inspectRunScheduler(runId: string, runPath: string): RunSchedulerObservation {
  let marker: string;
  try {
    marker = readFileSync(join(runPath, 'scheduler.pid'), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'corrupt', detail: 'scheduler.pid cannot be read' };
  }
  const pid = parseSchedulerPidMarker(marker);
  if (pid === null) return { kind: 'corrupt', detail: 'scheduler.pid is not a positive integer' };
  if (!processIsAlive(pid)) return { kind: 'dead', pid };

  const identity = identityBindsSchedulerToRun(pid, runId, runPath);
  if (identity === 'bound') return { kind: 'live', pid };
  if (identity === 'reused') return { kind: 'reused', pid };
  if (identity === 'corrupt') {
    return { kind: 'corrupt', pid, detail: 'scheduler identity does not bind this PID and run' };
  }
  if (identity === 'unverifiable') {
    return { kind: 'unverifiable', pid, detail: 'scheduler process identity is unreadable' };
  }

  const args = processArguments(pid);
  if (args === null) return { kind: 'unverifiable', pid, detail: 'legacy scheduler arguments are unreadable' };
  return commandLooksLikeFlowcrewScheduler(pid, runId) || legacyDirectCommandBindsRun(pid, runPath)
    ? { kind: 'live', pid }
    : { kind: 'reused', pid };
}

export function isLiveFlowcrewSchedulerPid(pid: number): boolean {
  return processIsAlive(pid) && commandLooksLikeFlowcrewScheduler(pid);
}

/**
 * Process- and run-authoritative ownership. New schedulers carry a start-time
 * identity beside scheduler.pid. Exact legacy CLI bindings remain accepted;
 * an older direct launch is additionally tied to its project and start window.
 */
export function isLiveFlowcrewSchedulerForRun(pid: number, runId: string, runPath: string): boolean {
  if (!processIsAlive(pid)) return false;
  const identity = identityBindsSchedulerToRun(pid, runId, runPath);
  // Once an identity file exists it is authoritative. In particular, a v2
  // token-kind mismatch must not be bypassed by the scheduler-shaped argv
  // compatibility path; that path is only for runs predating identity files.
  if (identity !== 'absent') return identity === 'bound';
  return commandLooksLikeFlowcrewScheduler(pid, runId)
    || legacyDirectCommandBindsRun(pid, runPath);
}

/**
 * Cancellation liveness is deliberately more conservative than signal
 * authority. A readable token and argv can prove that a live PID is unrelated;
 * if either identity input is unreadable, the PID remains possibly-live work
 * and must keep the cancellation barrier closed.
 */
export function schedulerProcessIsAliveForCancellation(
  pid: number,
  runId: string,
  runPath: string,
): boolean {
  if (!processIsAlive(pid)) return false;
  if (processStartToken(pid) === undefined || processArguments(pid) === null) return true;
  return isLiveFlowcrewSchedulerForRun(pid, runId, runPath);
}

export interface LiveRunOwner {
  runId: string;
  pid: number;
  projectDir: string;
}

/** Text embedded in admission errors; it names both the run and live process. */
export function describeLiveRunOwner(owner: Pick<LiveRunOwner, 'runId' | 'pid'>): string {
  return `${owner.runId}, scheduler pid ${owner.pid}`;
}

function scanLiveRunOwners(): LiveRunOwner[] {
  const owners: LiveRunOwner[] = [];
  let dirs: string[];
  try { dirs = listOperationalRunIdsFromIndex('') ?? readdirSync(runsRoot()); } catch { return owners; }
  for (const dir of dirs) {
    try {
      const runPath = join(runsRoot(), dir);
      const rs = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as { projectDir?: string };
      if (typeof rs.projectDir !== 'string') continue;
      const pid = parseSchedulerPidMarker(
        readFileSync(join(runPath, 'scheduler.pid'), 'utf-8'),
      );
      if (pid === null) continue;
      if (!isLiveFlowcrewSchedulerForRun(pid, dir, runPath)) {
        try { setRunSchedulerActive('', dir, false); } catch { /* index is best effort */ }
        continue;
      }
      owners.push({ runId: dir, pid, projectDir: normalizedProjectDir(rs.projectDir) });
    } catch { /* missing or unreadable run metadata / pid -> skip */ }
  }
  return owners;
}

/**
 * Process-authoritative project owner scan. The run status is intentionally
 * ignored; only a validated live scheduler PID owns the worktree.
 */
export function findLiveRunOwnerForProject(projectDir: string, selfRunId?: string): LiveRunOwner | null {
  const normalized = normalizedProjectDir(projectDir);
  return scanLiveRunOwners().find((owner) => (
    owner.projectDir === normalized && (!selfRunId || owner.runId !== selfRunId)
  )) ?? null;
}

/**
 * Returns the runId of a live run for `projectDir`, or null when the project is
 * free. `selfRunId` (when given) is excluded so a run can probe for siblings.
 */
export function findActiveRunForProject(projectDir: string, selfRunId?: string): string | null {
  return findLiveRunOwnerForProject(projectDir, selfRunId)?.runId ?? null;
}

// The probe walks every run directory (hundreds on a long-lived install), and
// the daemon calls it once per queued task per sweep. Cache within a sweep;
// the TTL is far shorter than the 30s tick, and callers that LAUNCH must treat
// the project as busy themselves (the cache cannot see a launch that just
// happened — the run writes run.json milliseconds later).
const PROBE_TTL_MS = 5_000;
let probeCache: { at: number; result: Map<string, LiveRunOwner> } | null = null;

/** Live runs keyed by projectDir -> owner evidence. One directory walk, cached briefly. */
function liveRunOwnersByProject(): Map<string, LiveRunOwner> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.result;
  const out = new Map<string, LiveRunOwner>();
  for (const owner of scanLiveRunOwners()) {
    if (!out.has(owner.projectDir)) out.set(owner.projectDir, owner);
  }
  probeCache = { at: now, result: out };
  return out;
}

/** Live owners keyed by projectDir -> an operator-readable run/PID description. */
export function activeRunsByProject(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [projectDir, owner] of liveRunOwnersByProject()) {
    out.set(projectDir, describeLiveRunOwner(owner));
  }
  return out;
}

/** Drop the probe cache — call after anything that changes run liveness. */
export function invalidateRunLockCache(): void {
  probeCache = null;
}

/** Daemon admission blocker: launch owner id, or live run id plus scheduler PID. */
export function isProjectBusy(projectDir: string, selfOwnerRunId?: string, nowMs = Date.now()): string | null {
  const intent = readLaunchIntent(projectDir, selfOwnerRunId, nowMs);
  if (intent) return intent.ownerRunId;
  return activeRunsByProject().get(normalizedProjectDir(projectDir)) ?? null;
}

/**
 * A run for this project that is PARKED on an approval request, if any.
 *
 * The daemon needs this to tell "the unit exited because the run is waiting for
 * a human" from "the unit crashed". Without it, a park looks exactly like a
 * clean-exit-without-commit and the orchestrator relaunches the brief as a NEW
 * run — re-running the very consequential action awaiting approval.
 *
 * Matched by projectDir + a park that started at/after the task's launch, so a
 * months-old parked run cannot pin a fresh task in place.
 */
export function findParkedRunForProject(projectDir: string, sinceIso?: string): { runId: string; requestId?: string } | null {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  // Callers with a registry task always have created_at available. Fail closed
  // when no usable boundary is supplied so an abandoned historical park can
  // never pin unrelated future work.
  if (!Number.isFinite(since)) return null;
  let dirs: string[];
  try { dirs = listOperationalRunIdsFromIndex('') ?? readdirSync(runsRoot()); } catch { return null; }
  for (const dir of dirs.sort().reverse()) {
    try {
      const rs = JSON.parse(readFileSync(join(runsRoot(), dir, 'run.json'), 'utf-8')) as {
        projectDir?: string; status?: string; parked?: { requestId?: string; pausedAt?: string };
      };
      if (rs.projectDir !== projectDir || !rs.status || !isPausedRunStatus(rs.status)) continue;
      const pausedAt = rs.parked?.pausedAt ? Date.parse(rs.parked.pausedAt) : NaN;
      if (!Number.isFinite(pausedAt) || pausedAt < since) continue;
      const requestId = rs.parked?.requestId;
      const item = requestId ? getItem(dir, requestId) : undefined;
      if (!requestId || !item || !isPendingInboxItemState(item.state)) continue;
      return { runId: dir, requestId };
    } catch { /* skip */ }
  }
  return null;
}
