import { readFile, readdir, open, stat, access } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { closeOperation, endOperation, identity, probeOwner, stopRun, scanMarker, GROUP_DRAIN_MS, CLOSURE_RUNAWAY_MS } from '../dist-rewrite/host/process.js';

const native = vi.hoisted(() => ({ execute: vi.fn(), lock: vi.fn(), close: vi.fn() }));
vi.mock('node:sqlite', () => ({ DatabaseSync: class { exec = native.lock; close = native.close; } }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: native.execute }) };
});
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn(), stat: vi.fn(), readdir: vi.fn(), open: vi.fn(), access: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
/** Authored /proc: one process stat line, and the current boot id. */
const proc = (stat: string, boot = 'boot') => async (path: unknown) => String(path).endsWith('/boot_id') ? boot : stat;

it('observes live drainage until ESRCH', async () => {
  // Authored kernel observations: no worker, real process identity or host read.
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  const stat = '42 (fixture) ' + fields.join(' ');
  vi.mocked(readFile).mockImplementation(proc(stat) as any);
  const kill = vi.fn().mockReturnValue(true);
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'linux' }, kill: { value: kill },
  }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Initial live probe, authenticated signal, four live polls, then empty group.
  kill.mockReturnValueOnce(true).mockReturnValueOnce(true);
  for (let poll = 0; poll < 4; poll++) kill.mockReturnValueOnce(true);
  kill.mockImplementationOnce(() => { throw Object.assign(Error('Empty group'), { code: 'ESRCH' }); });
  const closing = closeOperation(owner);
  await vi.runAllTimersAsync();
  expect(await closing).toEqual({ ok: true, value: 'dead' });
  expect(kill.mock.calls).toEqual([[-42, 0], [-42, 'SIGKILL'],
    [-42, 0], [-42, 0], [-42, 0], [-42, 0], [-42, 0]]);


});

it('one closure owner waits through unavailable post-signal observations for ESRCH', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  vi.mocked(readFile).mockImplementation(proc('42 (fixture) ' + fields.join(' ')) as any);
  const unavailable = () => { throw Object.assign(Error('Unavailable'), { code: 'EPERM' }); };
  const empty = () => { throw Object.assign(Error('Empty'), { code: 'ESRCH' }); };
  const kill = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true)
    .mockImplementationOnce(unavailable).mockReturnValueOnce(true).mockImplementationOnce(empty);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const closing = endOperation(owner);
  await vi.runAllTimersAsync();
  expect(await closing).toEqual({ ok: true, value: 'dead' });
  expect(kill.mock.calls).toEqual([[-42, 0], [-42, 'SIGKILL'], [-42, 0], [-42, 0], [-42, 0]]);
  // EPERM before authentication never authorizes a signal or retirement.
  vi.mocked(readdir).mockResolvedValue([]);
  kill.mockImplementation(unavailable);
  expect(await endOperation(owner)).toMatchObject({ ok: false, kind: 'unknown' });
  expect(kill.mock.calls.slice(5)).toEqual([[-42, 0]]);
});

it('persistent EPERM after authenticated SIGKILL returns typed unconfirmed closure at the one backstop', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  const kill = vi.fn().mockImplementation(() => { throw Object.assign(Error('Unavailable'), { code: 'EPERM' }); })
    .mockReturnValueOnce(true).mockReturnValueOnce(true);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  const zombieFields = [...fields]; zombieFields[0] = 'Z'; zombieFields[1] = '1';
  vi.mocked(readFile).mockImplementation(proc('42 (fixture) ' + zombieFields.join(' ')) as any);
  vi.mocked(readdir).mockResolvedValue(['42'] as any);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const closing = closeOperation(owner);
  let settled = false; void closing.then(() => { settled = true; });
  // Independent native drain ceiling: do not let the controller's five-minute wait leak into this path.
  await vi.advanceTimersByTimeAsync(8600);
  expect(settled, 'SIGKILL group drain exceeded its independent 8.6-second ceiling').toBe(true);
  const result = await closing;
  expect(result).toMatchObject({ ok: false, kind: 'unknown', closure: { state: 'not_confirmed_closed',
    owner, observation: 'unknown', members: [{ pid: 42, state: 'Z', parent: 1 }] } });
  expect(result.ok ? '' : result.detail).toContain('The recorded group still holds an unreaped process, which happens when PID 1 does not reap orphans');
  expect(result.ok ? '' : result.detail).toContain('Check process ownership, permissions and the parent reaper; then repeat cancel for a cancelled run, or resume an uncancelled parked run, to retry closure.');
  expect(kill.mock.calls.filter(call => call[1] === 'SIGKILL')).toEqual([[-42, 'SIGKILL']]);
});

