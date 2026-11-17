import type { RunProjection } from '../../dist-rewrite/contract/runtime.js';
// Independently authored facts: no SQL, Git, workflow or expected-state reducer.
export function coreProjection(completed = false): RunProjection {
  const ref = { path: 'authored/ref', sha256: 'a'.repeat(64) }, tree = 'b'.repeat(64);
  const declaration = { criteria: [{id:'correct',text:'Reviewed result'}],inputs:[],outputs:[],commands:[],results:[],
    allowBlocked:false,body:'Opaque goal' };
  const brief = {bytes:ref,digest:ref.sha256,declaration};
  const role = {id:'author',description:'',prompt:'Full goal',backend:'codex' as const,model:'fixture',effort:'fixture'};
  const plan = {stages:[{id:'work',role:'author',purpose:'work' as const,after:[],instruction:'Work',skills:[]},
    {id:'gate',role:'author',purpose:'gate' as const,after:['work'],instruction:'Review',skills:[],commands:[],repair:{stage:'repair',returnsTo:'gate'}},
    {id:'repair',role:'author',purpose:'work' as const,after:[],instruction:'Repair',skills:[]}]};
  const admitted = {revision:'Revision',plan,digest:tree,executed:[]};
  const unit = {run:'Run',authority:'authored',runtime:ref};
  const address = {run:'Run',stage:'gate',attempt:'GateAttempt',invocation:1};
  const checkpoint = {id:'GateCheckpoint',address,parent:null,state:'safe' as const,manifest:ref,tree,brief:brief.digest,inputHashes:[],evidence:[]};
  return {run:'Run',cursor:5,statusSince:5,status:'running',currentStage:null,brief,
    launch:{run:'Run',project:'/synthetic/project',brief,runtime:ref,roles:[role],unit,plan,
      setup:{project:'/synthetic/source',target:'/synthetic/project',brief:brief.digest,inputs:[],outputs:[],commands:[],nativeGrant:'applied'}},
    plan:admitted,revisions:[admitted],attempts:completed?[{address,ending:'delivered',before:tree,after:tree,audit:ref,
      closure:'dead',usage:{state:'unknown',raw:[]},evidence:[],inputChars:1,answerRef:ref,
      answer:{kind:'gate',answer:{outcome:'accepted',reason:'Observed',criteria:{correct:{status:'pass',evidence:'Bytes'}},findings:[],remainingWork:[]}}}]:[],
    transitions:completed?[{type:'gate_transition',stage:'gate',attempt:'GateAttempt',outcome:'accepted',next:null,evidence:[ref]}]:[],
    stageStates:plan.stages.map((s,index)=>({stage:s.id,state:completed&&s.id!=='repair'?'settled':'pending',
      obligation:'Revision:'+index,completed:completed&&s.id!=='repair'})),
    checkpoints:completed?[checkpoint]:[],received:[],obligations:[],closedInvocations:[],invocations:[],lineage:[],reservations:[],intervals:[],intents:[],operations:[],commands:[],
    leases:[],owners:[],restoring:null,outputs:[],backstop:{gateSuffix:0,failureSuffix:0,bestPassCount:null,segment:0,settlement:null,obligation:null}};
}
