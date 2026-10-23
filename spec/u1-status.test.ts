import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTaskWithRunState } from '../src/cli-daemon.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun } from './test-support/create-run.js';
import { TaskRegistry } from '../src/task-registry.js';
import { RUN_STATUS, resolveRunStatus, taskDisplayStatus } from '../src/lifecycle-status.js';
import { fcGlobalDir, readOperationalRunState, readRunState, setFcGlobalDir, updateRunState, writeRunState, writeStageStatus } from '../src/store.js';

let root: string, project: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'u1-status-'));
  project = join(root, 'project');
  mkdirSync(project);
  previous = fcGlobalDir();
  setFcGlobalDir(join(root, 'fc'));
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

it('publishes cancellation with one spelling across storage, events, registry, RPC and task display', async () => {
  const run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  updateRunState(project, run.runId, state => { state.status = RUN_STATUS.RUNNING; });
  const stale = readRunState(project, run.runId);
  const registry = new TaskRegistry({ baseDir: join(root, 'fc') });
  const task = registry.create({ projectDir: project, run_id: run.runId, status: 'running' });
  const coordinator = new RunCancellationCoordinator({ registry,
    units: { isActive: async () => ({ kind: 'absent' as const }), stopUnit: async () => {} },
    timeoutMs: 0, signalGraceMs: 0,
  });
  expect(await coordinator.cancelTask(task.id)).toMatchObject({ ok: true, status: 'cancelled' });
  expect(JSON.parse(readFileSync(join(run.runDirPath, 'run.json'), 'utf8')).status).toBe('cancelled');
  expect(readRunEvents(project, run.runId).filter(event => event.type === 'run_status_changed').at(-1)?.runStatus).toBe('cancelled');
  const stored = registry.get(task.id)!;
  expect(stored.status).toBe('cancelled');
  const rpc = mergeTaskWithRunState(stored, join(root, 'fc', 'runs'));
  expect(rpc).toMatchObject({ status: 'cancelled', run: { status: 'cancelled', failureReason: 'Cancelled by user' } });
  expect(taskDisplayStatus(rpc.status, rpc.run?.status)).toBe('cancelled');
  // Acknowledged cancellation still fences snapshot, locked mutation and stage publication.
  expect(() => writeRunState(project, run.runId, stale)).toThrow('RUN_CANCELLED');
  expect(() => updateRunState(project, run.runId, state => { state.failureReason = 'stale publisher'; })).toThrow('RUN_CANCELLED');
  expect(() => writeStageStatus(project, run.runId, 'work', { status: 'complete', retries: 0 })).toThrow('RUN_CANCELLED');
});

it('projects the resumed complete outcome over a stale failed task (historical f341a0 shape)', () => {
  const run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
  updateRunState(project, run.runId, state => { state.status = RUN_STATUS.COMPLETE; state.completedAt = '2030-01-01T00:00:00Z'; });
  const registry = new TaskRegistry({ baseDir: join(root, 'fc') });
  const task = registry.create({ projectDir: project, run_id: run.runId, status: 'failed', notes: 'old attempt failed' });
  const rpc = mergeTaskWithRunState(task, join(root, 'fc', 'runs'));
  expect(rpc.status).toBe('failed');
  expect(rpc.run?.status).toBe('complete');
  expect(taskDisplayStatus(rpc.status, rpc.run?.status)).toBe('complete');
  for (const control of ['pending', 'deferred', 'running', 'cancelling', 'stuck', 'needs_summary']) {
    expect(taskDisplayStatus(control, rpc.run?.status)).toBe(control);
  }
});

it('reads stopped as cancelled without changing archived bytes or inferring success', () => {
  const run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
  const path = join(run.runDirPath, 'run.json');
  const archived = JSON.parse(readFileSync(path, 'utf8'));
  archived.status = 'stopped';
  archived.failureReason = 'Historical operator cancellation';
  writeFileSync(path, JSON.stringify(archived));
  const bytes = readFileSync(path, 'utf8');
  expect(readRunState(project, run.runId).status).toBe('cancelled');
  expect(readOperationalRunState(project, run.runId).status).toBe('cancelled');
  expect(resolveRunStatus('stopped')).toMatchObject({ kind: 'known', status: 'cancelled', semantics: { successful: false, resumable: true } });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(Object.values(RUN_STATUS)).not.toContain('stopped');
  expect(resolveRunStatus('awaiting_approval').kind).toBe('unknown');
  expect(resolveRunStatus('phase_complete').kind).toBe('unknown');
});