for (const witness of ['leader', 'member']) {
  it.each([false, true])(`darwin ${witness} authentication ignores adjusted boottime and closes an owner of another boot as dead (%s)`, async differentBoot => {
    // Two authored kernel snapshots, with the real failure's changing boottime shape.
    let snapshot = { boottime: '{ sec = 1000, usec = 870801 } calendar text',
      boot: '11111111-2222-4333-8444-555555555555' };
    native.execute.mockImplementation(async (tool: string, argv: string[]) => {
      if (tool.endsWith('/sysctl')) return { stdout: (argv[1] === 'kern.bootsessionuuid' ? snapshot.boot : snapshot.boottime) + '\n', stderr: '' };
      if (tool.endsWith('/ps')) return { stdout: '42 42 SNs 1\n', stderr: '' };
      const pid = Number(argv.at(-1));
      return { stdout: JSON.stringify(pid === 42 ? { pid, group: 42, start: '2000:123456' } : { error: 3 }), stderr: '' };
    });
    const kill = vi.fn().mockReturnValue(true);
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' }, kill: { value: kill },
      env: { value: { PATH: '/fixture/bin' } } }));
    const recorded = await identity(42);
    const owner = { ...recorded, authority: 'recorded', ...(witness === 'member' ? {
      pid: 41, members: [{ pid: recorded.pid, start: recorded.start, boot: recorded.boot }],
    } : {}) };
    snapshot = { boottime: '{ sec = 1000, usec = 789949 } corrected calendar text',
      boot: differentBoot ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : snapshot.boot };
    if (!differentBoot) {
      // Live group, authenticated signal, then ESRCH; no native process or timer.
      kill.mockReturnValueOnce(true).mockReturnValueOnce(true).mockImplementationOnce(() => {
        throw Object.assign(Error('Empty group'), { code: 'ESRCH' });
      });
      expect(await closeOperation(owner)).toEqual({ ok: true, value: 'dead' });
      expect(kill.mock.calls).toEqual([[-42, 0], [-42, 'SIGKILL'], [-42, 0]]);
    } else {
      expect(await closeOperation(owner)).toMatchObject({ ok: true, value: 'dead' });
      expect(kill).not.toHaveBeenCalled();
    }
  });
}


it.each([false, true].flatMap(interrupt => ['active', 'unknown'].map(state => ({ interrupt, state }))))('round 14 legacy controller without a lock explains refusal without signalling ($state, interrupt=$interrupt)', async ({ interrupt, state }) => {
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'recorded'};
  const fields = Array<string>(20).fill('0');fields[2]='42';fields[19]='birth';
  vi.mocked(readFile).mockImplementation(state === 'active' ? proc('42 (fixture) '+fields.join(' ')) as any
    : async () => { throw Object.assign(Error('Observation denied'), { code: 'EPERM' }); });
  vi.mocked(access).mockRejectedValueOnce(Object.assign(Error('missing'),{code:'ENOENT'}));
  const kill = vi.fn();
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  const unit = {run:'Run',runtime:{path:'runtime',sha256:'a'.repeat(64)},authority:'unit'};
  expect(await stopRun(unit,{} as any,{storeRoot:'/authored',observation:async()=>({ok:true,value:{unit,state:'active',owner}})} as any,interrupt))
    .toMatchObject({ok:false,kind:state === 'unknown' ? 'unknown' : 'conflict',
      detail: 'Controller has no closure lock; closure refused to preserve receipts. If this run was started by an earlier build, cancel with that build or wait for the controller to finish, then retry. If activation was interrupted, wait for the controller to finish, then retry'});
  expect(kill).not.toHaveBeenCalled();
});

