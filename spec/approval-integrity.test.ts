import { runRecordPath } from '../src/run-layout.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { recordRequest, foldItems, resolveRequest } from './test-support/legacy-approvals.js';
import { inspectRunScheduler, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { createRun } from './test-support/create-run.js';
import { campaignsRoot, fcGlobalDir, readRunState, setFcGlobalDir, updateRunState, withRunStateLock } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { startDashboard } from '../src/dashboard.js';
import * as storage from '../src/store.js';
import * as engineFs from '../src/engine-fs.js';

let root: string, project: string, store: string, run: string, runId: string, prior: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'approval-integrity-'));
  project = join(root, 'project'); mkdirSync(project);
  store = join(root, 'store'); prior = fcGlobalDir(); setFcGlobalDir(store);
  ({ runId, runDirPath: run } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
  recordRequest({ projectDir: project, runId, requestId: 'publish', action: 'publish',
    risk: 'external', title: 'Publish result', stageId: 'work', createdAt: new Date().toISOString() });
  writeFileSync(runRecordPath(run, 'scheduler.pid'), String(process.pid));
  writeSchedulerProcessIdentity(run, runId);
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

describe('approval inbox publication ownership', () => {

  it.each(['rename', 'delete'])('refuses a separate dashboard campaign %s before changing a live run or its history', async operation => {
    updateRunState(project, runId, state => {
      state.campaignId = 'fixture'; state.campaignStorageKey = 'fixture'; state.campaignName = 'Original';
    });
    mkdirSync(campaignsRoot(), { recursive: true });
    const history = join(campaignsRoot(), 'fixture.jsonl'); writeFileSync(history, '{}\n');
    const before = readFileSync(runRecordPath(run, 'run.json'), 'utf8');
    const dashboard = new URL('../src/dashboard.ts', import.meta.url).href;
    const storage = new URL('../src/store.ts', import.meta.url).href;
    const request = operation === 'rename'
      ? { method: 'POST', url: '/api/run-campaigns/rename', payload: { campaignId: 'fixture', name: 'Changed' } }
      : { method: 'DELETE', url: '/api/run-campaigns/fixture' };
    const code = `import { setFcGlobalDir } from ${JSON.stringify(storage)};
      setFcGlobalDir(${JSON.stringify(store)});
      const { startDashboard } = await import(${JSON.stringify(dashboard)});
      const app = await startDashboard(${JSON.stringify(project)}, 0);
      try {
        const response = await app.inject(${JSON.stringify(request)});
        if (response.statusCode !== 409) throw new Error(response.body);
      } finally { await app.close(); }`;
    await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
        { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: root, FC_HOME: store }, encoding: 'utf8' });
    });
    expect(readFileSync(runRecordPath(run, 'run.json'), 'utf8')).toBe(before);
    expect(readFileSync(history, 'utf8')).toBe('{}\n');
  });

  it.each(['rename', 'delete'])('rechecks campaign %s ownership under the run lock when a scheduler claims after preflight', async operation => {
    updateRunState(project, runId, state => {
      state.campaignId = 'fixture'; state.campaignStorageKey = 'fixture'; state.campaignName = 'Original';
    });
    unlinkSync(runRecordPath(run, 'scheduler.pid')); unlinkSync(runRecordPath(run, 'scheduler.identity.json'));
    mkdirSync(campaignsRoot(), { recursive: true });
    const history = join(campaignsRoot(), 'fixture.jsonl'); writeFileSync(history, '{}\n');
    const before = readFileSync(runRecordPath(run, 'run.json'), 'utf8');
    const original = storage.updateRunState;
    const update = vi.spyOn(storage, 'updateRunState').mockImplementation((...args) => {
      engineFs.writeFileSync(runRecordPath(run, 'scheduler.pid'), String(process.pid));
      writeSchedulerProcessIdentity(run, runId);
      return original(...args);
    });
    const app = await startDashboard(project, 0);
    try {
      await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
        const response = await app.inject(operation === 'rename'
          ? { method: 'POST', url: '/api/run-campaigns/rename', payload: { campaignId: 'fixture', name: 'Changed' } }
          : { method: 'DELETE', url: '/api/run-campaigns/fixture' });
        expect(update).toHaveBeenCalledOnce();
        expect(response.statusCode).toBe(409);
      });
    } finally { update.mockRestore(); await app.close(); }
    expect(readFileSync(runRecordPath(run, 'run.json'), 'utf8')).toBe(before);
    expect(readFileSync(history, 'utf8')).toBe('{}\n');
  });
});
