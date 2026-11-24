import './fixtures/rewrite-core-sql.js'; // Register authored effects before importing production consumers.
import { reconstructBackstop } from '../dist-rewrite/core/retry.js';
// Register authored effects before loading the real workflow/settlement modules.
import { afterEach,beforeEach,expect,it } from 'vitest';
import type { StageAnswer } from '../dist-rewrite/contract/answers.js';
import { gateReview, type AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';
import { settle } from '../dist-rewrite/core/settlement.js';
import { answerSchema } from '../dist-rewrite/contract/answers.js';
import { readEvidence } from '../dist-rewrite/records/evidence.js';
import { decideNext } from '../dist-rewrite/core/decisions.js';
import { putEvidence,readEvents,withState } from '../dist-rewrite/records/state.js';
import { stateFixture,type StateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { workflowFixture } from './fixtures/rewrite-workflow.js';
let f: StateFixture;
beforeEach(async () => { f = await stateFixture(); await f.admit(); });
afterEach(async () => { await f.close(); });
it('round 12 late cancelled receipt retains exact evidence and usage without checkpoint or refusal objects', async () => {
  const address = {run:'Run',stage:'work',attempt:'Late',invocation:1};
  const invocation = {charge:'work' as const,address:{kind:'stage' as const,...address}};
  await f.append(f.execution,[{type:'invocation_reserved',invocation}]);
  const before = await f.projection();
  await f.append(f.control,[{type:'control_intent',intent:{id:'Cancel',kind:'cancel',run:'Run',unit:f.launch.unit,expectedCursor:before.cursor}}]);
  const receipt: AttemptReceipt = {address,before:'a'.repeat(64),after:'b'.repeat(64),ending:'cancelled',closure:'dead',
    audit:f.ref,evidence:[f.ref],usage:{state:'unknown',raw:[f.ref]},inputChars:123};
  const result = await settle(before,receipt,f.execution,f.scope);
  expect(result).toEqual({ok:false,kind:'unknown',detail:'Late receipt retained after cancellation'});
  const after = await f.projection();
  expect({received:after.received,attempts:after.attempts}).toEqual({received:[receipt],attempts:[receipt]});
  expect({checkpoints:after.checkpoints,revisions:after.revisions,stageStates:after.stageStates})
    .toEqual({checkpoints:before.checkpoints,revisions:before.revisions,stageStates:before.stageStates});
});
async function answerReceipt(receipt: AttemptReceipt, answer: StageAnswer) {
  return { ...receipt, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) };
}
async function resetFixture(patch: Parameters<typeof stateFixture>[0] = {}, graph?: Parameters<typeof stateFixture>[1]) {
  await f.close(); f = await stateFixture(patch, graph); await f.admit();
}
const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role: 'author', purpose, after,
 ...(purpose === 'gate' ? { commands: [] } : { instruction: 'Finite declared obligation' }) });
