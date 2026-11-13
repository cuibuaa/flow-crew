import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { foldRunLifecycle } from '../src/run-lifecycle-fold.js';
import { hasLifecycleAuthority } from '../src/run-lifecycle-authority.js';
import { readRunSnapshot } from '../src/run-lifecycle.js';
import { runRecordPath } from '../src/run-layout.js';
import { fcGlobalDir, readRunState, readArchivedRunState, readOperationalRunState, setFcGlobalDir, withRunStateLock, importRunLifecycleForResume } from '../src/store.js';
import { readRunStateView } from '../src/run-state-view.js';
import { pollWatch, createWatchState } from '../src/watch.js';
import { startDashboard } from '../src/dashboard.js';

// Exercise real HTTP handlers with Fastify injection, without opening sockets.
vi.mock('fastify', async original => {
  const actual = await original<typeof import('fastify')>();
  return { ...actual, default: (...args: Parameters<typeof actual.default>) => {
    const app = actual.default(...args);
    app.listen = vi.fn(async () => '') as typeof app.listen;
    return app;
  } };
});

const repository = resolve(import.meta.dirname, '..');
const previous = fcGlobalDir();
const roots: string[] = [];
const children = new Set<ChildProcess>();
let cliChild: ChildProcess | undefined;
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGKILL'); await closed;
}
afterAll(async () => { if (cliChild) await kill(cliChild); });
afterEach(async () => {
  for (const child of children) {
    await kill(child);
  }
  children.clear();
  setFcGlobalDir(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const parent = join(repository, '.cache'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'lifecycle-crash-')); roots.push(root);
  for (const name of ['tmp', 'home', 'fc', 'project']) mkdirSync(join(root, name));
  return root;
}
function environment(root: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    FC_HOME: join(root, 'fc'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock'), FC_DAEMON_SOCKET: join(root, 'daemon.sock'),
    NO_COLOR: '1' };
}
interface Identity { runId: string; directory: string; project: string }
interface Checkpoint extends Identity { checkpoint: number; kind: string; path: string }
interface Fixture { root: string; identity: Identity }
interface Snapshot extends Fixture { checkpoint: Checkpoint }
interface Execution extends Fixture { checkpoints: Checkpoint[]; snapshots: Snapshot[]; status?: string }
interface CliResult { status: number; stdout: string; stderr: string }
let pendingCli: { resolve: (result: CliResult) => void; reject: (error: Error) => void } | undefined;
function cli(fixture: Fixture, args: string[]): Promise<CliResult> {
  if (!cliChild) {
    const root = temporaryRoot();
    cliChild = spawn(process.execPath, [join(repository, 'spec/test-support/lifecycle-cli.mjs')],
      { cwd: repository, env: environment(root), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', errors = '';
    cliChild.stderr!.on('data', chunk => { errors += chunk; });
    cliChild.stdout!.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const result = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const pending = pendingCli; pendingCli = undefined; pending!.resolve(result);
    });
    cliChild.once('error', error => pendingCli?.reject(error));
    cliChild.once('close', () => pendingCli?.reject(new Error(`CLI exited: ${errors}`)));
  }
  if (cliChild.exitCode !== null || cliChild.signalCode !== null) return Promise.reject(new Error('CLI is closed'));
  return new Promise((resolve, reject) => {
    pendingCli = { resolve, reject };
    cliChild!.stdin!.write(JSON.stringify({ root: fixture.root, project: fixture.identity.project, args }) + '\n');
  });
}
// Copy native bytes while the engine is blocked on its checkpoint ack. Keep
// record contents (including original project identity), temp files and locks.
// Each copy has a fresh FC_HOME so readers cannot reuse another gap's caches.
function snapshot(root: string, checkpoint: Checkpoint): Snapshot {
  const copy = temporaryRoot();
  cpSync(root, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  return { root: copy, identity: { ...checkpoint, directory: join(copy, checkpoint.directory.slice(root.length)) }, checkpoint };
}
// Compare every directory, symlink target and file byte, including engine temp
// files and the index, without normalizing paths, IDs, PIDs or record contents.
function diskBytes(root: string): unknown[] {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [name, stat.mode, stat.isSymbolicLink() ? readlinkSync(path)
      : stat.isDirectory() ? diskBytes(path) : readFileSync(path)];
  });
}
function text(path: string): string { try { return readFileSync(path, 'utf8'); } catch { return ''; } }
// Independent oracle deliberately does not call the production fold.
function oracle(bytes: string) {
  let status: string | undefined, sequence = 0, observedAt: string | undefined;
  for (const line of bytes.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row.lifecycleVersion === 1 && ['run_status_changed', 'run_status_imported'].includes(row.type)) {
        status = row.runStatus; sequence++; observedAt = row.timestamp;
      }
    } catch { /* incomplete/malformed row */ }
  }
  return status === undefined ? undefined : { version: 2, sequence, status, observedAt };
}
async function execute(mode: string, killKind?: string): Promise<Execution> {
  const root = temporaryRoot();
  const child = spawn(process.execPath, [join(repository, 'spec/test-support/lifecycle-engine.mjs'), root, mode],
    { cwd: repository, env: environment(root), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let buffer = '', errors = '', identity: Identity | undefined, final: { status: string } | undefined;
  const checkpoints: Checkpoint[] = [];
  const snapshots: Snapshot[] = [];
  let failure: unknown, killedAt: number | undefined;
  let fileFlushed = true, directoryFlushed = true;
  child.stderr!.on('data', chunk => { errors += chunk; });
  child.stdout!.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.ready) identity = message;
      if (message.done) final = message;
      if (!message.checkpoint) continue;
      checkpoints.push(message);
      try {
        const bytes = text(join(message.directory, 'events.jsonl'));
        if (message.path === join(message.directory, 'events.jsonl')) {
          if (message.kind === 'write') { fileFlushed = false; directoryFlushed = false; }
          if (message.kind === 'fsync-file') fileFlushed = true;
          if (message.kind === 'fsync-directory' && fileFlushed) directoryFlushed = true;
        }
        expect(foldRunLifecycle(bytes)).toEqual(oracle(bytes));
        // Every write of either lifecycle cache, including atomic staging,
        // must already have its new status recorded in the log.
        if (/^(run\.json|run_event_status\.json)/.test(message.path.split('/').at(-1))
            && existsSync(message.path) && ['write', 'rename'].includes(message.kind)) {
          const record = JSON.parse(text(message.path));
          if (record.lifecycleAuthority || record.version === 2 && record.sequence) {
            expect(record.status).toBe(oracle(bytes)?.status);
            expect(fileFlushed, 'lifecycle file must be flushed before cache bytes').toBe(true);
            expect(directoryFlushed, 'lifecycle directory must be flushed before cache bytes').toBe(true);
          }
        }
      } catch (error) { failure = error; child.kill('SIGKILL'); continue; }
      const shouldKill = message.kind === killKind;
      try {
        if (killKind === undefined || shouldKill) snapshots.push(snapshot(root, message));
      } catch (error) { failure = error; child.kill('SIGKILL'); continue; }
      if (shouldKill) { killedAt = message.checkpoint; child.kill('SIGKILL'); }
      else child.stdin!.write('x');
    }
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal]));
  });
  children.delete(child);
  if (failure) throw failure;
  expect(identity, errors).toBeDefined();
  if (killKind === undefined) expect(code, errors).toBe(0);
  else {
    expect(killedAt, `missing checkpoint kind: ${killKind}`).toBeDefined();
    expect(signal, errors).toBe('SIGKILL');
    expect(checkpoints.at(-1)?.checkpoint).toBe(killedAt);
  }
  return { root, identity: identity!, checkpoints, snapshots, status: final?.status };
}
function lifecycleBytes(directory: string) {
  return ['run.json', 'events.jsonl', 'run_event_status.json'].map(name => {
    const path = runRecordPath(directory, name);
    return [path, createHash('sha256').update(text(path)).digest('hex'), existsSync(path) ? String(statSync(path, { bigint: true }).mtimeNs) : undefined];
  });
}
async function checkReads(execution: Fixture, app: Awaited<ReturnType<typeof startDashboard>>): Promise<void> {
  const { root, identity: { directory, runId, project } } = execution;
  setFcGlobalDir(join(root, 'fc'));
  const before = lifecycleBytes(directory);
  const bytes = text(join(directory, 'events.jsonl'));
  const folded = oracle(bytes);
  expect(foldRunLifecycle(bytes)).toEqual(folded);
  let record: ReturnType<typeof readRunSnapshot> | undefined;
  try { record = readRunSnapshot(directory); } catch { /* no admission declaration yet */ }
  const declared = record && hasLifecycleAuthority(record);
  const expected = declared ? folded?.status : record?.status;
  if (expected !== undefined) {
    expect(readRunState(project, runId).status).toBe(expected);
    expect(readArchivedRunState(project, runId).state.status).toBe(expected);
    expect(readOperationalRunState(project, runId).status).toBe(expected);
    expect(readRunStateView(project, runId, { observedAt: '2035-02-03T04:06:00.000Z' }).run.status).toBe(expected);
    const status = await cli(execution, ['status', '--all']);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Status: ${expected}`);
    const listing = await cli(execution, ['list', '--limit', '5']);
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain(runId);
    expect(listing.stdout).toContain(String(expected));
    // A diagnostic deliberately mismatches a terminal artifact. Watch must
    // report the exact folded lifecycle, even for every terminal vocabulary.
    const other = expected === 'complete' ? 'failed' : 'complete';
    const watch = pollWatch(createWatchState(), { runsRoot: join(root, 'fc', 'runs'), candidateRunIds: () => [runId],
      nowMs: () => Date.parse('2035-02-03T04:06:00.000Z'), isProcessAlive: () => true,
      readText: path => path === join(directory, 'run.json')
        ? JSON.stringify({ ...record, terminalArtifact: 'diagnostic', terminalStates: { [other]: { paths: ['diagnostic'] } } })
        : path.endsWith('scheduler.pid') ? '1' : readFileSync(path, 'utf8'),
    });
    expect(watch.alerts.find(alert => alert.kind === 'terminal_status_mismatch')).toMatchObject({ lifecycleStatus: expected });
    {
      const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().status).toBe(expected);
      const listing = await app.inject({ method: 'GET', url: '/api/standalone-runs' });
      expect(listing.statusCode).toBe(200);
      const row = listing.json().find((row: { id: string }) => row.id === runId);
      // Index candidate discovery may lag; selected details still fold now.
      if (existsSync(join(directory, 'run.json'))) expect(row).toBeDefined();
      if (row) expect(row.outcome).toBe(declared ? expected : expected === 'complete' ? 'shipped' : expected);
    }
  } else {
    expect(() => readRunState(project, runId)).toThrow();
    expect((await cli(execution, ['status', '--all'])).stdout).not.toMatch(/Status: (?:running|parked|complete)/);
  }
  expect(lifecycleBytes(directory)).toEqual(before);
  // Opening for writing, even with an early return, repairs BOTH caches and
  // never uses either old cache to manufacture another lifecycle event.
  withRunStateLock(directory, () => {});
  const afterWriter = text(join(directory, 'events.jsonl'));
  expect(afterWriter.startsWith(bytes)).toBe(true);
  expect(foldRunLifecycle(afterWriter)).toEqual(folded);
  // A short batch may lack its non-status wrap-up notice. Writers can complete
  // that notice from the logged decision, without creating another decision.
  const appended = afterWriter.slice(bytes.length).trim();
  if (appended) expect(appended.split('\n').map(row => JSON.parse(row).type)).toEqual(['operator_wrap_up_required']);
  if (declared && folded) {
    const cached = JSON.parse(text(join(directory, 'run.json')));
    expect(cached.status).toBe(folded.status);
    expect(cached.lifecycleCursor).toEqual(folded);
    expect(JSON.parse(text(runRecordPath(directory, 'run_event_status.json')))).toEqual(folded);
  }
}

// main releases unfinished validation to the next model without a lifecycle
// transition. Retain that former parking case as a no-transition control.
const cases = [
  ['initialize', 'running'],
  ...['complete', 'failed', 'shipped', 'ceiling_hit', 'escalated', 'reality_gate_failed', 'cancelled', 'incomplete'].map(status => [`terminal:${status}`, status]),
  ['pause', 'parked'], ['park', 'parked'], ['quota', 'parked'], ['validation-unfinished', 'running'], ['resume', 'running'],
  ['cancel', 'cancelled'], ['cancel-active', 'cancelled'], ['recovery-active', 'parked'], ['recovery-park', 'parked'], ['recovery-block', 'failed'], ['import-resume', 'running'], ['terminal-short', 'failed'], ['import-short', 'running'],
];
async function dashboard(fixture: Fixture) {
  setFcGlobalDir(join(fixture.root, 'fc'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { return await startDashboard(fixture.identity.project, 0, { distDir: join(fixture.root, 'empty-dist') }); }
  finally { output.mockRestore(); }
}
describe('lifecycle crash then replay', () => {
  it.each(cases)('covers EVERY consecutive write gap for %s', async (mode, status) => {
    const baseline = await execute(mode);
    expect(baseline.status).toBe(status);
    expect(baseline.checkpoints.length).toBeGreaterThan(1);
    expect(baseline.snapshots).toHaveLength(baseline.checkpoints.length);
    const app = await dashboard(baseline);
    try {
      // One engine execution captures every boundary except the final one:
      // each consecutive pair still gets an independent, disposable disk image
      // and all read assertions. No writer resumes inside any checked image.
      for (const crashed of baseline.snapshots.slice(0, -1)) {
        await checkReads(crashed, app);
        if (mode.startsWith('import-')) {
          setFcGlobalDir(join(crashed.root, 'fc'));
          importRunLifecycleForResume(crashed.identity.project, crashed.identity.runId);
          importRunLifecycleForResume(crashed.identity.project, crashed.identity.runId);
          const events = text(join(crashed.identity.directory, 'events.jsonl')).trim().split('\n').map(row => JSON.parse(row));
          expect(events.filter(row => row.type === 'run_status_imported')).toHaveLength(1);
          expect(events.find(row => row.type === 'run_status_imported')).toMatchObject({ snapshotSource: 'run.json' });
        }
        rmSync(crashed.root, { recursive: true, force: true });
      }
    } finally { await app.close(); }
    process.stdout.write(`LIFECYCLE_GAPS ${mode} ${baseline.checkpoints.length - 1}\n`);
  });

  it.each([
    ['initialize', 'open'], ['terminal-short', 'write'], ['import-short', 'fsync-file'],
    ['recovery-active', 'rename'], ['park', 'fsync-directory'],
  ])('cross-checks snapshot bytes against SIGKILL for %s at %s', async (mode, kind) => {
    const killed = await execute(mode, kind);
    expect(killed.snapshots).toHaveLength(1);
    expect(diskBytes(killed.snapshots[0].root)).toEqual(diskBytes(killed.root));
    const app = await dashboard(killed);
    try { await checkReads(killed, app); } finally { await app.close(); }
  });
});

it('keeps identical event bytes read-only while legacy snapshot displays differ on every surface', async () => {
  const execution = await execute('terminal:failed');
  const { directory } = execution.identity;
  const record = JSON.parse(text(join(directory, 'run.json')));
  delete record.lifecycleAuthority; delete record.lifecycleCursor;
  const log = text(join(directory, 'events.jsonl'));
  const app = await dashboard(execution);
  try {
    for (const status of ['parked', 'complete']) {
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...record, status }));
      await checkReads(execution, app);
      expect(text(join(directory, 'events.jsonl'))).toBe(log);
    }
  } finally { await app.close(); }
});
