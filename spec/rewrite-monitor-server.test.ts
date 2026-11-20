import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { METHODS } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { startMonitor } from '../dist-monitor/rewrite-monitor/server.js';
import { parseRunStatusFile,type RunStatusFile } from '../rewrite-src/contract/runtime.js';
import { identity } from '../rewrite-src/host/identity.mjs';
const controller = {...await identity(),authority:'synthetic'};
import { wireStatus } from './fixtures/rewrite-status.js';
const bound = vi.hoisted(() => ({ server: null as Server | null }));
// Exercise the real handlers and their Node bind arguments without opening a network service.
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, createServer: (handler: any) => {
      const server = actual.createServer(handler);
      server.listen = vi.fn((port, host, ready) => {
        bound.server = server;
        server.address = () => ({ address: host, port, family: 'IPv4' });
        ready();
        return server;
      }) as typeof server.listen;
      server.close = ((done?: () => void) => { server.emit('close'); done?.(); return server; }) as typeof server.close;
      return server;
    } };
});
const reasons = {
  pending: null, running: null, parked: 'attempt_failed', complete: 'completed',
  accepted_blocked: 'accepted_blocked', incomplete: 'command_missing', failed: 'gate_irreparable',
  escalated: 'recovery_unknown', cancelled: 'cancelled',
} as const;
const states = Object.keys(reasons) as Array<keyof typeof reasons>;
function status(run: string, state: keyof typeof reasons = 'running'): RunStatusFile {
  return {
    ...wireStatus(run,state,'frontend:session_A'),publishedAt:'2001-01-01T00:00:00Z',currentStage:state === 'running' ? 'work_A' : null,focus:['running','parked'].includes(state) ? 'work_A' : null,
    gates: [
      { stage: 'progress_A', attempt: 'attempt_A', scope: 'progress', outcome: 'accepted',
        answer: { path: 'evidence/progress.json', sha256: 'a'.repeat(64) }, cursor: 1 },
      ...(['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable'] as const)
        .map((outcome, index) => ({ stage: 'delivery_A', attempt: `attempt_${index}`, scope: 'delivery' as const,
        outcome, result: `label_${index}`, answer: { path: 'evidence/final.json', sha256: 'b'.repeat(64) }, cursor: 2 })),
    ],
    stopReason: reasons[state], journalCursor: 8, statusSince: 3,
  };
}
function put(root: string, run: string, value: unknown): void {
  const directory = join(root, 'runs', run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'status.json'), JSON.stringify(value));
}
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
function inventory(root: string): unknown[] {
  return readdirSync(root).sort().map(name => {
    const file = join(root, name);
    const info = lstatSync(file);
    return info.isDirectory() ? [name, inventory(file)]
      : [name, info.mtimeMs, createHash('sha256').update(readFileSync(file)).digest('hex')];
  });
}
describe('approved read-only dashboard', () => {
  let temporary: string, roots: string[], servers: Server[], windows: JSDOM[];
  beforeEach(() => {
    temporary=mkdtempSync(join(tmpdir(),'rewrite-monitor-')); roots=[join(temporary,'A'),join(temporary,'B')];
    for(const root of roots) mkdirSync(join(root,'runs'),{recursive:true}); servers=[];windows=[];
  });
  afterEach(async()=>{
    for(const window of windows)window.window.close();
    await Promise.all(servers.map(server=>new Promise<void>(done=>server.close(()=>done()))));
    rmSync(temporary,{recursive:true,force:true});
  });
  async function start(storeRoots=roots):Promise<Server>{const server=await startMonitor({storeRoots,port:0});servers.push(server);return server;}
  function dom(html:string){const d=new JSDOM(html);windows.push(d);return d.window.document;}
  const at='2026-11-18T10:00:00Z';
  function stage(id:string,state='pending',purpose='work'):any{return {id,state,purpose,role:'author',after:[],goal:'Declared goal',instruction:'Opaque instruction',commands:[],revision:'Revision',attempts:0,lastEnding:null,verdict:null,startedAt:null,settledAt:null};}
  function dashboard(run='Run',state:keyof typeof reasons='parked'):RunStatusFile{
    const s=status(run,state);
    const {readiness,...host}=s.host;
    return {...s,version:4,host:{...host,boot:controller.boot,activation:{state:'active',owner:controller,checkedAt:null}},requester:'claude:3f2a9c1e',startedAt:at,lastActivityAt:'2026-11-18T12:00:00Z',
      ...(state==='complete'?{endedAt:'2026-11-18T12:00:00Z'}:{}),
      stages:[{...stage('planner','settled','plan'),attempts:1,lastEnding:'delivered',segments:[{kind:'attempt',attempt:'Plan',invocation:1,startedAt:at,endedAt:'2026-11-18T10:01:00Z',ending:'delivered'}]},
        {...stage('work_A',state==='running'?'running':'pending'),attempts:1,lastEnding:'invalid_answer',summary:'Author summary verbatim <safe>.',segments:[
          {kind:'attempt',attempt:'Attempt',invocation:1,startedAt:'2026-11-18T10:01:00Z',endedAt:'2026-11-18T11:00:00Z',ending:'invalid_answer'},
          {kind:'pause',startedAt:'2026-11-18T11:00:00Z',endedAt:'2026-11-18T12:00:00Z'}]},stage('Review','pending','gate'),stage('Later')]};
  }
  it.each([false, true])('public monitor serves the CLI default store without --store-root (FC_HOME=%s)', async fcHome => {
    const stateHome = join(temporary, 'state'), xdg = join(temporary, 'xdg');
    const root = join(fcHome ? stateHome : join(xdg, 'flowcrew'), 'store');
    put(root, 'DefaultStore', { ...dashboard('DefaultStore', 'complete'), title: 'Default store boundary witness' });
    vi.resetModules();
    vi.stubEnv('XDG_STATE_HOME', xdg);
    vi.stubEnv('FC_HOME', fcHome ? stateHome : undefined);
    vi.stubEnv('FLOWCREW_STORE_ROOT', undefined);
    const argv = process.argv, exitCode = process.exitCode;
    vi.spyOn(process, 'on').mockReturnValue(process);
    let published!: () => void;
    const ready = new Promise<void>(done => { published = done; });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      expect(String(chunk)).toBe('FlowCrew monitor: http://127.0.0.1:8795\n');
      published(); return true;
    });
    process.argv = [process.execPath, 'flowcrew', 'monitor'];
    const entry = import('../dist-rewrite/cli.js');
    try {
      await Promise.race([ready, entry.then(() => { throw Error('Monitor exited before printing its URL'); })]);
      const response = await get(bound.server!);
      expect(response.code).toBe(200);
      expect(response.body).toContain('Default store boundary witness');
      bound.server!.close();
      await entry;
      expect(process.exitCode).toBe(0);
    } finally {
      bound.server?.close();
      stdout.mockRestore();
      process.argv = argv; process.exitCode = exitCode;
      vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  });
  it('renders declared titles, one ended heading and compact missing-status rows with short ids',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-18T13:00:00Z'));
    try {
      put(roots[0],'Named',{...dashboard('Named','running'),title:'Declared run title'});
      put(roots[0],'Old',{...dashboard('Old','cancelled'),endedAt:'2026-11-18T12:00:00Z'});
      put(roots[0],'Ancient',{...dashboard('Ancient','complete'),endedAt:'2026-11-16T12:00:00Z'});
      mkdirSync(join(roots[0],'runs','run_without_any_status_file'));
      const d=dom((await get(await start())).body);
      expect(d.querySelector('h2')!.textContent).toBe('Declared run title');
      expect(d.querySelectorAll('.label')).toHaveLength(1);
      expect(d.querySelectorAll('article.row')).toHaveLength(3);
      expect(d.querySelector('article.unavailable h3')!.textContent).toBe('run_without_any_');
      expect(d.querySelector('article.unavailable .unknown-state')!.textContent).toBe('No status');
      expect([...d.querySelectorAll('.sum b')].map(n=>n.textContent)).toEqual(['0','1','1']);
    } finally {vi.restoreAllMocks();}
  });
  it('shows the space held by ended runs that are not landed: a header total and the bytes on each ended row; landed and unmeasured runs add nothing, and an escalated run is shown like any other the status holds',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-18T13:00:00Z'));
    try {
      put(roots[0],'Failed',{...dashboard('Failed','failed'),endedAt:'2026-11-18T12:00:00Z',heldBytes:1_500_000_000});
      put(roots[0],'Cancelled',{...dashboard('Cancelled','cancelled'),endedAt:'2026-11-18T12:00:00Z',heldBytes:250_000_000});
      put(roots[0],'Landed',{...dashboard('Landed','complete'),endedAt:'2026-11-18T12:00:00Z',reclaimed:{at:'2026-11-18T12:30:00Z',delivery:'/synthetic/delivery'}});
      put(roots[0],'Escalated',{...dashboard('Escalated','escalated'),endedAt:'2026-11-18T12:00:00Z',heldBytes:50_000_000});
      put(roots[0],'Unmeasured',{...dashboard('Unmeasured','failed'),endedAt:'2026-11-18T12:00:00Z'});
      put(roots[0],'Live',{...dashboard('Live','running')});
      const before=inventory(temporary),d=dom((await get(await start())).body);
      const held=d.querySelector('.sum a[data-held]')!;
      expect(held.getAttribute('data-held')).toBe('1800000000');
      expect(held.querySelector('b')!.textContent).toBe('1.80 GB');
      expect(held.getAttribute('data-tip')).toBe('Space held by 3 ended runs not yet landed: 1.80 GB');
      const rows=Object.fromEntries([...d.querySelectorAll('article.row')].map(row=>[row.getAttribute('data-key')!.slice(2),row.textContent!]));
      expect(rows.Failed).toContain('1.50 GB held');expect(rows.Cancelled).toContain('250 MB held');
      for(const run of ['Landed','Unmeasured'])expect(rows[run]).not.toContain(' held');
      const live=[...d.querySelectorAll('article.run')].map(card=>[card.getAttribute('data-key')!.slice(2),card.textContent!]);
      expect(Object.fromEntries(live).Escalated).toContain('50 MB held');expect(Object.fromEntries(live).Live).not.toContain(' held');
      expect(inventory(temporary)).toEqual(before);
    } finally {vi.restoreAllMocks();}
  });
  it('shows no space total while no ended run has a measurement',async()=>{
    put(roots[0],'Old',{...dashboard('Old','cancelled'),endedAt:'2026-11-18T12:00:00Z'});
    expect(dom((await get(await start())).body).querySelector('.sum a[data-held]')).toBeNull();
  });
  it.each([2,3] as const)('renders historical v%s time bars, current stage and total through the decoder',async version=>{
    const base=status('Historical'),{focus,...file}=base,{readiness,...host}=base.host;
    put(roots[0],base.run,{...file,version,...(version===3?{host:{...host,activation:{state:'active',owner:controller,checkedAt:null}}}:{}),currentStage:'calibrate_runtime',
      stages:[{...stage('planner','settled','plan'),attempts:1,lastEnding:'delivered',startedAt:at,settledAt:'2026-11-18T10:02:00Z'},
        {...stage('calibrate_runtime','running'),attempts:1,startedAt:'2026-11-18T10:02:00Z'},
        ...Array.from({length:5},(_,i)=>stage('Later_'+i))],step:{startedAt:'2026-11-18T10:02:00Z',elapsedMs:60000}});
    const d=dom((await get(await start())).body);
    expect(d.querySelectorAll('.bar .p')).toHaveLength(2);
    expect(d.querySelector('.under')!.textContent).toBe('Calibrate runtime1/6');
    expect(d.querySelector('.total')!.textContent).toBe('3m');
    expect(d.querySelector('.bar .p.live')).not.toBeNull();
    expect([...d.querySelectorAll('tbody td:nth-child(3)')].slice(0,2).map(n=>n.textContent)).not.toContain('—');
  });
  it.each([true,false])('shows needs-you state, short owner and tooltips (bound=%s)',async bound=>{
    const s=dashboard();const {requester:_requester,...rest}=s;
    put(roots[0],s.run,bound?s:{...rest,notification:{...s.notification,session:'unbound'}});
    const before=inventory(temporary),d=dom((await get(await start())).body),card=d.querySelector('article')!;
    expect(card.querySelector('.r3 .status')!.textContent).toBe('Paused');
    expect(card.querySelector('.goto')!.textContent).toBe(bound?'Claude Code · 3f2a…':'No session');
    expect(card.querySelector('.goto use')!.getAttribute('href')).toBe('#i-arrow');
    expect(card.querySelectorAll('.goto use')[1].getAttribute('href')).toBe(bound?'#i-bell':'#i-belloff');
    expect(card.querySelector('.goto')!.getAttribute('data-tip')).toContain(bound?'3f2a9c1e':'flowcrew status');
    expect(card.querySelector('.more-body')!.hasAttribute('hidden')).toBe(true);
    expect(card.querySelectorAll('.bar .node')).toHaveLength(4);
    expect(card.querySelectorAll('.bar .node.sq')).toHaveLength(1);
    expect(card.querySelector('.under')!.textContent).toBe('Work A1/3');
    expect(card.querySelectorAll('.bar .p.x')).toHaveLength(1);
    expect(card.querySelectorAll('.bar .p.gap')).toHaveLength(1);
    expect(card.querySelector('.bar .p.x')!.getAttribute('style')).toBe('flex:3540000 1 0');
    expect(card.querySelector('.bar .p.gap')!.getAttribute('style')).toBe('flex:3600000 1 0');
    expect(card.querySelector('.res')!.textContent).toBe('');
    expect(card.querySelectorAll('.res')[1].textContent).toBe('Author summary verbatim <safe>.');
    expect(card.querySelector('safe')).toBeNull();expect(inventory(temporary)).toEqual(before);
  });
  it('formats stage kinds and renders recorded checkpoint, attention and park facts',async()=>{
    const base=dashboard('Facts');
    const file={...base,checkpoints:{count:4,latestAt:'2026-11-18T14:22:19Z'},
      stopReason:'recovery_unknown',attention:{reason:'recovery_unknown',condition:null,cause:'resume_refused',detail:'Paused / arbitrary prose <safe>'},
      stages:base.stages!.map((st,i)=>({...st,state:i===1?'pending':st.state}))};
    put(roots[0],base.run,file);
    const d=dom((await get(await start())).body);
    expect([...d.querySelectorAll('.nm b')].map(n=>n.textContent)).toEqual(['Plan','Work A','Review','Later']);
    expect([...d.querySelectorAll('.nm small')].map(n=>n.textContent)).toEqual(['Planner','Work','Review','Work']);
    expect(d.querySelector('tbody tr')!.getAttribute('data-tip')).toContain('author');
    expect(d.querySelector('.r3 .status')!.textContent).toBe('Resume refused');
    expect(d.querySelector('.why time')!.getAttribute('datetime')).toBe(file.checkpoints.latestAt);
    expect(d.querySelector('.meter .note')).toBeNull();
    put(roots[0],base.run,{...file,attention:{...file.attention,cause:undefined,detail:'Resume refused is only prose'}});
    expect(dom((await get(await start())).body).querySelector('.r3 .status')!.textContent).toBe('Paused');
    put(roots[0],base.run,{...file,stopReason:'backstop',attention:{reason:'backstop',condition:'failure',detail:'Limit recorded'},
      backstop:{...base.backstop,failureSuffix:4,condition:'failure',pausedAt:file.checkpoints.latestAt}});
    const backstop=dom((await get(await start())).body);
    expect(backstop.querySelector('.r3 .status')!.textContent).toBe('Paused at run limit');
    expect(backstop.querySelector('.meter.s-wait .note time')!.getAttribute('datetime')).toBe(file.checkpoints.latestAt);
    put(roots[0],base.run,{...base,checkpoints:{count:1,latestAt:null}});
    expect(dom((await get(await start())).body).querySelector('.why')!.textContent).toContain('Work is safe: 1 checkpoint saved.');
    put(roots[0],base.run,{...base,checkpoints:{count:0,latestAt:null}});
    const fresh=dom((await get(await start())).body).querySelector('.why')!.textContent;
    expect(fresh).toContain('No checkpoint saved yet.');expect(fresh).not.toContain('Work is safe');
    put(roots[0],base.run,base);
    const old=dom((await get(await start())).body);
    expect(old.querySelector('.r3 .status')!.textContent).toBe('Paused');
    expect(old.querySelector('.why')!.textContent).not.toContain('checkpoints saved');
    expect(old.querySelector('.meter .note')).toBeNull();
  });
  it('renders the published focus without inferring one from stage disposition',async()=>{
    const s=dashboard();
    put(roots[0],s.run,{...s,focus:'Later'});
    const d=dom((await get(await start())).body);
    expect(d.querySelector('[aria-current="step"]')!.getAttribute('data-stage')).toBe('Later');
    expect(d.querySelector('.under')!.textContent).toBe('Later3/3');
    put(roots[0],s.run,{...s,focus:null});
    const empty=dom((await get(await start())).body);
    expect(empty.querySelector('[aria-current="step"],.under')).toBeNull();
  });
  it.each(['interrupted','unknown','complete'] as const)('renders correction focus through the server for a historical %s run',async state=>{
    const s=dashboard('Correction',state==='complete'?'complete':'running');
    const {readiness,...host}=s.host;
    const output=parseRunStatusFile({...s,version:3,status:state,journalStatus:state==='complete'?'complete':'running',currentStage:null,focus:'work_A',
      ...(state==='interrupted'?{interruption:{detail:'interrupted',resume:'flowcrew resume Correction'}}:{}),
      attention:state==='complete'?s.attention:{reason:'recovery_unknown',detail:'Controller unavailable',condition:null},
      host:{...host,activation:{state:'unknown',owner:null,checkedAt:null}},
      stages:s.stages!.map(stage=>stage.id==='work_A'?{...stage,state:'needs-correction'}:stage)});
    expect(output.ok).toBe(true);if(!output.ok)throw Error(output.detail);
    put(roots[0],s.run,output.value);
    const d=dom((await get(await start())).body);
    expect(d.querySelector('[aria-current="step"]')!.getAttribute('data-stage')).toBe('work_A');
    expect(d.querySelector('.under')?.textContent ?? null).toBe(state==='complete'?null:'Work A1/3');
  });
  it('displays v4 journal stage facts as needs-correction through the server',async()=>{
    const s=dashboard('Correction','complete'),{readiness,...host}=s.host;
    const value={...s,version:4 as const,host,focus:'work_A',
      stages:s.stages!.map(row=>row.id==='work_A'?{...row,state:'pending' as const}:row)};
    put(roots[0],s.run,value);
    const before=inventory(temporary),response=await get(await start()),d=dom(response.body);
    expect(response.code).toBe(200);
    expect(d.querySelector('[data-stage="work_A"]')!.classList.contains('s-wait')).toBe(true);
    expect(d.querySelectorAll('tbody tr')[1].classList.contains('s-wait')).toBe(true);
    expect(inventory(temporary)).toEqual(before);
  });
  it.each(['delivered','cancelled','invalid_answer','invalid_plan','work_failed','technical_failure','auth','refused',
    'input_too_large','quota','duration','isolation_failure','closure_unknown','provider_unknown'] as const)(
    'uses one %s disposition in the track, details and stage tone',async ending=>{
      const s=dashboard('Ending','complete'),tone=ending==='delivered'?'dlv':ending==='cancelled'?'off':['invalid_answer','invalid_plan'].includes(ending)?'wait':'bad';
      put(roots[0],s.run,{...s,stages:[{...stage('work_A','settled'),attempts:1,lastEnding:ending,segments:[
        {kind:'attempt',attempt:'One',invocation:1,startedAt:at,endedAt:'2026-11-18T10:01:00Z',ending}]}]});
      const d=dom((await get(await start())).body);
      expect(d.querySelector(`.bar .stg.s-${tone} .p.s-${tone}`)).not.toBeNull();
      expect(d.querySelector(`tbody tr.s-${tone} .tally use`)!.getAttribute('href')).toBe(`#i-${tone}`);
      expect(d.querySelectorAll('.bar .p.x')).toHaveLength(['bad','wait'].includes(tone)?1:0);
    });
  it('renders a running gate from declared per-command facts, with current command position and moving stripes',async()=>{
    const s=dashboard('Checks','running');
    const gate={...stage('work_A','running','gate'),commands:['Unit','Integration','Final'],attempts:1,
      segments:[{kind:'attempt',attempt:'Gate',invocation:1,startedAt:at,endedAt:null}],commandProgress:[
        {command:'Unit',state:'passed'},{command:'Integration',state:'running'},{command:'Final',state:'not_started'}]};
    put(roots[0],s.run,{...s,stages:[gate]});
    const d=dom((await get(await start())).body);
    expect(d.querySelectorAll('.ck')).toHaveLength(3);expect(d.querySelector('.ckn')!.textContent).toBe('2/3');
    expect(d.querySelector('.ck.s-run')!.getAttribute('data-tip')).toContain('Integration');
    expect(d.querySelector('.bar .p.live')).not.toBeNull();expect(d.querySelector('.curlab')!.textContent).toBe('Work A1/1');
  });
  it('renders live author progress before exit, escapes it, and leaves historical activity absent',async()=>{
    const {runCard}=await import('../dist-monitor/rewrite-monitor/view.js');
    const s=dashboard('Live','running'),now=Date.parse('2026-11-18T12:03:00Z');
    const live={...s,activity:[{invocation:{charge:'work' as const,address:{kind:'stage' as const,run:s.run,stage:'work_A',attempt:'LiveAttempt',invocation:1}},
      source:'author' as const,stage:'work_A',state:'current' as const,lastEventAt:'2026-11-18T12:00:00Z',lastTool:'Bash',summary:'npm test <untrusted>',toolRunning:true,observation:'progress' as const}]};
    expect(parseRunStatusFile(live).ok).toBe(true);
    const d=dom(runCard(live.run,live,now,'key'));
    expect(d.querySelectorAll('.res')[1].textContent).toContain('running Bash: npm test <untrusted> · last progress 3m ago');
    expect(d.querySelector('.under')!.textContent).toContain('running Bash: npm test <untrusted>');
    expect(d.querySelector('untrusted')).toBeNull();
    const quiet={...live,activity:live.activity.map(item=>({...item,observation:'quiet' as const,notice:{cursor:8,message:'no observed progress for 10 min' as const}}))};
    expect(dom(runCard(quiet.run,quiet,now,'key')).querySelector('.r3')?.textContent).toContain('No observed progress');
    expect(dom(runCard(s.run,s,now,'key')).querySelectorAll('.res')[1].textContent).toBe('Author summary verbatim <safe>.');
  });
  it('uses requester prefix as a closed mapping and leaves other declared kinds verbatim',async()=>{
    for(const [run,requester] of [['Codex','codex:abcd-more'],['Other','tool:efgh-more'],['Prototype','constructor:ijkl-more']])put(roots[0],run,{...dashboard(run),requester});
    const d=dom((await get(await start())).body);
    expect([...d.querySelectorAll('.goto')].map(n=>n.textContent)).toEqual(['Codex · abcd…','tool · efgh…','constructor · ijkl…']);
  });
  it.each(['complete','accepted_blocked','incomplete','failed','cancelled'] as const)('keeps an ended %s run on one row with a mini track and collapsed details',async state=>{
    put(roots[0],'Done',dashboard('Done',state));
    const d=dom((await get(await start())).body),row=d.querySelector('article')!;
    expect(d.querySelector('.sum b')!.textContent).toBe('0');
    expect(row.classList.contains('row')).toBe(true);expect(row.querySelector('.r1 .bar.mini')).not.toBeNull();
    if(state==='complete')expect(row.querySelector('.fresh')!.textContent).toMatch(/^ended .* ago$/);
    else expect(row.querySelector('.fresh')).toBeNull();
    expect(row.querySelector('.under,.r3,.trackrow')).toBeNull();expect(row.querySelector('.more-body')!.hasAttribute('hidden')).toBe(true);
  });
  it('leaves facts absent in historical status files off the page and keeps every lifecycle readable',async()=>{
    for(const state of states)put(roots[0],`run_${state}`,status(`run_${state}`,state));
    const d=dom((await get(await start())).body);
    expect(d.querySelectorAll('article')).toHaveLength(states.length);
    expect(d.querySelector('.bar,.under,time,.ubar,.ck')).toBeNull();
    expect(d.querySelectorAll('.pips')).toHaveLength(states.length*2);
  });
  it.each([['future_state','future_purpose'],['constructor','constructor'],['__proto__','toString']])('shows refused %s / %s files as unavailable without relaxing the decoder',async(state,purpose)=>{
    const s=dashboard();
    put(roots[0],s.run,{...s,stages:[{...stage('X','future_stage_state',purpose)}]});
    put(roots[0],'Future',{...s,run:'Future',identity:{...s.identity,run:'Future'},status:state,journalStatus:state,currentStage:null,stopReason:'future_reason',attention:{reason:'future_reason',detail:'Opaque message',condition:null}});
    const before=inventory(temporary),d=dom((await get(await start())).body);
    expect(d.querySelectorAll('article[data-status="unavailable"]')).toHaveLength(2);
    expect(d.querySelector('.bar')).toBeNull();expect(inventory(temporary)).toEqual(before);
  });
  it('sums recorded track time and shows untimed outcomes without inventing duration or live stripes',async()=>{
    const s=dashboard('Partial','running');
    put(roots[0],s.run,{...s,startedAt:'2000-01-01T00:00:00Z',stages:s.stages!.map((st,index)=>index===1?{...st,segments:[
      ...st.segments!,{kind:'attempt',attempt:'Older',invocation:2,startedAt:null,endedAt:null,ending:'invalid_answer'}]}:st)});
    const d=dom((await get(await start())).body);
    expect(d.querySelector('.total')!.textContent).toBe('2h');
    expect(d.querySelector('.total')!.getAttribute('data-tip')).toContain('some try times unavailable');
    expect(d.querySelectorAll('.bar .p.x')).toHaveLength(2);expect(d.querySelector('.bar .p.live')).toBeNull();
    expect([...d.querySelectorAll('.bar .p.x')].at(-1)!.getAttribute('data-tip')).toContain('time unavailable');
  });
  it('labels three counts, uses recorded end time for 24h, and carries token and automatic-pause facts only in details',async()=>{
    const now=new Date().toISOString();
    put(roots[0],'Need',dashboard('Need'));put(roots[0],'Running',dashboard('Running','running'));
    put(roots[0],'Done',{...dashboard('Done','complete'),endedAt:now,usage:{...dashboard().usage,input:100,cached:80,output:7}});
    const d=dom((await get(await start())).body);
    expect([...d.querySelectorAll('.sum b')].map(n=>n.textContent)).toEqual(['1','1','1']);
    expect([...d.querySelectorAll('.sum .lb')].map(n=>n.textContent)).toEqual(['Needs you','Running','Ended · 24h']);
    expect(d.querySelector('.ubar .c')!.getAttribute('style')).toBe('width:80%');
    expect(d.querySelector('.ukey')!.textContent).toContain('output 7');
  });
  it('keeps the mock-shaped three-run page within 45 visible English words with details closed',async()=>{
    for(const [run,state] of [['run_aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa','parked'],['run_bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb','running'],['run_cccccccc-1111-2222-3333-cccccccccccc','complete']] as const)
      put(roots[0],run,dashboard(run,state));
    const d=dom((await get(await start())).body),walker=d.createTreeWalker(d.body,4),texts:string[]=[];
    while(walker.nextNode()) {
      const node=walker.currentNode,p=node.parentElement!;
      if(!p.closest('style,script,svg,[hidden]'))texts.push(node.textContent!);
    }
    const words=[...new Intl.Segmenter('en',{granularity:'word'}).segment(texts.join(' '))].filter(s=>s.isWordLike).length;
    console.info('Three-run collapsed word count:',words);
    expect(words).toBeLessThanOrEqual(45);
    expect(d.querySelectorAll('.more-body[hidden]')).toHaveLength(3);
  });
  it('has no horizontal overflow mechanisms, uses the approved palette and dark default',async()=>{
    const html=(await get(await start())).body,d=dom(html),style=d.querySelector('style')!.textContent!;
    expect(d.documentElement.dataset.theme).toBeUndefined();expect(style).toContain('--bg:#0d1723');
    expect(style).toContain('--wait:#edc79d');expect(style).toContain(':root[data-theme="light"]');
    expect(style).toContain('grid-template-columns:minmax(0,1fr)');
  });
  it('serves only GET on every route, including the former real cancel URL, without store changes',async()=>{
    put(roots[0],'Run',dashboard());const before=inventory(temporary),server=await start();
    expect(server.listen).toHaveBeenCalledWith(0,'127.0.0.1',expect.any(Function));
    for(const method of METHODS.filter(m=>m!=='GET'))for(const path of ['/','/cancel','/cancel/0/Run']){
      const r=await get(server,method,path,{host:'127.0.0.1',origin:'http://127.0.0.1'});
      expect(r.code,method+' '+path).toBe(405);expect(r.headers.allow).toBe('GET');
    }
    for(const path of ['/cancel/0/Run','/status.json','/../../status.json'])expect((await get(server,'GET',path)).code).toBe(404);
    const r=await get(server);
    expect(dom(r.body).querySelector('.store')!.getAttribute('aria-label')).toBe('Store 1');
    for (const root of roots) expect(r.body).not.toContain(root);
    expect(r.body).not.toContain('class="cancel"');expect(r.body).not.toContain("method:'POST'");
    expect(inventory(temporary)).toEqual(before);
  });
  it('reports malformed, unavailable, mismatched and aliased status carriers without opening journal data',async()=>{
    for(const [run,value] of [['Bad',{}],['Mismatch',status('Other')],['Old',dashboard('Old')]] as const)put(roots[0],run,value);
    renameSync(join(roots[0],'runs/Old/status.json'),join(temporary,'outside.json'));
    symlinkSync(join(temporary,'outside.json'),join(roots[0],'runs/Old/status.json'));
    symlinkSync(join(roots[0],'runs/Bad'),join(roots[0],'runs/Alias'));
    const d=dom((await get(await start())).body);expect(d.querySelectorAll('.unavailable')).toHaveLength(3);
    expect(d.querySelector('time,.bar')).toBeNull();
  });
  it('escapes untrusted text and gives each inline program its CSP hash',async()=>{
    const unsafe='<img src=x onerror=alert(1)>';mkdirSync(join(roots[0],'runs',unsafe));
    const r=await get(await start()),d=dom(r.body);
    expect(d.querySelector('article h3')!.textContent).toBe(unsafe.slice(0,16));expect(d.querySelector('article h3')!.getAttribute('data-tip')).toBe(unsafe);expect(d.querySelector('img')).toBeNull();
    for(const e of d.querySelectorAll('script,style'))expect(r.headers['content-security-policy']).toContain("'sha256-"+createHash('sha256').update(e.textContent!).digest('base64')+"'");
    expect(r.headers['content-security-policy']).toContain("form-action 'none'");
  });
  it.each(['Asia/Tokyo','America/New_York'])('polls with local clocks in %s and retains expansion, focus, theme and facts',async zone=>{
    const at='2026-11-18T14:22:19Z',later='2026-11-18T15:22:19Z';
    put(roots[0],'Run',{...dashboard(),checkpoints:{count:1,latestAt:at}});const server=await start(),first=(await get(server)).body;
    put(roots[0],'Run',{...dashboard(),checkpoints:{count:1,latestAt:later},attention:{reason:'attempt_failed',condition:null,detail:'New raw message'}});
    let publication=(await get(server)).body,fail=false;
    const timeouts:Array<()=>Promise<void>>=[],intervals:Array<()=>void>=[],calls:unknown[]=[];
    const nativeClock=Intl.DateTimeFormat;
    const expected=(at:string)=>new nativeClock(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));
    const browser=new JSDOM(first,{url:'http://localhost/',runScripts:'dangerously',beforeParse(w){
      w.Intl.DateTimeFormat=function(locale:any,options:any){
        expect(locale).toBeUndefined();expect(options).not.toHaveProperty('timeZone');
        return new nativeClock(locale,{...options,timeZone:zone});
      } as any;
      w.setTimeout=((callback:()=>Promise<void>)=>{timeouts.push(callback);return 1;}) as any;
      w.setInterval=((callback:()=>void)=>{intervals.push(callback);return 1;}) as any;
      w.fetch=async(...args)=>{calls.push(args);if(fail)throw Error('Unavailable');return {ok:true,text:async()=>publication} as Response;};
    }});windows.push(browser);const d=browser.window.document,card=d.querySelector('article')!,button=card.querySelector('button')!,body=card.querySelector('.more-body')!;
    expect(d.querySelector('time[data-clock]')!.textContent).toBe(expected(at));
    button.click();button.focus();d.getElementById('theme')!.click();button.focus();
    expect(button.getAttribute('aria-expanded')).toBe('true');expect(body.hasAttribute('hidden')).toBe(false);
    expect(d.documentElement.dataset.theme).toBe('light');expect(timeouts).toHaveLength(1);
    await timeouts.shift()!();expect(calls).toEqual([['/',{method:'GET',cache:'no-store'}]]);
    expect(d.querySelector('article')).toBe(card);expect(d.activeElement).toBe(button);expect(body.hasAttribute('hidden')).toBe(false);
    expect(d.querySelector('time[data-clock]')!.textContent).toBe(expected(later));
    expect(d.body.textContent).toContain('New raw message');expect(d.documentElement.dataset.theme).toBe('light');
    put(roots[0],'Run',dashboard('Run','complete'));publication=(await get(server)).body;
    await timeouts.shift()!();expect(d.querySelector('article')).toBe(card);expect(d.activeElement).toBe(button);
    expect(card.querySelector('.more-body')).toBe(body);expect(body.hasAttribute('hidden')).toBe(false);
    fail=true;await timeouts.shift()!();expect(d.getElementById('poll-health')!.classList.contains('poll-down')).toBe(true);
    expect(card.getAttribute('data-status')).toBe('complete');intervals[0]();
    expect(d.querySelector('.fresh')!.textContent).toMatch(/^ended .* ago$/);
    expect(timeouts).toHaveLength(1);
  });
  it('validates explicit roots, host and port',async()=>{
    for(const config of [{storeRoots:[],port:0},{storeRoots:[''],port:0},{storeRoots:roots,port:-1},{storeRoots:roots,port:65536},{storeRoots:roots,port:1.5},{storeRoots:roots,port:0,host:''}])await expect(startMonitor(config)).rejects.toThrow();
    const before=inventory(temporary);const d=dom((await get(await start([roots[0],join(temporary,'missing')]))).body);
    expect(d.body.textContent).toContain('No run directories.');expect(d.body.textContent).toContain('Store unavailable');expect(inventory(temporary)).toEqual(before);
  });
});
