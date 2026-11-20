import { f, resetFixture, stage } from './fixtures/rewrite-core.js';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import * as host from '../../dist-rewrite/host/process.js';
import { operateRun,runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { appendEvents, claim, openWriter, putEvidence, release } from '../../dist-rewrite/records/state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';

it('guide preserves a C2 park; accepted resume opens one segment with completion identities retained', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); return { ok: true, value: { ...r, ending: 'invalid_answer',
   answer: undefined, answerRef: undefined } }; };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const parked = await f.projection(), completed = parked.stageStates.map(s => [s.obligation, s.completed]);
  await f.releaseClaims();
  const services = runServices(f);
  const guidance = get(await putEvidence(f.journal, Buffer.from('Explicit human guidance')));
  const guide = { id: 'Guide', kind: 'guide' as const, run: 'Run', unit: f.launch.unit, expectedCursor: parked.cursor, intervention: {
   kind: 'guide' as const, address: parked.attempts.at(-1)!.address, content: guidance } };
  expect(get(await operateRun({ location: f.location, intent: guide }, services)).state).toBe('acknowledged');
  expect(get(await operateRun({ location: f.location, intent: { ...guide, id: 'GuideTwo' } }, services)).state).toBe('acknowledged');
  expect((await f.projection()).backstop).toEqual(parked.backstop);
  expect((await f.projection()).status).toBe('parked');
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null, evidence: [],
   detail: 'Manager fixture' } });
  vi.mocked(host.startRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'active', owner: null, evidence: [],
   detail: 'Manager fixture' } });
  const resume = { id: 'Resume', kind: 'resume' as const, run: 'Run', unit: f.launch.unit, expectedCursor: (await f.projection()).cursor };
  expect(get(await operateRun({ location: f.location, intent: resume }, services)).state).toBe('acknowledged');
  const p = await f.projection();
  expect(p.backstop).toMatchObject({ gateSuffix: 0, failureSuffix: 0, bestPassCount: null, segment: 1 });
  expect(p.stageStates.map(s => [s.obligation, s.completed])).toEqual(completed);
  expect(p.status).toBe('pending');
  expect(get(await operateRun({ location: f.location, intent: resume }, services)).state).toBe('acknowledged');
  expect((await f.projection()).backstop.segment).toBe(1);
  expect(get(await runUnitEntry(f.location, f.launch.unit, services, new AbortController().signal)).status).toBe('complete');
  expect((await f.projection()).backstop.segment).toBe(1);
  expect((await f.projection()).attempts.flatMap(item => item.guidance ?? [])).toEqual(['Guide', 'GuideTwo']);
});
it('explicit human replacement uses guide authority, preserves C2 and history, and cannot revive cancellation', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); return { ok: true, value: { ...r, ending: 'invalid_answer',
   answer: undefined, answerRef: undefined } }; };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const p = await f.projection(), content = get(await putEvidence(f.journal, Buffer.from('Human-authored finite replacement')));
  const replacement = { baseRevision: p.plan.revision, plan: { stages: [stage('replacement'), { ...stage('gate', 'gate', ['replacement']),
   purpose: 'gate' as const, commands: [], repair: { stage: 'repair', returnsTo: 'gate' } }, stage('repair')] } };
  await f.releaseClaims();
  const intent = { id: 'Replace', kind: 'guide' as const, run: 'Run', unit: f.launch.unit, expectedCursor: p.cursor, intervention: {
   kind: 'guide' as const, address: p.attempts.at(-1)!.address, content, replacement } };
  expect(get(await operateRun({ location: f.location, intent }, runServices(f))).state).toBe('acknowledged');
  const next = await f.projection();
  expect(next.backstop).toEqual(p.backstop);
  expect(next.attempts).toEqual(p.attempts);
  expect(next.status).toBe('parked');
  expect(next.stageStates.find(s => s.stage === 'work')?.obligation).toBe(p.stageStates.find(s => s.stage === 'work')?.obligation);
  expect(next.plan.plan.stages.some(s => s.id === 'replacement')).toBe(true);
  const held = get(await claim(join(f.journal.root, 'control'), f.launch.unit, { database: f.database, holder: f.journal.root }));
  try {
    const writer = get(await openWriter(f.journal, held, 'control'));
    get(await appendEvents(writer, next.cursor, [{ type: 'control_intent', intent: { id: 'CancelReplacement', kind: 'cancel',
     run: 'Run', unit: f.launch.unit, expectedCursor: next.cursor } }]));
  }
  finally {
    get(await release(held, 'retire'));
  }
  expect(await operateRun({ location: f.location, intent: { ...intent, id: 'AfterCancel',
   expectedCursor: (await f.projection()).cursor } }, runServices(f))).toMatchObject({ ok: false, kind: 'conflict' });
  expect((await f.projection()).status).toBe('cancelled');
});
it('A13 queues mid-attempt guides for the next author stage in commit order and never the independent gate', async () => {
  await resetFixture({}, { stages: [
    { id: 'work', purpose: 'work', role: 'author', after: [], instruction: 'First',  },
    { id: 'next', purpose: 'work', role: 'author', after: ['work'], instruction: 'Next',  },
    { id: 'gate', purpose: 'gate', role: 'author', after: ['next'], commands: [] }
  ] });
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async request => {
    if (request.stage.id === 'work') {
      for (const id of ['FirstGuide', 'SecondGuide']) {
        const content = get(await putEvidence(f.journal, Buffer.from(id)));
        await f.append(f.control, [{ type: 'control_intent', intent: { id, kind: 'guide', run: 'Run', unit: f.launch.unit,
          expectedCursor: (await f.projection()).cursor, intervention: { kind: 'guide', address: request.address, content } } }]);
      }
      expect(request.guidance).toBeUndefined();
    } else if (request.stage.id === 'next') {
      expect(request.guidance?.map(item => item.intent)).toEqual(['FirstGuide', 'SecondGuide']);
      expect(request.guidance?.map(item => item.cursor)).toEqual((await f.projection()).intents
        .filter(item => item.kind === 'guide').map(item => item.expectedCursor));
    }
    else expect(request.guidance).toBeUndefined();
    return native(request);
  };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  const receipts = (await f.projection()).attempts;
  expect(receipts.flatMap(item => item.guidance ?? [])).toEqual(['FirstGuide', 'SecondGuide']);
});

it('A13 replacement before the first attempt uses the current revision without inventing an invocation address', async () => {
  const projection = await f.projection(), content = get(await putEvidence(f.journal, Buffer.from('Replacement before work')));
  await f.releaseClaims();
  const result = get(await operateRun({ location: f.location, intent: {
    kind: 'guide', id: 'InitialReplacement', run: 'Run', unit: f.launch.unit, expectedCursor: projection.cursor,
    intervention: { kind: 'guide', address: null, content,
      replacement: { baseRevision: projection.plan.revision, plan: projection.plan.plan } }
  } }, runServices(f)));
  expect(result.state).toBe('acknowledged'); expect((await f.projection()).attempts).toEqual([]);
});
