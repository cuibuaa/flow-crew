import { putEvidence } from './state.js';
import type { RunAuthority, RunLocation } from '../contract/runtime.js';
import type { AdmittedBrief, Hash, Ref, Result } from '../contract/brief.js';
import { type GitContext, type AttemptAddress, type Checkpoint, type CheckpointId, type Journal, type OutputReceipt, type Writer } from '../contract/runtime.js';
import { probeOwner, nativeTool, nativeSpawn, publishNoReplace, type Claim } from '../host/process.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, rm, readdir, readlink, open, appendFile } from 'node:fs/promises';
import { constants, createReadStream, type PathLike } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { idSchema } from '../contract/brief.js';
import { recordOperation, readEvents, readProjection, readClosure, appendEvents } from './state.js';
import { readEvidence, validateRecordRef, evidenceRepository, publishObject, git, syncDirectory } from './evidence.js';
/** Raw file bytes, shared by declared input hashes and import identity. */
export async function fileHash(path: PathLike): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Ephemeral import identity; no Git objects or basename-dependent snapshot metadata.
 * Includes every entry's raw relative name, kind, permissions, file hash or link bytes.
 * Exclusions are exact relative paths shared with the copier. Times, ownership and
 * device numbers describe the carrier, not the imported content.
 */
export async function contentIdentity(root: string, excluded: readonly string[]): Promise<string> {
  const exclusions = new Set(excluded.map(name => Buffer.from(name).toString('hex')));
  const hash = createHash('sha256');
  const visit = async (path: Buffer, parts: readonly Buffer[]): Promise<void> => {
    const name = parts.map(part => part.toString('hex')).join('2f');
    if (exclusions.has(name)) return;
    const stat = await lstat(path);
    const content = stat.isFile() ? await fileHash(path) : stat.isSymbolicLink()
      ? (await readlink(path, { encoding: 'buffer' })).toString('hex') : null;
    hash.update(JSON.stringify([name, stat.mode & 0o170000, stat.mode & 0o7777, content]) + '\n');
    if (stat.isDirectory()) for (const child of (await readdir(path, { encoding: 'buffer' })).sort(Buffer.compare))
      await visit(Buffer.concat([path, Buffer.from('/'), child]), [...parts, child]);
  };
  await visit(Buffer.from(root), []);
  return hash.digest('hex');
}

/**  Physical scope plus immutable brief and original setup baselines. */
export interface ContentScope {
  readonly journal: Journal;
  readonly layout: RecordLayout;
  readonly brief: AdmittedBrief;
  readonly inputBaseline: readonly Ref[];
  readonly outputBaseline: readonly Ref[];
  readonly projectClaim: Claim;
  readonly git?: GitContext;
  readonly authority: RunAuthority;
}

/** The baseline manifest authenticates the declaration path as part of its content identity. */
async function inputIdentities(journal: Journal, refs: readonly Ref[]): Promise<Map<string, Ref>> {
  const byPath = new Map<string, Ref>();
  for (const ref of refs) {
    const read = await readEvidence(journal, ref);
    if (!read.ok) continue;
    let manifest: { format: string; path: string };
    try { manifest = JSON.parse(Buffer.from(read.value).toString('utf8')); } catch { continue; }
    if (manifest?.format === 'flowcrew-baseline-v2' && typeof manifest.path === 'string') byPath.set(manifest.path, ref);
  }
  return byPath;
}
/** Compare frozen identities using authenticated paths, independent of either list's order. */
export async function frozenInputsMatch(journal: Journal, brief: AdmittedBrief, observed: readonly Ref[], baseline: readonly Ref[]): Promise<boolean> {
  if (!brief.declaration.inputs.some(input => input.frozen)) return true;
  const current = await inputIdentities(journal, observed), original = await inputIdentities(journal, baseline);
  return brief.declaration.inputs.every(input => !input.frozen
    || (original.has(input.path) && current.get(input.path)?.sha256 === original.get(input.path)!.sha256));
}

/**  Narrow frozen-byte audit, including proven restoration. */
export interface FrozenSettlement {
  readonly state: 'unchanged' | 'restored' | 'quarantined';
  readonly evidence: readonly Ref[];
  readonly inputs: readonly Ref[];
}

type Snapshot = {
  tree: string; kind: 'absent' | 'file' | 'directory' | 'symlink' | 'special'; mode: number;
  leaf: string; modes: [string, number][]; empty: string[]; specials: [string, number, number, number][]; sha256?: string
};
type Tree = { format: 'flowcrew-tree-v3'; roots: { path: string; snapshot: Snapshot }[] };
function failResult(kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }
class Refusal extends Error {
  constructor(readonly kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string) { super(detail); }
}
const fail = (kind: Refusal['kind'], detail: string): never => { throw new Refusal(kind, detail); };
const digest = (bytes: Uint8Array | string): Hash => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function decodeJSON(content: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(content).toString('utf8')); }
  catch { return fail('invalid', 'Malformed content manifest'); }
}
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
async function result<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (error instanceof Refusal) return { ok: false, kind: error.kind, detail: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, kind: code === 'ENOENT' ? 'unavailable' : 'unknown', detail: String(error) };
  }
}
function known<T>(value: Result<T>): T {
  if (!value.ok) return fail(value.kind, value.detail);
  return value.value;
}
function location(scope: ContentScope, path: string) {
  return isAbsolute(path) ? path : resolve(scope.layout.project, path);
}
async function canonical(path: string, missing = false): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) await canonical(parent, missing);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || await realpath(absolute) !== absolute) fail('invalid', 'Aliased content path');
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
async function safeScope(scope: ContentScope): Promise<void> {
  known(await validateRecordLayout(scope.layout));
  if (resolve(scope.projectClaim.resource) !== scope.layout.project) fail('conflict', 'Project claim names another resource');
  const owner = await probeOwner(scope.projectClaim.owner);
  if (owner === 'unknown') fail('unknown', 'Project owner is unknown');
  if (owner !== 'live') fail('conflict', 'Project claim owner is not live');
}
async function quiescent(scope: ContentScope): Promise<void> {
  await safeScope(scope);
  known(await readClosure(scope.journal, [scope.projectClaim.owner]));
}
/**  Canonical run/project/record layout. */
export interface RecordLayout {
  readonly location: RunLocation;
  readonly project: string;
  readonly protectedRoots: readonly string[];
}

