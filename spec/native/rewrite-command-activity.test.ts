import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
import { wait } from '../fixtures/rewrite-host.js';
import { identifyCommand, runDeclaredCommand } from '../../dist-rewrite/exec/command.js';
import { readEvents, readHostState, reserveCommand, readAdvisoryActivity, putEvidence, storeEvidence, recordOperation } from '../../dist-rewrite/records/state.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import { activityRecorder, commandActivityObserver } from '../../dist-rewrite/ops/activity.js';
import { publishRunStatus } from '../../dist-rewrite/ops/status.js';
import { groupState } from '../../dist-rewrite/host/process.js';
import { INACTIVITY_WINDOW_MS, sampleActivity } from '../../dist-rewrite/host/activity.js';
import { recorderFactory } from '../../dist-rewrite/ops/main.js';
import { activityNotices } from '../../dist-rewrite/contract/status.mjs';
import type { ProcessPorts } from '../../dist-rewrite/host/process.js';

it('real idle command: one durable notice, restart dedup, progress clear, unknown control, and cancel closes the group', async () => {
  const code = `const cp=require('node:child_process');
    cp.spawn('nice',['-n','19',process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write('ready'); setInterval(()=>{},1000);`;
  const command = { id: 'Wait', argv: ['nice', '-n', '19', process.execPath, '-e', code], env: {}, inputs: [], required: false };
  const f = await stateFixture({ commands: [command] });
  const abort = new AbortController();
  let running: ReturnType<typeof runDeclaredCommand> | undefined;
  try {
    await f.admit();
    await f.append(f.control,[{type:'run_observed',observation:{unit:f.launch.unit,state:'active',owner:f.owner,evidence:[],detail:'Native test controller'}}]);
    const key = get(await identifyCommand(command, f.scope));
    const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
      { charge: 'command', address: { kind: 'stage', run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 } }));
    const ports: ProcessPorts = { streamRoot: f.journal.root, scratch: join(f.root, 'scratch'),
      operation: request => recordOperation(f.journal, 'construct', request),
      putEvidence: bytes => putEvidence(f.journal, bytes), storeEvidence: source => storeEvidence(f.journal, source),
      readEvidence: ref => readEvidence(f.journal, ref),
      recordProcess: recorderFactory()(f.execution).recordProcess };
    await mkdir(ports.scratch);
    running = runDeclaredCommand({ command, key, reservation }, { scope: f.scope, writer: f.execution, process: ports, abort: abort.signal });
    let owner: any;
    await wait(async () => {
      owner = get(readHostState(f.journal)).pending.find(item => item.streams && item.members?.length);
      return !!owner && (await readFile(owner.streams.stdout, 'utf8')).includes('ready');
    }, running);
    const observe = commandActivityObserver(f.execution);
    const status = () => get(publishRunStatus(f.location, new Date().toISOString(), 0));
    const notices = () => get(readAdvisoryActivity(f.journal)).filter(activity => activity.observation === 'quiet');
    const beforeObservation = (await f.projection()).cursor;
    await observe(0); await observe(INACTIVITY_WINDOW_MS - 1);
    expect((await f.projection()).cursor).toBe(beforeObservation);
    expect(status().activity?.[0].lastEventAt).toBe((await sampleActivity(owner))?.lastEventAt);
    expect(await notices()).toHaveLength(0);
    let at = INACTIVITY_WINDOW_MS;
    const untilQuiet = async (observer: ReturnType<typeof commandActivityObserver>) => wait(async () => {
      await observer(at); at += INACTIVITY_WINDOW_MS;
      return status().commandActivity?.[0]?.state === 'quiet';
    }, running);
    // Real native snapshots can be unavailable while the host changes; only known samples
    // build the virtual window. Exact threshold boundaries are tested with authored samples.
    await untilQuiet(observe);
    const idle = status();
    expect(idle).toMatchObject({ status: 'running', stopReason: null, attention:null,
      commandActivity: [{ command: 'Wait', stage: 'work', state: 'quiet' }],
      activity: [{ source: 'command', observation: 'quiet', notice: { message: 'no observed progress for 10 min' } }] });
    expect(idle.commandActivity![0].notice).toBeUndefined();
    const cursor = idle.activity![0].notice!.cursor;
    for (let i = 1; i <= 3; i++) { await observe(at); at += 5_000; }
    expect(await notices()).toHaveLength(1);
    // Controller recreation reads the persisted sample and quiet episode.
    const restarted = commandActivityObserver(f.execution);
    await untilQuiet(restarted);
    expect(status().activity![0].notice!.cursor).toBe(cursor);
    expect(await notices()).toHaveLength(1);
    await wait(async () => {
      await appendFile(owner.streams.stdout, 'progress');
      await restarted(at); at += 5_000;
      return status().commandActivity?.[0]?.state === 'progress';
    }, running);
    expect(status().commandActivity![0].state).toBe('progress');
    expect(status().activity![0].notice).toBeUndefined();
    // A cleared episode may issue one new notice; further polls share its identity.
    for (let i=0;i<3;i++) {await restarted(at);at+=INACTIVITY_WINDOW_MS;}
    expect(await notices()).toHaveLength(2);
    expect(status().activity![0].notice!.cursor).not.toBe(cursor);
    const missing = { ...owner, streams: { ...owner.streams, stdout: join(f.root, 'missing') } };
    await f.append(f.execution, [{ type: 'ownership', owner: missing, state: 'live' }]);
    expect((await restarted(at))[0].state).toBe('unknown');
    expect(await notices()).toHaveLength(2);
    expect(await sampleActivity(missing)).toBeNull();
    await f.append(f.execution,[{type:'ownership',owner:missing,state:'unknown'}]);
    expect(status().activity).toMatchObject([{source:'command',state:'current',observation:'unknown'}]);
    expect(status().activity![0].notice).toBeUndefined();
    // Restore only observation metadata; the running native group's cancellation path is unchanged.
    await f.append(f.execution, [{ type: 'ownership', owner, state: 'live' }]);
    const closingObservation = restarted(at);
    abort.abort(); await closingObservation;
    const receipt = get(await running);
    expect(receipt.execution).toMatchObject({ state: 'unfinished', reason: 'cancelled' });
    expect(groupState(owner)).toBe('dead');
    expect(status().commandActivity).toEqual([]);
    expect(get(await readEvents(f.journal, 0)).some(event => ['command_activity', 'execution_activity'].includes(event.payload.type))).toBe(false);
  } catch (error) {
    process.stderr.write('Activity test failure: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
    throw error;
  } finally { abort.abort(); if (running) await running; await f.close(); }
});

