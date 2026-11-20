import './fixtures/rewrite-core-sql.js'; // Register authored effects before importing production consumers.
import { afterEach, expect, it } from 'vitest';
import type { Brief } from '../dist-rewrite/contract/brief.js';
import type { Plan } from '../dist-rewrite/contract/plan.js';
import { admitLaunch } from '../dist-rewrite/core/admission.js';
import { readEvents } from '../dist-rewrite/records/state.js';
import { stateFixture, type StateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { evidenceBytes } from './fixtures/rewrite-bytes.js';

let f: StateFixture;
afterEach(async () => { await f.close(); });
const commands = ['Verify', 'Optional'].map(id => ({ id, argv: [process.execPath, '-e', ''], env: {}, inputs: [], required: id === 'Verify' }));
/** A prepared, not yet admitted run: the launch carries no plan, so admission alone chooses the initial graph. */
async function prepared(patch: Partial<Brief> = {}) {
  f = await stateFixture({ commands, ...patch }, 'bootstrap');
  // The fixture's brief locator is a fixed name; publish the authored bytes there so admission can read and authenticate them.
  evidenceBytes().set(f.launch.brief.bytes.path, evidenceBytes().get('authored/' + f.launch.brief.bytes.sha256)!);
  const request = { project: f.launch.setup.project, target: f.project, brief: f.brief, runtime: f.runtime };
  const baselines = { inputs: [], outputs: [] };
  get(await import('../dist-rewrite/records/state.js').then(state => state.appendEvents(f.control, 0, [
    { type: 'run_authority', authority: f.scope.authority } as never,
    { type: 'setup_prepared', request, unit: f.launch.unit, baselines, measured: null },
    { type: 'setup_prepared', request, unit: f.launch.unit, baselines, measured: f.launch.setup }])));
  const [author] = f.launch.roles, launch = { ...f.launch, roles: [author, { ...author, id: 'work' }, { ...author, id: 'gate' }] };
  const admit = (given = launch, planner = 'author') => admitLaunch(given, planner, f.control,
    { ...f.scope, inputBaseline: [], outputBaseline: [] } as never);
  return { admit, launch };
}
const committed = async () => get(await readEvents(f.journal, 0)).flatMap(event => event.payload.type === 'plan_committed' ? [event.payload.plan.plan] : []);

it('admits the fixed work/gate/repair graph when the brief does not declare decomposition', async () => {
  const { admit } = await prepared();
  const projection = get(await admit());
  expect(projection.plan.plan.stages.map(stage => [stage.id, stage.purpose, stage.role])).toEqual([
    ['work', 'work', 'work'], ['gate', 'gate', 'gate'], ['repair', 'work', 'work']]);
  expect(projection.plan.plan.stages.find(stage => stage.purpose === 'gate')).toMatchObject({ commands: ['Verify'] });
  expect(projection.plan.plan.stages.some(stage => stage.purpose === 'plan')).toBe(false);
  expect(await committed()).toHaveLength(1);
});

it('admits one planner stage under the explicit planner role when the brief declares decomposition', async () => {
  const { admit } = await prepared({ decompose: true });
  const projection = get(await admit(undefined, 'author'));
  expect(projection.plan.plan.stages).toEqual([expect.objectContaining({ purpose: 'plan', role: 'author', after: [] })]);
});

it('admits an operator plan in Launch.plan whatever the brief declares', async () => {
  for (const decompose of [false, true]) {
    const { admit, launch } = await prepared({ decompose });
    const plan: Plan = { stages: [{ id: 'only', role: 'author', purpose: 'work', after: [], instruction: 'Do it' },
      { id: 'review', role: 'author', purpose: 'gate', after: ['only'], commands: [] }] };
    const projection = get(await admit({ ...launch, plan }));
    expect(projection.plan.plan.stages.map(stage => stage.id)).toEqual(['only', 'review']);
    await f.close();
  }
  f = await stateFixture();
});

it('refuses the fixed graph naming the missing role id and commits nothing', async () => {
  for (const missing of ['work', 'gate']) {
    const { admit, launch } = await prepared();
    const refused = await admit({ ...launch, roles: launch.roles.filter(role => role.id !== missing) });
    expect(refused).toMatchObject({ ok: false, kind: 'invalid', detail: expect.stringContaining(`Unknown role id ${missing};`) });
    expect(get(await readEvents(f.journal, 0)).some(event => event.payload.type === 'admitted')).toBe(false);
    await f.close();
  }
  f = await stateFixture();
});

it('does not need the work and gate roles when the brief declares decomposition', async () => {
  const { admit, launch } = await prepared({ decompose: true });
  expect((await admit({ ...launch, roles: launch.roles.filter(role => role.id === 'author') })).ok).toBe(true);
});
