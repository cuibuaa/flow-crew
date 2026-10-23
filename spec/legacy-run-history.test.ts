import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { cmdState } from '../src/run-state-access.js';
import { fcGlobalDir, readRunState, runsRoot, setFcGlobalDir } from '../src/store.js';

let root = '';
let previousStore = '';
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (previousStore) setFcGlobalDir(previousStore);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('reads a legacy zero-count history through state, dashboard and campaign views without losing stage evidence', async () => {
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'legacy-history-'));
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'fc'));
  const projectDir = join(root, 'project');
  const runId = 'legacy-history-run';
  const campaignId = 'legacy-history-campaign';
  const directory = join(runsRoot(), runId);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const retired = {
    stageId: 'writer', iteration: 1,
    status: { status: 'complete', retries: 0, tokens_in: 11, tokens_out: 7, attempts: [{ index: 1, startedAt: '2026-10-16T18:40:02.118Z', status: 'complete', tokens_in: 11, tokens_out: 7 }] },
  };
  const history = [
    { kind: 'retiredStageUsage', index: 0, value: retired },
    { kind: 'stageEvidence', index: 0, value: { ...retired, statusPath: 'stages/writer/status.json', attemptOutputPaths: [] } },
  ].map(record => JSON.stringify(record) + '\n').join('');
  const state = {
    runId, projectDir, workflowName: 'default', status: 'complete',
    stages: { audit: { status: 'complete', retries: 0, tokens_in: 3, tokens_out: 2 } },
    startedAt: '2026-10-16T18:40:02.118Z', completedAt: '2026-10-16T18:50:02.118Z',
    taskDescription: 'Read the retained run history', campaignId, campaignStorageKey: campaignId,
    campaignName: 'Legacy history',
    stateFormat: {
      version: 2, revision: 126,
      history: { version: 1, path: 'run-history.jsonl', committedBytes: Buffer.byteLength(history), counts: { supervisorAttempts: 0, retiredStageUsage: 1, stageEvidence: 1 } },
    },
  };
  const runJson = JSON.stringify(state);
  writeFileSync(join(directory, 'run.json'), runJson);
  writeFileSync(join(directory, 'run-history.jsonl'), history);
  writeFileSync(join(directory, 'workflow.yaml'), 'name: default\nstages:\n  - id: audit\n    role: qa\n');

  const hydrated = readRunState(projectDir, runId);
  expect(hydrated.retiredStageUsage).toEqual([retired]);
  expect(hydrated.stageEvidence).toHaveLength(1);
  let output = '', errors = '';
  expect(cmdState(['--project', projectDir, '--run', runId, '--summary'], { write: text => { output += text; return true; } }, { write: text => { errors += text; return true; } })).toBe(0);
  expect(errors).toBe('');
  expect(JSON.parse(output)).toMatchObject({ run: { runId, status: 'complete' }, stages: { audit: { status: 'complete' } }, budget: { tokens: { knownInputTokens: 14, knownOutputTokens: 9 } } });

  const record = { ...state };
  app = await startDashboard(projectDir, 0, { campaignPageSources: {
    listCampaigns: () => [{ id: campaignId, storageKey: campaignId, name: 'Legacy history', runCount: 1, bestScore: null, latestRun: runId, latestTimestamp: state.startedAt }],
    listRunRecordsByCampaign: () => [record], readCampaignEntries: () => [],
    readTasks: async () => [],
    readInbox: async () => ({ approvals: { status: 'complete', items: [] }, deferred: { status: 'complete', items: [] }, stale: { status: 'complete', items: [] } }),
  } });
  const dashboard = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
  expect(dashboard.statusCode).toBe(200);
  expect(dashboard.json()).toMatchObject({ runId, status: 'complete', stageHistory: [retired], stages: [{ id: 'audit', status: 'complete' }] });
  const campaign = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/operator-view` });
  expect(campaign.statusCode).toBe(200);
  expect(campaign.json()).toMatchObject({ identity: { id: campaignId, runCount: 1 }, cost: { value: { tokens: 23, tokenCoverage: { succeeded: 1, failed: 0, total: 1 } } }, runs: { value: { total: 1, items: [{ runId, status: 'complete' }] } } });
  expect(readRunState(projectDir, runId).workflowName).toBe('planner');
  expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(runJson);
  expect(readFileSync(join(directory, 'run-history.jsonl'), 'utf8')).toBe(history);
});
