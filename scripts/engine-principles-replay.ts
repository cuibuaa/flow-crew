/** Full frozen-population recognition replay. Historical commands remain data. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FrozenReplayCorpus, parseReplayArguments, requireFreshTemporaryDirectory, sha256 as hash } from './engine-principles-inputs.js';
import { pathToFileURL } from 'node:url';
import { parse as yaml, stringify } from 'yaml';
import { classifyDeclarationAdmissionChange, classifyRealityDeclarationChange, recordedReplayValue, withRecordedReplayClock, type ReplayDecision } from '../src/recorded-replay-policy.js';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node --import tsx scripts/engine-principles-replay.ts --census <frozen-corpus> --baseline-dist <copied-dist> --candidate-dist <dist> --private-root <fresh os.tmpdir child> --out <own evidence>');
  process.exit(0);
}
if (args.includes('--old-dist')) throw new Error('--old-dist third-generation comparison was retired; run a separate --baseline-dist/--candidate-dist comparison for each declared generation pair');
const options = parseReplayArguments(args, ['--census', '--baseline-dist', '--candidate-dist', '--private-root', '--out']);
const census = resolve(options['--census']), baseline = resolve(options['--baseline-dist']), candidate = resolve(options['--candidate-dist']);
const scratch = resolve(options['--private-root']), output = resolve(options['--out']);
requireFreshTemporaryDirectory(scratch);
mkdirSync(scratch, {recursive:false}); mkdirSync(output, {recursive:true});
process.env.FC_HOME = join(scratch, 'private-store'); process.env.FLOWCREW_DAEMON_SOCKET = join(scratch, 'unavailable.sock');
const corpus = new FrozenReplayCorpus(census);
const carriers = corpus.files, sources = corpus.sources;
const json = (name: string) => corpus.json(name);
const frozen = (path: string) => corpus.read(path);
for (const name of ['dispatch_records.json','native_planner_records.json','dispatch_documents.json','native_planner_documents.json','replay_templates_unique_context.json','checks_replay_selection.json']) json(name);
const audits=carriers.filter((row)=>row.readable&&/(?:^|\/)artifact_contract\.json$/.test(row.relative_path));
const verdicts=carriers.filter((row)=>row.readable&&/(?:^|\/)(?:rejected_)?verdict(?:_[^/]+)?\.json$/.test(row.relative_path));
const admissions=carriers.filter((row)=>row.readable&&/(?:^|\/)(?:(?:proposed|effective)_)?dispatch_admission\.json$/.test(row.relative_path));
const stageReferences=[...json('dispatch_records.json'),...json('native_planner_records.json')],templates=json('replay_templates_unique_context.json'),checks=json('checks_replay_selection.json').members,documents=json('dispatch_documents.json').documents;
const nativeDocs=json('native_planner_documents.json').documents.filter((row:any)=>row.status==='stage_document');
// Frozen indexes carry hashes and source references, rather than another copy
// of every planner prompt. Legacy inline projections remain readable.
const documentCache=new Map<string,any[]>();
function referencedStages(row:any):any[]{
  const key=JSON.stringify([row.source_path,row.line]);const cached=documentCache.get(key);if(cached)return cached;
  let text:string;
  if(row.line!==undefined){const source=nativeDocs.find((item:any)=>item.source_path===row.source_path&&item.line===row.line);if(!source)throw new Error(`Native document reference missing: ${key}`);text=corpus.nativeDocument(source);const fence=text.match(/```(?:yaml|yml)\s*\n([\s\S]*?)```/);if(fence)text=fence[1];}
  else text=frozen(row.source_path);
  const raw=yaml(text),items=Array.isArray(raw)?raw:raw?.stages;if(!Array.isArray(items))throw new Error(`Stage document reference invalid: ${key}`);documentCache.set(key,items);return items;
}
function referencedStage(row:any):any{
  if(row.stage)return row.stage;
  const stage=referencedStages(row).find(item=>item.id===row.stage_id&&hash(JSON.stringify(item))===row.stage_sha256);
  if(!stage)throw new Error(`Stage projection hash mismatch: ${row.source_path}:${row.stage_id}`);return stage;
}
const rawStages=stageReferences.map((row:any)=>({...row,stage:referencedStage(row)}));
function referencedTemplate(row:any):string{
  if(typeof row.template==='string')return row.template;
  const source=row.occurrences[0],stage=referencedStages(source).find(item=>item.id===source.stage_id&&typeof item.prompt_template==='string'&&hash(item.prompt_template)===row.raw_sha256);
  if(!stage)throw new Error(`Template reference hash mismatch: ${row.raw_sha256}`);return stage.prompt_template;
} 
const expected:Record<string,number>={stage_schema:rawStages.length,artifact_contracts:templates.length,check_declarations:checks.length,general_admission:documents.length,native_admission:nativeDocs.length,reality_admission:checks.length,recorded_audits:audits.length,gate_verdicts:verdicts.length,retry_requirements:admissions.length};
writeFileSync(join(output,'replay_selection_before.json'),JSON.stringify({version:3,at:new Date().toISOString(),expected,sources,rules:['New live inputs add exact contract/replays errors while retaining graph, ownership, warnings and terminal decisions.','Prompt/report prose supplies no obligations; a legacy input is refused for missing declarations.','Reality declarations require reads including advisory checks; malformed declarations fail admission. Only undeclared script references are superseded.','Typed handler reads bind their declared physical root; invalid/outward declarations remain refused.','Recorded obligation/replay/verdict bytes remain readable; no stored command or check runs.','Every other difference is ambiguous_unpredicted and blocks an achieved replay claim.'],context:'Frozen full selected recognition projections; absent original complete-plan role/criteria/input/terminal provenance is censored'},null,2));
async function runtime(dist:string){const load=(file:string)=>import(pathToFileURL(join(dist,file)).href);return{scheduler:await load('scheduler.js'),contract:await load('stage-artifact-contract.js'),checks:await load('reality-gate/index.js'),retry:await load('plan-retry-monotone.js'),declarations:await load('artifact-declarations.js')};}
const before=await runtime(baseline),after=await runtime(candidate),reader=await import(pathToFileURL(join(candidate,'recorded-artifact-contract.js')).href);
const project=join(scratch,'empty-project'),directory=join(scratch,'empty-run');mkdirSync(project);mkdirSync(directory);
const replayClock = Date.parse('2000-01-01T00:00:00.000Z');
function decision(fn:()=>unknown):ReplayDecision{try{return{status:'returned',value:recordedReplayValue(withRecordedReplayClock(replayClock,fn),scratch)};}catch(e){return{status:'refused',error:String((e as Error).message??e).replaceAll(scratch,'<owned-root>')};}}
const key=(value:unknown)=>JSON.stringify(value),same=(a:ReplayDecision,b:ReplayDecision)=>key(a)===key(b);
function formatErrors(raw:any):string[]{
  if(!raw.artifact_contract)return[`ARTIFACT_DECLARATION_REQUIRED: ${raw.id??'stage'}.artifact_contract: declare {version:1, produces:[], reads:[], groups:[], replays:[]} explicitly; prose cannot supply this contract`];
  if(typeof raw.artifact_contract==='object'&&!('replays'in raw.artifact_contract)){
    const errors=[`REPLAY_DECLARATION_REQUIRED: ${raw.id??'stage'}.artifact_contract.replays: declare [] explicitly, or structured {id, runner, targets, argv, expected} replay commands`];
    const recorded=after.declarations.RecordedArtifactContractSchema.safeParse(raw.artifact_contract);
    if(!recorded.success)errors.push(`ARTIFACT_DECLARATION_INVALID: ${raw.id??'stage'}.artifact_contract: ${recorded.error.message}`);
    return errors;
  }return[];
}
const schemaCache=new Map<string,{decisions:ReplayDecision[];classification:string}>();
const schemaRows=rawStages.map((row:any)=>{
  const digest=hash(JSON.stringify(row.stage));let result=schemaCache.get(digest);
  if(!result){const a=decision(()=>before.scheduler.parseDispatchedStageConfig(row.stage)),b=decision(()=>after.scheduler.parseDispatchedStageConfig(row.stage));const errors=formatErrors(row.stage),predicted=errors.join('; ');result={decisions:[a,b],classification:same(a,b)?'unchanged':errors.length&&b.status==='refused'&&b.error===(a.status==='refused'?`${a.error}; ${predicted}`:predicted)?'intended':'ambiguous_unpredicted'};schemaCache.set(digest,result);}
  return{source:row.source_path,runId:row.run_id,stageId:row.stage_id,line:row.line,digest,partial:!row.recorded_prompt_field,...result,rule:'new_input_declaration_required'};
});
const artifactRows=templates.map((row:any,index:number)=>{
  let template=referencedTemplate(row);if(row.project_dir)template=template.replaceAll(row.project_dir,project);if(row.run_dir)template=template.replaceAll(row.run_dir,directory);
  const inspect=(engine:typeof after)=>decision(()=>{const i={stageId:'recorded',template,projectDir:project,runDir:directory,writes:[]};const audit=engine.contract.inspectStageArtifactContract({...i,preimages:engine.contract.captureStageArtifactContractPreimages(i)});if(audit.replayExecutions.length)throw new Error('Stored command execution forbidden');return{obligations:audit.obligations,violations:audit.violations};});
  const a=inspect(before),b=inspect(after);const intended=b.status==='returned'&&key((b.value as any).obligations)==='[]'&&(b.value as any).violations.length===1&&(b.value as any).violations[0].reason===formatErrors({id:'recorded'})[0];
  return{index,templateHash:row.raw_sha256,contextState:row.context_state,occurrenceCount:row.occurrences.length,decisions:[a,b],classification:same(a,b)?'unchanged':intended?'intended':'ambiguous_unpredicted',rule:'prose_inference_removed_and_legacy_input_refused'};
});
function readsRequired(check:any):string{return`REALITY_READ_DECLARATION_REQUIRED: reality check ${JSON.stringify(check.name)}.reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration`;}
const checkRows=checks.map((row:any)=>{const text=frozen(row.path),a=decision(()=>before.checks.parseChecksFromMarkdown(text)),b=decision(()=>after.checks.parseChecksFromMarkdown(text));const predicted=a.status==='returned'?(a.value as any[]).map(check=>check.kind!=='invalid'&&check.reads===undefined?{kind:'invalid',name:check.name,type:'__invalid-reality-check-declaration__',diagnostic:readsRequired(check)}:check):undefined;return{source:row.path,runId:row.run_id,decisions:[a,b],classification:same(a,b)?'unchanged':b.status==='returned'&&key(predicted)===key(b.value)?'intended':'ambiguous_unpredicted',rule:'reality_reads_required'};});
function admission(engine:typeof after,raw:any):ReplayDecision{return decision(()=>{if(typeof raw==='string')raw=yaml(raw);const items=Array.isArray(raw)?raw:raw?.stages;if(!Array.isArray(items))throw new Error('No stage list in selected carrier');const stages=items.map((item:any)=>engine.scheduler.StageConfigSchema.parse(item));const report=engine.scheduler.inspectDispatchAdmission({dispatched:stages,baseStages:[],dispatchStageId:'plan'});return{pass:report.pass,errors:report.errors,warnings:report.warnings,terminalOwners:report.terminalOwners};});}
function admissionRow(row:any,raw:any){const a=admission(before,raw),b=admission(after,raw);let parsed=raw;try{if(typeof parsed==='string')parsed=yaml(parsed);}catch{parsed=undefined;}const items=Array.isArray(parsed)?parsed:parsed?.stages;const requiredErrors=Array.isArray(items)?items.filter(item=>after.declarations.RecordedArtifactContractSchema.safeParse(item.artifact_contract).success||!item.artifact_contract).flatMap(formatErrors):[];return{source:row.path??row.source_path,runId:row.run_id,line:row.line,decisions:[a,b],requiredErrors,classification:classifyDeclarationAdmissionChange({baseline:a,candidate:b,requiredErrors}),rule:'new_input_declaration_required_with_other_refusals_retained',context:'general core only'};}
const admissionRows=documents.map((row:any)=>admissionRow(row,frozen(row.path)));
const nativeRows=nativeDocs.map((row:any)=>admissionRow(row,corpus.nativeDocument(row)));
const realityRows=checks.map((row:any)=>{const markdown=frozen(row.path);const inspect=(engine:typeof after,text:string)=>decision(()=>engine.scheduler.inspectRealityCheckReachability({markdown:text,projectDir:project,runDir:directory,stages:[]}));const a=inspect(before,markdown),b=inspect(after,markdown),parsed=before.checks.parseChecksFromMarkdown(markdown);const requiredErrors=parsed.flatMap((check:any)=>check.kind==='invalid'?[check.diagnostic]:check.reads===undefined?[readsRequired(check)]:[]);const text='## Reality checks\n```yaml\n'+stringify({checks:parsed.filter((check:any)=>check.kind!=='invalid'&&check.reads!==undefined)})+'```\n';const declaredOnly=inspect(after,text);return{source:row.path,runId:row.run_id,decisions:[a,b],requiredErrors,declaredOnly,classification:classifyRealityDeclarationChange({baseline:a,candidate:b,declaredOnly,requiredErrors}),rule:'declared_reads_only_invalid_checks_refused',context:'empty-project producer projection'};});
const archivedPath=join(scratch,'recorded-artifact.json');
const auditRows=audits.map(row=>{const text=frozen(row.path);writeFileSync(archivedPath,text);const a=decision(()=>JSON.parse(text)),record=reader.readRecordedArtifactContract(archivedPath);const b=record.status==='readable'?decision(()=>record.record):{status:'refused'as const,error:record.reason};return{source:row.path,runId:row.run_id,decisions:[a,b],legacy:record.legacy,classification:same(a,b)?'unchanged':'ambiguous_unpredicted',rule:'recorded_audit_data_preserved'};});
const vd=join(project,'docs');mkdirSync(vd);
const verdictRows=verdicts.map(row=>{writeFileSync(join(vd,'verdict_recorded.json'),frozen(row.path));const a=decision(()=>before.scheduler.readGateVerdict(project,'recorded',undefined,null,false,false)),b=decision(()=>after.scheduler.readGateVerdict(project,'recorded',undefined,null,false,false));return{source:row.path,runId:row.run_id,decisions:[a,b],classification:same(a,b)?'unchanged':'ambiguous_unpredicted',context:'raw recorded verdict only'};});
const requirementRows=admissions.map(row=>{const text=frozen(row.path);const inspect=(engine:typeof after)=>decision(()=>{const report=JSON.parse(text);if(!Array.isArray(report.errors))throw new Error('Admission carrier has no errors array');return report.errors.map((error:string)=>engine.retry.planRetryRequirement(error));});const a=inspect(before),b=inspect(after);return{source:row.path,runId:row.run_id,decisions:[a,b],classification:same(a,b)?'unchanged':'ambiguous_unpredicted'};});
const facets:Record<string,any[]>={stage_schema:schemaRows,artifact_contracts:artifactRows,check_declarations:checkRows,general_admission:admissionRows,native_admission:nativeRows,reality_admission:realityRows,recorded_audits:auditRows,gate_verdicts:verdictRows,retry_requirements:requirementRows};
for(const[name,rows]of Object.entries(facets)){if(rows.length!==expected[name])throw new Error(`Population mismatch ${name}`);writeFileSync(join(output,`replay_${name}.json`),JSON.stringify(rows));}
const populations=Object.fromEntries(Object.entries(facets).map(([name,rows])=>[name,{expected:expected[name],processed:rows.length,unchanged:rows.filter(row=>row.classification==='unchanged').length,intended:rows.filter(row=>row.classification==='intended').length,ambiguous_unpredicted:rows.filter(row=>row.classification==='ambiguous_unpredicted').length}]));
const summary={version:3,at:new Date().toISOString(),populations,selections:sources,commandsExecuted:0,checksExecuted:0,limits:['Every selected relevant recognition/reader carrier replayed; absent original full admission context is censored.','Historical commands/scripts and model prompts were never executed.','Actual declared executions and registered private daemon/generation/recovery trials require their constructed evidence.'],differences:Object.fromEntries(Object.entries(facets).map(([name,rows])=>[name,rows.filter(row=>row.classification==='ambiguous_unpredicted')]))};
writeFileSync(join(output,'replay.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({populations,unpredicted:Object.values(populations).reduce((n,p)=>n+p.ambiguous_unpredicted,0)}));process.exitCode=Object.values(populations).some(p=>p.ambiguous_unpredicted>0)?2:0;
