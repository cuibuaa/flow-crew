import { expect, it, vi } from 'vitest';
import * as host from '../../dist-rewrite/host/process.js';
import { runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { join } from 'node:path';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
vi.mock('../../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/host/process.js')>(), observeRun:vi.fn(),
}));

it.each(['dead','live'] as const)('native unit entry distinguishes a %s predecessor while its own unit is active', async activation => {
  const f = await stateFixture(), worker = get(await host.beginOperation());
  try {
    await f.admit();
    await f.append(f.execution,[{type:'active_time_opened',interval:{id:'Prior',owner:worker.owner,
      openedAt:new Date().toISOString(),spentMs:null}},{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
    if (activation === 'dead') get(await host.endOperation(worker.owner));
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'active',owner:null,evidence:[],detail:'New unit activation'}});
    const result = await runUnitEntry(f.location,f.launch.unit,runServices(f),new AbortController().signal);
    if (activation === 'dead') {
      expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{status:'complete'}});
      expect((await f.projection()).intervals.find(i => i.id === 'Prior')).toMatchObject({closed:'unmeasured',spentMs:null});
      expect((await f.projection()).obligations).toEqual([]);
    } else {
      expect(result).toMatchObject({ok:false,kind:'conflict',detail:'Run owner is live'});
      expect(host.groupState(worker.owner)).toBe('live');
      expect((await f.projection()).status).toBe('running');
      expect((await f.projection()).intervals).toEqual([expect.objectContaining({id:'Prior',spentMs:null})]);
    }
  } finally { get(await host.endOperation(worker.owner)); await f.close(); }
});

