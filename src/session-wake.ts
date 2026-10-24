import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { atomicWrite, mkdirSync, unlinkSync } from './engine-fs.js';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { processIsAlive, processStartToken, processStartTokensMatch, type ProcessStartToken } from './run-lock.js';
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

interface Waiter {
  session: string; pid: number; start: ProcessStartToken;
  host: number; hostStart: ProcessStartToken; expiresAt: number; bootId?: string;
}
const directory = (root: string) => join(root, 'waiters');
// Linux start tokens are ticks since boot, so PID/start pairs alone can recur
// after a reboot. POSIX lstart tokens already include the calendar date.
function bootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; }
  catch { return undefined; }
}
function liveWaiters(root: string, session: string, now: number): Array<{ name: string; waiter: Waiter }> {
  if (!existsSync(directory(root))) return [];
  const boot = bootId();
  if (process.platform === 'linux' && !boot) return [];
  return readdirSync(directory(root)).filter(name => name.endsWith('.json')).flatMap(name => {
    let waiter: Waiter;
    try { waiter = JSON.parse(readFileSync(join(directory(root), name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (waiter.session !== session || waiter.expiresAt <= now
        || (process.platform === 'linux' && waiter.bootId !== boot)) return [];
    return processIsAlive(waiter.pid) && processStartTokensMatch(waiter.start, processStartToken(waiter.pid))
      && processIsAlive(waiter.host) && processStartTokensMatch(waiter.hostStart, processStartToken(waiter.host))
      ? [{ name, waiter }] : [];
  });
}
export function hasClaudeWakeWaiter(root: string, session: string, now = Date.now()): boolean {
  return liveWaiters(root, session, now).length > 0;
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
  if (!/^[\w-]+$/u.test(session)) throw new Error('Invalid wake session id');
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const expiresAt = now() + (options.lifetimeMs ?? WAKE_LIFETIME_MS);
  const start = processStartToken(process.pid);
  const hostStart = processStartToken(process.ppid);
  const boot = bootId();
  if (!start || !hostStart || (process.platform === 'linux' && !boot)) return { code: 0 }; // no verifiable owner: gate remains blocking
  push.registerClaudeWake(session);
  mkdirSync(directory(push.root), { recursive: true });
  const name = `${process.hrtime.bigint().toString().padStart(24, '0')}-${randomUUID()}.json`;
  const path = join(directory(push.root), name);
  // Waiters are leases tied to two live process identities, not crash recovery records.
  atomicWrite(path, JSON.stringify({ session, pid: process.pid, start, host: process.ppid, hostStart, expiresAt, bootId: boot } satisfies Waiter), { durability: 'replace-only', mode: 0o600 });
  try {
    for (;;) {
      const live = liveWaiters(push.root, session, now()).sort((a, b) => a.name.localeCompare(b.name));
      // One polling process per session. Simultaneous starters elect the same
      // oldest owner; immutable event/attempt claims also cover handover races.
      if (live.length && live[0].name !== name) return { code: 0 };
      if (!processIsAlive(process.ppid) || !processStartTokensMatch(hostStart, processStartToken(process.ppid))) return { code: 0 };
      const pending = push.pending(session).filter(event => event.target.frontend === 'claude');
      for (const event of pending) {
        if (push.claimWake(event)) return { code: 2, prompt: wrapUpPrompt(event, push.registry.baseDir) };
      }
      if (!push.openTasks('claude', session).length && !pending.length) return { code: 0 };
      if (now() >= expiresAt) return { code: 2, prompt: 'FlowCrew wake coverage is expiring. Inspect this session’s FlowCrew task and pending events. Handle and explicitly ACK any pending event. If execution is still in flight, end this turn normally so the installed Stop hook renews wake coverage; do not wait in the foreground.' };
      await pause(Math.min(options.pollMs ?? 1000, Math.max(1, expiresAt - now())));
    }
  } finally { if (existsSync(path)) unlinkSync(path); }
}
