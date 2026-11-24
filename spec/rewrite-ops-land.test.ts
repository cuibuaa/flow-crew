import { beforeEach, expect, it, vi } from 'vitest';
import { land } from '../dist-rewrite/ops/land.js';
import * as host from '../dist-rewrite/host/process.js';
import * as records from '../dist-rewrite/records/state.js';
import { preserveOutputs, verifyRuntime } from '../dist-rewrite/records/content.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';

// Run the real land/reconcile decisions against declared state; no SQL, Git or native child.
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  readPreparation: vi.fn(), openJournal: vi.fn(), readProjection: vi.fn(), claim: vi.fn(), openWriter: vi.fn(),
  appendEvents: vi.fn(), release: vi.fn(), recordOperation: vi.fn(),
}));
vi.mock('../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../dist-rewrite/host/process.js')>(),
  observeRun: vi.fn(), stopRun: vi.fn(), waitForControllerExit: vi.fn(), probeOwner: vi.fn(), endOperation: vi.fn(),
}));
vi.mock('../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/content.js')>(),
  verifyRuntime: vi.fn(), preserveOutputs: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(records.readPreparation).mockReturnValue({ ok: true, value: null });
  vi.mocked(records.appendEvents).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(records.release).mockResolvedValue({ ok: true, value: 'dead' });
  vi.mocked(host.waitForControllerExit).mockResolvedValue({ ok: true, value: null } as never);
});

it.each(['', '   '])('refuses blank acceptance reason %j before opening the journal', async reason => {
  expect(await land({ database: '/synthetic/state.sqlite', storeRoot: '/synthetic/store', run: 'Run' },
    () => ({} as host.ProcessPorts), {} as host.RunContext, [{ criterionId: 'correct', reason }]))
    .toMatchObject({ ok: false, kind: 'invalid' });
  expect(records.openJournal).not.toHaveBeenCalled();
  expect(records.recordOperation).not.toHaveBeenCalled();
});

it('validates the gate settled during controller exit before any preservation or deletion', async () => {
  const reviewed = coreProjection(true);
  const older = { ...reviewed, status: 'cancelled' as const, attempts: reviewed.attempts.map(attempt => ({ ...attempt,
    answer: { kind: 'gate' as const, answer: { outcome: 'rejected_repairable' as const, reason: 'Earlier gap', findings: [], remainingWork: [],
      criteria: { correct: { status: 'fail' as const, evidence: 'Earlier failure' } } } }
  })) };
  const location = { database: '/synthetic/state.sqlite', storeRoot: '/synthetic/store', run: 'Run' };
  const journal = { database: location.database, root: '/synthetic/store/runs/Run' };
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'control' };
  vi.mocked(records.openJournal).mockResolvedValue({ ok: true, value: journal });
  vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: older });
  vi.mocked(records.claim).mockResolvedValue({ ok: true, value: { owner, unit: older.launch.unit } } as never);
  vi.mocked(records.openWriter).mockResolvedValue({ ok: true, value: { kind: 'control', journal, owner } } as never);
  vi.mocked(host.waitForControllerExit).mockImplementation(async () => {
    vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: { ...reviewed, status: 'cancelled' } });
    return { ok: true, value: null } as never;
  });
  vi.mocked(host.observeRun).mockResolvedValue({ ok: false, kind: 'unavailable', detail: 'Preservation must not begin with a stale gate' });
  expect(await land(location, () => ({} as host.ProcessPorts), {} as host.RunContext,
    [{ criterionId: 'correct', reason: 'Accept earlier failure' }])).toEqual({ ok: false, kind: 'invalid', detail: 'Latest gate passed criterion: correct' });
  expect(records.recordOperation).not.toHaveBeenCalled();
  expect(records.appendEvents).not.toHaveBeenCalled();
  expect(host.observeRun).not.toHaveBeenCalled();
});
const refusals = [
  ['unknown', 'dead', 'unknown', 'Run unit state unknown'],
  ['inactive', 'live', 'conflict', 'Run owner is live'],
  ['inactive', 'unknown', 'unknown', 'Owner closure unavailable'],
] as const;
it.each(refusals)(
  'land refuses manager=%s owner=%s before output work', async (manager, ownerState, kind, detail) => {
    const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'prior' };
    const projection = { ...coreProjection(), status: 'failed' as const, owners: [{ owner, state: 'unknown' as const }] };
    const location = { database: '/synthetic/state.sqlite', storeRoot: '/synthetic/store', run: 'Run' };
    const journal = { database: location.database, root: '/synthetic/store/runs/Run' };
    const writer = { journal, kind: 'control' as const, owner: { ...owner, authority: 'current' } };
    const observation = { unit: projection.launch.unit, state: manager, owner: null, evidence: [], detail: 'Declared manager state' };
    vi.mocked(records.openJournal).mockResolvedValue({ ok: true, value: journal });
    vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: projection });
    vi.mocked(records.claim).mockResolvedValue({ ok: true, value: {} } as never);
    vi.mocked(records.openWriter).mockResolvedValue({ ok: true, value: writer } as never);
    vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: observation });
    vi.mocked(host.stopRun).mockResolvedValue({ ok: true, value: observation });
    vi.mocked(host.probeOwner).mockResolvedValue(ownerState);
    vi.mocked(host.endOperation).mockResolvedValue({ ok: false, kind: 'unknown', detail: 'Owner closure unavailable' });
    expect(await land(location, () => ({} as host.ProcessPorts), {} as host.RunContext))
      .toEqual({ ok: false, kind, detail });
    expect(verifyRuntime).not.toHaveBeenCalled();
    expect(preserveOutputs).not.toHaveBeenCalled();
    expect(records.recordOperation).not.toHaveBeenCalled();
    expect(host.endOperation).toHaveBeenCalledTimes(manager === 'inactive' && ownerState === 'unknown' ? 1 : 0);
  });
