import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { RUN_STATUS, runsRoot, STAGE_STATUS, type StoreState } from '../src/store.js';
import type { CampaignPageSources } from '../src/campaign-page.js';

let root = '';
let projectDir = '';
let distDir = '';
let runEvidenceDir = '';
let app: FastifyInstance | undefined;

function emptyInbox() {
  return {
    approvals: { status: 'complete' as const, items: [] },
    deferred: { status: 'complete' as const, items: [] },
    stale: { status: 'complete' as const, items: [] },
    patches: { status: 'complete' as const, items: [], coverage: { succeeded: 1, failed: 0 } },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'campaign-page-api-'));
  projectDir = join(root, 'project');
  distDir = join(root, 'dist');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'dashboard.js'), 'export const fixture = true;\n', 'utf-8');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (runEvidenceDir) rmSync(runEvidenceDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function sources(): Partial<CampaignPageSources> {
  const campaignId = 'operator-api-fixture';
  const state: StoreState = {
    runId: 'operator-api-run',
    workflowName: 'default',
    projectDir,
    status: RUN_STATUS.COMPLETE,
    stages: { implement: { status: STAGE_STATUS.COMPLETE, retries: 0, tokens_in: 4, tokens_out: 2 } },
    startedAt: '2026-08-02T10:00:00.000Z',
    completedAt: '2026-08-02T10:10:00.000Z',
    taskDescription: 'TASK — API contract: dedicated campaign model',
    campaignId,
    campaignStorageKey: campaignId,
    campaignName: 'Operator API fixture',
    supervise: false,
  };
  runEvidenceDir = join(runsRoot(), state.runId);
  mkdirSync(runEvidenceDir, { recursive: true });
  writeFileSync(join(runEvidenceDir, 'workflow.yaml'), 'name: default\nstages:\n  - id: implement\n    role: coder\n', 'utf-8');
  writeFileSync(join(runEvidenceDir, 'summary.md'), '## What was done\n- served the dedicated operator contract\n', 'utf-8');
  const records = [{
    runId: state.runId,
    status: state.status,
    workflowName: state.workflowName,
    taskDescription: state.taskDescription,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    campaignId,
    campaignStorageKey: campaignId,
    campaignName: state.campaignName,
  }];
  return {
    listCampaigns: () => [{
      id: campaignId,
      name: state.campaignName!,
      storageKey: campaignId,
      runCount: 1,
      bestScore: null,
      latestRun: state.runId,
      latestTimestamp: state.startedAt,
    }],
    listRunRecords: () => records,
    listRunRecordsByCampaign: () => records,
    readRunState: () => state,
    readCampaignEntries: () => [],
    readInbox: async () => emptyInbox(),
    readTasks: async () => [],
    hasLiveWorker: () => true,
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  };
}

describe('campaign operator HTTP contract', () => {
  it('serves a batched index, dedicated detail, and explicit run page', async () => {
    app = await startDashboard(projectDir, 0, { distDir, campaignPageSources: sources() });

    const index = await app.inject({ method: 'GET', url: '/api/campaigns/operator-index' });
    expect(index.statusCode).toBe(200);
    expect(index.json()).toMatchObject({
      campaigns: { status: 'complete', value: { total: 1, items: [{ id: 'operator-api-fixture', runCount: 1 }] } },
    });

    const detail = await app.inject({ method: 'GET', url: '/api/campaigns/operator-api-fixture/operator-view' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      identity: { id: 'operator-api-fixture', classification: { kind: 'engineering' } },
      cost: {
        value: {
          wallMs: 600_000,
          tokens: 6,
          wallCoverage: { succeeded: 1, failed: 0, total: 1 },
          tokenCoverage: { succeeded: 1, failed: 0, total: 1 },
        },
      },
      runs: { value: { shown: 1, total: 1, truncated: false } },
    });
    expect(detail.json().runs.value.items[0]).not.toHaveProperty('tokens');
    expect(detail.json().runs.value.items[0]).toMatchObject({
      shortName: 'API contract',
      fullTitle: 'API contract: dedicated campaign model',
    });
    expect(JSON.stringify(detail.json())).not.toContain('"error"');

    const page = await app.inject({ method: 'GET', url: '/api/campaigns/operator-api-fixture/operator-runs?cursor=0&limit=12' });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ status: 'complete', value: { shown: 1, nextCursor: null } });

  });

  it('returns an honest 404 for an unknown id and 400 for an invalid cursor', async () => {
    app = await startDashboard(projectDir, 0, { distDir, campaignPageSources: sources() });
    expect((await app.inject({ method: 'GET', url: '/api/campaigns/missing/operator-view' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/campaigns/operator-api-fixture/operator-runs?cursor=-1' })).statusCode).toBe(400);
  });
});
