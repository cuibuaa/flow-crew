import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Process identity is a control-plane primitive and must not disappear when a
// caller intentionally removes service-manager tools from PATH. macOS/BSD has
// no procfs fallback, so resolve the standard system ps independently of PATH.
export const POSIX_PS_COMMAND = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path)) ?? 'ps';

export type ProcessStartToken =
  | { kind: 'linux'; value: string }
  | { kind: 'posix-lstart'; value: string };

export function linuxProcessStartTimeTicks(pid: number): string | undefined {
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

export function processStartTokensMatch(
  recorded: ProcessStartToken | undefined,
  current: ProcessStartToken | undefined,
): boolean {
  return recorded !== undefined
    && current !== undefined
    && recorded.kind === current.kind
    && recorded.value === current.value;
}

/** TCP receive bytes advance before a provider emits an item. Socket inodes
 * bind the kernel counters to this group, including native clients launched
 * by a wrapper. CPU polling, writes and TCP timers are not receive progress.
 * TCP_INFO covers recv-based transports even without /proc I/O accounting. */
function processGroupReadWork(members: readonly { pid: number }[]): string | undefined {
  try {
    const inodes = new Set<string>();
    for (const { pid } of members) {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target: string;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (error) {
          if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode) inodes.add(inode);
      }
    }
    if (!inodes.size) return undefined;
    const sockets = execFileSync('ss', ['-tineHO'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const reads = sockets.split('\n').flatMap(line => {
      const inode = /\bino:(\d+)\b/.exec(line)?.[1];
      return inode && inodes.has(inode) ? [[inode, /\bbytes_received:(\d+)\b/.exec(line)?.[1] ?? '0']] : [];
    });
    return reads.length ? JSON.stringify(reads.sort()) : undefined;
  } catch { return undefined; } // ss/counters unavailable: no receive-progress claim
}

/** Read-only work evidence for one identity-bound, engine-owned process group.
 * CPU and I/O counters include quiet descendants. Process state describes a
 * wait; it cannot by itself prove that work advanced.
 * Unavailable observations remain unknown, never a claim that work is idle. */
export function processGroupWork(pid: number, startTimeTicks?: string, kind: 'command' | 'provider' = 'command'): {
  startTimeTicks: string; fingerprint: string; readWork?: string; ioObserved: boolean;
  members: Array<{ pid: number; state: string; cpuTicks: number; wait: string }>;
} | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const fields = (id: string) => readFileSync(`/proc/${id}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
    let leader: string[] | undefined;
    try { leader = fields(String(pid)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || startTimeTicks === undefined) throw error;
    }
    if (leader && startTimeTicks !== undefined && leader[19] !== startTimeTicks) return undefined;
    const work: string[] = [];
    let ioObserved = true;
    const members: Array<{ pid: number; state: string; cpuTicks: number; wait: string }> = [];
    for (const id of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let stat: string[];
      try { stat = fields(id); } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      if (Number(stat[2]) !== pid || stat[0] === 'Z' || stat[0] === 'X') continue;
      // A disappearing descendant is itself a lifecycle change, while an
      // unreadable live member cannot certify an idle group.
      let io: string;
      try { io = readFileSync(`/proc/${id}/io`, 'utf8'); } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (!existsSync(`/proc/${id}/stat`)) continue;
        // Some kernels expose stat without per-process I/O accounting. Keep
        // their CPU evidence instead of silently dropping the live member.
        io = 'unavailable';
        ioObserved = false;
      }
      // Provider CPU polling is not model work. Tool descendants remain
      // observable command work; inbound bytes are sampled separately below.
      if (kind === 'command' || Number(id) !== pid) {
        work.push(`${id}:${stat[19]}:${stat[11]}:${stat[12]}:${io}`);
      }
      let wait = 'unknown';
      try { wait = readFileSync(`/proc/${id}/wchan`, 'utf8').trim(); } catch { /* optional diagnostic */ }
      members.push({ pid: Number(id), state: stat[0], cpuTicks: Number(stat[11]) + Number(stat[12]), wait });
    }
    const readWork = kind === 'provider' ? processGroupReadWork(members) : undefined;
    if (readWork !== undefined) work.push(readWork);
    return { startTimeTicks: leader?.[19] ?? startTimeTicks!, fingerprint: createHash('sha256').update(work.sort().join('\n')).digest('hex'), readWork, ioObserved, members };
  } catch { return undefined; }
}

/** A dead group leader can still have writing descendants. Linux zombies have
 * no execution left; signal-zero alone would wait forever for their reaper. */
export function processGroupIsAlive(pid: number): boolean {
  try { process.kill(-pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
        if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    return false;
  }
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

export function validProcessStartToken(token: ProcessStartToken): boolean {
  return typeof token.value === 'string' && (token.kind === 'linux' ? /^\d+$/.test(token.value)
    : token.kind === 'posix-lstart' && token.value.trim().length > 0);
}

/** Only positive death or same-kind start-time mismatch proves absence.
 * Callers choose whether unknown permits observation, admission or signalling. */
export function processLiveness(pid: number, recorded?: ProcessStartToken): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead';
  if (recorded && !validProcessStartToken(recorded)) return 'unknown';
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    // EPERM proves existence. A readable start token can still prove PID reuse.
    if (code !== 'EPERM' || !recorded) return 'unknown';
  }
  if (process.platform === 'linux') {
    try {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[0];
      if (state === 'Z' || state === 'X') return 'dead';
    } catch { return 'unknown'; }
  }
  if (!recorded) return 'alive';
  const current = processStartToken(pid);
  if (!current || current.kind !== recorded.kind) return 'unknown';
  return processStartTokensMatch(recorded, current) ? 'alive' : 'dead';
}

/** Compatibility for conservative build/group callers; admission callers use
 * the three-state observation and declare their unknown policy explicitly. */
export function processIsAlive(pid: number): boolean {
  return processLiveness(pid) !== 'dead';
}