it('public CLI resume re-requests an interrupted required command in the next gate attempt', async () => {
  const { runDeclaredCommand } = await import('../../dist-rewrite/exec/command.js');
  const { withState } = await import('../../dist-rewrite/records/state.js');
  const { workflowFixture } = await import('../fixtures/rewrite-workflow.js');
  const { pinRuntime } = await import('../../dist-rewrite/records/pin.js');
  const { spawn } = await import('node:child_process');
  const { wait } = await import('../fixtures/rewrite-host.js');
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const command = {id:'Check',argv:['nice','-n','19',process.execPath,'-e',
    "require('node:fs').writeFileSync('checked','fresh required execution')"],env:{},inputs:[],required:true};
  const graph = {stages:[{id:'gate',role:'author',purpose:'gate' as const,after:[],commands:[]}]};
  const f = await stateFixture({commands:[command]},graph);
  try {
    // Real source-built public CLI, immutable run pin and detached supervisor.
    // Its adapter executable is a test-owned protocol fixture, with no provider.
    const runtime=get(await pinRuntime(process.cwd(),f.location.storeRoot,'Continuation',f.configuration));
    Object.assign(f.runtime,runtime);
    Object.assign(f.scope.authority,{preferences:[{role:'author',backend:'codex',settings:{model:'fixture',effort:'low',source:{model:'role',effort:'role'}}}]});
    const bin=join(f.root,'bin');await mkdir(bin);
    await writeFile(join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs');const text=fs.readFileSync(0,'utf8');
const schema=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema')+1],'utf8'));
if(schema.properties.kind.const!=='gate'||fs.readFileSync('checked','utf8')!=='fresh required execution'||!/^- Check: exit 0, log /m.test(text))process.exit(7);
const answer={kind:'gate',answer:{outcome:'accepted',reason:'Fresh native command output reviewed',criteria:{correct:{status:'pass',evidence:'checked file and supplied direct exit zero'}},findings:[],remainingWork:[]}};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}}));
console.log(JSON.stringify({type:'turn.completed'}));
`,{mode:0o755});
    await f.admit();
    await f.releaseClaims();
    vi.mocked(host.observeRun).mockResolvedValue({ok:true,value:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Closed predecessor'}});
    const services=runServices(f);
    // Lose the native process receipt at the recording boundary. The command has
    // run, but its reservation cannot become a measured success or reach the gate.
    const interrupted=await runUnitEntry(f.location,f.launch.unit,{...services,
      configRoot:join(dirname(join(f.location.storeRoot,runtime.path)),'config'),
      workflowPorts(scope,writer,process,abort){
        const {ports}=workflowFixture({...f,scope,execution:writer});
        ports.command=async request=>{
          const result=await runDeclaredCommand(request,{scope,writer,abort,process:{...process,
          recordProcess:payload=>payload.type==='process'
            ? Promise.resolve({ok:false as const,kind:'unknown' as const,detail:'Fixture lost native receipt'})
            : process.recordProcess(payload)}});
          await f.append(writer,[{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:f.owner,evidence:[],detail:'Fixture activation ended'}}]);
          return result;
        };
        return ports;
      }},new AbortController().signal);
    expect(interrupted).toMatchObject({ok:false,kind:'unknown'});
    const before=await f.projection();
    expect(before).toMatchObject({status:'parked',conclusion:{reason:'recovery_unknown'}});
    expect(before.attempts).toHaveLength(0);expect(before.commands).toHaveLength(0);
    expect(before.reservations).toHaveLength(1);
    const prior=before.reservations[0],key=prior.key;
    expect(prior.invocation.address).toMatchObject({kind:'stage',stage:'gate'});
    expect(await readFile(join(f.project,'checked'),'utf8')).toBe('fresh required execution');
    const stored=()=>get(withState(f.database,false,db=>({ok:true,value:JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current))})));
    get(withState(f.database,true,db=>{
      const current=JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current));current.plan.plan.observations={retired:true};current.launch.plan.observations=null;
      db.prepare('UPDATE runs SET current=? WHERE root=?').run(JSON.stringify(current),f.journal.root);return {ok:true,value:true};
    }));
    expect(stored().plan.plan).toHaveProperty('observations');
    const stdout:string[]=[],stderr:string[]=[];
    const child=spawn('nice',['-n','19',process.execPath,new URL('../../dist-rewrite/cli.js',import.meta.url).pathname,'resume','Run'],
      {cwd:f.project,env:{PATH:bin+':/usr/bin:/bin',HOME:f.root,FC_HOME:dirname(f.database),FLOWCREW_STORE_ROOT:f.location.storeRoot},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>stdout.push(String(bytes)));child.stderr.on('data',bytes=>stderr.push(String(bytes)));
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    expect(exit,stderr.join('')).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({state:'acknowledged',intent:{kind:'resume'}});
    expect(stored().plan.plan).not.toHaveProperty('observations');
    expect(stored().launch.plan).not.toHaveProperty('observations');
    await wait(async()=>{const p=await f.projection();return !['pending','running'].includes(p.status);});
    const final=await f.projection();
    process.stdout.write('I3e continuation observation '+JSON.stringify({resumeExit:exit,resumes:final.intents.filter(intent=>intent.kind==='resume').length,gateAttempts:new Set(final.reservations.map(r=>r.invocation.address.kind==='stage'?r.invocation.address.attempt:null)).size,gateDispatches:final.attempts.length,commands:final.commands.length,status:final.status})+'\n');
    expect(final.status,JSON.stringify(final.conclusion)).toBe('complete');
    expect(final.intents.filter(intent=>intent.kind==='resume')).toHaveLength(1);
    expect(final.attempts).toHaveLength(1);
    expect(final.attempts[0].address.attempt).not.toBe(prior.invocation.address.kind==='stage'?prior.invocation.address.attempt:null);
    expect(final.commands).toHaveLength(1);expect(final.commands[0].key.execution!.id).not.toBe(key.execution!.id);
    expect(await readFile(join(f.project,'checked'),'utf8')).toBe('fresh required execution');
    expect(final.reservations.map(r=>r.state)).toEqual(['closed-unmeasured','committed']);
    expect(final.reservations[0]).toEqual({...prior,state:'closed-unmeasured'});
    expect(final.reservations[1].invocation.address).toEqual({kind:'stage',...final.attempts[0].address});
    process.stdout.write('I3e native evidence '+JSON.stringify({resumeExit:exit,resumes:1,gateAttempts:2,gateDispatches:final.attempts.length,commands:final.commands.length,
      status:final.status,historicalKeysRemoved:true})+'\n');
  } finally {
    const {readEvents,readProjection}=await import('../../dist-rewrite/records/state.js');
    const loaded=await readProjection(f.journal), owners=loaded.ok?[...loaded.value.owners.map(row=>row.owner),...get(await readEvents(f.journal,0)).flatMap(event=>
      event.payload.type==='run_observed'&&event.payload.observation.owner?[event.payload.observation.owner]:[])]:[];
    for(const owner of owners)get(await host.closeOperation(owner));
    expect(await Promise.all(owners.map(owner=>host.probeOwner(owner)))).toEqual(owners.map(()=> 'dead'));
    process.stdout.write('I3e cleanup '+JSON.stringify({owners:owners.length,alive:0})+'\n');
    await f.close();
  }
});


// One reuse rule for every command, required or not: a passing receipt on unchanged declared inputs and an unchanged tree is not run
// again by a later stage that schedules the same command; a tree changed by an author since makes it run again, in a new context.
it.each([['unchanged source','nothing',1],['an author change in between','author change',2]] as const)(
  'a newly scheduled command with a passing receipt is not run again on %s',async (_title,between,runs) => {
  const {runWorkflow} = await import('../../dist-rewrite/core/loop.js');
  const {workflowFixture} = await import('../fixtures/rewrite-workflow.js');
  const {writeFile} = await import('node:fs/promises');
  const {readEvidence} = await import('../../dist-rewrite/records/evidence.js');
  const {runDeclaredCommand} = await import('../../dist-rewrite/exec/command.js');
  const command = {id:'Check',argv:[process.execPath,'-e',
    "process.stdout.write(require('fs').readFileSync(process.argv[1]))",'../host-state'],env:{},inputs:[],required:false};
  // The synthetic work stage writes a file into the project: that is the author change.
  const gates = [{id:'progress',role:'author',purpose:'gate' as const,after:between === 'author change' ? ['work'] : [],commands:['Check']},
    {id:'gate',role:'author',purpose:'gate' as const,after:between === 'author change' ? ['later'] : ['progress'],commands:['Check']}];
  const graph = {stages:between === 'author change' ? [{id:'work',role:'author',purpose:'work' as const,after:[],instruction:'Work'},gates[0],
    {id:'later',role:'author',purpose:'work' as const,after:['progress'],instruction:'Later'},gates[1]] : gates};
  const f = await stateFixture({commands:[command]},graph);
  try {
    await f.admit();
    const {ports} = workflowFixture(f), native = ports.attempt, requests: any[] = [];
    const marker = join(f.project,'..','host-state');
    await writeFile(marker,'first host observation');
    ports.command = async request => {requests.push(request);return runDeclaredCommand(request,{
      scope:f.scope,writer:f.execution,process:runServices(f).process(f.execution),abort:new AbortController().signal});};
    ports.attempt = async request => {
      if (request.stage.id === 'later') await writeFile(marker,'second host observation');
      return native(request);
    };
    expect(get(await runWorkflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal}))).toMatchObject({status:'complete'});
    expect(requests).toHaveLength(runs);
    expect((await f.projection()).reservations.map(r => r.state)).toEqual(Array(runs).fill('committed'));
    const receipts = (await f.projection()).commands;
    expect(await Promise.all(receipts.map(async receipt => Buffer.from(get(await readEvidence(f.journal,receipt.stdout))).toString())))
      .toEqual(runs === 1 ? ['first host observation'] : ['first host observation','second host observation']);
    if (runs === 2) expect(requests[0].key.execution.id).not.toBe(requests[1].key.execution.id);
  } finally {await f.close();}
});

it.each(['native-signal','lost-native-exit'] as const)('records %s without inventing command success', async ending => {
  const {readFile,access} = await import('node:fs/promises');
  const {identifyCommand,runDeclaredCommand} = await import('../../dist-rewrite/exec/command.js');
  const {reserveCommand} = await import('../../dist-rewrite/records/state.js');
  const {wait} = await import('../fixtures/rewrite-host.js');
  const command = {id:'Check',argv:[process.execPath,'-e',
    "require('fs').writeSync(1,'retained bytes');require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
    '../ready'],env:{},inputs:[],required:true};
  const f = await stateFixture({commands:[command]});
  let running: ReturnType<typeof runDeclaredCommand> | undefined, owner: any;
  try {
    await f.admit();
    const key = get(await identifyCommand(command,f.scope));
    const reservation = get(await reserveCommand(f.execution,(await f.projection()).cursor,'Check',key,
      {charge:'command',address:{kind:'final',run:'Run'}}));
    const ports = runServices(f).process(f.execution), record = ports.recordProcess;
    ports.recordProcess = async payload => {if(payload.type === 'ownership') owner=payload.owner;return record(payload);};
    running = runDeclaredCommand({command,key,reservation},{scope:f.scope,writer:f.execution,process:ports,abort:new AbortController().signal});
    const ready = join(f.project,'..','ready');
    await wait(async () => access(ready).then(() => true,() => false),running);
    const child = Number(await readFile(ready,'utf8'));
    await wait(async () => !!owner?.members?.some(m => m.pid === child),running);
    process.kill(ending === 'native-signal' ? child : owner.pid,ending === 'native-signal' ? 'SIGTERM' : 'SIGKILL');
    const receipt = get(await running);
    expect(receipt.execution).toEqual(ending === 'native-signal'
      ? {state:'unfinished',reason:'signalled',signal:'SIGTERM'} : {state:'unfinished',reason:'closure_unknown'});
    expect(host.groupState(owner)).toBe('dead');
    expect((await f.projection()).commands).toEqual([receipt]);
    const {readEvidence} = await import('../../dist-rewrite/records/evidence.js');
    expect(Buffer.from(get(await readEvidence(f.journal,receipt.stdout))).toString()).toBe('retained bytes');
    const again = get(await runDeclaredCommand({command,key,reservation},{scope:f.scope,writer:f.execution,process:ports,abort:new AbortController().signal}));
    expect(again).toEqual(receipt);
  } finally {if(owner) get(await host.endOperation(owner));if(running) await running;await f.close();}
});


it('historical current state reads back after one continuation write without retired keys', async () => {
  const {withState}=await import('../../dist-rewrite/records/state.js');
  const f=await stateFixture();
  try {
    await f.admit();
    await f.append(f.execution,[{type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Historical stop'}}]);
    const before=await f.projection();
    const stored=()=>get(withState(f.database,false,db=>({ok:true,value:JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current))})));
    get(withState(f.database,true,db=>{
      const current=JSON.parse(String(db.prepare('SELECT current FROM runs WHERE root=?').get(f.journal.root)!.current));
      current.plan.plan.observations={retired:true};current.launch.plan.stages[0].skills=null;
      db.prepare('UPDATE runs SET current=? WHERE root=?').run(JSON.stringify(current),f.journal.root);return {ok:true,value:true};
    }));
    expect(stored().plan.plan).toHaveProperty('observations');expect(stored().launch.plan.stages[0]).toHaveProperty('skills');
    await f.append(f.control,[{type:'control_intent',intent:{id:'HistoricalResume',kind:'resume',run:f.launch.run,
      unit:f.launch.unit,expectedCursor:before.cursor}}]);
    const after=await f.projection();
    expect(after.cursor).toBe(before.cursor+1);expect(after.status).toBe('pending');expect(after.plan).toEqual(before.plan);
    expect(stored().plan.plan).not.toHaveProperty('observations');expect(stored().launch.plan.stages[0]).not.toHaveProperty('skills');
    process.stdout.write('I3d historical evidence '+JSON.stringify({writes:1,cursorDelta:after.cursor-before.cursor,status:after.status,retiredKeysRemoved:true})+'\n');
  } finally {await f.close();}
});
