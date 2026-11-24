import { putAuthored } from './fixtures/rewrite-bytes.js';
import { commandDeclarationIdentity } from '../dist-rewrite/exec/command.js';
import { expect,it,vi } from 'vitest';
import type { AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { admitPlan } from '../dist-rewrite/core/admission.js';
import { decideNext,decidePublication as publication } from '../dist-rewrite/core/decisions.js';
import { decideRetry,outcomeFacts } from '../dist-rewrite/core/retry.js';
import { commandInterrupted,readEvents } from '../dist-rewrite/records/state.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),readEvents:vi.fn(),
}));
// These pure fixtures supply the journal facts corresponding to their authored lineage.
const decidePublication: typeof publication = (journal, projection, checkpoint, outputs) => {
  vi.mocked(readEvents).mockResolvedValue({ok:true,value:projection.lineage.map((item,index) => ({
    seq:index+1,at:'2030-01-01T00:00:00Z',run:projection.run,payload:item.kind === 'command'
      ? {type:'command' as const,receipt:item.receipt} : {type:'checkpoint' as const,checkpoint:item.checkpoint},
  }))});
  return publication(journal,projection,checkpoint,outputs);
};
const journal = { root: '/synthetic', database: '/synthetic/state.sqlite' };
const f = { brief: coreProjection().brief, ref: {path:'authored/ref',sha256:'a'.repeat(64)}, plan: coreProjection().plan.plan,
  projection: async () => coreProjection() };
const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role:'author', purpose, after,
 ...(purpose === 'gate' ? {commands:[]} : {instruction:'Finite declared obligation'}) });
