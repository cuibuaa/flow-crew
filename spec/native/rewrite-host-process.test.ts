import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { access,mkdir,readFile,writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect,it,vi } from 'vitest';
import { kernelCapabilities } from './fixtures/kernel-capabilities.js';
import * as host from '../../dist-rewrite/host/process.js';
import * as state from '../../dist-rewrite/records/state.js';
import { fixture,known,pause,wait } from '../fixtures/rewrite-host.js';
it('exact stdin/stdout/stderr bytes and direct exit 7 survive durable streams; fd 3 cannot forge receipt', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 65]), stdin = known(await f.ports.putEvidence(bytes));
    const record = f.ports.recordProcess;
    f.ports.recordProcess = async (payload) => { if (payload.type === 'ownership' && payload.state === 'live')
      await writeFile(join(f.work, 'stream-names'), JSON.stringify(payload.owner.streams)); return record(payload); };
    const receipt = await f.launch(("const fs=require('fs');let fd3=false;try{fs.writeSync(3,'forged')}catch{fd3=true};" +
      "process.stdout.write(fs.readFileSync(0));let direct=false;" +
      "try{fs.appendFileSync(JSON.parse(fs.readFileSync('stream-names')).stdout,'BAD');" +
      "direct=true}catch{}process.stderr.write(fd3&&!direct?'private':'LEAK');" +
      "process.exitCode=7"), { program: { stdin } });
    expect(receipt).toMatchObject({ state: 'closed', exit: 7, signal: null, grant: 'applied' });
    expect(receipt.stdout.sha256).toBe(stdin.sha256);
    expect(await f.text(receipt.stderr)).toBe('private');
    expect(host.groupState(receipt.owner!)).toBe('dead');
    await f.evidence('streams', { receipt, bytes: [...bytes] });
  }
  finally {
    await f.close();
  }
});
it('ready/go records ownership before effects; refused persistence, pre-abort and zero duration never release work', async () => {
  const f = await fixture();
  try {
    const marker = join(f.work, 'effect'), code = `require('fs').writeFileSync(${JSON.stringify(marker)},'effect')`;
    const original = f.ports.recordProcess;
    let recorded = false;
    f.ports.recordProcess = async (payload) => { if (payload.type === 'ownership' && payload.state === 'live') {
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      recorded = true;
    } return original(payload); };
    expect((await f.launch(code)).exit).toBe(0);
    expect(recorded).toBe(true);
    const { rm } = await import('node:fs/promises');
    await rm(marker);
    f.ports.recordProcess = async () => ({ ok: false, kind: 'unknown', detail: 'Injected persistence outcome' });
    await expect(f.launch(code)).rejects.toThrow('Injected persistence');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    f.ports.recordProcess = original;
    const abort = new AbortController();
    abort.abort();
    expect((await f.launch(code, { abort: abort.signal })).state).toBe('not_started');
    expect((await f.launch(code, { program: { durationMs: 0 } })).state).toBe('not_started');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  finally {
    await f.close();
  }
});
it('identity seam refuses stale birth, stale boot, PGID reuse and EPERM without signalling a foreign group', async () => {
  const worker = known(await host.beginOperation());
  try {
    expect(host.groupState(worker.owner)).toBe('live');
    expect(await host.closeOperation({ ...worker.owner, authority: '' })).toMatchObject({ ok: false, kind: 'invalid' });
    for (const owner of [{ ...worker.owner, start: worker.owner.start + 'stale' }, { ...worker.owner, boot: 'stale-boot' }, {
     ...worker.owner, pid: process.pid }]) {
      const spy = vi.spyOn(process, 'kill');
      expect(await host.closeOperation(owner)).toMatchObject({ ok: false, kind: 'unknown' });
      expect(spy.mock.calls.some(call => call[1] === 'SIGKILL')).toBe(false);
      spy.mockRestore();
    }
    const original = process.kill.bind(process), spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
     if (pid === -worker.owner.group && signal === 0)
      throw Object.assign(Error('Unavailable observation'), { code: 'EPERM' }); return original(pid, signal); });
    expect(await host.probeOwner(worker.owner)).toBe('unknown');
    expect(await host.closeOperation(worker.owner)).toMatchObject({ ok: false, kind: 'unknown' });
    spy.mockRestore();
  }
  finally {
    vi.restoreAllMocks();
    known(await host.endOperation(worker.owner));
  }
  expect(host.groupState(worker.owner)).toBe('dead');
});
it('dead leader with recorded live member remains owned; close observes ESRCH only after native child drains', async () => {
  const f = await fixture();
  let owner: any;
  try {
    const gates = join(f.work, 'gates');
    await mkdir(gates);
    const operation = state.recordOperation(f.journal, 'construct', { module: new URL('./fixtures/rewrite-native-operation.mjs',
     import.meta.url).href, method: 'constructGated', args: [f.journal, gates] });
    const rows = () => { const db = new DatabaseSync(f.location.database); try {
      return db.prepare("SELECT owner FROM resources WHERE id LIKE 'record:%'").all().map((r: any) => JSON.parse(r.owner));
    }
    finally {
      db.close();
    } };
    await wait(async () => { owner = rows().find(o => o.members?.length); return !!owner; });
    process.kill(owner.pid, 'SIGKILL');
    await pause(30);
    expect(host.groupState(owner)).toBe('live');
    expect(await host.probeOwner(owner)).toBe('live');
    known(await state.reclaimRecordOperations(f.journal));
    expect(host.groupState(owner)).toBe('dead');
    expect(await operation).toMatchObject({ ok: false, kind: 'unknown' });
    await f.evidence('A2-member', { owner, after: host.groupState(owner) });
  }
  finally {
    if (owner)
      await host.closeOperation(owner);
    await f.close();
  }
});
it('P4 normal/TERM/KILL close recorded group; ordinary, setsid and double-fork facts retain actual scope', async () => {
  const f = await fixture(), escapes: number[] = [];
  try {
    const python = await host.nativeTool('python3');
    for (const mode of ['normal', 'SIGTERM', 'SIGKILL']) {
      const dir = join(f.work, mode);
      await mkdir(dir);
      const ready = join(dir, 'ready'), release = join(dir, 'release');
      const code = ("import os,sys,time,json,signal\nd=sys.argv[1]\nfor label in ['ordinary','setsid'," +
        "'doubleFork']:\n p=os.fork()\n if p==0:\n  if label!='ordinary':os.setsid()\n  if " +
        "label=='doubleFork':\n   if os.fork():os._exit(0)\n  open(d+'/'+label," +
        "'w').write(str(os.getpid()))\n  while True:time.sleep(.1)\nwhile not " +
        "all(os.path.exists(d+'/'+x) for x in ['ordinary','setsid'," +
        "'doubleFork']):time.sleep(.01)\nopen(d+'/ready','w').write(str(os.getpid()))\nwhile not " +
        "os.path.exists(d+'/release'):time.sleep(.01)\n");
      const abort = new AbortController();
      const running = f.launch('', { program: { argv: [python, '-I', '-S', '-B', '-c', code, dir] }, abort: abort.signal });
      await wait(async () => access(ready).then(() => true, () => false), running);
      await wait(async () => !![...known(await state.readEvents(f.journal, 0))].reverse().find(e => e.payload.type === 'ownership'
        && e.payload.state === 'live')?.payload.owner.members?.length, running);
      const facts = known(await state.readEvents(f.journal, 0));
      const owner = [...facts].reverse().find(e => e.payload.type === 'ownership' && e.payload.state === 'live')!.payload as any;
      const ids = Object.fromEntries(await Promise.all(['ordinary', 'setsid', 'doubleFork'].map(async (name) => [name,
       Number(await readFile(join(dir, name), 'utf8'))])));
      if (process.platform === 'darwin') escapes.push(...Object.values(ids));
      if (mode === 'normal')
        await writeFile(release, 'go');
      else if (mode === 'SIGKILL')
        process.kill(owner.owner.pid, 'SIGKILL');
      else
        abort.abort();
      const receipt = await running;
      expect(host.groupState(receipt.owner!)).toBe('dead');
      expect(receipt.scope).toBe(process.platform === 'linux' ? 'contained_descendants' : 'group');
      const survivors: any = {};
      if (process.platform === 'darwin')
        for (const [name, pid] of Object.entries(ids)) {
          try {
            process.kill(pid, 0);
            survivors[name] = true;
          }
          catch {
            survivors[name] = false;
          }
        }
      else {
        const { stdout } = await host.nativeExec(['ps', '-axo', 'pid=,args='], { env: { PATH: process.env.PATH! } });
        expect(stdout.split('\n').filter(line => line.includes(dir) && line.includes('python'))).toEqual([]);
      }
      if (process.platform === 'darwin') {
        expect(survivors.ordinary).toBe(false);
        expect(survivors.setsid).toBe(true);
        expect(survivors.doubleFork).toBe(true);
      }
      await f.evidence('P4-' + mode, { mode, receipt, insideIdentities: ids, survivors });
    }
  }
  finally {
    for (const pid of escapes)
      try {
        process.kill(pid, 'SIGKILL');
      }
      catch { }
    await f.close();
  }
});
it('a recorded native birth closes the group after anchor death without a PID namespace', async () => {
  const f = await fixture();
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  const sh = await host.nativeTool('sh');
  // Exercise the group owner independently of bwrap's parent-death cleanup.
  // This controlled payload only stays alive; P4 above retains the real sandbox.
  const launcher = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockImplementation(async command =>
    ({ argv: [sh, '-c', command], env: {} }));
  let owner: any;
  try {
    const running = f.launch('setInterval(()=>{},1000)');
    await wait(async () => {
      owner = [...known(await state.readEvents(f.journal, 0))].reverse().find(e => e.payload.type === 'ownership'
        && e.payload.state === 'live' && e.payload.owner.members?.length)?.payload.owner;
      return !!owner;
    }, running);
    process.kill(owner.pid, 'SIGKILL');
    const receipt = await running;
    expect(receipt.state).toBe('closure_unknown');
    expect(receipt.owner!.members).toEqual(owner.members);
    expect(host.groupState(receipt.owner!)).toBe('dead');
    await f.evidence('P4-group-witness', { owner, receipt });
  } finally {
    launcher.mockRestore();
    if (owner) known(await host.closeOperation(owner));
    await f.close();
  }
});
async function runContext(f: Awaited<ReturnType<typeof fixture>>, run: any) {
  return { database: f.location.database, storeRoot: f.location.storeRoot, environment: {},
    observation: async () => { const value = state.readHostState(f.journal); return value.ok ? { ok: true as const,
     value: value.value.observation } : value; },
    pending: async () => { const value = state.readHostState(f.journal); return value.ok ? { ok: true as const,
     value: value.value.pending } : value; } };
}
async function activation(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = Buffer.from('synthetic pinned runtime');
  await writeFile(join(f.outside, 'runtime'), runtime);
  const run = { run: f.location.run, authority: 'synthetic-run', runtime: { path: 'runtime',
   sha256: createHash('sha256').update(runtime).digest('hex') } };
  // Runtime lives at a normal store-relative reference, never traversal.
  await writeFile(join(f.records, 'runtime'), runtime);
  run.runtime.path = 'runtime';
  const config = { location: f.location, run, work: f.work, records: f.records, home: f.home, scratch: f.scratch, marker: join(f.work,
   'started'), release: join(f.work, 'release'), result: join(f.work, 'result') };
  const configPath = join(f.outside, 'supervisor.json');
  await writeFile(configPath, JSON.stringify(config));
  const entry = { argv: [process.execPath, new URL('./fixtures/rewrite-supervisor.mjs', import.meta.url).pathname, configPath],
   cwd: f.work, env: { PATH: process.env.PATH!, HOME: f.home }, writableRoots: [] };
  // The supervisor already publishes the launch Result, including not_started receipts.
  const finished = async () => {
    try { return JSON.parse(await readFile(config.result, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  return { run, config, configPath, entry, finished, context: await runContext(f, run) };
}
it('P5 detached supervisor outlives launcher, retains exact exit 7, then resume uses a fresh activation with the same pin', async () => {
  const f = await fixture();
  let owner: any;
  try {
    const a = await activation(f), marker = join(f.outside, 'launcher-result'), launcherConfig = join(f.outside, 'launcher.json');
    await writeFile(launcherConfig, JSON.stringify({ ...a.config, mode: 'launcher', entry: a.entry, writer: f.writer, marker }));
    const child = spawn('/usr/bin/nice', ['-n', '19', process.execPath, new URL('./fixtures/rewrite-supervisor.mjs',
     import.meta.url).pathname, launcherConfig], { env: { PATH: process.env.PATH!, HOME: f.home }, stdio: 'ignore' });
    expect(await new Promise(resolve => child.once('exit', resolve))).toBe(0);
    const started = known(JSON.parse(await readFile(marker, 'utf8')));
    owner = started.owner;
    await wait(async () => access(a.config.marker).then(() => true, () => false), a.finished);
    await f.evidence('P5-RSS', { controller: owner, rss: await host.nativeExec(['ps', '-o', 'rss=', '-p', String(owner.pid)], { env: {
     PATH: process.env.PATH! } }) });
    expect((known(await host.observeRun(a.run, a.context))).state).toBe('active');
    await writeFile(a.config.release, 'go');
    await wait(async () => access(a.config.result).then(() => true, () => false));
    const receipt = known(JSON.parse(await readFile(a.config.result, 'utf8')));
    expect(receipt).toMatchObject({ state: 'closed', exit: 7 });
    expect(await f.text(receipt.stdout)).toBe('partial-stdout\ncomplete\n');
    expect(await f.text(receipt.stderr)).toBe('partial-stderr\n');
    await wait(async () => host.groupState(owner) === 'dead');
    const again = known(await host.startRun(a.run, a.entry, f.ports, a.context));
    expect(again.owner.authority).not.toBe(owner.authority);
    owner = again.owner;
    await wait(async () => host.groupState(owner) === 'dead');
    await f.evidence('P5-detached', { started, receipt, again });
  }
  finally {
    if (owner)
      await host.closeOperation(owner);
    await f.close();
  }
});
it('B1/B2 supervisor SIGKILL preserves inherited-fd bytes; recovery records unknown and empties both groups without replay', async ({ signal }) => {
  const f = await fixture();
  let controller: any, invocation: any;
  try {
    const a = await activation(f);
    controller = known(await host.startRun(a.run, a.entry, f.ports, a.context)).owner;
    await wait(async () => access(a.config.marker).then(() => true, () => false), a.finished);
    invocation = known(await a.context.pending()).valueOf()[0];
    expect(invocation.streams).toBeDefined();
    const before = { stdout: await readFile(invocation.streams.stdout, 'utf8'), stderr: await readFile(invocation.streams.stderr, 'utf8') };
    expect(before).toEqual({ stdout: 'partial-stdout\n', stderr: 'partial-stderr\n' });
    process.kill(controller.pid, 'SIGKILL');
    // SIGKILL does not acknowledge reaping. A zombie retains its native
    // identity until the parent observes exit, especially under suite load.
    await wait(async () => {
      try { process.kill(controller.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, undefined, signal);
    expect(await host.startRun(a.run, a.entry, f.ports, a.context)).toMatchObject({ ok: false, kind: 'unknown' });
    const stopped = known(await host.stopRun(a.run, f.ports, a.context));
    expect(host.groupState(controller)).toBe('dead');
    expect(host.groupState(invocation)).toBe('dead');
    const receipt = [...known(await state.readEvents(f.journal, 0))].reverse().find(e => e.payload.type === 'process')!.payload.receipt;
    expect(receipt).toMatchObject({ state: 'closure_unknown', exit: null, signal: null });
    expect(await f.text(receipt.stdout)).toBe(before.stdout);
    expect(await f.text(receipt.stderr)).toBe(before.stderr);
    await expect(access(a.config.result)).rejects.toMatchObject({ code: 'ENOENT' });
    known(await state.reclaimRecordOperations(f.journal));
    await f.evidence('B1-B2', { controller, invocation, before, receipt, stopped });
  }
  finally {
    for (const owner of [invocation, controller])
      if (owner)
        await host.closeOperation(owner);
    await f.close();
  }
});
it('concurrent start claims have one winner; stale writer epoch cannot persist after closed-group retirement', async () => {
  const f = await fixture();
  try {
    const scope = { database: f.location.database, holder: f.journal.root }, resource = join(f.work, 'start');
    const contenders = await Promise.all([state.claim(resource, null, scope), state.claim(resource, null, scope)]);
    expect(contenders.filter(r => r.ok)).toHaveLength(1);
    const claim = known(contenders.find(r => r.ok)!);
    const writer = known(await state.openWriter(f.journal, claim, 'execution'));
    known(await state.release(claim, 'retire'));
    expect(await state.appendEvents(writer, 0, [{ type: 'ownership', owner: claim.owner, state: 'dead' }])).toMatchObject({ ok: false,
     kind: 'conflict' });
    expect(await state.release({ ...claim, epoch: 'stale' }, 'retire')).toMatchObject({ ok: false, kind: 'conflict' });
    const abandoned = known(await state.claim(resource, null, scope));
    process.kill(abandoned.owner.pid, 'SIGKILL');
    await wait(async () => host.groupState(abandoned.owner) === 'dead');
    const reclaimed = known(await state.claim(resource, null, scope));
    expect(reclaimed.epoch).not.toBe(abandoned.epoch);
    expect(await state.release(abandoned, 'retire')).toMatchObject({ ok: false, kind: 'conflict' });
    expect(host.groupState(reclaimed.owner)).toBe('live');
    known(await state.release(reclaimed, 'retire'));
  }
  finally {
    await f.close();
  }
});
it('failed final receipt persistence retains stream files and recovery preserves unknown output without replay', async () => {
  const f = await fixture();
  try {
    const record = f.ports.recordProcess;
    f.ports.recordProcess = async (payload) => payload.type === 'process' ? { ok: false, kind: 'unknown',
     detail: 'Injected final persistence failure' } : record(payload);
    await expect(f.launch(`process.stdout.write('retained output');process.exitCode=7`)).rejects.toThrow('Injected final persistence');
    const events = known(await state.readEvents(f.journal, 0)), owner = (events.find(e => e.payload.type === 'ownership' &&
     e.payload.state === 'live')!.payload as any).owner;
    expect(await readFile(owner.streams.stdout, 'utf8')).toBe('retained output');
    expect(host.groupState(owner)).toBe('dead');
    f.ports.recordProcess = record;
    const a = await activation(f);
    known(await host.stopRun(a.run, f.ports, a.context));
    const receipt = [...known(await state.readEvents(f.journal, 0))].reverse().find(e => e.payload.type === 'process')!.payload.receipt;
    expect(receipt).toMatchObject({ state: 'closure_unknown', exit: null });
    expect(await f.text(receipt.stdout)).toBe('retained output');
    await f.evidence('failed-persistence', { owner, receipt });
  }
  finally {
    await f.close();
  }
});

it('serializes simultaneous native member identities through async persistence and real SQL claims', async () => {
  const f = await fixture();
  const request = { module: new URL('./fixtures/rewrite-native-operation.mjs', import.meta.url).href,
    method: 'concurrentNativeChildren', args: [] };
  let recorded: any, count = 0;
  try {
    const result = await host.runOperation(request, {
      ready: async owner => { recorded = owner; return { ok: true, value: true }; },
      updated: async (previous, next) => {
        await pause(10);
        if (JSON.stringify(previous) !== JSON.stringify(recorded))
          return { ok: false, kind: 'conflict', detail: 'Member update lost its previous owner' };
        recorded = next; count++; return { ok: true, value: true };
      },
      closed: async () => ({ ok: true, value: true }),
    });
    expect(result).toEqual({ ok: true, value: true });
    expect(count).toBe(8);
    expect(recorded.members).toHaveLength(8);
    expect(await state.recordOperation(f.journal, 'construct', request)).toEqual({ ok: true, value: true });
  }
  finally { if (recorded) await host.endOperation(recorded); await f.close(); }
});

it('keeps a completed internal executor alive until its recorder closes the owned group',async()=>{
  const worker=known(await host.beginOperation());
  try {
    const result=new Promise<any>(done=>worker.child.on('message',packet=>{if((packet as any).result)done((packet as any).result);}));
    worker.child.send({request:{module:new URL('./fixtures/rewrite-native-operation.mjs',import.meta.url).href,method:'completed',args:[]}});
    worker.child.stdin!.end();
    expect(await result).toEqual({ok:true,value:true});
    // Probe scheduling interval, not a product deadline: the completed executor must still anchor its claim.
    await pause(100);
    expect(await host.probeOwner(worker.owner)).toBe('live');
    expect(worker.child.exitCode).toBeNull();
    expect(await host.endOperation(worker.owner)).toEqual({ok:true,value:'dead'});
    expect(host.groupState(worker.owner)).toBe('dead');
  } finally {await host.endOperation(worker.owner);}
});

it.skipIf(!kernelCapabilities.procStat)('uses the observed exit of a fast native child instead of persisting its dying-task group',async()=>{
  const f=await fixture();
  try {
    const request={module:new URL('./fixtures/rewrite-native-operation.mjs',import.meta.url).href,method:'dyingNativeChild',args:[]};
    expect(await state.recordOperation(f.journal,'construct',request)).toEqual({ok:true,value:{exit:0,sampled:true}});
    expect(await state.recordOperation(f.journal,'construct',{...request,args:[false]})).toMatchObject({ok:false,kind:'unknown',
      detail:expect.stringContaining('Native member group differs from recorded operation group')});
  } finally {await f.close();}
});

// Exercise the real operation worker and real exit/close events. Only terminal
// delivery and the existing asynchronous persistence boundary are controlled.
it.each(['after-exit', 'queued-persistence'] as const)('drains terminal IPC before missing-result settlement: %s', async mode => {
  let owner: any, delayed: any[] | undefined, release: (() => void) | undefined, retired = false;
  const emitted = EventEmitter.prototype.emit;
  vi.spyOn(EventEmitter.prototype, 'emit').mockImplementation(function (this: any, event: any, ...args: any[]) {
    if (owner && this.pid === owner.pid) {
      if (event === 'message' && args[0]?.result) {
        this.kill('SIGKILL');
        if (mode === 'after-exit') { delayed = args; return true; }
      }
      const result = emitted.call(this, event, ...args);
      if (event === 'exit' && delayed) {
        const packet = delayed; delayed = undefined;
        queueMicrotask(() => emitted.call(this, 'message', ...packet));
      }
      if (event === 'close') release?.();
      return result;
    }
    return emitted.call(this, event, ...args);
  });
  try {
    const result = await host.runOperation({ module: new URL('./fixtures/rewrite-native-operation.mjs', import.meta.url).href,
      method: mode === 'after-exit' ? 'completed' : 'completedWithMember', args: [] }, {
      ready: async value => { owner = value; return { ok: true, value: true }; },
      updated: async () => { await new Promise<void>(done => { release = done; }); return { ok: true, value: true }; },
      closed: async () => { retired = true; return { ok: true, value: true }; },
    });
    expect(result).toEqual({ ok: true, value: true });
    expect(retired).toBe(true);
    expect(host.groupState(owner)).toBe('dead');
  } finally { vi.restoreAllMocks(); if (owner) await host.endOperation(owner); }
});

it('retains unknown when a real operation worker exits without any terminal IPC result', async () => {
  let owner: any, retired = false;
  try {
    expect(await host.runOperation({ module: new URL('./fixtures/rewrite-native-operation.mjs', import.meta.url).href,
      method: 'exitWithoutResult', args: [] }, {
      ready: async value => { owner = value; return { ok: true, value: true }; },
      updated: async () => ({ ok: true, value: true }),
      closed: async () => { retired = true; return { ok: true, value: true }; },
    })).toMatchObject({ ok: false, kind: 'unknown' });
    expect(retired).toBe(false);
  } finally { if (owner) await host.endOperation(owner); }
});

it('normal authenticated SIGKILL drains well inside the one backstop', async () => {
  const worker = known(await host.beginOperation());
  let signalledAt = 0;
  const nativeKill = process.kill.bind(process), signal = vi.spyOn(process, 'kill').mockImplementation((pid, kind) => {
    if (pid === -worker.owner.group && kind === 'SIGKILL') signalledAt = performance.now();
    return nativeKill(pid, kind);
  });
  try {
    expect(await host.endOperation(worker.owner)).toEqual({ ok: true, value: 'dead' });
    const elapsedMs = performance.now() - signalledAt;
    expect(signalledAt).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(host.DRAIN_BACKSTOP_MS / 3);
    await new Promise(resolve => setTimeout(resolve, 0));
    process.stderr.write('Native evidence closure-drain ' + JSON.stringify({ platform: process.platform, elapsedMs,
      backstopMs: host.DRAIN_BACKSTOP_MS, group: host.groupState(worker.owner) }) + '\n');
  } finally { signal.mockRestore(); known(await host.endOperation(worker.owner)); }
}, 2 * host.DRAIN_BACKSTOP_MS);


it.skipIf(!kernelCapabilities.procStat || !kernelCapabilities.childSubreaper || kernelCapabilities.zombieGroup !== 'present').each(['invocation', 'record'])('real %s launch and cancel retain unreaped ownership and attention until reaping', async mode => {
  const f = await fixture();
  const script = join(f.outside, 'held-zombie.mjs'), releasePath = join(f.outside, 'reap');
  // A dedicated subreaper owns the deliberately displaced parent too; no fixture orphan is left to PID 1.
  const driver = `
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [fixtureUrl, sandboxUrl, releasePath] = process.argv.slice(2);
const { fixture, known, wait } = await import(fixtureUrl);
const { SandboxManager } = await import(sandboxUrl);
const host = await import(${JSON.stringify(new URL('../../dist-rewrite/host/process.js', import.meta.url).href)});
const state = await import(${JSON.stringify(new URL('../../dist-rewrite/records/state.js', import.meta.url).href)});
const { stateFixture } = await import(${JSON.stringify(new URL('../fixtures/rewrite-state.ts', import.meta.url).href)});
const { runServices } = await import(${JSON.stringify(new URL('../fixtures/rewrite-run-services.ts', import.meta.url).href)});
const { operateRun } = await import(${JSON.stringify(new URL('../../dist-rewrite/ops/run.js', import.meta.url).href)});
const { readRunStatus } = await import(${JSON.stringify(new URL('../../dist-rewrite/ops/status.js', import.meta.url).href)});
const mode = ${JSON.stringify(mode)};
const f = await fixture(), r = await stateFixture(); let owner;
await r.admit();await mkdir(join(r.root, 'tmp'));
const services = runServices(r), ports = services.process(r.execution);
services.unitContext.pending = async () => ({ ok: true, value: state.readHostState(r.journal).value.pending });
const cancel = async id => operateRun({ location: r.location, intent: { id, kind: 'cancel', run: r.location.run,
  unit: r.launch.unit, expectedCursor: (await r.projection()).cursor } }, services);
const python = await host.nativeTool('python3');
const code = ${JSON.stringify(`
import os,time,sys
original=os.getpgrp()
p=os.fork()
if p==0:
 os.setpgid(0,0)
 # The displaced reaper must not hold nativeSpawn's result pipes open.
 with open('/dev/null','r+b',buffering=0) as sink:
  for fd in (0,1,2):os.dup2(sink.fileno(),fd)
 z=os.fork()
 if z==0:
  os.setpgid(0,original)
  os._exit(0)
 while True:
  with open('/proc/%d/stat'%z) as f:
   if f.read().split(') ')[1].startswith('Z'):break
  time.sleep(.01)
 with open(sys.argv[2],'w') as f:f.write(str(z))
 while not os.path.exists(sys.argv[1]):time.sleep(.01)
 os.waitpid(z,0)
 os._exit(0)
while not os.path.exists(sys.argv[2]):time.sleep(.01)
os._exit(0)
`)};
const marker = join(f.work, 'zombie');
const wrap = SandboxManager.wrapWithSandboxArgv;
const pythonFile = join(f.outside, 'held.py');await writeFile(pythonFile, code);
SandboxManager.wrapWithSandboxArgv = async () => ({ argv: [await host.nativeTool('sh'), '-c',
  [python, '-I', '-S', '-B', pythonFile, releasePath, marker].map(p => "'" + p + "'").join(' ')], env: {} });
try {
 const result = mode === 'invocation'
   ? await host.launchInvocation(f.grant, { argv: [process.execPath, '-e', ''], cwd: f.work,
     env: { PATH: process.env.PATH, HOME: f.home }, writableRoots: f.grant.writableRoots }, ports, new AbortController().signal)
   : await state.recordOperation(r.journal, 'construct', {
     module: ${JSON.stringify(new URL('./fixtures/rewrite-native-operation.mjs', import.meta.url).href)},
     method: 'heldZombie', args: [pythonFile, releasePath, marker] });
 assert.equal(host.isUnconfirmedClosure(result), true, JSON.stringify(result));owner = result.closure.owner;
 const zombie = Number(await readFile(marker, 'utf8'));
 assert(result.closure.members.some(m => m.pid === zombie && m.state === 'Z'));
 assert.equal(state.readHostState(r.journal).value.pending.length, mode === 'invocation' ? 1 : 0);
 if (mode === 'invocation') { const streams = await readFile(owner.streams.stdout);assert.equal(streams.length, 0); }
 assert.equal((await state.readEvents(r.journal, 0)).value.some(e => e.payload.type === 'process'), false);
 // Invocation ownership lives in the journal; recordOperation owns a real SQL row.
 // There is no production API for assigning invocation groups to claim()'s separate idle executor.
 const claimRows = () => { const db = new DatabaseSync(r.database); try {
   return db.prepare("SELECT id,owner,epoch FROM resources WHERE holder=? AND id LIKE 'record:%'").all(r.journal.root);
 } finally { db.close(); } };
 const before = claimRows();assert.equal(before.length, mode === 'record' ? 1 : 0);
 if (mode === 'record') assert.deepEqual(JSON.parse(before[0].owner), owner);
 await r.releaseClaims();
 const stopped = known(await cancel('CancelZombie'));
 assert.equal(stopped.state, 'not_confirmed_closed');
 assert(stopped.detail.includes('"pid":' + zombie + ',"state":"Z"'));
 assert.equal((await r.projection()).status, 'cancelled');
 const status = known(readRunStatus(r.location));
 assert.equal(status.status, 'cancelled');
 assert.equal(status.attention.reason, 'closure_unconfirmed');
 assert.equal(status.attention.detail, stopped.detail);
 assert(status.attention.obligations.some(o => o.kind === 'closure-unconfirmed' && o.members.some(m => m.pid === zombie && m.state === 'Z')));
 assert.equal(state.readHostState(r.journal).value.pending.length, mode === 'invocation' ? 1 : 0);
 const retained = claimRows();assert.deepEqual(retained, before);
 assert.equal((await r.projection()).operations.length, 1);
 const resumed = await operateRun({ location: r.location, intent: { id: 'ResumeZombie', kind: 'resume', run: r.location.run,
   unit: r.launch.unit, expectedCursor: (await r.projection()).cursor } }, services);
 assert.equal(resumed.ok, false);assert.equal(resumed.kind, 'conflict');
 await writeFile(releasePath, 'reap');
 await wait(async () => host.groupState(owner) === 'dead');
 assert.equal(known(await cancel('RepeatCancelZombie')).state, 'acknowledged');
 assert.equal((await r.projection()).status, 'cancelled');
 assert.equal(state.readHostState(r.journal).value.pending.length, 0);
 assert.equal(claimRows().length, 0);
 console.log(JSON.stringify({launch: result.closure, stop: stopped, parked: status.status, attention: status.attention,
   mode, retainedClaims: retained.length, recovered: true}));
} finally {
 await writeFile(releasePath, 'reap');
 if (owner) { await wait(async () => host.groupState(owner) === 'dead');known(await host.endOperation(owner)); }
 known(await state.reclaimRecordOperations(r.journal));
 SandboxManager.wrapWithSandboxArgv = wrap;await r.close();await f.close();
}
`;
  await writeFile(script, driver);
  const python = await host.nativeTool('python3');
  const child = spawn('/usr/bin/nice', ['-n', '19', python, '-I', '-S', '-B', '-c', `
import ctypes,os,subprocess,sys
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
p=subprocess.Popen(sys.argv[1:])
code=p.wait()
while True:
 try:os.waitpid(-1,0)
 except ChildProcessError:break
sys.exit(code)
`, 'nice', '-n', '19', process.execPath, '--import', import.meta.resolve('tsx'), script,
    new URL('../fixtures/rewrite-host.ts', import.meta.url).href, import.meta.resolve('@anthropic-ai/sandbox-runtime'), releasePath],
  {cwd: resolve('.'), env: {PATH: process.env.PATH!, HOME: f.home}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';child.stdout.on('data', b => stdout += b);child.stderr.on('data', b => stderr += b);
  try {
    const exit = await new Promise(resolve => child.once('close', resolve));
    expect(exit, stderr + stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ recovered: true, launch: { state: 'not_confirmed_closed' }, stop: { state: 'not_confirmed_closed' }, parked: 'cancelled', mode, retainedClaims: mode === 'record' ? 1 : 0 });
    process.stderr.write('Native evidence real-invocation-zombie ' + stdout);
  } finally { await writeFile(releasePath, 'reap'); await f.close(); }
}, 4 * host.DRAIN_BACKSTOP_MS);

it.each([
  {ok:false,kind:'unavailable',detail:'Declared launch refused'},
  {ok:true,value:{state:'not_started',grant:'refused',exit:null,signal:null}}
])('wait consumes a completed supervisor result without waiting for readiness: %j', async outcome => {
  await expect(wait(async () => false,async () => outcome)).rejects.toThrow(JSON.stringify(outcome));
});

it('wait preserves a rejected launch Error message and structured cause', async () => {
  const cause = {ok:false,kind:'unavailable',detail:'Declared launch refused'};
  const outcome = Error('Launch refused before workload', {cause});
  const result = wait(async () => false, Promise.reject(outcome));
  await expect(result).rejects.toThrow('Launch refused before workload');
  await expect(result).rejects.toThrow(JSON.stringify(cause));
  await expect(result).rejects.toHaveProperty('cause',outcome);
});

// The parent holds waitpid until requested, so this observes a real zombie-only group.
it('reports native zombie-only group observations without treating EPERM as empty', async () => {
  const child = spawn('/usr/bin/nice', ['-n','19',await host.nativeTool('python3'),'-I','-S','-B','-c', `
import os, signal, sys
signal.signal(signal.SIGCHLD, lambda s, f: None)
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
ready_r, ready_w = os.pipe()
go_r, go_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(ready_r); os.close(go_w)
    os.setsid()
    os.write(ready_w, b'1')
    os.read(go_r, 1)
    os._exit(0)
os.close(ready_w); os.close(go_r)
try:
    os.read(ready_r, 1)
    print(pid, flush=True)
    sys.stdin.readline()
    os.write(go_w, b'1')
    signal.sigwait({signal.SIGCHLD})
    print('zombie', flush=True)
    sys.stdin.readline()
finally:
    os.close(go_w)
    os.waitpid(pid, 0)
`], {stdio:['pipe','pipe','pipe']});
  const exited = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  try {
    const pid = Number((await lines.next()).value);
    const owner = {...await host.identity(pid),authority:'synthetic-zombie'};
    expect(await host.probeOwner(owner)).toBe('live');
    child.stdin.write('exit child\n');
    expect((await lines.next()).value,stderr).toBe('zombie');
    const expected = {present:'live',absent:'dead',EPERM:'unknown'} as const;
    const observed = host.groupState(owner), probed = await host.probeOwner(owner);
    expect(observed).toBe(expected[kernelCapabilities.zombieGroup]);
    expect(probed).toBe(observed);
    const closed = await host.endOperation(owner);
    expect(closed).toMatchObject(observed === 'dead' ? {ok:true,value:'dead'} :
      {ok:false,kind:'unknown',closure:{state:'not_confirmed_closed',observation:observed,owner}});
    process.stderr.write('Native evidence zombie-only group ' + JSON.stringify({platform:process.platform,
      capability:kernelCapabilities.zombieGroup,observed,probed,closed}) + '\n');
    child.stdin.end('reap child\n');
    expect(await exited,stderr).toBe(0);
    expect(host.groupState(owner)).toBe('dead');
    expect(await host.endOperation(owner)).toEqual({ok:true,value:'dead'});
  } finally { if (!child.stdin.writableEnded) child.stdin.end('reap child\n'); await exited; }
});
