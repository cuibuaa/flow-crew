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
  'unknown race consumers', 'wrong cancellation', 'not stopped', 'attempt disagreement', 'invalid budget', 'invalid timing', 'missing completion time', 'invalid completion time'] as const)(
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
      if (kind === 'attempt disagreement') state.stages.work.attempts![0].index++;
      if (kind === 'invalid budget') state.maxIterations = 0;
      if (kind === 'invalid timing') state.completedAt = '2000-01-01T00:00:00.000Z';
      if (kind === 'missing completion time') state.completedAt = undefined;
      if (kind === 'invalid completion time') state.completedAt = 'invalid';
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

it.each(['live', 'unknown', 'dead'] as const)('checks %s ownership when only the ledger is unsettled', owner => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
  if (owner === 'live') {
    raw.engineCheckpoint.pid = process.pid;
    raw.engineCheckpoint.processStart = ownership.processStartToken(process.pid);
  }
  if (owner === 'unknown') delete raw.engineCheckpoint;
  writeFileSync(rawPath, JSON.stringify(raw));
  const before = readFileSync(join(created.runDirPath, 'stages/work/status.json'), 'utf8');
  if (owner === 'dead') expect(() => assertContinuationCompatible(project, created.runId)).not.toThrow();
  else expect(() => assertContinuationCompatible(project, created.runId)).toThrow(
    owner === 'live' ? 'controller may still be alive' : 'ownership is unknown',
  );
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readFileSync(join(created.runDirPath, 'stages/work/status.json'), 'utf8')).toBe(before);
});

it.each(['not stopped', 'wrong cancellation', 'missing completion time', 'invalid completion time'] as const)(
  'refuses ledger-only interruption with %s despite proven owner death', boundary => {
    const created = cancelled();
    const rawPath = join(created.runDirPath, 'run.json');
    const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    raw.stages.work = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
    if (boundary === 'not stopped') raw.status = 'failed';
    if (boundary === 'wrong cancellation') raw.failureReason = 'Independent rejection';
    if (boundary === 'missing completion time') delete raw.completedAt;
    if (boundary === 'invalid completion time') raw.completedAt = 'invalid';
    writeFileSync(rawPath, JSON.stringify(raw));
    const ledger = readFileSync(ledgerPath, 'utf8');
    expect(() => assertContinuationCompatible(project, created.runId)).toThrow('unsettled attempt');
    expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
  },
);

it('refuses historical running attempts remaining after interruption settlement', () => {
  const created = cancelled(true);
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const ledger = readStageStatus(project, created.runId, 'work');
  raw.stages.work.attempts[0].status = 'running';
  ledger.attempts![0].status = 'running';
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('unsettled attempt');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
});

it.each(['index', 'start time'] as const)('refuses matching malformed %s history in both carriers', field => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const stage = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
  if (field === 'index') stage.attempts![0].index = 2;
  else stage.attempts![0].startedAt = 'invalid';
  raw.stages.work = stage;
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(stage));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid attempt history');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(stage);
});

it.each(['stage', 'attempt'] as const)('refuses an unknown ledger %s status despite proven owner death', carrier => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
  const ledger = structuredClone(raw.stages.work);
  if (carrier === 'stage') ledger.status = 'unknown';
  else ledger.attempts[0].status = 'unknown';
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow(
    carrier === 'stage' ? 'invalid stage record' : 'invalid attempt history',
  );
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
});

it('refuses an unsupported projection status before normalizing its interrupted attempt', () => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work.status = 'unknown';
  writeFileSync(rawPath, JSON.stringify(raw));
  const ledger = readFileSync(ledgerPath, 'utf8');
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid stage record');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
});

it.each([null, false, 0, ''])('refuses an existing falsy JSON ledger %j for an unstarted stage', ledger => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work.status = 'pending';
  raw.stages.work.attempts = [];
  delete raw.engineCheckpoint;
  writeFileSync(rawPath, JSON.stringify(raw));
  const persistedLedger = JSON.stringify(ledger);
  writeFileSync(ledgerPath, persistedLedger);
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid stage record');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(persistedLedger);
});

it('refuses running summary-only records without owner evidence', () => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work.status = 'running';
  raw.stages.work.attempts = [];
  delete raw.engineCheckpoint;
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(raw.stages.work));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('ownership is unknown');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(raw.stages.work);
});

it('rechecks scheduler death under the settlement lock', () => {
  const created = cancelled();
  const before = readRunState(project, created.runId);
  const ledger = readStageStatus(project, created.runId, 'work');
  const inspect = vi.spyOn(ownership, 'inspectRunScheduler')
    .mockReturnValueOnce({ kind: 'missing' })
    .mockReturnValue({ kind: 'live', pid: process.pid });
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('scheduler identity is live');
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(readRunState(project, created.runId)).toEqual(before);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
});

it.each(['projection', 'ledger'] as const)('refuses a %s changed between preflight and locked settlement', carrier => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  let changedProjection = readFileSync(rawPath, 'utf8');
  let changedLedger = readFileSync(ledgerPath, 'utf8');
  let changed = false;
  vi.spyOn(ownership, 'inspectRunScheduler').mockImplementation(() => {
    if (!changed) {
      changed = true;
      if (carrier === 'projection') {
        const raw = JSON.parse(changedProjection);
        raw.currentIteration = 2;
        changedProjection = JSON.stringify(raw);
        writeFileSync(rawPath, changedProjection);
      } else {
        const ledger = JSON.parse(changedLedger);
        ledger.error = 'Concurrent ledger publication';
        changedLedger = JSON.stringify(ledger);
        writeFileSync(ledgerPath, changedLedger);
      }
    }
    return { kind: 'missing' };
  });
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow(
    carrier === 'projection' ? 'cancelled run changed before settlement' : 'stage ledger changed before settlement',
  );
  expect(readFileSync(rawPath, 'utf8')).toBe(changedProjection);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(changedLedger);
});

it('settles a cancelled projection despite incidental ledger metadata', () => {
  const created = cancelled();
  // Exercise a ledger mismatch independently from its projection.
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const ledger = readStageStatus(project, created.runId, 'work');
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger, error: 'Unrelated ledger change' }));
  expect(() => assertContinuationCompatible(project, created.runId)).not.toThrow();
  expect(readStageStatus(project, created.runId, 'work').attempts![0]).toMatchObject({ status: 'failed', exitCode: 143 });
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

it('accepts a split interrupted settlement with incidental timing differences', () => {
  const created = cancelled();
  const before = readRunState(project, created.runId);
  const terminal = interruptedStageStatus(before.stages.work, before.completedAt!, 'CANCELLED_INTERRUPTED: Cancelled by user');
  terminal.attempts![0].duration_ms!++;
  writeFileSync(join(created.runDirPath, 'stages/work/status.json'), JSON.stringify(terminal));
  expect(() => assertContinuationCompatible(project, created.runId)).not.toThrow();
  expect(readRunState(project, created.runId).stages.work.attempts![0]).toMatchObject({ status: 'failed', exitCode: 143 });
});