function completedDecisionFixture() { return coreProjection(true); }
const endings: Array<[
  AttemptReceipt['ending'],
  string,
  string?
]> = [
  ['delivered', 'settled'], ['invalid_answer', 'retry', 'correction'], ['invalid_plan', 'retry', 'correction'], ['work_failed', 'park', 'recovery_unknown'],
  ['technical_failure', 'park', 'recovery_unknown'], ['auth', 'park', 'recovery_unknown'], ['refused', 'park', 'recovery_unknown'],
  ['input_too_large', 'park', 'recovery_unknown'], ['quota', 'park', 'recovery_unknown'], ['duration', 'park', 'recovery_unknown'],
  ['cancelled', 'stop', 'cancelled'], ['isolation_failure', 'stop', 'isolation_refused'], ['closure_unknown', 'park', 'recovery_unknown'],
   ['provider_unknown', 'park', 'recovery_unknown'],
];
it.each(endings)('preserves the pure retry decision for %s', async (ending, kind, detail) => {
  const p = await f.projection();
  const receipt: AttemptReceipt = { address: { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, ending,
   before: 'a'.repeat(64), after: 'a'.repeat(64), audit: f.ref, closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [],
   inputChars: 1, resetAt: '2030-01-01T00:00:00Z' };
  const result = decideRetry({ projection: p, receipt });
  expect(result.kind).toBe(kind);
  if (result.kind === 'retry')
    expect(result.charge).toBe(detail);
  if (result.kind === 'park' || result.kind === 'stop')
    expect(result.conclusion.reason).toBe(detail);
});
it.each(['no-gate', 'ambiguous-gates', 'orphan', 'unknown-role', 'unsafe-base',
 'missing-repair-return'])('retains pure admission refusal for %s', async (kind) => {
  const work = { id: 'work', role: 'author', purpose: 'work' as const, after: [], instruction: 'Work', }, gate = { id: 'gate',
   role: 'author', purpose: 'gate' as const, after: ['work'], commands: [] };
  const proposals = {
    'no-gate': { stages: [work] }, 'ambiguous-gates': { stages: [work, gate, { ...gate, id: 'other' }] },
    orphan: { stages: [work, gate, { ...work, id: 'orphan' }] }, 'unknown-role': { stages: [{ ...work, role: 'unknown' }, gate] },
    'unsafe-base': { stages: [{ ...work, baseCheckpoint: 'quarantined' }, gate] },
    'missing-repair-return': { stages: [work, { ...gate, repair: { stage: 'work', returnsTo: 'unknown' } }] }
  };
  expect((await admitPlan(journal, proposals[kind as keyof typeof proposals], 'next', await f.projection()))).toMatchObject({ ok: false, kind: 'invalid' });
});
it('keeps a pending gate graph fixed until independent review', async () => {
  const p = await f.projection();
  expect((await admitPlan(journal, f.plan, 'next', p)).ok).toBe(true);
  expect((await admitPlan(journal, { stages: f.plan.stages.filter(s => s.id !== 'repair').map(s => s.purpose === 'gate' ? { ...s, repair: { stage: 'work',
   returnsTo: 'gate' } } : s) }, 'next', p)).ok).toBe(false);
});
it.each(['safe', 'quarantined'] as const)('retains admission of only %s checkpoint bases', async (state) => {
  const p = await f.projection(), checkpoint = { id: 'Checkpoint', address: { run: 'Run', stage: 'work', attempt: 'Attempt',
   invocation: 1 }, parent: null, state, manifest: f.ref, tree: 'a'.repeat(64), brief: f.brief.digest, inputHashes: [], evidence: [] };
  expect((await admitPlan(journal, { stages: f.plan.stages.map(s => s.id === 'work' ? { ...s, baseCheckpoint: 'Checkpoint' } : s) }, 'next', { ...p,
   revisions: [], checkpoints: [checkpoint] })).ok).toBe(state === 'safe');
});
it('retains duplicate gate-transition and undeclared-blocked refusal', async () => {
  const p = await completedDecisionFixture(), checkpoint = p.checkpoints.at(-1)!;
  expect(decideNext({ ...p, transitions: [...p.transitions, p.transitions[0]] })).toMatchObject({ ok: false, kind: 'invalid' });
  const changed = { ...p, attempts: p.attempts.map(r => r.answer?.kind === 'gate' ? { ...r, answer: { kind: 'gate' as const, answer: {
   ...r.answer.answer, outcome: 'accepted_blocked' as const } } } : r) };
  expect((await decidePublication(journal, changed, checkpoint, { preserved: true, artifacts: [], detail: '' })).ok).toBe(false);
});
it('a finite bootstrap graph may retain a dormant planner owned by a future independent repair return', async () => {
  const graph = { stages: [stage('work'), { ...stage('gate', 'gate', ['work']), purpose: 'gate' as const, commands: [], repair: {
   stage: 'repair_plan', returnsTo: 'gate' } }, stage('repair_plan', 'plan')] };
  const base = coreProjection(), planner = stage('planner', 'plan');
  const p = { ...base, launch: { ...base.launch, plan: undefined },
    plan: { ...base.plan, plan: { stages: [planner] } }, revisions: [{ ...base.plan, plan: { stages: [planner] } }],
    stageStates: [{ stage: 'planner', state: 'pending' as const, obligation: 'Revision:0', completed: false }] };
  expect((await admitPlan(journal, graph, 'Finite', p, 'planner'))).toMatchObject({ ok: true });
});
it('a completed gate obligation cannot clear later failures through another pass', async () => {
  const p = coreProjection(true), receipt = p.attempts.at(-1)!, stage = p.stageStates.find(s => s.stage === receipt.address.stage)!;
  expect(stage.completed).toBe(true);
  const current = { ...p, backstop: { ...p.backstop, failureSuffix: 3 } };
  const facts = outcomeFacts(current, receipt, stage, true);
  expect(facts[0]).toMatchObject({ type: 'outcome_settled', completed: false, backstop: { failureSuffix: 3 } });
});

function frontierFixture() {
  const base = coreProjection(), planner = stage('planner', 'plan');
  const commands = Array.from({ length: 23 }, (_, i) => ({ id: 'check_' + i, argv: ['synthetic-check', String(i)],
    env: {}, inputs: [], required: false }));
  const brief = { ...base.brief, declaration: { ...base.brief.declaration, commands } };
  const bootstrap = { ...base.plan, plan: { stages: [planner] } };
  const projection = { ...base, brief, launch: { ...base.launch, brief, plan: undefined }, plan: bootstrap,
    revisions: [bootstrap], stageStates: [{ stage: planner.id, state: 'pending' as const, obligation: 'Revision:0', completed: false }] };
  // Scrubbed real shape: eleven stages, 23 distinct commands, 67 references.
  const names = ['prepare', 'work1', 'work2', 'work3', 'work4', 'work5', 'measure', 'component', 'polish', 'finalize', 'delivery'];
  const references = [commands.slice(0, 5), [], [], [], [], [], commands.slice(5, 12), commands.slice(0, 11), [], commands.slice(1), commands.slice(1)];
  const plan = { stages: names.map((id, i) => ({ ...stage(id, i === 7 || i === 10 ? 'gate' : 'work', i ? [names[i - 1]] : []),
    commands: references[i].map(command => command.id) })) };
  return { projection, plan };
}
it('admits the real-shape graph without any model-authored command relations', async () => {
  const { projection, plan } = frontierFixture();
  expect(plan.stages).toHaveLength(11);
  expect(plan.stages.flatMap(stage => stage.commands)).toHaveLength(67);
  expect((await admitPlan(journal, plan, 'Next', projection, 'planner'))).toMatchObject({ ok: true });
});
it('admits a commandless first stage and a later command-bearing frontier', async () => {
  const { projection } = frontierFixture();
  const future = { ...stage('future', 'work', ['first']), commands: ['check_0'] };
  const serial = { stages: [stage('first'), future, { ...stage('review', 'gate', ['future']), purpose: 'gate' as const, commands: [] }] };
  expect((await admitPlan(journal, serial, 'Next', projection, 'planner'))).toMatchObject({ ok: true });
});

it('checks the executable replacement frontier while the run remains parked', async () => {
  const { projection, plan } = frontierFixture();
  const parked = { ...projection, status: 'parked' as const,
    conclusion: { status: 'parked' as const, reason: 'backstop' as const, detail: 'Awaiting manual correction' } };
  const intent = { id: 'Guide', kind: 'guide' as const, run: projection.run, unit: projection.launch.unit,
    expectedCursor: projection.cursor, intervention: { kind: 'guide' as const, address: null, content: projection.brief.bytes,
      replacement: { baseRevision: projection.plan.revision, plan } } };
  expect((await admitPlan(journal, plan, 'Next', parked, undefined, intent))).toMatchObject({ ok: true });
  expect(parked.status).toBe('parked');
});

it('blocks open reservations but admits author repair after command reconciliation', () => {
  const p = coreProjection();
  const reservation = {key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},
    identity:'Check',invocation:{charge:'command' as const,address:{kind:'stage' as const,run:p.run,stage:'work',attempt:'Interrupted',invocation:1}},state:'uncertain' as const};
  const plan = {...p.plan,plan:{...p.plan.plan,stages:p.plan.plan.stages.map(stage=>stage.id==='work'?{...stage,commands:['Check']}:stage)}};
  const brief={...p.brief,declaration:{...p.brief.declaration,commands:[{id:'Check',argv:['synthetic-check'],env:{},inputs:[],required:false}]}};
  const current = {...p,brief,launch:{...p.launch,brief},plan,reservations:[reservation]};
  expect(decideNext(current)).toMatchObject({ok:false,kind:'unknown',detail:expect.stringContaining('flowcrew resume')});
  const closed = {...current,reservations:[{...reservation,state:'closed-unmeasured' as const}]};
  expect(decideNext(closed)).toMatchObject({ok:true,value:{kind:'stage',stage:{id:'work'}}});
  const replaced = {...closed,plan:p.plan};
  expect(decideNext(replaced)).toMatchObject({ok:true,value:{kind:'stage',stage:{id:'work'}}});
  expect(replaced.reservations[0].state).toBe('closed-unmeasured');
});