it('settles four native answer failures once before parking', async () => {
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  const endings = ['invalid_answer', 'invalid_plan', 'invalid_answer', 'invalid_plan'] as const;
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
  const committed = (await f.projection()).backstop;
  get(withState(f.database,true,db => {
    db.prepare("UPDATE runs SET current=json_set(current,'$.backstop',json(?)) WHERE root=?")
      .run(JSON.stringify({gateSuffix:0,failureSuffix:0}),f.journal.root);
    return {ok:true,value:null};
  }));
  get(await reconstructBackstop(f.execution));
  expect((await f.projection()).backstop).toEqual(committed);
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
it('retains a malformed delivered plan as invalid_plan without committing its nondispatchable frontier', async () => {
  const commands = Array.from({ length: 23 }, (_, i) => ({ id: 'check_' + i, argv: ['synthetic-check', String(i)],
    env: {}, inputs: [], required: false }));
  await resetFixture({ commands }, 'bootstrap');
  const initial = await f.projection(), { ports, seen } = workflowFixture(f);
  const references = [commands.slice(0, 5), [], [], [], [], [], commands.slice(5, 12), commands.slice(0, 11), [], commands.slice(1), commands.slice(1)];
  const plan = { stages: references.map((refs, i) => ({ ...stage('stage_' + i, i === 7 || i === 10 ? 'gate' : 'work',
    i ? ['stage_' + (i - 1)] : []), commands: refs.map(command => command.id) })) };
  plan.stages.push({ ...stage('other_gate', 'gate', ['stage_0']), commands: [] });
  const frontier = get(decideNext(initial));
  if (frontier.kind !== 'stage') throw new Error('Expected bootstrap planner');
  expect(answerSchema(frontier.context).parse({ kind: 'plan', answer: { baseRevision: initial.plan.revision, plan } }).ok).toBe(true);
  ports.attempt = async request => {
    seen.push(request);
    const tree = await f.tree();
    return { ok: true, value: await answerReceipt({ address: request.address, before: tree, after: tree, ending: 'delivered',
      closure: 'dead', audit: f.ref, evidence: [], usage: { state: 'unknown', raw: [] }, inputChars: 1 },
      { kind: 'plan', answer: { baseRevision: request.plan.revision, plan } }) };
  };
  ports.command = async () => { throw new Error('An unadmitted frontier dispatched'); };
  expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })))
    .toMatchObject({ status: 'parked', reason: 'backstop' });
  const p = await f.projection();
  expect(p.revisions).toEqual(initial.revisions);
  expect(p.attempts.map(receipt => receipt.ending)).toEqual(Array(4).fill('invalid_plan'));
  expect(p.attempts.every(receipt => receipt.answerRef && receipt.evidence.length)).toBe(true);
  for (const receipt of p.attempts) {
    const evidence = await Promise.all(receipt.evidence.map(async ref => JSON.parse(Buffer.from(get(await readEvidence(f.journal, ref))).toString())));
    expect(evidence).toContainEqual({ refusal: { ok: false, kind: 'invalid', detail:
      'Graph requires one unique last delivery gate: last gates [stage_10, other_gate]; stages [' + [frontier.stage.id, ...plan.stages.map(stage => stage.id)].join(', ') + ']' } });
    expect(receipt.answerRef).toEqual(p.received.find(raw => raw.address.attempt === receipt.address.attempt)!.answerRef);
  }
  expect(p.stageStates.find(state => state.stage === 'planner')).toMatchObject({ state: 'pending', completed: false });
});
it('safe work settles delivered before a later command gate without relations', async () => {
  await resetFixture({ commands: [{ id: 'Check', argv: ['synthetic-check'], env: {}, inputs: [], required: false }] }, 'bootstrap');
  const plan = { stages: [stage('work'), { ...stage('gate', 'gate', ['work']), purpose: 'gate' as const, commands: ['Check'] }] };
  const plannerAddress = { run: 'Run', stage: 'planner', attempt: 'PlanAttempt', invocation: 1 };
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', ...plannerAddress } } }]);
  const before = await f.tree();
  const plannerReceipt = await answerReceipt({ address: plannerAddress, before, after: before, ending: 'delivered', closure: 'dead',
    audit: f.ref, evidence: [], usage: { state: 'unknown', raw: [] }, inputChars: 1 },
    { kind: 'plan', answer: { baseRevision: (await f.projection()).plan.revision, plan } });
  const admitted = get(await settle(await f.projection(), plannerReceipt, f.execution, f.scope));
  expect(admitted.receipt.ending).toBe('delivered');
  expect(admitted.projection.plan.plan).toEqual({...plan,stages:[admitted.projection.revisions[0].plan.stages[0],...plan.stages]});
  expect(admitted.projection.revisions).toHaveLength(2);
  const address = { run: 'Run', stage: 'work', attempt: 'WorkAttempt', invocation: 1 };
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', ...address } } }]);
  const tree = await f.tree();
  const receipt = await answerReceipt({ address, before: tree, after: tree, ending: 'delivered', closure: 'dead', audit: f.ref,
    evidence: [], usage: { state: 'unknown', raw: [] }, inputChars: 1 }, { kind: 'work', answer: { status: 'delivered',
    summary: 'Ready for review', caveats: [], remainingWork: [], blocks: null } });
  const result = get(await settle(await f.projection(), receipt, f.execution, f.scope));
  expect(result.receipt.ending).toBe('delivered');
  expect(result.projection.attempts.at(-1)?.ending).toBe('delivered');
  expect(result.projection.stageStates.find(state => state.stage === 'work')).toMatchObject({
    state: 'settled', completed: true });
  expect(get(decideNext(result.projection))).toMatchObject({ kind: 'stage', stage: { id: 'gate' } });
  expect(result.projection.commands).toEqual([]);
});

