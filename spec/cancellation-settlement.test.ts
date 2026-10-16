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
    expect(state.stages.later.status).toBe(STAGE_STATUS.SKIPPED);
    expect(existsSync(join(run.runDirPath, 'stages/later/status.json'))).toBe(false);
    expect(() => completeStageAttempt(projectDir, run.runId, 'work', work.retries, { exitCode: 0, duration_ms: 1 })).toThrow(/cancel/i);
    expect(readStageStatus(projectDir, run.runId, 'work')).toEqual(work);
    expect(readRunState(projectDir, run.runId)).toEqual(state);
  });
});

describe('cancellation preserves ledger evidence', () => {
  it.each(['ahead', 'other disagreement', 'missing', 'malformed'] as const)('leaves a %s ledger untouched and continuation refuses it', async kind => {
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
    expect(state.stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143 });
    expect(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined).toBe(before);
    expect(() => assertContinuationCompatible(projectDir, run.runId)).toThrow(
      kind === 'ahead' || kind === 'other disagreement' ? 'stage projection and attempt ledger disagree' : 'CONTINUATION_INCOMPATIBLE',
    );
    expect(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined).toBe(before);
    expect(readRunState(projectDir, run.runId)).toEqual(state);
  });

  it.each([false, true])('keeps repended execution ledgers byte-for-byte (matching pending ledger=%s)', async matching => {
    const run = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['work']);
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

    expect(readRunState(projectDir, run.runId).stages.work).toMatchObject({ status: STAGE_STATUS.SKIPPED, attempts });
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });
});
