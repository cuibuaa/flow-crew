import { closeSync, openSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { processStartToken } from './run-lock.js';
import {
  SUPERVISION_PROTOCOL_VERSION,
  atomicWriteJson,
  readSupervisionLaunch,
  type SupervisionExitRecord,
  type SupervisionRunningRecord,
} from './supervision.js';

const controlDir = process.argv[2];
const launchPath = controlDir ? join(controlDir, 'launch.json') : '';
const runningPath = controlDir ? join(controlDir, 'running.json') : '';
const exitPath = controlDir ? join(controlDir, 'exit.json') : '';
const logPath = controlDir ? join(controlDir, 'out.log') : '';

// A just-forked pid can be absent from the process table for a few
// milliseconds where identity comes from `ps` rather than procfs. Probe a few
// more times, then stop: an unrecorded token is a tolerated state, not a fault.
const BACKFILL_ATTEMPTS = 10;
const BACKFILL_INTERVAL_MS = 25;

let agent: ChildProcess | undefined;
let running: SupervisionRunningRecord | undefined;
let logFd: number | undefined;
let forceTimer: NodeJS.Timeout | undefined;
let settleTimer: NodeJS.Timeout | undefined;
let stopRequested = false;
let stopForwarded = false;
let forcedKill = false;
let stopRequestedBeforeAgentExit = false;
let finalized = false;
let pendingExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

function shellJoin(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

function normalizedExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (Number.isInteger(code) && (code ?? 0) >= 0) return code!;
  const signalNumber = signal
    ? (constants.signals as Record<string, number>)[signal]
    : undefined;
  return Number.isInteger(signalNumber) ? 128 + signalNumber! : 1;
}

function signalAgent(signal: NodeJS.Signals): void {
  const pid = agent?.pid;
  if (!pid) return;
  const target = process.platform !== 'win32' ? -pid : pid;
  try { process.kill(target, signal); } catch { /* child close remains authoritative */ }
}

function agentGroupIsAlive(): boolean {
  const pid = agent?.pid;
  if (!pid) return false;
  const target = process.platform !== 'win32' ? -pid : pid;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function updateLegacyRecord(record: Record<string, unknown>): void {
  const launch = readSupervisionLaunch(launchPath);
  if (!launch?.legacyRecordPath) return;
  try {
    atomicWriteJson(launch.legacyRecordPath, record, { createParent: false });
  } catch { /* compatibility mirror is non-authoritative */ }
}

function finalize(
  code: number | null,
  signal: NodeJS.Signals | null,
  reason?: string,
  normalizedOverride?: number,
): void {
  if (finalized) return;
  finalized = true;
  if (forceTimer) clearTimeout(forceTimer);
  if (settleTimer) clearTimeout(settleTimer);
  const normalized = normalizedOverride ?? normalizedExit(code, signal);
  const endedAt = new Date().toISOString();
  const exit: SupervisionExitRecord = {
    version: SUPERVISION_PROTOCOL_VERSION,
    exitCode: code,
    ...(signal ? { signal } : {}),
    normalized,
    endedAt,
    ...(reason ? { reason } : {}),
  };
  updateLegacyRecord({
    ...(running ? {
      pid: running.agentPid,
      ...(running.agentToken ? {
        startTimeTicks: running.agentToken.value,
        startTokenKind: running.agentToken.kind,
      } : {}),
    } : {}),
    state: normalized === 0 ? 'inactive' : 'failed',
    command: readSupervisionLaunch(launchPath)?.command,
    reason: reason ?? (signal ? `fallback process terminated by ${signal}` : `fallback process exited with code ${normalized}`),
    completedAt: endedAt,
  });
  if (logFd !== undefined) {
    try { closeSync(logFd); } catch { /* already closed */ }
    logFd = undefined;
  }
  // This is deliberately the final filesystem mutation. Readers that observe
  // exit.json may safely clean up later without racing a compatibility write.
  try {
    atomicWriteJson(exitPath, exit, { createParent: false });
  } catch { /* there is no safer recovery channel */ }
  process.exit(0);
}

function settleAfterGroupExit(): void {
  if (finalized || !pendingExit) return;
  if (!agentGroupIsAlive()) {
    // A successful scheduler may leave a descendant behind after writing its
    // terminal run record. Cleaning that residual process tree is wrapper
    // housekeeping, not a reason to rewrite the scheduler's outcome as 137.
    // An externally requested stop still reports the forced signal truthfully.
    if (forcedKill && stopRequestedBeforeAgentExit) finalize(null, 'SIGKILL');
    else finalize(pendingExit.code, pendingExit.signal);
    return;
  }
  // The configured grace period can be longer than any arbitrary settle
  // window. Keep the shim (and therefore the service wrapper) alive until the
  // group is actually empty; after the grace timer sends SIGKILL, publishing a
  // terminal record before that fact would recreate the orphaned-cgroup bug.
  settleTimer = setTimeout(settleAfterGroupExit, 25);
}

function beginStop(): void {
  if (!pendingExit) stopRequestedBeforeAgentExit = true;
  stopRequested = true;
  if (running && !running.stoppingAt) {
    running = { ...running, stoppingAt: new Date().toISOString() };
    try {
      atomicWriteJson(runningPath, running, { createParent: false });
    } catch { /* exit.json will remain authoritative */ }
    updateLegacyRecord({
      pid: running.agentPid,
      state: 'deactivating',
      command: running.command,
      ...(running.agentToken ? {
        startTimeTicks: running.agentToken.value,
        startTokenKind: running.agentToken.kind,
      } : {}),
    });
  }
  if (!agent?.pid || stopForwarded) return;
  stopForwarded = true;
  signalAgent('SIGTERM');
  const launch = readSupervisionLaunch(launchPath);
  const graceMs = Math.max(0, Math.min(60_000, launch?.shutdownGraceMs ?? 1_500));
  forceTimer = setTimeout(() => {
    forcedKill = true;
    signalAgent('SIGKILL');
    settleAfterGroupExit();
  }, graceMs);
}

function failBeforeAgent(reason: string, normalized = 127): never {
  updateLegacyRecord({
    state: 'failed',
    command: readSupervisionLaunch(launchPath)?.command,
    reason,
    completedAt: new Date().toISOString(),
  });
  finalize(null, null, reason, normalized);
  throw new Error(reason);
}

/**
 * Fill in start tokens the process table had not published yet. Bounded and
 * best-effort: a token that never arrives leaves the record bound by argv
 * alone, which is what the reader already tolerates. Never blocks the agent,
 * and never keeps the shim alive on its own account.
 */
function backfillStartTokens(attempt = 0): void {
  if (!running || finalized) return;
  if (running.shimToken && running.agentToken) return;
  if (attempt >= BACKFILL_ATTEMPTS) return;
  const shimToken = running.shimToken ?? processStartToken(running.shimPid);
  const agentToken = running.agentToken ?? processStartToken(running.agentPid);
  if (shimToken !== running.shimToken || agentToken !== running.agentToken) {
    running = {
      ...running,
      ...(shimToken ? { shimToken } : {}),
      ...(agentToken ? { agentToken } : {}),
    };
    try {
      atomicWriteJson(runningPath, running, { createParent: false });
    } catch { /* exit.json remains authoritative; argv binding still holds */ }
  }
  if (running.shimToken && running.agentToken) return;
  setTimeout(() => backfillStartTokens(attempt + 1), BACKFILL_INTERVAL_MS).unref();
}

function main(): void {
  if (!controlDir) throw new Error('supervise shim requires a control directory');
  const launch = readSupervisionLaunch(launchPath);
  if (!launch) throw new Error(`invalid supervision launch record: ${launchPath}`);
  // Not a launch precondition. See SupervisionRunningRecord.shimToken: a
  // process table can lag a fork, and refusing to start because we cannot yet
  // see ourselves would make launch success depend on probe timing.
  const shimToken = processStartToken(process.pid);

  logFd = openSync(logPath, 'a');
  try {
    agent = spawn(launch.shellPath, ['-c', launch.command], {
      cwd: launch.workingDirectory,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (error) {
    failBeforeAgent(`fallback spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  agent.once('error', (error) => {
    finalize(null, null, `fallback spawn failed: ${error.message}`, 127);
  });
  agent.once('close', (code, signal) => {
    pendingExit = { code, signal };
    if (!agentGroupIsAlive()) {
      settleAfterGroupExit();
      return;
    }
    // A shell may exit on TERM before a descendant in the same process group.
    // Keep supervising the group; writing exit.json here would silently orphan
    // that descendant while claiming cancellation had completed.
    beginStop();
    settleAfterGroupExit();
  });

  const agentPid = agent.pid;
  if (!agentPid) return;
  // Likewise never fatal. Killing a healthy agent because its pid has not
  // reached the process table yet is the same timing artefact, with a worse
  // outcome: the run dies and reports that it was never launched.
  const agentToken = processStartToken(agentPid);
  const shimArgv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  running = {
    version: SUPERVISION_PROTOCOL_VERSION,
    shimPid: process.pid,
    ...(shimToken ? { shimToken } : {}),
    shimCommand: shellJoin(shimArgv),
    agentPid,
    ...(agentToken ? { agentToken } : {}),
    command: launch.command,
    startedAt: new Date().toISOString(),
    ...(stopRequested ? { stoppingAt: new Date().toISOString() } : {}),
  };
  atomicWriteJson(runningPath, running, { createParent: false });
  updateLegacyRecord({
    pid: agentPid,
    state: stopRequested ? 'deactivating' : 'active',
    command: launch.command,
    ...(agentToken ? {
      startTimeTicks: agentToken.value,
      startTokenKind: agentToken.kind,
    } : {}),
  });
  if (!shimToken || !agentToken) backfillStartTokens();
  if (stopRequested) beginStop();
}

process.on('SIGTERM', beginStop);
process.on('SIGINT', beginStop);

try {
  main();
} catch (error) {
  if (!finalized && exitPath) {
    finalize(null, null, error instanceof Error ? error.message : String(error), 125);
  }
}
