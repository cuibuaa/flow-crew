import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { recordRequest } from '../src/inbox.js';
import { campaignsRoot, fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';

let app: FastifyInstance | undefined;
let fixtureRoot: string;
let projectDir: string;
let realFcHome: string;
const runId = 'parked-dashboard-run';

beforeAll(() => {
  realFcHome = fcGlobalDir();
});

beforeEach(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-dashboard-approval-'));
  projectDir = join(fixtureRoot, 'project');
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  writeFileSync(
    join(projectDir, 'config', 'workflows', 'default.yaml'),
    'name: default\nstages: []\n',
    'utf-8',
  );

  const runPath = join(runsRoot(), runId);
  mkdirSync(runPath, { recursive: true });
  writeFileSync(join(runPath, 'run.json'), JSON.stringify({
    runId,
    projectDir,
    workflowName: 'default',
    status: 'parked',
    stages: {
      plan: { status: 'complete', retries: 0 },
      consequential: { status: 'complete', retries: 0 },
      after: { status: 'pending', retries: 0 },
    },
    startedAt: '2026-07-30T00:00:00.000Z',
    currentIteration: 2,
    taskDescription: 'Preserve this exact parked DAG',
    parked: {
      requestId: 'dashboard-approval',
      action: 'deploy',
      target: 'production',
      risk: 'external',
      pausedAt: '2026-07-30T00:05:00.000Z',
      atIteration: 2,
    },
  }, null, 2), 'utf-8');
  recordRequest({
    runId,
    projectDir,
    requestId: 'dashboard-approval',
    action: 'deploy',
    target: 'production',
    risk: 'external',
    title: 'Approve production deploy',
    createdAt: '2026-07-30T00:05:00.000Z',
    atIteration: 2,
  });
  app = await startDashboard(projectDir, 0);
}, 30000);

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(realFcHome);
});

describe('dashboard parked-run execution guard (M6)', () => {
  it('returns 409 before mutating the parked run or spawning a resume', async () => {
    const runJson = join(runsRoot(), runId, 'run.json');
    const before = readFileSync(runJson, 'utf-8');

    const response = await app!.inject({
      method: 'POST',
      url: `/api/tasks/${runId}/execute`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('approval');
    expect(readFileSync(runJson, 'utf-8')).toBe(before);
  });

  it('uses the configured global state root for campaign deletion and run orphaning', async () => {
    const campaignId = 'fc-home-isolation';
    const historyPath = join(campaignsRoot(), `${campaignId}.jsonl`);
    const isolatedRunId = 'fc-home-isolation-run';
    const runPath = join(runsRoot(), isolatedRunId, 'run.json');
    mkdirSync(campaignsRoot(), { recursive: true });
    mkdirSync(join(runsRoot(), isolatedRunId), { recursive: true });
    writeFileSync(historyPath, '{}\n', 'utf-8');
    writeFileSync(runPath, JSON.stringify({
      runId: isolatedRunId,
      projectDir,
      workflowName: 'default',
      status: 'complete',
      stages: {},
      startedAt: '2026-08-02T00:00:00.000Z',
      campaignId,
      campaignStorageKey: campaignId,
      campaignName: 'Isolated campaign',
    }), 'utf-8');

    const response = await app!.inject({ method: 'DELETE', url: `/api/run-campaigns/${campaignId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removedHistory: true, orphaned: 1 });
    expect(existsSync(historyPath)).toBe(false);
    expect(JSON.parse(readFileSync(runPath, 'utf-8'))).toMatchObject({
      campaignId: '',
      campaignStorageKey: '',
      campaignName: '',
    });
  });
});
