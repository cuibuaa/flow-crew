import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from './test-support/create-run.js';
import {
  beginStageAttempt, closeStageAttempt, fcGlobalDir, readStageStatus,
  runDir, setFcGlobalDir, settleStageAttempt, updateRunState,
} from '../src/store.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';

let root: string, project: string, prior: string, runId: string;
const startedAt = '2026-01-01T00:00:00.000Z';
const completedAt = '2026-01-01T00:00:01.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-closure-owner-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runId;
  beginStageAttempt(project, runId, 'work', 0, startedAt, { role: 'author', iteration: 2 });
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

function close() {
  return closeStageAttempt(project, runId, 'work', 1, {
    exitCode: 0, duration_ms: 1000, completedAt, tokens_in: 17, tokens_out: 23,
    tokenUsage: 'known', writes: ['product.txt'], writeAttribution: 'structured',
  });
}
function ledger() { return readFileSync(join(runDir(project, runId), 'stages/work/status.json'), 'utf8'); }

describe('one attempt closure owner', () => {
  it('keeps closure non-runnable and non-successful until classification, then retains measured facts', () => {
    expect(close()).toMatchObject({ status: 'running', attempts: [{ status: 'closed', completedAt, tokens_out: 23 }] });
    const final = settleStageAttempt(project, runId, 'work', 1);
    expect(final).toMatchObject({ status: 'complete', attempts: [{ index: 1, status: 'complete', role: 'author', iteration: 2,
      completedAt, duration_ms: 1000, tokens_in: 17, tokens_out: 23, tokenUsage: 'known', writes: ['product.txt'] }] });
    expect(final.attempts).toHaveLength(1);
  });

  it('rejects stale close and classification identities without touching the ledger', () => {
    const running = ledger();
    expect(() => closeStageAttempt(project, runId, 'work', 2, { exitCode: 0, duration_ms: 1 })).toThrow('execution identity changed');
    expect(() => settleStageAttempt(project, runId, 'work', 1)).toThrow('matching closed child');
    expect(ledger()).toBe(running);
    close(); const closed = ledger();
    expect(() => close()).toThrow('execution identity changed');
    expect(() => settleStageAttempt(project, runId, 'work', 2)).toThrow('matching closed child');
    expect(ledger()).toBe(closed);
  });

  it('records refusal or a real suspension on the same closed child', () => {
    close();
    const failed = settleStageAttempt(project, runId, 'work', 1, true, { exitCode: 1, error: 'independent audit refused' });
    expect(failed).toMatchObject({ status: 'failed', attempts: [{ status: 'failed', exitCode: 1, error: 'independent audit refused', tokens_out: 23 }] });
    expect(failed.attempts).toHaveLength(1);
    beginStageAttempt(project, runId, 'work', 0);
    closeStageAttempt(project, runId, 'work', 2, { exitCode: 0, duration_ms: 1 });
    expect(settleStageAttempt(project, runId, 'work', 2, true)).toMatchObject({ status: 'pending', attempts: [{ status: 'failed' }, { status: 'suspended' }] });
  });

  it('recovers unverified closure honestly without losing known usage or claiming successful work', () => {
    close();
    updateRunState(project, runId, state => {
      state.engineCheckpoint = { version: 2, runId, projectDir: project, bootId: 'prior-boot', pid: 2147483647, at: startedAt, processes: [] };
      state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4;
    });
    const recovered = reconcileHostInterruptedRun(project, runId, { currentBootId: 'next-boot' });
    expect(recovered).toMatchObject({ status: 'parked', currentIteration: 2, maxIterations: 3, maxRetries: 4,
      recovery: { kind: 'resumable' }, stages: { work: { status: 'pending', attempts: [{ index: 1, status: 'failed', exitCode: 143,
        completedAt, duration_ms: 1000, tokens_in: 17, tokens_out: 23, tokenUsage: 'known', writes: ['product.txt'] }] } } });
    expect(readStageStatus(project, runId, 'work').attempts).toHaveLength(1);
    expect(reconcileHostInterruptedRun(project, runId, { currentBootId: 'next-boot' }).stages.work.attempts).toHaveLength(1);
  });
});
