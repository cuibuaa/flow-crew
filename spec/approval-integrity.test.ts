import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { recordRequest, foldItems, resolveRequest } from '../src/inbox.js';
import { inspectRunScheduler, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';
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
  writeFileSync(join(run, 'scheduler.pid'), String(process.pid));
  writeSchedulerProcessIdentity(run, runId);
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

describe('approval inbox publication ownership', () => {
  it('repolls a completed resolution without waking the run directory watcher', async () => {
    resolveRequest(project, runId, 'publish', 'approve');
    const changes: string[] = [];
    const watcher = watch(run, (_event, name) => { changes.push(String(name)); });
    try {
      const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
      const ctx = { projectDir: project, runId, runDirPath: run, iteration: 1 };
      for (let poll = 0; poll < 3; poll++) {
        expect(await monitor.tryParkOnApprovalRequest(readRunState(project, runId), ctx)).toBe(null);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(changes).toEqual([]);
    } finally { watcher.close(); }
  });
  it.each(['cli', 'dashboard'])('accepts a separate %s resolution while only the resident engine publishes its records', async surface => {
    expect(inspectRunScheduler(runId, run).kind).toBe('live');
    const cli = new URL('../src/cli-inbox.ts', import.meta.url).href;
    const dashboard = new URL('../src/dashboard.ts', import.meta.url).href;
    const storage = new URL('../src/store.ts', import.meta.url).href;
    const code = `import { setFcGlobalDir } from ${JSON.stringify(storage)};
      setFcGlobalDir(${JSON.stringify(store)});
      ${surface === 'cli'
        ? `const { cmdInbox } = await import(${JSON.stringify(cli)});
          process.exitCode = await cmdInbox(['inbox','approve','publish','--run',${JSON.stringify(runId)},'--no-resume']);`
        : `const { startDashboard } = await import(${JSON.stringify(dashboard)});
          const app = await startDashboard(${JSON.stringify(project)}, 0);
          try {
            const response = await app.inject({method:'POST',url:${JSON.stringify(`/api/inbox/${runId}/publish/resolve`)},payload:{decision:'approve'}});
            if (response.statusCode !== 200) throw new Error(response.body);
          } finally { await app.close(); }`}`;
    await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
        { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: root, FC_HOME: store }, encoding: 'utf8' });
      expect(foldItems(runId).get('publish')?.state).toBe('approved');
      expect(existsSync(join(run, 'approvals', 'publish.decision.json'))).toBe(false);
      expect(readRunEvents(project, runId).filter(event => event.type === 'approval_resolved')).toEqual([]);
      const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
      const ctx = { projectDir: project, runId, runDirPath: run, iteration: 1 };
      expect(await monitor.tryParkOnApprovalRequest(readRunState(project, runId), ctx)).toBe(null);
      expect(await monitor.tryParkOnApprovalRequest(readRunState(project, runId), ctx)).toBe(null);
    });
    expect(JSON.parse(readFileSync(join(run, 'approvals', 'publish.decision.json'), 'utf8'))).toMatchObject({ decision: 'approve' });
    expect(readRunEvents(project, runId).filter(event => event.type === 'approval_resolved')).toEqual([
      expect.objectContaining({ requestId: 'publish', decision: 'accepted', source: 'operator' }),
    ]);
  });

  it.each(['rename', 'delete'])('refuses a separate dashboard campaign %s before changing a live run or its history', async operation => {
    updateRunState(project, runId, state => {
      state.campaignId = 'fixture'; state.campaignStorageKey = 'fixture'; state.campaignName = 'Original';
    });
    mkdirSync(campaignsRoot(), { recursive: true });
    const history = join(campaignsRoot(), 'fixture.jsonl'); writeFileSync(history, '{}\n');
    const before = readFileSync(join(run, 'run.json'), 'utf8');
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
    expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(before);
    expect(readFileSync(history, 'utf8')).toBe('{}\n');
  });

  it.each(['rename', 'delete'])('rechecks campaign %s ownership under the run lock when a scheduler claims after preflight', async operation => {
    updateRunState(project, runId, state => {
      state.campaignId = 'fixture'; state.campaignStorageKey = 'fixture'; state.campaignName = 'Original';
    });
    unlinkSync(join(run, 'scheduler.pid')); unlinkSync(join(run, 'scheduler.identity.json'));
    mkdirSync(campaignsRoot(), { recursive: true });
    const history = join(campaignsRoot(), 'fixture.jsonl'); writeFileSync(history, '{}\n');
    const before = readFileSync(join(run, 'run.json'), 'utf8');
    const original = storage.updateRunState;
    const update = vi.spyOn(storage, 'updateRunState').mockImplementation((...args) => {
      engineFs.writeFileSync(join(run, 'scheduler.pid'), String(process.pid));
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
    expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(before);
    expect(readFileSync(history, 'utf8')).toBe('{}\n');
  });

  it('serializes an external resolution projection with a scheduler claim using the existing run lock', async () => {
    unlinkSync(join(run, 'scheduler.pid')); unlinkSync(join(run, 'scheduler.identity.json'));
    const cli = new URL('../src/cli-inbox.ts', import.meta.url).href;
    const storeModule = new URL('../src/store.ts', import.meta.url).href;
    const code = `import { setFcGlobalDir } from ${JSON.stringify(storeModule)};
      setFcGlobalDir(${JSON.stringify(store)});
      const { cmdInbox } = await import(${JSON.stringify(cli)});
      process.exitCode = await cmdInbox(['inbox','approve','publish','--run',${JSON.stringify(runId)},'--no-resume']);`;
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    try {
      await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
        withRunStateLock(run, () => {
          child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
            { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: root, FC_HOME: store }, stdio: 'ignore' });
          closed = new Promise<number | null>((resolve, reject) => {
            child!.once('error', reject); child!.once('close', resolve);
          });
          const deadline = Date.now() + 5000;
          while (foldItems(runId).get('publish')?.state !== 'approved') {
            if (Date.now() >= deadline) throw new Error('External operator did not append its inbox resolution');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          // The inbox append has completed; its projection must remain blocked
          // while this lock can still establish a new resident owner.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          expect(existsSync(join(run, 'approvals', 'publish.decision.json'))).toBe(false);
          expect(readRunEvents(project, runId).filter(event => event.type === 'approval_resolved')).toEqual([]);
          engineFs.writeFileSync(join(run, 'scheduler.pid'), String(process.pid));
          writeSchedulerProcessIdentity(run, runId);
        });
        expect(await closed).toBe(0);
      });
      expect(existsSync(join(run, 'approvals', 'publish.decision.json'))).toBe(false);
      expect(readRunEvents(project, runId).filter(event => event.type === 'approval_resolved')).toEqual([]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });

  it('keeps an approved inbox decision but refuses resume admission if a scheduler claims after preflight', async () => {
    const brief = '# Goal\n## What the report must show\n1. Publish the reviewed result.\n';
    updateRunState(project, runId, state => {
      state.status = 'parked'; state.taskDescription = brief; delete state.briefAdmission;
    });
    writeFileSync(join(run, 'task_brief.md'), brief);
    unlinkSync(join(run, 'scheduler.pid')); unlinkSync(join(run, 'scheduler.identity.json'));
    const before = readFileSync(join(run, 'run.json'), 'utf8');
    const original = storage.updateRunState;
    const update = vi.spyOn(storage, 'updateRunState').mockImplementation((...args) => {
      engineFs.writeFileSync(join(run, 'scheduler.pid'), String(process.pid));
      writeSchedulerProcessIdentity(run, runId);
      return original(...args);
    });
    const registerTask = vi.fn(async () => ({ id: 1, unit: 'fixture', pid: 0, build: 'fixture', acknowledgement: 'persisted' as const }));
    const app = await startDashboard(project, 0, { registerTask });
    try {
      const preflight = await app.inject({ method: 'POST', url: '/api/brief-preflight', payload: { brief } });
      expect(preflight.statusCode).toBe(200);
      const { report, receipt } = preflight.json();
      await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
        const response = await app.inject({ method: 'POST', url: `/api/inbox/${runId}/publish/resolve`, payload: {
          decision: 'approve', briefPreflightDigest: report.digest, briefPreflightReceipt: receipt, acknowledgeBriefWarnings: true,
        } });
        expect(update).toHaveBeenCalledOnce();
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ won: true, resumeRegistered: false });
      });
    } finally { update.mockRestore(); await app.close(); }
    expect(registerTask).not.toHaveBeenCalled();
    expect(foldItems(runId).get('publish')?.state).toBe('approved');
    expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(before);
  });
});