/**  Validate disjoint physical destinations for engine import, restore and publication. */
export async function validateRecordLayout(layout: RecordLayout): Promise<Result<RecordLayout>> {
  const held: import('node:fs/promises').FileHandle[] = [];
  try {
    if (!idSchema.safeParse(layout.location.run).success || !layout.protectedRoots.length)
      return failResult('invalid', 'Missing run identity or protected roots');
    const store = await canonicalDirectory(layout.location.storeRoot);
    const run = await canonicalDirectory(join(store, 'runs', layout.location.run));
    if (!layout.protectedRoots.some(root => contains(root, run))) return failResult('invalid', 'Journal destination is not declared');
    const roots = [layout.project, ...layout.protectedRoots];
    const identities = new Set<string>();
    for (const [index, root] of roots.entries()) {
      if (!isAbsolute(root) || resolve(root) !== root) throw Error('Noncanonical record destination');
      await canonical(root, index > 0);
      for (const other of roots.slice(index + 1)) if (contains(root, other) || contains(other, root))
        return failResult('conflict', 'Record and project roots overlap');
      try {
        // SQLite WAL/SHM names can disappear between observations. Hold the
        // compared inode alive so a later file cannot recycle its identity.
        const handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
        held.push(handle);
        const info = await handle.stat();
        if (index === 0 && !info.isDirectory()) throw Error('Project is not a directory');
        const inode = `${info.dev}:${info.ino}`;
        if (identities.has(inode)) return failResult('invalid', 'Physically aliased record destinations');
        identities.add(inode);
      } catch (error) { if (index === 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { ok: true, value: layout };
  } catch (error) { return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'invalid',
    detail: String(error) }; }
  finally { await Promise.all(held.map(handle => handle.close())); }
}

function contains(root: string, target: string): boolean { return target === root || target.startsWith(root + sep); }
async function canonicalDirectory(path: string): Promise<string> {
  await canonical(path);
  if (!(await lstat(path)).isDirectory()) throw Error('Root is not a directory');
  return path;
}

/** Engine Git metadata has a separate destination; each worker uses independent scratch metadata. */
export function gitAuthority(location: RunLocation, project: string): GitContext {
  return {
    worktree: project, commonDir: evidenceRepository({ root: join(resolve(location.storeRoot), 'runs', location.run), database: location.database }),
    privateDir: join(resolve(location.storeRoot), 'work', location.run, 'git'), baseCommit: null
  };
}
async function nativeContent(journal: Journal, action: 'capture' | 'restore' | 'append' | 'changed', root: string, value?: unknown): Promise<Buffer> {
  const execute = async () => {
    const { child, done: closed } = await nativeSpawn([await nativeTool('python3'), '-I', '-S', '-B', '-c', gitContentPython,
    evidenceRepository(journal), action, root, await nativeTool('git')], { env: {} });
    const chunks: Buffer[] = []; let error = '';
    child.stdout.on('data', bytes => chunks.push(Buffer.from(bytes))); child.stderr.on('data', bytes => { error += bytes; });
    child.stdin.on('error', () => undefined); child.stdin.end(value ? JSON.stringify(value) : undefined);
    const code = await closed;
    if (code !== 0) fail(code === 75 ? 'conflict' : 'invalid', error);
    return { ok: true as const, value: Buffer.concat(chunks) };
  };
  return known(await execute());
}
function checkedSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot;
  if (!snapshot || !/^[a-f0-9]{40}$/.test(snapshot.tree) || !['absent', 'file', 'directory', 'symlink', 'special'].includes(snapshot.kind)
    || !Number.isInteger(snapshot.mode) || snapshot.mode < 0 || snapshot.mode > 0o7777 || typeof snapshot.leaf !== 'string'
    || !Array.isArray(snapshot.modes) || !Array.isArray(snapshot.empty) || !Array.isArray(snapshot.specials)) fail('invalid',
      'Invalid Git content metadata');
  // Metadata paths describe observed byte names, independently of authored path syntax.
  const path = (hex: unknown) => {
    if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})*$/.test(hex)) fail('invalid', 'Invalid raw metadata path');
    const parts = Buffer.from(hex as string, 'hex').toString('latin1').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) fail('invalid', 'Escaping metadata path');
  };
  if (snapshot.leaf) path(snapshot.leaf);
  for (const name of snapshot.empty) path(name);
  for (const row of [...snapshot.modes, ...snapshot.specials]) { if (!Array.isArray(row)) fail('invalid', 'Invalid metadata row'); path(row[0]); }
  return snapshot;
}
export async function snapshotTask(journal: Journal, root: string): Promise<Result<Snapshot>> {
  return result(async () => { const captured = checkedSnapshot(decodeJSON(await nativeContent(journal, 'capture', root)));
    await publishObject(journal, captured.tree, 'content/' + captured.tree); return captured; });
}
async function snapshot(journal: Journal, root: string): Promise<Snapshot> {
  return known(await recordOperation<Snapshot>(journal, 'construct', { module: import.meta.url, method: 'snapshotTask', args: [journal, root] }));
}
export function restoreTask(journal: Journal, root: string, captured: Snapshot): Promise<Result<true>> { return result(async () => {
  await canonical(dirname(root)); await nativeContent(journal, 'restore', root, captured); return true as const; }); }
async function input(scope: ContentScope, index: number): Promise<Ref> {
  const declaration = scope.brief.declaration.inputs[index], path = location(scope, declaration.path);
  await canonical(path, true);
  const captured = await snapshot(scope.journal, path);
  if (captured.kind !== 'absent' && captured.kind !== declaration.kind) fail('invalid', 'Input kind mismatch');
  if (declaration.sha256 && declaration.sha256 !== captured.sha256) fail('conflict', 'Declared input digest mismatch');
  return known(await putEvidence(scope.journal, bytes({ format: 'flowcrew-baseline-v2', path: declaration.path, snapshot: captured })));
}
async function baselineSnapshot(scope: ContentScope, ref: Ref, path: string): Promise<Snapshot> {
  const parsed = decodeJSON(known(await readEvidence(scope.journal, ref))) as { format: string; path: string; snapshot: unknown };
  if (parsed?.format !== 'flowcrew-baseline-v2' || parsed.path !== path) fail('invalid', 'Baseline manifest identity mismatch');
  return checkedSnapshot(parsed.snapshot);
}
async function tree(scope: ContentScope): Promise<Tree> {
  known(await validateRecordLayout(scope.layout));
  const roots: Tree['roots'] = [{ path: PROJECT, snapshot: await snapshot(scope.journal, scope.layout.project) }];
  const external = scope.authority.outputs.filter(output => output.write === 'exact').map(output => output.absolute).sort();
  for (const path of external) {
    if (external.some(other => other !== path && inside(other, path))) continue;
    if (scope.layout.protectedRoots.some(root => inside(root, path) || inside(path, root))) fail('invalid', 'Output overlaps protected records');
    await canonical(dirname(path)); roots.push({ path, snapshot: await snapshot(scope.journal, path) });
  }
  return { format: 'flowcrew-tree-v3', roots };
}

