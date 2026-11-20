import { beforeEach, expect, it, vi } from 'vitest';
import { land } from '../dist-rewrite/ops/land.js';
import * as host from '../dist-rewrite/host/process.js';
import * as records from '../dist-rewrite/records/state.js';
import { preserveOutputs, verifyRuntime } from '../dist-rewrite/records/content.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';

// Run the real land/reconcile decisions against declared state; no SQL, Git or native child.
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  openJournal: vi.fn(), readProjection: vi.fn(), claim: vi.fn(), openWriter: vi.fn(),
  appendEvents: vi.fn(), release: vi.fn(), recordOperation: vi.fn(),
}));
vi.mock('../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../dist-rewrite/host/process.js')>(),
  observeRun: vi.fn(), stopRun: vi.fn(), probeOwner: vi.fn(), endOperation: vi.fn(),
}));
vi.mock('../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/content.js')>(),
  verifyRuntime: vi.fn(), preserveOutputs: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(records.appendEvents).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(records.release).mockResolvedValue({ ok: true, value: 'dead' });
});
const refusals = [
  ['active', 'dead', 'conflict', 'Run unit is active'],
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
  vi.mocked(records.openJournal).mockResolvedValue({ ok: true, value: { database: location.database, root: '/synthetic/store/runs/Run' } });
  vi.mocked(records.readProjection).mockResolvedValue({ ok: true, value: projection });
  vi.mocked(records.claim).mockResolvedValue({ ok: true, value: {} } as never);
  vi.mocked(records.openWriter).mockResolvedValue({ ok: true, value: { kind: 'control' } } as never);
  expect(await land(location, () => ({} as host.ProcessPorts), {} as host.RunContext)).toEqual({ ok: false, kind: 'conflict',
    detail: `Run is ${status}, not finished; run flowcrew cancel Run first, then land it` });
  expect(host.observeRun).not.toHaveBeenCalled();
  expect(preserveOutputs).not.toHaveBeenCalled();
  expect(records.recordOperation).not.toHaveBeenCalled();
});
