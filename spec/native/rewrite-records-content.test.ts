import { beginOperation, endOperation } from "../../dist-rewrite/host/process.js";
import { fixtureAuthority } from "../fixtures/rewrite-authority.js";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, link, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Input, Output, Ref, Result } from "../../dist-rewrite/contract/brief.js";
import type { Checkpoint, JournalPayload, OwnerState, Writer } from "../../dist-rewrite/contract/runtime.js";
import { captureCheckpoint, captureTree, hashInputs, materializeCheckpoint, preserveOutputs, readCheckpoint, settleFrozenInputs,
 verifyRuntime, type ContentScope } from "../../dist-rewrite/records/content.js";
import { appendEvents, readEvents, openJournal, openWriter } from "../../dist-rewrite/records/state.js";
import { putEvidence, readEvidence, git, evidenceRepository, evidenceOid } from "../../dist-rewrite/records/evidence.js";
import { stateFixture } from "../fixtures/rewrite-state.js";
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
async function manifest(ref: Ref): Promise<any> { return JSON.parse(Buffer.from(known(await readEvidence(scope.journal, ref))).toString()); }
function known<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(result.kind + ': ' + result.detail); return result.value; }
let root: string;
let scope: ContentScope;
let writer: Writer;
async function record(payload: JournalPayload) { known(await appendEvents(writer, known(await readEvents(scope.journal, 0)).length, [payload])); }
function declarations(inputs: readonly Input[] = [], outputs: readonly Output[] = []) {
  scope = { ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, inputs, outputs } } };
  scope.authority = fixtureAuthority(scope);
}
async function checkpoint(state: Checkpoint['state'] = 'safe') {
  const cp = known(await captureCheckpoint(scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, state, []));
  await record({ type: 'checkpoint', checkpoint: cp });
  return cp;
}
let f: Awaited<ReturnType<typeof stateFixture>>;
beforeEach(async () => {
  f = await stateFixture({}, { stages: [{ id: 'work', purpose: 'work', role: 'author', after: [], instruction: 'Work', skills: [] }] });
  await f.admit();
  root = f.root;
  scope = f.scope;
  writer = f.execution;
  await mkdir(join(root, 'runtime'));
});
afterEach(async () => { await f.close(); });
describe('records content frozen identities', () => {
  it('hashes exact file/directory/external inputs and rejects declared kind/hash mismatch', async () => {
    await writeFile(join(scope.layout.project, 'input'), 'original');
    await mkdir(join(scope.layout.project, 'dir'));
    await writeFile(join(scope.layout.project, 'dir', '.ignored'), 'ignored');
    await writeFile(join(root, 'external'), 'external');
    declarations([{ id: 'file', path: 'input', kind: 'file', frozen: true }, { id: 'directory', path: 'dir', kind: 'directory',
     frozen: true }, { id: 'external', path: join(root, 'external'), kind: 'file', frozen: false }]);
    const refs = known(await hashInputs(scope));
    expect(refs).toHaveLength(3);
    expect((await manifest(refs[0])).snapshot.sha256).toBe(hash('original'));
    declarations([{ id: 'wrong', path: 'input', kind: 'directory', frozen: true }]);
    expect(await hashInputs(scope)).toMatchObject({ ok: false, kind: 'invalid' });
    declarations([{ id: 'wrong', path: 'input', kind: 'file', frozen: true, sha256: hash('different') }]);
    expect(await hashInputs(scope)).toMatchObject({ ok: false, kind: 'conflict' });
  });


  it('quarantines missing/corrupt baselines and changed external frozen inputs', async () => {
    await writeFile(join(scope.layout.project, 'input'), 'tampered');
    declarations([{ id: 'input', path: 'input', kind: 'file', frozen: true }]);
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    const missing: Ref = { path: 'blobs/' + hash('missing'), sha256: hash('missing') };
    scope = { ...scope, inputBaseline: [missing] };
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    await writeFile(join(root, 'external'), 'original');
    declarations([{ id: 'input', path: join(root, 'external'), kind: 'file', frozen: true }]);
    scope = { ...scope, inputBaseline: known(await hashInputs(scope)) };
    await writeFile(join(root, 'external'), 'changed');
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    expect(await readFile(join(root, 'external'), 'utf8')).toBe('changed');
  });
});
describe('records content checkpoint authority', () => {
  it('captures ignored/untracked/external bytes, modes, symlinks and deletions', async () => {
    await writeFile(join(scope.layout.project, '.ignored'), 'secret');
    await writeFile(join(scope.layout.project, 'untracked'), 'work');
    await writeFile(join(root, 'artifact'), 'outside');
    await symlink('untracked', join(scope.layout.project, 'link'));
    declarations([], [{ path: join(root, 'artifact'), kind: 'file', existing: 'replace' }]);
    const initial = known(await captureTree(scope));
    await chmod(join(scope.layout.project, 'untracked'), 0o755);
    expect(known(await captureTree(scope))).not.toBe(initial);
    const cp = await checkpoint();
    await rm(join(scope.layout.project, 'untracked'));
    await writeFile(join(root, 'artifact'), 'changed');
    expect(known(await captureTree(scope))).not.toBe(cp.tree);
    expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
    expect((await lstat(join(scope.layout.project, 'untracked'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(root, 'artifact'), 'utf8')).toBe('outside');
    expect((await lstat(join(scope.layout.project, 'link'))).isSymbolicLink()).toBe(true);
  });
  it.each(['project-file', 'external-file', 'directory-child', 'external-directory-target'] as const)(
    'replaced output %s retains only symlink bytes and never reads or copies its ungranted target', async placement => {
      const target = join(root, 'outside-every-grant'), secret = 'ungranted target bytes ' + placement;
      const directoryTarget = placement === 'external-directory-target';
      if (directoryTarget) await mkdir(target);
      const targetFile = directoryTarget ? join(target, 'external-output') : target;
      await writeFile(targetFile, secret);
      const output = placement.startsWith('external-') ? join(root, 'external-output') : 'out';
      const absolute = output.startsWith('/') ? output : join(scope.layout.project, output);
      const directory = placement === 'directory-child';
      if (directory) await mkdir(absolute);
      const planted = directory ? join(absolute, 'link') : absolute;
      await writeFile(planted, 'original output');
      const kind = directory ? 'directory' as const : 'file' as const;
      declarations([{ id: 'original', path: output, kind, frozen: false }], [{ path: output, kind, existing: 'replace' }]);
      const baseline = known(await hashInputs(scope));
      declarations([], [{ path: output, kind, existing: 'replace' }]);
      scope = { ...scope, outputBaseline: baseline };
      const original = known(await captureTree(scope));
      await rm(planted);
      await symlink(target, planted);
      // The target is unreadable for an ordinary native user. Git must hash
      // readlink bytes even when privileged CI could bypass these permissions.
      await chmod(target, 0);
      try {
        const cp = await checkpoint();
        expect(cp.tree).not.toBe(original);
        const tree = await manifest(cp.manifest);
        const selected = tree.roots.find((entry: any) => entry.path === (placement.startsWith('external-') ? absolute : 'project'));
        const listing = (await git(scope.journal, ['ls-tree', '-r', selected.snapshot.tree])).toString();
        const linkOid = (await git(scope.journal, ['hash-object', '--stdin'], { input: Buffer.from(target) })).toString().trim();
        expect(listing).toContain('120000 blob ' + linkOid);
        expect((await git(scope.journal, ['cat-file', 'blob', linkOid])).toString()).toBe(target);
        const targetOid = createHash('sha1').update('blob ' + Buffer.byteLength(secret) + '\0').update(secret).digest('hex');
        expect((await git(scope.journal, ['cat-file', '--batch-check'], { input: Buffer.from(targetOid + '\n') }))
          .toString()).toBe(targetOid + ' missing\n');
        // Changing target bytes cannot change the checkpoint identity.
        await chmod(target, directoryTarget ? 0o700 : 0o600);
        await writeFile(targetFile, secret + ' changed');
        expect(known(await captureTree(scope))).toBe(cp.tree);
        const preserved = known(await preserveOutputs(scope, cp));
        expect(preserved.preserved).toBe(directory);
        expect(preserved.artifacts).toHaveLength(directory ? 1 : 0);
        if (directory) {
          const retained = await manifest(preserved.artifacts[0]);
          expect((await git(scope.journal, ['ls-tree', '-r', retained.snapshot.tree])).toString()).toContain('120000 blob ' + linkOid);
          expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
        } else {
          // Retention before materialization refuses a symlink at the declared file root.
          expect(await materializeCheckpoint(scope, writer, cp)).toMatchObject({ ok: false, kind: 'invalid' });
        }
        expect(await readlink(planted)).toBe(target);
        expect(await readFile(targetFile, 'utf8')).toBe(secret + ' changed');
        process.stderr.write('Native evidence output-symlink ' + JSON.stringify({ platform: process.platform, placement,
          targetBlobAbsent: true, targetChangesIgnored: true, preserved: preserved.preserved }) + '\n');
      } finally { await chmod(target, directoryTarget ? 0o700 : 0o600); }
    });
  it('does not expose an uncommitted capture and rejects corrupt/quarantined bases', async () => {
    await writeFile(join(scope.layout.project, 'file'), 'work');
    const uncommitted = known(await captureCheckpoint(scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, 'safe', []));
    expect(await readCheckpoint(scope.journal, uncommitted.id)).toMatchObject({ ok: false, kind: 'unavailable' });
    await record({ type: 'checkpoint', checkpoint: uncommitted });
    expect(known(await readCheckpoint(scope.journal, uncommitted.id))).toEqual(uncommitted);
    const bad = await checkpoint('quarantined');
    expect(await materializeCheckpoint(scope, writer, bad)).toMatchObject({ ok: false, kind: 'conflict' });
    const oid = evidenceOid(uncommitted.manifest), carrier = join(evidenceRepository(scope.journal), 'objects', oid.slice(0, 2), oid.slice(2));
    await chmod(carrier, 0o644);
    await writeFile(carrier, 'corrupt');
    expect(await readCheckpoint(scope.journal, uncommitted.id)).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it.each(['dead', 'live', 'unknown'] as const)('materialization with a %s group requires physical closure', async (state) => {
    const cp = await checkpoint(), empty = known(await putEvidence(scope.journal, Buffer.alloc(0)));
    const worker = known(await beginOperation());
    try {
      if (state === 'dead')
        known(await endOperation(worker.owner));
      await record({ type: 'process', receipt: { owner: state === 'unknown' ? { ...worker.owner,
       start: 'stale-birth' } : worker.owner, state: 'closed', exit: 0,
          signal: null, grant: 'applied', stdout: empty, stderr: empty, durationMs: 1, scope: 'group' } });
      const restored = await materializeCheckpoint(scope, writer, cp);
      if (state === 'dead')
        expect(known(restored)).toBe(cp.tree);
      else
        expect(restored).toMatchObject({ ok: false, kind: state === 'unknown' ? 'unknown' : 'conflict' });
    }
    finally {
      known(await endOperation(worker.owner));
    }
  });

  it('owner observation updates retain one authority and still require a closed receipt', async () => {
    const worker = known(await beginOperation());
    const updated = { ...worker.owner, members: [] };
    try {
      await record({ type: 'ownership', owner: worker.owner, state: 'live' });
      await record({ type: 'ownership', owner: updated, state: 'live' });
      known(await endOperation(worker.owner));
      // Kernel death alone is insufficient; the same authority still needs its receipt.
      const address = { run: 'Run', stage: 'work', attempt: 'updated_owner', invocation: 1 };
      expect(await captureCheckpoint(scope, address, null, 'safe', [])).toMatchObject({ ok: false, kind: 'conflict' });
      await record({ type: 'ownership', owner: updated, state: 'dead' });
      expect(await captureCheckpoint(scope, address, null, 'safe', [])).toMatchObject({ ok: false, kind: 'conflict' });
      const empty = known(await putEvidence(scope.journal, Buffer.alloc(0)));
      await record({ type: 'process', receipt: { owner: updated, state: 'closed', exit: 0, signal: null, grant: 'applied',
        stdout: empty, stderr: empty, durationMs: 1, scope: 'group' } });
      expect(await captureCheckpoint(scope, address, null, 'safe', [])).toMatchObject({ ok: true });
    } finally {
      known(await endOperation(worker.owner));
    }
  });

  it('selecting an old base preserves invocations plan and history and appends one materialization fact', async () => {
    await writeFile(join(scope.layout.project, 'value'), 'old');
    const old = await checkpoint();
    const invocation = { charge: 'work' as const, address: { kind: 'stage' as const, run: 'Run', stage: 'work', attempt: 'budget',
     invocation: 1 } };
    await record({ type: 'invocation_reserved', invocation });
    await record({ type: 'plan_committed', plan: { revision: 'new', digest: hash('plan'), executed: [], plan: { stages: [{ id: 'work',
     purpose: 'work', role: 'author', after: [], instruction: 'Next', skills: [] }] } } });
    await writeFile(join(scope.layout.project, 'value'), 'new');
    const latest = await checkpoint();
    const before = known(await readEvents(scope.journal, 0));
    expect(known(await materializeCheckpoint(scope, writer, old))).toBe(old.tree);
    const events = known(await readEvents(scope.journal, 0));
    expect(events.slice(0, before.length)).toEqual(before);
    expect(events.at(-1)?.payload).toEqual({ type: 'checkpoint_materialized', checkpoint: old.id });
    expect(events.some(event => event.payload.type === 'checkpoint' && event.payload.checkpoint.id === latest.id)).toBe(true);
  });
  it('archives later append output before restoring the exact old base', async () => {
    await writeFile(join(scope.layout.project, 'history'), 'first\n');
    declarations([], [{ path: 'history', kind: 'file', existing: 'append' }]);
    const originals = known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, inputs: [{
     id: 'history', path: 'history', kind: 'file', frozen: false }] } } }));
    scope = { ...scope, outputBaseline: originals };
    const cp = await checkpoint();
    await writeFile(join(scope.layout.project, 'history'), 'first\nsecond\n');
    expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
    expect(await readFile(join(scope.layout.project, 'history'), 'utf8')).toBe('first\n');
    const retained = known(await readEvents(scope.journal,
     0)).flatMap(event => event.payload.type === 'outputs_preserved' ? event.payload.receipt.artifacts : []);
    const baseline = await manifest(retained[0]);
    expect((await git(scope.journal, ['show', baseline.snapshot.tree + ':history'])).toString()).toBe('first\nsecond\n');
  });
});
describe('records content output preservation and runtime pin', () => {
  it.each(['create', 'update', 'append', 'replace'] as const)('archives %s output and authenticates its settled tree', async (existing) => {
    declarations([], [{ path: 'out', kind: 'file', existing }]);
    if (existing !== 'create') {
      await writeFile(join(scope.layout.project, 'out'), 'old');
      const baselines = known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration,
       inputs: [{ id: 'out', path: 'out', kind: 'file', frozen: false }] } } }));
      scope = { ...scope, outputBaseline: baselines };
    }
    if (existing === 'create')
      scope = { ...scope, outputBaseline: known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: {
       ...scope.brief.declaration, inputs: [{ id: 'out', path: 'out', kind: 'file', frozen: false }] } } })) };
    await writeFile(join(scope.layout.project, 'out'), existing === 'append' ? 'old-new' : 'new');
    const cp = await checkpoint();
    const receipt = known(await preserveOutputs(scope, cp));
    expect(receipt.preserved).toBe(true);
    expect(receipt.artifacts).toHaveLength(1);
    await writeFile(join(scope.layout.project, 'out'), 'changed');
    expect(await preserveOutputs(scope, cp)).toMatchObject({ ok: false, kind: 'conflict' });
  });
  it('reports absent kind prefix failures with partial successful archives', async () => {
    declarations([], [{ path: 'missing', kind: 'file', existing: 'create' }, { path: 'wrong', kind: 'directory', existing: 'create' }, {
     path: 'prefix', kind: 'file', existing: 'append' }, { path: 'good', kind: 'file', existing: 'create' }]);
    await writeFile(join(scope.layout.project, 'prefix'), 'original');
    scope = { ...scope, outputBaseline: known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: {
     ...scope.brief.declaration, inputs: scope.brief.declaration.outputs.map((output, index) => ({ id: 'out' + index, path: output.path,
     kind: output.kind, frozen: false })) } } })) };
    for (const name of ['wrong', 'prefix', 'good'])
      await writeFile(join(scope.layout.project, name), 'changed');
    const cp = await checkpoint();
    const receipt = known(await preserveOutputs(scope, cp));
    expect(receipt.preserved).toBe(false);
    expect(receipt.artifacts).toHaveLength(1);
  });
  it('verifies the complete run pin and refuses mutable or aliased carriers', async () => {
    const path = join(root, 'runtime', 'program');
    await writeFile(path, 'program');
    await chmod(path, 0o555);
    const ref = { path: 'program', sha256: hash('program'), executable: true };
    const content = JSON.stringify([ref]);
    const manifestPath = join(root, 'runtime', '.pin');
    await writeFile(manifestPath, content);
    await chmod(manifestPath, 0o444);
    const runtime = { path: 'runtime/.pin', sha256: hash(content) };
    expect(known(await verifyRuntime(root, runtime))).toEqual(runtime);
    const retired = JSON.stringify({ version: 1, files: [ref] });
    await chmod(manifestPath, 0o644); await writeFile(manifestPath, retired); await chmod(manifestPath, 0o444);
    expect(await verifyRuntime(root, { ...runtime, sha256: hash(retired) })).toMatchObject({ ok: false, kind: 'invalid',
      detail: expect.stringContaining('Unsupported runtime inventory format') });
    await chmod(manifestPath, 0o644); await writeFile(manifestPath, content); await chmod(manifestPath, 0o444);
    await chmod(path, 0o755);
    expect(await verifyRuntime(root, runtime)).toMatchObject({ ok: false, kind: 'unavailable' });
    await chmod(path, 0o555);
    await rm(path);
    await symlink('.pin', path);
    expect(await verifyRuntime(root, runtime)).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});