it('admits an engine-required final command after reconciliation even when the authored command list is empty', () => {
  const p = coreProjection();
  const reservation = {key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},
    identity:'Check',invocation:{charge:'command' as const,address:{kind:'stage' as const,run:p.run,stage:'gate',attempt:'Interrupted',invocation:1}},state:'closed-unmeasured' as const};
  const final = {...p,plan:p.plan,brief:{...p.brief,declaration:{...p.brief.declaration,commands:[
    {id:'Check',argv:['check'],env:{},inputs:[],required:true}]}},
    stageStates:p.stageStates.map(state=>state.stage==='work'?{...state,state:'settled' as const,completed:true}:state),
    reservations:[{...reservation,state:'closed-unmeasured' as const,invocation:{...reservation.invocation,
      address:{...reservation.invocation.address,stage:'gate'}}}]};
  expect(decideNext(final)).toMatchObject({ok:true,value:{kind:'stage',stage:{id:'gate'},context:{final:true}}});
  expect(final.plan.plan.stages.find(stage=>stage.id==='gate')?.commands).toEqual([]);
});

it.each([false,true])('checkpoint base eligibility compares only frozen identities: frozen=%s',async frozen=>{
  const p=coreProjection(),checkpoint={id:'ChangedInput',address:{run:'Run',stage:'work',attempt:'Earlier',invocation:1},
    parent:null,state:'safe' as const,manifest:f.ref,tree:'a'.repeat(64),brief:p.brief.digest,
    inputHashes:[putAuthored(Buffer.from(JSON.stringify({format:'flowcrew-baseline-v2',path:'changing.txt',snapshot:'changed'})))],evidence:[]};
  const brief={...p.brief,declaration:{...p.brief.declaration,inputs:[{id:'changing',path:'changing.txt',kind:'file' as const,frozen}]}};
  const projection={...p,revisions:[],brief,launch:{...p.launch,brief,setup:{...p.launch.setup,inputs:[putAuthored(Buffer.from(JSON.stringify({format:'flowcrew-baseline-v2',path:'changing.txt',snapshot:'original'})))]}},checkpoints:[checkpoint]};
  const proposal={stages:p.plan.plan.stages.map(s=>s.id==='work'?{...s,baseCheckpoint:checkpoint.id}:s)};
  expect((await admitPlan(journal, proposal,'InputRevision',projection)).ok).toBe(!frozen);
});


