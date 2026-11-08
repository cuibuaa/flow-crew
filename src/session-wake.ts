import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { appendFileSync, atomicWrite, mkdirSync, renameSync, unlinkSync } from './engine-fs.js';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { processIsAlive, processStartToken, processStartTokensMatch, type ProcessStartToken } from './run-lock.js';
import { lockOwnerIdentity, parseLockOwner, publishLockOwner, recoverStaleLock, type LockObservation, type LockOwner } from './lock-publication.js';
import type { SessionPush } from './session-push.js';
import { wrapUpPrompt } from './session-push.js';

// Conservative supported floor: this is the version exercised by the native
// probe. Earlier versions advertising asyncRewake are deliberately fail-closed.
export const CLAUDE_WAKE_MIN_VERSION = '2.1.308';
export const WAKE_LIFETIME_MS = 60 * 60_000;
export function supportsClaudeWakeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 308)));
}
export function claudeWakeCapability(): { supported: boolean; detail: string } {
  try {
    const version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const supported = supportsClaudeWakeVersion(version);
    return { supported, detail: `Claude ${version || '(unknown)'}; wake requires >= ${CLAUDE_WAKE_MIN_VERSION}${supported ? '' : '. Upgrade: claude update'}` };
  } catch { return { supported: false, detail: `Claude version unavailable; wake requires >= ${CLAUDE_WAKE_MIN_VERSION}. Install/upgrade Claude Code: claude update` }; }
}

/** One small fact per session: wake coverage could not be registered. Written
 * only by the wake path, overwritten on each failure, deleted when a waiter
 * registers. While it exists Stop does not ask the model to renew coverage;
 * the next wake attempt (every Stop and SessionStart runs one) retires it. */
export const WAKE_UNAVAILABLE_REASONS = ['unsupported_version', 'hook_disabled', 'identity_unavailable', 'registration_failed', 'lock_unavailable', 'owner_unverifiable', 'wake_cli_failed'] as const;
export type WakeUnavailableReason = typeof WAKE_UNAVAILABLE_REASONS[number];
export const wakeUnavailablePath = (root: string, session: string): string =>
  join(root, 'wake-unavailable', `${createHash('sha256').update(session).digest('hex')}.json`);
