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
import { TechnicalChainController, type TechnicalChainClock } from '../src/technical-chain.js';
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

class ManualTechnicalChainClock implements TechnicalChainClock {
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
    attemptElapsedMs: 125,
    effectiveBudgetMs: 100,
    maxAttemptBudgetMs: 300,
    hardRemainingMs: 175,
    supervisorAborted: false,
    attemptAborted: false,
    hardCapAborted: false,
    ...overrides,
  });
}

describe('timeout-extension persisted write-time policy', () => {
  it('accepts a request persisted before the soft deadline even when consumed after it', () => {
    const candidate = request({ requestedAt: '2030-01-01T00:00:00.099Z' });

    expect(evaluate(candidate)).toMatchObject({
      accepted: true,
      grantedExtensionMs: 50,
      timingBasis: 'requested_at',
      adjudicatedAttemptElapsedMs: 99,
      requestedAtAttemptElapsedMs: 99,
    });
    expect(candidate.requestedAt).toBe('2030-01-01T00:00:00.099Z');
  });

  it('rejects a request whose persisted time is at the soft deadline', () => {
    const decision = evaluate(request({ requestedAt: '2030-01-01T00:00:00.100Z' }));

    expect(decision).toMatchObject({
      accepted: false,
      grantedExtensionMs: 0,
      timingBasis: 'requested_at',
      adjudicatedAttemptElapsedMs: 100,
      rejectionReason: 'request arrived at or after the effective soft deadline',
    });
  });

  it('keeps legacy v1 requests on consumption-time semantics when requestedAt is absent', () => {
    const legacy = request();
    expect('requestedAt' in legacy).toBe(false);

    expect(evaluate(legacy)).toMatchObject({
      accepted: false,
      timingBasis: 'legacy_consumption',
      adjudicatedAttemptElapsedMs: 125,
      rejectionReason: 'request arrived at or after the effective soft deadline',
    });
    expect(evaluate(legacy, { attemptElapsedMs: 99 })).toMatchObject({
      accepted: true,
      grantedExtensionMs: 50,
      timingBasis: 'legacy_consumption',
      adjudicatedAttemptElapsedMs: 99,
    });
  });

  it('preserves the existing supervisor requestedAt field through v1 parsing', () => {
    const parsed = parseTimeoutExtensionRequest({
      version: 1,
      kind: 'timeout_extension',
      requestId: 'supervisor-write-time',
      stageId: 'work',
      attemptIndex: 1,
      requestedAt: '2030-01-01T00:00:00.099Z',
      requestedExtensionMs: 50,
      reason: 'verified work remains',
    }, 'supervisor');

    expect(parsed).toMatchObject({
      ok: true,
      request: { requestedBy: 'supervisor', requestedAt: '2030-01-01T00:00:00.099Z' },
    });
  });

  async function persistedTerminationCause(exhaustHardCapDuringSettlement: boolean) {
    const stageId = exhaustHardCapDuringSettlement ? 'hard_timeout' : 'soft_timeout';
    const created = createRun(projectDir, 'write-time-accounting', 'name: write-time-accounting', [stageId]);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    const clock = new ManualTechnicalChainClock();
    const chain = new TechnicalChainController({
      initialBudgetMs: 50,
      hardTotalMs: 100,
      ledgerDir: join(created.runDirPath, 'stages', stageId),
      clock,
    });
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      return new Promise<RunResult>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => {
          const settle = () => resolve({ output: 'cancelled', exitCode: 137, duration_ms: clock.monotonicNow() });
          if (exhaustHardCapDuringSettlement) setImmediate(() => { clock.advance(50); settle(); });
          else settle();
        }, { once: true });
        setImmediate(() => clock.advance(50));
      });
    } };

    try {
      await runStage(adapter, {
        stageId,
        role,
        dependsOn: [],
        promptTemplate: 'accounting fixture',
        timeout_ms: 50,
        timeout_total_ms: 100,
        technicalChain: chain,
        projectDir,
        runId: created.runId,
        runDir: created.runDirPath,
        retries: 0,
      });
      return readStageStatus(projectDir, created.runId, stageId).timeout?.terminationCause;
    } finally {
      chain.dispose();
    }
  }

  it('persists hard-cap exhaustion as hard and an unextended soft deadline as soft', async () => {
    await expect(persistedTerminationCause(true)).resolves.toBe('hard_cap_timeout');
    await expect(persistedTerminationCause(false)).resolves.toBe('soft_timeout');
  });
});
