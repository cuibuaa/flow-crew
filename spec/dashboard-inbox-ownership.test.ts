import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDashboard } from '../src/dashboard.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';

const reads = vi.hoisted(() => ({ enabled: false, paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (reads.enabled) reads.paths.push(String(args[0]));
    return actual.readFileSync(...args);
  } };
});

let root: string;
let app: Awaited<ReturnType<typeof startDashboard>> | undefined;
const originalStore = fcGlobalDir();
afterEach(async () => {
  reads.enabled = false;
  await app?.close();
  app = undefined;
  setFcGlobalDir(originalStore);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('inbox campaign attention ownership', () => {
  it('keeps ledger stale alerts without loading research presentation artifacts', async () => {
    root = mkdtempSync(join(tmpdir(), 'inbox-attention-'));
    const project = join(root, 'project');
    mkdirSync(project);
    setFcGlobalDir(join(root, 'store'));
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []', ['review']);
    updateRunState(project, created.runId, state => {
      state.status = 'running';
      state.campaignId = 'ledger-attention';
      state.campaignStorageKey = 'ledger-attention';
    });
    const path = runDir(project, created.runId);
    mkdirSync(join(path, 'stages', 'review'), { recursive: true });
    writeFileSync(join(path, 'metrics_review.json'), JSON.stringify({ score: 7, metric_name: 'quality' }));
    writeFileSync(join(path, 'stages', 'review', 'metric.json'), JSON.stringify({ hasMetric: true, value: 7, metric: 'quality' }));
    writeFileSync(join(path, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'candidate', result: 7 }] }));
    const campaigns = join(fcGlobalDir(), 'campaigns');
    mkdirSync(campaigns, { recursive: true });
    writeFileSync(join(campaigns, 'ledger-attention.jsonl'), JSON.stringify({
      kind: 'task_started', seq: 1, runId: created.runId, campaignId: 'ledger-attention', status: 'running', pass: false,
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    }) + '\n');
    app = await startDashboard(project, 0, { listTasks: async () => [], inboxSources: { listApprovals: () => [] } });
    reads.paths = [];
    reads.enabled = true;
    const response = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
    reads.enabled = false;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stale: { status: 'complete', items: [expect.objectContaining({ id: 'ledger-attention', staleRunId: created.runId })] },
    });
    expect(reads.paths.filter(file => /(?:metrics_.*\.json|metric\.json|research_journal\.json)$/.test(file))).toEqual([]);
  });
});
