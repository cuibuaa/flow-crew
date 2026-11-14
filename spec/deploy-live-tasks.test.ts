import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cmdDaemon } from '../src/cli-daemon.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { readDaemonIdentity } from '../src/daemon-identity.js';
import { processLiveness, processStartToken, type ProcessStartToken } from '../src/process-liveness.js';
import { sendRpc, type RegisterRpcResponse } from '../src/orchestrator-rpc.js';
import {setTimeout as wait} from 'node:timers/promises';
import { fcGlobalDir, setFcGlobalDir, readRunState, readStageStatus } from '../src/store.js';
import { SessionPush } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';
import { supervisionPaths, readSupervisionRunning } from '../src/supervision.js';
import { NodeSystemd } from '../src/orchestrator.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { daemonFile } from './test-support/daemon-events.js';
import { deployBuild, installValidationBarrier } from './test-support/deploy-build.js';

const brief = '---\ncriteria: [{id: keep, text: Preserve the original execution and independently review it.}]\n---\n# Preserve work\n';
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.unstubAllEnvs(); });

async function fixture(seam: string, controlSeam?: string) {
  // Short physical paths are necessary for Unix sockaddr_un, and remain inside
  // this checkout. Compiler staging is separately supplied by TMPDIR.
  mkdirSync('.t', { recursive: true });
  const root = mkdtempSync(resolve('.t/d-'));
  const fc = join(root, 'f'), project = join(root, 'p'), bin = join(root, 'b'), barrier = join(root, 'r'), control = join(root,'c');
  for (const dir of [fc, project, bin, barrier, control, join(root, 't'), join(root, 'h'), join(root, 'x')]) mkdirSync(dir);
  const socket = join(fc, 'd.sock'), sends = join(root, 'sends');
  // Retry passage is controlled explicitly, independent of deployment duration.
  writeFileSync(join(control,'clock'),String(Date.now()));
  for (const key of Object.keys(process.env).filter(key=>key.startsWith('GIT_'))) vi.stubEnv(key,undefined);
  const previous = fcGlobalDir(); setFcGlobalDir(fc);
  for (const [key, value] of Object.entries({FC_HOME:fc, HOME:join(root,'h'), XDG_RUNTIME_DIR:join(root,'x'),
    TMPDIR:join(root,'t'), TMP:join(root,'t'), TEMP:join(root,'t'),
    DEPLOY_FIXTURE_CONTROL:control, DEPLOY_FIXTURE_CONTROL_SEAM:controlSeam ?? '',
    DEPLOY_FIXTURE_SEAM:seam, DEPLOY_FIXTURE_BARRIER:barrier, DEPLOY_FIXTURE_SENDS:sends,
    PATH:`${bin}:${process.env.PATH}`})) vi.stubEnv(key,value);
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
  for (const [name, body] of Object.entries({
    'systemd-run': `printf 'launch\\n' >> '${root}/manager'\nexit 1`,
    systemctl: `case "$2" in is-active) echo inactive; exit 3;; show) echo not-found;; list-units) echo '[]';; stop) printf 'stop\\n' >> '${root}/manager'; exit 1;; esac`,
    journalctl: 'exit 1',
  })) { const file = join(bin,name); writeFileSync(file,`#!/bin/sh\n${body}\n`); chmodSync(file,0o755); }
  if (controlSeam === 'manager-ack') {
    writeFileSync(join(bin,'systemd-run'),`#!${process.execPath}
import {spawn} from 'node:child_process';
import {watch,writeFileSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(control)},args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root,'manager'))},'launch\\n');
const child=spawn(args[4],args.slice(5),{detached:true,stdio:'ignore'}); child.unref();
const watcher=watch(root,check);
writeFileSync(root+'/entered',JSON.stringify({seam:'manager-ack',pid:JSON.parse(readFileSync(${JSON.stringify(join(fc,'daemon.json'))},'utf8')).pid,helper:process.pid}));
function check(){if(existsSync(root+'/release')){watcher.close();writeFileSync(root+'/retired','retired');process.exit(0);}} check();
`);
    chmodSync(join(bin,'systemd-run'),0o755);
  }
  // Git only operates on the disposable project; no user identity is printed.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    execFileSync('git', ['init', '-q']);
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  `], { cwd: project, env: { ...process.env, HOME: join(root,'h'), FC_HOME: fc }, timeout: 15000 });
  const build = deployBuild(root); const first = build.publish(1);
  const registry = new TaskRegistry({baseDir:fc});
  const daemons = new Map<number,ProcessStartToken>();
  let output = '', error = '';
  const options = {distDir:join(build.engine,'dist'),
    stdout:{write:(text:string)=>{output+=text;}} as NodeJS.WriteStream,
    stderr:{write:(text:string)=>{error+=text;}} as NodeJS.WriteStream};
  const command = async (sub:string, value?:number) => {
    const code = await cmdDaemon(['daemon',sub,'--socket',socket],{...options,
      ...(value ? {controls:{build:async()=>{build.publish(value);}}} : {})});
    const identity = readDaemonIdentity(socket);
    if (identity && processLiveness(identity.pid) === 'alive') {
      const start = processStartToken(identity.pid); if (start) daemons.set(identity.pid,start);
    }
    expect(code, error + (existsSync(join(fc,'daemon.log')) ? readFileSync(join(fc,'daemon.log'),'utf8') : '')).toBe(0);
    return identity!;
  };
  const failBuild=()=>cmdDaemon(['daemon','deploy','--socket',socket],{...options,controls:{build:async()=>{throw new Error('fixture build failure');}}});
  cleanup = async () => {
    writeFileSync(join(barrier,'release'),'release');
    writeFileSync(join(control,'release'),'release');
    for (const task of registry.list({status:'all'})) {
      const running = readSupervisionRunning(supervisionPaths(fc,task.systemd_unit).running);
      const paths=supervisionPaths(fc,task.systemd_unit);
      if (running && !existsSync(paths.exit)) {
        await new NodeSystemd(fc).stopUnit(task.systemd_unit);
        await daemonFile(paths.exit,()=>existsSync(paths.exit) ? true : undefined,AbortSignal.timeout(15000));
      }
    }
    for (const [pid,start] of daemons) if (processLiveness(pid,start) === 'alive') {
      // These identities were captured only from the children this fixture started.
      try { await sendRpc(socket,{cmd:'stop'}); } catch { if(processLiveness(pid,start)==='alive') process.kill(pid,'SIGKILL'); }
      const signal=AbortSignal.timeout(10000);
      while(processLiveness(pid,start)!=='dead') await wait(10,undefined,{signal});
    }
    if (controlSeam === 'manager-ack' && existsSync(join(control,'entered'))) {
      await daemonFile(join(control,'retired'),()=>existsSync(join(control,'retired')) ? true : undefined,AbortSignal.timeout(10000));
    }
    setFcGlobalDir(previous);
    rmSync(root,{recursive:true,force:true});
  };
  const old = await command('start');
  const setupPath=writeReadySetupRecord(project,brief,fc);
  if (seam === 'validation') installValidationBarrier(setupPath,barrier);
  const receipt = createBriefAdmission(inspectBrief(brief),{kind:'explicit',source:'cli_current_input_flag',at:new Date().toISOString()});
  const registration = sendRpc<RegisterRpcResponse>(socket,{cmd:'register',task:{projectDir:project,brief_text:brief,brief_admission:receipt,
    launcher:{frontend:'codex',sessionId:'fixture',cwd:project,ledgerRoot:join(root,'ledger'),codexHome:join(root,'codex')},
    ...(controlSeam === 'git' ? {commit_prefix:'fixture'} : {}),
    launch_options:{adapter:'mock',noCampaign:true}}}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  const blocksLaunch = ['reservation','launch-record','launch-ack','manager-ack'].includes(controlSeam ?? '');
  const registered = blocksLaunch ? await daemonFile(join(fc,'tasks/1/current.json'),()=>{
    const task=registry.get(1); return task?.run_id && task.runtime ? {id:1} : undefined;
  }) : (await registration).value!;
  const entered = blocksLaunch && !['launch-ack','manager-ack'].includes(controlSeam!) ? undefined : await daemonFile(join(barrier,'entered'),()=> {
    if (!existsSync(join(barrier,'entered'))) return undefined;
    try { return JSON.parse(readFileSync(join(barrier,'entered'),'utf8')) as {pid:number;helper:number;seam:string}; } catch { return undefined; }
  });
  const task = registry.get(registered.id)!;
  return {root,fc,project,barrier,control,registration,socket,sends,build,first,registry,old,entered,task,command,failBuild,
    output:()=>output,error:()=>error};
}

it.each(['model','validation','settlement','admission'])('compatible deploy replaces the launching daemon inside %s; successor observes one settlement and wrap-up', {timeout:120000}, async seam => {
  const f = await fixture(seam);
  const entered=f.entered!;
  const start = processStartToken(entered.pid)!;
  const supervision = readSupervisionRunning(supervisionPaths(f.fc,f.task.systemd_unit).running);
  expect(f.task.runtime?.generation).toBe(f.first.generation);
  const before = readRunState(f.project,f.task.run_id!);
  const stagesBefore = Object.fromEntries(Object.keys(before.stages).filter(id=>before.stages[id].attempts?.length).map(id=>[id,readStageStatus(f.project,f.task.run_id!,id)]));
  const replacement = await f.command('deploy',2);
  expect(replacement.pid).not.toBe(f.old.pid);
  expect(processLiveness(f.old.pid)).toBe('dead');
  expect(processLiveness(entered.pid,start)).toBe('alive');
  expect(readSupervisionRunning(supervisionPaths(f.fc,f.task.systemd_unit).running)).toEqual(supervision);
  expect(existsSync(join(f.barrier,'release'))).toBe(false);
  const unchanged = f.registry.get(f.task.id)!;
  expect([unchanged.run_id,unchanged.attempt,unchanged.launch,unchanged.systemd_unit,unchanged.runtime])
    .toEqual([f.task.run_id,f.task.attempt,f.task.launch,f.task.systemd_unit,f.task.runtime]);
  const during = readRunState(f.project,f.task.run_id!);
  expect(during.status).toBe('running');
  expect(during.queryState).toEqual(before.queryState);
  expect(during.briefAdmission).toEqual(before.briefAdmission);
  for (const [id,stage] of Object.entries(stagesBefore)) expect(readStageStatus(f.project,f.task.run_id!,id)).toEqual(stage);
  expect(existsSync(join(f.fc,'deployment-hold.json'))).toBe(false);
  expect(readFileSync(join(f.root,'manager'),'utf8')).toBe('launch\n');
  // A third deployment must retain A's module, document and dependency bytes.
  const third = await f.command('deploy',3);
  expect(third.pid).not.toBe(replacement.pid);
  expect(processLiveness(entered.pid,start)).toBe('alive');
  expect(readSupervisionRunning(supervisionPaths(f.fc,f.task.systemd_unit).running)).toEqual(supervision);
  expect(readRunState(f.project,f.task.run_id!).queryState).toEqual(before.queryState);
  writeFileSync(join(f.barrier,'release'),'release');
  const finished = await daemonFile(join(f.barrier,'finished'),()=>{
    try { return JSON.parse(readFileSync(join(f.barrier,'finished'),'utf8')); } catch { return undefined; }
  });
  expect(finished).toMatchObject({pid:entered.pid,run:f.task.run_id,status:'complete',late:1,resource:'1',dependency:1});
  const exitPath=supervisionPaths(f.fc,f.task.systemd_unit).exit;
  await daemonFile(exitPath,()=>existsSync(exitPath) ? true : undefined);
  expect(JSON.parse(readFileSync(exitPath,'utf8')).exitCode).toBe(0);
  const final = await daemonFile(join(f.fc,'tasks',String(f.task.id),'current.json'),()=>{
    const task = f.registry.get(f.task.id); return task?.status === 'done' ? task : undefined;
  });
  expect([final.run_id,final.attempt,final.launch]).toEqual([f.task.run_id,1,1]);
  expect(final.runtime).toEqual(f.task.runtime);
  const state = readRunState(f.project,f.task.run_id!);
  for (const id of ['plan','work','review']) expect(readStageStatus(f.project,state.runId,id).attempts).toHaveLength(1);
  const rows = readFileSync(join(f.fc,'runs',state.runId,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.filter(row=>row.type === 'operator_wrap_up_required')).toHaveLength(1);
  await daemonFile(f.sends,()=>{
    if (!existsSync(f.sends)) return undefined;
    const rows = readFileSync(f.sends,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    return rows.some(row=>row.kind === 'operator_wrap_up_required') ? rows : undefined;
  });
  const events = readdirSync(join(f.fc,'session-push/events')).map(file=>JSON.parse(readFileSync(join(f.fc,'session-push/events',file),'utf8')));
  expect(events.filter(row=>row.kind === 'operator_wrap_up_required')).toHaveLength(1);
  const wrap = events.find(row=>row.kind === 'operator_wrap_up_required');
  const deliveries = readFileSync(f.sends,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const push = new SessionPush(f.registry);
  expect(deliveries.filter(row=>row.kind === 'operator_wrap_up_required')).toHaveLength(1);
  expect(deliveries.find(row=>row.kind === 'operator_wrap_up_required')).toMatchObject({pid:third.pid,eventId:wrap.eventId});
  await daemonFile(join(f.fc,'session-push/delivery',`${wrap.eventId}.json`),()=>push.delivery(wrap.eventId).sentAt ? true : undefined);
  expect(push.delivery(wrap.eventId).attempts).toBe(1);
  const log = readFileSync(join(f.fc,'daemon.log'),'utf8');
  expect(log).not.toMatch(/\s(?:hold|hold-status|continue)\n/);
  expect(f.output()).toContain('FRESH:');
  if (seam === 'model') {
    rmSync(join(f.barrier,'finished'));
    const registered = await sendRpc<RegisterRpcResponse>(f.socket,{cmd:'register',task:{projectDir:f.project,brief_text:brief,
      brief_admission:f.task.brief_admission,launch_options:{adapter:'mock',noCampaign:true}}});
    const selected = f.registry.get(registered.id)!;
    expect(selected.runtime?.generation).not.toBe(f.first.generation);
    expect(selected.runtime?.cliPath).toBe(join(third.distDir!,'cli.js'));
    const next = await daemonFile(join(f.barrier,'finished'),()=>{
      try { return JSON.parse(readFileSync(join(f.barrier,'finished'),'utf8')); } catch { return undefined; }
    });
    expect(next).toMatchObject({late:3,resource:'3',dependency:3,status:'complete'});
    const exitPath=supervisionPaths(f.fc,selected.systemd_unit).exit;
    await daemonFile(exitPath,()=>existsSync(exitPath) ? true : undefined);
    expect(JSON.parse(readFileSync(exitPath,'utf8')).exitCode).toBe(0);
  }
});

it('a failed deploy build leaves real old control serving and its original task executing', {timeout:120000}, async()=>{
  const f=await fixture('model');
  expect(await f.failBuild()).toBe(1);
  expect(await sendRpc(f.socket,{cmd:'status'})).toMatchObject({pid:f.old.pid});
  expect(processLiveness(f.entered!.pid)).toBe('alive');
  expect(existsSync(join(f.fc,'deployment-hold.json'))).toBe(false);
  writeFileSync(join(f.barrier,'release'),'release');
  await daemonFile(join(f.barrier,'finished'),()=>existsSync(join(f.barrier,'finished')) ? true : undefined);
});

it.each(['reservation','launch-record','launch-ack','manager-ack','git','send'])('control replacement does not join blocked %s and preserves durable uncertainty', {timeout:120000}, async seam=>{
  const f=await fixture('model',seam);
  if (seam === 'git' || seam === 'send') writeFileSync(join(f.barrier,'release'),'release');
  const blocked=await daemonFile(join(f.control,'entered'),()=>{
    try { return JSON.parse(readFileSync(join(f.control,'entered'),'utf8')); } catch { return undefined; }
  });
  expect(blocked.pid).toBe(f.old.pid);
  const before=f.registry.get(f.task.id)!;
  const paths=supervisionPaths(f.fc,before.systemd_unit);
  const replacement=await f.command('deploy',2);
  expect(processLiveness(f.old.pid)).toBe('dead');
  expect(replacement.pid).not.toBe(f.old.pid);
  expect(existsSync(join(f.control,'release'))).toBe(false);
  if (['reservation','launch-record','launch-ack','manager-ack'].includes(seam)) {
    const outcome=await f.registration;
    expect(outcome.error?.name).toBe('RpcOutcomeUnknownError');
    expect(outcome.error?.exitCode).toBe(2);
    expect(f.registry.get(before.id)?.run_id).toBe(before.run_id);
    if (seam === 'launch-record') {
      // launch.json without an acknowledgement cannot authorize replay. Both
      // provisional-active and unknown observation preserve that obligation.
      await daemonFile(before.tick_log_path,()=>f.registry.readRecentTicks(before.id).some(line=>/status=(?:active|unobservable)/.test(line)) ? true : undefined);
      expect(existsSync(paths.running)).toBe(false);
      expect(existsSync(join(f.root,'manager'))).toBe(false);
      expect(f.registry.get(before.id)?.launch).toBe(1);
      return;
    }
    if (seam === 'launch-ack' || seam === 'manager-ack') {
      expect(processLiveness(f.entered!.pid)).toBe('alive');
      expect(f.registry.get(before.id)?.launch).toBe(1);
      if (seam === 'manager-ack') expect(processLiveness(blocked.helper)).toBe('alive');
    }
    writeFileSync(join(f.barrier,'release'),'release');
    await daemonFile(join(f.barrier,'finished'),()=>existsSync(join(f.barrier,'finished')) ? true : undefined);
    expect(readFileSync(join(f.root,'manager'),'utf8')).toBe('launch\n');
  }
  if (seam === 'send') {
    const push=new SessionPush(f.registry);
    const wrap=push.events().find(event=>event.kind==='operator_wrap_up_required')!;
    expect(wrap).toBeDefined();
    expect(push.delivery(wrap.eventId)).toMatchObject({attempts:1});
    expect(push.delivery(wrap.eventId).sentAt).toBeUndefined();
    expect(push.acknowledged(wrap.eventId)).toBe(false);
    // Advance only the fixture clock to the existing recorded retry instant.
    writeFileSync(join(f.control,'clock'),String(push.delivery(wrap.eventId).nextAttemptAt));
    await daemonFile(join(f.fc,'session-push/delivery',`${wrap.eventId}.json`),()=>push.delivery(wrap.eventId).sentAt ? true : undefined);
    expect(push.events().filter(event=>event.kind==='operator_wrap_up_required')).toHaveLength(1);
    expect(push.delivery(wrap.eventId).attempts).toBe(2);
    expect(push.acknowledged(wrap.eventId)).toBe(false);
    const sends=readFileSync(f.sends,'utf8').trim().split('\n').map(row=>JSON.parse(row)).filter(row=>row.kind === 'operator_wrap_up_required');
    expect(sends).toHaveLength(2);
    expect(sends.map(row=>row.eventId)).toEqual([wrap.eventId,wrap.eventId]);
  }
  await daemonFile(join(f.fc,'tasks',String(before.id),'current.json'),()=>f.registry.get(before.id)?.status === 'done' ? true : undefined);
});

it('recovery under new control executes the first runtime and retains completed work and spent histories', {timeout:120000}, async()=>{
  const f=await fixture('model');
  const runtime=f.task.runtime;
  const plan=readStageStatus(f.project,f.task.run_id!,'plan');
  const before=readRunState(f.project,f.task.run_id!);
  const validationRoot=join(f.fc,'validation');
  const receipts=existsSync(validationRoot) ? readdirSync(validationRoot).filter(name=>name!=='queue.json' && name.endsWith('.json'))
    .map(name=>({name,value:JSON.parse(readFileSync(join(validationRoot,name),'utf8'))})) : [];
  await f.command('deploy',2);
  const token=processStartToken(f.entered!.pid)!;
  expect(processLiveness(f.entered!.pid,token)).toBe('alive');
  process.kill(f.entered!.pid,'SIGKILL');
  const paths=supervisionPaths(f.fc,f.task.systemd_unit);
  await daemonFile(paths.exit,()=>existsSync(paths.exit) ? true : undefined);
  await daemonFile(join(f.fc,'tasks',String(f.task.id),'current.json'),()=>{
    const task=f.registry.get(f.task.id); return task?.status === 'deferred' ? task : undefined;
  });
  const recovered=readRunState(f.project,f.task.run_id!);
  expect(recovered.recovery?.kind).toBe('resumable');
  expect([recovered.currentIteration,recovered.maxIterations]).toEqual([before.currentIteration,before.maxIterations]);
  expect(readStageStatus(f.project,f.task.run_id!,'plan')).toEqual(plan);
  // Explicit resume avoids waiting for the production queue's backoff clock.
  await sendRpc(f.socket,{cmd:'resume',id:f.task.id});
  const finished=await daemonFile(join(f.barrier,'finished'),()=>{
    try { return JSON.parse(readFileSync(join(f.barrier,'finished'),'utf8')); } catch { return undefined; }
  });
  expect(finished).toMatchObject({run:f.task.run_id,status:'complete',late:1,resource:'1',dependency:1});
  expect(finished.pid).not.toBe(f.entered!.pid);
  expect(f.registry.get(f.task.id)?.runtime).toEqual(runtime);
  expect(readStageStatus(f.project,f.task.run_id!,'plan')).toEqual(plan);
  const work=readStageStatus(f.project,f.task.run_id!,'work');
  expect(work.attempts).toHaveLength(2);
  expect(work.attempts?.[0].endingCause).toBe('process_death');
  expect(work.attempts?.[1].status).toBe('complete');
  const recoveredExit=supervisionPaths(f.fc,f.registry.get(f.task.id)!.systemd_unit).exit;
  await daemonFile(recoveredExit,()=>existsSync(recoveredExit) ? true : undefined);
  expect(JSON.parse(readFileSync(recoveredExit,'utf8')).exitCode).toBe(0);
  for (const receipt of receipts) {
    const after=JSON.parse(readFileSync(join(validationRoot,receipt.name),'utf8'));
    expect(after.executions.slice(0,receipt.value.executions.length)).toEqual(receipt.value.executions);
    expect(after.spentMs).toBeGreaterThanOrEqual(receipt.value.spentMs);
  }
});
