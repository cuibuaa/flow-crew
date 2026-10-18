import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import type { SupervisorBackend } from '../src/supervision.js';
import {
  beginStageAttempt, closeStageAttempt, completeStageAttempt, createRun, fcGlobalDir,
  readRunState, readStageStatus, rependStageStatus, RUN_STATUS, setFcGlobalDir, STAGE_STATUS, updateRunState,
} from '../src/store.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

let root: string;
let projectDir: string;
let originalStore: string;
const completedAt = '2026-10-16T12:00:10.000Z';
const startedAt = '2026-10-16T12:00:00.000Z';
const units: SupervisorBackend = {
  isActive: async () => ({ kind: 'absent' }), runUnit: async () => {},
  stopUnit: async () => {}, journalTail: async () => '',
};

beforeEach(() => {
  originalStore = fcGlobalDir();
  root = mkdtempSync(join(tmpdir(), 'fc-cancel-settlement-'));
  projectDir = join(root, 'project');
  mkdirSync(projectDir);
  setFcGlobalDir(join(root, 'state'));
});

afterEach(() => {
  setFcGlobalDir(originalStore);
  rmSync(root, { recursive: true, force: true });
});

describe('cancellation settles interrupted execution', () => {
  it.each(['running', 'closed', 'timeout-retry'] as const)('publishes terminal matching ledgers for %s work and preserves completed stages', async phase => {
    const run = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['done', 'work', 'later']);
    updateRunState(projectDir, run.runId, state => { state.status = RUN_STATUS.RUNNING; });
    beginStageAttempt(projectDir, run.runId, 'done', 0, startedAt);
    completeStageAttempt(projectDir, run.runId, 'done', 0, { exitCode: 0, duration_ms: 1, completedAt: startedAt });
    const done = readStageStatus(projectDir, run.runId, 'done');
    beginStageAttempt(projectDir, run.runId, 'work', 0, startedAt);
    if (phase === 'timeout-retry') {
      completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 124, duration_ms: 5, completedAt: startedAt, error: 'attempt timed out' });
      beginStageAttempt(projectDir, run.runId, 'work', 1, startedAt);
    }
    if (phase === 'closed') closeStageAttempt(projectDir, run.runId, 'work', 1, { exitCode: 0, duration_ms: 7, completedAt: startedAt, tokens_in: 2, tokens_out: 3 });
    const before = readStageStatus(projectDir, run.runId, 'work');
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({ projectDir, run_id: run.runId, status: TASK_STATUS.RUNNING });

    const result = await new RunCancellationCoordinator({ registry, units,
      now: () => new Date(completedAt), timeoutMs: 0, signalGraceMs: 0,
    }).cancelTask(task.id);

    expect(result).toMatchObject({ ok: true, status: 'cancelled' });
    const state = readRunState(projectDir, run.runId);
    const work = readStageStatus(projectDir, run.runId, 'work');
    expect(state).toMatchObject({ status: RUN_STATUS.STOPPED, failureReason: 'Cancelled by user', completedAt });
    expect(work).toEqual(state.stages.work);
    expect(work).toMatchObject({ status: STAGE_STATUS.FAILED, retries: phase === 'timeout-retry' ? 1 : 0 });
    expect(work.attempts?.at(-1)).toMatchObject({ status: 'failed', exitCode: 143, error: 'CANCELLED_INTERRUPTED: Cancelled by user' });
    expect(work.attempts).toHaveLength(before.attempts!.length);
    expect(work.attempts?.slice(0, -1)).toEqual(before.attempts?.slice(0, -1));
    expect(work.attempts?.at(-1)?.duration_ms).toBe(phase === 'closed' ? 7 : 10_000);
    expect(work.attempts?.at(-1)?.tokenUsage).toBe(phase === 'closed' ? 'known' : 'unknown');
    expect(Object.values(state.stages).flatMap(stage => stage.attempts ?? []).some(attempt => ['running', 'closed'].includes(attempt.status))).toBe(false);
    expect(state.stages.done).toEqual(done);
    expect(readStageStatus(projectDir, run.runId, 'done')).toEqual(done);
    expect(state.stages.later.status).toBe(STAGE_STATUS.PENDING);
    expect(existsSync(join(run.runDirPath, 'stages/later/status.json'))).toBe(false);
    expect(() => completeStageAttempt(projectDir, run.runId, 'work', work.retries, { exitCode: 0, duration_ms: 1 })).toThrow(/cancel/i);
    expect(readStageStatus(projectDir, run.runId, 'work')).toEqual(work);
    expect(readRunState(projectDir, run.runId)).toEqual(state);
  });
});

