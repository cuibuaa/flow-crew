import { writeAdmittedRealityChecks } from './test-support/admitted-reality-checks.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as net from 'node:net';
import * as owner from '../src/adapters/base.js';
import { runProjectCommand } from '../src/project-validation.js';
import { startCommandRecorder } from '../src/recorded-command.js';
import { TaskRegistry } from '../src/task-registry.js';
import { cmdAuditReality } from '../src/reality-gate/audit-reality.js';
import { runAllChecks, readRealityGateReport } from '../src/reality-gate/index.js';
import { runPostTerminateHook } from '../src/scheduler/sched_policy/terminal.js';
import { concludeRun } from '../src/scheduler/sched_policy/run-completion.js';
import { createRun } from './test-support/create-run.js';
import { readRunState } from '../src/store.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { runRecordPath } from '../src/run-layout.js';

vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createServer: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'clock-')); roots.push(path); return path; }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function owned(stopCode: number | null = null) {
  const ready = deferred();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const stop = vi.fn(async () => { child.emit('close', stopCode, 'SIGTERM'); });
  vi.spyOn(owner, 'spawnOwnedCommand').mockImplementation(() => { ready.resolve(); return { child: child as unknown as owner.ChildProcess, stop, publication: Promise.resolve(), writeGrantFailure: () => undefined, writeGrantApplied: () => undefined }; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { child, stop, ready: ready.promise };
}
const command = { role: 'test' as const, command: 'fixture', args: [], display: 'finite work' };

describe('owned evidence waits for events unless its author declares an allowance', () => {
  it('an undeclared project command waits beyond the former engine default', async () => {
    const f = owned(); let finished = false;
    const pending = runProjectCommand({ ...command, cwd: root() }).then(value => { finished = true; return value; });
    await f.ready; await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.stop).not.toHaveBeenCalled(); expect(finished).toBe(false);
    f.child.stdout.write('finite result'); f.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ exitCode: 0, stdout: 'finite result' });
  });

  it.each([undefined, 2])('reality script timeout_seconds=%s retains the declared distinction', async seconds => {
    const f = owned(0), projectDir = root(), taskDir = root();
    const pending = runAllChecks([{ reads: [], name: 'finite check', type: 'exec-script-exit-zero',
      params: { script: 'fixture', ...(seconds === undefined ? {} : { timeout_seconds: seconds }) } }], { projectDir, taskDir });
    await f.ready;
    f.child.stdout.write('already completed A\n');
    await vi.advanceTimersByTimeAsync(seconds === undefined ? 3_600_000 : seconds * 1000);
    if (seconds === undefined) { expect(f.stop).not.toHaveBeenCalled(); f.child.emit('close', 0, null); }
    const report = await pending;
    expect(report.results[0]).toMatchObject(seconds === undefined ? { pass: true } : { pass: false, unfinished: true });
    const path = join(taskDir, 'report.json'); writeFileSync(path, JSON.stringify(report));
    expect(readRealityGateReport(path)).toEqual(report);
    if (seconds !== undefined) {
      const legacy = structuredClone(report); delete legacy.results[0].unfinished;
      writeFileSync(path, JSON.stringify(legacy));
      expect(readRealityGateReport(path).results[0].unfinished).toBe(true);
    }
    expect(report.results[0].evidence).toMatchObject({ stdout: 'already completed A\n', exit: { timedOut: seconds !== undefined } });
  });

  it('a declared reality allowance parks the candidate with resumable facts instead of failing its product', async () => {
    const f = owned(), projectDir = root();
    const { runId, runDirPath } = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);
    writeAdmittedRealityChecks(runRecordPath(runDirPath, 'reality_checks.md'), '## Reality checks\n```yaml\nchecks:\n  - name: check\n    type: exec-script-exit-zero\n    reads: []\n    params: {script: fixture, timeout_seconds: 2}\n```\n');
    const state = readRunState(projectDir, runId);
    const pending = concludeRun(state, { status: 'complete', reasonCode: 'workflow_complete' });
    await f.ready; f.child.stdout.write('partial facts\n'); await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ status: 'parked', recovery: { kind: 'resumable', cause: 'work_unfinished' },
      realityGate: { results: [{ unfinished: true, exit: { timedOut: true } }] } });
    expect(readRunState(projectDir, runId).status).toBe('parked');
  });

  it('audit displays an exhausted reality command as unfinished without a fabrication verdict', async () => {
    const f = owned(0), projectDir = root(), brief = join(projectDir, 'brief.md');
    const text = '---\nreality_checks:\n  - name: check\n    type: exec-script-exit-zero\n    reads: []\n    params: {script: fixture, timeout_seconds: 2}\n---\n';
    writeFileSync(brief, text);
    const registry = new TaskRegistry(), task = registry.create({ projectDir, brief_path: brief, status: 'complete',
      brief_admission: createBriefAdmission(inspectBrief(text), { kind: 'not_required' }) });
    let output = '';
    const pending = cmdAuditReality(['--task', String(task.id)], { stdout: { write: (text: string) => { output += text; } } as unknown as NodeJS.WriteStream });
    await f.ready; await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(0); expect(output).toContain('check:UNFINISHED');
    expect(output).not.toContain('FAKE'); expect(output).not.toContain('FABRICATED');
  });

  it.each([undefined, 2])('terminal hook timeoutSeconds=%s records unfinished only at a declared stop', async seconds => {
    const f = owned(), projectDir = root();
    const { runId, runDirPath: runDir } = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);
    const pending = runPostTerminateHook({ command: 'fixture', ...(seconds === undefined ? {} : { timeoutSeconds: seconds }) },
      { projectDir, runDir, runId, terminalStatus: 'complete', verdictPath: join(runDir, 'verdict.json') });
    await f.ready; f.child.stdout.write('hook receipt\n');
    await vi.advanceTimersByTimeAsync(seconds === undefined ? 3_600_000 : seconds * 1000);
    if (seconds === undefined) { expect(f.stop).not.toHaveBeenCalled(); f.child.emit('close', 0, null); }
    await pending;
    const log = readFileSync(runRecordPath(runDir, 'post_terminate_hook.log'), 'utf8');
    expect(log).toContain('hook receipt\n'); expect(log).toContain(`unfinished: ${seconds !== undefined}`);
    expect(log).toContain(`timeout_seconds: ${seconds ?? 'undeclared'}`);
  });

  it('recorder client and server retain a pending receipt beyond both former inactivity clocks', async () => {
    const clientSocket = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn(), write: vi.fn() });
    const sent = deferred<string>();
    const serverSocket = Object.assign(new EventEmitter(), { end: vi.fn((value: string) => sent.resolve(value)), destroy: vi.fn(), setTimeout: vi.fn(), setEncoding: vi.fn() });
    let accept!: (socket: typeof serverSocket) => void;
    vi.mocked(net.createServer).mockImplementation((_options, listener) => {
      accept = listener as unknown as typeof accept;
      const server = Object.assign(new EventEmitter(), {
        listen: (_path: string, ready: () => void) => ready(), close: (done: () => void) => done(),
      });
      return server as unknown as net.Server;
    });
    const release = deferred<object>(), entered = deferred(), execute = vi.fn(async () => { entered.resolve(); return release.promise; });
    const recorder = await startCommandRecorder(root(), execute);
    try {
      const paths = [...recorder.command.matchAll(/'([^']*)'/g)].map(match => match[1]);
      runInNewContext(readFileSync(paths[1], 'utf8'), {
        require: () => ({ connect: () => clientSocket }),
        process: { argv: ['node', paths[1], paths[2], '{}'], stdout: { write: vi.fn() } }, console,
      });
      accept(serverSocket);
      serverSocket.emit('data', JSON.stringify({ command: 'fixture', cwd: root(), shell: '/bin/sh' })); serverSocket.emit('end');
      await entered.promise;
      // Intercepting both socket APIs exercises their inactivity policy without wall time.
      expect(clientSocket.setTimeout).not.toHaveBeenCalled(); expect(serverSocket.setTimeout).not.toHaveBeenCalled();
      expect(serverSocket.end).not.toHaveBeenCalled();
      release.resolve({ exitCode: 0, stdout: 'untouched receipt' });
      expect(await sent.promise).toBe('{"exitCode":0,"stdout":"untouched receipt"}\n');
    } finally { release.resolve({}); await recorder.close(); }
  });
});