it('a command closes while its five-second activity sample is held without losing closure evidence', async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  const code='const fs=require("node:fs");console.log("ready");const t=setInterval(()=>{if(fs.existsSync("close")){clearInterval(t);process.exit(0)}},10)';
  const command={id:'Close',argv:['nice','-n','19',process.execPath,'-e',code],env:{},inputs:[],required:false};
  const f=await stateFixture({commands:[command]});
  const abort=new AbortController();let running:ReturnType<typeof runDeclaredCommand>|undefined;
  let cadence:ReturnType<typeof setInterval>|undefined;
  const activity = await import('../../dist-rewrite/host/activity.js'), sample = activity.sampleActivity;
  let release!:()=>void, sampled!:()=>void;
  const held = new Promise<void>(resolve=>{release=resolve;}), sampling = new Promise<void>(resolve=>{sampled=resolve;});
  let probe:ReturnType<typeof vi.spyOn>|undefined;
  try {
    await f.admit();
    const key=get(await identifyCommand(command,f.scope));
    const reservation=get(await reserveCommand(f.execution,(await f.projection()).cursor,command.id,key,
      {charge:'command',address:{kind:'stage',run:'Run',stage:'work',attempt:'Close',invocation:1}}));
    const ports=recorderFactory()(f.execution);
    const observe=commandActivityObserver(f.execution);
    running=runDeclaredCommand({command,key,reservation},{scope:f.scope,writer:f.execution,process:ports,abort:abort.signal});
    await wait(async()=>get(readHostState(f.journal)).pending.some(owner=>!!owner.streams),running);
    await observe(0);
    probe=vi.spyOn(activity,'sampleActivity').mockImplementation(async owner=>{sampled();await held;return sample(owner);});
    let observation:Promise<unknown>|undefined;
    cadence=setInterval(()=>{observation=observe(5000);},5000);
    await vi.advanceTimersByTimeAsync(5000);
    await sampling;
    await appendFile(join(f.project,'close'),'yes');
    expect(get(await running).execution).toEqual({state:'complete',exit:0});
    release();await observation;
    const events=get(await readEvents(f.journal,0));
    expect(get(readAdvisoryActivity(f.journal))).not.toEqual([]);
    expect(events.some(event=>['command_activity','execution_activity'].includes(event.payload.type))).toBe(false);
    expect(events.filter(event=>event.payload.type === 'process')).toHaveLength(1);
    expect(events.some(event=>event.payload.type === 'owner_closed')).toBe(true);
    expect((await f.projection()).commands).toHaveLength(1);
  } finally {release();probe?.mockRestore();if(cadence)clearInterval(cadence);abort.abort();if(running)await running;await f.close();vi.useRealTimers();}
});

it('an old journal command_activity record still appears in status', async()=>{
  const command={id:'Legacy',argv:['legacy'],env:{},inputs:[],required:false};
  const f=await stateFixture({commands:[command]});
  try {
    await f.admit();
    const key=get(await identifyCommand(command,f.scope));
    const reservation=get(await reserveCommand(f.execution,(await f.projection()).cursor,command.id,key,
      {charge:'command',address:{kind:'stage',run:'Run',stage:'work',attempt:'Legacy',invocation:1}}));
    const owner={...f.owner,streams:{stdout:join(f.root,'legacy.out'),stderr:join(f.root,'legacy.err')}};
    await f.append(f.execution,[{type:'ownership',owner,state:'live'},
      {type:'command_activity',owner,key,state:'quiet',notice:'no observed progress for 10 min'}]);
    const old=new DatabaseSync(f.database);old.exec('DROP TABLE advisory_activity');old.close();
    const hasActivityTable=()=>{const db=new DatabaseSync(f.database);try {
      return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='advisory_activity'").get();
    } finally {db.close();}};
    const status=get(publishRunStatus(f.location,new Date().toISOString(),0));
    expect(status.commandActivity).toEqual([{command:'Legacy',stage:'work',state:'quiet',notice:{
      cursor:(await f.projection()).cursor,message:'no observed progress for 10 min'}}]);
    expect(activityNotices(status)).toEqual(status.commandActivity);
    expect(get(readAdvisoryActivity(f.journal))).toEqual([]);
    expect(hasActivityTable()).toBe(false);
    const cursor=(await f.projection()).cursor;
    activityRecorder(f.journal)({invocation:reservation.invocation,source:'command',command:'Legacy',stage:'work',state:'current',
      lastEventAt:null,lastTool:'legacy',summary:'command Legacy',toolRunning:true,observation:'observing'});
    expect(hasActivityTable()).toBe(true);
    expect(get(readAdvisoryActivity(f.journal))).toHaveLength(1);
    expect((await f.projection()).cursor).toBe(cursor);
    expect(get(await readEvents(f.journal,0)).at(-1)?.payload.type).toBe('command_activity');
  } finally {await f.close();}
});