it.each([false, true])('controller closure backstop retains evidence without killing a flushing recorder (interrupt=%s)', async interrupt => {
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'recorded'};
  const fields = Array<string>(20).fill('0');fields[2]='42';fields[19]='birth';
  vi.mocked(readFile).mockImplementation(async path => String(path).endsWith('/stat') ? '42 (fixture) '+fields.join(' ') : 'boot');
  const kill = vi.fn(() => true);
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  native.lock.mockImplementation(() => { throw Object.assign(Error('database is locked'), {errcode:5}); });
  const unit = {run:'Run',runtime:{path:'runtime',sha256:'a'.repeat(64)},authority:'unit'};
  const pending = vi.fn(), recordProcess = vi.fn();
  const stopping = stopRun(unit,{recordProcess} as any,{
    storeRoot:'/authored',observation:async () => ({ok:true,value:{unit,state:'active',owner,evidence:[],detail:'live'}}),pending
  } as any,interrupt);
  expect(await stopping).toMatchObject({ok:false,kind:'unavailable',detail:expect.stringContaining('Controller exit is not confirmed. Evidence and work are retained.')});
  const waited = native.lock.mock.calls[0][0];
  expect(waited).toMatch(/^PRAGMA busy_timeout=\d+; BEGIN; SELECT count\(\*\) FROM sqlite_master$/);
  expect(Number(waited.match(/busy_timeout=(\d+)/)[1])).toBeLessThanOrEqual(CLOSURE_RUNAWAY_MS);
  expect(native.lock).toHaveBeenLastCalledWith('PRAGMA busy_timeout=0; SELECT count(*) FROM sqlite_master');
  expect(native.close).toHaveBeenCalledOnce();
  expect(kill.mock.calls).toEqual(interrupt ? [[42,'SIGTERM']] : []);
  expect(pending).not.toHaveBeenCalled();expect(recordProcess).not.toHaveBeenCalled();
});

it('accepts a controller lock released at the deadline without signalling its group', async () => {
  vi.mocked(readFile).mockImplementation(async () => { throw Object.assign(Error('Exited'), {code:'ENOENT'}); });
  native.lock.mockImplementationOnce(() => { throw Object.assign(Error('busy'), {errcode:5}); }).mockImplementation(() => {});
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'recorded'};
  const unit = {run:'Run',runtime:{path:'runtime',sha256:'a'.repeat(64)},authority:'unit'};
  const kill = vi.spyOn(process, 'kill');
  const recordProcess = vi.fn().mockResolvedValue({ok:true,value:1});
  expect(await stopRun(unit,{recordProcess} as any,{storeRoot:'/authored',
    observation:async()=>({ok:true,value:{unit,state:'active',owner,evidence:[],detail:'exited'}}),
    pending:async()=>({ok:true,value:[]})} as any,false)).toMatchObject({ok:true,value:{state:'inactive'}});
  expect(native.lock).toHaveBeenCalledTimes(2);
  expect(kill).not.toHaveBeenCalled();
});

// Identity/permission permutations belong to the host decision, not a real worker.
it.each([
  ['unbound authority', { authority: '' }, false, 'invalid'],
  ['stale birth', { start: 'old-birth' }, false, 'unknown'],
  ['reused PGID', { group: 43 }, false, 'unknown'],
  ['EPERM', {}, true, 'unknown'],
] as const)('refuses %s without signalling a foreign group', async (_name, change, denied, kind) => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded', ...change };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  vi.mocked(readFile).mockImplementation(async path => String(path).endsWith('/stat') ? '42 (fixture) ' + fields.join(' ') : 'boot');
  vi.mocked(readdir).mockResolvedValue([]);
  const kill = vi.fn((_pid: number, _signal: number | string) => { if (denied) throw Object.assign(Error('Unavailable observation'), { code: 'EPERM' }); return true; });
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  if (denied) expect(await probeOwner(owner)).toBe('unknown');
  expect(await closeOperation(owner)).toMatchObject({ ok: false, kind });
  expect(kill.mock.calls.some(call => call[1] === 'SIGKILL')).toBe(false);
});


// Processes never survive a reboot: whatever the facility, an owner recorded on another boot is dead, and
// nothing is probed or signalled (its pid, group and scope path may now belong to unrelated work).
it.each([
  ['group', undefined],
  ['marker', { kind: 'marker' as const, marker: 'mark' }],
  ['cgroup', { kind: 'cgroup' as const, inode: '123', path: '/user.slice/flowcrew-dddddddd.scope' }],
] as const)('an owner from an earlier boot closes as dead under the %s facility', async (_kind, containment) => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'old-boot', authority: 'opaque', ...(containment ? { containment } : {}) };
  vi.mocked(readFile).mockImplementation(async () => 'boot');
  const kill = vi.fn(() => true);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  expect(await closeOperation(owner)).toMatchObject({ ok: true, value: 'dead' });
  expect(kill).not.toHaveBeenCalled();
  expect(vi.mocked(open)).not.toHaveBeenCalled();
  expect(vi.mocked(readdir)).not.toHaveBeenCalled();
});