it('retired historical stage skills cannot masquerade as a changed frozen definition', async () => {
  const projection = coreProjection();
  const historical = { ...projection.plan, plan: { ...projection.plan.plan,
    stages: projection.plan.plan.stages.map(stage => ({ ...stage, skills: ['HistoricalOnly'] })) } };
  const result = await admitPlan(journal, projection.plan.plan, 'NextRevision', { ...projection, plan: historical, revisions: [historical] });
  expect(result).toMatchObject({ ok: true, value: { plan: projection.plan.plan } });
});

it('marks an interrupted required request incomplete instead of substituting an older success at delivery', async () => {
  const p=coreProjection(true),checkpoint=p.checkpoints.at(-1)!,ref=checkpoint.manifest;
  const command={id:'Check',argv:['synthetic-check'],env:{},inputs:[],required:true};
  const key={tree:checkpoint.tree,declaration:commandDeclarationIdentity(command),inputHashes:[],context:'d'.repeat(64),
    generation:{...ref,sha256:checkpoint.tree}};
  const receipt={key,command:'Check',execution:{state:'complete' as const,exit:0},stdout:ref,stderr:ref,before:checkpoint.tree,
    after:checkpoint.tree,delta:ref,spent:{durationMs:1}};
  const invocation={charge:'command' as const,address:{kind:'stage' as const,...checkpoint.address}};
  const measured={key,identity:'Check',state:'committed' as const,invocation,receipt};
  const current={...p,brief:{...p.brief,declaration:{...p.brief.declaration,commands:[command]}},
    reservations:[measured],commands:[receipt],lineage:[{kind:'command' as const,receipt},{kind:'checkpoint' as const,checkpoint}]};
  expect(await decidePublication(journal,current,checkpoint,{preserved:true,artifacts:[],detail:''}))
    .toMatchObject({ok:true,value:{status:'complete'}});
  const unknown={key:{...key,context:'f'.repeat(64)},identity:'Check',
    invocation:{...invocation,address:{...invocation.address,attempt:'Interrupted'}},state:'closed-unmeasured' as const};
  for (const address of [unknown.invocation.address, invocation.address]) {
    const previous = address === invocation.address ? measured
      : {...measured,invocation:{...invocation,address:{...invocation.address,attempt:'Older'}}};
    const result = await decidePublication(journal,{...current,reservations:[previous,
      {...unknown,invocation:{...invocation,address}}]},checkpoint,{preserved:true,artifacts:[],detail:''});
    expect(result).toMatchObject({ok:true,value:{status:'incomplete',reason:'command_unfinished',
      detail:expect.not.stringContaining('flowcrew resume')}});
    if (result.ok) expect(result.value.detail).toContain(JSON.stringify(address));
  }
});
it.each(['valid','rename','replace','dependency'] as const)('finite repair admission keeps the pending gate definition: %s', async variant => {
  const base = coreProjection(), work = stage('work');
  const progress = {...stage('progress','gate',['work']),purpose:'gate' as const,commands:[],repair:{stage:'planner',returnsTo:'progress'}};
  const later = stage('later','work',['progress']), gate = {...stage('gate','gate',['later']),purpose:'gate' as const,commands:[]};
  const plan = {...base.plan,plan:{stages:[work,progress,later,gate,stage('planner','plan')]}};
  const receipt = coreProjection(true).attempts[0];
  const projection = {...base,plan,revisions:[plan],attempts:[{...receipt,address:{...receipt.address,stage:'work'}},
    {...receipt,address:{...receipt.address,stage:'progress'},answer:{kind:'gate' as const,answer:{
      outcome:'rejected_repairable' as const,reason:'Needs repair',criteria:{correct:{status:'fail' as const,evidence:'Independent defect'}},
      findings:[],remainingWork:['Repair']}}}],
    transitions:[{type:'gate_transition' as const,stage:'progress',attempt:receipt.address.attempt,outcome:'rejected_repairable' as const,
      next:'planner',evidence:[base.brief.bytes]}],
    stageStates:plan.plan.stages.map((s,i)=>({stage:s.id,obligation:'Revision:'+i,
      state:i<2?'settled' as const:'pending' as const,completed:i===0}))};
  const nextLater = variant==='rename'?{...later,id:'renamed'}:variant==='replace'?{...later,instruction:'Unauthorized replacement'}:later;
  const nextGate = variant==='rename'?{...gate,after:['renamed']}:variant==='dependency'?{...gate,after:['later','repair_work']}:gate;
  const proposal = {stages:[stage('repair_work','work',['work']),{...progress,after:['work','repair_work']},nextLater,nextGate]};
  expect(await admitPlan(journal,proposal,'Next',projection,'planner')).toMatchObject(variant==='valid'?{ok:true}:{ok:false,kind:'invalid'});
});
it.each(['bootstrap','repair'] as const)('refuses a nondispatchable successor planner at the %s boundary', async boundary => {
  const base = coreProjection(), planner = stage('planner','plan');
  const gate = {...stage('gate','gate',['work']),purpose:'gate' as const,commands:[],repair:{stage:'planner',returnsTo:'gate'}};
  const plan = {...base.plan,plan:{stages:boundary==='bootstrap'?[planner]:[stage('work'),gate,planner]}};
  const receipt = coreProjection(true).attempts[0];
  const projection = {...base,launch:{...base.launch,plan:boundary==='bootstrap'?undefined:plan.plan},plan,revisions:[plan],
    attempts:boundary==='bootstrap'?[]:[{...receipt,address:{...receipt.address,stage:'work'}},receipt],
    transitions:boundary==='bootstrap'?[]:[{type:'gate_transition' as const,stage:'gate',attempt:'GateAttempt',
      outcome:'rejected_repairable' as const,next:'planner',evidence:[base.brief.bytes]}],stageStates:plan.plan.stages.map((s,i)=>({
      stage:s.id,obligation:'Revision:'+i,state:boundary==='repair'&&i<2?'settled' as const:'pending' as const,
      completed:boundary==='repair'&&i===0}))};
  const proposal = {stages:boundary==='bootstrap'?[stage('new_planner','plan'),
    {...stage('gate','gate',['new_planner']),purpose:'gate' as const,commands:[]}]:[
      stage('new_planner','plan',['work']),{...gate,after:['work','new_planner']} ]};
  expect(await admitPlan(journal,proposal,'Next',projection,'planner')).toMatchObject({ok:false,kind:'invalid'});
});


