import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {publicTestTimeoutMs} from './public-cli.mjs';

/** One public same-store witness; every lifecycle action uses the executable. */
export async function publicRetention(packageRoot, evidenceDirectory, signal) {
  const root=await fs.mkdtemp(join(tmpdir(),'public-retention-'));
  const source=join(root,'source'),bin=join(root,'bin'),home=join(root,'home'),store=join(root,'store'),external=join(root,'external');
  for(const path of [source,bin,home,external])await fs.mkdir(path);
  const state=await import(pathToFileURL(join(packageRoot,'dist-rewrite/records/state.js')).href);
  const host=await import(pathToFileURL(join(packageRoot,'dist-rewrite/host/process.js')).href);
  const env={PATH:bin+':'+process.env.PATH,HOME:home,CODEX_HOME:join(home,'.codex'),FC_HOME:join(root,'state'),FLOWCREW_STORE_ROOT:store,
    RETENTION_ROOT:root,RETENTION_EXTERNAL:external,NODE_NO_WARNINGS:'1'};
  const children=new Set(),runs=[],cli=[];let cleaning=false;
  const invoke=async args=>{
    if(!cleaning)signal?.throwIfAborted();
    const t=performance.now();const child=spawn('nice',['-n','19',process.execPath,join(packageRoot,'dist-rewrite/cli.js'),...args],{cwd:source,env,stdio:['ignore','pipe','pipe']});
    children.add(child);const cancel=()=>{child.kill('SIGKILL');};if(!cleaning)signal?.addEventListener('abort',cancel,{once:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});children.delete(child);signal?.removeEventListener('abort',cancel);if(!cleaning)signal?.throwIfAborted();
    const result={args,exit,ms:performance.now()-t,stdout,stderr};cli.push(result);return result;
  };
  const value=result=>{assert(result.ok,JSON.stringify(result));return result.value;};
  const projection=async run=>value(await state.readProjection({database:join(root,'state','state.sqlite'),root:join(store,'runs',run)}));
  // Shared history-derived public backstop; only this fixture's current rows are polled.
  const until=async probe=>{const t=performance.now();for(;;){if(!cleaning)signal?.throwIfAborted();if(await probe())return;assert(performance.now()-t<publicTestTimeoutMs,'fixture backstop');await new Promise(r=>setTimeout(r,25));}};
  const report={root,cli};
  try {
    await fs.writeFile(join(source,'changed'),'checkpoint bytes');
    await fs.copyFile(new URL('./provider-protocol.mjs',import.meta.url),join(bin,'provider-protocol.mjs'));
    await fs.writeFile(join(bin,'codex'),`#!${process.execPath}
import fs from 'node:fs';import {join} from 'node:path';import {providerProtocol,nativePrompt} from './provider-protocol.mjs';
await providerProtocol('codex',async message=>{
const p=nativePrompt('codex',message);
const kind=p.stage.purpose,root=process.env.RETENTION_ROOT,external=process.env.RETENTION_EXTERNAL;
let answer;
if(kind==='work'){
  const label=fs.existsSync(join(root,'run-A-started'))?'B':'A';
  fs.writeFileSync(join(p.project,'changed'),label+' changed bytes');fs.writeFileSync(join(p.project,'new'),label+' new bytes');fs.writeFileSync(join(external,'result'),label+' external bytes');
  if(label==='A'){fs.writeFileSync(join(root,'run-A-started'),'yes');await new Promise(()=>setInterval(()=>{},1000));}
  answer={status:'delivered',summary:'Wrote B bytes',caveats:[],remainingWork:[],blocks:null};
}else{if(fs.readFileSync(join(external,'result'),'utf8')!=='B external bytes')throw Error('B bytes missing');answer={outcome:'accepted',reason:'Observed B bytes',criteria:{correct:{status:'pass',evidence:'B external bytes'}},findings:[],remainingWork:[]};}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({kind,answer})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:7,cached_input_tokens:0}}));
});
`,{mode:0o755});
    const declaration={criteria:[{id:'correct',text:'Deliver bytes'}],inputs:[],outputs:[{path:'changed',kind:'file',existing:'replace'},{path:'new',kind:'file',existing:'replace'},{path:external,kind:'directory',existing:'replace'}],commands:[],results:[],allowBlocked:false};
    const brief=join(root,'brief.md'),config=join(root,'runtime.json');
    await fs.writeFile(brief,'---\n'+JSON.stringify(declaration)+'\n---\nWrite outputs.\n');
    await fs.writeFile(config,JSON.stringify({roles:['plan','work','gate'].map(id=>({id,description:id,prompt:'Return '+id+' result',backend:'codex',model:'synthetic',effort:'low'}))}));
    const start=async()=>{const prepared=await invoke(['setup',brief,'--project',source,'--config',config,'--backend','codex']);
      return prepared.exit===0?invoke(['start',JSON.parse(prepared.stdout).run]):prepared;};
    const a=await start();assert.equal(a.exit,0,a.stderr);const runA=JSON.parse(a.stdout).run;runs.push(runA);
    await until(()=>fs.access(join(root,'run-A-started')).then(()=>true,()=>false));
    const cancelled=await invoke(['cancel',runA]);assert.equal(cancelled.exit,0,JSON.stringify(cancelled));
    await until(async()=>{const p=await projection(runA);return p.status==='cancelled'&&p.owners.every(row=>row.state==='dead');});
    // Reconcile after the controller closes; active activation never authorizes retirement.
    await until(async()=>{const observation=value(state.readHostState({database:join(root,'state','state.sqlite'),root:join(store,'runs',runA)})).observation;
      return !observation?.owner||await host.probeOwner(observation.owner)==='dead';});
    const closed=await invoke(['cancel',runA]);assert.equal(closed.exit,0,closed.stderr);
    await until(async()=>{const p=await projection(runA);return p.outputs.some(receipt=>receipt.released?.includes(external));});
    const b=await start();assert.equal(b.exit,0,b.stderr);const runB=JSON.parse(b.stdout).run;runs.push(runB);
    await until(async()=>['complete','failed','parked','incomplete'].includes((await projection(runB)).status));
    assert.equal((await projection(runB)).status,'complete',JSON.stringify(await projection(runB)));
    await until(async()=>{const p=await projection(runB);return p.owners.every(row=>row.state==='dead');});
    const reclaimed=await invoke(['land',runA]);assert.equal(reclaimed.exit,0,reclaimed.stderr);assert.match(JSON.parse(reclaimed.stdout).outputs.detail,/Unreviewed/);
    const repeat=await invoke(['land',runA]);assert.equal(repeat.exit,0,repeat.stderr);
    assert.deepEqual(JSON.parse(reclaimed.stdout).outputs.artifacts,JSON.parse(repeat.stdout).outputs.artifacts);
    const delivery=JSON.parse(reclaimed.stdout).delivery;
    const manifest=JSON.parse(await fs.readFile(join(delivery,'manifest.json'),'utf8'));
    const externalEntry=manifest.outputs.find(row=>row.path===external);
    const archived=await Promise.all([join(delivery,'project','changed'),join(delivery,'project','new'),join(delivery,externalEntry.archive,'result')].map(path=>fs.readFile(path)));
    assert.deepEqual(archived.map(bytes=>bytes.toString()),['A changed bytes','A new bytes','A external bytes']);
    // The way back: the delivery's patch, applied with git to a copy of the source project, yields the delivered relative outputs.
    const applied=join(root,'applied');await fs.cp(source,applied,{recursive:true});
    const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
    assert.equal(spawnSync('git',['init','-q'],{cwd:applied,env:gitEnv}).status,0);
    const patched=spawnSync('git',['apply',join(delivery,'changes.patch')],{cwd:applied,encoding:'utf8',env:gitEnv});assert.equal(patched.status,0,patched.stderr);
    assert.deepEqual(await Promise.all(['changed','new'].map(name=>fs.readFile(join(applied,name),'utf8'))),['A changed bytes','A new bytes']);
    assert.equal(await fs.readFile(join(external,'result'),'utf8'),'B external bytes');
    assert.equal((await projection(runA)).status,'cancelled');
    report.ok=true;report.retainedBytes=archived.reduce((sum,bytes)=>sum+bytes.length,0);report.runBStatus='complete';
    return report;
  }finally{
    cleaning=true;
    const database=join(root,'state','state.sqlite');
    const listed=await fs.stat(database).then(()=>state.listProjections(store,database),()=>undefined);
    const locations=listed?.ok?listed.value.map(row=>row.location):runs.map(run=>({database,storeRoot:store,run}));
    report.cleanupOwners=[];report.remainingOwners=[];
    for(const location of locations){try{
      await invoke(['cancel',location.run]);
      const journal=value(await state.openJournal(location,'read'));
      const activation=value(state.readHostState(journal)).observation?.owner;
      if(activation){try{value(await host.closeOperation(activation));}catch(error){report.cleanupError=String(error);}}
      const p=await projection(location.run),owners=[...(activation?[activation]:[]),...p.owners.map(row=>row.owner)];
      report.cleanupOwners.push(...owners);
      for(const owner of owners){try{value(await host.closeOperation(owner));}catch(error){report.cleanupError=String(error);}}
      value(await state.reclaimRecordOperations(journal));
      report.remainingOwners.push(...await Promise.all(owners.map(owner=>host.probeOwner(owner))));
    }catch(error){report.cleanupError=String(error);}}
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}
    if(evidenceDirectory){await fs.mkdir(evidenceDirectory,{recursive:true});await fs.writeFile(join(evidenceDirectory,'public-retention.json'),JSON.stringify(report,null,2));}
    await fs.rm(root,{recursive:true,force:true});
    assert(!report.cleanupError,report.cleanupError);
    assert(report.remainingOwners.every(state=>state==='dead'),'no retention fixture survivors');
  }
}