it('captures frozen and external alias bytes without a second content-owned hardlink inventory', async () => {
  const file = join(scope.layout.project, 'frozen');
  await writeFile(file, 'original');
  const outside = join(root, 'outside');
  await link(file, outside);
  await link(file, join(scope.layout.project, 'project-alias'));
  const directory = join(scope.layout.project, 'frozen-directory');
  await mkdir(directory);
  await writeFile(join(directory, 'a'), 'frozen');
  await link(join(directory, 'a'), join(directory, 'b'));
  declarations([{ id: 'frozen', path: 'frozen', kind: 'file', frozen: true },
    { id: 'directory', path: 'frozen-directory', kind: 'directory', frozen: true }]);
  expect((await hashInputs(scope)).ok).toBe(true);
  expect((await captureTree(scope)).ok).toBe(true);
  declarations([{ id: 'frozen', path: 'frozen', kind: 'file', frozen: true },
    { id: 'directory', path: 'frozen-directory', kind: 'directory', frozen: true }], [{ path: outside, kind: 'file', existing: 'replace' }]);
  expect((await hashInputs(scope)).ok).toBe(true);
  expect((await captureTree(scope)).ok).toBe(true);
});
// Baselines and checkpoints carry the same exact original filesystem facts.
const restorationCases = (['create', 'update', 'append', 'replace'] as const).flatMap(existing =>
  (['file', 'directory'] as const).map(kind => ({ existing, kind, present: true, modeChanged: true })));
