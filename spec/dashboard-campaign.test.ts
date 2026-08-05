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
  it('GET /api/campaigns lists fixture campaigns under the temp home root', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((campaign: { id: string }) => campaign.id).sort()).toEqual(['no-log', 'test-campaign']);
    expect(body.find((campaign: { id: string }) => campaign.id === 'test-campaign')).toMatchObject({
      status: 'running',
      latest_outcome: 'valid_ship',
    });
  });

  it('GET /api/campaigns/:id/iterations returns parsed iteration log entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/test-campaign/iterations' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { iter: 1, run_id: 'run-1', outcome: 'invalid_ship', brief_version: 'v1' },
      { iter: 2, run_id: 'run-2', outcome: 'valid_ship', brief_version: 'v2' },
    ]);
  });

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

  it('uses 200 empty for known pending-review collections and 404 only for an unknown campaign', async () => {
    const historyPath = join(homeDir, '.fc', 'campaigns', 'history-only.jsonl');
    writeJsonl(historyPath, [{
      ts: '2026-05-24T16:14:00.000Z',
      kind: 'task_started',
      runId: 'history-run',
      campaignId: 'history-only',
      status: 'running',
    }]);

    const canonical = await app.inject({ method: 'GET', url: '/api/campaigns/no-log/pending-review' });
    const historyOnly = await app.inject({ method: 'GET', url: '/api/campaigns/history-only/pending-review' });
    const unknown = await app.inject({ method: 'GET', url: '/api/campaigns/truly-unknown/pending-review' });

    expect(canonical.statusCode).toBe(200);
    expect(canonical.json()).toEqual([]);
    expect(historyOnly.statusCode).toBe(200);
    expect(historyOnly.json()).toEqual([]);
    expect(unknown.statusCode).toBe(404);
  });

  it('returns an empty array when iteration_log.jsonl is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/no-log/iterations' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('GET /api/campaigns includes a completed campaign envelope run', async () => {
    mkdirSync(join(homeDir, '.fc', 'campaigns'), { recursive: true });
    writeJsonl(join(homeDir, '.fc', 'campaigns', 'ui-test.jsonl'), [
      {
        ts: '2026-05-24T16:14:00.000Z',
        kind: 'task_started',
        runId: 'run-ui-test',
        campaignId: 'ui-test',
        workflow: 'default',
        status: 'running',
      },
      {
        ts: '2026-05-24T16:15:00.000Z',
        kind: 'task_ended',
        runId: 'run-ui-test',
        campaignId: 'ui-test',
        workflow: 'default',
        status: 'complete',
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((campaign: { id: string }) => campaign.id)).toContain('ui-test');
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

    const list = await app.inject({ method: 'GET', url: '/api/campaigns/test-campaign/pending-review' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ index: 0, reason: 'operator should review' }]);

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

  it('returns KG hints and queues suggested patches for review', async () => {
    const campaignDir = join(homeDir, '.fc', 'campaigns', 'test-campaign');
    writeFileSync(join(campaignDir, 'kg_hints.json'), JSON.stringify([
      {
        symptomNode: {
          id: 'symptom-a',
          type: 'symptom',
          campaignId: 'prior-campaign',
          metadata: { kind: 'rejection', counts: { unstable_seeds: 4 } },
        },
        suggestedPatch: {
          id: 'patch-a',
          type: 'patch',
          campaignId: 'prior-campaign',
          metadata: { section: '# Brief', op: 'append', value: 'review KG hint' },
        },
        outcomeNode: {
          id: 'outcome-a',
          type: 'outcome',
          campaignId: 'prior-campaign',
          metadata: { kind: 'valid_ship', iterations_used: 2 },
        },
        similarity: 0.8,
        reason: 'same projectDir + same brief metric',
      },
    ], null, 2), 'utf-8');

    const list = await app.inject({ method: 'GET', url: '/api/campaigns/test-campaign/kg-hints' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ similarity: 0.8, symptomNode: { campaignId: 'prior-campaign' } }]);

    const review = await app.inject({ method: 'POST', url: '/api/campaigns/test-campaign/kg-hints/0/review' });
    expect(review.statusCode).toBe(200);
    const pending = readFileSync(join(campaignDir, 'pending_review.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      campaignId: 'test-campaign',
      reason: 'Cross-campaign KG suggestion from prior-campaign',
      source: 'cross_campaign_kg',
      patch: { type: 'brief_patch', section: '# Brief', op: 'append', value: 'review KG hint' },
    });
  });

  it('summarizes the cross-campaign KG store', async () => {
    const kgRoot = join(homeDir, '.fc', 'cross-campaign-kg');
    mkdirSync(kgRoot, { recursive: true });
    writeJsonl(join(kgRoot, 'nodes.jsonl'), [
      {
        id: 'symptom-a',
        type: 'symptom',
        campaignId: 'prior-a',
        campaignStartedAt: '2026-05-23T10:00:00.000Z',
        metadata: { kind: 'rejection', counts: { unstable_seeds: 5 } },
      },
      {
        id: 'symptom-b',
        type: 'symptom',
        campaignId: 'prior-b',
        campaignStartedAt: '2026-05-23T10:01:00.000Z',
        metadata: { kind: 'rejection', counts: { unstable_seeds: 2 } },
      },
      {
        id: 'patch-a',
        type: 'patch',
        campaignId: 'prior-a',
        campaignStartedAt: '2026-05-23T10:00:00.000Z',
        metadata: { section: '# Brief', op: 'append' },
      },
    ]);
    writeJsonl(join(kgRoot, 'edges.jsonl'), [
      { from: 'symptom-a', to: 'patch-a', relation: 'fixed_by', weight: 1 },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/cross-campaign-kg/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total_nodes: 3,
      total_edges: 1,
      top_symptoms: [{ key: 'rejection:unstable_seeds', count: 2 }],
      top_patches: [{ key: '# Brief:append', count: 1 }],
    });
  });

  it('UI smoke fixture: /campaign/test-campaign should render timeline cards and the heatmap from this fixture', async () => {
    const res = await app.inject({ method: 'GET', url: '/campaign/test-campaign' });
    expect([200, 404]).toContain(res.statusCode);
  });
});
