import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCancellationCoordinator } from '../src/run-control.js';
import type { SupervisorBackend } from '../src/supervision.js';
import {
  beginStageAttempt, closeStageAttempt, completeStageAttempt, createRun, fcGlobalDir,
  readRunState, readStageStatus, RUN_STATUS, setFcGlobalDir, STAGE_STATUS, updateRunState,
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
    expect(readStageStatus(projectDir, run.runId, 'later')).toEqual(state.stages.later);
    expect(() => completeStageAttempt(projectDir, run.runId, 'work', work.retries, { exitCode: 0, duration_ms: 1 })).toThrow(/cancel/i);
    expect(readStageStatus(projectDir, run.runId, 'work')).toEqual(work);
    expect(readRunState(projectDir, run.runId)).toEqual(state);
  });
});