it('spent requests belong to the reserving attempt across corrections and resumes', () => {
  const p=coreProjection(), address={run:'Run',stage:'gate',attempt:'Interrupted',invocation:1};
  const invocation={charge:'command' as const,address:{kind:'stage' as const,...address}};
  const reservation={identity:'Check',key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)},
    invocation,state:'closed-unmeasured' as const};
  const projection={...p,reservations:[reservation],attempts:[],checkpoints:[],invocations:[invocation]};
  const resume={seq:2,payload:{type:'control_intent',intent:{id:'Resume',kind:'resume',run:'Run',unit:p.launch.unit,expectedCursor:1}}};
  const spent = (candidate: typeof address) => commandInterrupted(projection,candidate,'Check');
  expect(spent(address)).toBe(true);
  expect(spent({...address,invocation:2})).toBe(true);
  for(const candidate of [{...address,attempt:'Next'}, {...address,stage:'other'}, {...address,run:'Other'}])
    expect(spent(candidate)).toBe(false);
  projection.intents.push(resume.payload.intent as never);
  expect(spent(address)).toBe(true);
  expect(spent({...address,attempt:'Next'})).toBe(false);
  projection.reservations.push({...reservation,invocation:{...invocation,address:{...invocation.address,attempt:'Next'}}});
  expect(spent({...address,attempt:'Next'})).toBe(true);
});

