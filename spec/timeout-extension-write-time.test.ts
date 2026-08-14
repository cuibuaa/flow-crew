import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { parseTimeoutExtensionRequest, type TimeoutExtensionRequestV1 } from '../src/runtime-negotiation.js';
import {
  evaluateTimeoutExtensionRequest,
  runStage,
  type TimeoutExtensionPolicyInput,
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
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadlineMs <= this.monotonicMs)
      .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs);
    for (const [timerId, timer] of due) {
      this.timers.delete(timerId);
      timer.callback();
    }
  }
}

function request(overrides: Record<string, unknown> = {}): TimeoutExtensionRequestV1 {
  const parsed = parseTimeoutExtensionRequest({
    version: 1,
    kind: 'timeout_extension',
    requestId: 'write-time-policy',
    stageId: 'work',
    attemptIndex: 1,
    requestedExtensionMs: 50,
    reason: 'verified work remains',
    ...overrides,
  }, 'stage');
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.request;
}

function evaluate(
  candidate: TimeoutExtensionRequestV1,
  overrides: Partial<Omit<TimeoutExtensionPolicyInput, 'request'>> = {},
) {
  return evaluateTimeoutExtensionRequest({
    request: candidate,
    attemptStartedWallMs: ATTEMPT_STARTED_WALL_MS,
    attemptElapsedMs: 25,
    effectiveBudgetMs: 100,
    supervisorAborted: false,
    attemptAborted: false,
    deadlineAborted: false,
    ...overrides,
  });
}

describe('legacy timeout-extension write-time policy', () => {
  it('rejects pre-deadline and legacy requests without changing their parsed audit timing', () => {
    const persisted = evaluate(request({ requestedAt: '2030-01-01T00:00:00.025Z' }));
    expect(persisted).toMatchObject({
      accepted: false,
      grantedExtensionMs: 0,
      timingBasis: 'requested_at',
      adjudicatedAttemptElapsedMs: 25,
      requestedAtAttemptElapsedMs: 25,
      rejectionReason: 'running attempt deadlines are immutable; edit config/defaults.yaml::default_timeout_ms before launch',
    });

    const legacy = evaluate(request());
    expect(legacy).toMatchObject({
      accepted: false,
      grantedExtensionMs: 0,
      timingBasis: 'legacy_consumption',
      adjudicatedAttemptElapsedMs: 25,
      rejectionReason: 'running attempt deadlines are immutable; edit config/defaults.yaml::default_timeout_ms before launch',
    });
  });

  it('keeps a current-attempt ABORT authoritative in the rejection audit', () => {
    expect(evaluate(request(), { supervisorAborted: true })).toMatchObject({
      accepted: false,
      rejectionReason: 'a current-attempt ABORT already exists',
    });
  });

  it('preserves supervisor requestedAt metadata through legacy v1 parsing', () => {
    const parsed = parseTimeoutExtensionRequest({
      version: 1,
      kind: 'timeout_extension',
      requestId: 'supervisor-write-time',
      stageId: 'work',
      attemptIndex: 1,
      requestedAt: '2030-01-01T00:00:00.025Z',
      requestedExtensionMs: 50,
      reason: 'verified work remains',
    }, 'supervisor');

    expect(parsed).toMatchObject({
      ok: true,
      request: { requestedBy: 'supervisor', requestedAt: '2030-01-01T00:00:00.025Z' },
    });
  });

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