describe('cancellation preserves ledger evidence', () => {
  it.each(['missing attempt', 'different status', 'failed attempt', 'different exit code'] as const)(
    'refuses settled ledger work absent from the projection: %s', async difference => {
      const run = createRun(projectDir, 'fixture', 'name: fixture\nstages:\n  - id: work\n    role: coder\n    scope: []\n    prompt_template: Complete fixture.\n', ['work']);
      beginStageAttempt(projectDir, run.runId, 'work', 0, startedAt);
      completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 0, duration_ms: 5, completedAt });
      const ledgerPath = join(run.runDirPath, 'stages/work/status.json');
      const ledger = readStageStatus(projectDir, run.runId, 'work');
      if (difference === 'missing attempt') ledger.attempts!.push({ ...ledger.attempts![0], index: 2 });
      if (difference === 'different status') ledger.attempts![0].status = 'suspended';
      if (difference === 'failed attempt') Object.assign(ledger.attempts![0], { status: 'failed', exitCode: 1 });
      if (difference === 'different exit code') ledger.attempts![0].exitCode = 143;
      writeFileSync(ledgerPath, JSON.stringify(ledger));
      const before = readFileSync(ledgerPath, 'utf8');
      const registry = new TaskRegistry({ baseDir: root });
      const task = registry.create({ projectDir, run_id: run.runId, status: TASK_STATUS.RUNNING });
      expect(await new RunCancellationCoordinator({ registry, units, timeoutMs: 0, signalGraceMs: 0 }).cancelTask(task.id))
        .toMatchObject({ ok: true, status: 'cancelled' });
      const state = readRunState(projectDir, run.runId);
      expect(() => assertContinuationCompatible(projectDir, run.runId)).toThrow('attempt ledger is ahead');
      expect(readRunState(projectDir, run.runId)).toEqual(state);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    },
  );

  it.each(['ahead', 'other disagreement', 'status disagreement', 'missing', 'malformed'] as const)('leaves a %s ledger untouched and admits only known settled work', async kind => {
    const run = createRun(projectDir, 'fixture', 'name: fixture\nstages:\n  - id: work\n    role: coder\n    scope: []\n    prompt_template: Complete fixture.\n', ['work']);
    updateRunState(projectDir, run.runId, state => { state.status = RUN_STATUS.RUNNING; });
    beginStageAttempt(projectDir, run.runId, 'work', 0, startedAt);
    const projection = readRunState(projectDir, run.runId).stages.work;
    const ledgerPath = join(run.runDirPath, 'stages/work/status.json');
    if (kind === 'ahead') {
      // writeStageStatus publishes the ledger first. Restore only run.json to
      // reproduce a crash before the corresponding projection was published.
      const raw = readFileSync(join(run.runDirPath, 'run.json'), 'utf8');
      completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 0, duration_ms: 5, completedAt });
      writeFileSync(join(run.runDirPath, 'run.json'), raw);
    }
    if (kind === 'other disagreement') writeFileSync(ledgerPath, JSON.stringify({ ...projection, error: 'Independent ledger evidence' }));
    if (kind === 'status disagreement') {
      completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 0, duration_ms: 5, completedAt });
      writeFileSync(ledgerPath, JSON.stringify({ ...readStageStatus(projectDir, run.runId, 'work'), status: STAGE_STATUS.FAILED }));
    }
    if (kind === 'missing') rmSync(ledgerPath);
    if (kind === 'malformed') writeFileSync(ledgerPath, '{unreadable ledger');
    const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined;
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({ projectDir, run_id: run.runId, status: TASK_STATUS.RUNNING });

    const result = await new RunCancellationCoordinator({ registry, units,
      now: () => new Date(completedAt), timeoutMs: 0, signalGraceMs: 0,
    }).cancelTask(task.id);

    expect(result).toMatchObject({ ok: true, status: 'cancelled' });
    const state = readRunState(projectDir, run.runId);
    expect(state.status).toBe(RUN_STATUS.STOPPED);
    expect(state.stages.work.attempts!.at(-1)).toMatchObject(kind === 'status disagreement'
      ? { status: 'complete', exitCode: 0 } : { status: 'failed', exitCode: 143 });
    expect(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined).toBe(before);
    if (kind === 'status disagreement') expect(() => assertContinuationCompatible(projectDir, run.runId)).not.toThrow();
    else expect(() => assertContinuationCompatible(projectDir, run.runId)).toThrow(
      kind === 'ahead' ? 'attempt ledger is ahead' : 'CONTINUATION_INCOMPATIBLE',
    );
    expect(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined).toBe(before);
    expect(readRunState(projectDir, run.runId)).toEqual(state);
  });

  it.each(['attempts', 'retries', 'timestamps', 'skipped'] as const)('continues a cancelled repended stage despite incidental %s differences', async difference => {
    const run = createRun(projectDir, 'fixture', 'name: fixture\nstages:\n  - id: work\n    role: coder\n    scope: []\n    prompt_template: Complete fixture.\n', ['work']);
    beginStageAttempt(projectDir, run.runId, 'work', 0, startedAt);
    completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 0, duration_ms: 5, completedAt });
    updateRunState(projectDir, run.runId, state => {
      state.status = RUN_STATUS.RUNNING;
      state.stages.work = rependStageStatus(state.stages.work);
      if (difference === 'skipped') state.stages.work.status = STAGE_STATUS.SKIPPED;
    });
    const ledgerPath = join(run.runDirPath, 'stages/work/status.json');
    const ledger = readStageStatus(projectDir, run.runId, 'work');
    if (difference === 'attempts') ledger.attempts![0].duration_ms!++;
    if (difference === 'retries') ledger.retries++;
    if (difference === 'timestamps') {
      ledger.completedAt = '2026-10-16T12:00:11.000Z';
      ledger.attempts![0].startedAt = '2026-10-16T12:00:01.000Z';
      ledger.attempts![0].completedAt = ledger.completedAt;
    }
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const before = readFileSync(ledgerPath, 'utf8');
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({ projectDir, run_id: run.runId, status: TASK_STATUS.RUNNING });
    expect(await new RunCancellationCoordinator({ registry, units,
      now: () => new Date(completedAt), timeoutMs: 0, signalGraceMs: 0,
    }).cancelTask(task.id)).toMatchObject({ ok: true, status: 'cancelled' });
    expect(() => assertContinuationCompatible(projectDir, run.runId)).not.toThrow();
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it.each([false, true])('continues cancelled repended stages with unchanged execution ledgers (matching pending ledger=%s)', async matching => {
    const run = createRun(projectDir, 'fixture', 'name: fixture\nstages:\n  - id: work\n    role: coder\n    scope: []\n    prompt_template: Complete fixture.\n', ['work']);
    beginStageAttempt(projectDir, run.runId, 'work', 0, startedAt);
    completeStageAttempt(projectDir, run.runId, 'work', 0, { exitCode: 0, duration_ms: 5, completedAt });
    updateRunState(projectDir, run.runId, state => {
      state.status = RUN_STATUS.RUNNING;
      state.stages.work = rependStageStatus(state.stages.work);
    });
    const ledgerPath = join(run.runDirPath, 'stages/work/status.json');
    if (matching) writeFileSync(ledgerPath, JSON.stringify(readRunState(projectDir, run.runId).stages.work));
    const before = readFileSync(ledgerPath, 'utf8');
    const attempts = readRunState(projectDir, run.runId).stages.work.attempts;
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({ projectDir, run_id: run.runId, status: TASK_STATUS.RUNNING });

    expect(await new RunCancellationCoordinator({ registry, units,
      now: () => new Date(completedAt), timeoutMs: 0, signalGraceMs: 0,
    }).cancelTask(task.id)).toMatchObject({ ok: true, status: 'cancelled' });

    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    expect(() => assertContinuationCompatible(projectDir, run.runId)).not.toThrow();
    expect(readRunState(projectDir, run.runId).stages.work).toMatchObject({ status: STAGE_STATUS.PENDING, attempts });
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });
});
