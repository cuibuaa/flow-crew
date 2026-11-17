import { mkdirSync, realpathSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { readFile, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { promisify, isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id, Ref, Result } from '../contract/brief.js';
import type { Owner, OwnerState, RunRef, RunObservation, OwnedProgram, ProcessReceipt, GrantRequest, JournalPayload, Writer }
  from '../contract/runtime.js';
import { prepareGrant, type EvidencePorts } from './confine.js';
// Trusted operation executors do not load confinement infrastructure. The run controller owns that lifecycle.
let sandbox: typeof import('./srt.js') | undefined;
const controller = async () => sandbox ??= await import('./srt.js');

const execute = promisify(execFile);
const bad = (kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> => ({ ok: false, kind, detail });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const key = (owner: Owner) => JSON.stringify([owner.pid, owner.start, owner.boot, owner.authority]);
const self = fileURLToPath(import.meta.url);
const tools = new Map<string, string>();
export interface Claim { readonly database: string; readonly holder: string; readonly resource: string; readonly owner: Owner;
  readonly epoch: Id; readonly unit: RunRef | null; }
export interface ProcessPorts extends EvidencePorts {
  storeEvidence(source: () => AsyncIterable<Uint8Array>): Promise<Result<Ref>>;
  recordController?(owner: Owner): Promise<Result<unknown>>;
  readonly streamRoot: string;
  readonly scratch: string;
  readEvidence(ref: Ref): Promise<Result<Uint8Array>>;
  recordProcess(payload: Extract<JournalPayload, { type: 'ownership' | 'process' | 'run_observed' }>): Promise<Result<number>>;
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
// Native process details stay here. ESRCH is the only empty-group observation; EPERM is unknown.
export async function identity(pid = process.pid): Promise<Owner> {
  if (process.platform === 'linux') {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, start: f[19], boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), group: Number(f[2]), authority: '' };
  }
  if (process.platform !== 'darwin') throw new Error('Unsupported host');
  // Native birth has microsecond precision; ps lstart alone cannot distinguish same-second PID reuse.
  const [birth, boot] = await Promise.all([
    execute(await nativeTool('python3'), [ '-I', '-S', '-B', '-c',
      ("\nimport ctypes, os, sys, json\nclass Info(ctypes.Structure):\n _fields_=[(name,ctypes.c_uint" +
      "32) for name in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid'" +
      ",'svgid','reserved']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(name,ctypes." +
      "c_uint32) for name in ['nfiles','pgid','jobc','tdev','tpgid','nice']]+[('sec',ctypes.c_uin" +
      "t64),('usec',ctypes.c_uint64)]\npid=int(sys.argv[1]);info=Info();lib=ctypes.CDLL('/usr/lib/" +
      "libproc.dylib',use_errno=True)\nif lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeo" +
      "f(info))!=ctypes.sizeof(info):\n print(json.dumps({'error':ctypes.get_errno()}))\nelse:print" +
      "(json.dumps({'pid':info.pid,'group':info.pgid,'start':str(info.sec)+':'+str(info.usec)}))\n"), String(pid)],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }),
    execute(await nativeTool('sysctl'), [ '-n', 'kern.boottime'], { env: { PATH: '/usr/bin:/bin' } }),
  ]);
  const info = JSON.parse(birth.stdout);
  if (info.error !== undefined) throw Object.assign(new Error('Native process identity unavailable'), {
    code: info.error === 3 ? 'ESRCH' : info.error === 1 ? 'EPERM' : 'EIO' });
  if (info.pid !== pid || !info.group || !info.start) throw new Error('Native process identity unavailable');
  return { pid, start: info.start, boot: boot.stdout.trim(), group: info.group, authority: '' };
}
export const ownIdentity = identity;
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
const closing = new Map<string, Promise<Result<'dead'> | UnconfirmedClosure>>();
/** One owner, one drain backstop; ESRCH alone authorizes retirement. Concurrent callers share the same wait. */
export async function closeOperation(owner: Owner): Promise<Result<'dead'> | UnconfirmedClosure> {
  const id = key(owner), prior = closing.get(id); if (prior) return prior;
  const pending = drainOperation(owner); closing.set(id, pending);
  try { return await pending; } finally { closing.delete(id); }
}
async function drainOperation(owner: Owner): Promise<Result<'dead'> | UnconfirmedClosure> {
  if (!owner.authority) return bad('invalid', 'Unbound process identity is not a recorded operation authority');
  let state = groupState(owner);
  if (state !== 'live') return state === 'dead' ? ok(state) : notClosed(owner, state, 'Group observation unavailable');
  if (!await authenticated(owner)) return groupState(owner) === 'dead' ? ok('dead') : notClosed(owner, 'unknown',
    'No surviving recorded group identity; refusing signal');
  const started = performance.now();
  try { process.kill(-owner.group, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notClosed(owner, 'unknown', 'Group signal outcome unavailable'); }
  for (;;) {
    state = groupState(owner);
    if (state === 'dead') return ok(state);
    if (performance.now() - started >= DRAIN_BACKSTOP_MS) return notClosed(owner, state, 'SIGKILL drain backstop reached');
    await pause(10);
  }
}
const send = (child: ReturnType<typeof spawn>,
  packet: Parameters<NonNullable<ReturnType<typeof spawn>['send']>>[0]) => new Promise<boolean>(resolve => {
  if (!child.connected) return resolve(false); child.send!(packet, error => resolve(!error)); });
interface Worker { owner: Owner; child: ReturnType<typeof spawn>; done: Promise<{ exit: number | null; signal: string | null }>; }
const held = new Map<string, Worker>();
/** Idle worker is also the claim's capability. No effects occur before the durable ready/go exchange. */
export async function beginOperation(fds?: readonly [number | 'pipe', number | 'pipe']): Promise<Result<Worker>> {
  try {
    const child = spawn(process.execPath, [self, '--operation'], { detached: true, stdio: ['pipe',
      fds?.[0] ?? 'ignore', fds?.[1] ?? 'ignore', 'ipc'], serialization: 'advanced' });
    const done = new Promise<{ exit: number | null; signal: string | null }>(resolve => {
      child.once('error', () => resolve({ exit: null, signal: null })); child.once('close', (exit, signal) => resolve({ exit, signal }));
    });
    const owner = await Promise.race([
      new Promise<Owner>(resolve => child.once('message', value => resolve(value as Owner))),
      done.then(() => { throw new Error('Operation exited before ready'); }),
    ]);
    if (owner.pid !== child.pid || owner.group !== child.pid || !await authenticated(owner)) { child.kill('SIGKILL'); await done;
      return bad('unknown', 'Operation identity not authenticated'); }
    const worker = { owner, child, done }; held.set(key(owner), worker); return ok(worker);
  } catch (error) { return bad('unavailable', String(error)); }
}
export async function endOperation(owner: Owner): Promise<Result<'dead'> | UnconfirmedClosure> {
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
  const owner = { ...await identity(), authority: randomUUID() };
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
        await closeController();
        process.exit(process.exitCode ?? 0);
      } else if (message.request) {
        const value = await performOperation(message.request);
        if (process.stdout.writable) process.stdout.end(() => process.send!({ result: value })); else process.send!({ result: value });
      }
    } catch (error) { if (process.connected) process.send!({ result: bad('unknown', String(error)) }); else process.exit(1); }
  });
}
export async function launchInvocation(request: GrantRequest, program: OwnedProgram, ports: ProcessPorts,
  abort: AbortSignal): Promise<Result<ProcessReceipt>> {
  const started = performance.now();
  // The trusted recorder supplies the run-private infrastructure scratch, part of the disclosed write union.
  request = { ...request, writableRoots: [...new Set([...request.writableRoots, ports.scratch])] };
  program = { ...program, writableRoots: request.writableRoots };
  const prepared = await prepareGrant(request, program, ports); if (!prepared.ok) return prepared;
  const adapter = await controller();
  let descriptor;
  try { descriptor = await adapter.wrap(request, { ...program, env: { ...prepared.value.environment, ...program.env } }, ports.scratch, nativeTool); }
  catch (error) { return bad('unavailable', adapter.diagnosis(String(error))); }
  if (controllerOwner && ports.recordController) { controllerOwner = { ...controllerOwner, members: await groupMembers(controllerOwner) };
    const recorded = await ports.recordController(controllerOwner); if (!recorded.ok) return recorded; }
  const token = randomUUID(), paths = ['stdout', 'stderr'].map(name => join(ports.streamRoot, token + '-' + name));
  const files = await Promise.all(paths.map(path => open(path, 'wx', 0o600)));
  const opened = await beginOperation([files[0].fd, files[1].fd]);
  for (const file of files) await file.close();
  if (!opened.ok) return opened;
  const worker = opened.value; worker.owner = { ...worker.owner, streams: { stdout: paths[0], stderr: paths[1] } };
  let released = false, closureAttempted = false, timer: NodeJS.Timeout | undefined;
  const cancel = () => { if (released) void send(worker.child, { cancel: true }); };
  abort.addEventListener('abort', cancel, { once: true });
  const invoke = async (): Promise<Result<ProcessReceipt>> => { try {
    const recorded = await ports.recordProcess({ type: 'ownership', owner: worker.owner, state: 'live' });
    if (!recorded.ok) return recorded;
    const input = program.stdin ? await ports.readEvidence(program.stdin) : ok(new Uint8Array());
    if (!input.ok) return input;
    if (program.stdin && createHash('sha256').update(input.value).digest('hex') !== program.stdin.sha256) return bad('invalid',
      'Stdin reference mismatch');
    worker.child.stdin!.on('error', () => { });
    let nativeExit = false, updates = Promise.resolve();
    const outcome = new Promise<{ exit: number | null; signal: string | null }>(resolve => {
      worker.child.on('message', (value: any) => {
        updates = updates.then(async () => {
          if (value.member) await recordMember(worker, value.member, async (_previous, owner) =>
            ports.recordProcess({ type: 'ownership', owner, state: 'live' }));
          else { nativeExit = !!value.nativeExit; resolve(value.nativeExit ?? { exit: null, signal: null }); }
        }).catch(() => resolve({ exit: null, signal: null }));
      });
      worker.done.then(() => updates.then(() => resolve({ exit: null, signal: null })));
    });
    if (!abort.aborted && (program.durationMs === undefined || performance.now() - started < program.durationMs)) {
      if (!await send(worker.child, { exec: { argv: descriptor.argv, env: descriptor.env, cwd: program.cwd } }
        )) return bad('unknown', 'Invocation interrupted at recorded start barrier');
      worker.child.stdin!.end(input.value); released = true; if (abort.aborted) cancel();
      const tick = () => { if (program.durationMs === undefined) return; const remaining = program.durationMs - (performance.now() - started);
        if (remaining <= 0) cancel(); else timer = setTimeout(tick, Math.min(remaining, 2147483647)); }; tick();
    } else worker.child.kill('SIGKILL');
    const ending = await outcome;
    closureAttempted = true;
    const closed = await endOperation(worker.owner);
    if (!closed.ok) return closed;
    const refs: Ref[] = [];
    for (const path of paths) {
      const ref = await ports.storeEvidence(async function* () { const file = await open(path, 'r'); try {
        for await (const bytes of file.createReadStream()) yield bytes; } finally { await file.close(); } });
      if (!ref.ok) return ref; refs.push(ref.value);
    }
    const receipt: ProcessReceipt = {
owner: worker.owner, state: !released ? 'not_started' : closed.ok && nativeExit ? 'closed' : 'closure_unknown',
  exit: released ? ending.exit : null, signal: ending.signal,
      grant: 'applied', stdout: refs[0], stderr: refs[1], durationMs: Math.ceil(performance.now() - started),
        scope: process.platform === 'linux' ? 'contained_descendants' : 'group'
};
    const ownerSaved = await ports.recordProcess({ type: 'ownership', owner: worker.owner, state: closed.ok ? 'dead' : 'unknown' });
      if (!ownerSaved.ok) return ownerSaved;
    const saved = await ports.recordProcess({ type: 'process', receipt });
    if (saved.ok) for (const path of paths) await rm(path);
    return saved.ok ? ok(receipt) : saved;
  } finally {
    clearTimeout(timer); abort.removeEventListener('abort', cancel);
    adapter.cleanup();
  } };
  let result: Result<ProcessReceipt>;
  try { result = await invoke(); } catch (error) { result = bad('unknown', String(error)); }
  if (!closureAttempted) { const closed = await endOperation(worker.owner); if (!closed.ok) return closed; }
  return result;
}
export async function checkReadiness(request: GrantRequest, program: OwnedProgram, ports: ProcessPorts,
  abort: AbortSignal): Promise<import('../contract/runtime.js').GrantReceipt> {
  const launched = await launchInvocation(request, program, ports, abort);
  const adapter = await controller();
  if (!launched.ok) return { state: launched.kind === 'unavailable' ? 'unavailable' : 'refused', evidence: [], detail: launched.detail };
  const receipt = launched.value;
  const ready = receipt.state === 'closed' && receipt.exit === 0;
  const stderr = ready ? undefined : await ports.readEvidence(receipt.stderr);
  const diagnostic = stderr?.ok ? Buffer.from(stderr.value).toString().trim() : stderr?.detail;
  return { state: ready ? 'applied' : 'unavailable', evidence: [receipt.stdout, receipt.stderr],
    detail: ready ? 'Real confined readiness launch succeeded. ' + adapter.disclosure(request,
    ports.scratch) : adapter.diagnosis(diagnostic ||
      `Real native readiness launch exited ${receipt.exit}, signal ${receipt.signal}; raw stderr retained`) };
}
export async function observeRun(run: RunRef, context: RunContext): Promise<Result<RunObservation>> {
  const observed = await context.observation(run); if (!observed.ok) return observed;
  if (!observed.value) return ok({ unit: run, state: 'inactive', owner: null, evidence: [], detail: 'No activation recorded' });
  if (!isDeepStrictEqual(observed.value.unit, run)) return bad('conflict', 'Pinned run identity differs');
  const owner = observed.value.owner;
  const state = owner ? (groupState(owner) === 'dead' ? 'dead' : await matching(owner) ? 'live' : 'unknown') : 'unknown';
  return ok({ ...observed.value, state: state === 'live' ? 'active' : state === 'dead' ? 'inactive' : 'unknown' });
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
  if (controller && await matching(controller)) {
    try { process.kill(controller.pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notClosed(controller, 'unknown', 'Controller wake outcome unavailable');
    }
    // A live recorder owns invocation closure and durable receipts. Never race it with a second group kill.
    const started = performance.now();
    while (groupState(controller) !== 'dead' && await matching(controller)) {
      if (performance.now() - started >= DRAIN_BACKSTOP_MS)
        return notClosed(controller, groupState(controller), 'Recorder has not finished recording');
      await pause(10);
    }
  }
  if (controller) { const closed = await closeOperation(controller); if (!closed.ok) return closed; }
  let pending = await context.pending(run); if (!pending.ok) return pending;
  for (const owner of pending.value) {
    const closed = await closeOperation(owner); if (!closed.ok) return closed;
    if (!owner.streams) return bad('unknown', 'Interrupted invocation has no recorded stream locations');
    const refs: Ref[] = [];
    for (const path of [owner.streams.stdout, owner.streams.stderr]) { const saved = await ports.storeEvidence(async function* () {
      const file = await open(path, 'r'); try { for await (const bytes of file.createReadStream()) yield bytes; } finally { await file.close(); } });
      if (!saved.ok) return saved; refs.push(saved.value); }
    const receipt: ProcessReceipt = { owner, state: 'closure_unknown', exit: null, signal: null, grant: 'applied', stdout: refs[0],
      stderr: refs[1], durationMs: 0, scope: process.platform === 'linux' ? 'contained_descendants' : 'group' };
    const saved = await ports.recordProcess({ type: 'process', receipt }); if (!saved.ok) return saved;
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

/** Resolve native prerequisites once at the host boundary; consumers use the selected absolute executable. */
export async function nativeTool(name: string): Promise<string> {
  const known = tools.get(name); if (known) return known;
  const { access } = await import('node:fs/promises');
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(':')) if (directory.startsWith('/')) {
    const candidate = join(directory, name); try { await access(candidate, 1); tools.set(name, candidate); return candidate; } catch { }
  }
  throw new Error('Missing native prerequisite: ' + name);
}
export async function publishNoReplace(source: string, target: string): Promise<void> {
  await nativeExec([await nativeTool('python3'), '-I', '-S', '-B', '-c',
      ("\nimport ctypes, os, sys\nlibc=ctypes.CDLL(None,use_errno=True)\nsource,target=map(os.fsencod" +
      "e,sys.argv[1:3])\nif sys.platform=='darwin': result=libc.renamex_np(source,target,4)\nelse: " +
      "result=libc.renameat2(-100,source,-100,target,1)\nif result:\n error=ctypes.get_errno()\n rai" +
      "se OSError(error,os.strerror(error))\n"), source, target], { env: {} });
}

export async function closeController(): Promise<void> { if (sandbox) { await sandbox.reset(); sandbox = undefined; } }

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
const contains = (parent: string, path: string): boolean => {
  const suffix = relative(parent, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
};
async function prepareGit(request: GrantRequest, snapshot: { protected: { path: string }[]; writable: { path: string; kind: string }[] },
  initialize: boolean): Promise<Record<string, string>> {
  const git = request.git;
  if (!git) return {};
  for (const path of [git.worktree, git.commonDir, git.privateDir])
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('Invalid Git path');
  if (realpathSync(git.worktree) !== git.worktree || realpathSync(git.commonDir) !== git.commonDir
    || realpathSync(join(git.commonDir, 'objects')) !== join(git.commonDir, 'objects')
    || !snapshot.protected.some(root => contains(root.path, git.commonDir))
    || !snapshot.writable.some(root => root.kind === 'directory' && contains(root.path, git.privateDir))
  )
    throw new Error('Git authority escapes explicit roots');
  // The parent must already exist beneath a physical grant; never follow an authored alias to create authority.
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
  if (!initialize) return env;
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

export async function prepareGitTask(request: GrantRequest, snapshot: { writable: { path: string; kind: string }[]; protected:
  { path: string }[] }): Promise<Result<{ environment: Record<string, string> }>> {
  try { return { ok: true, value: { environment: await prepareGit(request, snapshot, true) } }; } catch (error) { return { ok: false,
    kind: 'invalid', detail: String(error) }; }
}