/** The root every generation has and `decodeTree` guarantees: the project, first and named by its path. */
const PROJECT = 'project';
const projectRoot = (tree: Tree) => tree.roots.find(root => root.path === PROJECT)!;

async function decodeTree(journal: Journal, manifest: Ref): Promise<Tree> {
  const parsed = decodeJSON(known(await readEvidence(journal, manifest))) as Tree;
  if (parsed?.format !== 'flowcrew-tree-v3' || Object.keys(parsed).some(key => !['format', 'roots'].includes(key)) ||
    !Array.isArray(parsed.roots) || !parsed.roots.length || parsed.roots[0].path !== PROJECT) fail('invalid', 'Invalid checkpoint manifest');
  const seen = new Set<string>();
  for (const root of parsed.roots) {
    if (!root || typeof root.path !== 'string' || seen.has(root.path) || (root.path !== PROJECT && !isAbsolute(root.path))) fail('invalid',
      'Invalid checkpoint root');
    seen.add(root.path); checkedSnapshot(root.snapshot);
    await git(journal, ['cat-file', '-e', root.snapshot.tree + '^{tree}']);
  }
  return parsed;
}
async function install(journal: Journal, root: string, captured: Snapshot): Promise<void> {
  known(await recordOperation(journal, 'restore', { module: import.meta.url, method: 'restoreTask', args: [journal, root, captured] }));
}
const flushDirectory = syncDirectory;
/**  Hash exactly declared inputs, including ignored/external paths and kind checks. `only` names declaration positions; the
 * result follows its order (default: every declared input). */
export function hashInputs(scope: ContentScope, only?: readonly number[]): Promise<Result<readonly Ref[]>> {
  return result(async () => {
    known(await validateRecordLayout(scope.layout));
    const refs: Ref[] = [];
    for (const index of only ?? scope.brief.declaration.inputs.keys()) {
      const ref = await input(scope, index);
      refs.push(ref);
    }
    return refs;
  });
}

/**  Identify the full persistent project plus declared external outputs, modes/symlinks/deletions included. */
export function captureTree(scope: ContentScope): Promise<Result<Hash>> {
  return result(async () => known(await captureGeneration(scope)).sha256);
}

export function captureGeneration(scope: ContentScope): Promise<Result<Ref>> {
  return result(async () => known(await putEvidence(scope.journal, bytes(await tree(scope)))));
}

/** Native Git delta plus exact metadata generations; observed byte names stay in raw evidence. */
export function contentDelta(journal: Journal, before: Ref, after: Ref): Promise<Result<Ref>> {
  return result(async () => {
    const prior = await decodeTree(journal, before), next = await decodeTree(journal, after);
    const deltas = [];
    for (const root of prior.roots) {
      const following = next.roots.find(item => item.path === root.path);
      if (!following) fail('conflict', 'Generation roots changed');
      const raw = await git(journal, ['diff-tree', '--no-commit-id', '--raw', '-z', '-r', root.snapshot.tree, following!.snapshot.tree]);
      deltas.push({ root: root.path, git: raw.toString('base64'), before: root.snapshot, after: following!.snapshot });
    }
    return known(await putEvidence(journal, bytes({ before, after, deltas })));
  });
}

export { verifyRuntime } from './pin.js';

async function recordedTree(journal: Journal, sha256: Hash): Promise<Tree> {
  return decodeTree(journal, { sha256, path: 'git/objects/' + (await git(journal, ['rev-parse', 'refs/evidence/' + sha256])).toString().trim() });
}

type Root = Tree['roots'][number];
type Recorded = { readonly path: string; readonly what: string; readonly before: string; readonly after: string };
const octal = (mode: number) => '0' + mode.toString(8);
const fileType = (format: number) => ({ [constants.S_IFIFO]: 'fifo', [constants.S_IFSOCK]: 'socket', [constants.S_IFCHR]: 'character device',
  [constants.S_IFBLK]: 'block device' })[format] ?? 'special file';
/** How a changed name under `root` is shown: the project's own relative names, an exact output directory's children under its path. */
const displayPath = (root: Root, following: Root, name: string) => root.path === PROJECT ? name
  : root.snapshot.kind === 'directory' && following.snapshot.kind === 'directory' ? root.path + '/' + name : root.path;
/** What differs between two captures of one root beside its Git tree: the root's own mode and kind, and the snapshot's rows for
 * unusual modes, empty directories and special files, which Git cannot hold. */
function recordedDifferences(root: Root, following: Root): Recorded[] {
  const rows: Recorded[] = [];
  // A file root's mode is also one of the snapshot's mode rows below; only a directory root's own mode is recorded nowhere else.
  if (root.snapshot.kind === 'directory' && root.snapshot.mode !== following.snapshot.mode) rows.push({ path: root.path, what: 'mode', before: octal(root.snapshot.mode), after: octal(following.snapshot.mode) });
  if (root.snapshot.kind !== following.snapshot.kind) rows.push({ path: root.path, what: 'kind', before: root.snapshot.kind, after: following.snapshot.kind });
  const fields: { what: string; none: string; rows: (snapshot: Snapshot) => [string, string][] }[] = [
    { what: 'mode', none: 'default', rows: snapshot => snapshot.modes.map(([name, mode]) => [name, octal(mode)]) },
    { what: 'empty directory', none: 'no', rows: snapshot => snapshot.empty.map(name => [name, 'yes']) },
    { what: 'special file', none: 'none', rows: snapshot => snapshot.specials.map(([name, format, mode, device]) =>
      [name, `${fileType(format)} ${octal(mode)}${device ? ` device ${device}` : ''}`]) },
  ];
  for (const { what, none, rows: entries } of fields) {
    const left = new Map(entries(root.snapshot)), right = new Map(entries(following.snapshot));
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) if (left.get(name) !== right.get(name))
      rows.push({ path: displayPath(root, following, Buffer.from(name, 'hex').toString()), what, before: left.get(name) ?? none, after: right.get(name) ?? none });
  }
  return rows;
}
/** The captured roots of two generations, paired by root path. The one rule for a root the next generation lacks: it is `gone`, and counts as
 * changed wherever changes are listed. */
