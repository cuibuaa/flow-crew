import { tmpdir } from 'node:os';
import { createHash, type Hash } from 'node:crypto';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { engineDirectory, stageWorkPath, requestPath, controlPath, assertSeparatedRunLayout, runRecordPath } from './run-layout.js';
import { observeEnginePublications, publishEngineFiles, type EngineWrite } from './engine-fs.js';
export { publishEngineFiles } from './engine-fs.js';
import { chmodSync, constants, copyFileSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fcGlobalDir, withRunStateLock } from './store.js';
import { projectRunLifecycle } from './run-lifecycle.js';
import { hasLifecycleAuthority } from './run-lifecycle-authority.js';
import { flushTextRecords } from './append-boundary.js';
import { engineOwnedDatabasePaths, prospectivePhysicalPath } from './engine-owned-carriers.js';
import { producesEngineOwnedArtifact, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { externalOutputDirectory, readAdmittedBriefContract } from './ship-inputs.js';

export class EngineStateError extends Error {}

type Entry = { identity: string; stat: string; length?: number; hash?: Hash; backing?: string; link?: string; mode?: number };
type Snapshot = Map<string, Entry>;
interface Guard { checkRoute: () => void; scan: (read?: typeof entry) => Snapshot; retain: (path: string, destination?: string) => Entry | undefined; prepareWrite: (path: string, previous: Entry | undefined, write: EngineWrite, append: boolean) => () => Entry; owns: (path: string) => boolean; expected: Snapshot; error?: EngineStateError }
const guards = new Set<Guard>();
const execution = new AsyncLocalStorage<Guard>();
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const same = (a?: Entry, b?: Entry): boolean => a?.identity === b?.identity;

// Content decides integrity, including before a trusted parent publication.
// Stat facts retain object/transfer identity; timestamps cannot attest bytes.
function entry(path: string, digest = true): Entry | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.mode}`;
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      return { identity: `link:${link}`, stat: `link:${identity}`, link };
    }
    if (stat.isDirectory()) return { identity: `directory:${stat.mode}`, stat: `directory:${identity}`, mode: Number(stat.mode) };
    // Stat-only checks never read the entry, so a stale daemon socket may be observed (and removed) without opening it.
    if (!stat.isFile() && !digest) return { identity: `special:${stat.mode}`, stat: `special:${identity}` };
    if (!stat.isFile()) throw new EngineStateError(`ENGINE_STATE_REFUSED: unsupported engine carrier ${path}`);
    return { identity: `file:${stat.mode}:${stat.size}:${digest ? hashRollbackFileSync(path).sha256 : ''}`,
      stat: `file:${identity}:${stat.size}:${stat.mtimeNs}`, length: Number(stat.size), mode: Number(stat.mode) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
const statEntry = (path: string): Entry | undefined => entry(path, false);
const sameStat = (a?: Entry, b?: Entry): boolean => a?.stat === b?.stat;

/** Hash a recorded prefix (or just its newly published tail) in bounded memory. */
function digestRange(path: string, length: number, hash = createHash('sha256'), start = 0, consume?: (chunk: Buffer) => void): Hash {
  const descriptor = openSync(path, 'r'), chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    for (let offset = start; offset < length;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, length - offset), offset);
      if (!count) throw new EngineStateError(`ENGINE_STATE_TAMPERED: truncated carrier ${path}`);
      const bytes = chunk.subarray(0, count);
      hash.update(bytes); consume?.(bytes); offset += count;
    }
  } finally { closeSync(descriptor); }
  return hash;
}

function changed(guard: Guard, actual: Snapshot): string[] {
  return [...new Set([...guard.expected.keys(), ...actual.keys()])]
    .filter(path => !same(guard.expected.get(path), actual.get(path)));
}
function notice(guard: Guard, paths: string[]): void {
  for (const path of paths) {
    guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; changed engine carrier ${path}`);
  }
}

/** Only synchronous parent publications advance the expected record. A child
 * has no access to this memory. Check before overwriting so an append or a later
 * engine publication cannot hide changed bytes. All concurrent guards advance. */
