import { atomicWrite } from '../src/engine-fs.js';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { stageWrapUpTiming, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { createRun } from './test-support/create-run.js';
import {
  fcGlobalDir,
  readStageStatus,
  setFcGlobalDir,
} from '../src/store.js';
import { runStage } from '../src/worker.js';

const role: AgentConfig = {
  name: 'deadline-starvation-fixture',
  description: 'blocks the event loop past the immutable attempt budget',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
};

let projectRoot: string;
let stateRoot: string;
let previousStateRoot: string;

function settlementClock() {
  let elapsed = 0;
  const startedWall = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const clock: AttemptDeadlineClock = {
    monotonicNow: () => elapsed,
    wallNow: () => startedWall + elapsed,
    setTimer(callback, delay) {
      const timer = {} as ReturnType<typeof setTimeout>;
      timers.set(timer, { at: elapsed + delay, callback });
      return timer;
    },
    clearTimer: timer => { timers.delete(timer); },
  };
  return { clock, advance(ms: number, fireTimers = false) {
    elapsed += ms;
    if (!fireTimers) return;
    for (const [timer, { at, callback }] of timers) {
      if (at > elapsed) continue;
      timers.delete(timer);
      callback();
    }
  } };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'attempt-deadline-wip-project-'));
  stateRoot = mkdtempSync(join(tmpdir(), 'attempt-deadline-wip-state-'));
  previousStateRoot = fcGlobalDir();
  setFcGlobalDir(stateRoot);
});

afterEach(() => {
  setFcGlobalDir(previousStateRoot);
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('bounded stage wrap-up and cancellation regressions', () => {
  it('F03 retains an exit-zero settlement after starved hard-stop expiry as forced continuation', { timeout: 10_000 }, async () => {
    const stageId = 'starved_deadline';
    const created = createRun(projectRoot, 'starved-deadline', 'name: starved-deadline', [stageId]);
    const budgetMs = 40;
    const home = join(created.runDirPath, 'stages', stageId, 'codex_home');
    let adapterStarted = false;
    const { clock: deadlineClock, advance } = settlementClock();
    const adapter: Adapter = {
      async run() {
        adapterStarted = true;
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'fixture-thread.json'), '{"messages":["needed thread context"]}');
        // Advance past the deadline while leaving its callback pending.
        advance(stageWrapUpTiming(budgetMs).hardLimitMs + 80);
        return { output: 'late success', exitCode: 0, duration_ms: 120, sessionId: '123e4567-e89b-42d3-a456-426614174000' };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline starvation fixture',
      deadlineClock,
      artifactContract: emptyArtifactContract(),
      timeout_ms: budgetMs,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, continuation: { forced: true } });
    expect(adapterStarted).toBe(true);
    expect(existsSync(home)).toBe(true);
    expect(status).toMatchObject({
      status: 'complete',
      attempts: [expect.objectContaining({ terminationCause: 'exit' })],
      timeout: {
        budgetMs,
        remainingMs: 0,
        deadlineReachedAt: expect.any(String),
        deadlineOverrunMs: expect.any(Number),
      },
    });
    expect(status.timeout?.deadlineOverrunMs).toBeGreaterThan(0);
  });

  it('QA16 retains a rejected settlement after starved hard-stop expiry as forced continuation', { timeout: 10_000 }, async () => {
    const stageId = 'starved_rejection';
    const created = createRun(projectRoot, 'starved-rejection', 'name: starved-rejection', [stageId]);
    const budgetMs = 40;
    const { clock: deadlineClock, advance } = settlementClock();
    const adapter: Adapter = {
      async run() {
        advance(stageWrapUpTiming(budgetMs).hardLimitMs + 80);
        throw new Error('late adapter rejection');
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline-starved rejection fixture',
      deadlineClock,
      artifactContract: emptyArtifactContract(),
      timeout_ms: budgetMs,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, continuation: { forced: true } });
    expect(status).toMatchObject({
      status: 'complete',
      attempts: [expect.objectContaining({ terminationCause: 'exit' })],
      timeout: {
        budgetMs,
        deadlineReachedAt: expect.any(String),
      },
    });
  });

  it('QA17 keeps a current-attempt watchdog ABORT authoritative at starved settlement', { timeout: 10_000 }, async () => {
    const stageId = 'starved_stage_abort';
    const created = createRun(projectRoot, 'starved-watchdog-abort', 'name: starved-watchdog-abort', [stageId]);
    const signalDirectory = join(created.runDirPath, 'signals');
    const signalPath = join(signalDirectory, `abort_${stageId}.json`);
    mkdirSync(signalDirectory, { recursive: true });
    const { clock: deadlineClock, advance } = settlementClock();
    const adapter: Adapter = {
      async run() {
        advance(stageWrapUpTiming(40).hardLimitMs + 80);
        atomicWrite(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'authoritative starved watchdog abort',
          timestamp: new Date(deadlineClock.wallNow()).toISOString(),
          source: 'watchdog',
        }));
        return { output: 'late success', exitCode: 0, duration_ms: 120, sessionId: '123e4567-e89b-42d3-a456-426614174000' };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'starved watchdog ABORT fixture',
      deadlineClock,
      artifactContract: emptyArtifactContract(),
      timeout_ms: 40,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({
      exitCode: 137,
      timedOut: false,
      terminationCause: 'stage_abort',
    });
    expect(status).toMatchObject({
      status: 'failed',
      attempts: [expect.objectContaining({ terminationCause: 'stage_abort' })],
    });
  });

  it('QA18 normalizes exit telemetry when watchdog ABORT arrives after deadline but before settlement', { timeout: 10_000 }, async () => {
    const stageId = 'deadline_then_stage_abort';
    const created = createRun(projectRoot, 'deadline-then-watchdog', 'name: deadline-then-watchdog', [stageId]);
    const signalDirectory = join(created.runDirPath, 'signals');
    const signalPath = join(signalDirectory, `abort_${stageId}.json`);
    mkdirSync(signalDirectory, { recursive: true });
    const { clock: deadlineClock, advance } = settlementClock();
    const adapter: Adapter = {
      async run() {
        advance(stageWrapUpTiming(40).hardLimitMs + 80, true);
        atomicWrite(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'authoritative abort after deadline signal',
          timestamp: new Date(deadlineClock.wallNow()).toISOString(),
          source: 'watchdog',
        }));
        return { output: 'settled after both signals', exitCode: 0, duration_ms: 80 };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline then watchdog ABORT fixture',
      deadlineClock,
      artifactContract: emptyArtifactContract(),
      timeout_ms: 40,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({
      exitCode: 137,
      timedOut: false,
      terminationCause: 'stage_abort',
    });
    expect(status).toMatchObject({
      status: 'failed',
      attempts: [expect.objectContaining({ terminationCause: 'stage_abort' })],
    });
  });
});