function pairedRoots(prior: Tree, next: Tree) {
  const pairs: { root: Root; following: Root }[] = [], gone: Root[] = [];
  for (const root of prior.roots) {
    const following = next.roots.find(item => item.path === root.path);
    if (following) pairs.push({ root, following }); else gone.push(root);
  }
  return { pairs, gone };
}

/** Write one recorded generation's project root into a fresh directory outside the project. This reads records only; it
 * replaces nothing the run owns, so it is record construction, not restoration. */
export function materializeProject(journal: Journal, tree: Hash, destination: string): Promise<Result<true>> {
  return result(async () => {
    const project = projectRoot(await recordedTree(journal, tree));
    return known(await recordOperation<true>(journal, 'construct', { module: import.meta.url, method: 'restoreTask',
      args: [journal, destination, project.snapshot] }));
  });
}

/** Explain a rejected non-author write using the already captured generations. */
export function changedTreePaths(journal: Journal, before: Hash, after: Hash): Promise<Result<readonly string[]>> {
  return result(async () => {
    const prior = await recordedTree(journal, before), next = await recordedTree(journal, after), changed = new Set<string>();
    const { pairs, gone } = pairedRoots(prior, next);
    for (const root of gone) changed.add(root.path);
    for (const { root, following } of pairs) {
      const names = await nativeContent(journal, 'changed', journal.root, {before:root.snapshot.tree,after:following.snapshot.tree});
      for (const name of names.toString().split('\0').filter(Boolean)) changed.add(displayPath(root, following, name));
      for (const row of recordedDifferences(root, following)) changed.add(row.path);
    }
    return [...changed].sort();
  });
}

/** What a reviewer needs to compare two captured generations without the engine's object store: the project change as one patch file,
 * its diffstat, the roots outside the project that changed, how many differences the Git patch cannot carry, and a command that extracts
 * the base project on demand. */
export interface ChangeView { readonly patch: string; readonly stat: string; readonly otherRoots: readonly string[];
  readonly unpatched: number; readonly baseCommand: string }

const shellWord = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Write the `base` → `current` project change to `patchPath` (always, even when empty). A snapshot also records what Git cannot hold (see
 * `recordedDifferences`): those differences, in every root, follow the patch as a list of `path: what base → now`.
 * The base stays in the object store; `baseCommand` materializes its Git tree under `baseDirectory` only when the reviewer runs it, so cost
 * follows use rather than tree size. That tree has file bytes, the executable bit and symlinks; it has no other mode, empty directory or
 * special file, and a component named `.git` or starting `.fcrw-` appears as `.fcrw-` plus the hex of its name. */
export function changeSince(journal: Journal, base: Hash, current: Hash, patchPath: string, baseDirectory: string): Promise<Result<ChangeView>> {
  return result(async () => {
    const prior = await recordedTree(journal, base), next = await recordedTree(journal, current);
    const { pairs, gone } = pairedRoots(prior, next), project = { root: projectRoot(prior), following: projectRoot(next) };
    const others = pairs.filter(({ root }) => root.path !== PROJECT);
    const diff = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff'], trees = [project.root.snapshot.tree, project.following.snapshot.tree];
    await git(journal, [...diff, '--binary', '--output=' + patchPath, ...trees]);
    const stat = (await git(journal, [...diff, '--stat', ...trees])).toString().trimEnd();
    const recorded = [project, ...others].flatMap(({ root, following }) => recordedDifferences(root, following));
    if (recorded.length) await appendFile(patchPath, '\n# Differences the patch above cannot carry (path: what, base -> now)\n'
      + recorded.map(row => `# ${JSON.stringify(row.path)}: ${row.what}, ${row.before} -> ${row.after}\n`).join(''));
    const otherRoots = [...gone, ...others.filter(({ root, following }) => root.snapshot.tree !== following.snapshot.tree
      || recordedDifferences(root, following).length).map(({ root }) => root)].map(root => root.path);
    const baseCommand = `mkdir -p ${shellWord(baseDirectory)} && ${shellWord(await nativeTool('git'))} --git-dir=${shellWord(evidenceRepository(journal))}`
      + ` archive ${trees[0]} | tar -x -C ${shellWord(baseDirectory)}`;
    return { patch: patchPath, stat, otherRoots, unpatched: recorded.length, baseCommand };
  });
}

/** Capture settled bytes after closure; the caller commits the checkpoint with settlement. The tree is always read again. Whether the
 * checkpoint is safe is the caller's decision (settlement makes it from its frozen-input audit) and is recorded as given, with the
 * identities of the inputs that audit read. */
export function captureCheckpoint(scope: ContentScope, address: AttemptAddress, parent: CheckpointId | null, state: Checkpoint['state'],
  evidence: readonly Ref[], audited: readonly Ref[]): Promise<Result<Checkpoint>> {
  return result(async () => {
    await quiescent(scope);
    if (address.run !== scope.layout.location.run || !idSchema.safeParse(address.stage).success || !idSchema.safeParse(address.attempt).success
      || !Number.isSafeInteger(address.invocation) || address.invocation < 1 || !['safe', 'quarantined'].includes(state)) fail('invalid',
        'Checkpoint identity mismatch');
    if (parent) known(await readCheckpoint(scope.journal, parent));
    for (const ref of evidence) known(await readEvidence(scope.journal, ref));
    const manifest = known(await putEvidence(scope.journal, bytes(await tree(scope))));
    return {
      id: 'checkpoint_' + randomUUID().replaceAll('-', ''), address, parent, state, manifest,
      tree: manifest.sha256, brief: scope.brief.digest, inputHashes: audited, evidence
    };
  });
}


