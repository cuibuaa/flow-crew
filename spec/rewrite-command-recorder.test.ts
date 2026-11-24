import { afterEach, expect, it, vi } from 'vitest';
import { recorderFactory } from '../dist-rewrite/ops/main.js';
import { appendEvents, readEvents, readProjection, readCommandActivity, readExecutionActivity, insertAdvisoryActivity } from '../dist-rewrite/records/state.js';
import { publishRunStatus } from '../dist-rewrite/ops/status.js';
import { activityRecorder, commandActivityObserver } from '../dist-rewrite/ops/activity.js';
import { sampleActivity } from '../dist-rewrite/host/activity.js';
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(), appendEvents: vi.fn(), readEvents: vi.fn(),
  readProjection: vi.fn(), readCommandActivity: vi.fn(), readExecutionActivity: vi.fn(), insertAdvisoryActivity: vi.fn(),
}));
vi.mock('../dist-rewrite/ops/status.js', () => ({ publishRunStatus: vi.fn() }));
vi.mock('../dist-rewrite/host/activity.js', async original => ({
  ...await original<typeof import('../dist-rewrite/host/activity.js')>(), sampleActivity: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'owned' };
const writer: any = { journal: { root: '/synthetic/store/runs/Run', database: '/synthetic/state.sqlite' }, owner, epoch: 'Epoch', kind: 'execution' };
const key = { tree: 'a'.repeat(64), declaration: 'b'.repeat(64), context: 'c'.repeat(64), inputHashes: [] };
const invocation = { charge: 'command' as const, address: { kind: 'stage' as const, run: 'Run', stage: 'Stage', attempt: 'Attempt', invocation: 1 } };
const unknown = { ok: false as const, kind: 'unknown' as const, detail: 'Authored persistence failure' };
it.each(['unknown', 'throw'] as const)('advisory %s persistence is logged and leaves native facts recordable', async fault => {
  vi.mocked(readEvents).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(readProjection).mockResolvedValue({ ok: true, value: { run: 'Run' } } as any);
  vi.mocked(readExecutionActivity).mockReturnValue({ ok: true, value: undefined });
  vi.mocked(publishRunStatus).mockReturnValue({ ok: true, value: {} } as any);
  vi.mocked(appendEvents).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(insertAdvisoryActivity).mockImplementation(() => {
    if (fault === 'throw') throw Error('Authored persistence failure');
    return unknown;
  });
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() => activityRecorder(writer.journal)({ invocation, source: 'command', command: 'Wait', stage: 'Stage', state: 'current',
    lastEventAt: null, lastTool: 'wait', summary: 'command Wait', toolRunning: true, observation: 'unknown' })).not.toThrow();
  expect(log.mock.calls.flat().join('')).toContain('Authored persistence failure');
  const ports = recorderFactory()(writer);
  expect(await ports.recordProcess({ type: 'ownership', owner, state: 'dead' })).toEqual({ ok: true, value: 1 });
  expect(appendEvents).toHaveBeenCalledTimes(1);
  expect(appendEvents).toHaveBeenCalledWith(writer, 0, [{ type: 'ownership', owner, state: 'dead' }]);
});
it('rolled-back native persistence returns failure without readback or a second fence', async () => {
  vi.mocked(readEvents).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(appendEvents).mockResolvedValue(unknown);
  const ports = recorderFactory()(writer);
  expect(await ports.recordProcess({ type: 'ownership', owner, state: 'live' })).toEqual(unknown);
  expect(await ports.recordProcess({ type: 'ownership', owner, state: 'dead' })).toMatchObject({ ok: false, kind: 'unknown' });
  expect(appendEvents).toHaveBeenCalledTimes(2);
  expect(readEvents).toHaveBeenCalledTimes(2);
});
it('polls retain recorded command time through the first baseline and recovery from unknown', async () => {
  const history: any[] = [];
  vi.mocked(readCommandActivity).mockImplementation(() => ({ ok: true, value: { cursor: 0, owners: [owner], commands: [
    { identity: 'key', reservation: { key, identity: 'Wait', invocation }, execution: history.at(-1), activity: { command: 'Wait', stage: 'Stage', state: 'unknown' } }
  ] } } as any));
  vi.mocked(readExecutionActivity).mockImplementation(() => ({ ok: true, value: history.at(-1) }));
  vi.mocked(insertAdvisoryActivity).mockImplementation((_journal, activity) => {
    history.push(activity); return { ok: true, value: history.length };
  });
  vi.mocked(sampleActivity).mockResolvedValue({ stdout: 0, stderr: 0, lastEventAt: null });
  vi.mocked(readProjection).mockImplementation(async () => ({ ok: true, value: {
    brief: { declaration: { commands: [{ id: 'Wait', argv: ['wait'] }] } }, activity: history.slice(-1)
  } } as any));
  const observe = commandActivityObserver(writer);
  await expect(observe(1000)).resolves.toBeDefined();
  expect(history.at(-1)).toMatchObject({ lastEventAt: null, observation: 'observing' });
  const at = '2001-01-01T00:00:00.000Z';
  vi.mocked(sampleActivity).mockResolvedValue({ stdout: 7, stderr: 0, lastEventAt: at });
  await observe(2000);
  expect(history.at(-1)).toMatchObject({ lastEventAt: at, observation: 'progress' });
  vi.mocked(sampleActivity).mockResolvedValueOnce(null);
  await observe(3000);
  expect(history.at(-1)).toMatchObject({ lastEventAt: at, observation: 'unknown' });
  await observe(4000);
  expect(history.at(-1)).toMatchObject({ lastEventAt: at, observation: 'observing' });
  expect(appendEvents).not.toHaveBeenCalled();
});
it('closing native process facts retain their serialization independently of activity', async () => {
  const events: any[] = [];
  vi.mocked(readEvents).mockImplementation(async () => ({ ok: true, value: [...events] }));
  vi.mocked(readProjection).mockResolvedValue({ ok: true, value: { run: 'Run' } } as any);
  vi.mocked(publishRunStatus).mockReturnValue({ ok: true, value: {} } as any);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(appendEvents).mockImplementation(async (_writer, cursor, payloads) => {
    if (payloads[0].type === 'ownership') await held;
    expect(cursor).toBe(events.length);
    for (const payload of payloads) events.push({ seq: events.length + 1, payload });
    return { ok: true, value: events.length };
  });
  const ports = recorderFactory()(writer);
  const closed = ports.recordProcess({ type: 'ownership', owner, state: 'dead' });
  const processReceipt = ports.recordProcess({ type: 'process', receipt: {} as any });
  release();
  expect(await Promise.all([closed, processReceipt])).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }]);
  expect(events.map(event => event.payload.type)).toEqual(['ownership', 'process']);
});