observeEnginePublications((paths, tree, publication) => {
  const { transfer, append, write, copy, followSource, followDestination, merge, verbatimLinks, remove, directory, directories, mode, link } = publication ?? {};
  // A rename transfers the staged object, including its identity. Reading the
  // destination after rename can instead adopt a concurrent child's deletion
  // or replacement as a trusted parent publication.
  const moved = transfer?.map((path, index) => index === 0 && followSource || index === 1 && followDestination ? prospectivePhysicalPath(resolve(path))
    : join(prospectivePhysicalPath(dirname(resolve(path))), basename(path)));
  const postimages = new Map<Guard, Snapshot>();
  const writes = new Map<Guard, Map<string, () => Entry>>();
  const entries = paths.map(path => join(prospectivePhysicalPath(dirname(resolve(path))), basename(path)));
  const directoryParent = directories && prospectivePhysicalPath(resolve(paths[0]));
  const targets = paths.map(path => prospectivePhysicalPath(resolve(path)));
  const physical = [...new Set([...entries, ...targets, ...(moved ?? [])])];
  const entryAncestors = new Set(entries);
  for (const path of entries) for (let parent = dirname(path); ; parent = dirname(parent)) {
    entryAncestors.add(parent); if (dirname(parent) === parent) break;
  }
  const ancestors = new Set(physical);
  for (const path of physical) for (let parent = dirname(path); ; parent = dirname(parent)) {
    ancestors.add(parent);
    if (dirname(parent) === parent) break;
  }
  const hasDirectory = (): boolean => tree && physical.some(path =>
    statEntry(path)?.stat.startsWith('directory:')
    || [...guards].some(guard => guard.expected.get(path)?.stat.startsWith('directory:')));
  let descendants = hasDirectory();
  const affected = (path: string): boolean => ancestors.has(path) || (descendants && physical.some(root => inside(root, path)));
  const relevant = (guard: Guard): boolean => physical.some(path => guard.owns(path) || guard.expected.has(path))
    || (descendants && [...guard.expected.keys()].some(candidate => physical.some(path => inside(path, candidate))));
  // A file publication can only change its names and their ancestors. Enumerate
  // the ledger only for directory operations that can also change descendants.
  const candidates = (guard: Guard, actual: Snapshot, snapshot?: Snapshot): Set<string> => descendants
    ? new Set([...guard.expected.keys(), ...actual.keys(), ...(snapshot?.keys() ?? [])]) : ancestors;
  const current = (guard: Guard): Snapshot => descendants ? guard.scan(statEntry)
    : new Map([...ancestors].filter(path => guard.owns(path) || guard.expected.has(path)).flatMap(path => {
      const value = statEntry(path);
      return value ? [[path, value] as const] : [];
    }));
  for (const guard of guards) {
    if (execution.getStore() === guard) guard.checkRoute();
    if (!relevant(guard)) continue;
    let actual: Snapshot;
    try {
      actual = current(guard);
      notice(guard, [...candidates(guard, actual)]
        .filter(path => affected(path) && (guard.expected.has(path) || actual.has(path))
          && !same(guard.expected.get(path), entry(path))));
    } catch (error) {
      guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`);
      if (execution.getStore() === guard) throw guard.error;
      continue;
    }
    if (guard.error && execution.getStore() === guard) throw guard.error;
    try {
      if (write) writes.set(guard, new Map(physical.filter(path => guard.owns(path) && targets.includes(path) && guard.expected.get(path)?.link === undefined)
        .map(path => [path, guard.prepareWrite(path, guard.expected.get(path), write, Boolean(append))])));
      if (!moved) continue;
      const snapshot: Snapshot = new Map();
      const capture = (source: string, destination: string): void => {
        if (!guard.owns(destination) && !guard.expected.has(destination)) return;
        if (merge && followSource) source = prospectivePhysicalPath(source);
        const value = guard.retain(source, destination);
        if (!value) return;
        if (guard.expected.has(source) && !same(guard.expected.get(source), value)) {
          notice(guard, [source]);
          if (execution.getStore() === guard) throw guard.error;
        }
        if (merge && !verbatimLinks && source !== destination && value.link !== undefined) {
          value.link = resolve(dirname(source), value.link); value.identity = `link:${value.link}`;
        }
        if (!(merge && source !== destination && value.stat.startsWith('directory:') && snapshot.get(destination)?.stat.startsWith('directory:'))) snapshot.set(destination, value);
        if (value.stat.startsWith('directory:')) for (const name of readdirSync(source)) capture(join(source, name), join(destination, name));
      };
      if (merge && existsSync(moved[1])) capture(moved[1], moved[1]);
      capture(moved[0], moved[1]);
      // Renaming two hardlinks of one object leaves both names in place.
      if (copy || sameStat(statEntry(moved[0]), statEntry(moved[1]))) capture(moved[0], moved[0]);
      postimages.set(guard, snapshot);
    } catch (error) {
      guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`);
      if (execution.getStore() === guard) throw guard.error;
    }
  }
  return () => {
    descendants ||= hasDirectory();
    for (const guard of guards) {
      if (!relevant(guard)) continue;
      const snapshot = postimages.get(guard);
      const intended = writes.get(guard);
      let actual: Snapshot;
      try { actual = current(guard); }
      catch (error) {
        guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`);
        // A child may replace the destination with an unscannable namespace.
        // The engine's last write is still the captured rename source, never
        // the child's replacement or the pre-publication destination.
        if (moved && snapshot) for (const path of new Set([...guard.expected.keys(), ...snapshot.keys()])) {
          if (!inside(moved[0], path) && !inside(moved[1], path)) continue;
          const value = snapshot.get(path), previous = guard.expected.get(path)?.backing;
          if (previous && previous !== value?.backing) rmSync(previous, { force: true });
          if (value) guard.expected.set(path, value); else guard.expected.delete(path);
        }
        continue;
      }
      for (const path of candidates(guard, actual, snapshot)) {
        if (!affected(path)) continue;
        const written = intended?.get(path);
        const deleted = remove && entries.some(root => inside(root, path));
        const createdDirectory = directory !== undefined && (directories ? directories.some(root => join(directoryParent!, basename(root)) === path)
          : entryAncestors.has(path) && guard.owns(path) && (entries.includes(path) || !guard.expected.has(path)));
        const changedMetadata = physical.includes(path) && (mode !== undefined || link !== undefined);
        const transferred = Boolean(written || deleted || createdDirectory || changedMetadata || moved && (inside(moved[0], path) || inside(moved[1], path)));
        if (!transferred && sameStat(guard.expected.get(path), actual.get(path))) continue;
        let value: Entry | undefined;
        let acknowledged = false;
        try {
          const previous = guard.expected.get(path);
          value = written ? written() : deleted ? undefined : createdDirectory
            ? previous ?? { identity: `directory:${0o40000 | directory!}`, stat: '', mode: 0o40000 | directory! }
            : changedMetadata && link !== undefined ? { identity: `link:${link}`, stat: '', link }
            : changedMetadata && mode !== undefined && previous?.mode !== undefined ? {
              ...previous, mode: (previous.mode & ~0o7777) | (mode & 0o7777),
              identity: previous.identity.replace(`:${previous.mode}`, `:${(previous.mode & ~0o7777) | (mode & 0o7777)}`),
            } : moved && (inside(moved[0], path) || inside(moved[1], path)) ? snapshot?.get(path) : previous;
          try { acknowledged = guard.owns(path) || guard.expected.has(path) ? same(value, entry(path)) : sameStat(value, actual.get(path)); }
          catch { /* an unscannable replacement cannot acknowledge the intended bytes */ }
        } catch (error) {
          guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`);
          continue;
        }
        notice(guard, acknowledged ? [] : [path]);
        if (acknowledged && value && actual.has(path)) value.stat = actual.get(path)!.stat;
        if (!transferred && !acknowledged) {
          if (value?.backing && value.backing !== guard.expected.get(path)?.backing) rmSync(value.backing, { force: true });
          continue;
        }
        const previous = guard.expected.get(path)?.backing;
        if (previous && previous !== value?.backing) rmSync(previous, { force: true });
        if (value) guard.expected.set(path, value); else guard.expected.delete(path);
      }
    }
  };
});
export function publishEngineFile<T>(path: string, action: () => T): T {
  return publishEngineFiles([path], action);
}
export { appendFileSync as appendEngineFile, writeFileSync as writeEngineFile } from './engine-fs.js';

