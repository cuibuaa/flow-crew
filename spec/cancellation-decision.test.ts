import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { SupervisorBackend, UnitStatus } from '../src/supervision.js';
import { TASK_LIST_STATUS, TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

class UnobservableUnits implements SupervisorBackend {
  stopCalls = 0;
  launchCalls = 0;

  async isActive(): Promise<UnitStatus> {
    return { kind: 'unobservable', reason: 'supervisor probe failed' };
  }

  async runUnit(): Promise<void> {
    this.launchCalls += 1;
    throw new Error('cancelled work must not launch');
  }

  async stopUnit(): Promise<void> { this.stopCalls += 1; }

  async journalTail(): Promise<string> { return ''; }
}

let root: string;
let registry: TaskRegistry;
let units: UnobservableUnits;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-cancel-decision-'));
  clock = Date.parse('2026-08-06T20:00:00.000Z');
  registry = new TaskRegistry({ baseDir: root, now: () => new Date(clock) });
  units = new UnobservableUnits();
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function coordinator(): RunCancellationCoordinator {
  return new RunCancellationCoordinator({
    registry, units, now: () => new Date(clock), clockMs: () => clock,
    timeoutMs: 0, signalGraceMs: 0,
  });
}

describe('durable operator cancellation decision', () => {
  it.each([TASK_STATUS.RUNNING, TASK_STATUS.DEFERRED])('closes %s work while reporting unresolved process evidence', async status => {
    const task = registry.create({
      brief_text: 'operator cancellation fixture', projectDir: root, status,
      not_before: new Date(clock + 60_000).toISOString(), defer_kind: 'retry',
    });

    const result = await coordinator().cancelTask(task.id);

    expect(result).toMatchObject({
      ok: true, status: 'cancelled',
      observation: { unitState: { kind: 'unobservable', reason: 'supervisor probe failed' } },
    });
    expect(result.message).toMatch(/unobservable|unconfirmed|not confirmed|unknown/i);
    expect(registry.get(task.id)).toMatchObject({
      status: TASK_STATUS.CANCELLED, completed_at: new Date(clock).toISOString(),
    });
    expect(registry.get(task.id)?.not_before).toBeUndefined();
    expect(registry.get(task.id)?.defer_kind).toBeUndefined();
    expect(registry.list({ status: TASK_LIST_STATUS.ACTIVE })).toEqual([]);

    clock += 5 * 60_000;
    await expect(coordinator().cancelTask(task.id)).resolves.toMatchObject({ ok: true, status: 'cancelled' });
    await new Orchestrator({ registry, systemd: units, git: {} as never, now: () => new Date(clock) }).tickOnce();
    expect(units.launchCalls).toBe(0);
    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLED);
    expect(registry.list({ status: TASK_LIST_STATUS.ACTIVE })).toEqual([]);
  });

  it('ignores a persisted observation limit when the operator closes unfinished cancellation', async () => {
    const task = registry.create({ projectDir: root, status: TASK_STATUS.CANCELLING });
    // Old registries retain these fields after upgrading; they carry no authority
    // to reject a later operator decision.
    const legacy = {
      notes: 'prior cancellation observation limit reached',
      cancellation_unobservable_count: 10,
      cancellation_unobservable_first_at: new Date(clock - 5 * 60_000).toISOString(),
      cancellation_unobservable_reason: 'supervisor probe failed',
      cancellation_observation_limit_reached_at: new Date(clock).toISOString(),
    };
    registry.update(task.id, legacy);

    await expect(coordinator().cancelTask(task.id)).resolves.toMatchObject({ ok: true, status: 'cancelled' });
    expect(registry.get(task.id)?.status).toBe(TASK_STATUS.CANCELLED);
    expect(registry.list({ status: TASK_LIST_STATUS.ACTIVE })).toEqual([]);
    await expect(coordinator().cancelTask(task.id)).resolves.toMatchObject({ ok: true, status: 'cancelled' });
  });
});
