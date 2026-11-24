import {observeStatus} from '../../rewrite-src/host/identity.mjs';
import {spawn} from 'node:child_process';
import {get as request} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {stateFixture,get} from '../fixtures/rewrite-state.js';
import {identity,groupState} from '../../dist-rewrite/host/process.js';
import {main} from '../../dist-rewrite/ops/main.js';
import {publishRunStatus,refreshRunStatus,readRunStatus} from '../../dist-rewrite/ops/status.js';
import {statusLabel,parsePublicRunStatus} from '../../rewrite-src/contract/status.mjs';
import {startMonitor} from '../../dist-monitor/rewrite-monitor/server.js';
import {runHook,observe} from '../../dist-rewrite/flowcrew-session.mjs';

it('one controller identity drives CLI single/list, published v4, monitor and hook while a helper survives',async()=>{
  const f=await stateFixture(); await f.admit();
  const child=spawn('nice',['-n','19','python3','-I','-S','-B',resolve('spec/native/fixtures/rewrite-status-controller.py')],{stdio:['pipe','pipe','pipe']});
  let buffer='',stderr=''; const messages:any[]=[],waiters:((v:any)=>void)[]=[];
  child.stdout.on('data',bytes=>{buffer+=bytes; for (;;) {const end=buffer.indexOf('\n');if(end<0)break;
    const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const waiter=waiters.shift();if(waiter)waiter(value);else messages.push(value);}});
  child.stderr.on('data',bytes=>{stderr+=bytes;});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise<any>(done=>waiters.push(done));
  const ended=new Promise<number|null>((done,reject)=>{child.once('close',done);child.once('error',reject);});
  const server=await startMonitor({storeRoots:[f.location.storeRoot],port:0});
  const config={storeRoots:[f.location.storeRoot],tasksRoot:join(f.root,'synthetic-tasks')};
  const html=()=>new Promise<string>((done,reject)=>{request(`http://127.0.0.1:${(server.address() as any).port}/`,r=>{
    let text='';r.on('data',b=>{text+=b;});r.on('end',()=>done(text));}).on('error',reject);});
  const cli=async(single:boolean)=>{let stdout='',error=''; const exit=await main(single?['status','Run']:['status'],{
    cwd:f.root,storeRoot:f.location.storeRoot,home:dirname(f.database),runtimeRoot:resolve('dist-rewrite'),environment:{},
    stdin:new Uint8Array(),abort:new AbortController().signal,stdout:async b=>{stdout+=Buffer.from(b);},stderr:async b=>{error+=Buffer.from(b);}});
    expect(exit,error).toBe(0);const value=JSON.parse(stdout);return single?value:get(value[0]);};
  try {
    const pids=await next(),helper=await identity(pids.helper),owner={...await identity(pids.controller),authority:'synthetic-controller',
      members:[{pid:helper.pid,start:helper.start,boot:helper.boot}]};
    const invocation={charge:'command' as const,address:{kind:'stage' as const,run:'Run',stage:'work',attempt:'CommandPhase',invocation:1}};
    await f.append(f.execution,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner,evidence:[],detail:'Synthetic controller'}},
      {type:'invocation_reserved',invocation},{type:'command_reserved',reservation:{identity:'VerifyDeclared',invocation,state:'reserved',
        key:{tree:'a'.repeat(64),declaration:'b'.repeat(64),inputHashes:[],context:'c'.repeat(64)}}}]);
    for (const mode of ['live','dead','reboot','unknown'] as const) {
      if(mode==='dead'){child.stdin.write('kill\n');expect(await next()).toEqual({dead:true});expect(groupState(owner)).toBe('live');}
      if(mode==='reboot')await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',
        owner:{...owner,boot:'previous-boot'},evidence:[],detail:'Synthetic prior boot'}}]);
      if(mode==='unknown')await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'unknown',owner:null,evidence:[],detail:'Identity unavailable'}}]);
      const label=mode==='live'?'running':mode==='dead'?'interrupted':mode==='reboot'?'interrupted by restart':'unknown';
      if(mode==='dead') {
        // Kill first, then read the stale producer file directly: no CLI refresh may help either consumer.
        const before=await readFile(join(f.journal.root,'status.json'),'utf8');
        expect(JSON.parse(before).status).toBe('running');
        const stalePage=await html();expect(stalePage).toContain('data-status="interrupted"');
        expect(stalePage).not.toContain('aria-label="Running"');
        expect(stalePage).not.toContain('Historical workflow snapshot');
        expect(stalePage).not.toContain('data-label="Now">Command VerifyDeclared</td>');
        const staleLine=await runHook({session_id:'status-session'},config,'--statusline');
        expect(staleLine.stdout).toContain('Run interrupted');expect(staleLine.stdout).not.toContain('now Command VerifyDeclared');
        expect((await observe(config,'status-session','Wake')).reports[0]?.status.status).toBe('interrupted');
        expect(await readFile(join(f.journal.root,'status.json'),'utf8')).toBe(before);
      }
      get(publishRunStatus(f.location,new Date().toISOString(),null)); // The fixture owns the SQL writes above.
      const beforeCli=await readFile(join(f.journal.root,'status.json'),'utf8');
      const single=await cli(true),list=await cli(false),file=get(readRunStatus(f.location));
      expect(await readFile(join(f.journal.root,'status.json'),'utf8')).toBe(beforeCli);
      const observedFile=await observeStatus(file);
      expect(file).toMatchObject({status:'running',currentStage:'work',focus:'work'});
      for(const snapshot of [single,list,observedFile]) {
        expect(statusLabel(snapshot)).toBe(label);expect(snapshot.step.label).toBe(mode==='live'?'Command VerifyDeclared':null);expect(snapshot.currentStage).toBe(mode==='live'?'work':null);
        expect(snapshot.status).toBe(mode==='live'?'running':mode==='unknown'?'unknown':'interrupted');expect(snapshot.journalStatus).toBe('running');
        expect(parsePublicRunStatus(snapshot).ok).toBe(true);
        if(mode!=='live')expect(snapshot.step.elapsedMs).toBeNull();
      }
      const bound={...file,requester:'claude:status-session',notification:{...file.notification,session:'bound'}};
      await writeFile(join(f.journal.root,'status.json'),JSON.stringify(bound));
      const before=await readFile(join(f.journal.root,'status.json'),'utf8');
      const page=await html(); expect(page).toContain(`data-status="${observedFile.status}"`);
      expect(page).toContain(`aria-label="${label === 'running' ? 'Running' : label === 'unknown' ? 'Unknown' : label}"`);
      if(mode!=='live')expect(page).not.toContain('data-status="running"');
      if(mode==='live')expect(page).toContain('data-stage="work"');
      const line=await runHook({session_id:'status-session'},config,'--statusline');expect(line.stderr).toBe('');
      expect(line.stdout).toContain(mode==='live'?`Run ${label}/work; now Command VerifyDeclared`:`Run ${label}`);
      if(mode!=='live')expect(line.stdout).not.toContain('now Command VerifyDeclared');
      expect(line.stdout).not.toContain('unconfined');
      const wake=await observe(config,'status-session','Wake');expect(wake.kind).toBe(mode==='live'||mode==='dead'?'wait':'report');
      expect((await observe(config,'status-session','Wake')).kind).toBe('wait');
      expect(await readFile(join(f.journal.root,'status.json'),'utf8')).toBe(before);
    }
    const live=get(await refreshRunStatus(f.location,new Date().toISOString()));
    const unavailable=await observeStatus({...live,host:{...live.host,activation:{owner,state:'active',checkedAt:null}},attention:null},
      owner.boot,async()=>{throw Object.assign(new Error('Synthetic unavailable observation'),{code:'EPERM'});});
    expect(statusLabel(unavailable)).toBe('unknown');expect(unavailable.interruption).toBeUndefined();
  } finally {
    child.stdin.end('close\n');expect(await ended,stderr).toBe(0);
    await new Promise<void>((done,reject)=>{server.close(e=>e?reject(e):done());server.closeAllConnections();});
    await f.close();
  }
});
