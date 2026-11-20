import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendEvents, readEvents, readProjection } from "../../dist-rewrite/records/state.js";
import type { JournalPayload } from "../../dist-rewrite/contract/runtime.js";
import { get, stateFixture, type StateFixture } from "../fixtures/rewrite-state.js";
let f: StateFixture;
beforeEach(async () => { f = await stateFixture(); });
afterEach(async () => { await f.close(); });
it.each(['target', 'brief', 'unit', 'inputs'] as const)('retains the specific admission/setup refusal on changed %s facts',
 async (field) => {
  const { launch, ref } = f, request = { project: launch.setup.project, target: launch.project, brief: launch.brief, runtime: launch.runtime };
  await f.append(f.control, [{ type: 'setup_prepared', request, unit: launch.unit, baselines: { inputs: [], outputs: [], tree: launch.setup.tree },
   measured: null }, { type: 'setup_prepared', request, unit: launch.unit, baselines: { inputs: [], outputs: [], tree: launch.setup.tree }, measured: launch.setup }]);
  let changed = structuredClone(launch);
  if (field === 'target')
    changed = { ...changed, project: launch.project + '/other', setup: { ...launch.setup, target: launch.project + '/other' } };
  if (field === 'brief')
    changed = { ...changed, brief: { ...changed.brief, digest: 'b'.repeat(64), bytes: { ...changed.brief.bytes,
     sha256: 'b'.repeat(64) } }, setup: { ...changed.setup, brief: 'b'.repeat(64) } };
  if (field === 'unit')
    changed = { ...changed, unit: { ...changed.unit, authority: 'other-activation' } };
  if (field === 'inputs')
    changed = { ...changed, setup: { ...changed.setup, inputs: [ref] } };
  expect(await appendEvents(f.control, 2, [{ type: 'admitted', launch: changed }])).toMatchObject({ ok: false, kind: 'invalid',
   detail: 'Admission does not match setup' });
  expect(get(await readEvents(f.journal, 0))).toHaveLength(2);
  expect(await readProjection(f.journal)).toMatchObject({ ok: false, kind: 'unavailable' });
});
it.each(['missing-initial', 'repeat-initial', 'changed-original', 'changed-request', 'changed-measurement',
 'changed-base-tree', 'repeat-completed'] as const)('refuses invalid setup transition %s atomically', async (field) => {
  const { launch, ref } = f, request = { project: launch.setup.project, target: launch.project, brief: launch.brief, runtime: launch.runtime };
  const original = { type: 'setup_prepared' as const, request, unit: launch.unit, baselines: { inputs: [], outputs: [], tree: launch.setup.tree }, measured: null };
  if (field !== 'missing-initial')
    await f.append(f.control, [original]);
  const completed = { ...original, measured: launch.setup };
  if (field === 'repeat-completed')
    await f.append(f.control, [completed]);
  let fact: unknown = completed;
  if (field === 'repeat-initial')
    fact = original;
  if (field === 'changed-original')
    fact = { ...completed, baselines: { inputs: [ref], outputs: [], tree: launch.setup.tree }, measured: { ...launch.setup, inputs: [ref] } };
  if (field === 'changed-request')
    fact = { ...completed, request: { ...request, target: request.target + '/changed' } };
  if (field === 'changed-measurement')
    fact = { ...completed, measured: { ...launch.setup, brief: 'a'.repeat(64) } };
  if (field === 'changed-base-tree')
    fact = { ...completed, measured: { ...launch.setup, tree: 'a'.repeat(64) } };
  const before = get(await readEvents(f.journal, 0));
  expect((await appendEvents(f.control, before.length, [fact as JournalPayload])).ok).toBe(false);
  expect(get(await readEvents(f.journal, 0))).toEqual(before);
});
it.each(['undefined-stage', 'missing-checkpoint', 'duplicate-plan', 'invalid-conclusion', 'missing-attempt',
 'missing-reservation'] as const)('rolls back rejected %s and its preceding current-row changes', async (kind) => {
  await f.admit();
  const before = await f.projection();
  const bad: Record<typeof kind, unknown> = {
    'undefined-stage': { type: 'stage_settled', stage: 'absent', state: 'settled', evidence: [] },
    'missing-checkpoint': { type: 'checkpoint_materialized', checkpoint: 'absent' },
    'duplicate-plan': { type: 'plan_committed', plan: before.plan },
    'invalid-conclusion': { type: 'lifecycle', conclusion: { status: 'complete', reason: 'cancelled', detail: '' } },
    'missing-attempt': { type: 'gate_transition', stage: 'gate', attempt: 'absent', outcome: 'accepted', next: null, evidence: [] },
    'missing-reservation': { type: 'command_reserved', reservation: { identity: 'Check', key: { tree: 'a'.repeat(64),
     declaration: 'a'.repeat(64), context: 'a'.repeat(64), inputHashes: [] }, state: 'reserved', invocation: { charge: 'command', address: {
     kind: 'final', run: 'Run' } } } }
  };
  expect((await appendEvents(f.execution, before.cursor, [{ type: 'outputs_preserved', receipt: { preserved: false, artifacts: [],
   detail: 'roll back' } }, bad[kind] as JournalPayload])).ok).toBe(false);
  expect(await f.projection()).toEqual(before);
});
it('reopens persisted state without replaying events or losing original and measured setup facts', async () => {
  await f.admit();
  const p = await f.projection();
  const events = get(await readEvents(f.journal, 0));
  expect(events.slice(0, 3).map(e => e.payload.type)).toEqual(['run_authority', 'setup_prepared', 'setup_prepared']);
  expect(await f.projection()).toEqual(p);
  expect(p.launch.setup).toEqual(f.launch.setup);
});