it('safe gate acceptance settles once and advances to later command work', async () => {
  await resetFixture({commands:[{id:'Check',argv:['inert-check'],env:{},inputs:[],required:false}]},{stages:[
    stage('work'),{...stage('progress','gate',['work']),purpose:'gate',commands:[]},
    {...stage('later','work',['progress']),commands:['Check']},{...stage('gate','gate',['later']),purpose:'gate',commands:[]}]});
  const {ports,seen} = workflowFixture(f);
  expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})))
    .toMatchObject({status:'complete'});
  const p = await f.projection();
  expect(seen.map(r=>r.stage.id)).toEqual(['work','progress','later','gate']);
  expect(p.attempts.every(r=>r.ending==='delivered')).toBe(true);
  expect(p.transitions).toHaveLength(2);
});
it('repair-planner revision can schedule commands without relations', async () => {
  const gate = {...stage('gate','gate',['work']),purpose:'gate' as const,commands:[],repair:{stage:'planner',returnsTo:'gate'}};
  await resetFixture({commands:[{id:'Check',argv:['inert-check'],env:{},inputs:[],required:false}]},
    {stages:[stage('work'),gate,stage('planner','plan')]});
  const {ports,seen} = workflowFixture(f), native = ports.attempt;
  let rejected = false;
  ports.attempt = async request => {
    if (request.stage.purpose === 'plan') {
      seen.push(request);
      const tree = await f.tree();
      return {ok:true,value:await answerReceipt({address:request.address,before:tree,after:tree,ending:'delivered',closure:'dead',
        audit:f.ref,evidence:[],usage:{state:'unknown',raw:[]},inputChars:1},{kind:'plan',answer:{baseRevision:request.plan.revision,
          plan:{stages:[{...stage('repair_work','work',['work']),commands:['Check']},{...gate,after:['work','repair_work']}]}}})};
    }
    const receipt = get(await native(request));
    if (request.stage.id === 'gate' && !rejected) {
      rejected = true;
      return {ok:true,value:await answerReceipt(receipt,{kind:'gate',answer:{outcome:'rejected_repairable',reason:'Repair required',
        criteria:{correct:{status:'fail',evidence:'Independent defect'}},findings:[],remainingWork:['Repair']}})};
    }
    return {ok:true,value:receipt};
  };
  const result = get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}));
  const p = await f.projection();
  expect(result.status).toBe('complete');
  expect(p.revisions).toHaveLength(2);
  expect(p.attempts.filter(r=>r.address.stage==='planner').map(r=>r.ending)).toEqual(['delivered']);
  expect(seen.map(r=>r.stage.id)).toEqual(['work','gate','planner','repair_work','gate']);
});

it.each([false,true])('binds an accepted gate to the supplied history even with zero commands: stale=%s',async stale=>{
  const {ports} = workflowFixture(f),native=ports.attempt;
  ports.attempt=async request=>{
    const receipt=get(await native(request));
    if(request.stage.purpose!=='gate'||!stale)return {ok:true,value:receipt};
    const review=get(await putEvidence(f.journal,Buffer.from(JSON.stringify(gateReview({commands:[],lineage:[]},[],[])))));
    const audit=get(await putEvidence(f.journal,Buffer.from(JSON.stringify({address:request.address,input:receipt.evidence[0],review}))));
    return {ok:true,value:{...receipt,audit}};
  };
  const result=get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}));
  const p=await f.projection();expect(p.commands).toEqual([]);
  expect(result.status).toBe(stale?'parked':'complete');
  expect(p.attempts.filter(a=>a.answer?.kind==='gate').map(a=>a.ending)).toEqual(stale?Array(4).fill('invalid_answer'):['delivered']);
});

