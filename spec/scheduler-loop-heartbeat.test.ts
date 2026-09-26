import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schedulerLoopIsStalled } from '../src/dashboard.js';
import {
  observeSchedulerHeartbeatOnce,
  startSchedulerHeartbeat,
  SCHEDULER_LOOP_STALL_FILE,
} from '../src/scheduler-heartbeat.js';
import { createRun } from '../src/store.js';
import { removeSchedulerProcessIdentity, writeSchedulerProcessIdentity } from '../src/run-lock.js';

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { readFileSync(path); return; } catch { /* wait */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('independent scheduler-loop heartbeat', () => {
  it('warns durably while run truth stays running, then clears only the current warning on recovery', () => {
    const projectDir = process.env.FLOWCREW_VITEST_ROOT!;
    const created = createRun(projectDir, 'heartbeat', 'name: heartbeat', []);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    writeSchedulerProcessIdentity(created.runDirPath, created.runId);
    const handle = startSchedulerHeartbeat({
      runPath: created.runDirPath,
      runId: created.runId,
      intervalMs: 60_000,
      stallThresholdMs: 100,
      observerPollMs: 10,
      spawnObserver: false,
    });
    try {
      const heartbeat = JSON.parse(readFileSync(join(created.runDirPath, 'scheduler-heartbeat.json'), 'utf-8')) as { updatedAt: string };
      const stalledAt = Date.parse(heartbeat.updatedAt) + 101;
      expect(observeSchedulerHeartbeatOnce({
        runPath: created.runDirPath, runId: created.runId, thresholdMs: 100, nowMs: stalledAt,
      })).toBe('stalled');
      expect(schedulerLoopIsStalled(projectDir, created.runId)).toBe(true);
      expect(JSON.parse(readFileSync(join(created.runDirPath, 'run.json'), 'utf-8')).status).toBe('running');

      handle.pulse();
      expect(observeSchedulerHeartbeatOnce({
        runPath: created.runDirPath, runId: created.runId, thresholdMs: 100, nowMs: Date.now(),
      })).toBe('healthy');
      expect(schedulerLoopIsStalled(projectDir, created.runId)).toBe(false);
      const events = readFileSync(join(created.runDirPath, 'events.jsonl'), 'utf-8');
      expect(events).toContain('scheduler_loop_stalled');
      expect(events).toContain('scheduler_loop_recovered');
    } finally {
      handle.stop();
      removeSchedulerProcessIdentity(created.runDirPath, process.pid);
    }
  });

  it('an independent observer thread fires while an unrelated synchronous operation blocks the scheduler loop', async () => {
    const root = join(process.env.FLOWCREW_VITEST_ROOT!, 'generic-block');
    const projectDir = join(root, 'project');
    const runPath = join(root, 'run');
    const readyPath = join(root, 'ready');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(runPath, { recursive: true });
    const runId = 'generic-block-run';
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId, workflowName: 'block', projectDir, status: 'running', stages: {}, startedAt: new Date().toISOString(),
    }));
    const heartbeatUrl = pathToFileURL(join(process.cwd(), 'src', 'scheduler-heartbeat.ts')).href;
    const lockUrl = pathToFileURL(join(process.cwd(), 'src', 'run-lock.ts')).href;
    const source = [
      `import { writeFileSync } from 'node:fs';`,
      `import { startSchedulerHeartbeat } from ${JSON.stringify(heartbeatUrl)};`,
      `import { writeSchedulerProcessIdentity, removeSchedulerProcessIdentity } from ${JSON.stringify(lockUrl)};`,
      `const runPath=${JSON.stringify(runPath)}; const runId=${JSON.stringify(runId)};`,
      `writeFileSync(runPath + '/scheduler.pid', String(process.pid));`,
      `writeSchedulerProcessIdentity(runPath, runId);`,
      `const heartbeat=startSchedulerHeartbeat({runPath,runId,intervalMs:20,stallThresholdMs:100,observerPollMs:10});`,
      `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);`,
      `heartbeat.stop(); removeSchedulerProcessIdentity(runPath, process.pid);`,
    ].join('\n');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
      stdio: 'ignore',
    });
    await waitFor(readyPath, 2_000);
    await waitFor(join(runPath, SCHEDULER_LOOP_STALL_FILE), 2_000);
    const warning = JSON.parse(readFileSync(join(runPath, SCHEDULER_LOOP_STALL_FILE), 'utf-8')) as { active: boolean; thresholdMs: number };
    expect(warning).toMatchObject({ active: true, thresholdMs: 100 });
    expect(readFileSync(join(runPath, 'events.jsonl'), 'utf-8')).toContain('scheduler_loop_stalled');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`fixture exited ${code}`)));
    });
  });

  it('does not alarm for unsupported legacy, parked, terminal, or mismatched identity cases', () => {
    const root = join(process.env.FLOWCREW_VITEST_ROOT!, 'heartbeat-controls');
    mkdirSync(root, { recursive: true });
    expect(observeSchedulerHeartbeatOnce({ runPath: root, runId: 'legacy', thresholdMs: 1 })).toBe('unsupported');

    const projectDir = process.env.FLOWCREW_VITEST_ROOT!;
    const created = createRun(projectDir, 'heartbeat-controls', 'name: controls', []);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    writeSchedulerProcessIdentity(created.runDirPath, created.runId);
    const handle = startSchedulerHeartbeat({
      runPath: created.runDirPath, runId: created.runId,
      intervalMs: 60_000, stallThresholdMs: 1, observerPollMs: 1, spawnObserver: false,
    });
    try {
      const statePath = join(created.runDirPath, 'run.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { status: string };
      state.status = 'parked';
      writeFileSync(statePath, JSON.stringify(state));
      expect(observeSchedulerHeartbeatOnce({
        runPath: created.runDirPath, runId: created.runId, thresholdMs: 1, nowMs: Date.now() + 10,
      })).toBe('inactive');
      state.status = 'complete';
      writeFileSync(statePath, JSON.stringify(state));
      expect(observeSchedulerHeartbeatOnce({
        runPath: created.runDirPath, runId: created.runId, thresholdMs: 1, nowMs: Date.now() + 10,
      })).toBe('inactive');
      writeSchedulerProcessIdentity(created.runDirPath, 'different-run');
      expect(observeSchedulerHeartbeatOnce({
        runPath: created.runDirPath, runId: created.runId, thresholdMs: 1, nowMs: Date.now() + 10,
      })).toBe('identity_mismatch');
      expect(schedulerLoopIsStalled(projectDir, created.runId)).toBe(false);
    } finally {
      handle.stop();
      removeSchedulerProcessIdentity(created.runDirPath);
    }
  });
});
