import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { access,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect,it,vi } from 'vitest';
import { kernelCapabilities } from './fixtures/kernel-capabilities.js';
import * as host from '../../dist-rewrite/host/process.js';
import * as state from '../../dist-rewrite/records/state.js';
import { fixture,known,pause,wait,recordedClosed } from '../fixtures/rewrite-host.js';
it('exact stdin/stdout/stderr bytes and direct exit 7 survive durable streams; fd 3 cannot forge receipt', async () => {
  const f = await fixture();
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  try {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 65]), stdin = known(await f.ports.putEvidence(bytes));
    const receipt = await f.launch(("const fs=require('fs');let fd3=false;try{fs.writeSync(3,'forged')}catch{fd3=true};" +
      "process.stdout.write(fs.readFileSync(0));process.stderr.write(fd3?'private':'LEAK');process.exitCode=7"), { program: { stdin } });
    expect(receipt).toMatchObject({ state: 'closed', guarantee: 'marker', exit: 7, signal: null });
    expect(receipt).not.toHaveProperty('grant');
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
    // Only the first live record precedes release; later ones (a member joining) are written while the program already runs.
    // The observation is asserted after the launch: an assertion thrown inside persistence would surface as a null exit.
    let markerAtOwnership: boolean | undefined;
    f.ports.recordProcess = async (payload) => { if (payload.type === 'ownership' && payload.state === 'live' && markerAtOwnership === undefined) {
      markerAtOwnership = await access(marker).then(() => true, () => false);
    } return original(payload); };
    expect((await f.launch(code)).exit).toBe(0);
    expect(markerAtOwnership).toBe(false);
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
it('forced marker fallback retires ownership after retaining an honest best effort receipt', async () => {
  const f = await fixture();
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  try {
    const receipt = await f.launch(`process.stdout.write('marker output')`);
    expect(receipt).toMatchObject({state:'closed',guarantee:'marker',scope:'group',exit:0,signal:null});
    expect(receipt.owner?.containment).toEqual({kind:'marker',marker:receipt.owner?.authority});
    expect(await f.text(receipt.stdout)).toBe('marker output');
    const facts = known(await state.readEvents(f.journal,0));
    expect(facts.filter(e=>e.payload.type === 'owner_closed').at(-1)?.payload).toMatchObject({owner:receipt.owner});
    expect(recordedClosed(f.journal, receipt.owner!)).toBe(true);
    expect(known(state.readHostState(f.journal)).pending).toEqual([]);
    expect((await f.launch(`process.exitCode=3`))).toMatchObject({state:'closed',guarantee:'marker',exit:3});
  } finally { await f.close(); }
});
it('cancel closes an invocation while authenticated stdin is backpressured before readiness', async () => {
  const f = await fixture(), abort = new AbortController(), onReady = vi.fn();
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  let owner: any, running: Promise<any> | undefined;
  try {
    const marker = join(f.work,'stdin-blocked');
    const stdin = known(await f.ports.putEvidence(Buffer.alloc(1024 * 1024,65)));
    const code = `require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)`;
    running = host.launchInvocation({}, {argv:[process.execPath,'-e',code,marker],cwd:f.work,
      env:{PATH:process.env.PATH!,HOME:f.home},stdin}, f.ports, abort.signal, {onReady});
    await wait(async () => access(marker).then(()=>true,()=>false),running);
    abort.abort();
    const receipt = known(await running);owner=receipt.owner;
    expect(receipt).toMatchObject({state:'closed',guarantee:'marker',exit:null,signal:'SIGKILL'});
    expect(onReady).not.toHaveBeenCalled();
    expect(host.groupState(owner)).toBe('dead');
  } finally {
    abort.abort();if (running) { const result = await running.catch(()=>undefined);owner ??= result?.value?.owner; }
    if (owner) await host.closeOperation(owner);await f.close();
  }
});
it('the provider terminal event ends the invocation after the grace period although a descendant stays blocked on stdin', async () => {
  const f = await fixture(), abort = new AbortController(), pidFile = join(f.work, 'blocked.pid');
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  let running: Promise<any> | undefined, resultAt = 0, settledAt = 0, blocked = 0;
  try {
    // Like a provider whose tool is blocked on a pipe: it emits its result, then never exits while the tool lives.
    const child = `require('fs').writeFileSync(process.argv[1],String(process.pid));process.stdin.resume()`;
    const code = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(pidFile)}],` +
      `{stdio:['pipe','ignore','ignore']});const fs=require('fs');const tick=()=>fs.existsSync(${JSON.stringify(pidFile)})?` +
      `process.stdout.write('result\\n'):setTimeout(tick,10);tick();c.on('exit',()=>process.exit(0))`;
    let session: { end(): void } | undefined;
    running = f.launch('', { program: { argv: [process.execPath, '-e', code] }, abort: abort.signal, io: {
      onReady: (value: { end(): void }) => { session = value; },
      onStdout: (bytes: Uint8Array) => { if (!resultAt && Buffer.from(bytes).includes('result')) { resultAt = performance.now(); session!.end(); } } } });
    const receipt = await running; settledAt = performance.now();
    blocked = Number(await readFile(pidFile, 'utf8'));
    expect(receipt).toMatchObject({ state: 'closed', exit: null, signal: null, guarantee: 'marker', closedAtTerminal: true });
    expect(settledAt - resultAt).toBeGreaterThanOrEqual(host.TERMINAL_GRACE_MS - 100);
    expect(host.groupState(receipt.owner!)).toBe('dead');
    expect(() => process.kill(blocked, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(recordedClosed(f.journal, receipt.owner!)).toBe(true);
  } finally {
    abort.abort(); if (running) await running.catch(() => undefined);
    if (blocked) try { process.kill(blocked, 'SIGKILL'); } catch { }
    await f.close();
  }
});
it('an exit inside the grace period settles the invocation at the exit with its real status', async () => {
  const f = await fixture(); let end: (() => void) | undefined;
  try {
    const receipt = await f.launch(`process.stdin.resume();process.stdin.on('end',()=>process.exit(5));process.stdout.write('result\\n')`, {
      io: { onReady: (value: { end(): void }) => { end = value.end; }, onStdout: () => end!() } });
    expect(receipt).toMatchObject({ state: 'closed', exit: 5, signal: null });
    expect(receipt).not.toHaveProperty('closedAtTerminal');
  } finally { await f.close(); }
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
for (const guarantee of ['cgroup', 'marker'] as const) it.skipIf(guarantee === 'cgroup' && process.platform !== 'linux')(`P4 ${guarantee} normal/TERM/KILL close descendants including setsid without signalling unrelated work`, async () => {
  const f = await fixture();
  const script = join(f.outside, 'group-escape.mts');
  await writeFile(script, String.raw`
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const { fixture, known, wait, recordedClosed } = await import(process.argv[2]);
const host = await import(process.argv[3]);
const state = await import(process.argv[4]);
  const f = await fixture(), escapes = [];
  const guarantee = process.argv[5];
  if (guarantee === 'marker') f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
  const unrelatedDone = new Promise(resolve => unrelated.once('exit', resolve));
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
      escapes.push(...await Promise.all(Object.values(ids).map(pid => host.identity(pid))));
      if (mode === 'normal')
        await writeFile(release, 'go');
      else if (mode === 'SIGKILL')
        process.kill(owner.owner.pid, 'SIGKILL');
      else
        abort.abort();
      const receipt = await running;
      await wait(async () => host.groupState(receipt.owner) === 'dead');
      assert.equal(receipt.guarantee, guarantee);
      assert.equal(receipt.owner.containment.kind, guarantee);
      assert.equal(receipt.state, mode !== 'SIGKILL' ? 'closed' : 'closure_unknown');
      assert.equal(recordedClosed(f.journal, receipt.owner), true);
      await wait(async () => Object.values(ids).every(pid => {
        try { process.kill(pid,0);return false; } catch { return true; }
      }), undefined, AbortSignal.timeout(host.DRAIN_BACKSTOP_MS));
      const survivors = {};
      for (const [name, pid] of Object.entries(ids)) {
        try { process.kill(pid, 0); survivors[name] = true; }
        catch { survivors[name] = false; }
      }
      assert.equal(survivors.ordinary, false);
      assert.equal(survivors.setsid, false);
      assert.equal(survivors.doubleFork, false);
      assert.equal(process.kill(unrelated.pid, 0), true);
      await f.evidence('P4-' + mode, { mode, receipt, insideIdentities: ids, survivors });
    }
  }
  finally {
    unrelated.kill('SIGKILL'); await unrelatedDone;
    for (const owner of escapes)
      try {
        const current = await host.identity(owner.pid);
        if (current.start === owner.start && current.boot === owner.boot && current.group === owner.group) process.kill(owner.pid, 'SIGKILL');
      }
      catch { }
    await f.close();
  }
