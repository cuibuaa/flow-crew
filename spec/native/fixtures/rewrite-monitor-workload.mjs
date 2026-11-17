// Model-free operation fixture: the real portable supervisor and confined Node workload.
import {join} from 'node:path';
import {claim,openWriter,appendEvents,readEvents,readProjection,putEvidence,storeEvidence,recordOperation,release}
  from '../../../dist-rewrite/records/state.js';
import {readEvidence} from '../../../dist-rewrite/records/evidence.js';
import {launchInvocation,closeController} from '../../../dist-rewrite/host/process.js';
const input=JSON.parse(process.argv[2] ?? 'null');
if (input === null) process.exit(0);
const journal=input.journal;
const get=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value;};
const held=get(await claim(join(journal.root,'execution'),input.unit,{database:journal.database,holder:journal.root}));
const writer=get(await openWriter(journal,held,'execution'));
let serial=Promise.resolve();
const append=payload=>{
  const result=serial.then(async()=>appendEvents(writer,get(await readEvents(journal,0)).at(-1)?.seq??0,[payload]));
  serial=result;return result;
};
const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());
const address={kind:'stage',run:input.unit.run,stage:'work',attempt:'MonitorWork',invocation:1};
get(await append({type:'invocation_reserved',invocation:{charge:'work',address}}));
const ports={scratch:input.scratch,streamRoot:journal.root,
  recordController:async owner=>append({type:'run_observed',observation:{unit:input.unit,state:'active',owner,evidence:[],detail:'Synthetic controller group'}}),
  recordProcess:append,putEvidence:bytes=>putEvidence(journal,bytes),storeEvidence:source=>storeEvidence(journal,source),
  readEvidence:ref=>readEvidence(journal,ref),operation:request=>recordOperation(journal,'construct',request)};
try {
  const code="const fs=require('fs');process.stdout.write('raw-before-cancel\\n');process.stderr.write('raw-stderr\\n');fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)";
  const receipt=get(await launchInvocation({writableRoots:[input.project],protectedRoots:[journal.root]},
    {argv:[process.execPath,'-e',code,input.marker],cwd:input.project,env:{PATH:process.env.PATH,HOME:input.home},writableRoots:[input.project]},
    ports,abort.signal));
  // The process receipt is intentionally later than the committed cancel fence.
  const projection=get(await readProjection(journal));
  process.exitCode=projection.status==='cancelled'&&receipt.stdout ? 0:1;
} finally {await release(held,'handoff');await closeController();}
