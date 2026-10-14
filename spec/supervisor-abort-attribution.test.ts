import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from '../src/worker.js';
import { atomicWrite, createRun } from '../src/store.js';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';

/** Historical abort signals remain distinct from attempt deadlines. */

let projectDir: string;
let runId: string;
let runDir: string;
let stageId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'fc-abort-test-proj-'));
  stageId = 'unit_test_stage';
  ({ runId, runDirPath: runDir } = createRun(projectDir, 'abort', 'name: abort\nstages: []', [stageId]));
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
      // exit=137 + "[stage aborted]" return shape (see base.ts).
      await new Promise<void>((resolve) => {
        const sig = opts.abortSignal;
        if (!sig) return resolve();
        if (sig.aborted) return resolve();
        sig.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        output: 'partial\n[stage aborted]\n',
        exitCode: 137,
        duration_ms: 50,
        timedOut: false, // adapter base.ts sets this to false on abort
      };
    },
  };
}

describe('worker.ts abort attribution (Layer 2 fix)', () => {
  it('attributes an archived supervisor signal distinctly from wall-clock timeout', async () => {
    const adapter = makeAdapter('abort-on-signal');
    // Replay an archived signal so the owned cancellation poller fires.
    const sigPath = join(runDir, 'signals', `abort_${stageId}.json`);
    atomicWrite(sigPath, JSON.stringify({
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
      artifactContract: { version: 1, produces: [], reads: [], replays: [] },
      timeout_ms: 60_000,
      projectDir,
      runId,
      runDir,
      retries: 0,
    });
    expect(result.exitCode).toBe(137);
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8'));
    expect(status.status).toBe('failed');
    expect(status.error).toMatch(/^aborted by engine/);
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
      artifactContract: { version: 1, produces: [], reads: [], replays: [] },
      timeout_ms: 1_000,
      projectDir,
      runId,
      runDir,
      retries: 0,
    });
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8'));
    expect(status.error).toMatch(/^timed out after/);
    expect(status.error).not.toMatch(/aborted by engine/);
  });
});

describe('worker.ts stale abort-signal cleanup (Layer 3 fix)', () => {
  it('deletes a leftover abort signal at start so retry does not self-abort', async () => {
    // Simulate the state at retry: a leftover signal from attempt #1.
    const sigPath = join(runDir, 'signals', `abort_${stageId}.json`);
    atomicWrite(sigPath, JSON.stringify({ reason: 'stale from previous attempt' }));
    expect(existsSync(sigPath)).toBe(true);

    const adapter = makeAdapter('clean-exit');
    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'do work',
      artifactContract: { version: 1, produces: [], reads: [], replays: [] },
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