it('one recursive cgroup kill waits for recursive emptiness, without signalling unrelated processes', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot',
    authority: 'opaque', containment: {kind:'cgroup' as const, inode:'123', path:'/user.slice/flowcrew-aaaaaaaa.scope'} };
  vi.mocked(readFile).mockResolvedValue('boot');
  const populations = ['populated 1\n', 'populated 0\n'], buffers: Buffer[] = [];
  const write = vi.fn().mockResolvedValue({bytesWritten:1}), close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(open).mockImplementation(async path => !String(path).startsWith('/proc/self/fd/')
    ? {fd:80,stat:async()=>({ino:123n}),close} as any
    : String(path).endsWith('cgroup.kill') ? {write,close} as any : {
    close, read: async (buffer: Buffer) => { buffers.push(buffer); const text = populations.shift()!;buffer.write(text);return {bytesRead:text.length}; }
  } as any);
  const kill = vi.fn();
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const closing = closeOperation(owner);
  await vi.runAllTimersAsync();
  expect(await closing).toEqual({ok:true,value:'dead',scope:'contained_descendants',guarantee:'cgroup',
    detail:'cgroup: proven recursive descendant closure.'});
  expect(write.mock.calls).toEqual([['1']]);
  expect(kill).not.toHaveBeenCalled();
  expect(populations).toEqual([]);
  expect(buffers[0]).toBe(buffers[1]);
});

it('a surviving contained member prevents a closed receipt at the existing drain backstop', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot',
    authority: 'opaque', containment: {kind:'cgroup' as const, inode:'123', path:'/user.slice/flowcrew-bbbbbbbb.scope'} };
  vi.mocked(readFile).mockResolvedValue('boot');vi.mocked(readdir).mockResolvedValue([]);
  const write = vi.fn().mockResolvedValue({bytesWritten:1}), close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(open).mockImplementation(async path => !String(path).startsWith('/proc/self/fd/')
    ? {fd:80,stat:async()=>({ino:123n}),close} as any
    : String(path).endsWith('cgroup.kill') ? {write,close} as any : {
    close, read: async (buffer: Buffer) => { const text = 'populated 1\n';buffer.write(text);return {bytesRead:text.length}; }
  } as any);
  const kill = vi.fn();
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const closing = closeOperation(owner);
  await vi.advanceTimersByTimeAsync(GROUP_DRAIN_MS+10);
  expect(await closing).toMatchObject({ok:false,kind:'unknown',closure:{state:'not_confirmed_closed',observation:'live'}});
  expect(write.mock.calls).toEqual([['1']]);expect(kill).not.toHaveBeenCalled();
});

it('marker fallback retires an empty group and reports unreadable environments without signalling them', async () => {
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'opaque',containment:{kind:'marker' as const,marker:'11111111-1111-4111-8111-111111111111'}};
  vi.mocked(readdir).mockResolvedValue(['42', '43', '44'] as any);
  vi.mocked(stat).mockImplementation(async path => ({uid:String(path).endsWith('44') ? process.getuid!()+1 : process.getuid!()}) as any);
  vi.mocked(readFile).mockImplementation(async path => { if(String(path).endsWith('/43/environ')) throw Object.assign(Error('denied'),{code:'EACCES'}); return Buffer.from('OTHER=value\0'); });
  const kill = vi.fn(() => {throw Object.assign(Error('Empty group'),{code:'ESRCH'});});
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  expect(await closeOperation(owner)).toMatchObject({ok:true,value:'dead',unknownPids:[43],detail:expect.stringContaining('not signalled')});
  expect(kill.mock.calls).toEqual([[-42,0]]);
  expect(vi.mocked(readFile).mock.calls.some(([path])=>String(path).includes('/44/environ'))).toBe(false);
  vi.mocked(readdir).mockRejectedValueOnce(Error('scan facility unavailable'));
  expect(await closeOperation(owner)).toMatchObject({ok:true,value:'dead',detail:expect.stringContaining('scan unavailable')});
});


