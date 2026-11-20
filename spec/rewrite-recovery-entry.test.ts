import { expect, it, vi } from 'vitest';
import { coreProjection } from './fixtures/rewrite-core-projection.js';
import type { RunServices } from '../dist-rewrite/ops/run.js';
import type { AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { runUnitEntry } from '../dist-rewrite/ops/run.js';
import * as content from '../dist-rewrite/records/content.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';

// Authored I/O ports; the production entry chooses the restore/settle order.
const facts = vi.hoisted(() => ({projection:null as any}));
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  openJournal:async()=>({ok:true,value:{root:'/synthetic/store/runs/Run',database:'/synthetic/state.sqlite'}}),
  readProjection:async()=>({ok:true,value:facts.projection}),
  claim:async(resource)=>({ok:true,value:{resource,owner:{authority:'owned'},epoch:'epoch'}}),
  release:async()=>({ok:true,value:true}),
  openWriter:async(journal,claim,kind)=>({ok:true,value:{journal,owner:claim.owner,kind}}),
  readEvents:async()=>({ok:true,value:[{payload:{type:'run_authority',authority:{}}}]}),
}));
vi.mock('../dist-rewrite/ops/status.js',()=>({publishRunStatus:async()=>({ok:true,value:{}})}));
vi.mock('../dist-rewrite/ops/reconcile.js',()=>({reconcileRun:async()=>({ok:true,value:{}}),attendRun:async()=>({ok:true,value:null})}));
vi.mock('../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/content.js')>(),
  verifyRuntime:async(_root,ref)=>({ok:true,value:ref}),
  validateRecordLayout:async layout=>({ok:true,value:layout}),
  readCheckpoint:vi.fn(async(_journal,id)=>({ok:true,value:{id,tree:'b'.repeat(64)}})),
  captureTree:vi.fn(async()=>({ok:true,value:'c'.repeat(64)})),
  materializeCheckpoint:vi.fn(async()=>({ok:true,value:true})),
}));
vi.mock('../dist-rewrite/core/loop.js',()=>({runWorkflow:vi.fn(async()=>({ok:true,value:{status:'complete',reason:'completed',detail:'Workflow owns settlement'}}))}));
it.each([
  ['received author bytes',true,null,[]],
  ['ordinary recovery base',false,null,['Latest']],
  ['restore intent outranks received bytes',true,'Intent',['Intent']],
] as const)('recovery entry preserves %s', async (_name,pending,restoring,restored) => {
  vi.clearAllMocks();
  const p=coreProjection();
  const raw:AttemptReceipt={address:{run:p.run,stage:'work',attempt:'Prior',invocation:1},ending:'delivered',closure:'dead',
    before:'b'.repeat(64),after:'c'.repeat(64),audit:p.brief.bytes,evidence:[],usage:{state:'unknown',raw:[]},inputChars:1};
  const checkpoint={id:'Intent',address:raw.address,parent:null,state:'safe' as const,manifest:p.brief.bytes,tree:raw.before,brief:p.brief.digest,inputHashes:[],evidence:[]};
  p.checkpoints=[checkpoint,{...checkpoint,id:'Latest'}];p.received=pending?[raw]:[];p.restoring=restoring;
  p.launch.project='/synthetic/project';
  p.launch.runtime={path:'runtime/.pin',sha256:p.brief.digest};
  p.launch.unit={...p.launch.unit,runtime:p.launch.runtime};
  facts.projection=p;
  const services={configuration:{roles:p.launch.roles},unitContext:{},process:()=>({}),configRoot:'/synthetic/store/runtime/config',
    privateEnvironment:{},workflowPorts:()=>({})} as unknown as RunServices;
  const result=await runUnitEntry({run:p.run,storeRoot:'/synthetic/store',database:'/synthetic/state.sqlite'},p.launch.unit,services,new AbortController().signal);
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'complete'}});
  expect(vi.mocked(content.materializeCheckpoint).mock.calls.map(call=>call[2].id)).toEqual(restored);
  expect(runWorkflow).toHaveBeenCalledOnce();
});