it.each(restorationCases)('restores exact output baseline $existing/$kind/present=$present/modeChanged=$modeChanged', async ({ existing,
 kind, present, modeChanged }) => {
  const path = join(scope.layout.project, 'out');
  if (present) {
    if (kind === 'file')
      await writeFile(path, 'original');
    else {
      await mkdir(path);
      await writeFile(join(path, 'child'), 'original');
      await chmod(join(path, 'child'), 0o640);
    }
    await chmod(path, kind === 'file' ? 0o751 : 0o750);
  }
  declarations([{ id: 'original', path: 'out', kind, frozen: false }], [{ path: 'out', kind, existing }]);
  const baselineRefs = known(await hashInputs(scope));
  const baseline = await manifest(baselineRefs[0]);
  expect(baseline.path).toBe('out');
  expect(baseline.snapshot.kind !== 'absent').toBe(present);
  if (present)
    expect(baseline.snapshot).toMatchObject({ kind, mode: kind === 'file' ? 0o751 : 0o750 });
  declarations([], [{ path: 'out', kind, existing }]);
  scope = { ...scope, outputBaseline: baselineRefs };
  const cp = await checkpoint();
  await rm(path, { force: true, recursive: true });
  // Change type as well as content; mode changes are independent table inputs.
  if (kind === 'file')
    await mkdir(path);
  else
    await writeFile(path, 'changed');
  if (modeChanged)
    await chmod(path, 0o700);
  expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
  if (!present)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  else {
    const stat = await lstat(path);
    expect(stat.isFile()).toBe(kind === 'file');
    expect(stat.mode & 0o7777).toBe(kind === 'file' ? 0o751 : 0o750);
    expect(await readFile(kind === 'file' ? path : join(path, 'child'), 'utf8')).toBe('original');
    if (kind === 'directory')
      expect((await lstat(join(path, 'child'))).mode & 0o7777).toBe(0o640);
  }
  expect(known(await readEvents(scope.journal, 0)).some(event => event.payload.type === 'outputs_preserved' &&
   event.payload.receipt.artifacts.length === 1)).toBe(true);
  // Delivery, including replace/create, must authenticate the baseline's declared path.
  if (present) {
    const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...baseline, path: 'different' }))));
    scope = { ...scope, outputBaseline: [wrong] };
    const altered = await checkpoint();
    expect(known(await preserveOutputs(scope, altered)).preserved).toBe(false);
  }
});
it.each((['file', 'directory'] as const).flatMap(kind => [false, true].flatMap(present => [false, true].map(modeChanged => ({ kind, present,
 modeChanged }))).filter(row => row.present || !row.modeChanged)))('restores frozen baseline $kind/present=$present/modeChanged=$modeChanged', async ({ kind, present, modeChanged }) => {
  const path = join(scope.layout.project, 'input');
  if (present) {
    if (kind === 'file')
      await writeFile(path, 'original');
    else {
      await mkdir(path);
      await writeFile(join(path, 'child'), 'original');
    }
    await chmod(path, 0o750);
  }
  declarations([{ id: 'frozen', path: 'input', kind, frozen: true }]);
  scope = { ...scope, inputBaseline: known(await hashInputs(scope)) };
  if (present && modeChanged)
    await chmod(path, 0o700);
  else {
    await rm(path, { recursive: true, force: true });
    if (kind === 'file')
      await mkdir(path);
    else
      await writeFile(path, 'mutation');
  }
  const settled = known(await settleFrozenInputs(scope));
  expect(settled.state).toBe('restored');
  expect(settled.evidence).toHaveLength(1);
  expect(known(await settleFrozenInputs(scope)).state).toBe('unchanged');
  if (present) {
    expect((await lstat(path)).mode & 0o7777).toBe(0o750);
    expect((await lstat(path)).isFile()).toBe(kind === 'file');
    expect(await readFile(kind === 'file' ? path : join(path, 'child'), 'utf8')).toBe('original');
  }
  else
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('quarantines a valid baseline manifest belonging to a different declared path', async () => {
  const path = join(scope.layout.project, 'input');
  await writeFile(path, 'original');
  declarations([{ id: 'frozen', path: 'input', kind: 'file', frozen: true }]);
  const captured = known(await hashInputs(scope))[0];
  const baseline = await manifest(captured);
  const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...baseline, path: 'other' }))));
  scope = { ...scope, inputBaseline: [wrong] };
  await writeFile(path, 'changed');
  expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
  expect(await readFile(path, 'utf8')).toBe('changed');
});
it.each(['file', 'directory'] as const)('archives a deliberately empty declared external %s without inventing gate acceptance', async (kind) => {
  const path = join(root, 'external');
  declarations([{ id: 'original', path, kind, frozen: false }], [{ path, kind, existing: 'create' }]);
  scope = { ...scope, outputBaseline: known(await hashInputs(scope)) };
  declarations([], [{ path, kind, existing: 'create' }]);
  if (kind === 'file')
    await writeFile(path, '');
  else
    await mkdir(path);
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
  await writeFile(kind === 'file' ? path : join(path, 'result'), 'authored');
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
});
it('original-baseline authority is checked before a checkpoint can replace current bytes', async () => {
  const path = join(scope.layout.project, 'out');
  await writeFile(path, 'approved original');
  declarations([{ id: 'original', path: 'out', kind: 'file', frozen: false }], [{ path: 'out', kind: 'file', existing: 'update' }]);
  const baseline = known(await hashInputs(scope));
  declarations([], [{ path: 'out', kind: 'file', existing: 'update' }]);
  scope = { ...scope, outputBaseline: baseline };
  const cp = await checkpoint();
  const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...(await manifest(baseline[0])), path: 'foreign' }))));
  scope = { ...scope, outputBaseline: [wrong] };
  await writeFile(join(scope.layout.project, 'late-work'), 'must survive refusal');
  expect(await materializeCheckpoint(scope, writer, cp)).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await readFile(join(scope.layout.project, 'late-work'), 'utf8')).toBe('must survive refusal');
  const altered = await checkpoint();
  expect(known(await preserveOutputs(scope, altered)).preserved).toBe(false);
});
it('checkpoint identity cannot substitute a different tree for authenticated Git content', async () => {
  await writeFile(join(scope.layout.project, 'value'), 'selected');
  const selected = await checkpoint();
  const forged = { ...selected, id: 'forged_checkpoint', tree: hash('different content generation') };
  await record({ type: 'checkpoint', checkpoint: forged });
  expect(await readCheckpoint(scope.journal, forged.id)).toMatchObject({ ok: false, kind: 'invalid' });
  await writeFile(join(scope.layout.project, 'late-work'), 'must survive refusal');
  expect((await materializeCheckpoint(scope, writer, forged)).ok).toBe(false);
  expect(await readFile(join(scope.layout.project, 'late-work'), 'utf8')).toBe('must survive refusal');
});
it('append preserves an empty literal Git directory while allowing it to gain children', async () => {
  const out = join(scope.layout.project, 'out');
  await mkdir(join(out, '.git'), { recursive: true });
  declarations([{ id: 'original', path: 'out', kind: 'directory', frozen: false }], [{ path: 'out', kind: 'directory', existing: 'append' }]);
  const baseline = known(await hashInputs(scope));
  declarations([], [{ path: 'out', kind: 'directory', existing: 'append' }]);
  scope = { ...scope, outputBaseline: baseline };
  await writeFile(join(out, '.git', 'literal'), 'new child');
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
  await rm(join(out, '.git'), { recursive: true });
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(false);
});
it('restores nested external original absence through its single declared containing root', async () => {
  const parent = join(root, 'external-parent'), child = join(parent, 'nested', 'child');
  const outputs = [{ path: parent, kind: 'directory' as const, existing: 'create' as const }, { path: child, kind: 'file' as const,
   existing: 'create' as const }];
  declarations(outputs.map((output, i) => ({ id: 'original_' + i, path: output.path, kind: output.kind, frozen: false })), outputs);
  const baseline = known(await hashInputs(scope));
  declarations([], outputs);
  scope = { ...scope, outputBaseline: baseline };
  const cp = await checkpoint();
  await mkdir(join(parent, 'nested'), { recursive: true });
  await writeFile(child, 'later authored output');
  expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
  await expect(lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  const retained = known(await readEvents(scope.journal, 0)).findLast(event => event.payload.type === 'outputs_preserved');
  expect(retained?.payload).toMatchObject({ type: 'outputs_preserved', receipt: { artifacts: expect.any(Array) } });
  expect(retained?.payload.type === 'outputs_preserved' && retained.payload.receipt.artifacts.length).toBe(2);
});
