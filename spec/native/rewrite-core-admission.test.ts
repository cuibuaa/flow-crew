import { f, answerReceipt, resetFixture, stage, repairGraph } from './fixtures/rewrite-core.js';
import { initialBackstop } from '../../dist-rewrite/contract/runtime.js';
import { expect, it } from 'vitest';
import type { StageAnswer } from '../../dist-rewrite/contract/answers.js';
import type { AttemptReceipt } from '../../dist-rewrite/contract/runtime.js';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { settle } from '../../dist-rewrite/core/settlement.js';
import { putEvidence, readEvents, withState } from '../../dist-rewrite/records/state.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';

it('accepts a finite bootstrap result in the same transaction as first completion', async () => {
  await resetFixture({}, 'bootstrap');
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => {
    if (request.stage.purpose !== 'plan')
      return native(request);
    seen.push(request);
    const tree = await f.tree();
    const answer: StageAnswer = { kind: 'plan', answer: { baseRevision: request.plan.revision, plan: f.plan } };
    return { ok: true, value: { address: request.address, ending: 'delivered', before: tree, after: tree, audit: f.ref, closure: 'dead',
     usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
     Buffer.from(JSON.stringify(answer)))) } };
  };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect(seen.map(r => r.stage.id)).toEqual(['planner', 'work', 'gate']);
  const events = get(await readEvents(f.journal, 0)), settled = events.find(e => e.payload.type === 'outcome_settled' &&
   e.payload.address.stage === 'planner')!;
  const batchRow = get(withState(f.database, false, db => ({ ok: true,
   value: db.prepare('SELECT batch FROM events WHERE root=? AND seq=?').get(f.journal.root, settled.seq) })));
  const batch = get(withState(f.database, false, db => ({ ok: true,
   value: db.prepare('SELECT payload FROM events WHERE root=? AND batch=?').all(f.journal.root, batchRow.batch) })));
  expect(batch.map((x: any) => JSON.parse(x.payload).type)).toEqual(expect.arrayContaining(['attempt_settled', 'plan_committed',
   'stage_settled', 'outcome_settled']));
});
it('resumes raw evidence at the same settlement identity and never completes a raw invalid plan', async () => {
  await resetFixture({}, 'bootstrap');
  const p = await f.projection(), address = { run: 'Run', stage: 'planner', attempt: 'Raw', invocation: 1 }, tree = await f.tree();
  const answer: StageAnswer = { kind: 'plan', answer: { baseRevision: p.plan.revision, plan: { stages: [stage('renew', 'plan'), {
   ...stage('gate', 'gate', ['renew']), purpose: 'gate', commands: [] }] } } };
  const receipt: AttemptReceipt = { address, ending: 'delivered', before: tree, after: tree, audit: f.ref, closure: 'dead', usage: {
   state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
   Buffer.from(JSON.stringify(answer)))) };
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'plan', address: { kind: 'stage', ...address } } }, {
   type: 'attempt_received', receipt }]);
  expect((await f.projection()).backstop).toEqual(initialBackstop());
  expect((await f.projection()).stageStates[0].completed).toBe(false);
  get(await settle(await f.projection(), receipt, f.execution, f.scope));
  const settled = await f.projection();
  expect(settled.backstop.failureSuffix).toBe(1);
  expect(settled.stageStates[0].completed).toBe(false);
  expect(await settle(settled, receipt, f.execution, f.scope)).toMatchObject({ ok: false, kind: 'conflict' });
  expect((await f.projection()).backstop.failureSuffix).toBe(1);
});
it('finite repair admission preserves the unvisited gate and return identity', async () => {
  const graph = repairGraph();
  await resetFixture({}, graph);
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let rejected = false;
  ports.attempt = async (request) => {
    if (request.stage.purpose === 'plan') {
      seen.push(request);
      const before = await f.tree();
      const progress = { ...graph.stages[1], after: ['work', 'repair_work'] }, later = graph.stages[2], gate = graph.stages[3];
      const answer: StageAnswer = { kind: 'plan', answer: { baseRevision: request.plan.revision, plan: { stages: [stage('repair_work',
       'work', ['work']), progress, later, gate] as any } } };
      return { ok: true, value: { address: request.address, ending: 'delivered', before, after: before, audit: f.ref, closure: 'dead',
       usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
       Buffer.from(JSON.stringify(answer)))) } };
    }
    const r = get(await native(request));
    if (request.stage.id === 'progress' && !rejected) {
      rejected = true;
      return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
       reason: 'Finite repair required', criteria: { correct: { status: 'fail', evidence: 'Needs repair', briefQuote: 'Deliver reviewed work' } }, findings: [],
       remainingWork: ['Repair'] } }) };
    }
    return { ok: true, value: r };
  };
  const result = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const p = await f.projection();
  expect(result.status).toBe('complete');
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'progress', 'planner', 'repair_work', 'progress', 'later', 'gate']);
  expect(p.revisions).toHaveLength(2);
});
