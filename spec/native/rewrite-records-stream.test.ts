import * as cp from 'node:child_process';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { claim, release, initializeState, recordOperation } from "../../dist-rewrite/records/state.js";
import { captureTree, hashInputs } from "../../dist-rewrite/records/content.js";
import { interpretAuthority } from "../../dist-rewrite/exec/policy.js";
import { readEvidence } from "../../dist-rewrite/records/evidence.js";
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openJournal } from "../../dist-rewrite/records/state.js";
import { putEvidence, streamEvidence, evidenceOid, evidenceRepository } from "../../dist-rewrite/records/evidence.js";
vi.mock('node:child_process', async (original) => { const actual = await original<typeof import('node:child_process')>(); return {
 ...actual, spawn: vi.fn(actual.spawn) }; });
let root: string;
afterEach(async () => { if (root)
  await rm(root, { recursive: true, force: true }); });
it('streams raw Git evidence in bounded chunks and reuses its immutable object', async () => {
  root = await mkdtemp(join(tmpdir(), 'rewrite-stream-'));
  const state = initializeState(join(root, 'state.sqlite'));
  if (!state.ok)
    throw Error(state.detail);
  const opened = await openJournal({ database: state.value, storeRoot: root, run: 'Stream' }, 'create');
  if (!opened.ok)
    throw new Error(opened.detail);
  const journal = opened.value, content = Buffer.alloc(2 * 1024 * 1024, 41);
  const result = await putEvidence(journal, content);
  if (!result.ok)
    throw new Error(result.detail);
  const ref = result.value, oid = evidenceOid(ref), path = join(evidenceRepository(journal), 'objects', oid.slice(0, 2), oid.slice(2));
  const before = await stat(path), hash = createHash('sha256');
  let chunks = 0, max = 0;
  for await (const chunk of streamEvidence(journal, ref)) {
    hash.update(chunk);
    chunks++;
    max = Math.max(max, chunk.length);
  }
  expect(chunks).toBeGreaterThan(2);
  expect(max).toBeLessThan(content.length);
  expect(hash.digest('hex')).toBe(ref.sha256);
  expect(await putEvidence(journal, content)).toEqual(result);
  expect((await stat(path)).ino).toBe(before.ino);
});
it('never accepts a wrong raw pin even when the Git OID is valid', async () => {
  root = await mkdtemp(join(tmpdir(), 'rewrite-stream-pin-'));
  const state = initializeState(join(root, 'state.sqlite'));
  if (!state.ok)
    throw Error(state.detail);
  const opened = await openJournal({ database: state.value, storeRoot: root, run: 'Stream' }, 'create');
  if (!opened.ok)
    throw new Error(opened.detail);
  const result = await putEvidence(opened.value, Buffer.from('raw bytes'));
  if (!result.ok)
    throw new Error(result.detail);
  await expect(async () => { for await (const _ of streamEvidence(opened.value, { ...result.value, sha256: 'a'.repeat(64) })) {
   } }).rejects.toThrow('authentication');
});
async function sourceFixture() {
  root = await mkdtemp(join(tmpdir(), 'rewrite-racy-'));
  const project = join(root, 'project'), storeRoot = join(root, 'store');
  await mkdir(project);
  await mkdir(storeRoot);
  const state = initializeState(join(root, 'state.sqlite'));
  if (!state.ok)
    throw Error(state.detail);
  const opened = await openJournal({ database: state.value, storeRoot, run: 'Racy' }, 'create');
  if (!opened.ok)
    throw new Error(opened.detail);
  const journal = opened.value, held = await claim(project, null, { database: state.value, holder: journal.root });
  if (!held.ok)
    throw new Error(held.detail);
  const raw = await putEvidence(journal, Buffer.from('racy fixture'));
  if (!raw.ok)
    throw new Error(raw.detail);
  const declaration = { body: 'fixture', criteria: [{ id: 'correct', text: 'Complete bytes' }], inputs: [{ id: 'input', path: 'input',
   kind: 'file' as const, frozen: false }], outputs: [], commands: [], results: [], allowBlocked: false };
  const authority = interpretAuthority(declaration, {
   project, protectedRoots: [journal.root], workRoot: join(root, 'work') }, []);
  if (!authority.ok)
    throw new Error(authority.detail);
  const scope = { journal, layout: { location: { storeRoot, run: 'Racy' }, project, protectedRoots: [journal.root] },
   brief: { bytes: raw.value, digest: raw.value.sha256, declaration }, inputBaseline: [], outputBaseline: [],
   projectClaim: held.value, authority: authority.value };
  const input = join(project, 'input');
  await writeFile(input, 'aaaa');
  utimesSync(input, 100, 100);
  return { scope, input, held: held.value };
}
it.each([true, false])('rehashes bytes with deterministic same-second ctime and restored mtime (declared=%s)', async (declared) => {
  const fixture = await sourceFixture(), { input, held } = fixture;
  const scope = declared ? fixture.scope : { ...fixture.scope, brief: { ...fixture.scope.brief, declaration: {
   ...fixture.scope.brief.declaration, inputs: [] } } };
  try {
    const beforeStat = await stat(input), aTree = await captureTree(scope), a = await hashInputs(scope);
    if (!a.ok)
      throw new Error(a.detail);
    await writeFile(input, 'bbbb');
    utimesSync(input, beforeStat.atime, beforeStat.mtime);
    expect((await stat(input)).mtimeMs).toBe(beforeStat.mtimeMs);
    // A rewrite within the same ctime second with the mtime restored is what a stale index would miss. A capture keeps no index
    // between captures (its own is private and removed with it), so nothing is left that could go stale.
    expect((await readdir(evidenceRepository(scope.journal))).filter(name => name.startsWith('index'))).toEqual([]);
    const bTree = await captureTree(scope);
    expect(aTree.ok).toBe(true);
    expect(bTree.ok).toBe(true);
    expect(bTree).not.toEqual(aTree);
    if (!declared)
      return;
    const b = await hashInputs(scope);
    if (!b.ok)
      throw new Error(b.detail);
    expect(b.value).not.toEqual(a.value);
    const bytes = await readEvidence(scope.journal, b.value[0]);
    if (!bytes.ok)
      throw new Error(bytes.detail);
    expect(JSON.parse(Buffer.from(bytes.value).toString()).snapshot.sha256).toBe(createHash('sha256').update('bbbb').digest('hex'));
    expect(await hashInputs(scope)).toEqual(b);
  }
  finally {
    const result = await release(held, 'retire');
    expect(result.ok).toBe(true);
  }
});
it('an observed source race fails through the owned native exit protocol before exposing a generation', async () => {
  const { scope, input, held } = await sourceFixture();
  try {
    const observed = await recordOperation(scope.journal, 'construct', {
      module: new URL("./fixtures/rewrite-capture-race.mjs", import.meta.url).href,
      method: 'captureRace', args: [scope, input],
    });
    if (!observed.ok)
      throw Error(observed.detail);
    expect(observed.value.result).toMatchObject({ ok: false, kind: 'conflict' });
    expect(observed.value.injected).toBe(true);
  }
  finally {
    expect((await release(held, 'retire')).ok).toBe(true);
  }
});
