import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

// One filesystem boundary for all parent mutations, including descriptor writes.
// Child processes import their own node:fs and cannot advance the parent's ledger.
export { accessSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync,
  opendirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, watch,
  type FSWatcher, type Stats } from 'node:fs';
export type EngineWrite = { bytes: Buffer; position?: number; truncate?: boolean; mode?: number; resize?: number; advance?: boolean };
type Publication = { transfer?: readonly [source: string, destination: string]; copy?: boolean; followSource?: boolean; followDestination?: boolean; merge?: boolean; verbatimLinks?: boolean; append?: boolean; write?: EngineWrite; remove?: boolean; directory?: number; directories?: string[]; mode?: number; link?: string };
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
const descriptors = new Map<number, { path: string; append: boolean; position: number }>();
export const readSync = ((...args: unknown[]) => {
  const result = Reflect.apply(fs.readSync, fs, args) as number;
  const descriptor = typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
  const options = args[2] as number | { position?: number | null } | undefined;
  const position = typeof options === 'object' ? options?.position : args[4];
  if (descriptor && position == null) descriptor.position += result;
  return result;
}) as typeof fs.readSync;
function path(value: fs.PathLike | number): string {
  if (typeof value === 'number') {
    const recorded = descriptors.get(value);
    if (!recorded) throw new Error('ENGINE_WRITE_UNTRACKED: descriptor was not opened by the engine filesystem');
    return recorded.path;
  }
  return value instanceof URL ? fileURLToPath(value) : value.toString();
}
function mutation<F extends (...args: never[]) => unknown>(operation: () => F, targets: number[] | ((args: Parameters<F>) => string[]), tree = false, append: boolean | ((args: Parameters<F>) => boolean) = false, intent?: (args: Parameters<F>) => EngineWrite, metadata?: (args: Parameters<F>) => Partial<Publication>): F {
  return ((...args: Parameters<F>) => {
    const write = intent?.(args);
    return publishEngineFiles(typeof targets === 'function' ? targets(args) : targets.map(index => path(args[index] as fs.PathLike | number)), () => {
      const result = operation()(...args);
      if (write) {
        if (typeof result === 'number') write.bytes = write.bytes.subarray(0, result);
        const descriptor = typeof args[0] === 'number' && descriptors.get(args[0]);
        if (descriptor && write.advance !== false) descriptor.position = (write.position ?? descriptor.position) + write.bytes.length;
      }
      return result;
    }, tree, { append: typeof append === 'function' ? append(args) : append, write, ...metadata?.(args) });
  }) as F;
}

