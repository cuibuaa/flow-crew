import { mkdtemp, mkdir, rm, chmod, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Result } from "../../dist-rewrite/contract/brief.js";
import type { CommandKey, CommandReceipt, Invocation, Writer } from "../../dist-rewrite/contract/runtime.js";
import { release, claim, initializeState, openJournal, openWriter, readEvents } from "../../dist-rewrite/records/state.js";
import { putEvidence, readEvidence, evidenceRepository, evidenceOid } from "../../dist-rewrite/records/evidence.js";
import { readCommand, reserveCommand, commitCommand } from "../../dist-rewrite/records/state.js";
import { validateRecordRef } from "../../dist-rewrite/records/evidence.js";
import { validateRecordLayout } from "../../dist-rewrite/records/content.js";
vi.mock("../../dist-rewrite/host/process.js", async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 probeOwner: vi.fn(async () => 'live') }));
const roots: string[] = [];
const claims: any[] = [];
afterEach(async () => { for (const held of claims.splice(0))
  get(await release(held, 'retire')); for (const root of roots.splice(0))
  await rm(root, { recursive: true, force: true }); });
const objectPath = (j: {
  root: string;
}, ref: {
  path: string;
  sha256: string;
}) => { const oid = evidenceOid(ref); return join(evidenceRepository(j), 'objects', oid.slice(0, 2), oid.slice(2)); };
function get<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; }
const hash = 'a'.repeat(64);
const key: CommandKey = { tree: hash, declaration: hash, inputHashes: [hash], context: hash };
const invocation: Invocation = { charge: 'command', address: { kind: 'setup', run: 'Run' } };
async function fixture(): Promise<{
  writer: Writer;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rewrite-ledger-'));
  roots.push(root);
  const database = get(initializeState(join(root, 'state.sqlite')));
  const journal = get(await openJournal({ storeRoot: root, run: 'Run', database }, 'create'));
  const held = get(await claim(join(journal.root, 'execution'), null, { database, holder: journal.root }));
  claims.push(held);
  const writer = get(await openWriter(journal, held, 'execution'));
  return { writer, root };
}
it('publishes identical bytes once and distinct bytes separately; corrupt and missing evidence are refusals', async () => {
  const { writer } = await fixture(), j = writer.journal;
  const a = get(await putEvidence(j, Buffer.from('a'))), b = get(await putEvidence(j, Buffer.from('b')));
  expect(get(await putEvidence(j, Buffer.from('a')))).toEqual(a);
  expect(b).not.toEqual(a);
  expect(Buffer.from(get(await readEvidence(j, a))).toString()).toBe('a');
  await chmod(objectPath(j, a), 0o644);
  await writeFile(objectPath(j, a), 'corrupt');
  await chmod(objectPath(j, a), 0o444);
  expect(await readEvidence(j, a)).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await putEvidence(j, Buffer.from('a'))).toMatchObject({ ok: false, kind: 'invalid' });
  await rm(objectPath(j, b));
  expect(await readEvidence(j, b)).toMatchObject({ ok: false, kind: 'unavailable' });
});
it('refuses escaping, symlinked, writable and nonengine carriers even with the correct digest', async () => {
  const { writer, root } = await fixture(), j = writer.journal, a = get(await putEvidence(j, Buffer.from('a')));
  expect(await validateRecordRef(j, { ...a, path: '../escape' })).toMatchObject({ ok: false, kind: 'invalid' });
  await writeFile(join(j.root, 'verdict.json'), 'a');
  await chmod(join(j.root, 'verdict.json'), 0o444);
  expect(await validateRecordRef(j, { ...a, path: 'verdict.json' })).toMatchObject({ ok: false, kind: 'invalid' });
  await link(objectPath(j, a), join(j.root, 'alias'));
  expect((await readEvidence(j, a)).ok).toBe(true);
  await rm(join(j.root, 'alias'));
  await rm(objectPath(j, a));
  await writeFile(join(root, 'outside'), 'a');
  await symlink(join(root, 'outside'), objectPath(j, a));
  expect((await readEvidence(j, a)).ok).toBe(false);
});
it('validates roots and refuses only inodes shared by protected and writable roots', async () => {
  const { writer, root } = await fixture();
  const project = join(root, 'project'), cache = join(root, 'cache');
  await mkdir(project);
  await mkdir(cache);
  const layout = { location: { storeRoot: root, run: 'Run' }, project, protectedRoots: [writer.journal.root], sharedCaches: [cache] };
  expect((await validateRecordLayout(layout)).ok).toBe(true);
  expect(await validateRecordLayout({ ...layout, protectedRoots: [project, writer.journal.root] })).toMatchObject({ ok: false, kind: 'conflict' });
  const alias = join(root, 'project-alias');
  await symlink(project, alias);
  expect(await validateRecordLayout({ ...layout, project: alias })).toMatchObject({ ok: false, kind: 'invalid' });
  await writeFile(join(project, 'file'), 'x');
  await link(join(project, 'file'), join(cache, 'alias'));
  expect((await validateRecordLayout(layout)).ok).toBe(true);
  const evidence = get(await putEvidence(writer.journal, Buffer.from('protected')));
  const outside = join(root, 'another-checkout');
  await mkdir(outside);
  await link(objectPath(writer.journal, evidence), join(outside, 'release-dependency'));
  expect((await validateRecordLayout(layout)).ok).toBe(true);
  await link(objectPath(writer.journal, evidence), join(writer.journal.root, 'internal-alias'));
  expect((await validateRecordLayout(layout)).ok).toBe(true);
});
it('reserves the invocation and exact run key atomically; reopen is uncertain and reuse never spends again', async () => {
  const { writer } = await fixture();
  expect(get(await readCommand(writer.journal, key))).toBeNull();
  const reserved = get(await reserveCommand(writer, 0, 'Check', key, invocation));
  expect(reserved.state).toBe('reserved');
  expect(get(await readEvents(writer.journal, 0)).map(e => e.payload.type)).toEqual(['invocation_reserved', 'command_reserved']);
  expect(get(await readCommand(writer.journal, key))?.state).toBe('uncertain');
  expect(get(await reserveCommand(writer, 0, 'Check', key, invocation)).state).toBe('uncertain');
  expect(get(await readEvents(writer.journal, 0))).toHaveLength(2);
  expect(get(await readCommand(writer.journal, { ...key, context: 'b'.repeat(64) }))).toBeNull();
});
it('simultaneous reservations have one charge and one durable reservation', async () => {
  const { writer } = await fixture();
  const results = await Promise.all([reserveCommand(writer, 0, 'Check', key, invocation), reserveCommand(writer, 0, 'Check', key, invocation)]);
  expect(results.some(r => r.ok)).toBe(true);
  expect(get(await readEvents(writer.journal, 0)).filter(e => e.payload.type === 'invocation_reserved')).toHaveLength(1);
});
it.each([0, 9, 'unfinished'] as const)('commits %s exactly once and reuses the original result', async (execution) => {
  const { writer } = await fixture();
  const reservation = get(await reserveCommand(writer, 0, 'Check', key, invocation));
  const ref = get(await putEvidence(writer.journal, Buffer.from('output')));
  const receipt: CommandReceipt = { key, command: 'Check', execution: execution === 'unfinished' ? { state: 'unfinished',
   reason: 'duration' } : { state: 'complete', exit: execution },
    stdout: ref, stderr: ref, before: hash, after: hash, delta: ref, spent: { durationMs: 101 } };
  expect(get(await commitCommand(writer, 2, reservation, receipt))).toBe(3);
  expect(get(await readCommand(writer.journal, key))).toMatchObject({ state: 'committed', receipt });
  expect(get(await readCommand(writer.journal, key))!.receipt!.spent).toEqual({ durationMs: 101 });
  expect(await commitCommand(writer, 3, reservation, receipt)).toEqual({
    ok: false, kind: 'conflict', detail: 'Reservation is absent, replaced or already committed',
  });
  expect(get(await reserveCommand(writer, 0, 'Check', key, invocation))).toMatchObject({ state: 'committed', receipt });
});
it.each(['command', 'key', 'invocation', 'tree', 'evidence'] as const)('refuses mismatched %s without a commit', async (field) => {
  const { writer } = await fixture();
  let reservation = get(await reserveCommand(writer, 0, 'Check', key, invocation));
  const ref = get(await putEvidence(writer.journal, Buffer.from('output')));
  let receipt: CommandReceipt = { key, command: 'Check', execution: { state: 'complete', exit: 0 }, stdout: ref, stderr: ref,
   before: hash, after: hash, delta: ref, spent: { durationMs: 5 } };
  if (field === 'command')
    receipt = { ...receipt, command: 'Other' };
  if (field === 'key')
    receipt = { ...receipt, key: { ...key, declaration: 'b'.repeat(64) } };
  if (field === 'invocation')
    reservation = { ...reservation, invocation: { ...invocation, address: { kind: 'final', run: 'Run' } } };
  if (field === 'tree')
    receipt = { ...receipt, before: 'b'.repeat(64) };
  if (field === 'evidence')
    receipt = { ...receipt, stdout: { path: 'verdict.json', sha256: hash } };
  expect((await commitCommand(writer, 2, reservation, receipt)).ok).toBe(false);
  expect(get(await readEvents(writer.journal, 0))).toHaveLength(2);
});
it.each(['tree', 'declaration', 'context', 'inputHashes'] as const)('binds exact %s and keeps reuse local to one run', async (field) => {
  const { writer } = await fixture();
  get(await reserveCommand(writer, 0, 'Check', key, invocation));
  const different = { ...key, [field]: field === 'inputHashes' ? ['b'.repeat(64)] : 'b'.repeat(64) };
  expect(get(await readCommand(writer.journal, different))).toBeNull();
  const other = await fixture();
  expect(get(await readCommand(other.writer.journal, key))).toBeNull();
  expect((await reserveCommand(writer, 2, 'OtherCommand', key, invocation)).ok).toBe(false);
});
it('authenticates selected committed evidence after every lookup, including a fresh selection', async () => {
  const { writer } = await fixture(), reservation = get(await reserveCommand(writer, 0, 'Check', key, invocation));
  const ref = get(await putEvidence(writer.journal, Buffer.from('raw')));
  get(await commitCommand(writer, 2, reservation, { key, command: 'Check', execution: { state: 'complete', exit: 0 }, stdout: ref,
   stderr: ref, before: hash, after: hash, delta: ref, spent: { durationMs: 1 } }));
  await rm(objectPath(writer.journal, ref));
  expect(await readCommand(writer.journal, key)).toMatchObject({ ok: false, kind: 'unavailable' });
  expect(get(await readCommand(writer.journal, { ...key, context: 'b'.repeat(64) }))).toBeNull();
});

