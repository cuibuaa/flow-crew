import './fixtures/rewrite-core-sql.js'; // Register authored effects before importing production consumers.
import { mkdirSync, mkdtempSync, realpathSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseLaunch } from '../dist-rewrite/contract/runtime.js';
import { parsePlan } from '../dist-rewrite/contract/plan.js';
import { ignoreRetired } from '../dist-rewrite/contract/retirement.mjs';
import { runWorkflow } from '../dist-rewrite/core/loop.js';
import { appendEvents, openJournal, putEvidence, readEvents, readProjection, withState } from '../dist-rewrite/records/state.js';
import { publishRunStatus } from '../dist-rewrite/ops/status.js';
import { currentStatus } from '../dist-rewrite/contract/status.mjs';
import { validStatus } from '../rewrite-src/contract/status.mjs';
import { stateFixture, type StateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { workflowFixture } from './fixtures/rewrite-workflow.js';
import { summary } from '../dist-monitor/rewrite-monitor/view.js';

const OLD = 'Historical planner-written review text';
let f: StateFixture;
afterEach(async () => { await f.close(); });
/** Emulate bytes written before gates lost their instruction: appending today refuses the key, so edit the stored rows. */
function writeOldBytes() {
  const inject = (plan: any) => { for (const stage of plan.stages) if (stage.purpose === 'gate') stage.instruction = OLD; return plan; };
  get(withState(f.database, true, db => {
    for (const row of db.prepare("SELECT key,value FROM current_rows WHERE root=? AND kind='revision'").all(f.journal.root)) {
      const value = JSON.parse(String(row.value)); inject(value.plan);
      db.prepare("UPDATE current_rows SET value=? WHERE root=? AND kind='revision' AND key=?").run(JSON.stringify(value), f.journal.root, row.key);
    }
    const current = JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current));
    inject(current.plan.plan); inject(current.launch.plan);
    // The old writer copied every plan stage into the stored timeline (`projectTimeline` at 3fbac06a).
    for (const row of current.timeline.stages) inject({ stages: [row.definition] });
    db.prepare('UPDATE runs SET current=? WHERE root=?').run(JSON.stringify(current), f.journal.root);
    for (const row of db.prepare('SELECT seq,payload FROM events WHERE root=?').all(f.journal.root)) {
      const payload = JSON.parse(String(row.payload));
      if (payload.type === 'admitted') inject(payload.launch.plan);
      if (payload.type === 'plan_committed') inject(payload.plan.plan);
      db.prepare('UPDATE events SET payload=? WHERE root=? AND seq=?').run(JSON.stringify(payload), f.journal.root, row.seq);
    }
    return { ok: true, value: true };
  }));
  const raw = get(withState(f.database, false, db => ({ ok: true, value: db.prepare('SELECT payload FROM events WHERE root=?').all(f.journal.root)
    .map(row => String(row.payload)).join('') })));
  expect(raw).toContain(OLD);
}

it('loads old admitted and plan_committed payloads and projection rows with the gate instruction retired', async () => {
  f = await stateFixture(); await f.admit();
  writeOldBytes();
  const events = get(await readEvents(f.journal, 0)).map(event => event.payload);
  const admitted = events.find(payload => payload.type === 'admitted')!, plan = events.find(payload => payload.type === 'plan_committed')!;
  expect(JSON.stringify(events)).not.toContain(OLD);
  expect(parseLaunch((admitted as any).launch).ok).toBe(true);
  const projection = get(await readProjection(f.journal));
  for (const gates of [projection.plan.plan, projection.launch.plan!, projection.revisions[0].plan, (plan as any).plan.plan])
    for (const stage of gates.stages.filter((stage: any) => stage.purpose === 'gate')) expect(Object.hasOwn(stage, 'instruction')).toBe(false);
  for (const row of projection.timeline!.stages.filter(row => row.definition.purpose === 'gate')) expect(Object.hasOwn(row.definition, 'instruction')).toBe(false);
  expect(projection.plan.plan.stages.find(stage => stage.purpose === 'work')).toHaveProperty('instruction');
});

it('never hands an old gate instruction to model input: the stage and plan given to the attempt port carry none', async () => {
  f = await stateFixture(); await f.admit();
  writeOldBytes();
  const { ports, seen } = workflowFixture(f);
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const gate = seen.find(request => request.stage.purpose === 'gate')!;
  expect(gate).toBeDefined();
  expect(Object.hasOwn(gate.stage, 'instruction')).toBe(false);
  // `composeInput` serialises request.stage, request.plan and the evidence it is given; none of them may hold the old text.
  expect(JSON.stringify(seen.map(request => ({ stage: request.stage, plan: request.plan, brief: request.brief })))).not.toContain(OLD);
});