function fileWrite(args: Parameters<typeof fs.writeFileSync>, defaultFlag = 'w'): EngineWrite {
  const options = typeof args[2] === 'object' && args[2] ? args[2] : undefined;
  const encoding = typeof args[2] === 'string' ? args[2] : options?.encoding ?? 'utf8';
  const data = args[1];
  const bytes = typeof data === 'string' ? Buffer.from(data, encoding)
    : Buffer.from(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const descriptor = typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
  const flag = options?.flag ?? defaultFlag;
  return { bytes, position: descriptor?.position ?? 0,
    truncate: !descriptor && (typeof flag === 'number' ? Boolean(flag & fs.constants.O_TRUNC) : flag.includes('w')),
    mode: options?.mode === undefined ? undefined : typeof options.mode === 'string' ? Number.parseInt(options.mode, 8) : options.mode };
}

const appends = (target: fs.PathLike | number, flags?: string | number): boolean =>
  typeof target === 'number' ? descriptors.get(target)?.append === true
    : typeof flags === 'number' ? Boolean(flags & fs.constants.O_APPEND) && !(flags & fs.constants.O_TRUNC) : Boolean(flags?.includes('a'));
export const writeFileSync = mutation(() => fs.writeFileSync, [0], false, args =>
  appends(args[0], typeof args[2] === 'object' && args[2] ? args[2].flag : undefined), fileWrite);
export const appendFileSync = mutation(() => fs.appendFileSync, [0], false, args =>
  appends(args[0], typeof args[2] === 'object' && args[2] ? args[2].flag ?? 'a' : 'a'), args => fileWrite(args, 'a'));
export const writeSync = mutation(() => fs.writeSync, [0], false, args => appends(args[0]), args => {
  const values = args as unknown as [number, string | NodeJS.ArrayBufferView, number | { offset?: number; length?: number; position?: number } | null, number | BufferEncoding | undefined, number | null | undefined];
  const [fd, data, offset, length, position] = values;
  if (typeof data === 'string') return { bytes: Buffer.from(data, typeof length === 'string' ? length : 'utf8'), position: typeof offset === 'number' ? offset : descriptors.get(fd)?.position, advance: typeof offset !== 'number' };
  const options = typeof offset === 'object' && offset ? offset : undefined;
  const start = options?.offset ?? (typeof offset === 'number' ? offset : 0);
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return { bytes: Buffer.from(bytes.subarray(start, start + (options?.length ?? (typeof length === 'number' ? length : bytes.length - start)))),
    position: options?.position ?? position ?? descriptors.get(fd)?.position, advance: (options?.position ?? position) == null };
});
export const ftruncateSync = mutation(() => fs.ftruncateSync, [0], false, false, args => ({ bytes: Buffer.alloc(0), resize: args[1] ?? 0, advance: false }));
const fileMode = (mode: fs.Mode | null | undefined, fallback: number): number => typeof mode === 'string' ? Number.parseInt(mode, 8) : mode ?? fallback;
export const mkdirSync = mutation(() => fs.mkdirSync, [0], false, false, undefined, args => ({ directory:
  fileMode(typeof args[1] === 'object' && args[1] ? args[1].mode : args[1], 0o777) & ~process.umask() }));
export const mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
  const publication: Publication = { directory: 0o700 & ~process.umask(), directories: [] };
  return publishEngineFiles([dirname(path(args[0]))], () => {
    const created = fs.mkdtempSync(...args); publication.directories!.push(path(created)); return created;
  }, true, publication);
}) as typeof fs.mkdtempSync;
export const renameSync: typeof fs.renameSync = (source, destination) => {
  const transfer = [path(source), path(destination)] as const;
  return publishEngineFiles([...transfer], () => fs.renameSync(source, destination), true, { transfer });
};
export const rmSync = mutation(() => fs.rmSync, [0], true, false, undefined, () => ({ remove: true }));
export const rmdirSync = mutation(() => fs.rmdirSync, [0], true, false, undefined, () => ({ remove: true }));
export const unlinkSync = mutation(() => fs.unlinkSync, [0], false, false, undefined, () => ({ remove: true }));
export const copyFileSync: typeof fs.copyFileSync = (source, destination, flags) =>
  publishEngineFiles([path(source), path(destination)], () => fs.copyFileSync(source, destination, flags), false,
    { transfer: [path(source), path(destination)], copy: true, followSource: true, followDestination: true });
export const cpSync: typeof fs.cpSync = (source, destination, options) =>
  publishEngineFiles([path(source), path(destination)], () => fs.cpSync(source, destination, options), true,
    { transfer: [path(source), path(destination)], copy: true, merge: true, followSource: options?.dereference, verbatimLinks: options?.verbatimSymlinks });
export const linkSync: typeof fs.linkSync = (source, destination) =>
  publishEngineFiles([path(source), path(destination)], () => fs.linkSync(source, destination), false,
    { transfer: [path(source), path(destination)], copy: true, verbatimLinks: true });
export const symlinkSync = mutation(() => fs.symlinkSync, [1], false, false, undefined, args => ({ link: path(args[0]) }));
export const chmodSync = mutation(() => fs.chmodSync, [0], false, false, undefined, args => ({ mode: fileMode(args[1], 0) }));
export const openSync: typeof fs.openSync = (file, flags, mode) => {
  const target = resolve(path(file));
  const writable = typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(flags);
  const append = typeof flags === 'number' ? Boolean(flags & fs.constants.O_APPEND) : flags.includes('a');
  const truncate = typeof flags === 'number' ? Boolean(flags & fs.constants.O_TRUNC) : flags.includes('w');
  const fd = writable ? publishEngineFiles([target], () => fs.openSync(file, flags, mode), false, { append,
    write: { bytes: Buffer.alloc(0), position: 0, truncate, mode: typeof mode === 'string' ? Number.parseInt(mode, 8) : mode ?? undefined } }) : fs.openSync(file, flags, mode);
  if (writable) descriptors.set(fd, { path: target, append: typeof flags === 'number' ? Boolean(flags & fs.constants.O_APPEND) : flags.includes('a'), position: 0 });
  return fd;
};
export const closeSync: typeof fs.closeSync = fd => {
  try { fs.closeSync(fd); } finally { descriptors.delete(fd); }
};

/** Publish complete bytes. Durable records sync the file and its directory;
 * replace-only progress records need atomic visibility, not crash persistence.
 * Callers protecting recovery state remain durable by default. */
export function atomicWrite(filePath: string, data: string | Buffer, {
  durability = 'durable', mode, exclusive = false, stagingDirectory,
}: { durability?: 'durable' | 'replace-only'; mode?: number; exclusive?: boolean; stagingDirectory?: string } = {}): boolean {
  const tmp = join(stagingDirectory ?? dirname(filePath), basename(filePath) + '.tmp.' + randomBytes(4).toString('hex'));
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
