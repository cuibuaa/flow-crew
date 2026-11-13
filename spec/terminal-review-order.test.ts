import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowConfigSchema, } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { setFcGlobalDir, fcGlobalDir } from '../src/store.js';
let root:string;const previous=fcGlobalDir();
afterEach(()=>{setFcGlobalDir(previous);if(root)rmSync(root,{recursive:true,force:true})});
it('accepts a terminal report when a later whole-brief gate reviewed all actual product bytes',async()=>{
 root=mkdtempSync(join(tmpdir(),'terminal-review-order-'));const project=join(root,'project');mkdirSync(project);setFcGlobalDir(join(root,'store'));
 const workflow=WorkflowConfigSchema.parse({name:'review-order',defaults:{max_iterations:1,max_retries:0},stages:[
  {id:'aux',role:'coder',scope:['aux.txt']},
  {id:'author',role:'coder',scope:['result.md']},
  {id:'gate',role:'qa',is_gate:true,scope:[],depends_on:['author']},
  {id:'repair',role:'coder',scope:['result.md','aux.txt'],depends_on:['gate'],retry_to:['gate']},
 ]});
 const adapter=new ScriptedAdapter({
  aux:{projectFiles:{'aux.txt':'correct auxiliary result'}},
  author:{projectFiles:{'result.md':'correct terminal result'}},
  gate:{runFiles:{'verdict_gate.json':'{"pass":true,"reason":"Reviewed the whole brief, terminal result and auxiliary output"}'}},
 });
 const original=adapter.run.bind(adapter);let observed=false;
 adapter.run=async(p,r,o)=>{if(o.stageId==='gate'){
  expect(readFileSync(join(project,'aux.txt'),'utf8')).toBe('correct auxiliary result');
  expect(readFileSync(join(project,'result.md'),'utf8')).toBe('correct terminal result');observed=true;
 }return original(p,r,o)};
 const state=await runWorkflow(workflow,'',project,adapter,new Map(),undefined,join(import.meta.dirname,'../config/agents'),undefined,
  '---\nterminal_states:\n  complete: [result.md]\n---\nProduce a correct result and auxiliary output and independently review both.\n',true);
 console.log(JSON.stringify({status:state.status,reason:state.failureReason,observed,
  gate:state.stages.gate.gate?.pass,auxCompleted:state.stages.aux.attempts?.at(-1)?.completedAt,
  gateStarted:state.stages.gate.attempts?.at(-1)?.startedAt,calls:adapter.calls.map(c=>c.stageId)}));
 expect(observed).toBe(true);expect(state.stages.gate.gate?.pass).toBe(true);
 expect(Date.parse(state.stages.gate.attempts!.at(-1)!.startedAt))
  .toBeGreaterThanOrEqual(Date.parse(state.stages.aux.attempts!.at(-1)!.completedAt!));
 expect(state.status,state.failureReason).toBe('complete');
});
