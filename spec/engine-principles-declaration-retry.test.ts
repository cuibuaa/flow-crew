import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify, parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planRetryRequirement } from '../src/plan-retry-monotone.js';
import { runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';

let root:string,project:string,previous:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'flowcrew-declaration-retry-'));project=join(root,'project');mkdirSync(project);previous=fcGlobalDir();setFcGlobalDir(join(root,'store'));});
afterEach(()=>{setFcGlobalDir(previous);rmSync(root,{recursive:true,force:true});});
const contract={version:1,produces:[{id:'report',root:'project',path:'docs/final.md'}],reads:[] };
const rawStage={id:'work',role:'coder',scope:['docs/**'],depends_on:[],dependency_reasons:{},prompt_template:'Write the declared report.'};
describe('typed declarations are repaired by complete independently admitted replacements',()=>{
  it('binds typed error identity independently of diagnostic text and keeps replacement fields explicit',()=>{
    const error = { code: 'artifact_contract', stageId: 'work', field: 'artifact_contract', message: 'Declare the producer.' };
    const requirement = planRetryRequirement(error);
    expect(requirement).toMatchObject({ id: 'artifact_contract:work:artifact_contract', detail: error.message });
    expect(planRetryRequirement({ ...error, message: 'Different localized diagnostic: 123' })).toMatchObject({ id: requirement.id, detail: 'Different localized diagnostic: 123' });
    expect(planRetryRequirement({ ...error, stageId: 'peer' }).id).not.toBe(requirement.id);
    // A complete replacement is validated as authored; no hidden merge changes
    // its role or scope. Unknown roles are refused by whole-plan admission.
    const replacement={...rawStage,artifact_contract:contract,role:'foreign',scope:['foreign/**']};
    const effective=StageConfigSchema.parse(replacement);
    expect(effective.artifact_contract?.produces[0].path).toBe('docs/final.md');
    expect(effective.role).toBe('foreign');expect(effective.scope).toEqual(['foreign/**']);
  });
  it.each(['stage_contract','check_reads'] as const)('repairs %s through the public scheduler before any work is launched',async(failure)=>{
    const roles=new Map<string,AgentConfig>();
    const agentsDir=join(project,'config/agents');mkdirSync(agentsDir,{recursive:true});
    for(const name of ['planner','coder']){
      const role:AgentConfig={name,description:name,model:'default',reasoning_effort:'default',tools:[],prompt:'Fixture instructions.'};roles.set(name,role);writeFileSync(join(agentsDir,`${name}.yaml`),stringify(role));
    }
    setEngineDefaults({default_timeout_ms:10000,max_iterations:1,stage_technical_retries:1,gate_retry_loops:1});
    const workflow=WorkflowConfigSchema.parse({name:'typed-repair',stages:[{id:'plan',role:'planner',scope:[],dynamic_dispatch:true,prompt_template:'Produce a declared plan.',artifact_contract:{version:1,produces:[],reads:[]}}],defaults:{max_iterations:1}});
    const calls:string[]=[],prompts:string[]=[];let plans=0;
    const adapter:Adapter={async run(prompt,_role,opts){calls.push(opts.stageId);const writes:string[]=[];
      if(opts.stageId==='plan'){
        plans++;prompts.push(prompt);
        const declared=failure==='check_reads'||plans>1;
        writeFileSync(join(opts.runDir,'fixture_dispatch.yaml'),stringify([{...rawStage,...(declared?{artifact_contract:contract}:{artifact_contract:{version:2,produces:[],reads:[]}})}]));writes.push('run:dispatch.yaml');
        if(failure==='check_reads'){
          const check={name:'report',type:'file-exists-nonempty',params:{paths:['docs/final.md']},...(plans>1?{reads:[{id:'report',root:'project',path:'docs/final.md',source:{kind:'stage',stage:'work',artifact:'report'}}]}:{})};
          writeFileSync(join(opts.runDir,'reality_checks.md'),'## Reality checks\n```yaml\n'+stringify({checks:[check]})+'```\n');writes.push('run:reality_checks.md');
        }
      }
      if(opts.stageId==='work'){mkdirSync(join(project,'docs'),{recursive:true});writeFileSync(join(project,'docs/final.md'),'Fresh evidence from admitted work.');writes.push('docs/final.md');}
      return fixtureResult({output:'done',exitCode:0,duration_ms:1,writes,writeAttribution:'structured'}, opts);
    }};
    const state=await runWorkflow(workflow,stringify(workflow),project,adapter,roles,undefined,agentsDir,undefined,'Write a fresh report with verified evidence.',true);
    expect(state.status,state.failureReason).toBe('complete');
    expect(plans).toBe(2);expect(calls.slice(0,3)).toEqual(['plan','plan','work']);
    expect(prompts[1]).toContain(failure==='stage_contract'?'artifact_contract.version':'REALITY_READ_DECLARATION_REQUIRED');
    expect(readFileSync(join(project,'docs/final.md'),'utf8')).toContain('Fresh evidence');
    expect(StageConfigSchema.parse(rawStage).role).toBe('coder');
  });
});
