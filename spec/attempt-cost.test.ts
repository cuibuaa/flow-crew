import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { deriveRunTokenCost } from '../src/campaign-page.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
} from '../src/store.js';
import { runStage } from '../src/worker.js';

const role: AgentConfig = {
  name: 'coder',
  description: 'E10 fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
};

let projectDir: string;
let isolatedFcHome: string;
let previousFcHome: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e10-cost-project-'));
  isolatedFcHome = mkdtempSync(join(tmpdir(), 'flowcrew-e10-cost-state-'));
  previousFcHome = fcGlobalDir();
  setFcGlobalDir(isolatedFcHome);
});

afterEach(() => {
  vi.useRealTimers();
  setFcGlobalDir(previousFcHome);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedFcHome, { recursive: true, force: true });
});

describe('attempt token evidence', () => {
  it.each([
    { label: 'supervisor abort', exitCode: 137 },
    { label: 'timeout', exitCode: 124 },
    { label: 'ordinary failure', exitCode: 1 },
  ])('settles a telemetry-free $label as explicitly unknown', ({ exitCode }) => {
    const created = createRun(projectDir, 'unknown-cost', 'name: unknown-cost', ['work']);
    beginStageAttempt(projectDir, created.runId, 'work', 0, '2026-08-02T12:00:00.000Z');
    completeStageAttempt(projectDir, created.runId, 'work', 0, {
      exitCode,
      duration_ms: 500,
      completedAt: '2026-08-02T12:00:00.500Z',
    });

    const persisted = readStageStatus(projectDir, created.runId, 'work');
    expect(persisted.attempts?.[0]).toMatchObject({ tokenUsage: 'unknown' });
  });

  it('distinguishes an explicit unknown attempt from an unrecorded legacy attempt', () => {
    const created = createRun(projectDir, 'evidence-summary', 'name: evidence-summary', ['explicit', 'legacy']);
    beginStageAttempt(projectDir, created.runId, 'explicit', 0, '2026-08-02T12:00:00.000Z');
    completeStageAttempt(projectDir, created.runId, 'explicit', 0, {
      exitCode: 137,
      duration_ms: 500,
      tokens_out: 9,
      completedAt: '2026-08-02T12:00:00.500Z',
    });
    const state = readRunState(projectDir, created.runId);
    state.status = 'failed';
    state.supervise = false;
    state.stages.legacy = {
      status: 'failed',
      retries: 0,
      attempts: [{
        index: 1,
        startedAt: '2026-08-02T12:01:00.000Z',
        completedAt: '2026-08-02T12:01:00.500Z',
        status: 'failed',
        exitCode: 137,
        duration_ms: 500,
      }],
    };

    expect(deriveRunTokenCost(state)).toEqual({
      tokens: 9,
      supervisorTokens: 0,
      complete: false,
      attemptEvidence: { known: 0, recordedUnknown: 1, unrecorded: 1 },
    });
  });

  it('retains telemetry returned while a supervisor abort is closing the adapter', async () => {
    vi.useFakeTimers();
    const stageId = 'abort_with_telemetry';
    const created = createRun(projectDir, 'abort-cost', 'name: abort-cost', [stageId]);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    const adapter: Adapter = {
      async run(_prompt, _agent, opts): Promise<RunResult> {
        const signalPath = join(opts.runDir, 'signals', `abort_${opts.stageId}.json`);
        writeFileSync(signalPath, JSON.stringify({
          version: 1,
          stageId: opts.stageId,
          attemptIndex: 1,
          reason: 'verified wrong direction',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        if (!opts.abortSignal?.aborted) {
          await new Promise<void>((resolve) => opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
        }
        return { output: 'cancelled with usage', exitCode: 137, duration_ms: 2_000, tokens_in: 17, tokens_out: 5 };
      },
    };

    const running = runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'fixture',
      timeout_ms: 10_000,
      timeout_total_ms: 20_000,
      projectDir,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    expect(existsSync(join(created.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await running;
    const attempt = readStageStatus(projectDir, created.runId, stageId).attempts?.[0];

    expect(result.exitCode).toBe(137);
    expect(attempt).toMatchObject({
      status: 'failed',
      tokenUsage: 'known',
      tokens_in: 17,
      tokens_out: 5,
    });
  });
});