export interface EngineExecution {
  projectDir: string;
  runDir?: string;
  stageId: string;
  artifactContract?: ArtifactContract;
}

/** Storage topology plus an in-memory digest ledger; no child path grants,
 * permissions beyond those of an ordinary child process. */
export async function withEngineIntegrity<T>(input: EngineExecution, action: () => Promise<T>): Promise<T> {
  // Preserve output confinement, then judge ownership before resolving configuration here.
  const outputs = input.runDir ? (input.artifactContract?.produces ?? []).map(artifact => {
    const output = resolveArtifactLocation(artifact, input.projectDir, input.runDir!);
    let refusalReason = '';
    if (producesEngineOwnedArtifact(artifact, { id: input.stageId, depends_on: [] }, input.runDir, input.projectDir, reason => { refusalReason = reason; })) {
      throw new EngineStateError(`ENGINE_STATE_REFUSED: output contains an engine carrier: ${artifact.path}${refusalReason ? `: ${refusalReason}` : ''}`);
    }
    return { artifact, output };
  }) : [];
  const project = prospectivePhysicalPath(resolve(input.projectDir));
  const run = input.runDir && prospectivePhysicalPath(resolve(input.runDir));
  const store = prospectivePhysicalPath(resolve(fcGlobalDir()));
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const distribution = prospectivePhysicalPath(import.meta.url.endsWith('.ts') ? join(dirname(moduleDirectory), 'dist') : moduleDirectory);
  if (inside(project, distribution) || inside(distribution, project)) {
    throw new EngineStateError('ENGINE_STATE_REFUSED: running engine distribution must be outside authored work');
  }
  if (inside(project, store) || inside(project, join(store, 'runs')) || inside(join(store, 'runs'), project) || (run && (inside(project, run) || inside(run, project)))) {
    throw new EngineStateError('ENGINE_STATE_REFUSED: project and engine storage must be separate physical trees');
  }
  if (engineOwnedDatabasePaths(store).some(file => inside(project, prospectivePhysicalPath(file)))) {
    throw new EngineStateError('ENGINE_STATE_REFUSED: engine database must be outside authored work');
  }
  const engine = run && engineDirectory(run);
  if (run) assertSeparatedRunLayout(run);
  const roots = [engine, run && join(run, 'run.json'), run && join(run, 'events.jsonl'), distribution]
    .filter((root): root is string => Boolean(root));
  if (run) {
    for (const { artifact, output } of outputs) {
      if (artifact.root !== 'run') continue;
      publishEngineFile(artifact.kind === 'directory' ? output : dirname(output), () => mkdirSync(artifact.kind === 'directory' ? output : dirname(output), { recursive: true }));
    }
    const contract = readAdmittedBriefContract(run);
    for (const output of contract.outputs.filter(o => isAbsolute(o.path))) {
      const directory = externalOutputDirectory(output, project, undefined, { runDir: run, inputPaths: contract.inputs.map(input => input.path) });
      publishEngineFile(directory, () => mkdirSync(directory, { recursive: true }));
    }
  }
  const owns = (path: string): boolean => roots.some(root => inside(root, path));
  // Diagnostic append-only records retain a prefix digest. The authoritative
  // lifecycle log needs a preimage so deleted carriers can be restored together.
  // run-history is a rewritable journal (tail repair/truncation), not a log.
  const appendOnly = (path: string): boolean => /\.(?:log|jsonl)$/.test(path)
    && path !== (run && join(run, 'events.jsonl'))
    && !/^run-history(?:[./]|$)/.test(relative(engine ?? distribution, path));
  const backing = mkdtempSync(join(tmpdir(), '.tmp-integrity-'));
  let sequence = 0;
  const retain = (path: string, destination = path): Entry | undefined => {
    const value = statEntry(path);
    if (!value || !value.identity.startsWith('file:')) return value;
    const hash = createHash('sha256');
    const saved = appendOnly(destination) ? undefined : join(backing, String(sequence++));
    if (saved) copyFileSync(path, saved, constants.COPYFILE_FICLONE);
    digestRange(saved ?? path, value.length!, hash);
    return { ...value, hash, backing: saved, identity: value.identity + hash.copy().digest('hex') };
  };

  // The write's bytes come from the engine call, never its mutable destination.
  // Keep an independent preimage for positioned writes and restoration. Partial
  // writeSync results shorten write.bytes before this deferred image is built.
  const prepareWrite: Guard['prepareWrite'] = (path, previous, write, append) => {
    if (previous && previous.length === undefined) throw new EngineStateError(`ENGINE_STATE_REFUSED: write target is not a regular engine file ${path}`);
    const priorLength = previous?.length ?? 0;
    const offset = append ? priorLength : write.position ?? 0;
    const replace = write.truncate || !previous;
    const prefix = previous?.hash?.copy() ?? (previous ? digestRange(path, priorLength) : createHash('sha256'));
    const saved = join(backing, String(sequence++));
    const needsPrior = !replace && (write.resize !== undefined || offset !== priorLength || !appendOnly(path));
    if (needsPrior && previous) {
      copyFileSync(previous.backing ?? path, saved, constants.COPYFILE_FICLONE);
      // Appends use the retained engine image and the cached prefix digest;
      // restoration checks that image again before publishing it.
      if ((!append || !previous.backing) && hashRollbackFileSync(saved).sha256 !== prefix.copy().digest('hex')) throw new EngineStateError(`ENGINE_STATE_TAMPERED: changed engine preimage ${path}`);
    }
    let resized: Hash | undefined;
    if (write.resize !== undefined) {
      resized = createHash('sha256');
      let cursor = 0;
      const original = priorLength ? digestRange(saved, priorLength, createHash('sha256'), 0, chunk => {
        resized!.update(chunk.subarray(0, Math.max(0, Math.min(chunk.length, write.resize! - cursor))));
        cursor += chunk.length;
      }) : createHash('sha256');
      if (original.digest('hex') !== prefix.copy().digest('hex')) throw new EngineStateError(`ENGINE_STATE_TAMPERED: changed engine preimage ${path}`);
      const zeros = Buffer.alloc(256 * 1024);
      for (let remaining = write.resize - priorLength; remaining > 0; remaining -= zeros.length) resized.update(zeros.subarray(0, Math.min(remaining, zeros.length)));
    }
    const mode = previous?.mode ?? (0o100000 | ((write.mode ?? 0o666) & ~process.umask()));
    return () => {
      const bytes = write.bytes, length = write.resize ?? (replace ? bytes.length : Math.max(priorLength, offset + bytes.length));
      const hash = resized ?? (replace ? createHash('sha256').update(bytes) : offset === priorLength ? prefix.copy().update(bytes) : createHash('sha256'));
      if (write.resize === undefined && !replace && offset !== priorLength) {
        let cursor = 0, inserted = false;
        const original = digestRange(saved, priorLength, createHash('sha256'), 0, chunk => {
          const end = cursor + chunk.length;
          if (cursor < offset) hash.update(chunk.subarray(0, Math.min(chunk.length, offset - cursor)));
          if (!inserted && end >= offset) { hash.update(bytes); inserted = true; }
          if (end > offset + bytes.length) hash.update(chunk.subarray(Math.max(0, offset + bytes.length - cursor)));
          cursor = end;
        });
        if (original.digest('hex') !== prefix.copy().digest('hex')) throw new EngineStateError(`ENGINE_STATE_TAMPERED: changed engine preimage ${path}`);
        if (!inserted) {
          const zeros = Buffer.alloc(256 * 1024);
          for (let remaining = offset - priorLength; remaining > 0; remaining -= zeros.length) hash.update(zeros.subarray(0, Math.min(remaining, zeros.length)));
          hash.update(bytes);
        }
      }
      let retained: string | undefined;
      if (!appendOnly(path)) {
        const descriptor = openSync(saved, needsPrior && previous ? 'r+' : 'w');
        try {
          for (let written = 0; written < bytes.length;) {
            const count = writeSync(descriptor, bytes, written, bytes.length - written, replace ? written : offset + written);
            if (count <= 0) throw new Error('Engine write image made no progress');
            written += count;
          }
          ftruncateSync(descriptor, length);
        } finally { closeSync(descriptor); }
        chmodSync(saved, mode);
        retained = saved;
      }
      return { identity: `file:${mode}:${length}:${hash.copy().digest('hex')}`, stat: statEntry(path)?.stat ?? '', length, hash, backing: retained, mode };
    };
  };

  const checkRoute = (): void => {
    if (prospectivePhysicalPath(resolve(input.projectDir)) !== project
        || (run && prospectivePhysicalPath(resolve(input.runDir!)) !== run)) {
      throw new EngineStateError('ENGINE_STATE_TAMPERED: execution storage route changed');
    }
  };
  const scan = (read: typeof entry = entry): Snapshot => {
    checkRoute();
    const result: Snapshot = new Map(), visited = new Set<string>(), ancestors = new Set<string>();
    const separate = (path: string): void => {
      if ([project, ...(run ? [stageWorkPath(run), requestPath(run), controlPath(run)] : [])].some(root => inside(root, path))) throw new EngineStateError(`ENGINE_STATE_REFUSED: engine carrier consults authored work ${path}`);
    };
    const walk = (path: string): void => {
      separate(path);
      const value = read(path);
      if (!value) return;
      result.set(path, value);
      if (value.link !== undefined) {
        const target = prospectivePhysicalPath(path, {
          lstat(component) {
            separate(component);
            const stat = lstatSync(component);
            if (stat.isSymbolicLink()) { separate(component); result.set(component, read(component)!); }
            return stat;
          }, readlink: readlinkSync,
        });
        if (!roots.some(root => inside(root, target))) throw new EngineStateError(`ENGINE_STATE_REFUSED: engine record resolves outside engine trees ${path}`);
        if (ancestors.has(target)) throw new EngineStateError(`ENGINE_STATE_REFUSED: cyclic protected directory link ${path}`);
        if (target === path || !existsSync(target)) throw new EngineStateError(`ENGINE_STATE_REFUSED: unresolved protected link ${path}`);
        if (!visited.has(path)) {
          visited.add(path);
          walk(target);
        }
      } else if (value.stat.startsWith('directory:') && !visited.has(path)) {
        visited.add(path); ancestors.add(path);
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          walk(child);
        }
        ancestors.delete(path);
      }
    };
    // Shared store databases serve concurrent runs and CLI readers. Their
    // bytes are not this attempt's facts; admission still reserves their paths.
    for (const root of roots) walk(root);
    for (const root of roots) {
      for (let parent = dirname(root); ; parent = dirname(parent)) {
        const value = statEntry(parent);
        if (value) result.set(parent, value);
        if (dirname(parent) === parent) break;
      }
    }
    return result;
  };
  try {
    let expected: Snapshot;
    try { expected = scan(path => run && inside(run, path) ? retain(path) : entry(path)); } catch (error) {
      throw new EngineStateError(`ENGINE_STATE_REFUSED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const guard: Guard = { checkRoute, scan, retain, prepareWrite, owns, expected };
    guards.add(guard);
    let result: T | undefined, failure: unknown;
    try { result = await execution.run(guard, action); } catch (error) { failure = error; } finally {
      try {
        const actual = scan();
        notice(guard, changed(guard, actual));
      } catch (error) { guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`); }
      guards.delete(guard);
    }
    if (guard.error) {
      // Rebuild parent directories first; restore the projection last so all
      // acknowledged histories exist before it becomes readable again.
      const records = [...guard.expected].filter(([path]) => run && inside(run, path));
      records.sort(([a], [b]) => a.split('/').length - b.split('/').length);
      for (const [path, value] of records) {
        if (!value.stat.startsWith('directory:') || prospectivePhysicalPath(dirname(path)) !== dirname(path)) continue;
        try {
          const current = entry(path);
          if (current && !current.stat.startsWith('directory:')) rmSync(path, { force: true });
          mkdirSync(path, { recursive: true, mode: value.mode });
          if (value.mode !== undefined) chmodSync(path, value.mode);
        } catch { /* namespace damage remains a failure */ }
      }
      try {
        for (const path of [...scan().keys()].sort((a, b) => b.length - a.length)) {
          if (run && inside(run, path) && !guard.expected.has(path) && prospectivePhysicalPath(dirname(path)) === dirname(path)) rmSync(path, { recursive: true, force: true });
        }
      } catch { /* unresolved namespace changes still void the result */ }
      // Restore ordinary run records for honest failure settlement. Never
      // follow a stage-installed parent link when restoring a carrier.
      // Restore and flush the log before restoring any lifecycle cache. The
      // snapshot preimage supplies metadata, but its status is still a fold.
      const restoreOrder = (path: string): number => path === join(run!, 'events.jsonl') ? -1 : path === join(run!, 'run.json') ? 1 : 0;
      records.sort(([a], [b]) => restoreOrder(a) - restoreOrder(b));
      let logRestoreFailed = false;
      for (const [path, value] of records) {
        if (!run || !inside(run, path) || prospectivePhysicalPath(dirname(path)) !== dirname(path) || same(value, entry(path))) continue;
        if (path === runRecordPath(run, 'run_event_status.json')) continue; // reconciled from log under lock below
        if (path === join(run, 'run.json') && logRestoreFailed) continue;
        try {
          if (value.backing) {
            const temporary = engine && !inside(engine, path) ? join(engine, `${basename(path)}.integrity-restore`) : `${path}.integrity-restore`;
            rmSync(temporary, { recursive: true, force: true });
            mkdirSync(dirname(path), { recursive: true });
            // Clone first, then hash the actual staged bytes. This preserves
            // sparse preimages while retaining the same exact-content check.
            copyFileSync(value.backing, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
            if (hashRollbackFileSync(temporary).sha256 !== value.hash!.copy().digest('hex')) { rmSync(temporary); continue; }
            if (path === join(run, 'run.json')) {
              let restored: { lifecycleAuthority?: unknown } | undefined;
              try { restored = JSON.parse(readFileSync(temporary, 'utf8')); }
              catch { /* Opaque legacy preimages must still be restored byte for byte. */ }
              if (restored && typeof restored === 'object' && hasLifecycleAuthority(restored)) {
                // A preceding parent append may have failed its own flush.
                flushTextRecords(join(run, 'events.jsonl'));
                writeFileSync(temporary, JSON.stringify(projectRunLifecycle(run, restored)) + '\n', { flush: true });
              }
            }
            if (entry(path)?.stat.startsWith('directory:')) rmSync(path, { recursive: true, force: true });
            renameSync(temporary, path);
            if (value.mode !== undefined) chmodSync(path, value.mode);
          } else if (value.hash) {
            // A digest can validate and trim an untrusted tail, but cannot
            // reconstruct a destroyed prefix. Leave that damage visible.
            if (digestRange(path, value.length!).digest('hex') === value.hash.copy().digest('hex')) {
              const descriptor = openSync(path, 'r+');
              try { ftruncateSync(descriptor, value.length!); } finally { closeSync(descriptor); }
            }
          } else if (value.link !== undefined) { rmSync(path, { recursive: true, force: true }); symlinkSync(value.link, path); }
          if (path === join(run, 'events.jsonl')) flushTextRecords(path);
        } catch {
          if (path === join(run, 'events.jsonl')) logRestoreFailed = true;
          /* namespace damage cannot turn a voided result into success */
        }
      }
      if (run && !logRestoreFailed) try { withRunStateLock(run, () => {}); } catch { /* retain unrecoverable damage */ }
      // Restoration is a parent publication too. Other active attempts retain
      // their own latched errors, but must not re-accuse the repaired namespace.
      for (const other of guards) {
        try {
          for (const path of new Set([...guard.expected.keys(), ...other.expected.keys()])) {
            if (!run || !inside(run, path) || !other.owns(path)) continue;
            const value = other.retain(path);
            if (value) other.expected.set(path, value); else other.expected.delete(path);
          }
        } catch { /* the surviving guard will fail closed */ }
      }
      throw guard.error;
    }
    if (failure !== undefined) throw failure;
    return result as T;
  } finally { rmSync(backing, { recursive: true, force: true }); }
}