`);
  const child = spawn('/usr/bin/nice', ['-n', '19', await host.nativeTool('python3'), '-I', '-S', '-B', '-c', `
import ctypes,os,subprocess,sys
if sys.platform=='linux':assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
p=subprocess.Popen(sys.argv[1:])
code=0
while True:
 try:
  pid,status=os.wait()
  if pid==p.pid:code=os.waitstatus_to_exitcode(status)
 except ChildProcessError:break
sys.exit(code)
`, 'nice', '-n', '19', process.execPath, '--import', import.meta.resolve('tsx'), script,
    new URL('../fixtures/rewrite-host.ts', import.meta.url).href,
    new URL('../../dist-rewrite/host/process.js', import.meta.url).href,
    new URL('../../dist-rewrite/records/state.js', import.meta.url).href, guarantee],
    {env:{PATH:process.env.PATH!, HOME:f.home, TMPDIR:f.outside},stdio:['ignore','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  try { expect(await new Promise(resolve => child.once('close', resolve)), stderr + stdout).toBe(0);
    process.stderr.write(stderr);
  } finally { await f.close(); }
});
it('a recorded native birth closes the group after anchor death without a PID namespace', async () => {
  const f = await fixture();
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
    expect(recordedClosed(f.journal, receipt.owner!)).toBe(true);
    expect(receipt.owner!.members).toEqual(owner.members);
    expect(host.groupState(receipt.owner!)).toBe('dead');
    await f.evidence('P4-group-witness', { owner, receipt });
  } finally {
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
  const config = { containment: 'marker', location: f.location, run, work: f.work, records: f.records, home: f.home, scratch: f.scratch, marker: join(f.work,
   'started'), release: join(f.work, 'release'), result: join(f.work, 'result') };
  const configPath = join(f.outside, 'supervisor.json');
  await writeFile(configPath, JSON.stringify(config));
  const entry = { argv: [process.execPath, new URL('./fixtures/rewrite-supervisor.mjs', import.meta.url).pathname, configPath],
   cwd: f.work, env: { PATH: process.env.PATH!, HOME: f.home, TMPDIR: f.outside } };
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
     import.meta.url).pathname, launcherConfig], { env: { PATH: process.env.PATH!, HOME: f.home, TMPDIR: f.outside }, stdio: 'ignore' });
    expect(await new Promise(resolve => child.once('exit', resolve))).toBe(0);
    const started = known(JSON.parse(await readFile(marker, 'utf8')));
    expect(started.state).toBe('active'); // Production startRun accepts the ordinary host program without writableRoots.
    owner = started.owner;
    await wait(async () => access(a.config.marker).then(() => true, () => false), a.finished);
    await f.evidence('P5-RSS', { controller: owner, rss: await host.nativeExec(['ps', '-o', 'rss=', '-p', String(owner.pid)], { env: {
     PATH: process.env.PATH! } }) });
    expect((known(await host.observeRun(a.run, a.context))).state).toBe('active');
    await writeFile(a.config.release, 'go');
    await wait(async () => access(a.config.result).then(() => true, () => false));
    const receipt = known(JSON.parse(await readFile(a.config.result, 'utf8')));
    expect(receipt).toMatchObject({ state: 'closed', guarantee: 'marker', exit: 7 });
    expect(await f.text(receipt.stdout)).toBe('partial-stdout\ncomplete\n');
    expect(await f.text(receipt.stderr)).toBe('partial-stderr\n');
    await wait(async () => host.groupState(owner) === 'dead');
    expect(known(await a.context.pending())).toEqual([]);
    const facts = known(await state.readEvents(f.journal, 0));
    expect(facts.some(e => e.payload.type === 'owner_closed'
      && e.payload.owner.authority === receipt.owner.authority)).toBe(true);
    expect(recordedClosed(f.journal, receipt.owner)).toBe(true);
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
    expect(invocation.containment.kind).toBe('marker');
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
    const stopping = await host.stopRun(a.run, f.ports, a.context);
    const stopped = known(stopping);
    expect(host.groupState(controller)).toBe('dead');
    expect(host.groupState(invocation)).toBe('dead');
    const receipt = [...known(await state.readEvents(f.journal, 0))].reverse().find(e => e.payload.type === 'process')!.payload.receipt;
    expect(receipt).toMatchObject({ state: 'closure_unknown', guarantee: 'marker', exit: null, signal: null });
    expect(known(await a.context.pending())).toEqual([]);
    expect(recordedClosed(f.journal, receipt.owner!)).toBe(true);
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

it('a worker that dies before announcing itself is refused with its own exit status', async () => {
  // The worker inherits this environment and cannot load its preload, so it exits 1 before it can send its identity.
  const options = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=/nonexistent-preload.cjs';
  try {
    const refused = await host.beginOperation();
    expect(refused).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(refused.ok ? '' : refused.detail).toContain('Operation exited before ready (exit 1, signal null)');
  } finally { if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options; }
});

it('a worker that cannot establish its identity is refused with its own error over its channel', async () => {
  // A preload makes every identity source fail in the worker only (Linux /proc reads, Darwin sysctl/python3 spawns), so the
  // worker runs its entry, fails there and exits 1; its stderr is ignored, so only the channel can carry the reason.
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'fc-identity-'));
  const preload = join(directory, 'preload.cjs');
  await writeFile(preload, `const fsp = require('node:fs/promises'), cp = require('node:child_process'), read = fsp.readFile;
