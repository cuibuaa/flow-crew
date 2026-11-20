import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readEvents, readProjection, withState, recordOperation } from '../dist-rewrite/records/state.js';
let f: SqlFixture;
beforeEach(async () => { f = await sqlFixture(); });
afterEach(async () => { await f.close(); });
it('keeps current-state reads independent of the append-only history', async () => {
  await f.admit();
  for (let i = 0; i < 3; i++)
    await f.append(f.execution, [{ type: 'outputs_preserved', receipt: { preserved: false, artifacts: [], detail: String(i) } }]);
  expect((await f.projection()).cursor).toBe(8);
  // SQL current rows are authoritative; removing an old observation does not invoke a second reducer.
  get(withState(f.database, true, db => { db.prepare('DELETE FROM events WHERE root=? AND seq=6').run(f.journal.root); return { ok: true,
   value: true }; }));
  expect((await f.projection()).cursor).toBe(8);
  expect((await f.projection()).outputs).toHaveLength(3);
});

import { mkdir, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { claim, openJournal, openWriter, appendEvents, release } from '../dist-rewrite/records/state.js';
import { interpretAuthority } from '../dist-rewrite/exec/policy.js';
it.each([
  ['shared-write', 'shared-write', true], ['shared-write', 'exclusive-write', false], ['exclusive-write', 'shared-write', false],
  ['stable-read', 'stable-read', true], ['stable-read', 'shared-write', false], ['shared-write', 'stable-read', false],
  ['exclusive-write', 'stable-read', false], ['stable-read', 'exclusive-write', false],
] as const)('arbitrates two stores %s then %s with independent expected success=%s', async (a, b, success) => {
  const resource = join(f.root, 'common');
  await mkdir(resource);
  const authorize = (mode: typeof a | typeof b, project: string) => { const table = get(interpretAuthority({ ...f.brief.declaration,
    inputs: mode === 'stable-read' ? [{ id: 'Input', path: resource, kind: 'directory', frozen: true }] : [],
    outputs: mode === 'exclusive-write' ? [{ path: resource, kind: 'directory', existing: 'update' }] : [] }, { project,
     protectedRoots: [], workRoot: join(f.root, 'scratch') }, mode === 'exclusive-write' ? ['directory'] : []));
    return mode === 'shared-write' ? { ...table, resources: [...table.resources, { path: resource, access: mode }] } : table; };
  get(await appendEvents(f.control, 0, [{ type: 'run_authority', authority: authorize(a, f.project) }]));
  const storeRoot = join(f.root, 'other-store'), project = join(f.root, 'other-project');
  await mkdir(storeRoot);
  await mkdir(project);
  const journal = get(await openJournal({ storeRoot, run: 'Run', database: f.database }, 'create'));
  const held = get(await claim(join(journal.root, 'control'), null, { database: f.database, holder: journal.root }));
  try {
    const writer = get(await openWriter(journal, held, 'control'));
    const result = await appendEvents(writer, 0, [{ type: 'run_authority', authority: authorize(b, project) }]);
    expect(result.ok).toBe(success);
    if (!success)
      expect(result).toMatchObject({ ok: false, kind: 'conflict' });
  }
  finally {
    get(await release(held, 'retire'));
  }
});
it.each(['ancestry', 'inode'] as const)('refuses cross-store writer aliases by %s', async (kind) => {
  const resource = join(f.root, 'common'), alias = kind === 'ancestry' ? join(resource, 'nested') : join(f.root, 'alias');
  if (kind === 'ancestry') {
    await mkdir(resource);
    await mkdir(alias);
  }
  else {
    await writeFile(resource, 'shared inode');
    await link(resource, alias);
  }
  const base = { ...f.scope.authority, resources: [{ path: resource, access: 'shared-write' as const }] };
  get(await appendEvents(f.control, 0, [{ type: 'run_authority', authority: base }]));
  const storeRoot = join(f.root, 'other');
  await mkdir(storeRoot);
  const journal = get(await openJournal({ storeRoot, run: 'Run', database: f.database }, 'create'));
  const held = get(await claim(join(journal.root, 'control'), null, { database: f.database, holder: journal.root }));
  try {
    const writer = get(await openWriter(journal, held, 'control'));
    expect(await appendEvents(writer, 0, [{ type: 'run_authority', authority: { ...base, resources: [{ path: alias,
     access: 'exclusive-write' }] } }])).toMatchObject({ ok: false, kind: 'conflict' });
  }
  finally {
    get(await release(held, 'retire'));
  }
});
