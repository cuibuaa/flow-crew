import { linuxProcessStartTimeTicks, processLiveness } from './process-liveness.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { closeSync, linkSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync } from './engine-fs.js';

export const LEGACY_LOCK_STALE_MS = 30_000;

export interface LockOwner {
  pid: number;
  processStartTime?: string;
  acquiredAt?: string;
  token?: string;
  version?: number;
}

export interface LockObservation {
  owner?: LockOwner;
  mtimeMs: number;
  signature: string;
}

export function lockOwnerIdentity(): Pick<LockOwner, 'pid' | 'processStartTime'> {
  return { pid: process.pid, processStartTime: linuxProcessStartTimeTicks(process.pid) };
}

export function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return undefined;
    return {
      pid: parsed.pid as number,
      processStartTime: typeof parsed.processStartTime === 'string' && /^\d+$/u.test(parsed.processStartTime)
        ? parsed.processStartTime : undefined,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      version: typeof parsed.version === 'number' ? parsed.version : undefined,
    };
  } catch { return undefined; }
}

/** Share the owner/legacy-age rule and reinspection before removal. Physical
 * inspection and removal differ for registry files and ledger directories. */
export function recoverStaleLock<T extends LockObservation>(
  observed: T,
  inspect: () => T | undefined,
  remove: (lock: T) => void,
): string | undefined {
  let reason: string;
  if (observed.owner) {
    if (processLiveness(observed.owner.pid, observed.owner.processStartTime
      ? { kind: 'linux', value: observed.owner.processStartTime } : undefined) !== 'dead') return undefined;
    reason = `recorded owner pid=${observed.owner.pid} no longer exists or its process start time changed`;
  } else {
    const ageMs = Date.now() - observed.mtimeMs;
    if (ageMs < LEGACY_LOCK_STALE_MS) return undefined;
    reason = `lock mtime is ${Math.floor(ageMs)}ms old and owner metadata is incomplete`;
  }
  const current = inspect();
  if (!current || current.signature !== observed.signature) return undefined;
  try { remove(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return reason;
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
