import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { atomicWrite, mkdirSync } from './engine-fs.js';
import { lstatSync, readlinkSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';


/** Shared exclusion for source evidence and declared runner report paths. */
export function safeEvidencePath(path: string): boolean {
  return !path.split('/').some(part => ['.fc', '.codex', '.claude', 'codex_home', 'auth.json', 'credentials.json', 'installation_id'].includes(part) || part === '.env' || part.startsWith('.env.'));
}

/** Resolve components, including links whose final target does not yet exist.
 * Do not collapse a link's '..' before expanding preceding component links. */
export function prospectivePhysicalPath(path: string, fs: {
  lstat(path: string): { isSymbolicLink?(): boolean; isDirectory(): boolean };
  readlink(path: string): string;
} = { lstat: lstatSync, readlink: readlinkSync }): string {
  let cursor = parse(path).root;
  let pending = path.slice(cursor.length).split(sep);
  let links = 0;
  while (pending.length) {
    const component = pending.shift()!;
    if (!component || component === '.') continue;
    if (component === '..') { cursor = dirname(cursor); continue; }
    const next = join(cursor, component);
    let entry;
    try { entry = fs.lstat(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entry?.isSymbolicLink?.()) {
      if (++links > 40) throw new Error(`ARTIFACT_PATH_SYMLINK_LOOP: too many symbolic links resolving ${path}`);
      const link = fs.readlink(next);
      if (isAbsolute(link)) cursor = parse(link).root;
      pending = [...link.slice(isAbsolute(link) ? cursor.length : 0).split(sep), ...pending];
    } else {
      if (entry && pending.length && !entry.isDirectory()) throw new Error(`ARTIFACT_PATH_NOT_DIRECTORY: ${next} is not a directory`);
      cursor = next;
    }
  }
  return cursor;
}

export const RUN_INDEX_FILENAME = 'run-index.sqlite';
const registeredSqlitePaths = new Set<string>();

/** Trusted native providers enroll custom databases before publication. This
 * records ownership only; it never opens, initializes or rewrites the database. */
export function registerEngineOwnedSqlitePath(path: string): void {
  registeredSqlitePaths.add(resolve(path));
}

export function engineOwnedDatabasePaths(storeRoot: string): string[] {
  const paths = new Set([join(resolve(storeRoot), RUN_INDEX_FILENAME), ...registeredSqlitePaths]);
  // Keep both SQLite's supplied spelling and its physical name. This also
  // reserves a future target reached through a dangling link or missing parent.
  for (const path of paths) paths.add(prospectivePhysicalPath(path));
  return [...paths];
}

/** SQLite owns the main name and its entire companion prefix, including future
 * rollback/super journals. A missing file does not make that name an output. */
export function isEngineOwnedGlobalPath(path: string, storeRoot: string): boolean {
  const target = prospectivePhysicalPath(resolve(path));
  const registry = prospectivePhysicalPath(storageRegistryDirectory());
  const local = relative(registry, target);
  return (local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)))
    || engineOwnedDatabasePaths(storeRoot).some((file) => target === file || target.startsWith(`${file}-`));
}

export function containsEngineOwnedGlobalPath(path: string, storeRoot: string): boolean {
  return isEngineOwnedGlobalPath(path, storeRoot) || [storageRegistryDirectory(), ...engineOwnedDatabasePaths(storeRoot)].some((file) => {
    const rel = relative(resolve(path), file);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  });
}

/** Existing database members and their parent identities. The integrity ledger
 * tracks future companions without recursively inspecting unrelated files. */
export function engineOwnedGlobalCarriers(storeRoot: string): string[] {
  const paths = new Set<string>();
  for (const file of engineOwnedDatabasePaths(storeRoot)) {
    let parent = dirname(file);
    while (true) {
      try { lstatSync(parent); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
        parent = dirname(parent);
      }
    }
    try {
      lstatSync(parent);
      paths.add(parent);
      for (const name of readdirSync(dirname(file))) {
        if (name === basename(file) || name.startsWith(`${basename(file)}-`)) paths.add(join(parent, name));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...paths];
}

/** Admission reserves the envelope outside the stage work tree. This is a
 * location restriction, independent of stage role and record spelling; the
 * integrity guard owns engine/ and the two public projections. */
export function isReservedRunPath(path: string): boolean {
  const local = resolve('/', path);
  return local !== '/work' && !local.startsWith('/work/');
}

type StorageRoot = { path: string; dev: string; ino: string; kind: 'store' | 'work' };

/** Independent of FC_HOME; tests explicitly supply a disposable registry. */
export function storageRegistryDirectory(): string {
  return process.env.FC_STORE_REGISTRY ?? join(homedir(), '.local', 'state', 'flowcrew', 'storage-roots');
}

function identity(path: string): Pick<StorageRoot, 'path' | 'dev' | 'ino'> | undefined {
  path = realpathSync(path);
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) return undefined;
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}

/** One durable record per physical root: concurrent creators cannot lose entries.
 * Work roots use the same primitive so admission never reads candidate metadata. */
export function registerStorageRoot(path: string, kind: StorageRoot['kind']): void {
  const physical = identity(path);
  if (!physical) throw new Error('Storage root must be a directory');
  const record: StorageRoot = { ...physical, kind };
  const directory = storageRegistryDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  atomicWrite(join(directory, `${key}.json`), JSON.stringify(record) + '\n', { mode: 0o600, exclusive: true });
}

export function storageRoots(): StorageRoot[] {
  const directory = storageRegistryDirectory();
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const roots: StorageRoot[] = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as StorageRoot;
    if (typeof record.path !== 'string' || typeof record.dev !== 'string' || typeof record.ino !== 'string'
      || !['store', 'work'].includes(record.kind)) throw new Error('Invalid storage root identity');
    try {
      const current = identity(record.path);
      if (current && current.path === record.path && current.dev === record.dev && current.ino === record.ino) roots.push(record);
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return roots;
}
