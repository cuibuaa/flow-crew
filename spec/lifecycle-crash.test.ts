import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const loader = import.meta.resolve('tsx');
const previous = fcGlobalDir();
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL'); await closed;
    }
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
interface Execution { root: string; identity: Identity; checkpoints: Checkpoint[]; signal: string | null; status?: string }
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
async function execute(mode: string, killAt?: number): Promise<Execution> {
  const root = temporaryRoot();
  const child = spawn(process.execPath, ['--import', loader, join(repository, 'spec/test-support/lifecycle-engine.ts'), root, mode],
    { cwd: repository, env: environment(root), stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 });
  children.add(child);
  let buffer = '', errors = '', identity: Identity | undefined, final: { status: string } | undefined;
  const checkpoints: Checkpoint[] = [];
  let failure: unknown;
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
      if (message.checkpoint === killAt) child.kill('SIGKILL');
      else child.stdin!.write('x');
    }
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal]));
  });
  children.delete(child);
  if (failure) throw failure;
  expect(identity, errors).toBeDefined();
  if (killAt === undefined) expect(code, errors).toBe(0);
  else { expect(signal, errors).toBe('SIGKILL'); expect(checkpoints.at(-1)?.checkpoint).toBe(killAt); }
  return { root, identity: identity!, checkpoints, signal, status: final?.status };
}
function lifecycleBytes(directory: string) {
  return ['run.json', 'events.jsonl', 'run_event_status.json'].map(name => {
    const path = runRecordPath(directory, name);
    return [path, createHash('sha256').update(text(path)).digest('hex'), existsSync(path) ? String(statSync(path, { bigint: true }).mtimeNs) : undefined];
  });
}
async function checkReads(execution: Execution): Promise<void> {
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
  const cli = (command: string, args: string[]) => spawnSync(process.execPath,
    ['--import', loader, join(repository, 'src/cli.ts'), command, ...args],
    { cwd: project, env: environment(root), encoding: 'utf8', timeout: 90_000 });
  if (expected !== undefined) {
    expect(readRunState(project, runId).status).toBe(expected);
    expect(readArchivedRunState(project, runId).state.status).toBe(expected);
    expect(readOperationalRunState(project, runId).status).toBe(expected);
    expect(readRunStateView(project, runId, { observedAt: '2035-02-03T04:06:00.000Z' }).run.status).toBe(expected);
    const status = cli('status', ['--all']);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Status: ${expected}`);
    const listing = cli('list', ['--limit', '5']);
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
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = await startDashboard(project, 0, { distDir: join(root, 'empty-dist') });
    output.mockRestore();
    try {
      const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().status).toBe(expected);
      const listing = await app.inject({ method: 'GET', url: '/api/standalone-runs' });
      expect(listing.statusCode).toBe(200);
      const row = listing.json().find((row: { id: string }) => row.id === runId);
      // Index candidate discovery may lag; selected details still fold now.
      if (existsSync(join(directory, 'run.json'))) expect(row).toBeDefined();
      if (row) expect(row.outcome).toBe(declared ? expected : expected === 'complete' ? 'shipped' : expected);
    } finally { await app.close(); }
  } else {
    expect(() => readRunState(project, runId)).toThrow();
    expect(cli('status', ['--all']).stdout).not.toMatch(/Status: (?:running|parked|complete)/);
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

const cases = [
  ['initialize', 'running'],
  ...['complete', 'failed', 'shipped', 'ceiling_hit', 'escalated', 'reality_gate_failed', 'cancelled', 'incomplete'].map(status => [`terminal:${status}`, status]),
  ['pause', 'parked'], ['park', 'parked'], ['quota', 'parked'], ['validation-park', 'parked'], ['resume', 'running'],
  ['cancel', 'cancelled'], ['cancel-active', 'cancelled'], ['recovery-active', 'parked'], ['recovery-park', 'parked'], ['recovery-block', 'failed'], ['import-resume', 'running'], ['terminal-short', 'failed'], ['import-short', 'running'],
];
describe('lifecycle crash then replay', () => {
  it.each(cases)('covers EVERY consecutive write gap for %s', { timeout: 900_000 }, async (mode, status) => {
    const baseline = await execute(mode);
    expect(baseline.status).toBe(status);
    expect(baseline.checkpoints.length).toBeGreaterThan(1);
    // Kill at every observed boundary except the final one: every consecutive
    // pair has its own owned engine process and all required read assertions.
    for (const checkpoint of baseline.checkpoints.slice(0, -1)) {
      const crashed = await execute(mode, checkpoint.checkpoint);
      expect(crashed.checkpoints.map(row => [row.kind, row.path.replace(crashed.identity.directory, '').replace(/\.tmp\.[a-f0-9]+$/, '.tmp')]))
        .toEqual(baseline.checkpoints.slice(0, checkpoint.checkpoint).map(row => [row.kind, row.path.replace(baseline.identity.directory, '').replace(/\.tmp\.[a-f0-9]+$/, '.tmp')]));
      await checkReads(crashed);
      if (mode.startsWith('import-')) {
        setFcGlobalDir(join(crashed.root, 'fc'));
        importRunLifecycleForResume(crashed.identity.project, crashed.identity.runId);
        importRunLifecycleForResume(crashed.identity.project, crashed.identity.runId);
        const events = text(join(crashed.identity.directory, 'events.jsonl')).trim().split('\n').map(row => JSON.parse(row));
        expect(events.filter(row => row.type === 'run_status_imported')).toHaveLength(1);
        expect(events.find(row => row.type === 'run_status_imported')).toMatchObject({ snapshotSource: 'run.json' });
      }
      // Retire each completed fixture promptly; no owned process survives.
      rmSync(crashed.root, { recursive: true, force: true });
    }
    process.stdout.write(`LIFECYCLE_GAPS ${mode} ${baseline.checkpoints.length - 1}\n`);
  });
});

it('keeps identical event bytes read-only while legacy snapshot displays differ on every surface', { timeout: 120_000 }, async () => {
  const execution = await execute('terminal:failed');
  const { directory } = execution.identity;
  const record = JSON.parse(text(join(directory, 'run.json')));
  delete record.lifecycleAuthority; delete record.lifecycleCursor;
  const log = text(join(directory, 'events.jsonl'));
  for (const status of ['parked', 'complete']) {
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...record, status }));
    await checkReads(execution);
    expect(text(join(directory, 'events.jsonl'))).toBe(log);
  }
});
