import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CancellationObservationLimitError,
  RunCancellationCoordinator,
} from '../src/run-control.js';
import type { SupervisorBackend, UnitStatus } from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

class UnobservableUnits implements SupervisorBackend {
  stopCalls = 0;

  async isActive(): Promise<UnitStatus> {
    return { kind: 'unobservable', reason: 'systemctl probe failed' };
  }

  async runUnit(): Promise<void> {}

  async stopUnit(): Promise<void> {
    this.stopCalls += 1;
  }

  async journalTail(): Promise<string> { return ''; }
}

let root: string;
let registry: TaskRegistry;
let units: UnobservableUnits;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-cancel-budget-'));
  clock = Date.parse('2026-08-06T20:00:00.000Z');
  registry = new TaskRegistry({ baseDir: root, now: () => new Date(clock) });
  units = new UnobservableUnits();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function coordinator(maxCount: number, maxDurationMs = 5 * 60_000): RunCancellationCoordinator {
  return new RunCancellationCoordinator({
    registry,
    units,
    now: () => new Date(clock),
    clockMs: () => clock,
    timeoutMs: 0,
    signalGraceMs: 0,
    maxUnobservableObservations: maxCount,
    maxUnobservableDurationMs: maxDurationMs,
  });
}

function createRunningTask(): number {
  return registry.create({
    brief_text: 'unobservable cancellation budget fixture',
    projectDir: root,
    status: TASK_STATUS.RUNNING,
  }).id;
}

describe('durable cancellation observation ceiling', () => {
  it('survives coordinator recreation, becomes a named hard error, and leaves the task out of the retry sweep', async () => {
    const taskId = createRunningTask();

    await expect(coordinator(3).cancelTask(taskId)).resolves.toMatchObject({ ok: false, status: 'cancelling' });
    clock += 30_000;
    await expect(coordinator(3).cancelTask(taskId)).resolves.toMatchObject({ ok: false, status: 'cancelling' });
    clock += 30_000;
    await expect(coordinator(3).cancelTask(taskId)).rejects.toMatchObject({
      name: 'CancellationObservationLimitError',
      code: 'FLOWCREW_CANCELLATION_OBSERVATION_LIMIT',
      observations: 3,
    });

    expect(registry.get(taskId)).toMatchObject({
      status: TASK_STATUS.STUCK,
      cancellation_unobservable_count: 3,
      cancellation_observation_limit_reached_at: new Date(clock).toISOString(),
    });
    const stopCallsAtLimit = units.stopCalls;
    await expect(coordinator(3).cancelTask(taskId)).rejects.toBeInstanceOf(CancellationObservationLimitError);
    expect(units.stopCalls).toBe(stopCallsAtLimit);
  });

  it('also caps one continuously unobservable state after five minutes', async () => {
    const taskId = createRunningTask();
    await expect(coordinator(100).cancelTask(taskId)).resolves.toMatchObject({ ok: false });

    clock += 5 * 60_000;
    await expect(coordinator(100).cancelTask(taskId)).rejects.toThrow(/Automatic retries stopped/);
    expect(registry.get(taskId)?.status).toBe(TASK_STATUS.STUCK);
  });
});
