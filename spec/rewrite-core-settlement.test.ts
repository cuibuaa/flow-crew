import './fixtures/rewrite-core-sql.js'; // Register authored effects before importing production consumers.
// Register authored effects before loading the real workflow/settlement modules.
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { StageAnswer } from '../dist-rewrite/contract/answers.js';
import type { AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';
import { settle } from '../dist-rewrite/core/settlement.js';
import { putEvidence,readEvents } from '../dist-rewrite/records/state.js';
import { stateFixture,type StateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { workflowFixture } from './fixtures/rewrite-workflow.js';
let f: StateFixture;
beforeEach(async () => { f = await stateFixture(); await f.admit(); });
afterEach(async () => { await f.close(); });
async function answerReceipt(receipt: AttemptReceipt, answer: StageAnswer) {
  return { ...receipt, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) };
}
async function resetFixture(patch: Parameters<typeof stateFixture>[0] = {}, graph?: Parameters<typeof stateFixture>[1]) {
  await f.close(); f = await stateFixture(patch, graph); await f.admit();
}
const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role: 'author', purpose, after,
 instruction: 'Finite declared obligation', skills: [], ...(purpose === 'gate' ? { commands: [] } : {}) });
it('settles mixed technical, invalid, work and command-result failures once before parking', async () => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  const endings = ['technical_failure', 'invalid_answer', 'work_failed', 'invalid_plan'] as const;
  ports.attempt = async (request) => { const receipt = get(await native(request)); return { ok: true, value: { ...receipt,
   ending: endings[seen.length - 1], answer: undefined, answerRef: undefined } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'parked', reason: 'backstop' });
  expect(seen).toHaveLength(4);
  expect((await f.projection()).backstop.failureSuffix).toBe(4);
  const facts = get(await readEvents(f.journal, 0));
  expect(facts.flatMap(e => e.payload.type === 'outcome_settled' ? [e.payload.backstop.failureSuffix] : [])).toEqual([1, 2, 3, 4]);
  const last = (await f.projection()).attempts.at(-1)!;
  expect(await settle(await f.projection(), last, f.execution, f.scope)).toMatchObject({ ok: false, kind: 'conflict' });
  expect((await f.projection()).backstop.failureSuffix).toBe(4);
});
it('F(w),S(w) on one admitted obligation parks at failure event 9 despite usable repeated work', async () => {
  const gate = { ...stage('gate', 'gate', ['work']), purpose: 'gate' as const, commands: [], repair: { stage: 'work', returnsTo: 'gate' } };
  await resetFixture({ criteria: Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, text: 'Fixed criterion' })) }, {
   stages: [stage('work'), gate] });
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let work = 0, gates = 0;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.id === 'work' && ++work % 2 === 1)
      return { ok: true, value: { ...r, ending: 'work_failed', answer: undefined, answerRef: undefined } };
    if (request.stage.purpose === 'gate') {
      const count = gates++;
      return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
       reason: 'Independent finite-map rejection', criteria: Object.fromEntries(f.brief.declaration.criteria.map((c, i) => [c.id, {
       status: i < count ? 'pass' : 'fail', evidence: 'Actual criterion judgment' }])), findings: [], remainingWork: ['Repair'] } }) };
    }
    return { ok: true, value: r };
  };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const states = get(await readEvents(f.journal, 0)).flatMap(e => e.payload.type === 'outcome_settled' &&
   e.payload.address.stage === 'work' ? [e.payload.backstop.failureSuffix] : []);
  expect(states).toEqual([1, 0, 1, 1, 2, 2, 3, 3, 4]);
  expect(seen.filter(r => r.stage.id === 'work')).toHaveLength(9);
  expect((await f.projection()).status).toBe('parked');
});
it.each([['b', 'a']])('first completions clear failures in dependency-permitted order %j', async (first, second) => {
  await resetFixture({}, { stages: [stage(first), stage(second), { ...stage('gate', 'gate', [first, second]), purpose: 'gate', commands: [] }] });
  const { ports } = workflowFixture(f), native = ports.attempt;
  const failed = new Set<string>();
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose === 'work' &&
   !failed.has(request.stage.id)) {
    failed.add(request.stage.id);
    return { ok: true, value: { ...r, ending: 'technical_failure', answer: undefined, answerRef: undefined } };
  } return { ok: true, value: r }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect(get(await readEvents(f.journal, 0)).flatMap(e => e.payload.type === 'outcome_settled' &&
   e.payload.address.stage !== 'gate' ? [e.payload.backstop.failureSuffix] : [])).toEqual([1, 0, 1, 0]);
});
it('one failed attempt with an admitted rejection updates both suffixes exactly once', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; const next = await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
     reason: 'Failed but fully assessed', criteria: { correct: { status: 'fail', evidence: 'Independent rejection retained' } }, findings: [],
     remainingWork: ['Repair'] } }); return { ok: true, value: { ...next, ending: 'technical_failure' } }; };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const states = get(await readEvents(f.journal, 0)).flatMap(e => e.payload.type === 'outcome_settled' &&
   e.payload.address.stage === 'gate' ? [[e.payload.backstop.gateSuffix, e.payload.backstop.failureSuffix]] : []);
  expect(states).toEqual([[1, 1], [2, 2], [3, 3]]);
});
it('a real pass clears both suffixes and the high-water sequence; a lower later rejection seeds one', async () => {
  const progress = { ...stage('progress', 'gate', ['work']), purpose: 'gate' as const, commands: [], repair: { stage: 'work',
   returnsTo: 'progress' } }, gate = { ...stage('gate', 'gate', ['progress']), purpose: 'gate' as const, commands: [], repair: {
   stage: 'repair', returnsTo: 'gate' } };
  await resetFixture({ criteria: [0, 1, 2].map(i => ({ id: 'c' + i, text: 'Fixed criterion' })) }, { stages: [stage('work'), progress,
   gate, stage('repair')] });
  const { ports } = workflowFixture(f), native = ports.attempt;
  let progressVisits = 0, workVisits = 0;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.id === 'work' && ++workVisits === 2)
      return { ok: true, value: { ...r, ending: 'technical_failure', answer: undefined, answerRef: undefined } };
    if (request.stage.purpose === 'gate') {
      const accepted = request.stage.id === 'progress' && ++progressVisits > 1, count = accepted ? 3 : request.stage.id === 'progress' ? 2 : 0;
      return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: {
       outcome: accepted ? 'accepted' : 'rejected_repairable', reason: 'Full-map independent result',
       criteria: Object.fromEntries(f.brief.declaration.criteria.map((c, i) => [c.id, { status: i < count ? 'pass' : 'fail',
       evidence: 'Current criterion' }])), findings: [], remainingWork: [] } }) };
    }
    return { ok: true, value: r };
  };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const events = get(await readEvents(f.journal, 0)),
   outcomes = events.flatMap(e => e.payload.type === 'outcome_settled' ? [e.payload] : []), gates = outcomes.filter(e => ['progress',
   'gate'].includes(e.address.stage));
  expect(gates.map(e => e.backstop.gateSuffix)).toEqual([1, 0, 1, 2, 3]);
  expect(gates.map(e => e.backstop.bestPassCount)).toEqual([2, null, 0, 0, 0]);
  expect(outcomes[outcomes.indexOf(gates[1]) - 1].backstop.failureSuffix).toBe(1);
  expect(gates[1].backstop.failureSuffix).toBe(0);
});
it('equal counts on different passing predicates do not union into progress', async () => {
  await resetFixture({ criteria: [0, 1, 2].map(i => ({ id: 'c' + i, text: 'Fixed criterion' })) });
  const { ports } = workflowFixture(f), native = ports.attempt;
  let n = 0;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; const failed = n++ % 3; return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: {
     outcome: 'rejected_repairable', reason: 'Rotating pass identities', criteria: Object.fromEntries(f.brief.declaration.criteria.map((c,
     i) => [c.id, { status: i === failed ? 'fail' : 'pass', evidence: 'Independent current evidence' }])), findings: [],
     remainingWork: ['Repair'] } }) }; };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  expect((await f.projection()).backstop).toMatchObject({ gateSuffix: 3, bestPassCount: 2 });
});
it('an unresolved criterion map parks without inventing a zero score or clearing known state', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: {
     outcome: 'rejected_repairable', reason: 'Unresolvable map', criteria: {}, findings: [], remainingWork: [] } }) }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'parked', reason: 'recovery_unknown' });
  expect((await f.projection()).backstop).toMatchObject({ gateSuffix: 0, bestPassCount: null });
});
it.each(['delivered', 'technical_failure'] as const)('terminal gate refusal takes precedence at the C2 threshold with %s',
 async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let n = 0;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; const receipt = await answerReceipt(r, { kind: 'gate', answer: {
     outcome: ++n === 3 ? 'rejected_irreparable' : 'rejected_repairable', reason: 'Independent refusal', criteria: { correct: { status: 'fail',
     evidence: 'Failed authored predicate' } }, findings: [], remainingWork: [] } }); return { ok: true, value: { ...receipt,
     ending: n === 3 ? ending : 'delivered' } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'failed', reason: 'gate_irreparable' });
  expect((await f.projection()).backstop.gateSuffix).toBe(3);
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(3);
  expect(get(await readEvents(f.journal, 0)).some(e => e.payload.type === 'lifecycle' && e.payload.conclusion.reason === 'backstop')).toBe(false);
});
