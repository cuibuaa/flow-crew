import { it, expect } from 'vitest';
import { fixture, known } from "../fixtures/rewrite-host.js";
import { storeEvidence, readEvents, appendEvents } from "../../dist-rewrite/records/state.js";
it('status, cancel and evidence complete while a real construction stream remains suspended outside SQL', async () => {
  const f = await fixture();
  let resume!: () => void, entered!: () => void;
  const active = new Promise<void>(r => entered = r), barrier = new Promise<void>(r => resume = r);
  const capture = storeEvidence(f.journal, async function* () { entered(); await barrier; yield Buffer.alloc(1024 * 1024); });
  await active;
  try {
    known(await storeEvidence(f.journal, async function* () { yield Buffer.from('cancel evidence'); }));
    const events = known(await readEvents(f.journal, 0));
    expect(events).toHaveLength(0);
    // A committed fence can contend with a running native construction owner.
    const unit = { run: 'host_case', authority: 'synthetic', runtime: { path: 'release/manifest', sha256: 'a'.repeat(64) } };
    known(await f.ports.recordProcess({ type: 'control_intent', intent: { kind: 'cancel', id: 'Cancel', run: 'host_case', unit,
     expectedCursor: 0 } }));
    expect(known(await readEvents(f.journal, 0)).at(-1)?.payload.type).toBe('control_intent');
    await f.evidence('lock-suspended', { control: 'cancel', concurrentEvidence: true });
  }
  finally {
    resume();
    known(await capture);
    await f.close();
  }
});
import { vi } from 'vitest';
const nativeChecks = vi.hoisted(() => ({ active: () => false, launches: 0 }));
vi.mock('node:child_process', async (original) => {
  const native = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const checked = (fn: (...args: any[]) => any) => (...args: any[]) => {
    expect(nativeChecks.active()).toBe(false); nativeChecks.launches++; return fn(...args);
  };
  return { ...native, ...Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => {
    const fn = (native as any)[name], wrapped = checked(fn);
    // execFile's Promise API returns {stdout, stderr}, unlike callback promisification.
    if (fn[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, { value: checked(fn[promisify.custom]) });
    return [name, wrapped];
  })) };
});
import { DatabaseSync } from 'node:sqlite';
import * as cp from 'node:child_process';
import * as host from "../../dist-rewrite/host/process.js";
import { withState } from "../../dist-rewrite/records/state.js";
it('no native launch or liveness observation runs inside a real SQL transaction', async () => {
  const active = new Set<DatabaseSync>(), exec = DatabaseSync.prototype.exec;
  nativeChecks.active = () => [...active].some(db => db.isTransaction);
  const transaction = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
   const value = exec.call(this, sql); if (this.isTransaction)
    active.add(this);
  else
    active.delete(this); return value; });
  const kill = process.kill.bind(process), signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
   expect([...active].some(db => db.isTransaction)).toBe(false); return kill(pid, signal); });
  const { promisify } = await import('node:util');
  const observed = await promisify(cp.execFile)('nice', ['-n', '19', process.execPath, '-p', '1']);
  expect(observed).toMatchObject({ stdout: '1\n', stderr: '' });
  const f = await fixture();
  try {
    const receipt = await f.launch('process.stdout.write("lock-free")');
    expect(receipt.exit).toBe(0);
    const closed = known(await host.beginOperation());
    known(await host.endOperation(closed.owner));
    known(withState(f.location.database, true, db => { expect(db.isTransaction).toBe(true); return { ok: true, value: true }; }));
    expect(signals.mock.calls.length).toBeGreaterThan(0);
    expect(nativeChecks.launches).toBeGreaterThan(0);
    await f.evidence('lock-native-apis', { observed, launches: nativeChecks.launches, signals: signals.mock.calls.length,
      transactionBoundaryChecked: true });
  }
  finally {
    await f.close();
    nativeChecks.active = () => false;
    signals.mockRestore();
    transaction.mockRestore();
  }
});
