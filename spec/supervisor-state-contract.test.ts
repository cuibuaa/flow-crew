/**
 * Regression invariant: every supervisor observation crosses one closed,
 * runtime-validated UnitStatus contract and cancellation never guesses that
 * an unobservable process is stopped.
 *
 * Maintenance contract: this is a permanent schema/routing regression suite,
 * not a run-specific gate artifact. Keep it active in the default Vitest set.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelRunThroughControlPlane,
  isCancellationResult,
  type LocalCancellationControl,
} from '../src/cancellation-client.js';
import { unitIsStopped, type CancellationResult } from '../src/run-control.js';
import { isUnitStatus, type UnitStatus } from '../src/supervision.js';

const repositoryRoot = join(import.meta.dirname, '..');

function source(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf-8');
}

function completeResult(runId = 'daemon-owned'): CancellationResult {
  return {
    ok: true,
    status: 'cancelled',
    runId,
    observation: {
      unit: 'flowcrew-task-1.service',
      unitState: { kind: 'terminal', exitCode: 0 },
      runReadable: true,
      schedulerPid: null,
      schedulerAlive: false,
      launchInFlight: false,
    },
    message: 'daemon confirmed cancellation',
  };
}

const FORMAL_SUPERVISION_SUITES = [
  'portable-supervision-safety.test.ts',
  'supervisor-state-contract.test.ts',
  'durable-supervision-backend.test.ts',
  'supervision-cli-surfaces.test.ts',
] as const;

describe('closed supervisor state contract', () => {
  it('declares exactly the six required UnitStatus discriminants', () => {
    const declaration = source('src/supervision.ts');
    const kinds = Array.from(declaration.matchAll(/\| \{ kind: '([^']+)'/g), (match) => match[1]);

    expect(kinds).toEqual([
      'active',
      'deactivating',
      'terminal',
      'terminal-unknown',
      'absent',
      'unobservable',
    ]);
  });

  it('accepts every well-formed UnitStatus member at the runtime boundary', () => {
    const members: UnitStatus[] = [
      { kind: 'active' },
      { kind: 'deactivating' },
      { kind: 'terminal', exitCode: 0 },
      { kind: 'terminal-unknown', reason: 'lost sentinel' },
      { kind: 'absent' },
      { kind: 'unobservable', reason: 'probe failed' },
    ];

    expect(members.map(isUnitStatus)).toEqual([true, true, true, true, true, true]);
  });

  it('rejects legacy strings and malformed escape values at the runtime boundary', () => {
    const invalid = [
      'inactive',
      { kind: 'terminal' },
      { kind: 'terminal', exitCode: -1 },
      { kind: 'terminal', exitCode: 1.5 },
      { kind: 'terminal-unknown' },
      { kind: 'unobservable', reason: 1 },
      { kind: 'invented' },
      null,
      [],
    ];

    expect(invalid.map(isUnitStatus)).toEqual(invalid.map(() => false));
  });

  it('maps only terminal, terminal-unknown, and absent to stopped', () => {
    const statuses: UnitStatus[] = [
      { kind: 'active' },
      { kind: 'deactivating' },
      { kind: 'terminal', exitCode: 3 },
      { kind: 'terminal-unknown', reason: 'shim vanished' },
      { kind: 'absent' },
      { kind: 'unobservable', reason: 'systemctl failed' },
    ];

    expect(statuses.map(unitIsStopped)).toEqual([false, false, true, true, true, false]);
  });

  it('returns a complete daemon result without invoking local control', async () => {
    const remote = completeResult();
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => { throw new Error('unexpected local task cancellation'); }),
      cancelRun: vi.fn(async () => { throw new Error('unexpected local run cancellation'); }),
    };

    const result = await cancelRunThroughControlPlane(remote.runId!, undefined, {
      sendRequest: vi.fn(async () => remote),
      localControl: local,
    });

    expect(result).toBe(remote);
    expect(local.cancel).not.toHaveBeenCalled();
    expect(local.cancelRun).not.toHaveBeenCalled();
  });

  it('keeps a valid unobservable daemon response fail closed without local fallback', async () => {
    const remote: CancellationResult = {
      ...completeResult('unobservable-run'),
      ok: false,
      status: 'cancelling',
      observation: {
        ...completeResult().observation,
        unitState: { kind: 'unobservable', reason: 'systemctl probe failed' },
      },
    };
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => { throw new Error('unexpected local task cancellation'); }),
      cancelRun: vi.fn(async () => { throw new Error('unexpected local run cancellation'); }),
    };

    const result = await cancelRunThroughControlPlane('unobservable-run', undefined, {
      sendRequest: vi.fn(async () => remote),
      localControl: local,
    });

    expect(result).toBe(remote);
    expect(unitIsStopped(result.observation.unitState)).toBe(false);
    expect(local.cancelRun).not.toHaveBeenCalled();
  });

  it('rejects a legacy string-shaped cancellation response', () => {
    const legacy = {
      ...completeResult(),
      observation: { ...completeResult().observation, unitState: 'inactive' },
    };

    expect(isCancellationResult(legacy, { runId: 'daemon-owned' })).toBe(false);
  });

  it('routes all six production backend calls through the shared contract', () => {
    const runControl = source('src/run-control.ts');
    const orchestrator = source('src/orchestrator.ts');
    const count = (text: string, needle: string): number => text.split(needle).length - 1;

    expect(runControl).toContain("import type { SupervisorBackend, UnitStatus } from './supervision.js'");
    expect(count(runControl, 'this.units.stopUnit(')).toBe(1);
    expect(count(runControl, 'this.units.isActive(')).toBe(1);
    expect(count(orchestrator, 'this.systemd.journalTail(')).toBe(1);
    expect(count(orchestrator, 'this.systemd.isActive(')).toBe(2);
    expect(count(orchestrator, 'this.systemd.runUnit(')).toBe(1);
  });

  it('keeps the stopped predicate compile-time exhaustive with never', () => {
    const runControl = source('src/run-control.ts');
    const start = runControl.indexOf('export function unitIsStopped');
    const end = runControl.indexOf('\n}\n\nfunction unitOwnsGracefulStop', start);
    const predicate = runControl.slice(start, end + 2);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(predicate).toContain('const _exhaustive: never = status');
  });

  it('routes every published runtime test backend through the shared contract', () => {
    const publicBackends = [
      ['spec/cancellation-liveness.test.ts', 'class FakeSystemd implements SupervisorBackend'],
      ['spec/entry-guards.test.ts', 'class CapturingSystemd implements SupervisorBackend'],
      ['spec/cancellation-park.test.ts', 'class FakeSystemd implements SupervisorBackend'],
      ['spec/orchestrator.test.ts', 'class FakeSystemd implements SupervisorBackend'],
    ] as const;

    for (const [path, declaration] of publicBackends) expect(source(path)).toContain(declaration);
  });

  it('keeps the four promoted probes discoverable, invariant-named, and documented', () => {
    const specDir = join(repositoryRoot, 'spec');
    const entries = readdirSync(specDir);

    expect(entries.filter((entry) => /^gate-phase\d+-verification\./.test(entry))).toEqual([]);
    for (const file of FORMAL_SUPERVISION_SUITES) {
      expect(entries).toContain(file);
      expect(file).toMatch(/\.test\.ts$/);
      const contents = readFileSync(join(specDir, file), 'utf-8');
      expect(contents).toMatch(/^\/\*\*[\s\S]*?Regression invariant:/);
      expect(contents).toMatch(/Maintenance contract:/);
    }
  });

  it('requires spawned supervision fixtures to publish PIDs only after spawn succeeds', () => {
    const durableSuite = source('spec/durable-supervision-backend.test.ts');
    const fixtureStart = durableSuite.indexOf("check('early shim exit cannot certify");
    const fixtureEnd = durableSuite.indexOf("check('GC removes only", fixtureStart);
    const fixture = durableSuite.slice(fixtureStart, fixtureEnd);
    const spawnReady = fixture.indexOf("child.once('spawn', resolveSpawn)");
    const spawnError = fixture.indexOf("child.once('error', rejectSpawn)");
    const pidWrite = fixture.indexOf('writeFileSync(${JSON.stringify(orphanPidPath)}, String(child.pid))');

    expect(fixtureStart).toBeGreaterThanOrEqual(0);
    expect(fixtureEnd).toBeGreaterThan(fixtureStart);
    expect(spawnReady).toBeGreaterThanOrEqual(0);
    expect(spawnError).toBeGreaterThanOrEqual(0);
    expect(pidWrite).toBeGreaterThan(spawnReady);
  });
});
