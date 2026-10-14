import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDashboard } from '../src/dashboard.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

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

function makeCampaign(id: string, withIterations = true) {
  const campaignDir = join(homeDir, '.fc', 'campaigns', id);
  const briefDir = join(campaignDir, 'brief');
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(join(campaignDir, 'state.json'), JSON.stringify({
    status: 'running',
    started_at: '2026-05-23T10:00:00.000Z',
    projectDir,
    briefDir,
    goal: { metric: 'profit', validRange: '>= 10' },
    budget: { max_iters: 3 },
  }, null, 2), 'utf-8');
  writeFileSync(join(briefDir, 'v1.md'), '# Brief\nold rule\n', 'utf-8');
  writeFileSync(join(briefDir, 'v2.md'), '# Brief\nnew rule\n', 'utf-8');
  writeJsonl(join(briefDir, 'revisions.jsonl'), [
    { from_version: 'v1', to_version: 'v2', rule: 'tighten-risk', patch: { section: 'Risk', op: 'replace', value: 'new rule' } },
  ]);
  if (withIterations) {
    writeJsonl(join(campaignDir, 'iteration_log.jsonl'), [
      {
        iter: 1,
        run_id: 'run-1',
        outcome: 'invalid_ship',
        brief_version: 'v1',
        completing_commit: 'abcdef1234567890',
        patch_applied: { section: 'Risk', op: 'replace', value: 'new rule' },
        rule_fired: 'tighten-risk',
        rejections: { 'no-op': 1, unstable_seeds: 2 },
      },
      { iter: 2, run_id: 'run-2', outcome: 'valid_ship', brief_version: 'v2', rejection_counts: { stress_crashed: 1 } },
    ]);
  }
  return campaignDir;
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'fc-dashboard-campaign-project-'));
  homeDir = mkdtempSync(join(tmpdir(), 'fc-dashboard-campaign-home-'));
  oldHome = process.env.HOME;
  oldFcHome = fcGlobalDir();
  process.env.HOME = homeDir;
  setFcGlobalDir(join(homeDir, '.fc'));
  makeProject();
  makeCampaign('test-campaign');
  makeCampaign('no-log', false);
  app = await startDashboard(projectDir, 0);
}, 30000);

afterEach(async () => {
  if (app) await app.close();
  setFcGlobalDir(oldFcHome);
  process.env.HOME = oldHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('dashboard campaign API', () => {

  it('GET /api/campaigns/:id/brief-diff returns unified diff text', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/test-campaign/brief-diff?from=v1&to=v2' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('--- v1');
    expect(res.body).toContain('+++ v2');
    expect(res.body).toContain('-old rule');
    expect(res.body).toContain('+new rule');
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

  it('lists and accepts pending review patches', async () => {
    const campaignDir = join(homeDir, '.fc', 'campaigns', 'test-campaign');
    const briefDir = join(campaignDir, 'brief');
    writeJsonl(join(campaignDir, 'pending_review.jsonl'), [
      {
        ts: '2026-05-23T10:01:00.000Z',
        campaignId: 'test-campaign',
        reason: 'operator should review',
        severity: 'medium',
        briefDir,
        patch: { type: 'brief_patch', section: '# Brief', op: 'append', value: 'accepted by api' },
      },
    ]);
    writeFileSync(join(briefDir, 'HEAD'), 'v2\n', 'utf-8');

    const overview = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      patches: {
        status: 'complete',
        items: [{ campaignId: 'test-campaign', campaignName: 'test-campaign', index: 0 }],
      },
    });
    expect(overview.json().campaignCount).toBeGreaterThanOrEqual(2);

    const accept = await app.inject({
      method: 'POST',
      url: '/api/campaigns/test-campaign/review/0',
      payload: { decision: 'accept' },
    });
    expect(accept.statusCode).toBe(200);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/campaigns/test-campaign/review/0',
      payload: { decision: 'accept' },
    });
    expect(conflict.statusCode).toBe(409);
  });
});