/** Undefined: no fact. Any file that cannot be read whole counts as present. */
export function wakeUnavailable(root: string, session: string): string | undefined {
  try {
    const fact = JSON.parse(readFileSync(wakeUnavailablePath(root, session), 'utf8')) as { reason?: unknown; at?: unknown };
    const reason = (WAKE_UNAVAILABLE_REASONS as readonly unknown[]).includes(fact.reason) ? fact.reason : 'unreadable';
    return typeof fact.at === 'string' ? `${reason} since ${fact.at}` : `${reason}`;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable'; }
}
export function markWakeUnavailable(root: string, session: string, reason: WakeUnavailableReason): void {
  const path = wakeUnavailablePath(root, session);
  try {
    mkdirSync(join(root, 'wake-unavailable'), { recursive: true });
    atomicWrite(path, `${JSON.stringify({ reason, at: new Date().toISOString() })}\n`, { durability: 'replace-only', mode: 0o600 });
  } catch { /* the caller reports the failure itself; an unwritable store cannot add another */ }
}
function clearWakeUnavailable(root: string, session: string): void {
  try { unlinkSync(wakeUnavailablePath(root, session)); } catch { /* absent, or nothing to retire */ }
}

interface Waiter extends LockOwner {
  session: string; start: ProcessStartToken; host: number; hostStart: ProcessStartToken; expiresAt: number; bootId?: string;
}
export const sessionWaiterPath = (root: string, session: string): string =>
  join(root, 'waiters', `${createHash('sha256').update(session).digest('hex')}.json`);
// Linux start tokens recur after a reboot; calendar-based POSIX tokens do not.
function bootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; }
  catch { return undefined; }
}
function readWaiter(path: string): { waiter?: Waiter; observation: LockObservation } | undefined {
  try {
    const stat = statSync(path);
    const raw = readFileSync(path, 'utf8');
    const owner = parseLockOwner(raw);
    return { waiter: owner ? JSON.parse(raw) as Waiter : undefined,
      observation: { owner, mtimeMs: stat.mtimeMs, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}` } };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function hasClaudeWakeWaiter(root: string, session: string, now = Date.now()): boolean {
  const waiter = readWaiter(sessionWaiterPath(root, session))?.waiter;
  if (!waiter || waiter.session !== session || waiter.expiresAt <= now) return false;
  const boot = bootId();
  if (process.platform === 'linux' && (!boot || waiter.bootId !== boot)) return false;
  return processIsAlive(waiter.pid) && processStartTokensMatch(waiter.start, processStartToken(waiter.pid))
    && processIsAlive(waiter.host) && processStartTokensMatch(waiter.hostStart, processStartToken(waiter.host));
}

export interface WakeOptions {
  lifetimeMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}
/** Called only by the installed asyncRewake command. No model worker, socket
 * discovery, permission edits, or ACK inference. Exit 2 is Claude's wake API. */
export async function waitForClaudeWake(push: SessionPush, session: string, options: WakeOptions = {}): Promise<{ code: 0 | 2; prompt?: string }> {
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const expiresAt = now() + (options.lifetimeMs ?? WAKE_LIFETIME_MS);
  let failed: WakeUnavailableReason = 'identity_unavailable'; // what a throw during registration means for the fact
  const start = processStartToken(process.pid);
  const hostStart = processStartToken(process.ppid);
  const boot = bootId();
  const path = sessionWaiterPath(push.root, session);
  const token = randomUUID();
  const recovered = (owner: LockObservation, reason: string): void => {
    try { appendFileSync(join(push.registry.baseDir, 'infrastructure-recoveries.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), component: 'wake-lease', session, owner: owner.owner, reason })}\n`, { mode: 0o600, flush: true }); }
    catch { /* a diagnostic failure cannot turn recovery into a model wake */ }
  };
  // Only registration and retirement mutate the slot. Serialize both with the
  // existing writer boundary, then delete a detached, unique owner path outside
  // it. An expiring owner's cleanup can never unlink its replacement's slot.
  const detached: string[] = [];
  const detach = (): void => {
    const retired = join(push.root, 'waiters', `retired-${randomUUID()}.json`);
    renameSync(path, retired);
    detached.push(retired);
  };
  const removeDetached = (): void => { for (const file of detached.splice(0)) unlinkSync(file); };
  let acquired = false;
  try {
    if (!/^[\w-]+$/u.test(session)) { failed = 'registration_failed'; throw new Error('Invalid wake session id'); }
    if (!start || !hostStart || (process.platform === 'linux' && !boot)) throw new Error('Wake process identity unavailable; coverage cannot be registered');
    failed = 'registration_failed';
    push.registerClaudeWake(session);
    mkdirSync(join(push.root, 'waiters'), { recursive: true });
    failed = 'lock_unavailable';
    push.registry.withSessionWrite(() => {
      failed = 'registration_failed';
      for (;;) {
        try {
          publishLockOwner(path, { ...lockOwnerIdentity(), token, session, start, host: process.ppid, hostStart, expiresAt, bootId: boot });
          acquired = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const current = readWaiter(path);
          if (!current) continue;
          const previous = current.waiter;
          const leaseEnded = previous && (previous.expiresAt <= now() || (process.platform === 'linux' && boot && previous.bootId !== boot));
          if (leaseEnded) {
            detach(); recovered(current.observation, 'lease expired or belongs to a previous boot'); continue;
          }
          const reason = recoverStaleLock(current.observation, () => readWaiter(path)?.observation, detach);
          if (reason) { recovered(current.observation, reason); continue; }
          if (!hasClaudeWakeWaiter(push.root, session, now())) { failed = 'owner_unverifiable'; throw new Error('Wake lease owner cannot be verified; coverage unavailable', { cause: error }); }
          break; // an existing verified owner keeps its lease
        }
      }
    });
  } catch (error) {
    markWakeUnavailable(push.root, session, failed);
    throw error;
  } finally { removeDetached(); }
  clearWakeUnavailable(push.root, session); // a verified waiter now holds the slot
  if (!acquired) return { code: 0 };
  try {
    for (;;) {
      if (readWaiter(path)?.waiter?.token !== token) return { code: 0 };
      if (!processIsAlive(process.ppid) || !processStartTokensMatch(hostStart, processStartToken(process.ppid))) return { code: 0 };
      try {
        const pending = push.pending(session, 'claude');
        for (const event of pending) {
          if (push.claimWake(event)) {
            return { code: 2, prompt: wrapUpPrompt(event, push.registry.baseDir) };
          }
        }
        // Poll for every session task (a finished run's event may still be publishing);
        // renewal needs a model turn, so only unfinished work or a pending event earns one.
        if (!push.sessionTasks('claude', session).length && !pending.length) return { code: 0 };
        if (now() >= expiresAt) return pending.length || push.openTasks('claude', session).length
          ? { code: 2, prompt: 'FlowCrew wake coverage is expiring. Inspect this session’s FlowCrew task and pending events. Handle and explicitly ACK any pending event. If execution is still in flight, end this turn normally so the installed Stop hook renews wake coverage; do not wait in the foreground.' }
          : { code: 0 };
      } catch (error) {
        // Retain the live waiter across read/publication faults. A service
        // repair can resume delivery without inventing an empty model turn.
        // Stop and the status line show the same fault; if it outlasts the
        // lease, the caller reports it on stderr (a non-blocking exit).
        if (now() >= expiresAt) throw error;
      }
      await pause(Math.min(options.pollMs ?? 1000, Math.max(1, expiresAt - now())));
    }
  } finally {
    try {
      try {
        push.registry.withSessionWrite(() => { if (readWaiter(path)?.waiter?.token === token) detach(); });
      } finally { removeDetached(); }
    } catch (error) {
      // Retirement cannot replace a claimed event or coverage-renewal result.
      // Leave the slot for identity/expiry recovery by the next registrant;
      // never unlink it without serialization, where a replacement could win.
      try { appendFileSync(join(push.registry.baseDir, 'infrastructure-recoveries.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), component: 'wake-lease', session, token, operation: 'retire', deferred: true, error: String(error) })}\n`, { mode: 0o600, flush: true }); }
      catch { /* diagnostic storage cannot suppress the actionable result */ }
    }
  }
}
