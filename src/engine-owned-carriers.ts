import { lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
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
  return engineOwnedDatabasePaths(storeRoot).some((file) => target === file || target.startsWith(`${file}-`));
}

export function containsEngineOwnedGlobalPath(path: string, storeRoot: string): boolean {
  return isEngineOwnedGlobalPath(path, storeRoot) || engineOwnedDatabasePaths(storeRoot).some((file) => {
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

/** Resolve current trusted configuration at admission, never candidate metadata. */
export function physicalRoot(path: string): { path: string; dev?: bigint; ino?: bigint } {
  path = prospectivePhysicalPath(resolve(path));
  try {
    const entry = statSync(path, { bigint: true });
    if (!entry.isDirectory()) throw new Error(`ARTIFACT_PATH_NOT_DIRECTORY: ${path} is not a directory`);
    return { path, dev: entry.dev, ino: entry.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path };
  }
}

/** Compare current physical paths and ancestor device/inode identities. */
export function withinPhysicalRoot(root: ReturnType<typeof physicalRoot>, target: string): boolean {
  const local = relative(root.path, target);
  if (local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))) return true;
  if (root.ino === undefined) return false;
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      const entry = statSync(cursor, { bigint: true });
      if (entry.dev === root.dev && entry.ino === root.ino) return true;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (dirname(cursor) === cursor) return false;
  }
}
