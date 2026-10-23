import { tmpdir } from 'node:os';
import { createHash, type Hash } from 'node:crypto';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { isSessionHomeName } from './adapter-session.js';
import { observeEnginePublications, publishEngineFiles } from './engine-fs.js';
export { publishEngineFiles } from './engine-fs.js';
import { chmodSync, constants, copyFileSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fcGlobalDir } from './store.js';
import { engineOwnedDatabasePaths, isEngineOwnedRunPath, prospectivePhysicalPath } from './engine-owned-carriers.js';
import { producesEngineOwnedArtifact, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { externalOutputDirectory, extractBriefOutputDeclarations, extractDeclaredBriefInputPaths } from './ship-inputs.js';

export class EngineStateError extends Error {}

type Entry = { identity: string; stat: string; length?: number; hash?: Hash; backing?: string; link?: string; mode?: number };
type Snapshot = Map<string, Entry>;
interface Guard { scan: (read?: typeof entry) => Snapshot; retain: (path: string, previous?: Entry, destination?: string) => Entry | undefined; owns: (path: string) => boolean; expected: Snapshot; error?: EngineStateError }
const guards = new Set<Guard>();
const activeOutputs = new Set<string>();
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const privateNames = new Set(['auth.json', 'credentials.json', 'installation_id']);
const privateName = (name: string): boolean => privateNames.has(name) || isSessionHomeName(name);
const same = (a?: Entry, b?: Entry): boolean => a?.identity === b?.identity;

// Content decides whether a stage is valid; stat facts only guard synchronous
// parent publications against adopting a child's intervening write.
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

function writeAll(descriptor: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const count = writeSync(descriptor, bytes, offset);
    if (count <= 0) throw new Error('Engine recovery write made no progress');
    offset += count;
  }
}

