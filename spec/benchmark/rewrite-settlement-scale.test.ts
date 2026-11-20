import { expect, it, vi } from 'vitest';
import { settlementScale } from '../native/fixtures/rewrite-settlement-scale.js';
import * as state from '../../dist-rewrite/records/state.js';

it('settles the same 54 MiB TS/Python repository without reading unused evidence twice', async () => {
  const fixture = await settlementScale();
  try {
    expect(fixture.corpus).toMatchObject({ files: 2176, bytes: 54 * 1024 ** 2 });
    const received = await fixture.receive();
    expect(received.nativeExit).toBeGreaterThan(0);
    expect(received.returned).toBeGreaterThan(received.nativeExit);
    expect(received.receipt.before).not.toBe(received.receipt.after);
    const trace = received.receipt.evidence.at(-1)!;
    const operations = vi.spyOn(state, 'recordOperation');
    const settled = await fixture.settle(received.receipt);
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw Error(settled.detail);
    expect(settled.value.receipt.ending).toBe('delivered');
    expect(settled.value.frozen.state).toBe('unchanged');
    expect(settled.value.checkpoint.tree).toBe(received.receipt.after);
    expect(settled.value.checkpoint.inputHashes).toEqual(fixture.scope.inputBaseline);
    expect(settled.value.projection.received).toEqual([received.receipt]);
    expect(settled.value.projection.checkpoints).toEqual([settled.value.checkpoint]);
    // One receipt authentication and one independent checkpoint evidence authentication.
    // The old unused read performed a third complete native stream operation.
    expect(operations.mock.calls.filter(([, , request]) => request.method === 'streamTask'
      && (request.args[1] as { path?: string }).path === trace.path)).toHaveLength(2);
    expect((await fixture.changedModule())[0]).toBe(35);
  } finally { vi.restoreAllMocks(); await fixture.f.close(); }
});
