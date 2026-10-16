import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import * as ownership from '../src/run-lock.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { beginStageAttempt, completeStageAttempt, interruptedStageStatus, createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, previous: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-legacy-cancel-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
  }
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});

function cancelled(retry = false, alter?: (state: ReturnType<typeof readRunState>) => void) {
  const workflow = WorkflowConfigSchema.parse({ name: 'legacy-cancellation', defaults: { max_iterations: 1, max_retries: 0 },
    stages: ['done', 'done2', 'work'].map((id, index, ids) => ({ id, role: 'coder', scope: [],
      depends_on: index ? [ids[index - 1]] : [], prompt_template: 'Complete fixture.',
      artifact_contract: { version: 1, produces: [], reads: [] } })) });
  normalizeStageContracts(workflow.stages);
  const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
  for (const id of ['done', 'done2']) {
    beginStageAttempt(project, created.runId, id, 0);
    completeStageAttempt(project, created.runId, id, 0, { exitCode: 0, duration_ms: 1 });
  }
  if (retry) {
    beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 124, duration_ms: 1, error: 'Attempt deadline exceeded' });
  }
  beginStageAttempt(project, created.runId, 'work', Number(retry));
  // A real, exited controller supplies positive death evidence without a
  // hard-coded PID that another machine could own.
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', cwd: project,
    env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } }).trim());
  updateRunState(project, created.runId, state => {
    state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: deadPid, processStart: undefined, processes: [] };
    state.status = 'stopped'; state.failureReason = 'Cancelled by user'; state.completedAt = new Date().toISOString();
    state.stages.work.status = 'failed';
    alter?.(state);
  });
  return { ...created, workflow };
}

it.each([false, true])('settles old cancellation and executes only a new work attempt (timeout retry=%s)', async retry => {
  const created = cancelled(retry);
  const before = readRunState(project, created.runId);
  const completed = ['done', 'done2'].map(id => readStageStatus(project, created.runId, id));
  const first = before.stages.work.attempts![0];
  const settled = assertContinuationCompatible(project, created.runId);
  expect(settled.status).toBe('stopped');
  expect(settled.stages.work).toEqual(readStageStatus(project, created.runId, 'work'));
  expect(settled.stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143,
    completedAt: before.completedAt, error: 'CANCELLED_INTERRUPTED: Cancelled by user', tokenUsage: 'unknown' });
  if (retry) expect(settled.stages.work.attempts![0]).toEqual(first);
  expect(assertContinuationCompatible(project, created.runId)).toEqual(settled);
  const roles = join(root, 'roles'); mkdirSync(roles);
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\nprompt: Fixture.\ntools: []\n');
  const calls: string[] = [];
  const resumed = await runWorkflow(created.workflow, stringify(created.workflow), project, { async run(_prompt, _role, options) {
    calls.push(options.stageId);
    return fixtureResult({ output: 'Completed.', exitCode: 0, duration_ms: 1, writes: [] }, options);
  } }, new Map(), undefined, roles, created.runId);
  expect(resumed.status, resumed.failureReason).toBe('complete');
  expect(calls).toEqual(['work']);
  expect(['done', 'done2'].map(id => readStageStatus(project, created.runId, id))).toEqual(completed);
  expect(resumed.stages.work.attempts!.map(attempt => attempt.status)).toEqual(retry ? ['failed', 'failed', 'complete'] : ['failed', 'complete']);
  expect(resumed.stages.work.attempts!.at(-1)!.index).toBe(retry ? 3 : 2);
});