/** A journal the 3fbac06a engine wrote itself (public-CLI scenario `matrix-dead-settlement-plan`, one replaced plan revision), with the status it published. */
const OLD_JOURNAL = new URL('./fixtures/old-journal/', import.meta.url);
let scratch = '';
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = ''; });
async function openOldJournal(landed = false) {
  const old = JSON.parse(readFileSync(new URL('old-status.json', OLD_JOURNAL), 'utf8'));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'old-journal-')));
  const database = join(scratch, 'state.sqlite');
  copyFileSync(new URL(landed ? 'landed.sqlite' : 'state.sqlite', OLD_JOURNAL), database);
  mkdirSync(join(scratch, 'runs', old.run), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec('PRAGMA foreign_keys=OFF');
  try { // The journal is keyed by its absolute root; move it to this directory.
    const from = String((db.prepare('SELECT root FROM runs').get() as { root: string }).root), to = join(scratch, 'runs', old.run);
    for (const table of ['events', 'current_rows', 'epochs', 'advisory_activity']) db.prepare(`UPDATE ${table} SET root=? WHERE root=?`).run(to, from);
    db.prepare('UPDATE runs SET root=?, store=? WHERE root=?').run(to, scratch, from);
  } finally { db.close(); }
  const location = { storeRoot: scratch, run: old.run, database };
  return { old, location, journal: get(await openJournal(location, 'read')) };
}
const shape = (row: any) => ({ id: row.id, purpose: row.purpose, role: row.role, state: row.state, revision: row.revision, replacedBy: row.replacedBy });

it.each([false,true])('historical journal (landed=%s; landed writer uses main state.ts with branch modules) retains status and stages without obsolete gate instructions', async landed => {
  const { old, location, journal } = await openOldJournal(landed);
  const oldGate = old.stages.find((row: any) => row.purpose === 'gate').instruction as string;
  const raw = new DatabaseSync(location.database);
  const bytes = [...raw.prepare('SELECT payload AS v FROM events').all(), ...raw.prepare('SELECT current AS v FROM runs').all(),
    ...raw.prepare('SELECT value AS v FROM current_rows').all()].map(row => String(row.v)).join('');
  raw.close();
  expect(bytes, 'the fixture really holds the old gate instruction').toContain(oldGate);
  expect(old.stages.filter((row: any) => row.purpose === 'gate').length, 'a current and a replaced gate row').toBeGreaterThan(1);

  const events = get(await readEvents(journal, 0));
  const projection = get(await readProjection(journal));
  expect(JSON.stringify([events, projection])).not.toContain(oldGate);
  expect(projection.timeline!.stages.some(row => row.definition.purpose === 'gate')).toBe(true);

  const published = get(publishRunStatus(location, '2030-01-01T00:00:00.000Z', 0)), status = currentStatus(published);
  // landed.sqlite: main 2f2a2a7d state.ts plus this branch's other modules; run_reclaimed predates heldSpace/reclaimCompleted.
  if(landed){expect(published.reclaimed).toEqual({at:'2030-01-01T00:00:00.000Z',delivery:'/fixture/deliveries/landed'});
    expect(published.heldBytes).toBeUndefined();expect(published.heldSpacePending).toBeUndefined();expect(events.some(e=>e.payload.type==='reclaim_completed')).toBe(false);
    expect(summary([published],Date.parse(published.publishedAt))).not.toContain('data-held');}
  else { expect(published.heldSpacePending).toBe(true); expect(summary([published], Date.parse(published.publishedAt))).toContain('incomplete'); }
  expect(validStatus(status)).toBe(true);
  expect(JSON.stringify([published, status])).not.toContain(oldGate);
  // The old engine's own published file is compared with the file published now; `currentStatus` only restates it for a reader.
  expect(published.stages!.map(shape)).toEqual(old.stages.map(shape));
  for (const [row, was] of published.stages!.map((row, index) => [row, old.stages[index]] as const)) {
    if (row.purpose === 'gate') { expect(row).not.toHaveProperty('goal'); expect(row).not.toHaveProperty('instruction'); }
    else expect(row).toMatchObject({ goal: was.goal, instruction: was.instruction });
  }
  // Only a gate may omit them: a work row without either field is not a valid status.
  for (const field of ['goal', 'instruction']) {
    const broken = structuredClone(status);
    delete (broken.stages!.find(stage => stage.purpose === 'work') as any)[field];
    expect(validStatus(broken), field).toBe(false);
  }
});

