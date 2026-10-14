import { createHash } from 'node:crypto';
import { observeEnginePublications, publishEngineFiles } from './engine-fs.js';
export { publishEngineFiles } from './engine-fs.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fcGlobalDir } from './store.js';
import { engineOwnedDatabasePaths, isEngineOwnedRunPath, prospectivePhysicalPath } from './engine-owned-carriers.js';
import { producesEngineOwnedArtifact, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { externalOutputDirectory, extractBriefOutputDeclarations, extractDeclaredBriefInputPaths } from './ship-inputs.js';

type Entry = { identity: string; bytes?: Buffer; link?: string; mode?: number };
type Snapshot = Map<string, Entry>;
interface Guard { scan: () => Snapshot; owns: (path: string) => boolean; expected: Snapshot; error?: string }
const guards = new Set<Guard>();
const activeOutputs = new Set<string>();
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const privateNames = new Set(['codex_home', 'auth.json', 'credentials.json', 'installation_id']);
const same = (a?: Entry, b?: Entry): boolean => a?.identity === b?.identity;

function entry(path: string): Entry | undefined {
  try {
    const stat = lstatSync(path), inode = `${stat.dev}:${stat.ino}:${stat.mode}`;
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      return { identity: `link:${inode}:${link}`, link };
    }
    if (stat.isDirectory()) return { identity: `directory:${inode}`, mode: stat.mode };
    if (!stat.isFile()) throw new Error(`ENGINE_STATE_REFUSED: unsupported engine carrier ${path}`);
    const bytes = readFileSync(path);
    return { identity: `file:${inode}:${createHash('sha256').update(bytes).digest('hex')}`, bytes, mode: stat.mode };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function changed(guard: Guard, actual: Snapshot): string[] {
  return [...new Set([...guard.expected.keys(), ...actual.keys()])]
    .filter(path => !same(guard.expected.get(path), actual.get(path)));
}
function notice(guard: Guard, paths: string[]): void {
  if (paths.length) guard.error ??= `ENGINE_STATE_TAMPERED: stage result voided; changed engine carrier ${paths[0]}`;
}

/** Only synchronous parent publications advance the expected record. A child
 * has no access to this memory. Check before overwriting so an append or a later
 * engine publication cannot hide changed bytes. All concurrent guards advance. */
observeEnginePublications((paths, tree) => {
  const physical = [...new Set(paths.flatMap(path => [resolve(path), prospectivePhysicalPath(resolve(path))]))];
  const hasDirectory = (): boolean => tree && physical.some(path => {
    try { if (lstatSync(path).isDirectory()) return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return [...guards].some(guard => guard.expected.get(path)?.identity.startsWith('directory:'));
  });
  let descendants = hasDirectory();
  const affected = (path: string): boolean => physical.some(root => path === root || (descendants && inside(root, path)));
  const relevant = (guard: Guard): boolean => physical.some(path => guard.owns(path) || guard.expected.has(path)
    || (tree && [...guard.expected.keys()].some(candidate => inside(path, candidate))));
  for (const guard of guards) {
    if (!relevant(guard)) continue;
    if (descendants) notice(guard, changed(guard, guard.scan()).filter(affected));
    for (const path of physical) for (let candidate = path; ; candidate = dirname(candidate)) {
      if (guard.expected.has(candidate) || guard.owns(candidate)) notice(guard,
        same(guard.expected.get(candidate), entry(candidate)) ? [] : [candidate]);
      if (dirname(candidate) === candidate) break;
    }
    if (guard.error) throw new Error(guard.error);
  }
  // Only successful synchronous publications advance expected facts. A failed
  // write can contain child changes; keep its preimage for refusal and restoration.
  return () => {
    descendants ||= hasDirectory();
    for (const guard of guards) {
      if (!relevant(guard)) continue;
      if (descendants) {
        const current = guard.scan();
        for (const path of new Set([...guard.expected.keys(), ...current.keys()])) {
          if (!affected(path)) continue;
          const value = current.get(path);
          if (value) guard.expected.set(path, value); else guard.expected.delete(path);
        }
      }
      for (const path of physical) for (let candidate = path; ; candidate = dirname(candidate)) {
        if (guard.owns(candidate) || guard.expected.has(candidate)) {
          const value = entry(candidate);
          if (value) guard.expected.set(candidate, value); else guard.expected.delete(candidate);
        }
        if (dirname(candidate) === candidate) break;
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
    throw new Error('ENGINE_STATE_REFUSED: running engine distribution must be outside authored work');
  }
  if (inside(project, store) || inside(project, join(store, 'runs')) || inside(join(store, 'runs'), project) || (run && (inside(project, run) || inside(run, project)))) {
    throw new Error('ENGINE_STATE_REFUSED: project and engine storage must be separate physical trees');
  }
  if (engineOwnedDatabasePaths(store).some(file => inside(project, prospectivePhysicalPath(file)))) {
    throw new Error('ENGINE_STATE_REFUSED: engine database must be outside authored work');
  }
  const outputs = (input.artifactContract?.produces ?? []).filter(a => a.root === 'run'
    && !(input.structuredResult && (a.path === `verdict_${input.stageId}.json` || a.path === `handoff_${input.stageId}.md`)));
  if (run) {
    for (const artifact of outputs) {
      if (/^handoff_[^/]+\.md(?:\/|$)/.test(artifact.path) || producesEngineOwnedArtifact(artifact, { id: input.stageId, dynamic_dispatch: input.dynamicDispatch, depends_on: [] }, run, project)) {
        throw new Error(`ENGINE_STATE_REFUSED: output contains an engine carrier: ${artifact.path}`);
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
  const owns = (path: string): boolean => {
    if (path.split('/').some(part => privateNames.has(part)) || /\.tmp(?:[.-]|$)|\.integrity-restore$|\/\.run-state\.lock$/.test(path)
      || [...activeOutputs].some(root => inside(root, path))) return false;
    if (run && inside(run, path)) {
      const local = relative(run, path).split('\\').join('/');
      if (/^gate_reevaluation\/verdict_correction_[^/]+\.json$/.test(local)) return false;
      // The independent heartbeat warning is checked against live identity and never grades a result.
      if (local === 'scheduler-loop-stall.json') return false;
      // Operator resolutions enter through the shared inbox. The resident
      // scheduler publishes their canonical decision and event records.
      if (local === 'approvals.jsonl') return false;
      if (local === 'user_input.md' || local === 'signals' || /^signals\/interrupt_[^/]+\.json$/.test(local)) return false;
      if (/^stages\/[^/]+\/(?:approval_request|scope_revision_request|plan_revision_request|timeout_extension_request)\.json$/.test(local)) return false;
      return isEngineOwnedRunPath(local, { id: input.stageId, dynamic_dispatch: input.dynamicDispatch }) || /^handoff_[^/]+\.md(?:\/|$)/.test(local);
    }
    return inside(distribution, path);
  };
  const scan = (): Snapshot => {
    const result: Snapshot = new Map(), visited = new Set<string>(), ancestors = new Set<string>();
    const separate = (path: string): void => {
      if ([project, ...activeOutputs].some(root => inside(root, path))) throw new Error(`ENGINE_STATE_REFUSED: engine carrier consults authored work ${path}`);
    };
    const walk = (path: string, owned = true): void => {
      if (owned) separate(path);
      if (path.split('/').some(part => privateNames.has(part)) || /\.tmp(?:[.-]|$)|\.integrity-restore$|\/\.run-state\.lock$/.test(path) || [...activeOutputs].some(root => inside(root, path))) return;
      if (!owned && !lstatSync(path).isDirectory()) return;
      const value = entry(path);
      if (!value) return;
      if (owned) result.set(path, run && inside(run, path) ? value : { identity: value.identity, link: value.link });
      if (value.link !== undefined) {
        const target = prospectivePhysicalPath(path, {
          lstat(component) {
            if (component.split('/').some(part => privateNames.has(part))) throw new Error('ENGINE_STATE_REFUSED: private adapter state cannot carry engine records');
            const stat = lstatSync(component);
            if (stat.isSymbolicLink()) { separate(component); result.set(component, entry(component)!); }
            return stat;
          }, readlink: readlinkSync,
        });
        if (ancestors.has(target)) throw new Error(`ENGINE_STATE_REFUSED: cyclic protected directory link ${path}`);
        if (target === path || !existsSync(target)) throw new Error(`ENGINE_STATE_REFUSED: unresolved protected link ${path}`);
        if (!visited.has(path)) {
          visited.add(path);
          walk(target, owned);
        }
      } else if (value.identity.startsWith('directory:') && !visited.has(path)) {
        visited.add(path); ancestors.add(path);
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          walk(child, run && inside(run, child) ? owns(child) : owned);
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
        const value = entry(parent);
        if (value) result.set(parent, { identity: value.identity });
        if (dirname(parent) === parent) break;
      }
    }
    return result;
  };
  let expected: Snapshot;
  try { expected = scan(); } catch (error) {
    for (const path of exclusions) activeOutputs.delete(path);
    throw new Error(`ENGINE_STATE_REFUSED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const guard: Guard = { scan, owns, expected };
  guards.add(guard);
  let result: T | undefined, failure: unknown;
  try { result = await action(); } catch (error) { failure = error; } finally {
    try { notice(guard, changed(guard, scan())); } catch (error) { guard.error ??= `ENGINE_STATE_TAMPERED: stage result voided; ${String(error)}`; }
    guards.delete(guard);
    for (const path of exclusions) activeOutputs.delete(path);
    for (const other of guards) {
      const current = other.scan();
      for (const [path, value] of current) if (exclusions.some(root => inside(root, path))) other.expected.set(path, value);
    }
  }
  if (guard.error) {
    // Rebuild parent directories first; restore the projection last so all
    // acknowledged histories exist before it becomes readable again.
    const records = [...guard.expected].filter(([path]) => run && inside(run, path));
    records.sort(([a], [b]) => a.split('/').length - b.split('/').length);
    for (const [path, value] of records) {
      if (!value.identity.startsWith('directory:') || prospectivePhysicalPath(dirname(path)) !== dirname(path)) continue;
      try {
        const current = entry(path);
        if (current && !current.identity.startsWith('directory:')) rmSync(path, { force: true });
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
        if (value.bytes) {
          const temporary = `${path}.integrity-restore`;
          rmSync(temporary, { recursive: true, force: true });
          writeFileSync(temporary, value.bytes, { mode: value.mode, flag: 'wx' });
          if (entry(path)?.identity.startsWith('directory:')) rmSync(path, { recursive: true, force: true });
          renameSync(temporary, path);
          if (value.mode !== undefined) chmodSync(path, value.mode);
        } else if (value.link !== undefined) { rmSync(path, { recursive: true, force: true }); symlinkSync(value.link, path); }
      } catch { /* namespace damage cannot turn a voided result into success */ }
    }
    // Restoration is a parent publication too. Other active attempts retain
    // their own latched errors, but must not re-accuse the repaired namespace.
    for (const other of guards) {
      try {
        for (const path of new Set([...guard.expected.keys(), ...other.expected.keys()])) {
          if (!run || !inside(run, path) || !other.owns(path)) continue;
          const value = entry(path);
          if (value) other.expected.set(path, value); else other.expected.delete(path);
        }
      } catch { /* the surviving guard will fail closed */ }
    }
    throw new Error(guard.error);
  }
  if (failure !== undefined) throw failure;
  return result as T;
}
