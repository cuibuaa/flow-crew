import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { GitStandIn, success } from './test-support/git-stand-in.js';

const fixture = vi.hoisted(() => ({
  git: undefined as unknown as GitStandIn,
  child: undefined as ChildProcess | undefined,
  onSpawn: undefined as (() => void) | undefined,
  watch: undefined as ((event: string, name: string) => void) | undefined,
}));
vi.hoisted(() => vi.resetModules());
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual,
    spawnSync: (file: string, args: string[], options: object) => file === 'git'
      ? fixture.git.sync(args, options) : actual.spawnSync(file, args, options),
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      fixture.onSpawn?.();
      return fixture.child ?? actual.spawn(...args);
    },
  };
});
vi.mock('node:fs', async original => {
  const { stageFileSystem } = await import('./test-support/stage-filesystem.js');
  return { ...stageFileSystem(await original<typeof import('node:fs')>()),
    watch: (_path: string, _options: object, callback: typeof fixture.watch) => {
      fixture.watch = callback;
      return Object.assign(new EventEmitter(), { close() {}, ref() {} });
    },
  };
});

import { GitNotAnswered } from '../src/git-facts.js';
import * as gitFacts from '../src/git-facts.js';
import { fcGlobalDir, initializeReservedRun, readRunState, reserveRun, runsRoot, setFcGlobalDir, updateRunState } from '../src/store.js';
import { spawnOwnedCommand, withRunProcessOwnership } from '../src/adapters/base.js';
import { Orchestrator } from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { closeRollbackBaseline, ensureRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { captureProjectTree } from '../src/evidence-ledger.js';
import { startCommandRecorder } from '../src/recorded-command.js';
import { retireRunScratch } from '../src/invocation-scratch.js';
import { runStage } from './test-support/stage-deadline.js';
import { createRun } from './test-support/create-run.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { readStageStatus } from '../src/store.js';
import * as validation from '../src/project-validation.js';
import { engineValidation } from '../src/engine-validation.js';
import { createTerminalEvaluator, runPostTerminateHook } from '../src/scheduler/sched_policy/terminal.js';
import { runRecordPath } from '../src/run-layout.js';

let root: string, project: string, previous: string, previousSocket: string | undefined;
const oid = 'a'.repeat(40);
beforeEach(() => {
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'git-ownership-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  previousSocket = process.env.FLOWCREW_DAEMON_SOCKET;
  process.env.FLOWCREW_DAEMON_SOCKET = join(root, 'daemon.sock');
  fixture.child = undefined; fixture.onSpawn = undefined; fixture.watch = undefined; fixture.git = new GitStandIn();
  fixture.git.answer = args => args[0] === 'rev-parse' ? success(args.includes('--show-toplevel') ? project : oid)
    : args[0] === 'config' ? { status: 1 } : success();
});
afterEach(() => {
  closeRollbackBaseline(project); setFcGlobalDir(previous);
  if (previousSocket === undefined) delete process.env.FLOWCREW_DAEMON_SOCKET;
  else process.env.FLOWCREW_DAEMON_SOCKET = previousSocket;
  vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});
const terminate = () => { fixture.git.answer = () => ({ status: null, signal: 'SIGTERM' }); };
function commandChild() {
  const gate = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, gate],
    kill: vi.fn(() => true) }) as unknown as ChildProcess;
  fixture.child = child;
  return { child, gate };
}
function priorRun() {
  const directory = join(runsRoot(), 'prior');
  mkdirSync(join(directory, 'engine'), { recursive: true }); mkdirSync(join(directory, 'work'));
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ storageLayout: 2, runId: 'prior', projectDir: project,
    workflowName: 'fixture', status: 'running', startedAt: '2000-01-01T00:00:00Z', baseCommit: oid, stages: {} }));
  const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
  const task = registry.create({ kind: 'quick', projectDir: project, name: 'Fixture', status: 'running', run_id: 'prior', started_at: '2000-01-01T00:00:00Z' });
  return { directory, registry, task };
}

it('recovery propagates a terminated inventory without a continuation refusal or task settlement', async () => {
  const { directory, registry, task } = priorRun();
  const before = readFileSync(join(directory, 'run.json'));
  const orchestrator = new Orchestrator({ registry,
    systemd: { isActive: async () => ({ kind: 'terminal', exitCode: 0 }) } as never,
    reconcileOrphanRuns: () => {}, isProjectBusy: () => null });
  terminate();
  try {
    await expect(orchestrator.tickOnce()).rejects.toBeInstanceOf(GitNotAnswered);
    expect(registry.get(task.id)).toEqual(task);
    expect(readFileSync(join(directory, 'run.json'))).toEqual(before);
    expect(readRunState(project, 'prior').continuationFailure).toBeUndefined();
  } finally { await orchestrator.stop(); }
});

