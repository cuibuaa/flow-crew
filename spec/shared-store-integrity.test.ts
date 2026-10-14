import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { startSchedulerHeartbeat } from '../src/scheduler-heartbeat.js';
import { createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string, project: string, run: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-store-integrity-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
});
afterEach(() => {
  vi.useRealTimers();
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});
const execution = () => ({ projectDir: project, runDir: run, stageId: 'work' });

it('accepts another process updating the shared run index while a stage is executing', async () => {
  const index = join(fcGlobalDir(), 'run-index.sqlite');
  const before = readFileSync(index);
  await expect(withEngineIntegrity(execution(), async () => {
    execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('CREATE TABLE peer_update(value); INSERT INTO peer_update VALUES (1); PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    `, index], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } });
  })).resolves.toBeUndefined();
  expect(readFileSync(index)).not.toEqual(before);
});

it('leaves an asynchronous heartbeat refusal for stage settlement without escaping the timer', async () => {
  vi.useFakeTimers();
  const heartbeat = startSchedulerHeartbeat({ runPath: run, runId: run.split('/').at(-1)!,
    intervalMs: 20, stallThresholdMs: 100, observerPollMs: 10, spawnObserver: false });
  let reachedSettlement = false;
  const path = join(run, 'scheduler-heartbeat.json');
  try {
    await expect(withEngineIntegrity(execution(), async () => {
      writeFileSync(path, 'counterfeit');
      vi.advanceTimersByTime(40);
      reachedSettlement = true;
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(reachedSettlement).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('running');
  } finally { await heartbeat.stop(); }
});

it('still refuses and restores changed run-owned state after a concurrent index update', async () => {
  const path = join(run, 'run.json');
  const before = readFileSync(path);
  await expect(withEngineIntegrity(execution(), async () => {
    execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('CREATE TABLE another_peer(value)'); db.close();
    `, join(fcGlobalDir(), 'run-index.sqlite')], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } });
    writeFileSync(path, '{"status":"complete"}');
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(readFileSync(path)).toEqual(before);
});
