import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from '../src/worker.js';
import { runDir as computeRunDir } from '../src/store.js';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';

/**
 * Regression test for the 3-layer abort/timeout bug observed in run
 * 2026-05-19T06-32-39-616e13 (BTC v3, stage train_survivor):
 *
 *   Layer 2: worker.ts treated exit=137 as `timedOut=true` unconditionally,
 *            so abort-by-supervisor was recorded as "timed out after Xs".
 *   Layer 3: worker.ts did not delete a stale abort signal file at the start
 *            of a retry attempt, so attempt #2 self-aborted within ~2s.
 *
 * These tests exercise both fixes through the worker.runStage entry point with
 * a stub adapter that simulates the adapter's exit=137 + abortSignal behavior.
 *
 * Note: store.runsRoot is hardcoded to ~/.fc/runs/<runId>/, so we use unique
 * runIds with a `fc-test-` prefix and clean them up after.
 */

let projectDir: string;
let runId: string;
let runDir: string;
let stageId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'fc-abort-test-proj-'));
  runId = `fc-test-abort-${randomBytes(4).toString('hex')}`;
  runDir = computeRunDir(projectDir, runId);
  stageId = 'unit_test_stage';
  mkdirSync(join(runDir, 'stages', stageId), { recursive: true });
  mkdirSync(join(runDir, 'signals'), { recursive: true });
  writeFileSync(join(runDir, 'task_brief.md'), '# Test task\n');
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const role: AgentConfig = {
  name: 'unit-test-role',
  description: 'unit',
  tools: [],
  prompt: 'system',
};

function makeAdapter(behavior: 'abort-on-signal' | 'timeout' | 'clean-exit'): Adapter {
  return {
    name: 'unit-test-adapter',
    detect: () => true,
    run: async (_prompt: string, _r: AgentConfig, opts): Promise<RunResult> => {
      if (behavior === 'clean-exit') {
        return { output: 'ok', exitCode: 0, duration_ms: 50, timedOut: false };
      }
      if (behavior === 'timeout') {
        // Simulate wall-clock timeout from the adapter's POV: exit 124, timedOut flag set.
        return { output: 'partial\n', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true };
      }
      // 'abort-on-signal': wait for abortSignal, then simulate the adapter's
      // exit=137 + "[stage aborted by supervisor]" return shape (see base.ts).
      await new Promise<void>((resolve) => {
        const sig = opts.abortSignal;
        if (!sig) return resolve();
        if (sig.aborted) return resolve();
        sig.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        output: 'partial\n[stage aborted by supervisor]\n',
        exitCode: 137,
        duration_ms: 50,
        timedOut: false, // adapter base.ts sets this to false on abort
      };
    },
  };
}

describe('worker.ts abort attribution (Layer 2 fix)', () => {
  it('attributes supervisor abort distinctly from wall-clock timeout', async () => {
    const adapter = makeAdapter('abort-on-signal');
    // Pre-write the supervisor abort signal so the poller fires within 2s.
    const sigPath = join(runDir, 'signals', `abort_${stageId}.json`);
    writeFileSync(sigPath, JSON.stringify({
      version: 1,
      stageId,
      attemptIndex: 1,
      reason: 'idle past threshold; no implementation progress',
      timestamp: new Date().toISOString(),
      source: 'supervisor',
    }));
    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'do work',
      timeout_ms: 60_000,
      projectDir,
      runId,
      runDir,
      retries: 0,
    });
    expect(result.exitCode).toBe(137);
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8'));
    expect(status.status).toBe('failed');
    expect(status.error).toMatch(/^aborted by supervisor/);
    expect(status.error).toContain('idle past threshold');
    // Anti-regression: must NOT misattribute to timeout.
    expect(status.error).not.toMatch(/timed out after/);
  });

  it('still attributes true wall-clock timeout as "timed out"', async () => {
    const adapter = makeAdapter('timeout');
    await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'do work',
      timeout_ms: 1_000,
      projectDir,
      runId,
      runDir,
      retries: 0,
    });
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8'));
    expect(status.error).toMatch(/^timed out after/);
    expect(status.error).not.toMatch(/aborted by supervisor/);
  });
});

describe('worker.ts stale abort-signal cleanup (Layer 3 fix)', () => {
  it('deletes a leftover abort signal at start so retry does not self-abort', async () => {
    // Simulate the state at retry: a leftover signal from attempt #1.
    const sigPath = join(runDir, 'signals', `abort_${stageId}.json`);
    writeFileSync(sigPath, JSON.stringify({ reason: 'stale from previous attempt' }));
    expect(existsSync(sigPath)).toBe(true);

    const adapter = makeAdapter('clean-exit');
    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'do work',
      timeout_ms: 60_000,
      projectDir,
      runId,
      runDir,
      retries: 1, // marker that this is a retry attempt
    });

    // The stale signal should have been cleared at start; attempt completes normally.
    expect(result.exitCode).toBe(0);
    expect(existsSync(sigPath)).toBe(false);
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8'));
    expect(status.status).toBe('complete');
    expect(status.error).toBeUndefined();
  });
});