it('cancellation retires owned work but never publishes successful settlement for terminated inventory', async () => {
  const { directory, registry, task } = priorRun();
  const before = readFileSync(join(directory, 'run.json'));
  registry.update(task.id, { systemd_unit: 'fixture.service' });
  const original = registry.get(task.id);
  let stopped = false;
  const stopUnit = vi.fn(async () => { stopped = true; });
  const control = new RunCancellationCoordinator({ registry, runsDir: runsRoot(),
    units: { isActive: async () => stopped ? { kind: 'absent' } : { kind: 'active' }, stopUnit } as never,
    clockMs: () => 0, delay: async () => {}, signalGraceMs: 0,
    isSchedulerPidAlive: () => false, canSignalScheduler: () => false });
  terminate();
  await expect(control.cancelTask(task.id)).rejects.toBeInstanceOf(GitNotAnswered);
  expect(registry.get(task.id)).toEqual(original);
  expect(stopUnit).toHaveBeenCalledWith('fixture.service');
  expect(readFileSync(join(directory, 'run.json'))).toEqual(before);
  // A failed fact is not retried at the second settlement boundary.
  expect(fixture.git.calls).toHaveLength(1);
});

it('directory watcher events nominate physical descendants without acquiring Git outside the operation', async () => {
  fixture.git.answer = () => ({ status: 128 });
  const { baseline } = ensureRollbackBaseline(project);
  expect(fixture.watch).toBeTypeOf('function');
  mkdirSync(join(project, 'new-directory', 'nested'), { recursive: true });
  writeFileSync(join(project, 'new-directory', 'nested', 'file'), 'new bytes');
  const calls = fixture.git.calls.length;
  terminate();
  expect(() => fixture.watch!('rename', 'new-directory')).not.toThrow();
  expect(fixture.git.calls).toHaveLength(calls);
  expect(baseline.journal.has('new-directory/nested/file')).toBe(true);
});

it('process identity publication joins the owning operation and retires its child before rejecting the original non-answer', async () => {
  const { runId } = reserveRun(project);
  initializeReservedRun(project, runId, 'fixture', '', []);
  updateRunState(project, runId, state => { state.engineCheckpoint = { pid: process.pid, processes: [] } as never; });
  const { child, gate } = commandChild();
  let returned = false;
  const operation = withRunProcessOwnership(project, runId, async () => {
    const owned = spawnOwnedCommand('fixture-command', [], { cwd: project, priority: 19 });
    updateRunState(project, runId, state => { state.status = 'complete'; });
    terminate();
    return owned;
  }).finally(() => { returned = true; });
  // Install the rejection observer before delivering any callback, so this
  // tests an owned rejection and cannot pass via an unhandled exception.
  const outcome = operation.then(() => undefined, error => error);
  await Promise.resolve();
  expect(returned).toBe(false);
  gate.emit('data', Buffer.from(`${process.pid}\n`));
  expect(gate.writableEnded).toBe(true);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  await Promise.resolve(); expect(returned).toBe(false);
  child.emit('close', null, 'SIGTERM');
  const error = await outcome;
  expect(error).toBeInstanceOf(GitNotAnswered);
  expect(returned).toBe(true);
});

