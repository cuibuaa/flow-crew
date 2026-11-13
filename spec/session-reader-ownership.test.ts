import './test-support/policy-runtime.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { TaskRegistry, sessionTaskIndexPath } from '../src/task-registry.js';
import { SessionPush } from '../src/session-push.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { sessionGate } from '../src/cli-session-push.js';
import { hasClaudeWakeWaiter, sessionWaiterPath, waitForClaudeWake, wakeUnavailablePath } from '../src/session-wake.js';

const originalFcHome = fcGlobalDir();
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
  }
  children.clear();
  setFcGlobalDir(originalFcHome);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cli = join(import.meta.dirname, '../dist/cli.js');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-reader-owner-')); roots.push(root);
  const fc = join(root, 'fc');
  setFcGlobalDir(fc);
  const env = { ...process.env, HOME: root, FC_HOME: fc, FC_TASKS_ROOT: join(root, 'ledger'), FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock') };
  const registry = new TaskRegistry({ baseDir: fc });
  const task = registry.create({ projectDir: root, status: 'running', launcher: {
    frontend: 'claude', sessionId: 'reader-session', cwd: root, ledgerRoot: env.FC_TASKS_ROOT,
  } });
  return { root, fc, env, registry, task };
}
async function ready(child: ChildProcess) {
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`child readiness deadline: ${output}`)), 15_000);
    child.stderr!.on('data', chunk => { output += chunk; if (output.includes('fixture-ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited before readiness: ${code}: ${output}`)); });
  });
}
async function kill(child: ChildProcess) {
  const done = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGKILL');
  await done;
  children.delete(child);
}
function hook(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = f.env, frontend = 'claude', session = 'reader-session') {
  return spawnSync(process.execPath, [cli, 'session-push', 'hook', '--frontend', frontend, '--event', 'Stop'], {
    cwd: f.root, env: { ...env, HOME: f.root, FC_HOME: f.fc }, input: JSON.stringify({ session_id: session }), encoding: 'utf8', timeout: 15_000,
  });
}

it('registry inspection and maintenance dry-runs do not participate in a live writer lock', () => {
  const f = fixture();
  const owner = JSON.stringify({ pid: process.pid, token: 'fixture-live-writer' });
  writeFileSync(f.registry.lockPath, owner);
  const reader = new TaskRegistry({ baseDir: f.fc });
  expect(reader.get(f.task.id)?.id).toBe(f.task.id);
  expect(reader.list()).toHaveLength(1);
  expect(reader.snapshot().tasks).toHaveLength(1);
  expect(reader.health().unreadableRecords).toBe(0);
  expect(reader.metrics().records).toBe(1);
  expect(reader.hasUnknownTaskStatuses()).toBe(false);
  expect(reader.repair().applied).toBe(false);
  expect(reader.compact().applied).toBe(false);
  expect(readFileSync(reader.lockPath, 'utf8')).toBe(owner);
  expect(readdirSync(f.fc).filter(name => name.startsWith('tasks.lock'))).toEqual(['tasks.lock']);
});

it.each(['statusline', 'hook'])('a killed %s reader leaves no lock or temporary file and the next writer needs zero lock wait', async command => {
  const f = fixture();
  const preload = join(f.root, 'pause-reader.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (String(path).endsWith('/current.json')) { process.stderr.write('fixture-ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  return read.call(this, path, ...args);
}; syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ['--import', preload, cli, 'session-push', command,
    ...(command === 'hook' ? ['--frontend', 'claude', '--event', 'Stop'] : ['--json'])], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin!.end(JSON.stringify({ session_id: 'reader-session' }));
  await ready(child);
  expect(existsSync(f.registry.lockPath)).toBe(false);
  await kill(child);
  expect(readdirSync(f.fc).filter(name => name.startsWith('tasks.lock') || name.includes('.tmp'))).toEqual([]);
  expect(readdirSync(join(f.fc, 'tasks', '1')).filter(name => name.includes('.tmp'))).toEqual([]);
  const next = new TaskRegistry({ baseDir: f.fc }).create({ projectDir: f.root });
  expect(next.id).toBe(2);
});

it('a killed writer retains its durable append, is recovered by the next writer, and its recovery never blocks a Stop hook', async () => {
  const f = fixture();
  const module = pathToFileURL(join(import.meta.dirname, '../dist/task-registry.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { TaskRegistry } from ${JSON.stringify(module)}; import { fsyncSync } from 'node:fs';
new TaskRegistry({ baseDir: process.env.FC_HOME, syncFile: fd => { fsyncSync(fd); process.stderr.write('fixture-ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } }).create({ projectDir: process.env.HOME });
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(child);
  expect(existsSync(f.registry.lockPath)).toBe(true);
  await kill(child);
  const writer = new TaskRegistry({ baseDir: f.fc });
  expect(writer.create({ projectDir: f.root }).id).toBe(3);
  expect(writer.list().map(task => task.id)).toEqual([1, 2, 3]);
  const recoveries = readFileSync(join(f.fc, 'infrastructure-recoveries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(recoveries).toEqual([expect.objectContaining({ component: 'registry' })]); // operator diagnostic, not a model continuation
  expect(existsSync(writer.lockPath)).toBe(false);
  // Close this fixture's unrelated open work: the recovered infrastructure
  // condition alone has no authority to reopen a model turn.
  writeFileSync(join(f.fc, 'session-push', 'task-index', readdirSync(join(f.fc, 'session-push', 'task-index')).find(name => name.endsWith('.json'))!), '[]');
  const result = hook(f);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  // Same recovered condition with a real obligation: the verdict is the event, with no word of the takeover.
  const event = new SessionPush(f.registry).enqueue(f.task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
  const withEvent = hook(f);
  expect(JSON.parse(withEvent.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining(event.eventId) });
  expect(withEvent.stdout).not.toMatch(/recover|stale|infrastructure/iu);
});

it.each(['removed', 'rebound'])('crash recovery removes obsolete session ownership when a launcher was %s', change => {
  const f = fixture();
  const module = pathToFileURL(join(import.meta.dirname, '../dist/task-registry.js')).href;
  const patch = change === 'removed' ? '{ launcher: undefined }' : JSON.stringify({ launcher: { ...f.task.launcher!, sessionId: 'replacement' } });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { TaskRegistry } from ${JSON.stringify(module)}; import { fsyncSync } from 'node:fs';
new TaskRegistry({ baseDir: process.env.FC_HOME, syncFile: fd => { fsyncSync(fd); process.kill(process.pid, 'SIGKILL'); } }).update(1, ${patch});
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, encoding: 'utf8', timeout: 15_000 });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  const writer = new TaskRegistry({ baseDir: f.fc });
  writer.ensureSessionTaskIndexes();
  const push = new SessionPush(writer);
  expect(push.sessionTasks('claude', 'reader-session')).toEqual([]);
  expect(JSON.parse(readFileSync(sessionTaskIndexPath(f.fc, f.task.launcher!), 'utf8'))).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.fc, 'tasks', '1', 'current.json'), 'utf8')).launcher)
    .toEqual(change === 'removed' ? undefined : expect.objectContaining({ sessionId: 'replacement' }));
  expect(push.sessionTasks('claude', 'replacement').map(task => task.id)).toEqual(change === 'removed' ? [] : [1]);
  expect(sessionGate(push, 'claude', 'reader-session')).toEqual({});
  expect(existsSync(join(push.root, 'task-index', 'dirty'))).toBe(false);
});

it('a losing event publisher indexes and returns the canonical winner with its recorded launcher', async () => {
  const f = fixture();
  const taskB = f.registry.update(f.task.id, { launcher: { ...f.task.launcher!, sessionId: 'replacement' } });
  const source = { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() };
  const release = join(f.root, 'release-publisher');
  const modules = ['task-registry', 'session-push'].map(name => pathToFileURL(join(import.meta.dirname, `../dist/${name}.js`)).href);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const link = fs.linkSync;
fs.linkSync = (source, target, ...args) => {
  if (String(target).includes('/session-push/events/')) {
    process.stderr.write('fixture-ready\\n'); const deadline = Date.now() + 15_000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw Error('publisher release deadline');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return link(source, target, ...args);
}; syncBuiltinESMExports();
const { TaskRegistry } = await import(${JSON.stringify(modules[0])});
const { SessionPush } = await import(${JSON.stringify(modules[1])});
console.log(JSON.stringify(new SessionPush(new TaskRegistry({ baseDir: process.env.FC_HOME })).enqueue(${JSON.stringify(taskB)}, ${JSON.stringify(source)})));
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', bytes => { output += bytes; });
  const done = new Promise(resolve => child.once('close', resolve));
  await ready(child);
  const push = new SessionPush(f.registry);
  const winner = push.enqueue(f.task, source)!;
  writeFileSync(release, 'go');
  await done; children.delete(child);
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual(winner);
  expect(push.pending('reader-session', 'claude').map(event => event.eventId)).toEqual([winner.eventId]);
  expect(push.pending('replacement', 'claude')).toEqual([]);
  // Replaying publication also respects the immutable winner.
  expect(push.enqueue(taskB, source)).toEqual(winner);
  expect(push.pending('replacement', 'claude')).toEqual([]);
});

it('a paused expiring waiter cannot remove its replacement lease or lose its pending-event wake', async () => {
  const f = fixture();
  const release = join(f.root, 'release-old');
  const modules = ['task-registry', 'session-push', 'session-wake'].map(name => pathToFileURL(join(import.meta.dirname, `../dist/${name}.js`)).href);
  const start = (old: boolean) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const unlink = fs.unlinkSync;
fs.unlinkSync = (path, ...args) => {
  if (${old} && String(path).includes('/waiters/') && String(path).endsWith('.json')) {
    process.stderr.write('fixture-ready\\n'); const deadline = Date.now() + 15_000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw Error('waiter release deadline');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return unlink(path, ...args);
}; syncBuiltinESMExports();
const { TaskRegistry } = await import(${JSON.stringify(modules[0])});
const { SessionPush } = await import(${JSON.stringify(modules[1])});
const { waitForClaudeWake } = await import(${JSON.stringify(modules[2])});
console.log(JSON.stringify(await waitForClaudeWake(new SessionPush(new TaskRegistry({ baseDir: process.env.FC_HOME })), 'reader-session', {
  lifetimeMs: ${old ? 50 : 15_000}, pollMs: 10,
  sleep: async ms => { if (!${old}) process.stderr.write('fixture-ready\\n'); await new Promise(resolve => setTimeout(resolve, ms)); },
})));
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', bytes => { output += bytes; });
    const done = new Promise(resolve => child.once('close', resolve));
    return { child, done, output: () => output };
  };
  const old = start(true); await ready(old.child);
  const replacement = start(false); await ready(replacement.child);
  const path = sessionWaiterPath(join(f.fc, 'session-push'), 'reader-session');
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(replacement.child.pid);
  writeFileSync(release, 'go');
  await old.done; children.delete(old.child);
  expect(old.child.exitCode).toBe(0);
  expect(hasClaudeWakeWaiter(join(f.fc, 'session-push'), 'reader-session')).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(replacement.child.pid);
  const push = new SessionPush(f.registry);
  const event = push.enqueue(f.task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
  await push.deliver(event);
  await replacement.done; children.delete(replacement.child);
  expect(replacement.child.exitCode).toBe(0);
  expect(JSON.parse(replacement.output())).toMatchObject({ code: 2, prompt: expect.stringContaining(event.eventId) });
  expect(readdirSync(join(push.root, 'waiters'))).toEqual([]);
});

it('an unrecoverable session read failure reaches the operator on every Stop and status refresh and is never a decision or reason', () => {
  const f = fixture();
  writeFileSync(join(f.fc, 'tasks', '1', 'current.json'), '{broken');
  for (let call = 0; call < 2; call++) {
    const result = hook(f);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expect.stringContaining('Session state cannot be checked') });
    expect(result.stderr).toBe('');
  }
  const status = spawnSync(process.execPath, [cli, 'session-push', 'statusline', '--json'], {
    cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, input: JSON.stringify({ session_id: 'reader-session' }), encoding: 'utf8', timeout: 15_000,
  });
  expect(JSON.parse(status.stdout).text).toContain('display unavailable for session reader-session');
  expect(existsSync(join(f.fc, 'session-push', 'integration-errors'))).toBe(false); // nothing persists diagnostics
});

it('a pending event remains session-scoped and produces a real Stop continuation', () => {
  const f = fixture();
  const event = new SessionPush(f.registry).enqueue(f.task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
  const result = hook(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining(event.eventId) });
});

it('a wake read fault that outlasts the lease is thrown to the caller, not recorded, and a later healthy tick needs no clearing', async () => {
  const f = fixture();
  const push = new SessionPush(f.registry);
  writeFileSync(join(f.fc, 'tasks', '1', 'current.json'), '{broken');
  await expect(waitForClaudeWake(push, 'reader-session', { lifetimeMs: 0 })).rejects.toThrow();
  writeFileSync(join(f.fc, 'tasks', '1', 'current.json'), JSON.stringify(f.task));
  expect((await waitForClaudeWake(push, 'reader-session', { lifetimeMs: 0 })).code).toBe(2);
  expect(existsSync(join(push.root, 'integration-errors'))).toBe(false);
});

it('a killed ACK writer atomically retires the pending link and replay cannot resurrect it', async () => {
  const f = fixture();
  const push = new SessionPush(f.registry);
  const source = { type: 'operator_wrap_up_required' as const, runId: 'fixture-run', timestamp: new Date().toISOString() };
  const event = push.enqueue(f.task, source)!;
  const preload = join(f.root, 'pause-ack.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
fs.renameSync = function(source, target) {
  const result = rename(source, target);
  if (String(target).includes('/acks/')) { process.stderr.write('fixture-ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  return result;
}; syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ['--import', preload, cli, 'session-push', 'ack', '--event', event.eventId, '--session', 'reader-session'], {
    cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await ready(child);
  await kill(child);
  expect(push.acknowledged(event.eventId)).toBe(true);
  expect(push.pending('reader-session', 'claude')).toEqual([]);
  const warnings: string[] = [];
  new TaskRegistry({ baseDir: f.fc, warn: message => warnings.push(message) }).create({ projectDir: f.root });
  expect(warnings).toHaveLength(1);
  push.enqueue(f.task, source);
  expect(push.pending('reader-session', 'claude')).toEqual([]);
  expect(JSON.parse(readFileSync(join(push.root, 'acks', event.eventId + '.json'), 'utf8')).eventId).toBe(event.eventId);
});

it('a healthy Stop with a live waiter spawns no child process; the counter does see the version probe', async () => {
  const f = fixture();
  const modules = ['task-registry', 'session-push', 'session-wake'].map(name => pathToFileURL(join(import.meta.dirname, `../dist/${name}.js`)).href);
  const waiter = spawn(process.execPath, ['--input-type=module', '-e', `
const { TaskRegistry } = await import(${JSON.stringify(modules[0])});
const { SessionPush } = await import(${JSON.stringify(modules[1])});
const { waitForClaudeWake } = await import(${JSON.stringify(modules[2])});
await waitForClaudeWake(new SessionPush(new TaskRegistry({ baseDir: process.env.FC_HOME })), 'reader-session', {
  lifetimeMs: 30_000, pollMs: 50, sleep: async ms => { process.stderr.write('fixture-ready\\n'); await new Promise(resolve => setTimeout(resolve, ms)); },
});
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(waiter);
  const push = new SessionPush(f.registry);
  expect(hasClaudeWakeWaiter(push.root, 'reader-session')).toBe(true);
  const preload = join(f.root, 'count-spawns.mjs');
  const spawns = join(f.root, 'spawns.log');
  writeFileSync(preload, `import cp from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function(...args) { fs.appendFileSync(process.env.FIXTURE_SPAWNS, name + ' ' + String(args[0]) + '\\n'); return original.apply(this, args); };
}
syncBuiltinESMExports();`);
  const env = { ...f.env, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, FIXTURE_SPAWNS: spawns };
  const stop = hook(f, env);
  expect(stop.status, stop.stderr).toBe(0);
  expect(stop.stdout).toBe('');
  expect(existsSync(spawns)).toBe(false);
  // Control: the same counter records the version probe the wake path (and doctor) still make.
  spawnSync(process.execPath, [cli, 'session-push', 'wake-check'], { cwd: f.root, env: { ...env, HOME: f.root, FC_HOME: f.fc, PATH: dirname(process.execPath) }, encoding: 'utf8', timeout: 15_000 });
  expect(readFileSync(spawns, 'utf8')).toContain('execFileSync claude');
});

it('a Stop in its registration wait shows no takeover text when a writer holds and then loses the registry lock', async () => {
  const f = fixture();
  const module = pathToFileURL(join(import.meta.dirname, '../dist/task-registry.js')).href;
  // The wake registrant's own writer boundary: the lock is held between publications, so readers keep reading.
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
import { TaskRegistry } from ${JSON.stringify(module)};
new TaskRegistry({ baseDir: process.env.FC_HOME }).withSessionWrite(() => { process.stderr.write('fixture-ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
`], { cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc }, stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(writer);
  expect(existsSync(f.registry.lockPath)).toBe(true);
  const waiting = join(f.root, 'stop-waiting');
  const preload = join(f.root, 'signal-wait.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const stat = fs.statSync; let signalled = false;
fs.statSync = function(path, ...args) {
  if (!signalled && String(path).includes('/waiters/')) { signalled = true; fs.writeFileSync(process.env.FIXTURE_WAITING, 'x'); }
  return stat.call(this, path, ...args);
}; syncBuiltinESMExports();`);
  const stop = spawn(process.execPath, ['--import', preload, cli, 'session-push', 'hook', '--frontend', 'claude', '--event', 'Stop'], {
    cwd: f.root, env: { ...f.env, HOME: f.root, FC_HOME: f.fc, FIXTURE_WAITING: waiting }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(stop);
  let out = ''; let err = '';
  stop.stdout!.on('data', bytes => { out += bytes; }); stop.stderr!.on('data', bytes => { err += bytes; });
  const closed = new Promise(resolve => stop.once('close', resolve));
  stop.stdin!.end(JSON.stringify({ session_id: 'reader-session' }));
  for (let i = 0; i < 300 && !existsSync(waiting); i++) await new Promise(resolve => setTimeout(resolve, 50));
  expect(existsSync(waiting), `stdout=${out} stderr=${err}`).toBe(true); // the Stop is now inside its 4 s registration wait
  await kill(writer); // the writer loses the lock ...
  expect(new TaskRegistry({ baseDir: f.fc }).create({ projectDir: f.root }).id).toBeGreaterThan(1); // ... and the next writer takes it over
  await closed; children.delete(stop);
  expect(readFileSync(join(f.fc, 'infrastructure-recoveries.jsonl'), 'utf8')).toContain('"component":"registry"');
  const verdict = JSON.parse(out);
  expect(verdict).toEqual({ decision: 'block', reason: expect.stringContaining('must be renewed') });
  expect(`${out}${err}`).not.toMatch(/recover|stale|took over|takeover|infrastructure|tasks\.lock/iu);
}, 30_000);

it('a Codex pending event with an unreadable or failed display returns the event; raw error text reaches only the operator', () => {
  const f = fixture();
  const task = f.registry.create({ projectDir: f.root, status: 'running', launcher: {
    frontend: 'codex', sessionId: 'codex-session', cwd: f.root, ledgerRoot: f.env.FC_TASKS_ROOT, socket: join(f.root, 'codex.sock'),
  } });
  const event = new SessionPush(f.registry).enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
  const display = join(f.fc, 'tasks', String(task.id), 'session-push.json');
  for (const [content, operator] of [['{broken', 'display state unreadable'], [JSON.stringify({ error: 'RAW-DISPLAY-FAILURE-TEXT /secret/path' }), 'RAW-DISPLAY-FAILURE-TEXT']] as const) {
    writeFileSync(display, content);
    const result = hook(f, f.env, 'codex', 'codex-session');
    expect(result.status, result.stderr).toBe(0);
    const verdict = JSON.parse(result.stdout);
    expect(verdict).toMatchObject({ decision: 'block', reason: expect.stringContaining(event.eventId), systemMessage: expect.stringContaining(operator) });
    expect(verdict.reason).not.toMatch(/RAW-DISPLAY|secret|unreadable|JSON|position/u);
    expect(result.stderr).toBe('');
  }
});
