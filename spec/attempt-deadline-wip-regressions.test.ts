import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import {
  createRun,
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

describe('immutable attempt deadline regressions', () => {
  it('F03 classifies an exit-zero adapter settlement after timer starvation as attempt_timeout', { timeout: 10_000 }, async () => {
    const stageId = 'starved_deadline';
    const created = createRun(projectRoot, 'starved-deadline', 'name: starved-deadline', [stageId]);
    const budgetMs = 40;
    const adapter: Adapter = {
      async run() {
        const blockedUntil = performance.now() + 120;
        while (performance.now() < blockedUntil) {
          // Deliberately prevent the already-due timer callback from running.
        }
        return { output: 'late success', exitCode: 0, duration_ms: 120 };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline starvation fixture',
      timeout_ms: budgetMs,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(status).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/timed out/iu),
      timeout: {
        budgetMs,
        remainingMs: 0,
        terminationCause: 'attempt_timeout',
        deadlineReachedAt: expect.any(String),
        deadlineOverrunMs: expect.any(Number),
      },
    });
    expect(status.timeout?.deadlineOverrunMs).toBeGreaterThan(0);
  });

  it('QA16 classifies a rejected adapter settlement after timer starvation as attempt_timeout', { timeout: 10_000 }, async () => {
    const stageId = 'starved_rejection';
    const created = createRun(projectRoot, 'starved-rejection', 'name: starved-rejection', [stageId]);
    const budgetMs = 40;
    const adapter: Adapter = {
      async run() {
        const blockedUntil = performance.now() + 120;
        while (performance.now() < blockedUntil) {
          // Deliberately prevent the already-due timer callback from running.
        }
        throw new Error('late adapter rejection');
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline-starved rejection fixture',
      timeout_ms: budgetMs,
      projectDir: projectRoot,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    const status = readStageStatus(projectRoot, created.runId, stageId);

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(status).toMatchObject({
      status: 'failed',
      timeout: {
        budgetMs,
        terminationCause: 'attempt_timeout',
        deadlineReachedAt: expect.any(String),
      },
    });
  });

  it('QA17 keeps a current-attempt supervisor ABORT authoritative at starved settlement', { timeout: 10_000 }, async () => {
    const stageId = 'starved_supervisor_abort';
    const created = createRun(projectRoot, 'starved-supervisor-abort', 'name: starved-supervisor-abort', [stageId]);
    const signalDirectory = join(created.runDirPath, 'signals');
    const signalPath = join(signalDirectory, `abort_${stageId}.json`);
    mkdirSync(signalDirectory, { recursive: true });
    const adapter: Adapter = {
      async run() {
        const blockedUntil = performance.now() + 120;
        while (performance.now() < blockedUntil) {
          // Deliberately prevent both the deadline and ABORT poll timers.
        }
        writeFileSync(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'authoritative starved supervisor abort',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        return { output: 'late success', exitCode: 0, duration_ms: 120 };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'starved supervisor ABORT fixture',
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
      timeoutTerminationCause: 'supervisor_abort',
    });
    expect(status).toMatchObject({
      status: 'failed',
      timeout: { terminationCause: 'supervisor_abort' },
    });
  });

  it('QA18 normalizes exit telemetry when supervisor ABORT arrives after deadline but before settlement', { timeout: 10_000 }, async () => {
    const stageId = 'deadline_then_supervisor_abort';
    const created = createRun(projectRoot, 'deadline-then-supervisor', 'name: deadline-then-supervisor', [stageId]);
    const signalDirectory = join(created.runDirPath, 'signals');
    const signalPath = join(signalDirectory, `abort_${stageId}.json`);
    mkdirSync(signalDirectory, { recursive: true });
    const adapter: Adapter = {
      async run() {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
        writeFileSync(signalPath, JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'authoritative abort after deadline signal',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        return { output: 'settled after both signals', exitCode: 0, duration_ms: 80 };
      },
    };

    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'deadline then supervisor ABORT fixture',
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
      timeoutTerminationCause: 'supervisor_abort',
    });
    expect(status).toMatchObject({
      status: 'failed',
      timeout: { terminationCause: 'supervisor_abort' },
    });
  });
});
