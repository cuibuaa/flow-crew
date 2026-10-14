import { atomicWrite } from '../src/store.js';
import { stageLiveLogPath } from '../src/stage-live-log.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { inspectStageExecutionFacts } from '../src/stage-watchdog.js';
import { runStage } from '../src/worker.js';

const stageId = 'acceptance_gate';
const role: AgentConfig = {
  name: 'qa',
  description: 'test gate',
  tools: [],
  prompt: 'verify the deliverable',
};

let projectDir: string;
let isolatedFcHome: string;
let previousFcHome: string;
let currentRunId: string;
let currentRunDir: string;

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e8-project-'));
  isolatedFcHome = mkdtempSync(join(tmpdir(), 'flowcrew-e8-home-'));
  setFcGlobalDir(isolatedFcHome);
  const created = createRun(
    projectDir,
    'e8-supervision',
    'name: e8-supervision\nstages:\n  - id: acceptance_gate\n    role: qa\n',
    [stageId],
  );
  currentRunId = created.runId;
  currentRunDir = created.runDirPath;
  mkdirSync(join(currentRunDir, 'signals'), { recursive: true });
  writeFileSync(join(currentRunDir, 'task_brief.md'), '# Deterministic E8 fixture\n');
});

afterEach(() => {
  vi.useRealTimers();
  setFcGlobalDir(previousFcHome);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedFcHome, { recursive: true, force: true });
});

function markRunningAttempt(startedAt = new Date(Date.now() - 60_000).toISOString()): void {
  const state = readRunState(projectDir, currentRunId);
  state.stages[stageId] = {
    status: 'running',
    retries: 0,
    startedAt,
    attempts: [{ index: 1, startedAt, status: 'running' }],
  };
  writeRunState(projectDir, currentRunId, state);
}

function waitThenReturnOnAbort(cleanDelayMs = 2_500): Adapter {
  return {
    name: 'abort-aware-test-adapter',
    detect: () => true,
    run: async (_prompt, _role, opts): Promise<RunResult> => new Promise((resolve) => {
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(cleanTimer);
        resolve(aborted
          ? { output: '[stage aborted]\n', exitCode: 137, duration_ms: 2_000 }
          : { output: 'completed normally\n', exitCode: 0, duration_ms: cleanDelayMs });
      };
      const cleanTimer = setTimeout(() => finish(false), cleanDelayMs);
      if (opts.abortSignal?.aborted) finish(true);
      else opts.abortSignal?.addEventListener('abort', () => finish(true), { once: true });
    }),
  };
}

function stageOptions() {
  return {
      artifactContract: fixtureArtifactContract(stageId),
    stageId,
    role,
    dependsOn: [] as string[],
    promptTemplate: 'perform the acceptance check',
    timeout_ms: 60_000,
    projectDir,
    runId: currentRunId,
    runDir: currentRunDir,
    retries: 0,
  };
}

describe('current-attempt watchdog facts', () => {
  it('distinguishes current-attempt verdict, handoff, and commit facts', () => {
    markRunningAttempt();
    writeFileSync(join(currentRunDir, `verdict_${stageId}.json`), '{"pass":false}\n');
    writeFileSync(join(currentRunDir, `handoff_${stageId}.md`), '## Delivered\nchecked\n');
    const status = readRunState(projectDir, currentRunId).stages[stageId];

    const facts = inspectStageExecutionFacts({
      runDir: currentRunDir,
      stageId,
      status,
      sinceMs: Date.now() - 1_000,
      commitObserved: true,
    });

    expect(facts).toMatchObject({
      attemptIndex: 1,
      verdictObserved: true,
      handoffObserved: true,
      commitObserved: true,
      protectedFromIdleAbort: true,
      finalizing: false,
    });
  });

  it('does not treat an earlier attempt output as a new finalization window', () => {
    const outputPath = join(currentRunDir, 'stages', stageId, 'output.md');
    writeFileSync(outputPath, 'old attempt output\n');
    const oldTime = new Date(Date.now() - 120_000);
    utimesSync(outputPath, oldTime, oldTime);
    const attemptOneStart = new Date(Date.now() - 180_000).toISOString();
    const attemptTwoStart = new Date(Date.now() - 60_000).toISOString();

    const facts = inspectStageExecutionFacts({
      runDir: currentRunDir,
      stageId,
      status: {
        status: 'running',
        retries: 0,
        attempts: [
          { index: 1, startedAt: attemptOneStart, completedAt: attemptTwoStart, status: 'failed' },
          { index: 2, startedAt: attemptTwoStart, status: 'running' },
        ],
      },
      sinceMs: Date.now() - 1_000,
    });

    expect(facts.outputObserved).toBe(false);
    expect(facts.finalizing).toBe(false);
    expect(facts.protectedFromIdleAbort).toBe(false);
  });

});

describe('attempt-scoped one-shot abort signals', () => {
  it('consumes a matching signal once so the next same-name attempt runs normally', async () => {
    vi.useFakeTimers();
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    atomicWrite(signalPath, JSON.stringify({
      version: 1,
      stageId,
      attemptIndex: 1,
      reason: 'verified idle stage',
      timestamp: new Date().toISOString(),
      source: 'watchdog',
    }));

    const firstRun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_000);
    const first = await firstRun;
    const signalAfterFirst = existsSync(signalPath);

    const secondRun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_500);
    const second = await secondRun;

    expect({ firstExit: first.exitCode, signalAfterFirst, secondExit: second.exitCode }).toEqual({
      firstExit: 137,
      signalAfterFirst: false,
      secondExit: 0,
    });
  });

  it('ignores, warns about, and removes an abort signal owned by an old attempt', async () => {
    vi.useFakeTimers();
    beginStageAttempt(projectDir, currentRunId, stageId, 0, '2026-08-01T00:00:00.000Z');
    completeStageAttempt(projectDir, currentRunId, stageId, 0, {
      exitCode: 0,
      duration_ms: 1,
      completedAt: '2026-08-01T00:00:01.000Z',
    });
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    atomicWrite(signalPath, JSON.stringify({
      version: 1,
      stageId,
      attemptIndex: 1,
      reason: 'belongs to attempt one',
      timestamp: '2026-08-01T00:00:00.500Z',
      source: 'supervisor',
    }));

    const rerun = runStage(waitThenReturnOnAbort(), stageOptions());
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await rerun;
    const liveLog = readFileSync(stageLiveLogPath(currentRunDir, stageId), 'utf-8');

    expect(result.exitCode).toBe(0);
    expect(existsSync(signalPath)).toBe(false);
    expect(liveLog).toMatch(/ignored stale stage abort signal/i);
    expect(liveLog).toContain('expected attempt 2');
    expect(liveLog).toContain('observed attempt 1');
  });

  it('keeps an owned archived supervisor signal authoritative when the adapter throws before the next poll', async () => {
    const signalPath = join(currentRunDir, 'signals', `abort_${stageId}.json`);
    const adapter: Adapter = {
      run: async () => {
        atomicWrite(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'arrived during a crashing adapter call',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        throw new Error('deterministic adapter crash');
      },
    };

    const result = await runStage(adapter, stageOptions());
    expect(result).toMatchObject({
      exitCode: 137,
      timedOut: false,
      timeoutTerminationCause: 'stage_abort',
    });
    expect(existsSync(signalPath)).toBe(false);
  });
});
