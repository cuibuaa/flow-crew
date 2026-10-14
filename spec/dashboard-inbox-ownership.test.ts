import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDashboard } from '../src/dashboard.js';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';

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
  it('keeps legacy stale and patch alerts without loading research presentation artifacts', async () => {
    root = mkdtempSync(join(tmpdir(), 'inbox-attention-'));
    const project = join(root, 'project');
    mkdirSync(project);
    setFcGlobalDir(join(root, 'store'));
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []', ['review']);
    updateRunState(project, created.runId, state => {
      state.status = 'running';
      state.campaignId = 'legacy-attention';
      state.campaignStorageKey = 'legacy-attention';
    });
    const path = runDir(project, created.runId);
    mkdirSync(join(path, 'stages', 'review'), { recursive: true });
    writeFileSync(join(path, 'metrics_review.json'), JSON.stringify({ score: 7, metric_name: 'quality' }));
    writeFileSync(join(path, 'stages', 'review', 'metric.json'), JSON.stringify({ hasMetric: true, value: 7, metric: 'quality' }));
    writeFileSync(join(path, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'candidate', result: 7 }] }));
    const campaign = join(fcGlobalDir(), 'campaigns', 'legacy-attention');
    const brief = join(campaign, 'brief');
    mkdirSync(brief, { recursive: true });
    writeFileSync(join(campaign, 'state.json'), JSON.stringify({ status: 'running', projectDir: project, run_id: created.runId, briefDir: brief }));
    writeFileSync(join(campaign, 'iteration_log.jsonl'), JSON.stringify({ run_id: created.runId, score: 7, metric: 'quality', phase: 'study', phaseComplete: false }) + '\n');
    writeFileSync(join(brief, 'revisions.jsonl'), JSON.stringify({ to_version: 'v2', rule: 'review evidence' }) + '\n');
    writeFileSync(join(campaign, 'pending_review.jsonl'), JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', campaignId: 'legacy-attention', reason: 'review evidence', severity: 'medium', briefDir: brief, patch: { type: 'brief_patch', section: '# Goal', op: 'append', value: 'checked' } }) + '\n');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const file of ['state.json', 'iteration_log.jsonl']) utimesSync(join(campaign, file), old, old);
    app = await startDashboard(project, 0, { listTasks: async () => [], inboxSources: { listApprovals: () => [] } });
    reads.paths = [];
    reads.enabled = true;
    const response = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
    reads.enabled = false;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stale: { status: 'complete', items: [expect.objectContaining({ id: 'legacy-attention', staleRunId: created.runId })] },
      patches: { status: 'complete', items: [expect.objectContaining({ campaignId: 'legacy-attention', latestVersion: 'v2' })] },
    });
    expect(reads.paths.filter(file => /(?:metrics_.*\.json|metric\.json|research_journal\.json)$/.test(file))).toEqual([]);
  });
});
