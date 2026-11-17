import { putEvidence } from './state.js';
import type { RunAuthority, RunLocation } from '../contract/runtime.js';
import type { AdmittedBrief, Hash, Ref, Result } from '../contract/brief.js';
import { type GrantRequest, type AttemptAddress, type Checkpoint, type CheckpointId, type Journal, type OutputReceipt, type Writer,
  type ObservedPath } from '../contract/runtime.js';
import { probeOwner, nativeTool, nativeSpawn, type Claim } from '../host/process.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { idSchema } from '../contract/brief.js';
import { recordOperation, readEvents, readProjection, ownerClosed, appendEvents } from './state.js';
import { readEvidence, validateRecordRef, evidenceRepository, publishObject, git, syncDirectory } from './evidence.js';
/**  Physical scope plus immutable brief and original setup baselines. */
export interface ContentScope {
  readonly journal: Journal;
  readonly layout: RecordLayout;
  readonly brief: AdmittedBrief;
  readonly inputBaseline: readonly Ref[];
  readonly outputBaseline: readonly Ref[];
  readonly projectClaim: Claim;
  readonly git?: GrantRequest['git'];
  readonly authority: RunAuthority;
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
  const projection = known(await readProjection(scope.journal));
  for (const value of projection.owners) {
    if (value.owner.authority === scope.projectClaim.owner.authority) continue;
    if (!known(ownerClosed(scope.journal, value.owner))) fail('conflict', 'Descendant closure is not proven');
    const state = await probeOwner(value.owner);
    if (state === 'unknown') fail('unknown', 'Descendant owner is unknown');
    if (state === 'live') fail('conflict', 'A descendant is live');
  }
}
/**  Canonical run/project/protected-root layout. */
export interface RecordLayout {
  readonly location: RunLocation;
  readonly project: string;
  readonly protectedRoots: readonly string[];
  readonly sharedCaches: readonly string[];
}

/**  Validate canonical disjoint record/project/cache roots, aliases and protected publication layout. */
export async function validateRecordLayout(layout: RecordLayout): Promise<Result<RecordLayout>> {
  try {
    if (!idSchema.safeParse(layout.location.run).success || !layout.protectedRoots.length)
      return failResult('invalid', 'Missing run identity or protected roots');
    const store = await canonicalDirectory(layout.location.storeRoot);
    const run = await canonicalDirectory(join(store, 'runs', layout.location.run));
    const project = await canonicalDirectory(layout.project);
    const protectedRoots = await Promise.all(layout.protectedRoots.map(canonicalProtected));
    const caches = await Promise.all(layout.sharedCaches.map(canonicalDirectory));
    if (!protectedRoots.some(root => contains(root, run)))
      return failResult('invalid', 'Journal is not protected');
    const roots = [project, ...protectedRoots, ...caches];
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
      if (contains(roots[i], roots[j]) || contains(roots[j], roots[i]))
        return failResult('conflict', 'Record, project and cache roots overlap');
    const identities = new Set<string>();
    for (const root of roots) {
      const stat = await lstat(root).catch(error => { if (error.code === 'ENOENT' && protectedRoots.includes(root)) return null; throw error; });
        if (!stat) continue; const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) return failResult('invalid', 'Physically aliased roots');
      identities.add(identity);
    }
    return { ok: true, value: layout };
  } catch (error) { return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'invalid',
    detail: String(error) }; }
}

function contains(root: string, target: string): boolean { return target === root || target.startsWith(root + sep); }
async function canonicalProtected(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Noncanonical protected path');
  try { if (await realpath(path) !== path) throw new Error('Aliased protected path'); const stat = await lstat(path); if (!stat.isDirectory() &&
    !stat.isFile()) throw new Error('Unsupported protected path'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await canonicalDirectory(dirname(path)); }
  return path;
}
async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path)
    throw Object.assign(new Error('Noncanonical or aliased root'), { code: 'EINVAL' });
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw Object.assign(new Error('Root is not a directory'), { code: 'EINVAL' });
  return path;
}

/** Engine Git metadata is protected; each worker receives only independent scratch metadata. */
export function gitAuthority(location: RunLocation, project: string): NonNullable<GrantRequest['git']> {
  return {
    worktree: project, commonDir: evidenceRepository({ root: join(resolve(location.storeRoot), 'runs', location.run), database: location.database }),
    privateDir: join(resolve(location.storeRoot), 'work', location.run, 'git'), baseCommit: null
  };
}
async function nativeContent(journal: Journal, action: 'capture' | 'restore' | 'append', root: string, value?: unknown): Promise<Buffer> {
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
  const roots: Tree['roots'] = [{ path: 'project', snapshot: await snapshot(scope.journal, scope.layout.project) }];
  const external = scope.authority.outputs.filter(output => output.write === 'exact').map(output => output.absolute).sort();
  for (const path of external) {
    if (external.some(other => other !== path && inside(other, path))) continue;
    if (scope.layout.protectedRoots.some(root => inside(root, path) || inside(path, root))) fail('invalid', 'Output overlaps protected records');
    await canonical(dirname(path)); roots.push({ path, snapshot: await snapshot(scope.journal, path) });
  }
  return { format: 'flowcrew-tree-v3', roots };
}