it.each([false,true])('required failure disposition considers the whole set: reverse=%s', async reverse => {
  const p=coreProjection(true),checkpoint=p.checkpoints.at(-1)!,ref=checkpoint.manifest;
  const commands=['Measured','Interrupted'].map(id=>({id,argv:['synthetic-check'],env:{},inputs:[],required:true}));
  const key={tree:checkpoint.tree,declaration:commandDeclarationIdentity(commands[0]),inputHashes:[],context:'d'.repeat(64),generation:{...ref,sha256:checkpoint.tree}};
  const receipt={key,command:'Measured',execution:{state:'complete' as const,exit:7},stdout:ref,stderr:ref,before:checkpoint.tree,
    after:checkpoint.tree,delta:ref,spent:{durationMs:1}};
  const invocation={charge:'command' as const,address:{kind:'stage' as const,...checkpoint.address}};
  const measured={key,identity:'Measured',state:'committed' as const,invocation,receipt};
  const unknown={key:{...key,context:'f'.repeat(64)},identity:'Interrupted',state:'closed-unmeasured' as const,invocation};
  const current={...p,brief:{...p.brief,declaration:{...p.brief.declaration,commands:reverse?[...commands].reverse():commands}},
    reservations:[measured,unknown],commands:[receipt],lineage:[{kind:'command' as const,receipt},{kind:'checkpoint' as const,checkpoint}]};
  const result=await decidePublication(journal,current,checkpoint,{preserved:true,artifacts:[],detail:''});
  expect(result).toMatchObject({ok:true,value:{status:'incomplete',reason:'command_nonzero'}});
  if(result.ok){expect(result.value.detail).toContain('Measured: exit 7');expect(result.value.detail).toContain('Interrupted: interrupted request');
    expect(result.value.detail).not.toContain('flowcrew resume');}
  const interrupted=await decidePublication(journal,{...current,reservations:[unknown,{...unknown,identity:'Measured'}],commands:[],lineage:[]},
    checkpoint,{preserved:true,artifacts:[],detail:''});
  expect(interrupted).toMatchObject({ok:true,value:{status:'incomplete',reason:'command_unfinished',detail:expect.not.stringContaining('flowcrew resume')}});
});

it.each([false,true])('publication reason is canonical across terminal failures: reverse=%s', async reverse => {
  const p=coreProjection(true),checkpoint=p.checkpoints.at(-1)!,ref=checkpoint.manifest;
  const commands=['Measured','Missing'].map(id=>({id,argv:['synthetic-check'],env:{},inputs:[],required:true}));
  const key={tree:checkpoint.tree,declaration:commandDeclarationIdentity(commands[0]),inputHashes:[],context:'d'.repeat(64),generation:{...ref,sha256:checkpoint.tree}};
  const receipt={key,command:'Measured',execution:{state:'complete' as const,exit:7},stdout:ref,stderr:ref,before:checkpoint.tree,
    after:checkpoint.tree,delta:ref,spent:{durationMs:1}};
  const invocation={charge:'command' as const,address:{kind:'stage' as const,...checkpoint.address}};
  const current={...p,brief:{...p.brief,declaration:{...p.brief.declaration,commands:reverse?[...commands].reverse():commands}},
    reservations:[{key,identity:'Measured',state:'committed' as const,invocation,receipt}],commands:[receipt],
    lineage:[{kind:'command' as const,receipt},{kind:'checkpoint' as const,checkpoint}]};
  const result=await decidePublication(journal,current,checkpoint,{preserved:true,artifacts:[],detail:''});
  expect(result).toMatchObject({ok:true,value:{status:'incomplete',reason:'command_missing'}});
  if(result.ok)expect(result.value.detail).toBe('Missing: missing applicable committed receipt for delivery tree; Measured: exit 7');
});

