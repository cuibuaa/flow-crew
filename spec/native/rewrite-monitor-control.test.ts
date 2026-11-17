import {wait} from '../fixtures/rewrite-host.js';
import {stateFixture,get as known} from '../fixtures/rewrite-state.js';
import {cancelWithCli} from '../../dist-monitor/rewrite-monitor/cli.js';
import {publishRunStatus} from '../../dist-rewrite/ops/status.js';
import {startRun,closeController,ownIdentity,endOperation,closeOperation,probeOwner} from '../../dist-rewrite/host/process.js';
import {claim,release,openWriter,appendEvents,readEvents,readHostState,releaseRunResources,withState} from '../../dist-rewrite/records/state.js';
import {readEvidence} from '../../dist-rewrite/records/evidence.js';
import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import type {Server} from 'node:http';
import {it,expect,vi} from 'vitest';
import {startMonitor} from '../../rewrite-monitor/server.js';
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, createServer: (handler: any) => {
      const server = actual.createServer(handler);
      server.listen = vi.fn((port, host, ready) => {
        server.address = () => ({ address: host, port, family: 'IPv4' });
        ready();
        return server;
      }) as typeof server.listen;
      server.close = ((done: any) => { done(); return server; }) as typeof server.close;
      return server;
    } };
});
function get(server: Server, method = 'GET', path = '/', headers = {}): Promise<{
  code: number | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}> {
  return new Promise(resolveResponse => {
    const request = { method, url: path, headers };
    if (method === 'CONNECT' || 'Upgrade' in headers) {
      server.emit(method === 'CONNECT' ? 'connect' : 'upgrade', request, { end: (raw: string) => {
          const lines = raw.split('\r\n'), code = Number(lines[0].split(' ')[1]);
          const parsed = Object.fromEntries(lines.slice(1).filter(line => line.includes(':'))
            .map(line => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
          resolveResponse({ code, headers: parsed, body: '' });
        } });
    }
    else {
      let code: number, resultHeaders: Record<string, string>;
      const response = { writeHead: (status: number, values: Record<string, string>) => {
          code = status;
          resultHeaders = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
          return response;
        }, end: (body = '') => resolveResponse({ code, headers: resultHeaders, body }) };
      server.emit('request', request, response);
    }
  });
}
it('monitor Cancel reaches source-built CLI, committed fence, real host closure and raw late receipts; repeated terminal cancellation is idempotent and unknown resources remain held',async({signal})=>{
  const f=await stateFixture();let server:Server|undefined;
  try {
    await f.admit();await f.releaseClaims();
    const held=known(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const writer=known(await openWriter(f.journal,held,'control'));
    const recordProcess=async(payload:any)=>appendEvents(writer,known(await readEvents(f.journal,0)).at(-1)?.seq??0,[payload]);
    const marker=join(f.project,'ready'),scratch=join(f.root,'scratch');mkdirSync(scratch);
    const input={journal:f.journal,unit:f.launch.unit,project:f.project,scratch,marker,home:f.root};
    const started=known(await startRun(f.launch.unit,{argv:[process.execPath,resolve('spec/native/fixtures/rewrite-monitor-workload.mjs'),JSON.stringify(input)],cwd:f.project,
      env:{PATH:process.env.PATH!},writableRoots:[]},
      {recordProcess} as any,{...f.unitContext,pending:async()=>({ok:true,value:known(readHostState(f.journal)).pending}),
        observation:async()=>({ok:true,value:known(readHostState(f.journal)).observation})}));
    known(await release(held,'handoff'));
    await wait(async()=>{
      if(lstatExists(marker))return true;
      const observed=known(readHostState(f.journal));
      const receipt=known(await readEvents(f.journal,0)).find(e=>e.payload.type==='process');
      if(receipt || !started.owner || await probeOwner(started.owner)!=='live')
        throw Error('Workload ended before readiness: '+JSON.stringify({observed,receipt}));
      return false;
    },undefined,signal);
    const status=known(publishRunStatus(f.location,new Date().toISOString(),null));
    const adapter=cancelWithCli(resolve('dist-rewrite/cli.js'),{...process.env,FC_HOME:dirname(f.database),HOME:f.root});
    let calls=0;
    server=await startMonitor({storeRoots:[f.location.storeRoot],port:0,cancel:async(location,snapshot)=>{calls++;return adapter(location,snapshot);}});
    const origin={host:'127.0.0.1:1234',origin:'http://127.0.0.1:1234'};
    const html=await get(server);expect(html.body).toContain('class="cancel"');
    expect((await get(server,'POST','/cancel/0/Run',{...origin,origin:'http://foreign'})).code).toBe(403);
    for(const path of ['/cancel/3/Run','/cancel/0/../Run','/cancel/0/Foreign','/cancel/0/Run?argv=bad'])
      expect([400,404]).toContain((await get(server,'POST',path,origin)).code);
    expect(calls).toBe(0);
    const cancelled=await get(server,'POST','/cancel/0/Run',origin);
    const diagnostic=join(f.root,'cancel-diagnostics');mkdirSync(diagnostic,{recursive:true});writeFileSync(join(diagnostic,'diagnostic.json'),JSON.stringify({cancelled,events:known(await readEvents(f.journal,0))},null,2));
    expect(cancelled.code,cancelled.body).toBe(200);expect(cancelled.body).toContain('CLI exit 0');expect(calls).toBe(1);
    await wait(async()=>known(readHostState(f.journal)).pending.length===0,undefined,signal);
    const events=known(await readEvents(f.journal,0));
    const fence=events.find(e=>e.payload.type==='control_intent'&&e.payload.intent.kind==='cancel')!;
    const receipts=events.filter(e=>e.seq>fence.seq&&e.payload.type==='process');expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.map((e:any)=>e.payload.receipt.state)).toEqual(receipts.map(()=> 'closed'));
    const streams=await Promise.all(receipts.map(async(e:any)=>Buffer.from(known(await readEvidence(f.journal,e.payload.receipt.stdout))).toString()));
    expect(streams.join('')).toContain('raw-before-cancel');
    expect(known(readHostState(f.journal)).pending).toEqual([]);
    expect((await get(server)).body).toContain('data-status="cancelled"');
    const stale=await adapter(f.location,status);expect(stale.exit,stale.stdout+stale.stderr).toBe(0);
    const terminal=await get(server,'POST','/cancel/0/Run',origin);expect(terminal.body).toContain('CLI exit');
    // The existing owner protects foreign/unknown groups; the UI never frees resource extents.
    const owner={...await ownIdentity(),start:'foreign-birth',authority:'foreign-authority',streams:{stdout:join(f.journal.root,'unknown-out'),stderr:join(f.journal.root,'unknown-err')}};
    const heldAgain=known(await claim(join(f.journal.root,'control'),f.launch.unit,{database:f.database,holder:f.journal.root}));
    const freshWriter=known(await openWriter(f.journal,heldAgain,'control'));
    known(await appendEvents(freshWriter,known(await readEvents(f.journal,0)).length,[{type:'ownership',owner,state:'unknown'}]));
    known(await release(heldAgain,'handoff'));known(publishRunStatus(f.location,new Date().toISOString(),null));
    const count=()=>known(withState(f.database,false,db=>({ok:true,value:Number(db.prepare('SELECT count(*) AS n FROM resources').get()!.n)})));
    const before=count();const unknown=await get(server,'POST','/cancel/0/Run',origin);
    expect(unknown.code,unknown.body).toBe(409);expect(unknown.body).toContain('CLI exit 3');
    expect(releaseRunResources(f.journal).ok).toBe(false);expect(count()).toBe(before);
    const evidence=join(f.root,'cancel-diagnostics');mkdirSync(evidence,{recursive:true});
    writeFileSync(join(evidence,'result.json'),JSON.stringify({cancelled,stale,terminal,unknown,fence,receipts,streams,resources:before},null,2));
  } finally {
    if(server)await new Promise<void>(done=>server!.close(()=>done()));
    const remaining=readHostState(f.journal);if(remaining.ok){for(const owner of remaining.value.pending)await endOperation(owner);if(remaining.value.observation?.owner)await closeOperation(remaining.value.observation.owner);}
    await closeController();await f.close();
  }
});
function lstatExists(path:string){try{return lstatSync(path).isFile();}catch{return false;}}