async function decodeTree(journal: Journal, manifest: Ref): Promise<Tree> {
  const parsed = decodeJSON(known(await readEvidence(journal, manifest))) as Tree;
  if (parsed?.format !== 'flowcrew-tree-v3' || Object.keys(parsed).some(key => !['format', 'roots'].includes(key)) ||
    !Array.isArray(parsed.roots) || !parsed.roots.length || parsed.roots[0].path !== 'project') fail('invalid', 'Invalid checkpoint manifest');
  const seen = new Set<string>();
  for (const root of parsed.roots) {
    if (!root || typeof root.path !== 'string' || seen.has(root.path) || (root.path !== 'project' && !isAbsolute(root.path))) fail('invalid',
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
/**  Hash exactly declared inputs, including ignored/external paths and kind checks. */
export function hashInputs(scope: ContentScope): Promise<Result<readonly Ref[]>> {
  return result(async () => {
    known(await validateRecordLayout(scope.layout));
    const refs: Ref[] = [];
    for (let index = 0; index < scope.brief.declaration.inputs.length; index++) {
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

/** Capture a bounded semantic observation set with the same byte-authentic native content primitive. */
export function observePaths(scope: ContentScope, paths: readonly string[]): Promise<Result<readonly ObservedPath[]>> {
  return result(async () => {
    const observed: ObservedPath[] = [];
    for (const path of [...new Set(paths)]) {
      const physical = location(scope, path);
      const allowed = inside(scope.layout.project, physical) || [...scope.brief.declaration.inputs, ...scope.brief.declaration.outputs]
        .some(item => inside(location(scope, item.path), physical));
      if (!allowed || scope.layout.protectedRoots.some(root => inside(root, physical) || inside(physical, root))) fail('invalid',
        'Observation outside content authority');
      await canonical(dirname(physical));
      const identity = known(await putEvidence(scope.journal, bytes({ format: 'flowcrew-baseline-v2', path,
        snapshot: await snapshot(scope.journal, physical) })));
      observed.push({ path, identity });
    }
    return observed;
  });
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

/** Capture settled bytes after closure; the caller commits the checkpoint with settlement. */
export function captureCheckpoint(scope: ContentScope, address: AttemptAddress, parent: CheckpointId | null, state: Checkpoint['state'],
  evidence: readonly Ref[]): Promise<Result<Checkpoint>> {
  return result(async () => {
    await quiescent(scope);
    if (address.run !== scope.layout.location.run || !idSchema.safeParse(address.stage).success || !idSchema.safeParse(address.attempt).success
      || !Number.isSafeInteger(address.invocation) || address.invocation < 1 || !['safe', 'quarantined'].includes(state)) fail('invalid',
        'Checkpoint identity mismatch');
    if (parent) known(await readCheckpoint(scope.journal, parent));
    for (const ref of evidence) known(await readEvidence(scope.journal, ref));
    const frozen = await settleFrozenInputs(scope);
    if (!frozen.ok) return fail(frozen.kind, frozen.detail);
    if (state === 'safe' && frozen.value.state !== 'unchanged') fail('conflict', 'Safe checkpoint requires unchanged frozen inputs');
    const inputHashes = frozen.value.inputs;
    const projection = known(await readProjection(scope.journal));
    const observed = known(await observePaths(scope, projection.commands.flatMap(receipt => receipt.key.observation?.sources ?? [])));
    const captured = await tree(scope);
    const manifest = known(await putEvidence(scope.journal, bytes(captured)));
    return {
      id: 'checkpoint_' + randomUUID().replaceAll('-', ''), address, parent, state, manifest,
      observed, tree: manifest.sha256, brief: scope.brief.digest, inputHashes, evidence
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

/**  Restore only safe checkpoint bytes under exclusive project claim and proven quiescence, recording materialization. */
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
    for (const root of captured.roots) await install(scope.journal, root.path === 'project' ? scope.layout.project : root.path, root.snapshot);
    for (const path of allowed) if (!captured.roots.some(root => root.path === path)) await rm(path, { recursive: true, force: true });
    const frozen = known(await settleFrozenInputs(scope));
    if (frozen.state !== 'unchanged') fail('conflict', 'Materialized base violates frozen identities');
    const current = known(await captureTree(scope));
    if (current !== checkpoint.tree) fail('conflict', 'Materialized tree failed authentication');
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
    for (let index = 0; index < scope.brief.declaration.inputs.length; index++) {
      const declaration = scope.brief.declaration.inputs[index];
      const baseline = scope.inputBaseline[index];
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
async function appendCompatible(journal: Journal, original: Snapshot, current: Snapshot): Promise<boolean> {
  return known(await recordOperation<boolean>(journal, 'construct', { module: import.meta.url, method: 'appendTask', args: [journal, original,
    current] }));
}

/** Archive declared outputs against their original disposition and baselines; acceptance belongs to the gate. */
export function preserveOutputs(scope: ContentScope, checkpoint: Checkpoint): Promise<Result<OutputReceipt>> {
  return result(async () => {
    await quiescent(scope);
    if (!same(known(await readCheckpoint(scope.journal, checkpoint.id)), checkpoint) ||
      checkpoint.tree !== known(await captureTree(scope))) fail('conflict', 'Outputs differ from settled checkpoint');
    const artifacts: Ref[] = [];
    const problems: string[] = [];
    for (const [index, output] of scope.authority.outputs.entries()) {
      const baseline = scope.outputBaseline[index];
      try {
        const path = location(scope, output.path);
        await canonical(path);
        const stat = await lstat(path);
        if (output.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) { problems.push('Output kind mismatch: ' + output.path); continue; }
        const current = await snapshot(scope.journal, path);
        if (!baseline) { problems.push('Missing original output: ' + output.path); continue; }
        const prior = await baselineSnapshot(scope, baseline, output.path);
        if ((output.delivery.original === 'absent' && prior.kind !== 'absent')
          || (output.delivery.original === 'present' && prior.kind === 'absent')) {
          problems.push('Original output disposition mismatch: ' + output.path); continue;
        }
        if (output.delivery.append && !(await appendCompatible(scope.journal, prior, current))) {
          problems.push('Append prefix changed: ' + output.path); continue;
        }
        artifacts.push(known(await putEvidence(scope.journal, bytes({ format: 'flowcrew-output-v2', path: output.path, snapshot: current }))));
      } catch (error) { problems.push('Output preservation failed: ' + output.path + ': ' + String(error)); }
    }
    return { preserved: problems.length === 0, artifacts, detail: problems.join('\n') };
  });
}

/** Called inside the already recorded reclaim operation, while the project claim is held. */
export function materializeDelivery(journal: Journal, artifacts: readonly Ref[], destination: string): Promise<Result<true>> {
  return result(async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.mkdir(destination); // Never replace a person's delivery directory.
    for (const ref of artifacts) {
      const output = decodeJSON(known(await readEvidence(journal, ref))) as { path: string; snapshot: Snapshot };
      if (isAbsolute(output.path)) continue; // External outputs already survive workspace removal.
      const target = resolve(destination, output.path);
      if (!inside(destination, target)) fail('invalid', 'Delivery escapes its destination');
      await fs.mkdir(dirname(target), { recursive: true });
      known(await restoreTask(journal, target, checkedSnapshot(output.snapshot)));
    }
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    await syncDirectory(dirname(dirname(destination)));
    return true as const;
  });
}

const gitContentPython = String.raw`import os, sys, json, stat, subprocess, hashlib, shutil, tempfile, socket
repo, action, root = map(os.fsencode, sys.argv[1:4])
git_binary=os.fsencode(sys.argv[4])
env = {b'PATH': b'/usr/bin', b'GIT_CONFIG_NOSYSTEM': b'1', b'GIT_CONFIG_GLOBAL': b'/dev/null', b'GIT_DIR':repo,
       b'GIT_WORK_TREE': os.path.dirname(root),
       b'GIT_INDEX_FILE': repo+b'/index-'+hashlib.sha256(root).hexdigest().encode()}
def git(*args, data=None):
    r=subprocess.run([git_binary,b'-c',b'core.fsyncObjectFiles=true',
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
def capture(root):
    env[b'GIT_INDEX_FILE']=repo+b'/index-'+hashlib.sha256(root).hexdigest().encode()
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
    # Restore uses a distinct protected index.
    env[b'GIT_INDEX_FILE']=repo+b'/restore-'+str(os.getpid()).encode()
    restore_index=env[b'GIT_INDEX_FILE']
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
        for index in {restore_index,env[b'GIT_INDEX_FILE']}:
            try:os.unlink(index)
            except FileNotFoundError:pass
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
