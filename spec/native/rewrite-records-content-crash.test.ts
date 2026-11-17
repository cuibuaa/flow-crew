import { it, expect, vi } from 'vitest';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, known, wait } from "../fixtures/rewrite-host.js";
import * as state from "../../dist-rewrite/records/state.js";
import * as host from "../../dist-rewrite/host/process.js";
import { readEvidence, identifyEvidence } from "../../dist-rewrite/records/evidence.js";
const module = new URL("./fixtures/rewrite-native-operation.mjs", import.meta.url).href;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function records(database: string) { const db = new DatabaseSync(database); try {
  return db.prepare("SELECT * FROM resources WHERE id LIKE 'record:%'").all().map((r: any) => ({ ...r, owner: JSON.parse(r.owner) }));
}
finally {
  db.close();
} }
it('Input 11 killed constructor retains real SQL claim until native group close and exact-epoch reclaim', async ({ signal }) => {
  const f = await fixture();
  let owner: any;
  try {
    const gates = join(f.work, 'gates');
    await mkdir(gates);
    const operation = state.recordOperation(f.journal, 'construct', { module, method: 'constructGated', args: [f.journal, gates] });
    await wait(async () => { try {
      await access(join(gates, 'native'));
      return records(f.location.database).some(r => r.owner.members?.length);
    }
    catch {
      return false;
    } }, operation, signal);
    owner = records(f.location.database)[0].owner;
    const native = Number(await readFile(join(gates, 'native'), 'utf8'));
    await writeFile(join(gates, 'go'), 'go');
    await wait(async () => { try {
      await access(join(gates, 'object'));
      return true;
    }
    catch {
      return false;
    } }, operation, signal);
    process.kill(owner.pid, 'SIGKILL');
    await pause(30);
    expect(() => process.kill(native, 0)).not.toThrow();
    expect(await state.recordOperation(f.journal, 'restore', { module, method: 'touch', args: [join(gates,
     'forbidden')] })).toMatchObject({ ok: false, kind: 'conflict' });
    expect(await state.recordOperation(f.journal, 'gc', { module, method: 'touch', args: [join(gates, 'forbidden')] })).toMatchObject({
     ok: false, kind: 'conflict' });
    expect(records(f.location.database)).toHaveLength(1);
    expect(host.groupState(owner)).not.toBe('dead');
    known(await state.reclaimRecordOperations(f.journal));
    expect(host.groupState(owner)).toBe('dead');
    expect(records(f.location.database)).toHaveLength(0);
    expect((await operation).ok).toBe(false);
    const raw = identifyEvidence(Buffer.from('gated-object'));
    expect(Buffer.from(known(await readEvidence(f.journal, raw))).toString()).toBe('gated-object');
    await f.evidence('Input11', { owner, native, groupAfter: host.groupState(owner), claimRows: 0 });
  }
  finally {
    if (owner)
      await host.closeOperation(owner);
    await f.close();
  }
});
it('object durability before fact commit preserves bytes without inventing a committed fact', async () => {
  const f = await fixture();
  try {
    expect((await state.recordOperation(f.journal, 'construct', { module, method: 'publishAndKill', args: [f.journal] })).ok).toBe(false);
    const ref = identifyEvidence(Buffer.from('durable-before-fact'));
    expect(Buffer.from(known(await readEvidence(f.journal, ref))).toString()).toBe('durable-before-fact');
    expect(known(await state.readEvents(f.journal, 0))).toHaveLength(0);
    known(await state.reclaimRecordOperations(f.journal));
    expect(records(f.location.database)).toHaveLength(0);
  }
  finally {
    await f.close();
  }
});
it('claim insertion before go: killed idle executor creates no object and exact epoch alone can retire', async () => {
  const f = await fixture();
  let owner: any;
  try {
    const marker = join(f.work, 'forbidden');
    const result = await host.runOperation({ module, method: 'touch', args: [marker] }, { ready: async (value) => {
        owner = value;
        const db = new DatabaseSync(f.location.database);
        try {
          db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?)').run('record:barrier', f.journal.root, f.journal.root,
           'shared-write', null, JSON.stringify(owner), null, 'BarrierEpoch');
        }
        finally {
          db.close();
        }
        process.kill(owner.pid, 'SIGKILL');
        await pause(30);
        return { ok: true, value: true };
      }, updated: async () => ({ ok: true, value: true }), closed: async () => {
       throw Error('Interrupted barrier cannot retire its own claim'); } });
    expect(result).toMatchObject({ ok: false, kind: 'unknown' });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(records(f.location.database)).toHaveLength(1);
    known(await state.reclaimRecordOperations(f.journal));
    expect(records(f.location.database)).toHaveLength(0);
    await f.evidence('claim-before-go', { owner, result });
  }
  finally {
    if (owner)
      await host.endOperation(owner);
    await f.close();
  }
});
it('reclaim closes outside SQL and refuses retirement when the captured claim epoch changes during close', async () => {
  const f = await fixture();
  let owner: any;
  try {
    const gates = join(f.work, 'epoch-gates');
    await mkdir(gates);
    const operation = state.recordOperation(f.journal, 'construct', { module, method: 'awaitRelease', args: [gates] });
    await wait(async () => access(join(gates, 'ready')).then(() => true, () => false));
    const row = records(f.location.database)[0];
    owner = row.owner;
    const native = process.kill.bind(process);
    let changed = false;
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => { if (pid === -owner.group && sig === 'SIGKILL' && !changed) {
      const db = new DatabaseSync(f.location.database);
      try {
        db.prepare('UPDATE resources SET epoch=? WHERE id=?').run('ChangedEpoch', row.id);
        changed = true;
      }
      finally {
        db.close();
      }
    } return native(pid, sig); });
    try {
      expect(await state.reclaimRecordOperations(f.journal)).toMatchObject({ ok: false, kind: 'conflict' });
    }
    finally {
      signal.mockRestore();
    }
    expect(changed).toBe(true);
    expect(records(f.location.database)[0].epoch).toBe('ChangedEpoch');
    expect(host.groupState(owner)).toBe('dead');
    expect(await operation).toMatchObject({ ok: false });
    known(await state.reclaimRecordOperations(f.journal));
  }
  finally {
    vi.restoreAllMocks();
    if (owner)
      await host.endOperation(owner);
    await f.close();
  }
});