it.each(['provider_unknown','closure_unknown'] as const)('explicit continuation consumes %s while its raw answer stays history', async ending => {
  const {ports,seen}=workflowFixture(f),native=ports.attempt;
  let first=true;
  ports.attempt=async request=>{
    const result=get(await native(request));
    if(!first)return {ok:true,value:result};
    first=false;
    return {ok:true,value:{...result,ending}};
  };
  expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})))
    .toMatchObject({status:'parked',reason:'recovery_unknown'});
  const before=await f.projection(),old=before.attempts[0];
  expect(before.checkpoints).toHaveLength(1);
  expect(before.stageStates.find(s=>s.stage==='work')?.state).toBe('pending');
  await f.append(f.control,[{type:'control_intent',intent:{id:'Continue',kind:'resume',run:'Run',unit:f.launch.unit,expectedCursor:before.cursor}}]);
  expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))).toMatchObject({status:'complete'});
  const after=await f.projection();
  expect(after.attempts[0]).toEqual(old);
  expect(after.received[0].ending).toBe(ending);
  expect(seen.map(request=>request.stage.id)).toEqual(['work','work','gate']);
});

it('reconciled unknown raw stays history while a fresh author and gate complete', async () => {
  const address={run:'Run',stage:'work',attempt:'Interrupted',invocation:1};
  const before=await f.tree();
  const raw=await answerReceipt({address,before,after:before,ending:'delivered',closure:'unknown',audit:f.ref,
    evidence:[],usage:{state:'unknown',raw:[]},inputChars:1},
    {kind:'work',answer:{status:'delivered',summary:'Unconfirmed native bytes',caveats:[],remainingWork:[],blocks:null}});
  await f.append(f.execution,[{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',...address}}},
    {type:'attempt_received',receipt:raw}]);
  await f.append(f.control,[{type:'owner_closed',owner:f.owner},{type:'accounting_interrupted'}]);
  const current=await f.projection();
  await f.append(f.control,[{type:'control_intent',intent:{id:'Continue',kind:'resume',run:'Run',unit:f.launch.unit,expectedCursor:current.cursor}}]);
  const {ports,seen}=workflowFixture(f);
  expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))).toMatchObject({status:'complete'});
  const after=await f.projection();
  expect(after.attempts[0]).toEqual(raw);
  expect(after.received[0]).toEqual(raw);
  expect(after.checkpoints.some(cp=>cp.address.attempt==='Interrupted')).toBe(false);
  expect(after.stageStates.find(stage=>stage.stage==='work')?.completed).toBe(true);
  expect(seen.map(request=>request.stage.id)).toEqual(['work','gate']);
});

// Publication is decided only in the final gate command phase, so only it asks for a base run: a required command listed on an
// earlier stage is dispatched there as a plain command.
it('asks for a base run only in the final gate command phase', async () => {
  await resetFixture({commands:[{id:'Check',argv:['inert-check'],env:{},inputs:[],required:true}]},{stages:[
    stage('work'),{...stage('later','work',['work']),commands:['Check']},{...stage('gate','gate',['later']),purpose:'gate',commands:[]}]});
  const {ports} = workflowFixture(f), native = ports.command, asked: Array<[string, boolean | undefined]> = [];
  ports.command = async request => { const at = request.reservation.invocation.address;
    asked.push([at.kind === 'stage' ? at.stage : at.kind, request.againstBase]); return native(request); };
  get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})); // the fixture's receipts need not satisfy the gate
  expect(asked[0]).toEqual(['later', undefined]);
  expect(asked.slice(1).length).toBeGreaterThan(0);
  expect(asked.slice(1).every(([stageId, base]) => stageId === 'gate' && base === true)).toBe(true);
});
