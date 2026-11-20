import {identity, currentBoot, nativeTool, observeController} from './identity.mjs';
export {identity, ownIdentity, nativeTool, observeStatus} from './identity.mjs';
export { ActivityWindow, sampleActivity, INACTIVITY_MESSAGE, authorActivity, quietObservation,
  type ExecutionActivity, type GuideDelivery, type GuideStatus } from './activity.js';
import { mkdirSync, realpathSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { readFile, open, rm, access, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { promisify, isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id, Ref, Result } from '../contract/brief.js';
import type { Owner, OwnerState, RunRef, RunObservation, OwnedProgram, ProcessReceipt, InvocationContext, GitContext, JournalPayload, Writer }
  from '../contract/runtime.js';
const execute = promisify(execFile);
const bad = (kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> => ({ ok: false, kind, detail });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const key = (owner: Owner) => JSON.stringify([owner.pid, owner.start, owner.boot, owner.authority, owner.containment]);
const self = fileURLToPath(import.meta.url);
export interface Claim { readonly database: string; readonly holder: string; readonly resource: string; readonly owner: Owner;
  readonly epoch: Id; readonly unit: RunRef | null; }
export interface ProcessPorts {
  contain?(owner: Owner): Promise<Owner>;
  putEvidence(bytes: Uint8Array): Promise<Result<Ref>>;
  operation<T>(request: OperationRequest): Promise<Result<T>>;
  storeEvidence(source: () => AsyncIterable<Uint8Array>): Promise<Result<Ref>>;
  recordController?(owner: Owner): Promise<Result<unknown>>;
  readonly streamRoot: string;
  readonly scratch: string;
  readEvidence(ref: Ref): Promise<Result<Uint8Array>>;
  recordProcess(payload: Extract<JournalPayload, { type: 'ownership' | 'owner_closed' | 'process' | 'run_observed' }>): Promise<Result<number>>;
}
export type ProcessPortsFactory = (writer: Writer) => ProcessPorts;
export interface RunContext {
  readonly database: string;
  readonly storeRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  pending(run: RunRef): Promise<Result<readonly Owner[]>>;
  observation(run: RunRef): Promise<Result<RunObservation | null>>;
}
export interface OperationRequest { readonly module: string; readonly method: string; readonly args: readonly unknown[]; }
export async function performOperation<T>(request: OperationRequest): Promise<Result<T>> { try { const module = await import(request.module);
  return await module[request.method](...request.args); } catch (error) { return bad('unknown', String(error)); } }
export interface OperationPorts {
  ready(owner: Owner): Promise<Result<unknown>>;
  updated(previous: Owner, owner: Owner): Promise<Result<unknown>>;
  closed(owner: Owner): Promise<Result<unknown>>;
}
// Group control stays here; read-only birth/boot observation is shared with status readers.
// ESRCH is the only empty-group observation; EPERM is unknown.
export function groupState(owner: Owner): OwnerState {
  if (!Number.isSafeInteger(owner.group) || owner.group <= 1) return 'unknown';
  try { process.kill(-owner.group, 0); return 'live'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
async function matching(owner: Owner): Promise<boolean | undefined> {
  try { const current = await identity(owner.pid); return current.start === owner.start && current.boot === owner.boot &&
    current.group === owner.group; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return undefined; }
}
/** Authentication uses a recorded birth, including surviving member births when the leader died. */
async function authenticated(owner: Owner): Promise<boolean> {
  if (await matching(owner)) return true;
  for (const member of owner.members ?? []) if (await matching({ ...member, group: owner.group, authority: owner.authority })) return true;
  return false;
}
export async function probeOwner(owner: Owner): Promise<OwnerState> {
  const group = groupState(owner);
  if (group !== 'live') return group;
  return await authenticated(owner) ? 'live' : 'unknown';
}
// Native evidence: the largest completed kill-to-empty upper bound is 2862ms
// (macOS CI 44071379468 P4-SIGKILL, whole invocation). Three times that
// conservative bound; exact local drain samples are recorded in step-6m/REPORT.md.
export const DRAIN_BACKSTOP_MS = 3 * 2862;
export interface GroupMember { readonly pid: number; readonly state: string; readonly parent: number | null; }
export interface UnconfirmedClosure {
  readonly ok: false; readonly kind: 'unknown'; readonly detail: string;
  readonly closure: { readonly state: 'not_confirmed_closed'; readonly owner: Owner;
    readonly observation: OwnerState; readonly members: readonly GroupMember[] };
}
export const isUnconfirmedClosure = (result: unknown): result is UnconfirmedClosure =>
  !!result && typeof result === 'object' && 'closure' in result;
/** Diagnostic snapshot only; membership never authorizes signalling or proves ESRCH. */
async function observedMembers(owner: Owner): Promise<readonly GroupMember[]> {
  try {
    if (process.platform === 'linux') {
      const members: GroupMember[] = [];
      for (const pid of await (await import('node:fs/promises')).readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try { const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
          if (Number(fields[2]) === owner.group) members.push({ pid: Number(pid), state: fields[0], parent: Number(fields[1]) });
        } catch { /* A process may exit during the snapshot. */ }
      }
      return members;
    }
    const { stdout } = await execute(await nativeTool('ps'), ['-axo', 'pid=,pgid=,stat=,ppid='],
      { env: { PATH: '/usr/bin:/bin' }, timeout: DRAIN_BACKSTOP_MS });
    return stdout.trim().split('\n').flatMap(line => {
      const [pid, group, state, parent] = line.trim().split(/\s+/);
      return Number(group) === owner.group ? [{ pid: Number(pid), state, parent: Number(parent) }] : [];
    });
  } catch { return [{ pid: owner.pid, state: 'unavailable', parent: null }]; }
}
async function notClosed(owner: Owner, observation: OwnerState, reason: string): Promise<UnconfirmedClosure> {
  const members = await observedMembers(owner);
  const fact = members.some(member => member.state === 'Z' && member.parent === 1)
    ? 'The recorded group still holds an unreaped process, which happens when PID 1 does not reap orphans. ' : '';
  const remedy = 'Check process ownership, permissions and the parent reaper; then repeat cancel for a cancelled run, or resume an uncancelled parked run, to retry closure.';
  return { ok: false, kind: 'unknown', closure: { state: 'not_confirmed_closed', owner, observation, members },
    detail: `Not confirmed closed: group ${owner.group}; ${reason}; members ${JSON.stringify(members)}. ${fact}${remedy}` };
}
// Authority remains opaque. The recorded facility is the only closure dispatch input.
async function contain(owner: Owner): Promise<Owner> {
  if (process.platform === 'linux') try {
    const unit = `flowcrew-${owner.authority}.scope`;
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}` };
    await execute(await nativeTool('busctl'), ['--user', 'call', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit',
      'ssa(sv)a(sa(sv))', unit, 'fail', '2', 'PIDs', 'au', '1', String(owner.pid), 'Delegate', 'b', 'true', '0'], { env });
    // StartTransientUnit returns a queued job; start waits for that same job before inspecting membership.
    await execute(await nativeTool('systemctl'), ['--user', 'start', unit], { env });
    const membership = (await readFile(`/proc/${owner.pid}/cgroup`, 'utf8')).trim();
    const path = membership.startsWith('0::/') ? membership.slice(3) : '';
    if (!path.endsWith('/' + unit)) throw Error('Scope start did not establish membership');
    // Require both the recursive kill and recursive emptiness interfaces before claiming containment.
    await access(join('/sys/fs/cgroup', path, 'cgroup.kill'), 2);
    await access(join('/sys/fs/cgroup', path, 'cgroup.events'), 4);
    const directory = await open(join('/sys/fs/cgroup', path), 'r');
    try { return { ...owner, containment: { kind: 'cgroup', inode: String((await directory.stat({ bigint: true })).ino), path } }; }
    finally { await directory.close(); }
  } catch { /* The portable marker facility provides best-effort closure. */ }
  return { ...owner, containment: { kind: 'marker', marker: randomUUID() } };
}
async function drainScope(owner: Owner, scope: Extract<NonNullable<Owner['containment']>, { kind: 'cgroup' }>): Promise<ClosureResult> {
  if (process.platform !== 'linux') return notClosed(owner, 'unknown', 'Recorded containment is unavailable on this host');
  const { inode, path } = scope;
  if (!isAbsolute(path) || resolve(path) !== path || !/^flowcrew-[a-f0-9-]+\.scope$/.test(path.slice(path.lastIndexOf('/') + 1)))
    return notClosed(owner, 'unknown', 'Invalid recorded containment identity');
  const root = join('/sys/fs/cgroup', path), started = performance.now();
  try {
    // Keep open descriptors across systemd removing an emptied scope. No process-tree discovery is involved.
    const directory = await open(root, 'r');
    try {
      if (String((await directory.stat({ bigint: true })).ino) !== inode)
        return notClosed(owner, 'unknown', 'Recorded containment identity changed; refusing signal');
      const anchored = `/proc/self/fd/${directory.fd}`;
      const events = await open(join(anchored, 'cgroup.events'), 'r');
      try {
        const kill = await open(join(anchored, 'cgroup.kill'), 'w');
        try { await kill.write('1'); } finally { await kill.close(); }
        const buffer = Buffer.alloc(256);
        for (;;) {
          const { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
          if (buffer.subarray(0, bytesRead).toString().split('\n').includes('populated 0')) return ok('dead');
          if (performance.now() - started >= DRAIN_BACKSTOP_MS)
            return notClosed(owner, 'live', 'Containment kill drain backstop reached');
          await pause(10);
        }
      } finally { await events.close(); }
    } finally { await directory.close(); }
  } catch (error) {
    // The kernel only permits removal of an empty cgroup; the UUID scope is never reused.
    if (['ENOENT', 'ENODEV'].includes((error as NodeJS.ErrnoException).code ?? '')) return ok('dead');
    return notClosed(owner, 'unknown', 'Containment closure observation unavailable');
  }
}
export type ClosureResult = (Result<'dead'> & Partial<Pick<ProcessReceipt, 'scope' | 'guarantee' | 'unknownPids' | 'detail'>>) | UnconfirmedClosure;
export interface MarkerScan { readonly pids: readonly number[]; readonly unknownPids: readonly number[]; }
/** Only current-uid processes are inspected. Environment bytes never leave this function. */
export async function scanMarker(marker: string): Promise<MarkerScan> {
  const pids: number[] = [], unknownPids: number[] = [], token = `FLOWCREW_INVOCATION=${marker}`;
  if (process.platform === 'linux') {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry), root = `/proc/${pid}`;
      try {
        if ((await stat(root)).uid !== process.getuid!()) continue;
        try { if ((await readFile(`${root}/environ`)).toString().split('\0').includes(token)) pids.push(pid); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) unknownPids.push(pid); }
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    return { pids, unknownPids };
  }
  // KERN_PROCARGS2 separates argv from environ. ps -E merges them and may silently omit protected environments.
  const { stdout } = await execute(await nativeTool('python3'), ['-I', '-S', '-B', '-c', `
import ctypes,errno,json,os,struct,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
rows=subprocess.check_output(['/bin/ps','-axo','pid=,uid=']).decode().splitlines()
pids=[];unknown=[];token=os.fsencode(sys.argv[1]);uid=os.getuid()
for row in rows:
 pid,owner=map(int,row.split())
 if owner!=uid:continue
 mib=(ctypes.c_int*3)(1,49,pid);size=ctypes.c_size_t(0)
 if libc.sysctl(mib,3,None,ctypes.byref(size),None,0):
  if ctypes.get_errno() not in (errno.ESRCH,errno.ENOENT):unknown.append(pid)
  continue
 buf=ctypes.create_string_buffer(size.value)
 if libc.sysctl(mib,3,buf,ctypes.byref(size),None,0):
  if ctypes.get_errno() not in (errno.ESRCH,errno.ENOENT):unknown.append(pid)
  continue
 data=buf.raw[:size.value]
 if len(data)<4:unknown.append(pid);continue
 argc=struct.unpack_from('i',data)[0];pos=data.find(b'\\0',4)
 if pos<0:unknown.append(pid);continue
 while pos<len(data) and data[pos]==0:pos+=1
 for _ in range(argc):
  end=data.find(b'\\0',pos)
  if end<0:pos=len(data);break
  pos=end+1
 env=[v for v in data[pos:].split(b'\\0') if v]
 if not env:unknown.append(pid)
 elif token in env:pids.append(pid)
print(json.dumps({'pids':pids,'unknownPids':unknown}))
`, token], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout) as MarkerScan;
}
const closing = new Map<string, Promise<ClosureResult>>();
/** Exactly one dispatch owns normal completion, cancellation and recovery. Old owners remain group-only. */
export async function closeOperation(owner: Owner): Promise<ClosureResult> {
  const id = key(owner), prior = closing.get(id); if (prior) return prior;
  const pending = (async (): Promise<ClosureResult> => {
    // Processes never survive a reboot: an owner recorded on another boot is dead whatever its facility, and
    // its recorded group or pid may now belong to unrelated work, so nothing is probed or signalled.
    if (await currentBoot().then(boot => boot !== owner.boot, () => false))
      return { ...ok('dead'), detail: 'Recorded boot is not the current boot; no process survives a reboot.' };
    switch (owner.containment?.kind) {
      case 'cgroup':
        try {
          const result = await drainScope(owner, owner.containment);
          return result.ok ? { ...result, scope: 'contained_descendants', guarantee: 'cgroup',
            detail: 'cgroup: proven recursive descendant closure.' } : result;
        }
        catch { return notClosed(owner, 'unknown', 'Containment observation unavailable'); }
      case 'marker': {
        const marker = owner.containment.marker;
        const first = await drainOperation(owner), unknown = new Set<number>(), started = performance.now();
        // The group observation above predates the marker pass. When it could not authenticate the group (the leader died and
        // no member birth was persisted yet, or a killed member is still exiting), the marker pass is what retires the
        // survivors, so the group is observed again after it, within the one drain backstop, and that observation decides.
        const group = async () => first.ok || !isUnconfirmedClosure(first) ? first : emptied(owner);
        for (;;) {
          let scan: MarkerScan;
          try { scan = await scanMarker(marker); }
          catch { const final = await group(); return final.ok ? { ...final, guarantee: 'marker', unknownPids: [...unknown],
            detail: 'marker: best effort; current-user environment scan unavailable, descendant fate unknown; no unverified process signalled. Owner retired.' } : final; }
          scan.unknownPids.forEach(pid => unknown.add(pid));
          if (!scan.pids.length) { const final = await group(); return final.ok ? { ...final, guarantee: 'marker', unknownPids: [...unknown],
            detail: `marker: best effort; no readable current-user process retains the invocation marker. ` +
              `Environment-cleared processes are not covered. Unreadable environments (unknown, not signalled): ${[...unknown].join(', ') || 'none'}. Owner retired.` } : final; }
          for (const pid of scan.pids) try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notClosed(owner, 'unknown', 'Marked process signal unavailable'); }
          if (performance.now() - started >= DRAIN_BACKSTOP_MS) return notClosed(owner, 'live', 'Marker kill drain backstop reached');
          await pause(10);
        }
      }
      default: return drainOperation(owner);
    }
  })(); closing.set(id, pending);
  try { return await pending; } finally { closing.delete(id); }
}
const closureFields = (closed: Extract<ClosureResult, { ok: true }>): Pick<ProcessReceipt, 'scope' | 'guarantee' | 'unknownPids' | 'detail'> => ({
  scope: closed.scope ?? 'group', guarantee: closed.guarantee, unknownPids: closed.unknownPids, detail: closed.detail,
});
async function drainOperation(owner: Owner): Promise<Result<'dead'> | UnconfirmedClosure> {
  if (!owner.authority) return bad('invalid', 'Unbound process identity is not a recorded operation authority');
  const state = groupState(owner);
  if (state !== 'live') return state === 'dead' ? ok(state) : notClosed(owner, state, 'Group observation unavailable');
  if (!await authenticated(owner)) return groupState(owner) === 'dead' ? ok('dead') : notClosed(owner, 'unknown',
    'No surviving recorded group identity; refusing signal');
  try { process.kill(-owner.group, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notClosed(owner, 'unknown', 'Group signal outcome unavailable'); }
  return emptied(owner);
}
/** Waits, without signalling, until the recorded group is observed empty (ESRCH) or the one backstop passes. */
async function emptied(owner: Owner): Promise<Result<'dead'> | UnconfirmedClosure> {
  const started = performance.now();
  for (;;) {
    const state = groupState(owner);
    if (state === 'dead') return ok(state);
    if (performance.now() - started >= DRAIN_BACKSTOP_MS) return notClosed(owner, state, 'SIGKILL drain backstop reached');
    await pause(10);
  }
}
const send = (child: ReturnType<typeof spawn>,
  packet: Parameters<NonNullable<ReturnType<typeof spawn>['send']>>[0]) => new Promise<boolean>(resolve => {
  if (!child.connected) return resolve(false); child.send!(packet, error => resolve(!error)); });
interface Worker { owner: Owner; child: ReturnType<typeof spawn>; done: Promise<{ exit: number | null; signal: string | null; error?: string }>; }
const held = new Map<string, Worker>();
/** Idle worker is also the claim's capability. No effects occur before the durable ready/go exchange. */
export async function beginOperation(fds?: readonly [number | 'pipe', number | 'pipe']): Promise<Result<Worker>> {
  try {
    const child = spawn(process.execPath, [self, '--operation'], { detached: true, stdio: ['pipe',
      fds?.[0] ?? 'ignore', fds?.[1] ?? 'ignore', 'ipc'], serialization: 'advanced' });
    const done = new Promise<{ exit: number | null; signal: string | null; error?: string }>(resolve => {
      child.once('error', error => resolve({ exit: null, signal: null, error: error.message })); child.once('close', (exit, signal) => resolve({ exit, signal }));
    });
    const announced = await Promise.race([
      new Promise<Owner | { failed: string }>(resolve => child.once('message', value => resolve(value as Owner | { failed: string }))),
      // Nothing is recorded or effected before ready. A worker that can still speak says why over this channel (below);
      // one that never ran its entry (cannot start, killed) leaves only its exit status.
      done.then(({ exit, signal, error }) => { throw new Error(`Operation exited before ready (exit ${exit}, signal ${signal}${error ? `, ${error}` : ''})`); }),
    ]);
    if ('failed' in announced) { child.kill('SIGKILL'); await done; throw new Error(`Operation failed before ready: ${announced.failed}`); }
    const owner = announced;
    if (owner.pid !== child.pid || owner.group !== child.pid || !await authenticated(owner)) { child.kill('SIGKILL'); await done;
      return bad('unknown', 'Operation identity not authenticated'); }
    const worker = { owner, child, done };
    held.set(key(worker.owner), worker); return ok(worker);
  } catch (error) { return bad('unavailable', String(error)); }
}
export async function endOperation(owner: Owner): Promise<ClosureResult> {
  const worker = held.get(key(owner));
  const closed = await closeOperation(owner);
  if (!closed.ok) return closed;
  if (worker) { await worker.done; held.delete(key(owner)); }
  return closed;
}
/** Every native child uses the same durable surviving-member witness protocol. */
async function recordMember(worker: Worker, member: Owner, save: (previous: Owner, next: Owner) => Promise<Result<unknown>>) {
  if (member.group !== worker.owner.group) {
    await send(worker.child, { ack: member.pid, ok: false, detail: 'Native member group differs from recorded operation group' }); return;
  }
  const next = { ...worker.owner, members: [...(worker.owner.members ?? []), { pid: member.pid, start: member.start, boot: member.boot }] };
  const saved = await save(worker.owner, next);
  if (saved.ok) worker.owner = next;
  await send(worker.child, { ack: member.pid, ...saved });
}
/** One short-lived group for trusted pinned engine code. Native children inherit it; claims precede work and outlive parent death. */
export async function runOperation<T>(request: OperationRequest, ports: OperationPorts, source?: () => AsyncIterable<Uint8Array>,
  output?: (bytes: AsyncIterable<Uint8Array>) => Promise<void>): Promise<Result<T>> {
  const opened = await beginOperation(output ? ['pipe', 'pipe'] : undefined); if (!opened.ok) return opened;
  const worker = opened.value;
  const drained = output ? output(worker.child.stdout!) : Promise.resolve();
  worker.child.stderr?.resume();
  let saved: Result<unknown>;
  try { saved = await ports.ready(worker.owner); } catch (error) { saved = bad('unknown', String(error)); }
  if (!saved.ok) { const closed = await endOperation(worker.owner); return closed.ok ? saved : closed; }
  const outcome = new Promise<Result<T>>(resolve => {
    let updates = Promise.resolve();
    worker.child.on('message', (packet: any) => { updates = updates.then(async () => {
      if (packet.member) {
        await recordMember(worker, packet.member, ports.updated);
      } else if (packet.result) resolve(packet.result);
    }).catch(error => resolve(bad('unknown', String(error)))); });
    worker.done.then(() => updates.then(() => resolve(bad('unknown', 'Operation interrupted; its group remains owned'))));
  });
  if (!await send(worker.child, { request })) return bad('unknown', 'Operation interrupted at recorded start barrier');
  if (source) {
    try { for await (const chunk of source()) if (!worker.child.stdin!.write(chunk)) await new Promise<void>(
      resolve => worker.child.stdin!.once('drain', resolve));
      worker.child.stdin!.end(); }
    catch (error) { const closed = await endOperation(worker.owner); return closed.ok ? bad('unknown', String(error)) : closed; }
  } else worker.child.stdin!.end();
  const result = await outcome;
  await drained;
  if (!result.ok && result.kind === 'unknown') return result;
  const closed = await endOperation(worker.owner); if (!closed.ok) return closed;
  const retired = await ports.closed(worker.owner); return retired.ok ? result : retired;
}
/** The worker entry is trusted code from the pinned runtime, never a declared workload command. */
let controllerOwner: Owner | undefined;
export let inOperation = process.argv[2] === '--operation';
if (inOperation) {
  // The parent owns the one pre-ready exit: a worker that cannot establish its identity reports why over its own channel.
  const owner: Owner = await identity().then(own => ({ ...own, authority: randomUUID() }), async error => {
    await new Promise<void>(resolve => process.send!({ failed: String(error) }, () => resolve())); return process.exit(1);
  });
  process.send!(owner);
  const disconnected = () => process.exit(1);
  process.once('disconnect', disconnected);
  process.once('message', async (message: { request?: OperationRequest; exec?: { argv: string[]; env: Record<string, string>; cwd: string };
    supervisor?: OwnedProgram }) => {
    try {
      if (message.exec) {
        process.removeListener('disconnect', disconnected);
        process.chdir(message.exec.cwd);
        // The operation executor anchors the recorded group until the recorder closes it.
        // Losing the recorder interrupts work; it never leaves a crash-proof exit waiter.
        process.once('disconnect', () => process.kill(-process.pid, 'SIGKILL'));
        const native = spawn(message.exec.argv[0], message.exec.argv.slice(1), { cwd: message.exec.cwd, env: message.exec.env, stdio: 'inherit' });
        // Keep the executor alive to report the native exit before the recorder closes the group.
        const interrupt = (packet: { cancel?: boolean }) => { if (packet.cancel) native.kill('SIGKILL'); };
        process.on('message', interrupt);
        const exited = new Promise<{ exit: number | null; signal: string | null }>((resolve, reject) => {
          native.once('error', reject); native.once('exit', (exit, signal) => resolve({ exit, signal }));
        });
        // As in nativeSpawn, consume registration failures while the child is alive.
        // The recorder receives unknown immediately and closes its still-owned group.
        const [ending] = await Promise.all([exited, registerNative(native, exited)]);
        process.removeListener('message', interrupt);
        process.send!({ nativeExit: ending });
      } else if (message.supervisor) {
        process.removeListener('disconnect', disconnected);
        const entry = message.supervisor; inOperation = false; controllerOwner = owner;
        process.chdir(entry.cwd);
        for (const name of Object.keys(process.env)) delete process.env[name];
        Object.assign(process.env, entry.env);
        process.argv = [entry.argv[0], entry.argv[1], ...entry.argv.slice(2)];
        process.send!({ started: true }, () => process.disconnect!());
        await import(entry.argv[1]);
        process.exit(process.exitCode ?? 0);
      } else if (message.request) {
        const value = await performOperation(message.request);
        if (process.stdout.writable) process.stdout.end(() => process.send!({ result: value })); else process.send!({ result: value });
      }
    } catch (error) { if (process.connected) process.send!({ result: bad('unknown', String(error)) }); else process.exit(1); }
  });
}
/** After the provider's terminal event it gets this long to exit by itself before the owner is closed.
 * Result-to-exit gap after stdin EOF, measured: Claude Code 0.58-0.79 s over 10 direct runs, and at most 1.63 s (median 0.91 s,
 * including closure and evidence storage) over 15 retained invocations; Codex exec 0.71-0.99 s over 6 runs. Nothing the engine
 * consumes is written after the terminal event, so a slower exit only loses its exit status, never the answer. */
export const TERMINAL_GRACE_MS = 2000;
export interface InvocationIO {
  readonly input?: (bytes: Uint8Array) => Uint8Array;
  readonly onStdout?: (bytes: Uint8Array) => void;
  /** `end()` reports the provider's terminal event: it ends stdin and starts the grace period. The invocation ends at the
   * native exit or when the grace period elapses, whichever comes first; the owner (every descendant) is closed either way. */
  readonly onReady?: (session: { write(bytes: Uint8Array): Promise<boolean>; end(): void }) => void;
}
/** Launch exact argv/env under ordinary account rights; the recorder owns descendant closure and evidence. */
export async function launchInvocation(context: InvocationContext, program: OwnedProgram, ports: ProcessPorts,
  abort: AbortSignal, io?: InvocationIO): Promise<Result<ProcessReceipt>> {
  const started = performance.now();
  const prepared = context.git ? await ports.operation<{ environment: Record<string, string> }>({
    module: new URL('./process.js', import.meta.url).href, method: 'prepareGitTask', args: [context.git]
  }) : ok({ environment: {} });
  if (!prepared.ok) return prepared;
  if (controllerOwner && ports.recordController) { controllerOwner = { ...controllerOwner, members: await groupMembers(controllerOwner) };
    const recorded = await ports.recordController(controllerOwner); if (!recorded.ok) return recorded; }
  const token = randomUUID(), paths = ['stdout', 'stderr'].map(name => join(ports.streamRoot, token + '-' + name));
  const files = await Promise.all(paths.map(path => open(path, 'wx+', 0o600)));
  const opened = await beginOperation([files[0].fd, files[1].fd]);
  if (!opened.ok) { for (const file of files) await file.close(); return opened; }
  const worker = opened.value;
  held.delete(key(worker.owner)); worker.owner = await (ports.contain ?? contain)(worker.owner); held.set(key(worker.owner), worker);
  const environment: Record<string, string> = { TMPDIR: ports.scratch, ...prepared.value.environment, ...program.env };
  // Only marker owners carry a marker, and the recorded owner supplies its only assignment.
  delete environment.FLOWCREW_INVOCATION;
  if (worker.owner.containment?.kind === 'marker') environment.FLOWCREW_INVOCATION = worker.owner.containment.marker;
  // Native writes still go directly to durable raw files, including after recorder failure.
  // One new-byte reader owns live decoding and the final drained tail, independent of filesystem notifications.
  let offset = 0, observing = true;
  const buffer = Buffer.alloc(64 * 1024);
  const observe = async () => {
    if (!io?.onStdout) return;
    for (;;) {
      const { bytesRead } = await files[0].read(buffer, 0, buffer.length, offset);
      if (!bytesRead) return;
      offset += bytesRead; io.onStdout(buffer.subarray(0, bytesRead));
    }
  };
  const observations = io?.onStdout ? (async () => {
    while (observing) {
      try { await observe(); } catch (error) { console.warn('Live stdout observation failed; will retry:', error); }
      // Bound steering observation latency to 100 ms; status display refreshes every 5 s.
      await pause(100);
    }
  })() : Promise.resolve();
  worker.owner = { ...worker.owner,
    streams: { stdout: paths[0], stderr: paths[1] } };
  let released = false, closureAttempted = false, timer: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined;
  const cancel = () => { if (released) { worker.child.stdin!.destroy(); void send(worker.child, { cancel: true }); } };
  abort.addEventListener('abort', cancel, { once: true });
  const invoke = async (): Promise<Result<ProcessReceipt>> => { try {
    const recorded = await ports.recordProcess({ type: 'ownership', owner: worker.owner, state: 'live' });
    if (!recorded.ok) return recorded;
    const input = program.stdin ? await ports.readEvidence(program.stdin) : ok(new Uint8Array());
    if (!input.ok) return input;
    if (program.stdin && createHash('sha256').update(input.value).digest('hex') !== program.stdin.sha256) return bad('invalid',
      'Stdin reference mismatch');
    worker.child.stdin!.on('error', () => { });
    let nativeExit = false, updates = Promise.resolve(), retire = () => { };
    const elapsed = new Promise<null>(resolve => { retire = () => resolve(null); });
    const outcome = new Promise<{ exit: number | null; signal: string | null }>(resolve => {
      worker.child.on('message', (value: any) => {
        updates = updates.then(async () => {
          if (value.member) await recordMember(worker, value.member, async (_previous, owner) =>
            ports.recordProcess({ type: 'ownership', owner, state: 'live' }));
          else { nativeExit = !!value.nativeExit; worker.child.stdin!.end(); resolve(value.nativeExit ?? { exit: null, signal: null }); }
        }).catch(() => resolve({ exit: null, signal: null }));
      });
      worker.done.then(() => updates.then(() => resolve({ exit: null, signal: null })));
    });
    if (!abort.aborted && (program.durationMs === undefined || performance.now() - started < program.durationMs)) {
      if (!await send(worker.child, { exec: { argv: program.argv, env: environment, cwd: program.cwd } }
        )) return bad('unknown', 'Invocation interrupted at recorded start barrier');
      released = true; if (abort.aborted) cancel();
      const tick = () => { if (program.durationMs === undefined) return; const remaining = program.durationMs - (performance.now() - started);
        if (remaining <= 0) cancel(); else timer = setTimeout(tick, Math.min(remaining, 2147483647)); }; tick();
      const write = (bytes: Uint8Array) => new Promise<boolean>(resolve => {
        if (worker.child.stdin!.destroyed || worker.child.stdin!.writableEnded) return resolve(false);
        worker.child.stdin!.write(bytes, error => resolve(!error));
      });
      const written = await write(io?.input ? io.input(input.value) : input.value);
      if (written && !abort.aborted && io?.onReady) io.onReady({ write, end: () => {
        worker.child.stdin!.end(); grace ??= setTimeout(retire, TERMINAL_GRACE_MS); } });
      else worker.child.stdin!.end();
    } else worker.child.kill('SIGKILL');
    // The invocation ends at the first of the native exit and the provider's terminal event plus its grace period;
    // either way the owner is closed next, so a blocked descendant cannot keep a finished provider alive.
    const exited = await Promise.race([outcome, elapsed]), ending = exited ?? { exit: null, signal: null };
    closureAttempted = true;
    const closed = await endOperation(worker.owner);
    observing = false; await observations; await observe();
    if (!closed.ok) return closed;
    const refs: Ref[] = [];
    for (const path of paths) {
      const ref = await ports.storeEvidence(async function* () { const file = await open(path, 'r'); try {
        for await (const bytes of file.createReadStream()) yield bytes; } finally { await file.close(); } });
      if (!ref.ok) return ref; refs.push(ref.value);
    }
    const receipt: ProcessReceipt = {
owner: worker.owner, state: !released ? 'not_started' : nativeExit || exited === null ? 'closed' : 'closure_unknown',
  exit: released ? ending.exit : null, signal: ending.signal,
      stdout: refs[0], stderr: refs[1], durationMs: Math.ceil(performance.now() - started),
        ...closureFields(closed), ...(exited === null ? { closedAtTerminal: true as const } : {})
};
    const saved = await ports.recordProcess({ type: 'process', receipt }); if (!saved.ok) return saved;
    const retired = await ports.recordProcess({ type: 'owner_closed', owner: worker.owner }); if (!retired.ok) return retired;
    for (const path of paths) await rm(path);
    return ok(receipt);
  } finally {
    clearTimeout(timer); clearTimeout(grace); abort.removeEventListener('abort', cancel); observing = false;
    await observations; for (const file of files) await file.close();
  } };
  let result: Result<ProcessReceipt>;
  try { result = await invoke(); } catch (error) { result = bad('unknown', String(error)); }
  if (!closureAttempted) { const closed = await endOperation(worker.owner);
    if (!closed.ok) return closed; }
  return result;
}
export async function observeRun(run: RunRef, context: RunContext): Promise<Result<RunObservation>> {
  const observed = await context.observation(run); if (!observed.ok) return observed;
  if (!observed.value) return ok({ unit: run, state: 'inactive', owner: null, evidence: [], detail: 'No activation recorded' });
  if (!isDeepStrictEqual(observed.value.unit, run)) return bad('conflict', 'Pinned run identity differs');
  const owner = observed.value.owner;
  const state = owner ? await observeController(owner) : 'unknown';
  return ok({ ...observed.value, state });
}
export async function startRun(run: RunRef, entry: OwnedProgram, ports: ProcessPorts, context: RunContext): Promise<Result<RunObservation>> {
  const prior = await observeRun(run, context); if (!prior.ok) return prior;
  if (prior.value.state === 'active') return prior;
  if (prior.value.state === 'unknown') return bad('unknown', 'Previous activation is unresolved');
  const pending = await context.pending(run); if (!pending.ok) return pending;
  if (pending.value.length) return bad('unknown', 'Unresolved invocation outcome; close and retain interrupted streams before another activation');
  if (prior.value.owner) { const closed = await closeOperation(prior.value.owner); if (!closed.ok) return closed; }
  const path = join(context.storeRoot, run.runtime.path);
  try { if (createHash('sha256').update(await readFile(path)).digest('hex') !== run.runtime.sha256) return bad('conflict', 'Runtime pin differs'); }
  catch (error) { return bad('unavailable', String(error)); }
  const opened = await beginOperation(); if (!opened.ok) return opened;
  const worker = opened.value, value: RunObservation = { unit: run, state: 'active', owner: worker.owner, evidence: [],
    detail: 'Recorded detached activation; acknowledgement is not completion' };
  const saved = await ports.recordProcess({ type: 'run_observed', observation: value });
  if (!saved.ok) { const closed = await endOperation(worker.owner); return closed.ok ? saved : closed; }
  const started = new Promise<boolean>(resolve => { worker.child.once('message', () => resolve(true)); worker.done.then(() => resolve(false)); });
  worker.child.stdin!.end(); if (!await send(worker.child, { supervisor: entry })) return bad('unknown',
    'Activation interrupted at recorded start barrier');
  if (!await started) return bad('unknown', 'Activation interrupted before acknowledgement');
  worker.child.unref(); worker.child.channel?.unref(); held.delete(key(worker.owner));
  return ok(value);
}
export async function stopRun(run: RunRef, ports: ProcessPorts,
  context: RunContext): Promise<Result<RunObservation>> {
  const observed = await observeRun(run, context); if (!observed.ok) return observed;
  const controller = observed.value.owner;
  if (controller && observed.value.state === 'active') {
    try { process.kill(controller.pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notClosed(controller, 'unknown', 'Controller wake outcome unavailable');
    }
    // The recorder owns closure and durable receipts. Its healthy flush has no kill-drain deadline.
    if (await observeController(controller) === 'active') return ok({ ...observed.value, state: 'active',
      detail: `Controller ${controller.pid} is closing and retaining execution evidence` });
  }
  if (controller) { const closed = await closeOperation(controller); if (!closed.ok) return closed; }
  const pending = await context.pending(run); if (!pending.ok) return pending;
  for (const owner of pending.value) {
    const closed = await closeOperation(owner); if (!closed.ok) return closed;
    if (!owner.streams) return bad('unknown', 'Interrupted invocation has no recorded stream locations');
    const refs: Ref[] = [];
    for (const path of [owner.streams.stdout, owner.streams.stderr]) { const saved = await ports.storeEvidence(async function* () {
      const file = await open(path, 'r'); try { for await (const bytes of file.createReadStream()) yield bytes; } finally { await file.close(); } });
      if (!saved.ok) return saved; refs.push(saved.value); }
    const receipt: ProcessReceipt = { owner, state: 'closure_unknown', exit: null, signal: null, stdout: refs[0],
      stderr: refs[1], durationMs: 0, ...closureFields(closed) };
    const saved = await ports.recordProcess({ type: 'process', receipt }); if (!saved.ok) return saved;
    const retired = await ports.recordProcess({ type: 'owner_closed', owner }); if (!retired.ok) return retired;
    await rm(owner.streams.stdout); await rm(owner.streams.stderr);
  }
  const value = { ...observed.value, state: 'inactive' as const }; const saved = await ports.recordProcess({ type: 'run_observed',
    observation: value }); return saved.ok ? ok(value) : saved;
}
async function groupMembers(owner: Owner): Promise<NonNullable<Owner['members']>> {
  const members: NonNullable<Owner['members']>[number][] = [];
  for (const { pid } of await observedMembers(owner)) {
    if (pid === owner.pid) continue;
    try { const candidate = await identity(pid); if (candidate.group === owner.group) members.push({ pid, start: candidate.start,
      boot: candidate.boot }); } catch { }
  }
  return members;
}

export async function publishNoReplace(source: string, target: string): Promise<void> {
  await nativeExec([await nativeTool('python3'), '-I', '-S', '-B', '-c',
      ("\nimport ctypes, os, sys\nlibc=ctypes.CDLL(None,use_errno=True)\nsource,target=map(os.fsencod" +
      "e,sys.argv[1:3])\nif sys.platform=='darwin': result=libc.renamex_np(source,target,4)\nelse: " +
      "result=libc.renameat2(-100,source,-100,target,1)\nif result:\n error=ctypes.get_errno()\n rai" +
      "se OSError(error,os.strerror(error))\n"), source, target], { env: {} });
}


/** Native construction children remain in their executor's group and persist a surviving birth witness. */
export function nativeSpawn(argv: readonly string[], options: { env: Record<string, string>; cwd?: string }) {
  const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  // Return the streams immediately. Awaiting identity before attaching readers loses fast-child data/close ordering.
  const registered = registerNative(child, exited);
  return { child, done: Promise.all([exited, registered]).then(([code]) => code) };
}
async function registerNative(child: ReturnType<typeof spawn>, exited: Promise<unknown>) {
  if (!inOperation || !process.connected || !child.pid) return;
  let member: Owner;
  try { member = await identity(child.pid); } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
    await exited; return; } throw error; }
  // An observed exit owns the fast-child case even if the last native snapshot was captured while dying.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const saved = new Promise<Result<unknown>>(resolve => { const listen = (packet: any) => { if (packet.ack === child.pid) {
    process.removeListener('message', listen); resolve(packet); } }; process.on('message', listen); });
  if (!process.connected) throw Error('Recorder interrupted before native identity persistence');
  process.send!({ member });
  const receipt = await saved;
  if (!receipt.ok) { child.kill('SIGKILL'); await exited; throw Error('Native member identity persistence refused: ' + receipt.detail); }
}
export async function nativeExec(argv: readonly string[], options: { env: Record<string, string>; cwd?: string } = { env: {} }): Promise<{
  stdout: string; stderr: string }> {
  const { child, done } = await nativeSpawn(argv, options); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.stdin.end();
  if (await done !== 0) throw Error('Native operation refused: ' + stderr);
  return { stdout, stderr };
}
async function prepareGit(git: GitContext): Promise<Record<string, string>> {
  for (const path of [git.worktree, git.commonDir, git.privateDir])
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('Invalid Git path');
  if (realpathSync(git.worktree) !== git.worktree || realpathSync(git.commonDir) !== git.commonDir
    || realpathSync(join(git.commonDir, 'objects')) !== join(git.commonDir, 'objects')
  )
    throw new Error('Aliased Git context');
  // Engine-created metadata uses physical invocation scratch. This is ordinary metadata separation.
  const parent = resolve(git.privateDir, '..');
  if (realpathSync(parent) !== parent) throw new Error('Aliased private Git parent');
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_DIR: git.privateDir, GIT_COMMON_DIR: git.privateDir, GIT_WORK_TREE: git.worktree,
    GIT_INDEX_FILE: join(git.privateDir, 'index'), GIT_OBJECT_DIRECTORY: join(git.privateDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(git.commonDir, 'objects'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false'
  };
  const run = async (args: string[], env: Record<string, string>) => (await nativeExec([await nativeTool('git'), ...args], { env })).stdout.trim();
  const format = await run(['--git-dir', git.commonDir, 'rev-parse', '--show-object-format'], { GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null' });
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unknown object format');
  if (git.baseCommit !== null && (typeof git.baseCommit !== 'string'
    || !(format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(git.baseCommit))) throw new Error('Invalid base commit');
  try { mkdirSync(git.privateDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || realpathSync(git.privateDir) !== git.privateDir
      || !lstatSync(git.privateDir).isDirectory() || readdirSync(git.privateDir).length !== 0) throw error;
  }
  await run(['init', '--bare', `--object-format=${format}`, git.privateDir], { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  await run(['config', 'core.bare', 'false'], env);
  writeFileSync(join(git.privateDir, 'HEAD'), 'ref: refs/heads/flowcrew\n');
  if (git.baseCommit !== null) {
    if (await run(['cat-file', '-t', git.baseCommit], env) !== 'commit') throw new Error('Base is not a commit');
    await run(['update-ref', 'HEAD', git.baseCommit], env);
  }
  await run(['read-tree', git.baseCommit ?? '--empty'], env);
  return env;
}

export async function prepareGitTask(git: GitContext): Promise<Result<{ environment: Record<string, string> }>> {
  try { return { ok: true, value: { environment: await prepareGit(git) } }; } catch (error) { return { ok: false,
    kind: 'invalid', detail: String(error) }; }
}