export function readCheckpoint(journal: Journal, id: CheckpointId): Promise<Result<Checkpoint>> {
  return result(async () => {
    const events = known(await readEvents(journal, 0));
    const matches = events.filter(event => event.payload.type === 'checkpoint' && event.payload.checkpoint.id === id);
    if (matches.length !== 1) fail(matches.length ? 'invalid' : 'unavailable', 'Checkpoint is not uniquely committed');
    const payload = matches[0].payload;
    if (payload.type !== 'checkpoint') return fail('invalid', 'Checkpoint fact mismatch');
    const checkpoint = payload.checkpoint;
    const manifest = await decodeTree(journal, checkpoint.manifest);
    if (digest(bytes(manifest)) !== checkpoint.tree || checkpoint.tree !== checkpoint.manifest.sha256) fail('invalid', 'Checkpoint tree mismatch');
    for (const ref of [...checkpoint.inputHashes, ...checkpoint.evidence]) known(await validateRecordRef(journal, ref));
    return checkpoint;
  });
}

/** Make the project and every exact output equal one recorded generation and return the tree read last, which authenticates it. Installing
 * rewrites every byte (staged copy, per-file flush, replace); reading the tree is far cheaper, so a tree that already is the generation is
 * left as it is. The owner of "these bytes are the ones the record names": checkpoint materialization and settlement of a stage that must
 * not change the work both restore through it. */
export function restoreTree(scope: ContentScope, tree: Hash): Promise<Result<Hash>> {
  return result(async () => {
    await quiescent(scope);
    const captured = await recordedTree(scope.journal, tree);
    const allowed = scope.authority.outputs.filter(output => output.write === 'exact').map(output => output.absolute);
    let current = known(await captureTree(scope));
    if (current !== tree) {
      for (const root of captured.roots) await install(scope.journal, root.path === PROJECT ? scope.layout.project : root.path, root.snapshot);
      for (const path of allowed) if (!captured.roots.some(root => root.path === path)) await rm(path, { recursive: true, force: true });
      current = known(await captureTree(scope));
    }
    if (current !== tree) fail('conflict', 'Restored tree failed authentication');
    return current;
  });
}