it.each(['pending', 'running', 'parked'] as const)('land refuses a %s run and names cancel, before any observation or output work', async status => {
  const projection = { ...coreProjection(), status };
  const location = { database: '/synthetic/state.sqlite', storeRoot: '/synthetic/store', run: 'Run' };
  const journal = { database: location.database, root: '/synthetic/store/runs/Run' };
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'control'};
  vi.mocked(records.openJournal).mockResolvedValue({ ok: true, value: journal });
  vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: projection });
  vi.mocked(records.claim).mockResolvedValue({ ok: true, value: {owner,unit:projection.launch.unit} } as never);
  vi.mocked(records.openWriter).mockResolvedValue({ ok: true, value: { kind: 'control',journal,owner } } as never);
  expect(await land(location, () => ({} as host.ProcessPorts), {} as host.RunContext)).toEqual({ ok: false, kind: 'conflict',
    detail: `Run is ${status}, not finished; run flowcrew cancel Run first, then land it` });
  expect(host.observeRun).not.toHaveBeenCalled();
  expect(preserveOutputs).not.toHaveBeenCalled();
  expect(records.recordOperation).not.toHaveBeenCalled();
});

it.each(([
  ['unknown', 'Unknown frozen criterion: unknown'],
  ['correct', 'Latest gate passed criterion: correct'],
] as const).flatMap(([id, detail]) => (['cancelled', 'running'] as const).map(status => [id, detail, status] as const)))(
  'refuses acceptance of %s (%s) on a %s run before reconciliation, preservation or reclaim', async (criterionId, detail, status) => {
  const reviewed = coreProjection(true), latest = reviewed.attempts[0];
  const projection = { ...reviewed, status, attempts: [
    { ...latest, address: { ...latest.address, attempt: 'Earlier' }, answer: { kind: 'gate' as const, answer: {
      outcome: 'rejected_repairable' as const, reason: 'Earlier gap', findings: [], remainingWork: [],
      criteria: { correct: { status: 'fail' as const, evidence: 'Earlier failure' } }
    } } }, latest
  ] };
  const location = { database: '/synthetic/state.sqlite', storeRoot: '/synthetic/store', run: 'Run' };
  const journal = { database: location.database, root: '/synthetic/store/runs/Run' };
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'control' };
  vi.mocked(records.openJournal).mockResolvedValue({ ok: true, value: journal });
  vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: projection });
  vi.mocked(records.claim).mockResolvedValue({ ok: true, value: { owner, unit: projection.launch.unit } } as never);
  vi.mocked(records.openWriter).mockResolvedValue({ ok: true, value: { kind: 'control', journal, owner } } as never);
  expect(await land(location, () => ({} as host.ProcessPorts), {} as host.RunContext,
    [{ criterionId, reason: 'Human accepts the remaining gap' }])).toEqual({ ok: false, kind: 'invalid', detail });
  expect(host.observeRun).not.toHaveBeenCalled();
  expect(records.recordOperation).not.toHaveBeenCalled();
  expect(records.appendEvents).not.toHaveBeenCalled();
});
