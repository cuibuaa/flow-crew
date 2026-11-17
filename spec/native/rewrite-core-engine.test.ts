import { initialBackstop } from '../../dist-rewrite/contract/runtime.js';
import { access,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { StageAnswer } from '../../dist-rewrite/contract/answers.js';
import type { AttemptReceipt,AttemptRequest } from '../../dist-rewrite/contract/runtime.js';
import { decideNext } from '../../dist-rewrite/core/decisions.js';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { settle } from '../../dist-rewrite/core/settlement.js';
import * as host from '../../dist-rewrite/host/process.js';
import { land } from '../../dist-rewrite/ops/land.js';
import { operateRun,runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { readRunStatus } from '../../dist-rewrite/ops/status.js';
import { appendEvents,claim,openJournal,openWriter,putEvidence,readEvents,release,withState } from '../../dist-rewrite/records/state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { get,stateFixture,type StateFixture } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';
let f: StateFixture;
beforeEach(async () => {
  f = await stateFixture(); await f.admit();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null,
    evidence: [], detail: 'Manager fixture' } });
});
afterEach(async () => { await f.close(); });
async function returnedReceipt(invocation = true) {
  const p = await f.projection(), next = get(decideNext(p));
  if (next.kind !== 'stage')
    throw new Error('Expected work frontier');
  const address = { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, paid = { charge: 'work' as const, address: {
   kind: 'stage' as const, ...address } };
  if (invocation)
    await f.append(f.execution, [{ type: 'invocation_reserved', invocation: paid }]);
  const request: AttemptRequest = { address, invocation: paid, stage: next.stage, role: f.configuration.roles[0], brief: f.brief,
   plan: p.plan, evidence: [], context: next.context };
  return get(await workflowFixture(f).ports.attempt(request));
}
async function answerReceipt(receipt: AttemptReceipt, answer: StageAnswer) { return { ...receipt, answer,
 answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) }; }
async function resetFixture(patch: Parameters<typeof stateFixture>[0] = {}, graph?: Parameters<typeof stateFixture>[1]) { await f.close();
 f = await stateFixture(patch, graph); await f.admit(); }
const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role: 'author', purpose, after,
 instruction: 'Finite declared obligation', skills: [], ...(purpose === 'gate' ? { commands: [] } : {}) });