it.each(['live controller', 'unknown controller identity', 'malformed controller identity', 'live scheduler', 'unverifiable scheduler', 'missing ownership', 'missing command groups',
  'unknown race consumers', 'wrong cancellation', 'not stopped', 'retry disagreement', 'attempt disagreement', 'other stage disagreement', 'invalid budget', 'invalid timing'] as const)(
  'refuses %s without changing either execution record', kind => {
    const created = cancelled(false, state => {
      const checkpoint = state.engineCheckpoint!;
      if (kind === 'live controller' || kind === 'unknown controller identity') checkpoint.pid = process.pid;
      if (kind === 'malformed controller identity') { checkpoint.pid = process.pid; checkpoint.processStart = { kind: 'linux', value: 'not-a-start-token' }; }
      if (kind === 'unknown controller identity') checkpoint.processStart = { kind: 'linux', value: 'old-start' };
      if (kind === 'missing ownership') state.engineCheckpoint = undefined;
      if (kind === 'missing command groups') checkpoint.processes = undefined;
      if (kind === 'wrong cancellation') state.failureReason = 'Independent rejection';
      if (kind === 'not stopped') state.status = 'failed';
      if (kind === 'retry disagreement') state.stages.work.retries++;
      if (kind === 'attempt disagreement') state.stages.work.attempts![0].index++;
      if (kind === 'other stage disagreement') state.stages.done.retries++;
      if (kind === 'invalid budget') state.maxIterations = 0;
      if (kind === 'invalid timing') state.completedAt = '2000-01-01T00:00:00.000Z';
    });
    if (kind === 'unknown controller identity') vi.spyOn(ownership, 'processStartToken').mockReturnValue(undefined);
    if (kind === 'live scheduler' || kind === 'unverifiable scheduler') vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({
      kind: kind === 'live scheduler' ? 'live' : 'unverifiable', pid: process.pid, detail: 'unreadable fixture',
    });
    if (kind === 'unknown race consumers') {
      // A v1 checkpoint cannot account for nested race command consumers.
      const raw = JSON.parse(readFileSync(join(created.runDirPath, 'run.json'), 'utf8'));
      raw.engineCheckpoint.version = 1;
      raw.planControl = { version: 1, stages: [{ id: 'race', race: {} }] };
      writeFileSync(join(created.runDirPath, 'run.json'), JSON.stringify(raw));
    }
    const before = readRunState(project, created.runId);
    const ledger = readStageStatus(project, created.runId, 'work');
    expect(() => assertContinuationCompatible(project, created.runId)).toThrow('CONTINUATION_INCOMPATIBLE');
    expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
    expect(readRunState(project, created.runId).stages).toEqual(before.stages);
  },
);

it.each([false, true])('refuses an owned live command group after its controller has exited (malformed token=%s)', async malformed => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', cwd: project,
    env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const created = cancelled(false, state => {
    state.engineCheckpoint!.processes = [{ pid: child.pid!, processStart: malformed ? { kind: 'linux', value: 'not-a-start-token' } : ownership.processStartToken(child.pid!) }];
  });
  const ledger = readStageStatus(project, created.runId, 'work');
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow(malformed ? 'command identity is unknown' : 'commands are still active');
  expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
});

it('does not accept a fabricated cancelled projection with an already changed ledger', () => {
  const created = cancelled();
  // Exercise a ledger mismatch independently from its projection.
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const ledger = readStageStatus(project, created.runId, 'work');
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger, error: 'Unrelated ledger change' }));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('stage projection and attempt ledger disagree');
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).error).toBe('Unrelated ledger change');
});


it.each(['closed child', 'reused controller', 'split ledger'] as const)('continues a cancelled %s with exact settlement evidence', kind => {
  const created = cancelled(false, state => {
    if (kind === 'reused controller') {
      const token = ownership.processStartToken(process.pid)!;
      state.engineCheckpoint!.pid = process.pid;
      state.engineCheckpoint!.processStart = { ...token, value: token.kind === 'linux' ? String(BigInt(token.value) + 1n) : 'prior process start' };
    }
  });
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  if (kind === 'closed child') {
    // A legacy child may have closed before its scheduler was cancelled.
    const ledger = readStageStatus(project, created.runId, 'work');
    const attempt = ledger.attempts![0];
    Object.assign(attempt, { status: 'closed', completedAt: raw.completedAt, duration_ms: 1, exitCode: 0 });
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    raw.stages.work = { ...ledger, status: 'failed' };
    writeFileSync(rawPath, JSON.stringify(raw));
  }
  if (kind === 'split ledger') writeFileSync(ledgerPath, JSON.stringify(interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user')));
  const settled = assertContinuationCompatible(project, created.runId);
  expect(settled.stages.work.attempts).toHaveLength(1);
  expect(settled.stages.work.attempts![0]).toMatchObject({ index: 1, status: 'failed', exitCode: 143 });
  expect(readStageStatus(project, created.runId, 'work')).toEqual(settled.stages.work);
  expect(assertContinuationCompatible(project, created.runId)).toEqual(settled);
});

it('refuses a terminal ledger differing from the exact interrupted settlement', () => {
  const created = cancelled();
  const before = readRunState(project, created.runId);
  const terminal = interruptedStageStatus(before.stages.work, before.completedAt!, 'CANCELLED_INTERRUPTED: Cancelled by user');
  terminal.attempts![0].duration_ms!++;
  writeFileSync(join(created.runDirPath, 'stages/work/status.json'), JSON.stringify(terminal));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('stage projection and attempt ledger disagree');
  expect(readRunState(project, created.runId).stages).toEqual(before.stages);
});