it('refuses a committed caller reservation even when the journal still holds the original unresolved reservation', async () => {
  const { writer } = await fixture(), reservation = get(await reserveCommand(writer, 0, 'Check', key, invocation));
  const ref = get(await putEvidence(writer.journal, Buffer.from('raw')));
  const receipt: CommandReceipt = { key, command: 'Check', execution: { state: 'complete', exit: 9 },
    stdout: ref, stderr: ref, before: hash, after: hash, delta: ref, spent: { durationMs: 1 } };
  expect(await commitCommand(writer, 2, { ...reservation, state: 'committed', receipt }, receipt)).toMatchObject({ ok: false, kind: 'invalid' });
  expect(get(await readEvents(writer.journal, 0))).toHaveLength(2);
});
it('refuses canonical protected roots sharing the same real inode', async () => {
  const { writer, root } = await fixture(), project = join(root, 'project');
  await mkdir(project);
  const original = join(root, 'protected'), alias = join(root, 'protected-alias');
  await writeFile(original, 'protected bytes');
  await link(original, alias);
  const layout = { location: { storeRoot: root, run: 'Run' }, project, protectedRoots: [writer.journal.root, original] };
  expect(await validateRecordLayout(layout)).toMatchObject({ ok: true });
  expect(await validateRecordLayout({ ...layout, protectedRoots: [...layout.protectedRoots, alias] }))
    .toMatchObject({ ok: false, kind: 'invalid' });
});
import * as evidenceModule from "../../dist-rewrite/records/evidence.js";
import { recordOperation } from "../../dist-rewrite/records/state.js";
it('unknown command ownership refuses both destructive restore and GC', async () => {
  const { writer } = await fixture();
  get(await reserveCommand(writer, 0, 'Check', key, invocation));
  for (const kind of ['restore', 'gc'] as const)
    expect(await recordOperation(writer.journal, kind, { module: new URL("./fixtures/rewrite-native-operation.mjs",
     import.meta.url).href, method: 'touch', args: [] })).toMatchObject({ ok: false, kind: 'unknown',
     detail: 'Unresolved reservation prevents maintenance' });
});