it('a recreated cgroup scope is never signalled under an old recorded inode', async () => {
  const owner = {pid:42,group:42,start:'birth',boot:'boot',authority:'opaque', containment: {kind:'cgroup' as const, inode:'123', path:'/user.slice/flowcrew-cccccccc.scope'}};
  vi.mocked(readFile).mockResolvedValue('boot');vi.mocked(readdir).mockResolvedValue([]);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(open).mockResolvedValue({fd:80,stat:async()=>({ino:456n}),close} as any);
  const kill = vi.fn();
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  expect(await closeOperation(owner)).toMatchObject({ok:false,kind:'unknown',closure:{state:'not_confirmed_closed'}});
  expect(vi.mocked(open).mock.calls).toEqual([['/sys/fs/cgroup/user.slice/flowcrew-cccccccc.scope','r']]);
  expect(kill).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});

// Same framing/ownership decision for all hosts; authored Darwin syscall output never exposes environments.
it('Darwin marker scan returns only matching and unreadable PID lists from KERN_PROCARGS2', async () => {
  native.execute.mockResolvedValue({stdout:JSON.stringify({pids:[71],unknownPids:[72]}),stderr:''});
  vi.stubGlobal('process',Object.create(process,{platform:{value:'darwin'}}));
  expect(await scanMarker('marker')).toEqual({pids:[71],unknownPids:[72]});
  const args = native.execute.mock.calls.at(-1)![1];
  expect(args).toContain('FLOWCREW_INVOCATION=marker');
  expect(args[4]).toContain('(1,49,pid)');
  expect(args[4]).not.toContain('\u0000');
});

it('marker closure repeats scans until no matches and never masks group-drain failure', async () => {
  const owner={pid:42,group:42,start:'birth',boot:'boot',authority:'opaque',containment:{kind:'marker' as const,marker:'mark'}};
  vi.mocked(stat).mockResolvedValue({uid:process.getuid!()} as any);
  vi.mocked(readdir).mockResolvedValueOnce(['77'] as any).mockResolvedValueOnce(['78'] as any).mockResolvedValue([]);
  vi.mocked(readFile).mockResolvedValue(Buffer.from('FLOWCREW_INVOCATION=mark\0'));
  const kill=vi.fn((pid:number,signal:any)=>{if(signal===0)throw Object.assign(Error('empty'),{code:'ESRCH'});return true;});
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const closing=closeOperation(owner); await vi.runAllTimersAsync();
  expect(await closing).toMatchObject({ok:true,value:'dead'});
  expect(kill.mock.calls).toEqual([[-42,0],[77,'SIGKILL'],[78,'SIGKILL']]);
  kill.mockImplementation(()=>{throw Object.assign(Error('denied'),{code:'EPERM'});});
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const denied=closeOperation(owner); await vi.advanceTimersByTimeAsync(GROUP_DRAIN_MS+10);
  expect(await denied).toMatchObject({ok:false,kind:'unknown',closure:{state:'not_confirmed_closed'}});
});

// The first group observation can predate the marker pass: nothing authenticates a group whose leader died before any member
// birth was recorded, and a member the marker pass kills is still exiting for a while (macOS drains in seconds).
it('marker closure observes the group again after the marker pass instead of reporting its earlier refusal', async () => {
  const owner={pid:42,group:42,start:'birth',boot:'boot',authority:'opaque',containment:{kind:'marker' as const,marker:'mark'}};
  vi.mocked(stat).mockResolvedValue({uid:process.getuid!()} as any);
  let killed=false, exiting=0;
  vi.mocked(readdir).mockImplementation(async path => (String(path)==='/proc'&&!killed ? ['77'] : []) as any);
  vi.mocked(readFile).mockImplementation(async path => { const text=String(path);
    if(text.endsWith('/proc/42/stat')) throw Object.assign(Error('leader gone'),{code:'ENOENT'});
    return text==='/proc/77/environ' ? Buffer.from('FLOWCREW_INVOCATION=mark\0') : 'boot'; });
  const kill=vi.fn((pid:number,signal:any)=>{
    if(pid===77&&signal==='SIGKILL'){killed=true;return true;}
    if(signal===0){ if(killed&&exiting++>=3)throw Object.assign(Error('empty'),{code:'ESRCH'}); return true; }
    return true;});
  vi.stubGlobal('process',Object.create(process,{platform:{value:'linux'},kill:{value:kill}}));
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  const closing=closeOperation(owner); await vi.advanceTimersByTimeAsync(GROUP_DRAIN_MS+10);
  expect(await closing).toMatchObject({ok:true,value:'dead',guarantee:'marker'});
  expect(kill.mock.calls.filter(call=>call[1]==='SIGKILL')).toEqual([[77,'SIGKILL']]);
});