vi.mock('../../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 observeRun: vi.fn(), startRun: vi.fn() }));
const repairGraph = () => ({ stages: [stage('work'), { ...stage('progress', 'gate', ['work']), purpose: 'gate' as const, commands: [],
 repair: { stage: 'planner', returnsTo: 'progress' } }, stage('later', 'work', ['progress']), { ...stage('gate', 'gate', ['later']),
 purpose: 'gate' as const, commands: [] }, stage('planner', 'plan')] });
it('drives real SQL/content through work, independent review and final publication', async () => {
  const { ports, seen } = workflowFixture(f);
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'complete', reason: 'completed' });
  const p = await f.projection();
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'gate']);
  expect(p.status).toBe('complete');
  expect(p.attempts).toHaveLength(2);
  expect(p.checkpoints).toHaveLength(2);
  expect(p.transitions).toHaveLength(1);
  expect(p.outputs[0].preserved).toBe(true);
  expect(p.intervals.every(i => i.spentMs !== null)).toBe(true);
});
it('returns retained rejection to its repair stage and then the same gate', async () => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let first = true;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.purpose !== 'gate' || !first)
      return { ok: true, value: r };
    first = false;
    const answer = { kind: 'gate' as const, answer: { outcome: 'rejected_repairable' as const, reason: 'Repair the delivery',
     criteria: { correct: { status: 'fail' as const, evidence: 'Needs repair' } }, findings: [{ id: 'finding', paths: [], reason: 'Correctness',
     criterionIds: ['correct'], class: 'criterion_unmet' as const }], remainingWork: ['Repair'] } };
    return { ok: true, value: { ...r, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) } };
  };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'gate', 'repair', 'gate']);
  expect((await f.projection()).transitions.map(t => t.outcome)).toEqual(['rejected_repairable', 'accepted']);
});
it('retains late raw answer after real cancel without releasing dependencies', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const receipt = get(await native(request)); const p = await f.projection();
   await f.append(f.control, [{ type: 'control_intent', intent: { id: 'Cancel', kind: 'cancel', run: 'Run', unit: f.launch.unit,
   expectedCursor: p.cursor } }]); return { ok: true, value: receipt }; };
  await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
  const p = await f.projection();
  expect(p.status).toBe('cancelled');
  expect(p.attempts).toHaveLength(1);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
  expect(p.transitions).toEqual([]);
});
it.each(['quota', 'input_too_large', 'duration', 'provider_unknown',
 'closure_unknown'] as const)('parks %s with durable evidence and no redispatch', async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (r) => { const receipt = get(await native(r)); return { ok: true, value: { ...receipt, ending, answer: undefined,
   answerRef: undefined, ...(ending === 'closure_unknown' ? { closure: 'unknown' as const } : {}) } }; };
  await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
  const p = await f.projection();
  expect(p.status).toBe('parked');
  expect(seen).toHaveLength(1);
  expect(p.attempts[0].ending).toBe(ending);
});
it('restoration-in-progress fences dispatch after restart', async () => {
  const { ports, seen } = workflowFixture(f);
  await f.append(f.execution, [{ type: 'checkpoint', checkpoint: { id: 'Checkpoint', address: { run: 'Run', stage: 'work',
   attempt: 'Attempt', invocation: 1 }, parent: null, state: 'safe', manifest: f.ref, tree: 'a'.repeat(64), brief: f.brief.digest,
   inputHashes: [], evidence: [] } }, { type: 'checkpoint_restore_started', checkpoint: 'Checkpoint' }]);
  expect(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).toMatchObject({
   ok: false, kind: 'unknown' });
  expect(seen).toEqual([]);
});
it.each(['accepted_blocked', 'rejected_irreparable'] as const)('preserves actual workflow routing for typed %s', async (outcome) => {
  await f.close();
  f = await stateFixture({ allowBlocked: true });
  await f.admit();
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); if (r.answer?.kind !== 'gate')
    return { ok: true, value: r }; const answer = { ...r.answer, answer: { ...r.answer.answer, outcome,
     reason: 'Arbitrary diagnostics and metric -999' } }; return { ok: true, value: { ...r, answer, answerRef: get(await putEvidence(f.journal,
     Buffer.from(JSON.stringify(answer)))) } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports,
   abort: new AbortController().signal })).status).toBe(outcome === 'accepted' ? 'complete' : outcome === 'accepted_blocked' ? 'accepted_blocked' : 'failed');
});
it.each(['technical_failure'] as const)('retains a failed %s attempt before an actual successful retry',
 async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let first = true;
  ports.attempt = async (request) => { const r = get(await native(request)); if (!first)
    return { ok: true, value: r }; first = false; return { ok: true, value: { ...r, ending, answer: undefined, answerRef: undefined } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  const p = await f.projection();
  expect(p.attempts[0].ending).toBe(ending);
  expect(p.attempts).toHaveLength(3);
  expect(seen.map(r => r.stage.id)).toEqual(['work', 'work', 'gate']);
});
it.each(['live', 'reused', 'unknown'] as const)('keeps raw %s closure without checkpoint or stage completion', async (closure) => {
  const receipt = { ...await returnedReceipt(), closure };
  expect(await settle(await f.projection(), receipt, f.execution, f.scope)).toMatchObject({ ok: false, kind: 'unknown' });
  const p = await f.projection();
  expect(p.attempts).toEqual([receipt]);
  expect(p.checkpoints).toEqual([]);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
});
it.each(['stale address', 'missing invocation', 'wrong answer bytes'])('retains real settlement refusal for %s', async (fault) => {
  let receipt = await returnedReceipt(fault !== 'missing invocation');
  if (fault === 'stale address')
    receipt = { ...receipt, address: { ...receipt.address, attempt: 'stale' } };
  if (fault === 'wrong answer bytes')
    receipt = { ...receipt, answerRef: get(await putEvidence(f.journal, Buffer.from('{}'))) };
  const result = await settle(await f.projection(), receipt, f.execution, f.scope);
  expect(result.ok).toBe(fault === 'wrong answer bytes');
  const p = await f.projection();
  expect(p.checkpoints).toHaveLength(fault === 'wrong answer bytes' ? 1 : 0);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
  if (fault === 'wrong answer bytes')
    expect(p.attempts[0].ending).toBe('invalid_answer');
});
it.each([
  [[2, 4, 3, 4, 3], [1, 1, 2, 3], [2, 4, 4, 4]],
] as const)('parks a real rejection sequence %j at its record-high suffix', async (counts, suffixes, bests) => {
  await resetFixture({ criteria: Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, text: 'Authored criterion ' + i })) });
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let n = 0;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.purpose !== 'gate')
      return { ok: true, value: r };
    const count = counts[n++];
    return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
     reason: 'Independent rejection', criteria: Object.fromEntries(f.brief.declaration.criteria.map((c, i) => [c.id, {
     status: i < count ? 'pass' : 'fail', evidence: 'Direct independent evidence' }])), findings: [], remainingWork: ['Repair'] } }) };
  };
  const conclusion = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  expect(conclusion).toMatchObject({ status: 'parked', reason: 'backstop' });
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(suffixes.length);
  const events = get(await readEvents(f.journal, 0));
  const outcomes = events.flatMap(e => e.payload.type === 'outcome_settled' && e.payload.address.stage === 'gate' ? [e.payload.backstop] : []);
  expect(outcomes.map(x => x.gateSuffix)).toEqual(suffixes);
  expect(outcomes.map(x => x.bestPassCount)).toEqual(bests);
  expect(get(await readRunStatus(f.location)).backstop).toEqual({...(await f.projection()).backstop,
    rule:'C2',gateThreshold:3,failureThreshold:4,scope:'engine-outcomes',condition:'gate'});
  const again = workflowFixture(f);
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports: again.ports,
   abort: new AbortController().signal })).status).toBe('parked');
  expect(again.seen).toEqual([]);
});
it.each(['successor', 'repair-successor'] as const)('refuses %s at actual contextual settlement, never completing or dispatching the successor',
 async (variant) => {
  const gate = { ...stage('gate', 'gate', ['planner']), purpose: 'gate' as const, commands: [], repair: { stage: 'repair_plan',
   returnsTo: 'gate' } };
  const graph = variant === 'repair-successor' ? { stages: [stage('work'), { ...gate, after: ['work'] }, stage('repair_plan',
   'plan')] } : undefined;
  await resetFixture({}, graph ?? 'bootstrap');
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => {
    if (request.stage.purpose === 'plan') {
      const before = await f.tree();
      const proposed = { stages: [stage('new_planner', 'plan'), { ...stage('gate', 'gate', ['new_planner']), purpose: 'gate' as const,
       commands: [] }] };
      const answer: StageAnswer = { kind: 'plan', answer: { baseRevision: request.plan.revision, plan: proposed } };
      seen.push(request);
      return { ok: true, value: { address: request.address, ending: 'delivered', before, after: before, audit: f.ref, closure: 'dead',
       usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 100, answer, answerRef: get(await putEvidence(f.journal,
       Buffer.from(JSON.stringify(answer)))) } };
    }
    const r = get(await native(request));
    if (request.stage.purpose !== 'gate')
      return { ok: true, value: r };
    return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
     reason: 'Repair planning boundary', criteria: { correct: { status: 'fail', evidence: 'Needs finite repair' } }, findings: [],
     remainingWork: ['Repair'] } }) };
  };
  const p0 = await f.projection();
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const p = await f.projection();
  expect(p.status).toBe('parked');
  expect(p.backstop.failureSuffix, JSON.stringify({conclusion:p.conclusion,attempts:p.attempts,backstop:p.backstop})).toBe(4);
  expect(p.revisions).toHaveLength(p0.revisions.length);
  expect(seen.some(r => r.stage.id === 'new_planner')).toBe(false);
  expect(p.stageStates.find(s => s.stage === (variant === 'repair-successor' ? 'repair_plan' : 'planner'))?.completed).toBe(false);
  expect(p.attempts.filter(r => r.answer?.kind === 'plan').every(r => r.ending === 'invalid_plan')).toBe(true);
});
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
it.each(['file',
 'directory'] as const)(
  'preserves an external %s output through real delivery and reclaim; terminal extents exclude a later overlapping run', async (kind) => {
  const parent = await mkdtemp(join(tmpdir(), 'fcrw-external-delivery-')), external = join(parent, 'product');
  try {
    await resetFixture({ outputs: [{ path: external, kind, existing: 'create' }] });
    const { ports } = workflowFixture(f), native = ports.attempt;
    ports.attempt = async (request) => {
      const receipt = get(await native(request));
      if (request.stage.purpose === 'work') {
        if (kind === 'directory')
          await mkdir(external);
        else
          await writeFile(external, 'Delivered external bytes');
        return { ok: true, value: { ...receipt, after: await f.tree() } };
      }
      return { ok: true, value: receipt };
    };
    expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
    const location = { ...f.location, run: 'Later' }, journal = get(await openJournal(location, 'create'));
    const held = get(await claim(join(journal.root, 'control'), null, { database: f.database, holder: journal.root }));
    try {
      const writer = get(await openWriter(journal, held, 'control')), nextProject = join(f.root, 'later-project');
      await mkdir(nextProject);
      const authority = { ...f.scope.authority, project: nextProject, resources: [{ path: nextProject,
       access: 'exclusive-write' as const }, { path: external, access: 'exclusive-write' as const }] };
      expect(await appendEvents(writer, 0, [{ type: 'run_authority', authority }])).toMatchObject({ ok: false, kind: 'conflict' });
      await f.releaseClaims();
      vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null,
       evidence: [], detail: 'Model-free manager edge' } });
      expect(get(await land(f.location, 'preserve', runServices(f).process, f.unitContext)).state).toBe('preserved');
      expect(await appendEvents(writer, 0, [{ type: 'run_authority', authority }])).toMatchObject({ ok: false, kind: 'conflict' });
      expect(get(await land(f.location, 'reclaim', runServices(f).process, f.unitContext)).state).toBe('reclaimed');
      await expect(access(f.project)).rejects.toMatchObject({ code: 'ENOENT' });
      await access(external);
      if (kind === 'file')
        expect(await readFile(external, 'utf8')).toBe('Delivered external bytes');
      expect(get(await appendEvents(writer, 0, [{ type: 'run_authority', authority }]))).toBe(1);
    }
    finally {
      get(await release(held, 'retire'));
    }
  }
  finally {
    await rm(parent, { recursive: true, force: true });
  }
});
it('guide preserves a C2 park; accepted resume opens one segment with completion identities retained', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); return { ok: true, value: { ...r, ending: 'work_failed',
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
it.each(['valid', 'rename', 'replace',
 'dependency'] as const)('finite repair admission %s preserves the unvisited gate and return identity', async (kind) => {
  const graph = repairGraph();
  await resetFixture({}, graph);
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let rejected = false;
  ports.attempt = async (request) => {
    if (request.stage.purpose === 'plan') {
      seen.push(request);
      const before = await f.tree();
      const progress = { ...graph.stages[1], after: ['work', 'repair_work'] }, later = kind === 'rename' ? { ...graph.stages[2],
       id: 'renamed' } : kind === 'replace' ? { ...graph.stages[2], instruction: 'Unauthorized replacement' } : graph.stages[2];
      const gate = kind === 'rename' ? { ...graph.stages[3], after: ['renamed'] } : kind === 'dependency' ? { ...graph.stages[3],
       after: ['later', 'repair_work'] } : graph.stages[3];
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
       reason: 'Finite repair required', criteria: { correct: { status: 'fail', evidence: 'Needs repair' } }, findings: [],
       remainingWork: ['Repair'] } }) };
    }
    return { ok: true, value: r };
  };
  const result = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const p = await f.projection();
  if (kind === 'valid') {
    expect(result.status).toBe('complete');
    expect(seen.map(r => r.stage.id)).toEqual(['work', 'progress', 'planner', 'repair_work', 'progress', 'later', 'gate']);
    expect(p.revisions).toHaveLength(2);
  }
  else {
    expect(result).toMatchObject({ status: 'parked', reason: 'backstop' });
    expect(p.backstop.failureSuffix, JSON.stringify({conclusion:p.conclusion,attempts:p.attempts,backstop:p.backstop})).toBe(4);
    expect(p.revisions).toHaveLength(1);
    expect(seen.filter(r => r.stage.id === 'planner')).toHaveLength(4);
    expect(p.stageStates.find(s => s.stage === 'planner')?.completed).toBe(false);
  }
});
it('explicit human replacement uses guide authority, preserves C2 and history, and cannot revive cancellation', async () => {
  const { ports } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); return { ok: true, value: { ...r, ending: 'work_failed',
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
it('does not dispatch through an actual unresolved command reservation', async () => {
  await resetFixture({ commands: [{ id: 'Check', argv: ['fixture'], env: {}, inputs: [], required: true }] });
  const p = await f.projection(), invocation = { charge: 'command' as const, address: { kind: 'final' as const, run: 'Run' } };
  const { reserveCommand } = await import('../../dist-rewrite/records/state.js');
  get(await reserveCommand(f.execution, p.cursor, 'Check', { tree: 'a'.repeat(64), context: 'b'.repeat(64), declaration: 'c'.repeat(64),
   inputHashes: [] }, invocation));
  const { ports, seen } = workflowFixture(f);
  expect(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).toMatchObject({
   ok: false, kind: 'unknown' });
  expect(seen).toEqual([]);
});
it('missing required receipts refuse effective gate passes without a hidden final command sweep', async () => {
  await resetFixture({ commands: [{ id: 'Missing', argv: ['fixture'], env: {}, inputs: [], required: true }] });
  const { ports, seen } = workflowFixture(f);
  ports.command = async () => { throw new Error('Unplanned final execution'); };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({
   status: 'parked', reason: 'backstop' });
  expect((await f.projection()).commands).toEqual([]);
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(4);
  expect((await f.projection()).backstop.failureSuffix).toBe(4);
});
it('a stale pass of an already completed progress gate cannot clear later failures', async () => {
  const graph = { stages: [stage('work'), { ...stage('progress', 'gate', ['work']), purpose: 'gate' as const, commands: [] },
   stage('later', 'work', ['progress']), { ...stage('gate', 'gate', ['later']), purpose: 'gate' as const, commands: [] }] };
  await resetFixture({}, graph);
  const { ports } = workflowFixture(f), native = ports.attempt;
  let visits = 0, checked = false;
  ports.attempt = async (request) => {
    const r = get(await native(request));
    if (request.stage.id === 'later') {
      if (++visits === 1)
        return { ok: true, value: { ...r, ending: 'technical_failure', answer: undefined, answerRef: undefined } };
      const p = await f.projection(), old = p.attempts.find(a => a.address.stage === 'progress')!;
      expect(p.backstop.failureSuffix).toBe(1);
      expect(await settle(p, old, f.execution, f.scope)).toMatchObject({ ok: false, kind: 'conflict' });
      expect((await f.projection()).backstop.failureSuffix).toBe(1);
      checked = true;
    }
    return { ok: true, value: r };
  };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
  expect(checked).toBe(true);
});
it('genuine first completions in finite repair segments clear failures but never the rejection sequence', async () => {
  const gate = { ...stage('gate', 'gate', ['work']), purpose: 'gate' as const, commands: [], repair: { stage: 'repair_plan', returnsTo: 'gate' } };
  await resetFixture({ criteria: [0, 1, 2, 3, 4].map(i => ({ id: 'c' + i, text: 'Fixed criterion' })) }, { stages: [stage('work'), gate,
   stage('repair_plan', 'plan')] });
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let plans = 0, gates = 0;
  const failed = new Set<string>();
  ports.attempt = async (request) => {
    if (request.stage.purpose === 'plan') {
      seen.push(request);
      const before = await f.tree(), name = 'repair_' + (++plans);
      const answer: StageAnswer = { kind: 'plan', answer: { baseRevision: request.plan.revision, plan: { stages: [stage(name, 'work',
       ['work']), { ...gate, after: ['work', name] }] } } };
      return { ok: true, value: { address: request.address, ending: 'delivered', before, after: before, audit: f.ref, closure: 'dead',
       usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
       Buffer.from(JSON.stringify(answer)))) } };
    }
    const r = get(await native(request));
    if (request.stage.purpose === 'work' && !failed.has(request.stage.id)) {
      failed.add(request.stage.id);
      return { ok: true, value: { ...r, ending: 'work_failed', answer: undefined, answerRef: undefined } };
    }
    if (request.stage.purpose === 'gate') {
      const count = [4, 3, 4][gates++];
      return { ok: true, value: await answerReceipt(r, { kind: 'gate', answer: { outcome: 'rejected_repairable',
       reason: 'Independent fixed-map rejection', criteria: Object.fromEntries(f.brief.declaration.criteria.map((c, i) => [c.id, {
       status: i < count ? 'pass' : 'fail', evidence: 'Current predicate evidence' }])), findings: [], remainingWork: ['Repair'] } }) };
    }
    return { ok: true, value: r };
  };
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const p = await f.projection(), events = get(await readEvents(f.journal, 0)),
   outcomes = events.flatMap(e => e.payload.type === 'outcome_settled' ? [e.payload] : []);
  expect(p.status).toBe('parked');
  expect(p.revisions).toHaveLength(3);
  expect(outcomes.filter(e => e.address.stage === 'gate').map(e => [e.backstop.gateSuffix, e.backstop.failureSuffix,
   e.backstop.bestPassCount])).toEqual([[1, 0, 4], [2, 0, 4], [3, 0, 4]]);
  expect(outcomes.filter(e => e.address.stage !== 'repair_plan')).toHaveLength(9);
  expect(outcomes.filter(e => e.address.stage === 'repair_plan').map(e => e.completed)).toEqual([true, false]);
});
it.each(['provider_unknown', 'quota', 'duration',
 'input_too_large'] as const)('an unaccepted %s ending retains a rejected gate as evidence without changing C2', async (ending) => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  ports.attempt = async (request) => { const r = get(await native(request)); if (request.stage.purpose !== 'gate')
    return { ok: true, value: r }; return { ok: true, value: { ...await answerReceipt(r, { kind: 'gate', answer: {
     outcome: 'rejected_irreparable', reason: 'Unaccepted terminal envelope', criteria: { correct: { status: 'fail',
     evidence: 'Retained answer' } }, findings: [], remainingWork: [] } }), ending } }; };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('parked');
  expect((await f.projection()).backstop).toMatchObject({ gateSuffix: 0, failureSuffix: 0, bestPassCount: null });
  expect(seen.filter(r => r.stage.purpose === 'gate')).toHaveLength(1);
});

it('A13 queues mid-attempt guides for the next author stage in commit order and never the independent gate', async () => {
  await resetFixture({}, { stages: [
    { id: 'work', purpose: 'work', role: 'author', after: [], instruction: 'First', skills: [] },
    { id: 'next', purpose: 'work', role: 'author', after: ['work'], instruction: 'Next', skills: [] },
    { id: 'gate', purpose: 'gate', role: 'author', after: ['next'], instruction: 'Independent', skills: [], commands: [] }
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
