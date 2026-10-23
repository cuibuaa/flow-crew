import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as liveness from '../src/process-liveness.js';
import { findLiveRunOwnerForProject, inspectRunScheduler, invalidateRunLockCache, isProjectBusy, schedulerProcessIsAliveForCancellation, processStartToken, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { cmdPrune, pruneRunWorkAreas } from '../src/run-retention.js';
import { fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';
import { createWatchState, pollWatch } from '../src/watch.js';

let previous: string, project: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'm11b-identity-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc-home'));
  invalidateRunLockCache();
});
afterEach(() => {
  invalidateRunLockCache(); setFcGlobalDir(previous); vi.restoreAllMocks();
});

function fixture(runId: string, status = 'complete'): string {
  const path = join(runsRoot(), runId); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'run.json'), JSON.stringify({ runId, projectDir: project, workflowName: 'm11b', status,
    startedAt: '2026-10-01T00:00:00.000Z', stages: {} }));
  writeFileSync(join(path, 'scheduler.pid'), String(process.pid));
  writeSchedulerProcessIdentity(path, runId, process.pid);
  return path;
}

describe('scheduler identity policies', () => {
  it('keeps an unreadable scheduler identity busy and preserves its run during clean', () => {
    const runId = 'unreadable-owner', path = fixture(runId);
    const before = readFileSync(join(path, 'run.json'), 'utf8');
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(undefined);
    expect(inspectRunScheduler(runId, path).kind).toBe('unverifiable');
    expect(schedulerProcessIsAliveForCancellation(process.pid, runId, path)).toBe(true);
    expect(findLiveRunOwnerForProject(project)).toMatchObject({ runId, pid: process.pid });
    expect(isProjectBusy(project)).toBe(`${runId}, scheduler pid ${process.pid}`);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(readFileSync(join(path, 'run.json'), 'utf8')).toBe(before);
  });

  it('retains occupancy when the persisted scheduler identity is corrupt', () => {
    const runId = 'corrupt-owner', path = fixture(runId);
    writeFileSync(join(path, 'scheduler.identity.json'), '{');
    expect(inspectRunScheduler(runId, path).kind).toBe('corrupt');
    expect(findLiveRunOwnerForProject(project)).toMatchObject({ runId, pid: process.pid });
    expect(isProjectBusy(project)).toBe(`${runId}, scheduler pid ${process.pid}`);
  });

  it('does not count a recycled scheduler PID as live work in watch', () => {
    const runId = 'recycled-owner', path = fixture(runId, 'running');
    const token = processStartToken(process.pid)!;
    writeFileSync(join(path, 'scheduler.identity.json'), JSON.stringify({ version: 2, pid: process.pid, runId,
      startToken: { kind: token.kind, value: token.kind === 'linux' ? String(BigInt(token.value) + 1n) : `${token.value} stale` } }));
    expect(inspectRunScheduler(runId, path).kind).toBe('reused');
    expect(schedulerProcessIsAliveForCancellation(process.pid, runId, path)).toBe(false);
    expect(pollWatch(createWatchState(), { runsRoot: runsRoot(), candidateRunIds: () => [runId] }).stats.liveRuns).toBe(0);
    expect(findLiveRunOwnerForProject(project)).toBeNull();
    expect(isProjectBusy(project)).toBeNull();
  });

  it('keeps cancellation closed when the scheduler marker disappears before its live process exits', () => {
    const runId = 'released-marker', path = fixture(runId);
    unlinkSync(join(path, 'scheduler.pid'));
    expect(schedulerProcessIsAliveForCancellation(process.pid, runId, path)).toBe(true);
  });

  it('still rejects prune and clean for a live scheduler and counts it in watch', () => {
    const runId = 'live-owner', path = fixture(runId);
    expect(inspectRunScheduler(runId, path).kind).toBe('live');
    expect(() => pruneRunWorkAreas(path, { dryRun: true })).toThrow('RETENTION_PROCESS: scheduler is live');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(existsSync(join(path, 'run.json'))).toBe(true);
    const state = JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')); state.status = 'running';
    writeFileSync(join(path, 'run.json'), JSON.stringify(state));
    expect(pollWatch(createWatchState(), { runsRoot: runsRoot(), candidateRunIds: () => [runId] }).stats.liveRuns).toBe(1);
  });
});
