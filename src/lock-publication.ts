import { processStartToken, processLiveness, validProcessStartToken, type ProcessStartToken, type ProcessLiveness } from './process-liveness.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWrite, closeSync, linkSync, mkdirSync, openSync, rmSync, rmdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from './engine-fs.js';
import { constants, fstatSync, lstatSync, readFileSync, readdirSync, readlinkSync, readSync } from 'node:fs';

export interface LockOwner {
  pid: number;
  processStartTime?: string;
  startToken?: ProcessStartToken;
  bootId?: string;
  acquiredAt?: string;
  token?: string;
  version?: number;
}

export interface LockObservation {
  owner?: LockOwner;
  signature: string;
}

function bootId(): string | undefined {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; }
  catch { return undefined; }
}

export function lockOwnerIdentity(): Pick<LockOwner, 'pid' | 'processStartTime' | 'startToken' | 'bootId'> {
  const startToken = processStartToken(process.pid);
  const boot = startToken?.kind === 'linux' ? bootId() : undefined;
  return { pid: process.pid, startToken, bootId: boot,
    processStartTime: startToken?.kind === 'linux' ? startToken.value : undefined };
}

export function lockOwnerLiveness(owner: LockOwner): ProcessLiveness {
  const token = owner.startToken ?? (owner.processStartTime ? { kind: 'linux' as const, value: owner.processStartTime } : undefined);
  const liveness = token && !validProcessStartToken(token)
    ? (processLiveness(owner.pid) === 'dead' ? 'dead' : 'unknown') : processLiveness(owner.pid, token);
  if (liveness === 'dead') return 'dead';
  if (owner.bootId && process.platform === 'linux') {
    const current = bootId();
    if (!current) return 'unknown';
    if (owner.bootId !== current) return 'dead';
  }
  return liveness;
}

export function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return undefined;
    return {
      pid: parsed.pid as number,
      processStartTime: typeof parsed.processStartTime === 'string' && /^\d+$/u.test(parsed.processStartTime)
        ? parsed.processStartTime : undefined,
      startToken: parsed.startToken && typeof parsed.startToken === 'object' ? parsed.startToken as ProcessStartToken : undefined,
      bootId: typeof parsed.bootId === 'string' ? parsed.bootId : undefined,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      version: typeof parsed.version === 'number' ? parsed.version : undefined,
    };
  } catch { return undefined; }
}

/** Callers serialize replacement. Unknown and owner-less legacy publications
 * stay occupied until their publisher releases them; age supplies no evidence. */
