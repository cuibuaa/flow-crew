import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { appendEvents, openJournal, openWriter, readEvents, readProjection, withState, claim, release, reconcileClaims, endPreparation } from '../dist-rewrite/records/state.js';
import * as host from '../dist-rewrite/host/process.js';
let f: SqlFixture;
const raw = { type: 'outputs_preserved' as const, receipt: { preserved: false, artifacts: [], detail: 'raw' } };
beforeEach(async () => { f = await sqlFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await f.close(); });
it('creates exclusively, reads without creating, and rejects missing addresses', async () => {
  expect(await openJournal(f.location, 'create')).toMatchObject({ ok: false, kind: 'conflict' });
  expect(await openJournal({ ...f.location, run: 'Missing' }, 'read')).toMatchObject({ ok: false, kind: 'invalid' });
  expect(get(await readEvents(f.journal, 0))).toEqual([]);
});
it('commits an atomic batch and CAS refuses stale and invalid cursors', async () => {
  expect(get(await appendEvents(f.execution, 0, [raw, raw]))).toBe(2);
  expect(f.execution.cursor).toBe(0);
  expect(await appendEvents(f.execution, 0, [raw])).toMatchObject({ ok: false, kind: 'conflict' });
  expect(await readEvents(f.journal, 3)).toMatchObject({ ok: false, kind: 'invalid' });
  expect(get(await readEvents(f.journal, 1)).map(e => e.seq)).toEqual([2]);
});
it('rolls back current rows and events together when a later fact refuses', async () => {
  await f.admit();
  const before = await f.projection();
  expect(await appendEvents(f.execution, before.cursor, [raw, { type: 'stage_settled', stage: 'undefined', state: 'settled',
   evidence: [] }])).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await f.projection()).toEqual(before);
  expect(get(await readEvents(f.journal, 0))).toHaveLength(before.cursor);
});
it('uses FULL synchronous WAL and foreign key constraints', () => {
  expect(get(withState(f.database, false, db => ({ ok: true, value: [db.prepare('PRAGMA synchronous').get(),
   db.prepare('PRAGMA journal_mode').get(), db.prepare('PRAGMA foreign_keys').get()] })))).toEqual([{ synchronous: 2 }, {
   journal_mode: 'wal' }, { foreign_keys: 1 }]);
});
it('rejects synchronous reentry and promise callbacks without speculative changes', () => {
  expect(get(withState(f.database, true, () => ({ ok: true, value: withState(f.database, true, () => ({ ok: true,
   value: 1 })) })))).toMatchObject({ ok: false, kind: 'conflict' });
  expect(withState(f.database, true, (() => Promise.resolve({ ok: true, value: 1 })) as never)).toMatchObject({ ok: false, kind: 'unknown' });
});
it.each(['before-commit', 'close'] as const)('transaction outcome belongs to COMMIT under %s fault', async cut => {
  const intent = { id: 'Cancel', kind: 'cancel' as const, run: 'Run', unit: f.launch.unit, expectedCursor: 0 };
  const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  if (cut === 'before-commit') {
    const native = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') throw Error('before commit');
      native.call(this, sql);
    });
  } else {
    const native = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) {
      native.call(this); throw Error('after commit close');
    });
  }
  const result = await appendEvents(f.control, 0, [{ type: 'control_intent', intent }]);
  expect(result).toMatchObject(cut === 'close' ? { ok: true, value: 1 } : { ok: false, kind: 'unknown' });
  if (cut === 'close') expect(warning.mock.calls.flat().join('')).toContain('State cleanup warning');
  vi.restoreAllMocks();
  expect(get(await readEvents(f.journal, 0)).map(event => event.payload)).toEqual(cut === 'close' ? [{ type: 'control_intent', intent }] : []);
});
it('fences new positive work, retains late evidence, and cannot revive cancellation', async () => {
  await f.admit();
  expect(await endPreparation(f.control, 'refused', 'Already admitted')).toMatchObject({ ok: false, kind: 'invalid' });
  await f.append(f.control, [{ type: 'control_intent', intent: { id: 'Cancel', kind: 'cancel', run: 'Run', unit: f.launch.unit,
   expectedCursor: 5 } }]);
  const cursor = (await f.projection()).cursor;
  expect(await appendEvents(f.execution, cursor, [{ type: 'stage_settled', stage: 'work', state: 'settled',
   evidence: [] }])).toMatchObject({ ok: false, kind: 'conflict' });
  get(await appendEvents(f.execution, cursor, [raw]));
  expect((await f.projection()).status).toBe('cancelled');
  expect(await appendEvents(f.execution, cursor + 1, [{ type: 'lifecycle', conclusion: { status: 'complete', reason: 'completed',
   detail: '' } }])).toMatchObject({ ok: false, kind: 'conflict' });
});
it('separates control and execution writer kinds', async () => {
  expect(await appendEvents(f.execution, 0, [{ type: 'control_intent', intent: { id: 'Status', kind: 'status', run: 'Run',
   unit: f.launch.unit, expectedCursor: 0 } }])).toMatchObject({ ok: false, kind: 'conflict' });
  expect(await appendEvents(f.control, 0, [{ type: 'stage_settled', stage: 'work', state: 'settled', evidence: [] }])).toMatchObject({
   ok: false, kind: 'conflict' });
});
it('retired epochs never regain authority and replacing execution leaves control active', async () => {
  const held = get(await claim(f.project + '/replacement', null, { database: f.database, holder: f.journal.root }));
  expect(await openWriter(f.journal, held, 'execution')).toMatchObject({ ok: false, kind: 'conflict' });
  await f.retireExecution();
  const replacement = get(await openWriter(f.journal, held, 'execution'));
  expect(await appendEvents(f.execution, 0, [raw])).toMatchObject({ ok: false, kind: 'conflict' });
  expect(await openWriter(f.journal, { ...held, epoch: f.execution.epoch }, 'execution')).toMatchObject({ ok: false, kind: 'conflict' });
  get(await appendEvents(f.control, 0, [raw]));
  get(await appendEvents(replacement, 1, [raw]));
  get(await release(held));
  expect(await appendEvents(replacement, 2, [raw])).toMatchObject({ ok: false, kind: 'conflict' });
  expect(await endPreparation(replacement, 'cancelled', 'Stale writer')).toMatchObject({ ok: false, kind: 'conflict' });
  expect(get(await readEvents(f.journal, 0))).toHaveLength(2);
});
it('documents valid-cell edits as outside structural corruption detection', () => {
  get(withState(f.database, true, db => {
   db.prepare("UPDATE runs SET current=json_set(current,'$.status','parked') WHERE root=?").run(f.journal.root); return { ok: true, value: true }; }));
  expect(get(withState(f.database, false, db => ({ ok: true, value: db.prepare('PRAGMA integrity_check').get() })))).toEqual({
   integrity_check: 'ok' });
});
it('reconcileClaims deletes a reclaimed run claim instead of handing it off', async () => {
  await f.admit();
  const held = get(await claim(f.project + '/interrupted', f.launch.unit, { database: f.database, holder: f.journal.root }));
  await f.append(f.execution, [{ type: 'lifecycle', conclusion: { status: 'complete', reason: 'completed', detail: '' } }]);
  await f.append(f.control, [{ type: 'run_reclaimed', at: new Date().toISOString(), delivery: f.root + '/delivery' }, { type: 'reclaim_completed' }]);
  vi.spyOn(host, 'probeOwner').mockResolvedValue('dead');
  const retained = get(withState(f.database, false, db => ({ ok: true, value: db.prepare('SELECT epoch FROM resources WHERE epoch<>?').all(held.epoch) })));
  get(await reconcileClaims(f.journal, retained.map(row => ({ ...held, epoch: String(row.epoch) }))));
  expect(get(withState(f.database, false, db => ({ ok: true, value: db.prepare('SELECT * FROM resources WHERE epoch=?').all(held.epoch) })))).toEqual([]);
});