fsp.readFile = (path, ...rest) => String(path).startsWith('/proc/') ? Promise.reject(new Error('injected identity failure')) : read(path, ...rest);
cp.execFile = (...args) => { const done = args.at(-1); queueMicrotask(() => done(new Error('injected identity failure'))); return {}; };
require('node:module').syncBuiltinESMExports();`);
  const options = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  try {
    const refused = await host.beginOperation();
    expect(refused).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(refused.ok ? '' : refused.detail).toContain('Operation failed before ready: Error: injected identity failure');
  } finally { if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options;
    await rm(directory, { recursive: true, force: true }); }
});

// A marker owner whose leader died while a native child it started stays alive and unrecorded (no member witness was
// persisted yet): no recorded identity authenticates the group, so only the invocation marker can name the survivor.
it('a marker owner whose leader died leaves an unrecorded marked survivor: closure re-observes the group after the marker pass', async () => {
  const marker = 'marker-' + randomUUID();
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{FLOWCREW_INVOCATION:${JSON.stringify(marker)}},stdio:'ignore'});
console.log(child.pid);setInterval(()=>{},1000)`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const survivor = await new Promise<number>(resolve => leader.stdout.once('data', bytes => resolve(Number(String(bytes)))));
  const owner = { ...await host.identity(leader.pid!), authority: 'opaque', containment: { kind: 'marker' as const, marker } };
  const gone = new Promise(resolve => leader.once('exit', resolve));
  process.kill(leader.pid!, 'SIGKILL'); await gone;
  try {
    expect(host.groupState(owner)).toBe('live');
    expect(await host.probeOwner(owner)).toBe('unknown');
    expect(await host.closeOperation(owner)).toMatchObject({ ok: true, value: 'dead', guarantee: 'marker' });
    expect(host.groupState(owner)).toBe('dead');
  } finally { try { process.kill(survivor, 'SIGKILL'); } catch { /* already closed */ } }
});