function changed(guard: Guard, actual: Snapshot): string[] {
  return [...new Set([...guard.expected.keys(), ...actual.keys()])]
    .filter(path => !same(guard.expected.get(path), actual.get(path)));
}
function notice(guard: Guard, paths: string[]): void {
  if (paths.length) guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; changed engine carrier ${paths[0]}`);
}

/** Only synchronous parent publications advance the expected record. A child
 * has no access to this memory. Check before overwriting so an append or a later
 * engine publication cannot hide changed bytes. All concurrent guards advance. */
observeEnginePublications((paths, tree, publication) => {
  const { transfer, append } = publication ?? {};
  // A rename transfers the staged object, including its identity. Reading the
  // destination after rename can instead adopt a concurrent child's deletion
  // or replacement as a trusted parent publication.
  const moved = transfer?.map(path => join(prospectivePhysicalPath(dirname(resolve(path))), basename(path)));
  const postimages = new Map<Guard, Snapshot>();
  const physical = [...new Set([...paths.flatMap(path => [resolve(path), prospectivePhysicalPath(resolve(path))]), ...(moved ?? [])])];
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
    if (!relevant(guard)) continue;
    const actual = current(guard);
    notice(guard, [...candidates(guard, actual)]
      .filter(path => affected(path) && !sameStat(guard.expected.get(path), actual.get(path))));
    if (guard.error) throw guard.error;
    if (!moved) continue;
    const snapshot: Snapshot = new Map();
    const capture = (source: string, destination: string): void => {
      if (!guard.owns(destination) && !guard.expected.has(destination)) return;
      const value = guard.retain(source, undefined, destination);
      if (!value) return;
      snapshot.set(destination, value);
      if (value.stat.startsWith('directory:')) for (const name of readdirSync(source)) capture(join(source, name), join(destination, name));
    };
    capture(moved[0], moved[1]);
    // Renaming two hardlinks of one object leaves both names in place.
    if (sameStat(statEntry(moved[0]), statEntry(moved[1]))) capture(moved[0], moved[0]);
    postimages.set(guard, snapshot);
  }
  return () => {
    descendants ||= hasDirectory();
    for (const guard of guards) {
      if (!relevant(guard)) continue;
      const actual = current(guard), snapshot = postimages.get(guard);
      for (const path of candidates(guard, actual, snapshot)) {
        if (!affected(path)) continue;
        const transferred = moved && (inside(moved[0], path) || inside(moved[1], path));
        if (!transferred && sameStat(guard.expected.get(path), actual.get(path))) continue;
        const value = transferred ? snapshot?.get(path) : actual.has(path) ? guard.retain(path, append ? guard.expected.get(path) : undefined) : undefined;
        const acknowledged = sameStat(value, actual.get(path));
        notice(guard, acknowledged ? [] : [path]);
        if (!transferred && !acknowledged) {
          const previous = guard.expected.get(path);
          if (value?.backing && value.backing === previous?.backing) {
            const descriptor = openSync(value.backing, 'r+');
            try { ftruncateSync(descriptor, previous.length!); } finally { closeSync(descriptor); }
          }
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
  dynamicDispatch?: boolean;
  artifactContract?: ArtifactContract;
  structuredResult?: boolean;
}

/** Storage topology plus an in-memory digest ledger; no child path grants,
 * permissions beyond those of an ordinary child process. */
export async function withEngineIntegrity<T>(input: EngineExecution, action: () => Promise<T>): Promise<T> {
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
  const outputs = (input.artifactContract?.produces ?? []).filter(a => a.root === 'run'
    && !(input.structuredResult && (a.path === `verdict_${input.stageId}.json` || a.path === `handoff_${input.stageId}.md`)));
  if (run) {
    for (const artifact of outputs) {
      if (/^handoff_[^/]+\.md(?:\/|$)/.test(artifact.path) || producesEngineOwnedArtifact(artifact, { id: input.stageId, dynamic_dispatch: input.dynamicDispatch, depends_on: [] }, run, project)) {
        throw new EngineStateError(`ENGINE_STATE_REFUSED: output contains an engine carrier: ${artifact.path}`);
      }
      const output = resolveArtifactLocation(artifact, project, run);
      const directory = artifact.kind === 'directory' ? output : dirname(output);
      publishEngineFile(directory, () => mkdirSync(directory, { recursive: true }));
    }
    const briefPath = join(run, 'task_brief.md');
    const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
    for (const output of extractBriefOutputDeclarations(brief).filter(o => isAbsolute(o.path))) {
      const directory = externalOutputDirectory(output, project, undefined, { runDir: run, inputPaths: extractDeclaredBriefInputPaths(brief) });
      publishEngineFile(directory, () => mkdirSync(directory, { recursive: true }));
    }
  }
  const exclusions = outputs.map(a => join(run!, a.path));
  for (const path of exclusions) activeOutputs.add(path);
  // Concurrent declared publications are authored work, never engine facts.
  for (const guard of guards) for (const path of guard.expected.keys()) {
    if (exclusions.some(root => inside(root, path))) guard.expected.delete(path);
  }
  // Rollback payloads have a retained digest checked by restoreProjectPath.
  // Admission still reserves their namespace; they are not engine decisions.
  const rollbackBlobs = run && join(run, '.rollback-preimages');
  const isRollbackBlob = (path: string): boolean => Boolean(rollbackBlobs && inside(rollbackBlobs, path));
  const excluded = (path: string): boolean => {
    const root = run && inside(run, path) ? run : inside(distribution, path) ? distribution : undefined;
    // A temporary ancestor does not make an entire nested engine disposable.
    // Only temporary entries inside the protected carrier tree are exempt.
    const local = root === undefined ? '' : relative(root, path).split('\\').join('/');
    return path.split('/').some(privateName) || /\.tmp(?:[.-]|$)|\.integrity-restore$|(?:^|\/)\.run-state\.lock$/.test(local)
      || [...activeOutputs].some(root => inside(root, path));
  };
  const owns = (path: string): boolean => {
    if (isRollbackBlob(path)) return false;
    if (excluded(path)) return false;
    if (run && inside(run, path)) {
      const local = relative(run, path).split('\\').join('/');
      if (/^gate_reevaluation\/verdict_correction_[^/]+\.json$/.test(local)) return false;
      // The independent heartbeat warning is checked against live identity and never grades a result.
      if (local === 'scheduler-loop-stall.json') return false;
      // Operator resolutions enter through the shared inbox. The resident
      // scheduler publishes their canonical decision and event records.
      if (local === 'approvals.jsonl') return false;
      if (local === 'user_input.md' || local === 'signals' || /^signals\/interrupt_[^/]+\.json$/.test(local)) return false;
      if (/^stages\/[^/]+\/(?:approval_request|plan_revision_request)\.json$/.test(local)) return false;
      return isEngineOwnedRunPath(local, { id: input.stageId, dynamic_dispatch: input.dynamicDispatch }) || /^handoff_[^/]+\.md(?:\/|$)/.test(local);
    }
    return inside(distribution, path);
  };
  // Append-only text records retain a prefix digest, never a disk preimage.
  // run-history is a rewritable journal (tail repair/truncation), not a log.
  const appendOnly = (path: string): boolean => /\.(?:log|jsonl)$/.test(path)
    && !/^run-history(?:[./]|$)/.test(relative(run ?? distribution, path));
  const backing = mkdtempSync(join(tmpdir(), '.tmp-integrity-'));
  let sequence = 0;
  const retain = (path: string, previous?: Entry, destination = path): Entry | undefined => {
    const value = statEntry(path);
    if (!value || !value.identity.startsWith('file:')) return value;
    if (previous?.hash && value.length! < previous.length!) throw new EngineStateError(`ENGINE_STATE_TAMPERED: append truncated carrier ${path}`);
    const start = previous?.hash ? previous.length! : 0;
    const hash = previous?.hash?.copy() ?? createHash('sha256');
    let saved: string | undefined, descriptor: number | undefined;
    if (!appendOnly(destination)) {
      saved = previous?.backing ?? join(backing, String(sequence++));
      if (previous?.backing) descriptor = openSync(saved, 'a');
      else copyFileSync(path, saved, constants.COPYFILE_FICLONE);
    }
    try {
      digestRange(descriptor === undefined && saved ? saved : path, value.length!, hash, start,
        descriptor === undefined ? undefined : bytes => writeAll(descriptor!, bytes));
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
    return { ...value, hash, backing: saved, identity: value.identity + hash.copy().digest('hex') };
  };

  const scan = (read: typeof entry = entry): Snapshot => {
    const result: Snapshot = new Map(), visited = new Set<string>(), ancestors = new Set<string>();
    const separate = (path: string): void => {
      if ([project, ...activeOutputs].some(root => inside(root, path))) throw new EngineStateError(`ENGINE_STATE_REFUSED: engine carrier consults authored work ${path}`);
    };
    const walk = (path: string): void => {
      if (isRollbackBlob(path)) throw new EngineStateError(`ENGINE_STATE_REFUSED: engine record aliases rollback payload ${path}`);
      separate(path);
      if (excluded(path)) return;
      const value = read(path);
      if (!value) return;
      // Operators may create the request inbox during a stage. Its children
      // still carry protected abort records alongside untrusted requests.
      if (!run || path !== join(run, 'signals')) result.set(path, value);
      if (value.link !== undefined) {
        const target = prospectivePhysicalPath(path, {
          lstat(component) {
            if (component.split('/').some(privateName)) throw new EngineStateError('ENGINE_STATE_REFUSED: private adapter state cannot carry engine records');
            const stat = lstatSync(component);
            if (stat.isSymbolicLink()) { separate(component); result.set(component, read(component)!); }
            return stat;
          }, readlink: readlinkSync,
        });
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
          if (!run || !inside(run, child) || owns(child) || child === join(run, 'signals')) walk(child);
        }
        ancestors.delete(path);
      }
    };
    if (run) walk(run);
    // Shared store databases serve concurrent runs and CLI readers. Their
    // bytes are not this attempt's facts; admission still reserves their paths.
    walk(distribution);
    for (const root of [run, distribution].filter((root): root is string => Boolean(root))) {
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
      for (const path of exclusions) activeOutputs.delete(path);
      throw new EngineStateError(`ENGINE_STATE_REFUSED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const guard: Guard = { scan, retain, owns, expected };
    guards.add(guard);
    let result: T | undefined, failure: unknown;
    try { result = await action(); } catch (error) { failure = error; } finally {
      try { notice(guard, changed(guard, scan())); } catch (error) { guard.error ??= new EngineStateError(`ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`); }
      guards.delete(guard);
      for (const path of exclusions) activeOutputs.delete(path);
      for (const other of guards) {
        const current = other.scan(statEntry);
        for (const [path, value] of current) {
          if (!exclusions.some(root => inside(root, path))) continue;
          const retained = other.retain(path);
          notice(other, sameStat(value, retained) ? [] : [path]);
          if (sameStat(value, retained)) other.expected.set(path, retained!);
        }
      }
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
      records.sort(([a], [b]) => Number(a === join(run!, 'run.json')) - Number(b === join(run!, 'run.json')));
      for (const [path, value] of records) {
        if (!run || !inside(run, path) || prospectivePhysicalPath(dirname(path)) !== dirname(path) || same(value, entry(path))) continue;
        try {
          if (value.backing) {
            const temporary = `${path}.integrity-restore`;
            rmSync(temporary, { recursive: true, force: true });
            mkdirSync(dirname(path), { recursive: true });
            const descriptor = openSync(temporary, 'wx', value.mode);
            let digest: Hash;
            try { digest = digestRange(value.backing, value.length!, undefined, 0, bytes => writeAll(descriptor, bytes)); }
            finally { closeSync(descriptor); }
            if (digest.digest('hex') !== value.hash!.copy().digest('hex')) { rmSync(temporary); continue; }
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
        } catch { /* namespace damage cannot turn a voided result into success */ }
      }
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
