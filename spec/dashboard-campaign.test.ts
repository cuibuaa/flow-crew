import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRunIndexRecordsByCampaign, rebuildRunIndex } from '../src/run-index.js';
import { readCampaignEntries, resolveCampaignStorageKey } from '../src/campaigns.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { startDashboard } from '../src/dashboard.js';
import { createRun } from './test-support/create-run.js';
import { updateRunState, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let app: FastifyInstance;
let projectDir: string;
let homeDir: string;
let oldHome: string | undefined;
let oldFcHome: string;

function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

function makeProject() {
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  mkdirSync(join(projectDir, '.fc', 'runs'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'workflows', 'default.yaml'), 'name: default\nstages: []\n', 'utf-8');
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'fc-dashboard-campaign-project-'));
  homeDir = mkdtempSync(join(tmpdir(), 'fc-dashboard-campaign-home-'));
  oldHome = process.env.HOME;
  oldFcHome = fcGlobalDir();
  process.env.HOME = homeDir;
  setFcGlobalDir(join(homeDir, '.fc'));
  makeProject();
  app = await startDashboard(projectDir, 0, { listTasks: async () => [] });
}, 30000);

afterEach(async () => {
  if (app) await app.close();
  setFcGlobalDir(oldFcHome);
  process.env.HOME = oldHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('dashboard campaign API', () => {
  it.each([['ledger-only', 'ledger-only', 'Ledger only'], ['new:new:x', 'x', 'x'], ['新！', '', '新！']])('uses the same key for %s in persistence, index and campaign views', async (campaignName, expectedKey, expectedName) => {
    const created = createRun(projectDir, 'default', 'name: default\nstages: []', []);
    updateRunState(projectDir, created.runId, state => {
      state.campaignId = campaignName;
      state.campaignName = campaignName === 'ledger-only' ? 'Ledger only' : campaignName;
      state.status = 'complete';
    });
    const campaigns = join(fcGlobalDir(), 'campaigns');
    expectedKey ||= resolveCampaignStorageKey({ campaignId: campaignName, projectDir })!;
    expect(resolveCampaignStorageKey({ campaignId: campaignName, projectDir })).toBe(expectedKey);
    expect(readdirSync(campaigns)).toEqual([`${expectedKey}.jsonl`]);
    expect(readRunIndexRecordsByCampaign(projectDir, expectedKey)).toMatchObject([{ runId: created.runId }]);
    rebuildRunIndex(projectDir);
    expect(readRunIndexRecordsByCampaign(projectDir, expectedKey)).toMatchObject([{ runId: created.runId }]);
    const entries = readFileSync(join(campaigns, `${expectedKey}.jsonl`), 'utf-8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toMatchObject([
      { kind: 'task_started', runId: created.runId },
      { kind: 'task_ended', runId: created.runId, status: 'complete' },
    ]);
    const page = await app.inject({ method: 'GET', url: `/api/campaigns/${expectedKey}/operator-view` });
    expect(page.statusCode).toBe(200);
    expect(page.json().identity).toMatchObject({ id: expectedKey, name: expectedName, runCount: 1 });
    expect(page.json().runs.value.items).toMatchObject([{ runId: created.runId, status: 'complete' }]);
    const inbox = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toEqual({
      approvals: { status: 'complete', items: [] },
      deferred: { status: 'complete', items: [] },
      stale: { status: 'complete', items: [] },
      campaignCount: 1,
    });
  });

  it.each(['default', 'explicit'])('keeps non-ASCII projects with %s campaigns in separate ledgers', mode => {
    const projects = [join(projectDir, '项目一'), join(projectDir, '项目二')];
    const campaignName = (project: string) => mode === 'default' ? basename(project) : '新！';
    const runIds = projects.map(project => {
      mkdirSync(project);
      const created = createRun(project, 'default', 'name: default\nstages: []', []);
      configureWorkflowBrief({ name: 'default', stages: [] }, project, created.runId, created.runDirPath, 1, false, undefined, false, campaignName(project));
      updateRunState(project, created.runId, state => { state.status = 'complete'; });
      return created.runId;
    });
    const keys = projects.map(project => resolveCampaignStorageKey({ campaignName: campaignName(project), projectDir: project }));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
    expect(resolveCampaignStorageKey({ campaignName: '新！' })).toBeUndefined();
    expect(resolveCampaignStorageKey({ campaignName: '新！', projectDir: projects[0] }))
      .not.toBe(resolveCampaignStorageKey({ campaignName: '新！', projectDir: projects[1] }));
    expect(readdirSync(join(fcGlobalDir(), 'campaigns')).sort()).toEqual(keys.map(key => `${key}.jsonl`).sort());
    for (const [i, key] of keys.entries()) {
      const rows = readFileSync(join(fcGlobalDir(), 'campaigns', `${key}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row.runId)).toEqual([runIds[i], runIds[i]]);
      expect(readCampaignEntries(projects[i], campaignName(projects[i])).map(row => row.runId)).toEqual([runIds[i], runIds[i]]);
      expect(readRunIndexRecordsByCampaign(projects[i], key!)).toMatchObject([{ runId: runIds[i] }]);
      rebuildRunIndex(projects[i]);
      expect(readRunIndexRecordsByCampaign(projects[i], key!)).toMatchObject([{ runId: runIds[i] }]);
    }
  });

  it('matches a stored campaign name alias when editing runs', async () => {
    const created = createRun(projectDir, 'default', 'name: default\nstages: []', []);
    updateRunState(projectDir, created.runId, state => {
      state.campaignId = 'stable-id';
      state.campaignStorageKey = 'stable-key';
      state.campaignName = 'Display Alias';
      state.status = 'complete';
    });
    const response = await app.inject({ method: 'DELETE', url: '/api/run-campaigns/display-alias' });
    expect(response.statusCode).toBe(200);
    expect(response.json().orphaned).toBe(1);
    const state = JSON.parse(readFileSync(join(fcGlobalDir(), 'runs', created.runId, 'run.json'), 'utf8'));
    expect(state.campaignId).toBe('');
    expect(state.campaignStorageKey).toBe('');
    expect(state.campaignName).toBe('');
  });

  it('returns 404 for a missing campaign id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/missing-campaign' });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/run-campaigns/:id removes campaign history and orphans matching runs', async () => {
    mkdirSync(join(homeDir, '.fc', 'campaigns'), { recursive: true });
    const campaignPath = join(homeDir, '.fc', 'campaigns', 'delete-me.jsonl');
    writeJsonl(campaignPath, [{ runId: 'delete-run', campaignId: 'delete-me', status: 'complete' }]);
    const runDir = join(homeDir, '.fc', 'runs', 'delete-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'delete-run',
      workflowName: 'default',
      projectDir,
      status: 'complete',
      stages: {},
      startedAt: '2026-05-23T10:00:00.000Z',
      campaignId: 'delete-me',
      campaignStorageKey: 'delete-me',
      campaignName: 'Delete Me',
    }, null, 2), 'utf-8');

    const res = await app.inject({ method: 'DELETE', url: '/api/run-campaigns/delete-me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, orphaned: 1, removedHistory: true });
    expect(existsSync(campaignPath)).toBe(false);
    const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
    expect(runState).toMatchObject({ campaignId: '', campaign_id: '', campaignStorageKey: '', campaignName: '' });
  });


});