it('retires the key only from recorded plans: new input still refuses it and the writer refuses it', async () => {
  f = await stateFixture();
  const old = { stages: [{ id: 'g', role: 'author', purpose: 'gate', after: [], commands: [], instruction: OLD }] };
  expect(parsePlan(old, { roleIds: ['author'], commandIds: [], checkpointIds: [] }).ok).toBe(false);
  expect(parseLaunch({ ...f.launch, plan: old }).ok).toBe(false);
  expect(ignoreRetired({ plan: old }, 'launch').plan.stages[0]).not.toHaveProperty('instruction');
  expect(ignoreRetired({ ...old, stages: [{ ...old.stages[0], purpose: 'work', instruction: OLD }] }, 'recordedPlan').stages[0].instruction).toBe(OLD);
  await f.admit();
  const refused = await appendEvents(f.control, (await f.projection()).cursor, [{ type: 'plan_committed', plan: { revision: 'New', digest: 'e'.repeat(64),
    executed: [], plan: { stages: [f.plan.stages[0], { ...f.plan.stages[1], instruction: OLD }, f.plan.stages[2]] } } } as never]);
  expect(refused.ok).toBe(false);
});

/** A receipt that carries a planner answer, so the write path sees the same plan shape a recorded receipt holds. */
async function planReceipt(plan: unknown) {
  const address = { run: 'Run', stage: 'work', attempt: 'Planned', invocation: 1 }, before = await f.tree();
  const answer = { kind: 'plan', answer: { baseRevision: 'Base', plan } };
  return { address, before, after: before, ending: 'delivered', closure: 'unknown', audit: f.ref, evidence: [], usage: { state: 'unknown', raw: [] }, inputChars: 1,
    answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) };
}

it('retires the key only when reading: a new attempt receipt whose plan answer holds a gate instruction is refused, not stripped', async () => {
  f = await stateFixture(); await f.admit();
  const clean = { stages: [f.plan.stages[0], f.plan.stages[1]] }, dirty = { stages: [f.plan.stages[0], { ...f.plan.stages[1], instruction: OLD }] };
  const reserve = { type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', run: 'Run', stage: 'work', attempt: 'Planned', invocation: 1 } } };
  const cursor = async () => (await f.projection()).cursor;
  for (const type of ['attempt_received', 'attempt_settled']) {
    const refused = await appendEvents(f.execution, await cursor(), [reserve, { type, receipt: await planReceipt(dirty) }] as never);
    expect(refused, type).toMatchObject({ ok: false, kind: 'invalid' });
    expect(JSON.stringify(get(await readEvents(f.journal, 0)))).not.toContain(OLD);
  }
  // The same receipt without the key is accepted, so the refusal above is the key and nothing else.
  const accepted = await appendEvents(f.execution, await cursor(), [reserve, { type: 'attempt_received', receipt: await planReceipt(clean) }] as never);
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
});

it('hands no gate instruction to model input from an old journal: receipts, intents and operations are retired where model input reads them', async () => {
  const { old, location, journal } = await openOldJournal();
  const oldGate = old.stages.find((row: any) => row.purpose === 'gate').instruction as string;
  const raw = new DatabaseSync(location.database);
  const held = (kind: string) => raw.prepare("SELECT count(*) AS n FROM current_rows WHERE kind=? AND instr(value,?)>0").get(kind, oldGate)!.n as number;
  // The fixture really holds the text in each record kind the checks below name; otherwise they would prove nothing.
  const kinds = { receipt: 'received', attempt: 'attempt', intent: 'intent', operation: 'operation' } as const;
  for (const [name, kind] of Object.entries(kinds)) expect(held(kind), `the old journal's ${name} rows hold the gate text`).toBeGreaterThan(0);
  const events = new Set(raw.prepare('SELECT payload FROM events').all().filter(row => String(row.payload).includes(oldGate))
    .map(row => JSON.parse(String(row.payload)).type));
  raw.close();
  for (const type of ['attempt_received', 'attempt_settled', 'control_intent', 'control_settled']) expect(events.has(type), type).toBe(true);

  // `composeInput` serialises the projection's command history, the correction's prior attempt, the guides and the plan; each collection it reads is checked.
  const projection = get(await readProjection(journal));
  const modelInput = { plan: projection.plan, revisions: projection.revisions, timeline: projection.timeline, commands: projection.commands, lineage: projection.lineage,
    received: projection.received, attempts: projection.attempts, intents: projection.intents, operations: projection.operations,
    guideDeliveries: projection.guideDeliveries };
  for (const [name, value] of Object.entries(modelInput)) expect(JSON.stringify(value), name).not.toContain(oldGate);
  for (const name of ['received', 'attempts', 'intents', 'operations'] as const) expect(modelInput[name].length, name).toBeGreaterThan(0);
  expect(JSON.stringify(get(await readEvents(journal, 0)).filter(event => ['attempt_received', 'attempt_settled', 'control_intent', 'control_settled']
    .includes(event.payload.type)))).not.toContain(oldGate);
});
