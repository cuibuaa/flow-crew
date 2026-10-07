import { drainDueTimers } from './test-support/engine-fixtures.js';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import {
  runStage,
} from '../src/worker.js';
import type { AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { createRun, fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';

const ATTEMPT_STARTED_WALL_MS = Date.parse('2030-01-01T00:00:00.000Z');
const role: AgentConfig = {
  name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture',
};

let projectDir: string;
let isolatedStateDir: string;
let previousStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-write-time-project-'));
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'flowcrew-write-time-state-'));
  previousStateDir = fcGlobalDir();
  setFcGlobalDir(isolatedStateDir);
});

afterEach(() => {
  setFcGlobalDir(previousStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

class ManualAttemptDeadlineClock implements AttemptDeadlineClock {
  private monotonicMs = 0;
  private wallMs = ATTEMPT_STARTED_WALL_MS;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { deadlineMs: number; callback: () => void }>();

  monotonicNow(): number { return this.monotonicMs; }
  wallNow(): number { return this.wallMs; }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, { deadlineMs: this.monotonicMs + delayMs, callback });
    return timerId as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(elapsedMs: number): void {
    this.monotonicMs += elapsedMs;
    this.wallMs += elapsedMs;
    drainDueTimers(this.timers, this.monotonicMs);
  }
}

describe('immutable attempt deadline settlement', () => {
  async function persistedTerminationCause(settleAfterDeadline: boolean) {
    const stageId = settleAfterDeadline ? 'late_settlement' : 'prompt_settlement';
    const created = createRun(projectDir, 'deadline-accounting', 'name: deadline-accounting', [stageId]);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    const clock = new ManualAttemptDeadlineClock();
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      return new Promise<RunResult>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => {
          if (settleAfterDeadline) clock.advance(50);
          resolve({ output: 'cancelled', exitCode: 137, duration_ms: clock.monotonicNow() });
        }, { once: true });
        setImmediate(() => clock.advance(50));
      });
    } };

    await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'accounting fixture',
      artifactContract: emptyArtifactContract(),
      timeout_ms: 50,
      deadlineClock: clock,
      projectDir,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
    });
    return readStageStatus(projectDir, created.runId, stageId).timeout?.terminationCause;
  }

  it('keeps the same attempt-timeout cause while child settlement is observed', async () => {
    await expect(persistedTerminationCause(true)).resolves.toBe('attempt_timeout');
    await expect(persistedTerminationCause(false)).resolves.toBe('attempt_timeout');
  });
});
