import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// One filesystem boundary for all parent mutations, including descriptor writes.
// Child processes import their own node:fs and cannot advance the parent's ledger.
export { accessSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync,
  opendirSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync, watch,
  type FSWatcher, type Stats } from 'node:fs';
type PublicationTransfer = readonly [source: string, destination: string];
type PublicationObserver = (paths: string[], tree: boolean, transfer?: PublicationTransfer) => () => void;
const observers = new Set<PublicationObserver>();
/** Integrity supplies policy only while loaded; standalone tools keep this
 * filesystem boundary without importing the scheduler and storage graph. */
export function observeEnginePublications(observer: PublicationObserver): void {
  observers.add(observer);
}
export function publishEngineFiles<T>(paths: string[], action: () => T, tree = false, transfer?: PublicationTransfer): T {
  const records = [...observers].map(observer => observer(paths, tree, transfer));
  const result = action();
  for (const record of records) record();
  return result;
}
const descriptors = new Map<number, string>();
function path(value: fs.PathLike | number): string {
  if (typeof value === 'number') {
    const recorded = descriptors.get(value);
    if (!recorded) throw new Error('ENGINE_WRITE_UNTRACKED: descriptor was not opened by the engine filesystem');
    return recorded;
  }
  return value instanceof URL ? fileURLToPath(value) : value.toString();
}
function mutation<F extends (...args: never[]) => unknown>(operation: () => F, targets: number[] | ((args: Parameters<F>) => string[]), tree = false): F {
  return ((...args: Parameters<F>) => publishEngineFiles(typeof targets === 'function' ? targets(args) : targets.map(index => path(args[index] as fs.PathLike | number)),
    () => operation()(...args), tree)) as F;
}

export const writeFileSync = mutation(() => fs.writeFileSync, [0]);
export const appendFileSync = mutation(() => fs.appendFileSync, [0]);
export const writeSync = mutation(() => fs.writeSync, [0]);
export const writevSync = mutation(() => fs.writevSync, [0]);
export const ftruncateSync = mutation(() => fs.ftruncateSync, [0]);
export const truncateSync = mutation(() => fs.truncateSync, [0]);
export const mkdirSync = mutation(() => fs.mkdirSync, [0]);
export const mkdtempSync = mutation(() => fs.mkdtempSync, args => [dirname(path(args[0]))], true);
export const renameSync: typeof fs.renameSync = (source, destination) => {
  const transfer = [path(source), path(destination)] as const;
  return publishEngineFiles([...transfer], () => fs.renameSync(source, destination), true, transfer);
};
export const rmSync = mutation(() => fs.rmSync, [0], true);
export const rmdirSync = mutation(() => fs.rmdirSync, [0], true);
export const unlinkSync = mutation(() => fs.unlinkSync, [0]);
export const copyFileSync = mutation(() => fs.copyFileSync, [1]);
export const cpSync = mutation(() => fs.cpSync, [1], true);
export const linkSync = mutation(() => fs.linkSync, [1]);
export const symlinkSync = mutation(() => fs.symlinkSync, [1]);
export const chmodSync = mutation(() => fs.chmodSync, [0]);
export const fchmodSync = mutation(() => fs.fchmodSync, [0]);
export const chownSync = mutation(() => fs.chownSync, [0]);
export const fchownSync = mutation(() => fs.fchownSync, [0]);
export const lchownSync = mutation(() => fs.lchownSync, [0]);
export const utimesSync = mutation(() => fs.utimesSync, [0]);
export const futimesSync = mutation(() => fs.futimesSync, [0]);
export const lutimesSync = mutation(() => fs.lutimesSync, [0]);
export const openSync: typeof fs.openSync = (file, flags, mode) => {
  const target = resolve(path(file));
  const writable = typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(flags);
  const fd = writable ? publishEngineFiles([target], () => fs.openSync(file, flags, mode)) : fs.openSync(file, flags, mode);
  if (writable) descriptors.set(fd, target);
  return fd;
};
export const closeSync: typeof fs.closeSync = fd => {
  try { fs.closeSync(fd); } finally { descriptors.delete(fd); }
};
