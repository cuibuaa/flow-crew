import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// One filesystem boundary for all parent mutations, including descriptor writes.
// Child processes import their own node:fs and cannot advance the parent's ledger.
export { accessSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync,
  opendirSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync, watch,
  type FSWatcher, type Stats } from 'node:fs';
type Publication = { transfer?: readonly [source: string, destination: string]; append?: boolean };
type PublicationObserver = (paths: string[], tree: boolean, publication?: Publication) => () => void;
const observers = new Set<PublicationObserver>();
/** Integrity supplies policy only while loaded; standalone tools keep this
 * filesystem boundary without importing the scheduler and storage graph. */
export function observeEnginePublications(observer: PublicationObserver): void {
  observers.add(observer);
}
export function publishEngineFiles<T>(paths: string[], action: () => T, tree = false, publication?: Publication): T {
  const records = [...observers].map(observer => observer(paths, tree, publication));
  const result = action();
  for (const record of records) record();
  return result;
}
const descriptors = new Map<number, { path: string; append: boolean }>();
function path(value: fs.PathLike | number): string {
  if (typeof value === 'number') {
    const recorded = descriptors.get(value);
    if (!recorded) throw new Error('ENGINE_WRITE_UNTRACKED: descriptor was not opened by the engine filesystem');
    return recorded.path;
  }
  return value instanceof URL ? fileURLToPath(value) : value.toString();
}
function mutation<F extends (...args: never[]) => unknown>(operation: () => F, targets: number[] | ((args: Parameters<F>) => string[]), tree = false, append: boolean | ((args: Parameters<F>) => boolean) = false): F {
  return ((...args: Parameters<F>) => publishEngineFiles(typeof targets === 'function' ? targets(args) : targets.map(index => path(args[index] as fs.PathLike | number)),
    () => operation()(...args), tree, { append: typeof append === 'function' ? append(args) : append })) as F;
}

const appends = (target: fs.PathLike | number, flags?: string | number): boolean =>
  typeof target === 'number' ? descriptors.get(target)?.append === true
    : typeof flags === 'number' ? Boolean(flags & fs.constants.O_APPEND) && !(flags & fs.constants.O_TRUNC) : Boolean(flags?.includes('a'));
export const writeFileSync = mutation(() => fs.writeFileSync, [0], false, args =>
  appends(args[0], typeof args[2] === 'object' && args[2] ? args[2].flag : undefined));
export const appendFileSync = mutation(() => fs.appendFileSync, [0], false, args =>
  appends(args[0], typeof args[2] === 'object' && args[2] ? args[2].flag ?? 'a' : 'a'));
export const writeSync = mutation(() => fs.writeSync, [0], false, args => appends(args[0]));
export const ftruncateSync = mutation(() => fs.ftruncateSync, [0]);
export const mkdirSync = mutation(() => fs.mkdirSync, [0]);
export const mkdtempSync = mutation(() => fs.mkdtempSync, args => [dirname(path(args[0]))], true);
export const renameSync: typeof fs.renameSync = (source, destination) => {
  const transfer = [path(source), path(destination)] as const;
  return publishEngineFiles([...transfer], () => fs.renameSync(source, destination), true, { transfer });
};
export const rmSync = mutation(() => fs.rmSync, [0], true);
export const rmdirSync = mutation(() => fs.rmdirSync, [0], true);
export const unlinkSync = mutation(() => fs.unlinkSync, [0]);
export const copyFileSync = mutation(() => fs.copyFileSync, [1]);
export const cpSync = mutation(() => fs.cpSync, [1], true);
export const linkSync = mutation(() => fs.linkSync, [1]);
export const symlinkSync = mutation(() => fs.symlinkSync, [1]);
export const chmodSync = mutation(() => fs.chmodSync, [0]);
export const openSync: typeof fs.openSync = (file, flags, mode) => {
  const target = resolve(path(file));
  const writable = typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(flags);
  const fd = writable ? publishEngineFiles([target], () => fs.openSync(file, flags, mode)) : fs.openSync(file, flags, mode);
  if (writable) descriptors.set(fd, { path: target, append: typeof flags === 'number' ? Boolean(flags & fs.constants.O_APPEND) : flags.includes('a') });
  return fd;
};
export const closeSync: typeof fs.closeSync = fd => {
  try { fs.closeSync(fd); } finally { descriptors.delete(fd); }
};

/** Publish complete bytes. Durable records sync the file and its directory;
 * replace-only progress records need atomic visibility, not crash persistence.
 * Callers protecting recovery state remain durable by default. */
export function atomicWrite(filePath: string, data: string | Buffer, {
  durability = 'durable', mode, exclusive = false,
}: { durability?: 'durable' | 'replace-only'; mode?: number; exclusive?: boolean } = {}): boolean {
  const tmp = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    // Node writes all bytes and, when requested, syncs before closing. One
    // filesystem publication also avoids per-chunk integrity bookkeeping.
    writeFileSync(tmp, data, { flag: 'wx', mode, flush: durability === 'durable' });
    if (exclusive) {
      try { linkSync(tmp, filePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        unlinkSync(tmp);
        return false;
      }
      unlinkSync(tmp);
    } else renameSync(tmp, filePath);
    if (durability === 'durable') {
      // A visible record is not durable until its directory entry is synced.
      // Failure here must reach the caller even though publication succeeded.
      let parent: number | undefined;
      try {
        parent = openSync(dirname(filePath), 'r');
        fs.fsyncSync(parent);
      } finally {
        try { if (parent !== undefined) closeSync(parent); } catch { /* best effort */ }
      }
    }
    return true;
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw err;
  }
}