it.each([
  ['initial', 'direct'], ['initial', 'default'], ['callback', 'direct'], ['callback', 'default'],
] as const)('validation propagates %s publication failure through the %s runner before evidence or another command', async (boundary, runner) => {
  vi.useFakeTimers();
  const { runId } = reserveRun(project);
  initializeReservedRun(project, runId, 'fixture', '', []);
  updateRunState(project, runId, state => { state.engineCheckpoint = { pid: process.pid, processes: [] } as never; });
  const { child, gate } = commandChild();
  let spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  let spawnCount = 0;
  const onSpawn = vi.fn(() => {
    if (++spawnCount > 1) throw new Error('Another command after the missing fact');
    spawned();
  });
  fixture.onSpawn = onSpawn;
  const hash = 'c'.repeat(64);
  const command = { command: process.execPath, args: ['-e', 'process.stdout.write("fixture")'], display: 'Fixture' };
  let commandFailure: unknown;
  const operation = withRunProcessOwnership(project, runId, async () => {
    if (boundary === 'initial') {
      updateRunState(project, runId, state => { state.status = 'complete'; });
      terminate();
    }
    return engineValidation({ projectDir: project, treeHash: hash, treeAfter: () => hash,
      commands: [{ ...command, role: 'test' }, { ...command, role: 'lint' }],
      limits: { timeoutMs: 10000, attempts: 1 }, run: { projectDir: project, runId },
      ...(runner === 'direct' ? { runCommand: validation.runProjectCommand } : {}),
    }).catch(error => { commandFailure = error; throw error; });
  });
  const outcome = operation.then(() => undefined, error => error);
  await started;
  if (boundary === 'callback') {
    updateRunState(project, runId, state => { state.status = 'complete'; });
    terminate();
    gate.emit('data', Buffer.from(`${process.pid}\n`));
    expect(gate.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  }
  child.emit('close', null, 'SIGTERM');
  const error = await outcome;
  expect(error).toBeInstanceOf(GitNotAnswered);
  // The enclosing owner is too late: the command/batch itself must reject.
  expect(commandFailure).toBe(error);
  expect(onSpawn).toHaveBeenCalledTimes(1);
  const record = JSON.parse(readFileSync(join(fcGlobalDir(), 'validation', `${hash}.json`), 'utf8'));
  expect(record.executions.flatMap((execution: { commands: unknown[] }) => execution.commands)).toEqual([]);
  expect(record.resourceState).toBe('unfinished');
  expect(record.pass).toBe(false);
});

it.each([
  ['initial', 'hook'], ['initial', 'evaluator'], ['callback', 'hook'], ['callback', 'evaluator'],
] as const)('terminal %s publication rejects the awaited %s without hook evidence or a substituted decision', async (boundary, consumer) => {
  vi.useFakeTimers();
  const { runId, runDirPath } = reserveRun(project);
  initializeReservedRun(project, runId, 'fixture', '', ['work']);
  const hook = { command: 'fixture-command', args: [] };
  updateRunState(project, runId, state => {
    state.stages.work.status = 'complete';
    state.terminalStates = { complete: { paths: ['done.md'], postTerminateHook: hook } };
    state.terminalArtifactBaselines = {};
    state.engineCheckpoint = { pid: process.pid, processes: [] } as never;
    if (consumer === 'hook') state.status = 'complete';
  });
  writeFileSync(join(project, 'done.md'), 'Completed outcome');
  const { child, gate } = commandChild();
  let spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  fixture.onSpawn = () => {
    if (boundary === 'initial') terminate();
    spawned();
  };
  let factFailure: unknown;
  const sync = gitFacts.gitSync;
  vi.spyOn(gitFacts, 'gitSync').mockImplementation((...args: Parameters<typeof sync>) => {
    try { return sync(...args); }
    catch (error) { factFailure = error; throw error; }
  });
  let completed = false, operationFailure: unknown;
  const operation = withRunProcessOwnership(project, runId, async () => {
    try {
      if (consumer === 'hook') await runPostTerminateHook(hook, {
        projectDir: project, runDir: runDirPath, runId, terminalStatus: 'complete', verdictPath: join(project, 'done.md'),
      });
      else await createTerminalEvaluator({ writeCampaignEntry() {}, concludeRepeatedBlockage: () => null })
        .tryTerminateOnTerminalState(readRunState(project, runId), {
          projectDir: project, runDirPath, runId, iteration: 1, stages: [{ id: 'work', role: 'coder', depends_on: [] }],
        });
      completed = true;
    } catch (error) { operationFailure = error; throw error; }
  });
  const outcome = operation.then(() => undefined, error => error);
  await started;
  if (boundary === 'callback') {
    terminate();
    gate.emit('data', Buffer.from(`${process.pid}\n`));
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(operationFailure).toBeUndefined();
  }
  expect(gate.writableEnded).toBe(true);
  expect(child.kill).toHaveBeenCalledWith(boundary === 'initial' ? 'SIGKILL' : 'SIGTERM');
  expect(existsSync(runRecordPath(runDirPath, 'post_terminate_hook.log'))).toBe(false);
  child.emit('close', null, 'SIGTERM');
  const error = await outcome;
  expect(error).toBeInstanceOf(GitNotAnswered);
  expect(error).toBe(factFailure);
  // A late rejection by withRunProcessOwnership would conceal a hook/evaluator
  // that already returned normally or published replacement command evidence.
  expect(operationFailure).toBe(error);
  expect(completed).toBe(false);
  expect(readRunState(project, runId).status).toBe('complete');
  expect(existsSync(runRecordPath(runDirPath, 'post_terminate_hook.log'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['success', 'nonzero', 'signal', 'error'] as const)('terminal hook retains best-effort %s evidence after answered publication', async completion => {
  vi.useFakeTimers();
  const { runId, runDirPath } = reserveRun(project);
  initializeReservedRun(project, runId, 'fixture', '', []);
  updateRunState(project, runId, state => {
    state.status = 'complete'; state.engineCheckpoint = { pid: process.pid, processes: [] } as never;
  });
  const { child, gate } = commandChild();
  let spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  fixture.onSpawn = spawned;
  const operation = withRunProcessOwnership(project, runId, () => runPostTerminateHook({ command: 'fixture-command' }, {
    projectDir: project, runDir: runDirPath, runId, terminalStatus: 'complete', verdictPath: join(project, 'done.md'),
  }));
  await started;
  gate.emit('data', Buffer.from(`${process.pid}\n`));
  child.stdout!.emit('data', Buffer.from('hook output'));
  if (completion === 'error') child.emit('error', new Error('fixture launch error'));
  child.emit('close', completion === 'success' ? 0 : completion === 'nonzero' ? 1 : null, completion === 'signal' ? 'SIGTERM' : null);
  await operation;
  const text = readFileSync(runRecordPath(runDirPath, 'post_terminate_hook.log'), 'utf8');
  expect(text).toContain('hook output');
  expect(text).toContain(completion === 'error' ? 'spawn error: Error: fixture launch error'
    : completion === 'signal' ? 'code: null\nsignal: SIGTERM' : `code: ${completion === 'success' ? 0 : 1}\nsignal: null`);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['before', 'after'] as const)('recorder preserves terminated %s-command inventory through close and a typed failing client response', async boundary => {
  const directory = join(root, 'recording'); mkdirSync(directory);
  let ran = false;
  const recorder = await startCommandRecorder(directory, async () => {
    if (boundary === 'before') terminate();
    captureProjectTree(project);
    ran = true;
    if (boundary === 'after') terminate();
    return captureProjectTree(project);
  });
  // Use the actual recorder client, without a backend or a real command.
  const child = spawn(process.execPath, ['-e', 'require("node:child_process").execFileSync("/bin/sh", ["-c", process.argv[1]], { stdio: "inherit" });',
    `${recorder.command} '${JSON.stringify({ command: 'true', cwd: project, shell: '/bin/sh' })}'`],
    { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout!.on('data', chunk => { stdout += chunk; });
  let closed = false;
  try {
    const [code] = await once(child, 'close');
    expect(JSON.parse(stdout)).toMatchObject({ code: 'GIT_NOT_ANSWERED' });
    expect(code).toBe(1); expect(ran).toBe(boundary === 'after');
    await expect(recorder.close()).rejects.toBeInstanceOf(GitNotAnswered);
    closed = true;
  } finally {
    if (!closed) await recorder.close().catch(() => {});
    retireRunScratch(directory);
  }
});

it.each(['before', 'after'] as const)('the gate invocation fails with terminated %s-command inventory without a command receipt or verdict', async boundary => {
  const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  const command = vi.spyOn(validation, 'runProjectCommand').mockImplementation(async () => {
    terminate();
    return { exitCode: 0, stdout: 'command answered' };
  });
  const role = { name: 'fixture', description: '', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'Fixture' };
  let clientExit: number | null | undefined;
  const operation = runStage({ async run(prompt) {
    const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
    if (boundary === 'before') terminate();
    const request = JSON.stringify({ command: 'true', cwd: project, shell: '/bin/sh' }).replaceAll("'", "'\\''");
    const child = spawn(process.execPath, ['-e', 'require("node:child_process").execFileSync("/bin/sh", ["-c", process.argv[1]], { stdio: "inherit" });', `${client} '${request}'`],
      { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.resume(); child.stderr!.resume();
    [clientExit] = await once(child, 'close');
    return { output: JSON.stringify({ pass: true, reason: 'Fixture' }), exitCode: 0, duration_ms: 0 };
  } }, { ...created, projectDir: project, runDir: created.runDirPath, stageId: 'work', role, dependsOn: [],
    promptTemplate: 'Review the work.', timeout_ms: 10_000, retries: 0, isGate: true,
    artifactContract: { version: 1, produces: [], reads: [] } });
  await expect(operation).rejects.toBeInstanceOf(GitNotAnswered);
  expect(clientExit).toBe(1);
  expect(command).toHaveBeenCalledTimes(boundary === 'before' ? 0 : 1);
  expect(readEvidence(created.runDirPath).filter(entry => entry.kind === 'attempt' || entry.kind === 'decision'
    || entry.kind === 'command' && entry.owner === 'code')).toEqual([]);
  expect(readStageStatus(project, created.runId, 'work').attempts?.at(-1)?.status).toBe('running');
});
