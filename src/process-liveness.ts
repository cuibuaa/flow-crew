import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

/** Conservative liveness used by build ownership and run identity. Linux
 * zombies have no execution left even while their parent has not reaped them. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[0];
        if (state === 'Z' || state === 'X') return false;
      } catch { /* an inaccessible observation cannot prove no execution */ }
    }
    return true;
  } catch (error) {
    // signal 0 has exactly one portable death proof: ESRCH. EPERM means the
    // process exists but this user cannot signal it; unfamiliar probe failures
    // must remain fail-closed rather than being upgraded into death evidence.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