export function recoverStaleLock<T extends LockObservation>(
  observed: T,
  inspect: () => T | undefined,
  remove: (lock: T) => void,
): string | undefined {
  if (!observed.owner || lockOwnerLiveness(observed.owner) !== 'dead') return undefined;
  const current = inspect();
  if (!current || current.signature !== observed.signature) return undefined;
  try { remove(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return `recorded owner pid=${observed.owner.pid} is dead or has a different process identity`;
}

/** Publish complete metadata without replacing an existing lock, including an
 * empty legacy directory. rename() cannot provide that directory guarantee. */
export function publishLockOwner(path: string, owner: object, ownerFile?: string): string {
  const temporary = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
  let published = false;
  let staged = false;
  try {
    if (ownerFile) {
      mkdirSync(temporary, { mode: 0o700 });
      staged = true;
    }
    const fd = openSync(ownerFile ? join(temporary, ownerFile) : temporary, 'wx', 0o600);
    staged = true;
    try { writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf-8'); }
    finally { closeSync(fd); }
    if (ownerFile) symlinkSync(basename(temporary), path, 'dir');
    else linkSync(temporary, path);
    published = true;
    return ownerFile ? temporary : path;
  } finally {
    if (staged && (!ownerFile || !published)) rmSync(temporary, { recursive: !!ownerFile, force: true });
  }
}

export type ProcessLockKind = 'run-state' | 'task-registry' | 'session-ledger';
export interface LockWait {
  kind: 'lock_wait';
  lock: { kind: ProcessLockKind; path: string };
  waiter: LockOwner;
  holder: LockOwner | null;
  reason: 'holder' | 'choosing' | 'owner_unobservable' | 'legacy_owner_unavailable';
}
interface Contender {
  owner: LockOwner;
  ticket?: string;
  waiting?: LockWait;
}
interface Publication extends LockObservation { directory?: string }

// Retain the ledger's bounded, no-follow owner inspection for every lock.
// Nonblocking open also turns a replaced FIFO into an unavailable observation.
function readLockRecord(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    const bytes = Buffer.allocUnsafe(4097);
    if (!opened.isFile() || opened.size >= bytes.length) return undefined;
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const current = lstatSync(path);
    if (length >= bytes.length || fstatSync(fd).size !== length || current.dev !== opened.dev || current.ino !== opened.ino) return undefined;
    return bytes.subarray(0, length).toString('utf8');
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function inspectProcessLock(path: string, ownerFile?: string): Publication | undefined {
  try {
    const stat = lstatSync(path);
    let directory: string | undefined;
    if (ownerFile) {
      directory = path;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (!target.startsWith(`${basename(path)}.`) || !/^[a-f0-9-]{36}\.tmp$/u.test(target.slice(basename(path).length + 1))) {
          return { signature: `${stat.dev}:${stat.ino}` };
        }
        directory = join(dirname(path), target);
      }
    }
    const signature = `${stat.dev}:${stat.ino}`;
    const directoryIdentity = () => {
      if (!directory) return '';
      try {
        const target = lstatSync(directory);
        return target.isDirectory() && !target.isSymbolicLink() ? `${target.dev}:${target.ino}` : undefined;
      } catch { return undefined; }
    };
    const identity = directoryIdentity();
    if (identity === undefined) return { signature };
    const raw = readLockRecord(directory ? join(directory, ownerFile!) : path) ?? '';
    if (directoryIdentity() !== identity) return { signature };
    return { owner: parseLockOwner(raw), directory, signature: `${signature}:${identity}:${raw}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function removeLock(path: string, observed: Publication, ownerFile?: string): void {
  if (ownerFile && observed.directory === path) {
    const retired = `${path}.${randomUUID()}.tmp`;
    renameSync(path, retired);
    observed = { ...observed, directory: retired };
  } else unlinkSync(path);
  if (observed.directory) {
    try { unlinkSync(join(observed.directory, ownerFile!)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(observed.directory);
  }
}

function contenderPaths(path: string): string[] {
  const prefix = `${basename(path)}.wait-`;
  try {
    return readdirSync(dirname(path)).filter(name => name.startsWith(prefix)
      && /^[a-f0-9-]{36}\.json$/u.test(name.slice(prefix.length))).map(name => join(dirname(path), name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function readContender(path: string): Contender | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Contender; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Read from another process, including while the writer's event loop is in
 * Atomics.wait. These are transient observations, never persisted run fields. */
export function readLockWaits(path: string): LockWait[] {
  return contenderPaths(path).flatMap(candidate => {
    const record = readContender(candidate);
    return record?.waiting && lockOwnerLiveness(record.owner) !== 'dead' ? [record.waiting] : [];
  });
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));
function pause(): void { Atomics.wait(waitCell, 0, 0, 10); }

/** Lamport's bakery doorway serializes publication, recovery and release.
 * Every contender has a unique, atomically published identity before choosing
 * a ticket. Dead contenders can be ignored/removed by identity: their unique
 * paths are never reused. No compare/unlink race can remove a new canonical
 * owner. Tickets order contenders; neither their magnitude nor polling decides
 * whether a live process has stopped owning a lock.
 *
 * The canonical slot retains the previous format for mixed-version writers.
 * All current writers hold their ticket through canonical release. */
export function withProcessLock<T>(path: string, kind: ProcessLockKind, action: () => T, {
  ownerFile, recovered,
}: { ownerFile?: string; recovered?: (owner: LockOwner, reason: string) => void } = {}): T {
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true });
  let identity = lockOwnerIdentity();
  // An unavailable identity is no authority to publish a PID-only current lock.
  while (!identity.startToken || (identity.startToken.kind === 'linux' && !identity.bootId)) { pause(); identity = lockOwnerIdentity(); }
  const owner: LockOwner = { version: 1, ...identity, token: randomUUID().replaceAll('-', '') };
  const candidate = `${path}.wait-${randomUUID()}.json`;
  const record: Contender = { owner };
  const save = () => atomicWrite(candidate, `${JSON.stringify(record)}\n`, { durability: 'replace-only', mode: 0o600 });
  const wait = (holder: LockOwner | undefined, reason: LockWait['reason']) => {
    const waiting: LockWait = { kind: 'lock_wait', lock: { kind, path }, waiter: owner, holder: holder ?? null, reason };
    if (JSON.stringify(record.waiting) !== JSON.stringify(waiting)) { record.waiting = waiting; save(); }
    pause();
  };
  const contenders = () => contenderPaths(path).flatMap(file => {
    const current = readContender(file);
    if (!current || file === candidate) return [];
    if (lockOwnerLiveness(current.owner) === 'dead') {
      try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return [];
    }
    return [{ file, ...current }];
  });
  let published: Publication | undefined;
  let result!: T;
  const failures: unknown[] = [];
  try {
    save(); // choosing, with complete identity, before this contender is visible
    record.ticket = (contenders().reduce((max, other) => {
      const ticket = BigInt(other.ticket ?? 0);
      return ticket > max ? ticket : max;
    }, 0n) + 1n).toString();
    save();
    for (;;) {
      const ahead = contenders().find(other => other.file !== candidate && (!other.ticket
        || BigInt(other.ticket) < BigInt(record.ticket!)
        || (other.ticket === record.ticket && other.file < candidate)));
      if (ahead) {
        const canonical = inspectProcessLock(path, ownerFile);
        const holder = canonical?.owner && lockOwnerLiveness(canonical.owner) !== 'dead' ? canonical.owner : ahead.owner;
        wait(holder, ahead.ticket ? 'holder' : 'choosing');
        continue;
      }
      try {
        publishLockOwner(path, owner, ownerFile);
        const current = inspectProcessLock(path, ownerFile);
        if (current?.owner?.token !== owner.token) throw new Error(`Lock ownership changed at ${path}`);
        published = current;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const observed = inspectProcessLock(path, ownerFile);
        if (!observed) continue;
        const reason = recoverStaleLock(observed, () => inspectProcessLock(path, ownerFile), lock => removeLock(path, lock, ownerFile));
        if (reason) {
          try { recovered?.(observed.owner!, reason); } catch { /* diagnostics cannot refuse recovery */ }
          continue;
        }
        wait(observed.owner, observed.owner ? (lockOwnerLiveness(observed.owner) === 'unknown' ? 'owner_unobservable' : 'holder') : 'legacy_owner_unavailable');
      }
    }
    delete record.waiting;
    save();
    result = action();
  } catch (error) { failures.push(error); }
  try {
    // The bakery ticket still excludes every other current writer here.
    const current = inspectProcessLock(path, ownerFile);
    if (published) {
      if (current?.signature !== published.signature || current.owner?.token !== owner.token) throw new Error(`Lock ownership changed at ${path}`);
      removeLock(path, current, ownerFile);
    }
  } catch (error) { failures.push(error); }
  try { unlinkSync(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error); }
  if (failures.length) throw failures[0];
  return result;
}