it('normal authenticated SIGKILL drains inside the one backstop', async () => {
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
    await new Promise(resolve => setTimeout(resolve, 0));
    process.stderr.write('Native evidence closure-drain ' + JSON.stringify({ platform: process.platform, elapsedMs,
      backstopMs: host.DRAIN_BACKSTOP_MS, group: host.groupState(worker.owner) }) + '\n');
  } finally { signal.mockRestore(); known(await host.endOperation(worker.owner)); }
}, 2 * host.DRAIN_BACKSTOP_MS);


it.skipIf(!kernelCapabilities.procStat || !kernelCapabilities.childSubreaper || kernelCapabilities.zombieGroup !== 'present')('real record launch and cancel retain unreaped ownership and attention until reaping', async () => {
  const f = await fixture();
  const script = join(f.outside, 'held-zombie.mjs'), releasePath = join(f.outside, 'reap');
  // A dedicated subreaper owns the deliberately displaced parent too; no fixture orphan is left to PID 1.
  const driver = `
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [fixtureUrl, releasePath] = process.argv.slice(2);
const { fixture, known, wait, recordedClosed } = await import(fixtureUrl);
const host = await import(${JSON.stringify(new URL('../../dist-rewrite/host/process.js', import.meta.url).href)});
const state = await import(${JSON.stringify(new URL('../../dist-rewrite/records/state.js', import.meta.url).href)});
const { stateFixture } = await import(${JSON.stringify(new URL('../fixtures/rewrite-state.ts', import.meta.url).href)});
const { runServices } = await import(${JSON.stringify(new URL('../fixtures/rewrite-run-services.ts', import.meta.url).href)});
const { operateRun } = await import(${JSON.stringify(new URL('../../dist-rewrite/ops/run.js', import.meta.url).href)});
const { readRunStatus } = await import(${JSON.stringify(new URL('../../dist-rewrite/ops/status.js', import.meta.url).href)});
const f = await fixture(), r = await stateFixture(); let owner;
await r.admit();await mkdir(join(r.root, 'tmp'));
const services = runServices(r);
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
const pythonFile = join(f.outside, 'held.py');await writeFile(pythonFile, code);
try {
 const result = await state.recordOperation(r.journal, 'construct', {
     module: ${JSON.stringify(new URL('./fixtures/rewrite-native-operation.mjs', import.meta.url).href)},
     method: 'heldZombie', args: [pythonFile, releasePath, marker] });
 assert.equal(host.isUnconfirmedClosure(result), true, JSON.stringify(result));owner = result.closure.owner;
 const zombie = Number(await readFile(marker, 'utf8'));
 assert(result.closure.members.some(m => m.pid === zombie && m.state === 'Z'));
 assert.equal(state.readHostState(r.journal).value.pending.length, 0);
 assert.equal((await state.readEvents(r.journal, 0)).value.some(e => e.payload.type === 'process'), false);
 // recordOperation owns a real SQL row until the group can be proved empty.
 const claimRows = () => { const db = new DatabaseSync(r.database); try {
   return db.prepare("SELECT id,owner,epoch FROM resources WHERE holder=? AND id LIKE 'record:%'").all(r.journal.root);
 } finally { db.close(); } };
 const before = claimRows();assert.equal(before.length, 1);
 assert.deepEqual(JSON.parse(before[0].owner), owner);
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
 assert.equal(state.readHostState(r.journal).value.pending.length, 0);
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
   mode: 'record', retainedClaims: retained.length, recovered: true}));
} finally {
 await writeFile(releasePath, 'reap');
 if (owner) { await wait(async () => host.groupState(owner) === 'dead');known(await host.endOperation(owner)); }
 known(await state.reclaimRecordOperations(r.journal));
 await r.close();await f.close();
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
    new URL('../fixtures/rewrite-host.ts', import.meta.url).href, releasePath],
  {cwd: resolve('.'), env: {PATH: process.env.PATH!, HOME: f.home, TMPDIR: f.outside}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';child.stdout.on('data', b => stdout += b);child.stderr.on('data', b => stderr += b);
  try {
    const exit = await new Promise(resolve => child.once('close', resolve));
    expect(exit, stderr + stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ recovered: true, launch: { state: 'not_confirmed_closed' }, stop: { state: 'not_confirmed_closed' }, parked: 'cancelled', mode: 'record', retainedClaims: 1 });
    process.stderr.write('Native evidence real-invocation-zombie ' + stdout);
  } finally { await writeFile(releasePath, 'reap'); await f.close(); }
}, 4 * host.DRAIN_BACKSTOP_MS);

it.each([
  {ok:false,kind:'unavailable',detail:'Declared launch refused'},
  {ok:true,value:{state:'not_started',exit:null,signal:null}}
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

it.runIf(process.platform === 'darwin')('darwin identity uses the native boot-session UUID and a repeatable microsecond birth', async () => {
  const first = await host.identity();
  const session = await host.nativeExec([await host.nativeTool('sysctl'), '-n', 'kern.bootsessionuuid']);
  const second = await host.identity();
  expect(first.boot).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  expect(first.boot).toBe(session.stdout.trim());
  expect(first.start).toMatch(/^\d+:\d+$/);
  expect(second).toEqual(first);
});

it.each(['normal', 'cancel', 'supervisor-kill'])('native %s uses the same recorded marker closure and durable streams', async mode => {
  const f = await fixture();
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  const abort = new AbortController();
  let owner: any, running: Promise<any> | undefined;
  try {
    const ready = join(f.work, 'ready'), release = join(f.work, 'release');
    const code = String.raw`
      const fs=require('node:fs'),cp=require('node:child_process');
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeSync(1,'owned native stdout\n');fs.writeSync(2,'owned native stderr\n');
      fs.writeFileSync(process.argv[1],String(child.pid));
      const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.exit(0)}},10);
    `;
    const argv = [process.execPath, '-e', code, ready, release];
    const command = { id: 'Declared', argv, env: {}, inputs: [], required: true };
    running = f.launch('', { program: { argv }, command, abort: abort.signal });
    await wait(async () => access(ready).then(() => true, () => false), running);
    await wait(async () => {
      const facts = known(await state.readEvents(f.journal, 0));
      owner = facts.filter(e => e.payload.type === 'ownership' && e.payload.state === 'live').at(-1)?.payload.owner;
      return !!owner?.members?.length;
    }, running);
    expect(owner).not.toHaveProperty('unconfined');
    if (mode === 'normal') await writeFile(release, 'go');
    else if (mode === 'cancel') abort.abort();
    else process.kill(owner.pid, 'SIGKILL');
    const receipt = await running;
    expect(receipt).toMatchObject({ guarantee: 'marker', scope: 'group',
      state: mode !== 'supervisor-kill' ? 'closed' : 'closure_unknown' });
    expect(receipt).not.toHaveProperty('grant');
    expect(host.groupState(receipt.owner!)).toBe('dead');
    expect(await f.text(receipt.stdout)).toBe('owned native stdout\n');
    expect(await f.text(receipt.stderr)).toBe('owned native stderr\n');
    const facts = known(await state.readEvents(f.journal, 0));
    expect(facts.some(e => e.payload.type === 'owner_closed')).toBe(true);
    expect(recordedClosed(f.journal, receipt.owner!)).toBe(true);
    expect(facts.filter(e => e.payload.type === 'process').at(-1)?.payload.receipt).toEqual(receipt);
  } finally { abort.abort(); if (owner) await host.closeOperation(owner); if (running) await running.catch(() => {}); await f.close(); }
});

it('finds a platform tool in the system directories when the operator PATH omits them', async () => {
  const identityModule = new URL('../../dist-rewrite/host/identity.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(identityModule)}); process.stdout.write(await m.nativeTool('sh'));`],
    { env: { PATH: '/nonexistent-flowcrew-path' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exit = await new Promise(resolve => child.once('close', resolve));
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
  expect(['/usr/bin/sh', '/bin/sh']).toContain(stdout);
});
