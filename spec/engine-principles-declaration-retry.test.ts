import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify, parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planRetryRealityCheckName, planRetryRequirement } from '../src/plan-retry-monotone.js';
import { runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';

let root:string,project:string,previous:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'flowcrew-declaration-retry-'));project=join(root,'project');mkdirSync(project);previous=fcGlobalDir();setFcGlobalDir(join(root,'store'));});
afterEach(()=>{setFcGlobalDir(previous);rmSync(root,{recursive:true,force:true});});
const contract={version:1,produces:[{id:'report',root:'project',path:'docs/final.md'}],reads:[], replays: [] };
const rawStage={id:'work',role:'coder',scope:['docs/**'],depends_on:[],dependency_reasons:{},prompt_template:'Write the declared report.'};
describe('typed declarations are repaired by complete independently admitted replacements',()=>{
  it('keeps a declared unconditional existence check hard without demanding a conditional branch',()=>{
    const check='## Reality checks\n```yaml\nchecks:\n - name: report\n   type: file-exists-nonempty\n   reads: [{id: report, root: project, path: docs/final.md, source: {kind: stage, stage: work, artifact: report}}]\n   params: {paths: [docs/final.md]}\n```\n';
    const plain=inspectRealityChecks('Produce verified evidence.',check);
    expect(plain.advisoryFindings.map((finding)=>finding.code)).toContain('undeclared_artifact_existence');
    const artifacts=ArtifactContractSchema.parse(contract);
    expect(inspectRealityChecks('Produce verified evidence.',check,{artifactContracts:[artifacts]}).advisoryFindings).toEqual([]);
    const conditional=ArtifactContractSchema.parse({...contract,produces:[{...contract.produces[0],when:{stage:'choice',field:'exitCode',equals:0}}]});
    expect(inspectRealityChecks('Produce verified evidence.',check,{artifactContracts:[conditional]}).advisoryFindings.map((finding)=>finding.code)).toContain('undeclared_artifact_existence');
  });
  it('binds engine-coded names including escaped quotes and keeps replacement fields explicit',()=>{
    const name='quoted "audit"';
    expect(planRetryRealityCheckName(`ARTIFACT_READ_UNREACHABLE: reality check ${JSON.stringify(name)}.report needs a producer`)).toBe(name);
    const requirement=planRetryRequirement('ARTIFACT_DECLARATION_REQUIRED: work.artifact_contract: declare it');
    expect(requirement.id).toBe('stage:work:artifact_contract');
    const wrapped = 'work: invalid schema at ARTIFACT_DECLARATION_REQUIRED: work.artifact_contract: declare it';
    expect(planRetryRequirement(wrapped)).toMatchObject({ id: requirement.id, detail: wrapped });
    expect(planRetryRequirement(wrapped.replace(/^work:/, 'peer:')).id).toMatch(/^admission:/);
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
    mkdirSync(join(project,'config'),{recursive:true});writeFileSync(join(project,'config/defaults.yaml'),stringify({default_timeout_ms:10000,default_max_iterations:1,default_stage_technical_retries:1,default_gate_retry_loops:1}));
    const workflow=WorkflowConfigSchema.parse({name:'typed-repair',stages:[{id:'plan',role:'planner',scope:[],dynamic_dispatch:true,prompt_template:'Produce a declared plan.',artifact_contract:{version:1,produces:[],reads:[],replays:[]}}],defaults:{max_iterations:1}});
    const calls:string[]=[],prompts:string[]=[];let plans=0;
    const adapter:Adapter={async run(prompt,_role,opts){calls.push(opts.stageId);const writes:string[]=[];
      if(opts.stageId==='plan'){
        plans++;prompts.push(prompt);
        const declared=failure==='check_reads'||plans>1;
        writeFileSync(join(opts.runDir,'dispatch.yaml'),stringify([{...rawStage,...(declared?{artifact_contract:contract}:{})}]));writes.push('run:dispatch.yaml');
        if(failure==='check_reads'){
          const check={name:'report',type:'file-exists-nonempty',params:{paths:['docs/final.md']},...(plans>1?{reads:[{id:'report',root:'project',path:'docs/final.md',source:{kind:'stage',stage:'work',artifact:'report'}}]}:{})};
          writeFileSync(join(opts.runDir,'reality_checks.md'),'## Reality checks\n```yaml\n'+stringify({checks:[check]})+'```\n');writes.push('run:reality_checks.md');
        }
      }
      if(opts.stageId==='work'){mkdirSync(join(project,'docs'),{recursive:true});writeFileSync(join(project,'docs/final.md'),'Fresh evidence from admitted work.');writes.push('docs/final.md');}
      return {output:'done',exitCode:0,duration_ms:1,writes,writeAttribution:'structured'};
    }};
    const state=await runWorkflow(workflow,stringify(workflow),project,adapter,roles,undefined,agentsDir,undefined,'Write a fresh report with verified evidence.',true);
    expect(state.status,state.failureReason).toBe('complete');
    const preflightPath=join(runDir(project,state.runId),'reality_check_preflight.json');
    const diagnostic=failure==='check_reads'?readFileSync(preflightPath,'utf8'):'';
    expect(plans,diagnostic).toBe(2);expect(calls.slice(0,3)).toEqual(['plan','plan','work']);
    expect(prompts[1]).toContain(failure==='stage_contract'?'ARTIFACT_DECLARATION_REQUIRED':'REALITY_READ_DECLARATION_REQUIRED');
    expect(readFileSync(join(project,'docs/final.md'),'utf8')).toContain('Fresh evidence');
    expect(StageConfigSchema.parse(rawStage).role).toBe('coder');
  });
});