it.each(['closed-unmeasured','signalled'] as const)('failed output preservation precedes unfinished command evidence: %s', async kind => {
  const p=coreProjection(true),checkpoint=p.checkpoints.at(-1)!;
  const command={id:'Check',argv:['synthetic-check'],env:{},inputs:[],required:true};
  const invocation={charge:'command' as const,address:{kind:'stage' as const,...checkpoint.address}};
  const ref=checkpoint.manifest;
  const key={tree:checkpoint.tree,declaration:commandDeclarationIdentity(command),inputHashes:[],context:'d'.repeat(64),generation:{...ref,sha256:checkpoint.tree}};
  const receipt={key,command:'Check',execution:{state:'unfinished' as const,reason:'signalled' as const,signal:'SIGTERM'},
    stdout:ref,stderr:ref,before:checkpoint.tree,after:checkpoint.tree,delta:ref,spent:{durationMs:1}};
  const current={...p,brief:{...p.brief,declaration:{...p.brief.declaration,commands:[command]}},
    reservations:[kind==='signalled'?{key,identity:'Check',state:'committed' as const,invocation,receipt}
      :{key,identity:'Check',state:'closed-unmeasured' as const,invocation}],
    commands:kind==='signalled'?[receipt]:[],
    lineage:kind==='signalled'?[{kind:'command' as const,receipt},{kind:'checkpoint' as const,checkpoint}]:[]};
  const result=await decidePublication(journal,current,checkpoint,{preserved:false,artifacts:[],detail:'Output bytes not preserved'});
  expect(result).toMatchObject({ok:true,value:{status:'incomplete',reason:'outputs_unpreserved'}});
  if(result.ok){expect(result.value.detail).toContain(kind==='signalled'?`Check: ${JSON.stringify(receipt.execution)}`:'Check: interrupted request');
    expect(result.value.detail).toContain('Output bytes not preserved');
    expect(result.value.detail).not.toContain('flowcrew resume');}

});

it.each(['accepted','unapplied','rejected_repairable'] as const)('a pending gate retires applicability of its %s review and repair return',outcome=>{
  const p=completedDecisionFixture();
  const receipt=p.attempts[0];
  const answer=receipt.answer!;
  const changed={...p,stageStates:p.stageStates.map(state=>state.stage === 'gate' ? {...state,state:'pending' as const} : state),
    attempts:[{...receipt,answer:answer.kind === 'gate' ? {...answer,answer:{...answer.answer,outcome:outcome === 'rejected_repairable' ? outcome : 'accepted' as const}} : answer}],
    transitions:outcome === 'unapplied' ? [] : p.transitions.map(transition=>({...transition,outcome:outcome === 'rejected_repairable' ? outcome : 'accepted' as const,next:outcome === 'rejected_repairable' ? 'repair' : null}))};
  expect(decideNext(changed)).toMatchObject({ok:true,value:{kind:'stage',stage:{id:'gate'}}});
});
it('pending guidance chooses an author before delivery; the addressed native delivery releases it',()=>{
  const p=completedDecisionFixture(),address=p.attempts[0].address;
  const guide={id:'Guide',kind:'guide' as const,run:p.run,unit:p.launch.unit,expectedCursor:p.cursor,
    intervention:{kind:'guide' as const,address,content:p.brief.bytes}};
  expect(decideNext({...p,intents:[guide]})).toMatchObject({ok:true,value:{kind:'stage',stage:{id:'work'},context:{purpose:'work',final:false}}});
  expect(decideNext({...p,intents:[guide],guideDeliveries:[{guide:'Guide',invocation:{...address,stage:'work'}}]})).toMatchObject({ok:true,value:{kind:'publication'}});
});