/**  Restore only safe checkpoint bytes under exclusive project claim, retired owners and observed group quiescence, recording materialization. */
export function materializeCheckpoint(scope: ContentScope, writer: Writer, checkpoint: Checkpoint): Promise<Result<Hash>> {
  return result(async () => {
    await quiescent(scope);
    const committed = known(await readCheckpoint(scope.journal, checkpoint.id));
    if (!same(committed, checkpoint) || checkpoint.state !== 'safe' || checkpoint.brief !== scope.brief.digest
      || writer.journal.root !== scope.journal.root) fail('conflict', 'Checkpoint is not an admitted safe base');
    const captured = await decodeTree(scope.journal, checkpoint.manifest);
    const allowed = scope.authority.outputs.filter(output => output.write === 'exact').map(output => output.absolute);
    for (const path of allowed) if (scope.layout.protectedRoots.some(root => inside(root, path) || inside(path, root))) fail('invalid',
      'Output overlaps protected records');
    for (const root of captured.roots.slice(1)) if (!allowed.includes(root.path)) fail('invalid', 'Undeclared checkpoint root');
    // Originals remain an independent authority, never a second renderer over the
    // selected Git generation. Authenticate supplied original refs before replacement.
    for (const [index, ref] of scope.outputBaseline.entries()) {
      const output = scope.authority.outputs[index];
      if (!output) fail('invalid', 'Unknown original output baseline');
      await baselineSnapshot(scope, ref, output.path);
    }
    // Refresh CAS before any destructive operation; callers must reconcile an unknown append.
    const events = known(await readEvents(scope.journal, 0));
    if (events.some(event => event.payload.type === 'control_intent' && event.payload.intent.kind === 'cancel')) fail('conflict',
      'Cancelled run cannot materialize an execution base');
    // Retain and journal current outputs before replacing any content, so an old base cannot erase later delivery bytes.
    const retained: Ref[] = [];
    for (const output of scope.brief.declaration.outputs) {
      const path = location(scope, output.path);
      try {
        await canonical(path);
        const entries = await snapshot(scope.journal, path);
        retained.push(known(await putEvidence(scope.journal, bytes({ format: 'flowcrew-output-v2', path: output.path, snapshot: entries }))));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    known(await appendEvents(writer, events.at(-1)?.seq ?? 0, [{
      type: 'outputs_preserved', receipt: {
        preserved: false, artifacts: retained, detail: 'Bytes retained before checkpoint materialization; final output obligations remain unchecked.',
      }
    }]));
    const boundary = known(await readEvents(scope.journal, 0));
    if (boundary.some(event => event.payload.type === 'control_intent' && event.payload.intent.kind === 'cancel')) fail('conflict',
      'Cancelled run cannot materialize an execution base');
    known(await appendEvents(writer, boundary.at(-1)?.seq ?? 0, [{ type: 'checkpoint_restore_started', checkpoint: checkpoint.id }]));
    const current = known(await restoreTree(scope, checkpoint.tree));
    const frozen = known(await settleFrozenInputs(scope));
    if (frozen.state !== 'unchanged') fail('conflict', 'Materialized base violates frozen identities');
    const completion = known(await readEvents(scope.journal, 0));
    known(await appendEvents(writer, completion.at(-1)?.seq ?? 0, [{ type: 'checkpoint_materialized', checkpoint: checkpoint.id }]));
    return current;
  });
}

/**  Compare frozen inputs to original immutable baseline and narrowly restore only proven original bytes. */
export function settleFrozenInputs(scope: ContentScope): Promise<Result<FrozenSettlement>> {
  return result(async () => {
    await safeScope(scope);
    let state: FrozenSettlement['state'] = 'unchanged';
    const evidence: Ref[] = [];
    const inputs: Ref[] = [];
    const baselines = await inputIdentities(scope.journal, scope.inputBaseline);
    for (let index = 0; index < scope.brief.declaration.inputs.length; index++) {
      const declaration = scope.brief.declaration.inputs[index];
      const baseline = baselines.get(declaration.path);
      let current: Ref | undefined;
      try { current = await input(scope, index); } catch (error) { if (!(error instanceof Refusal) &&
        (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!declaration.frozen) { if (current) inputs.push(current); continue; }
      if (baseline && current?.sha256 === baseline.sha256) { inputs.push(current); continue; }
      evidence.push(known(await putEvidence(scope.journal, bytes({ input: declaration.id, baseline: baseline ?? null, observed: current ?? null }))));
      if (!baseline || !inside(scope.layout.project, location(scope, declaration.path))) { state = 'quarantined';
        if (current) inputs.push(current); continue; }
      try {
        const entries = await baselineSnapshot(scope, baseline, declaration.path);
        const path = location(scope, declaration.path);
        await canonical(dirname(path));
        if (entries.kind !== 'absent') await install(scope.journal, path, entries);
        else { await rm(path, { recursive: true, force: true }); await flushDirectory(dirname(path)); }
        current = await input(scope, index);
        if (current.sha256 !== baseline.sha256) fail('invalid', 'Restored input digest mismatch');
        inputs.push(current);
        if (state !== 'quarantined') state = 'restored';
      } catch { state = 'quarantined'; if (current) inputs.push(current); }
    }
    return { state, evidence, inputs };
  });
}
/** Retention observes actual declared bytes independently of publication obligations. */
export function retainOutputs(scope: ContentScope): Promise<Result<OutputReceipt>> {
  return result(async () => {
    await quiescent(scope);
    const projection = known(await readProjection(scope.journal));
    const artifacts: Ref[] = [], problems: string[] = [];
    for (const output of scope.authority.outputs) {
      try {
        const released = projection.outputs.findLast(receipt => receipt.released?.includes(output.path));
        const artifact = released ? (await retainedOutput(scope.journal, released.artifacts, output.path))!
          : await captureOutput(scope.journal, output.path, location(scope, output.path));
        const current = (decodeJSON(known(await readEvidence(scope.journal, artifact))) as {snapshot: Snapshot}).snapshot;
        if (current.kind === 'absent') problems.push('Output absent: ' + output.path);
        artifacts.push(artifact);
      } catch (error) { problems.push('Output preservation failed: ' + output.path + ': ' + String(error)); }
    }
    return { preserved: problems.length === 0, artifacts, detail: problems.join('\n') };
  });
}
/** The caller authenticates the gated checkpoint/tree; this owner checks declared delivery obligations. */
export async function preserveOutputs(scope: ContentScope, _checkpoint: Checkpoint): Promise<Result<OutputReceipt>> {
  return result(async () => {
    const receipt = known(await retainOutputs(scope)), problems: string[] = [];
    for (const artifact of receipt.artifacts) {
      const {path, snapshot: current} = decodeJSON(known(await readEvidence(scope.journal, artifact))) as {path: string; snapshot: Snapshot};
      const output = scope.authority.outputs.find(output => output.path === path)!;
      try {
        if (current.kind !== output.kind) problems.push('Output kind mismatch: ' + output.path);
        const baseline = scope.outputBaseline[scope.authority.outputs.indexOf(output)];
        if (!baseline) { problems.push('Missing original output: ' + output.path); continue; }
        const prior = await baselineSnapshot(scope, baseline, output.path);
        if ((output.delivery.original === 'absent' && prior.kind !== 'absent')
          || (output.delivery.original === 'present' && prior.kind === 'absent'))
          problems.push('Original output disposition mismatch: ' + output.path);
        if (output.delivery.append && !known(await recordOperation<boolean>(scope.journal, 'construct', {
          module: import.meta.url, method: 'appendTask', args: [scope.journal, prior, current] })))
          problems.push('Append prefix changed: ' + output.path);
      } catch (error) { problems.push(String(error)); }
    }
    return {...receipt, preserved: receipt.preserved && !problems.length, detail: [receipt.detail, ...problems].filter(Boolean).join('\n')};
  });
}
async function captureOutput(journal: Journal, path: string, absolute: string): Promise<Ref> {
  await canonical(absolute, true);
  const current = await snapshot(journal, absolute);
  return known(await putEvidence(journal, bytes({ format: 'flowcrew-output-v2', path, snapshot: current })));
}
async function retainedOutput(journal: Journal, artifacts: readonly Ref[], path: string): Promise<Ref | undefined> {
  for (const ref of artifacts) {
    const output = decodeJSON(known(await readEvidence(journal, ref))) as {path: string};
    if (output.path === path) return ref;
  }
}
/** Called while execution extents are still held, inside the existing record operation. */
export async function captureExecutionOutputs(journal: Journal, outputs: readonly RunAuthority['outputs'][number][]): Promise<Result<OutputReceipt>> {
  return result(async () => {
    const artifacts: Ref[] = [];
    for (const output of outputs) artifacts.push(await captureOutput(journal, output.path, output.absolute));
    return {preserved: false, artifacts, released: outputs.map(output => output.path), detail: 'Execution extent observation'};
  });
}

/** Build privately, then publish the complete archive without replacing a delivery.
 * A retry authenticates an already published archive against the same artifacts. */
export function materializeDelivery(journal: Journal, artifacts: readonly Ref[], destination: string): Promise<Result<true>> {
  return result(async () => {
    const fs = await import('node:fs/promises');
    const staging = join(dirname(dirname(journal.root)), 'work', basename(journal.root), 'delivery');
    await fs.mkdir(dirname(staging), { recursive: true });
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging);
    const outputs: {path: string; snapshot: Snapshot; ref: Ref}[] = [];
    for (const ref of artifacts) outputs.push({...decodeJSON(known(await readEvidence(journal, ref))) as {path: string; snapshot: Snapshot}, ref});
    const external = outputs.some(output => isAbsolute(output.path));
    const manifest: {path: string; archive: string; ref: Ref}[] = [];
    for (const [index, output] of outputs.entries()) {
      const archive = isAbsolute(output.path) ? join('external', String(index)) : external ? join('project', output.path) : output.path;
      manifest.push({path: output.path, archive, ref: output.ref});
      const target = resolve(staging, archive);
      if (!inside(staging, target)) fail('invalid', 'Delivery escapes its destination');
      await fs.mkdir(dirname(target), { recursive: true });
      known(await restoreTask(journal, target, checkedSnapshot(output.snapshot)));
    }
    if (external) await fs.writeFile(join(staging, 'manifest.json'), bytes(manifest), {flag: 'wx'});
    await syncDirectory(staging);
    await fs.mkdir(dirname(destination), { recursive: true });
    try {
      await fs.lstat(destination);
      await canonical(destination);
      if (!same(await snapshot(journal, destination), await snapshot(journal, staging)))
        fail('conflict', 'Existing delivery differs from preserved bytes');
      await fs.rm(staging, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await publishNoReplace(staging, destination);
    }
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    await syncDirectory(dirname(dirname(destination)));
    return true as const;
  });
}

const gitContentPython = String.raw`import os, sys, json, stat, subprocess, hashlib, shutil, tempfile, socket, fcntl, contextlib
repo, action, root = map(os.fsencode, sys.argv[1:4])
git_binary=os.fsencode(sys.argv[4])
env = {b'PATH': b'/usr/bin', b'GIT_CONFIG_NOSYSTEM': b'1', b'GIT_CONFIG_GLOBAL': b'/dev/null', b'GIT_DIR':repo,
       b'GIT_WORK_TREE': os.path.dirname(root)}
def git(*args, data=None):
    r=subprocess.run([git_binary,b'-c',b'core.fsyncObjectFiles=false',b'-c',b'pack.compression=1',
      b'-c',b'gc.auto=0',b'-c',b'core.autocrlf=false',b'-c',b'core.filemode=true',*args],
      env=env,cwd=env[b'GIT_WORK_TREE'],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if r.returncode: raise RuntimeError(r.stderr.decode('utf8','replace'))
    return r.stdout
prefix=b'.fcrw-'
def mapped(path):
    return b'/'.join(prefix+c.hex().encode() if c==b'.git' or c.startswith(prefix) else c for c in path.split(b'/'))
def decoded(path):
    return b'/'.join(bytes.fromhex(c[len(prefix):].decode()) if c.startswith(prefix) else c for c in path.split(b'/'))
def stamp(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
# One capture stores its new objects in one pack: written into a private object directory (nothing in it is durable), packed by
# git pack-objects, which fsyncs the pack and its index once, then the pack directory is fsynced. A capture therefore costs a
# constant number of flushes, however many objects it stores; no object is visible to the journal before that returns.
def seal(quarantine):
    fan=[d for d in os.listdir(quarantine) if len(d)==2]
    names=[d+n for d in fan for n in os.listdir(quarantine+b'/'+d)]
    if names:git(b'pack-objects',b'-q',b'--window=0',repo+b'/objects/pack/pack',data=b''.join(n+b'\n' for n in names))
    packs=quarantine+b'/pack'
    # A file above core.bigFileThreshold is streamed into a pack of its own; adopt it whole, index last.
    if os.path.isdir(packs):
        for n in sorted(os.listdir(packs),key=lambda n:n.endswith(b'.idx')):
            if n.endswith((b'.pack',b'.idx')):os.rename(packs+b'/'+n,repo+b'/objects/pack/'+n)
    sync(repo+b'/objects/pack')
# A capture or a restore owns everything it writes into the evidence repository: its index, and for a capture its new objects, live in
# one private directory that is removed with it, so a process killed at any point blocks no later one. Every live user holds
# capture.lock shared; the kernel drops a killed one's hold. A process that can take it exclusive therefore knows every private-*
# directory left in the repository is dead, and removes them.
@contextlib.contextmanager
def private(objects):
    guard=os.open(repo+b'/capture.lock',os.O_RDWR|os.O_CREAT|os.O_CLOEXEC,0o600)
    try:
        try:fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:
            for n in os.listdir(repo):
                if n.startswith(b'private-'):shutil.rmtree(repo+b'/'+n,ignore_errors=True)
        fcntl.flock(guard,fcntl.LOCK_SH)
        directory=os.fsencode(tempfile.mkdtemp(prefix='private-',dir=os.fsdecode(repo)))
        names=(b'GIT_INDEX_FILE',b'GIT_OBJECT_DIRECTORY',b'GIT_ALTERNATE_OBJECT_DIRECTORIES');outer=[env.get(n) for n in names]
        env[names[0]]=directory+b'/index'
        if objects:env[names[1]]=directory;env[names[2]]=repo+b'/objects'
        try:yield directory
        finally:
            for n,v in zip(names,outer):
                if v is None:env.pop(n,None)
                else:env[n]=v
            shutil.rmtree(directory,ignore_errors=True)
    finally:os.close(guard)
def capture(root):
    with private(True) as quarantine:
        value=observe(root);seal(quarantine);return value
def observe(root):
    files=[]; modes=[]; empty=[]; specials=[]; stamps={}
    try:rs=os.lstat(root)
    except FileNotFoundError:rs=None
    kind=('absent' if rs is None else 'directory' if stat.S_ISDIR(rs.st_mode) else
      'file' if stat.S_ISREG(rs.st_mode) else 'symlink' if stat.S_ISLNK(rs.st_mode) else 'special')
    # Classify once with lstat: a symlink to a directory must never become Git's worktree.
    env[b'GIT_WORK_TREE']=root if kind=='directory' else repo if kind=='absent' else os.path.dirname(root)
    def visit(path, name):
        s=os.lstat(path);stamps[path]=stamp(s);mode=stat.S_IMODE(s.st_mode)
        if stat.S_ISDIR(s.st_mode):
            names=sorted(os.listdir(path))
            if not names and name:empty.append(name.hex())
            if mode!=0o755 and name:modes.append([name.hex(),mode])
            for n in names:visit(path+b'/'+n,name+b'/'+n if name else n)
        elif stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode):
            files.append(name)
            normal=0o777 if stat.S_ISLNK(s.st_mode) else 0o755 if mode & 0o111 else 0o644
            if mode!=normal:modes.append([name.hex(),mode])
        else:specials.append([name.hex(),stat.S_IFMT(s.st_mode),mode,s.st_rdev])
    if rs:visit(root,b'' if kind=='directory' else os.path.basename(root))
    # Every capture reads current bytes; filesystem stats are not content identity.
    git(b'read-tree',b'--empty')
    normal=[f for f in files if mapped(f)==f]
    if normal:git(b'update-index',b'--add',b'--remove',b'-z',b'--stdin',data=b'\0'.join(normal)+b'\0')
    for f in files:
        if mapped(f)==f:continue
        path=root+b'/'+f if kind=='directory' else root
        s=os.lstat(path)
        if stat.S_ISLNK(s.st_mode):oid=git(b'hash-object',b'--no-filters',b'-w',b'--stdin',data=os.readlink(path)).strip();mode=b'120000'
        else:oid=git(b'hash-object',b'--no-filters',b'-w',b'--',path).strip();mode=b'100755' if s.st_mode & 0o111 else b'100644'
        git(b'update-index',b'--add',b'--cacheinfo',mode,oid,mapped(f))
    tree=git(b'write-tree').strip().decode()
    # write-tree stores nothing for a tree git already knows, and git knows the empty tree without holding it; the capture's pack is
    # made from what the private directory holds, so the root tree is written here, whatever it is, to make the ref that names it safe.
    git(b'hash-object',b'-t',b'tree',b'-w',b'--stdin',data=git(b'cat-file',b'tree',tree))
    for path,before in stamps.items():
        if stamp(os.lstat(path))!=before:
            print('Content changed during Git capture',file=sys.stderr);sys.exit(75)
    value={'tree':tree,'kind':kind,'mode':stat.S_IMODE(rs.st_mode) if rs else 0,'leaf':os.path.basename(root).hex() if rs and kind!='directory' else '',
           'modes':modes,'empty':empty,'specials':specials}
    if kind=='file':
        oid=git(b'ls-files',b'--stage',b'-z').split()[1]
        child=subprocess.Popen([git_binary,b'cat-file',b'blob',oid],env=env,stdout=subprocess.PIPE)
        h=hashlib.sha256()
        for chunk in iter(lambda:child.stdout.read(65536),b''):h.update(chunk)
        if child.wait():raise RuntimeError('Cannot authenticate root file')
        value['sha256']=h.hexdigest()
    return value
if action==b'capture':
    print(json.dumps(capture(root),separators=(',',':')))
elif action==b'restore':
    value=json.load(sys.stdin)
    # Restore uses a distinct protected index, in a private directory.
    held=contextlib.ExitStack();held.enter_context(private(False))
    staging=os.fsencode(tempfile.mkdtemp(prefix='.restore-',dir=os.fsdecode(os.path.dirname(root))))
    try:
        git(b'read-tree',value['tree'].encode())
        git(b'checkout-index',b'--all',b'--prefix='+staging+b'/')
        # Rename byte-name gaps deepest first; no symlink is traversed.
        for directory,dirs,files in os.walk(staging,topdown=False,followlinks=False):
            for name in dirs+files:
                actual=decoded(name)
                if actual!=name:os.rename(directory+b'/'+name,directory+b'/'+actual)
        for name in value['empty']:os.makedirs(staging+b'/'+bytes.fromhex(name),exist_ok=True)
        # Git's executable bit does not encode full permissions; checkout obeys umask.
        # Normalize the Git defaults before applying the explicitly retained mode gaps.
        for directory,dirs,files in os.walk(staging,followlinks=False):
            os.chmod(directory,0o755)
            for name in files:
                path=directory+b'/'+name;s=os.lstat(path)
                if stat.S_ISREG(s.st_mode):os.chmod(path,0o755 if s.st_mode & 0o111 else 0o644)
        for name,kind,mode,rdev in value['specials']:
            path=staging+b'/'+bytes.fromhex(name)
            os.makedirs(os.path.dirname(path),exist_ok=True)
            if kind==stat.S_IFSOCK:
                sock=socket.socket(socket.AF_UNIX);sock.bind(path);sock.close()
            else:os.mknod(path,kind|mode,rdev)
            os.chmod(path,mode)
        for name,mode in reversed(value['modes']):
            path=staging+b'/'+bytes.fromhex(name)
            if not os.path.islink(path):os.chmod(path,mode)
        payload=staging if value['kind']=='directory' else staging+b'/'+bytes.fromhex(value['leaf'])
        if value['kind'] not in ('absent','symlink'):os.chmod(payload,value['mode'])
        if value['kind']!='absent':
            observed=capture(payload)
            # The staged reconstruction is authenticated before replacing any live bytes.
            if observed!=value:raise RuntimeError('Git materialization differs from selected snapshot: '+json.dumps({'expected':value,'observed':observed}))
            for directory,dirs,files in os.walk(staging,topdown=False,followlinks=False):
                for name in files:
                    path=directory+b'/'+name
                    if stat.S_ISREG(os.lstat(path).st_mode):sync(path)
                sync(directory)
        if os.path.lexists(root):
            if os.path.isdir(root) and not os.path.islink(root):shutil.rmtree(root)
            else:os.unlink(root)
        if value['kind']!='absent':
            os.rename(payload,root)
            if value['kind']!='symlink':os.chmod(root,value['mode'])
        sync(os.path.dirname(root))
    finally:
        if os.path.exists(staging):shutil.rmtree(staging)
        held.close()
elif action==b'changed':
    pair=json.load(sys.stdin)
    names=git(b'diff-tree',b'--no-commit-id',b'--name-only',b'-z',b'-r',pair['before'].encode(),pair['after'].encode())
    sys.stdout.buffer.write(b'\0'.join(decoded(name) for name in names.split(b'\0') if name))
elif action==b'append':
    pair=json.load(sys.stdin);original=pair['original'];current=pair['current']
    def entries(value):
        result={}
        for row in git(b'ls-tree',b'-r',b'-t',b'-z',value['tree'].encode()).split(b'\0'):
            if row:
                header,path=row.split(b'\t',1);result[path]=header.split()
        return result
    def prefix_equal(before,after):
        sizes=[git(b'cat-file',b'-s',oid).strip() for oid in (before,after)]
        children=[subprocess.Popen([git_binary,b'cat-file',b'blob',oid],env=env,stdout=subprocess.PIPE) for oid in (before,after)]
        hashes=[hashlib.sha1(b'blob '+size+b'\0') for size in sizes];ok=True
        while True:
            a=children[0].stdout.read(65536)
            if not a:break
            b=children[1].stdout.read(len(a));hashes[0].update(a);hashes[1].update(b)
            if a!=b:ok=False
        for b in iter(lambda:children[1].stdout.read(65536),b''):hashes[1].update(b)
        codes=[child.wait() for child in children]
        if any(codes) or any(h.hexdigest().encode()!=oid for h,oid in zip(hashes,(before,after))):raise RuntimeError('Append evidence authentication failed')
        return ok
    ok=original['kind']=='absent' or original['kind']==current['kind']
    prior=entries(original);after=entries(current)
    for path,row in prior.items():
        next=after.get(path)
        if next is None or row[1]!=next[1] or row[0][:3]!=next[0][:3]:ok=False;break
        if row[1]==b'tree' or row[2]==next[2]:continue
        if row[0]==b'120000' or not prefix_equal(row[2],next[2]):ok=False;break
    for raw in original['empty']:
        next=after.get(mapped(bytes.fromhex(raw)))
        if raw not in current['empty'] and (next is None or next[1]!=b'tree'):ok=False
    for row in original['specials']:
        if row not in current['specials']:ok=False
    print('true' if ok else 'false')
else:raise ValueError('unknown content operation')
`;

export function appendTask(journal: Journal, original: Snapshot, current: Snapshot): Promise<Result<boolean>> {
  return result(async () => (await nativeContent(journal, 'append', journal.root, { original, current })).toString().trim() === 'true'); }
