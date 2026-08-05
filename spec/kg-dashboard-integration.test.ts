import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createRun, runDir } from '../src/store.js';
import { ratchetCheck } from '../src/knowledge-graph.js';
import { startDashboard } from '../src/dashboard.js';

let projectDir: string;
let app: FastifyInstance | undefined;
let port: number;

// Minimal workflow YAML that createRun needs
const workflowYaml = `name: test-wf\nstages:\n  - id: s1\n    role: worker\n`;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-dash-int-'));
  // createRun needs .fc/runs to exist (it creates the run subdir)
  mkdirSync(join(projectDir, '.fc', 'runs'), { recursive: true });
  // Use port 0 to let OS pick a free port
  port = 0;
  app = await startDashboard(projectDir, port);
}, 30000);

afterEach(async () => {
  await app?.close();
});

describe('KG bestScore in dashboard API (end-to-end)', () => {
  it('GET /api/tasks/:id includes bestScore after ratchetCheck writes to KG', async () => {
    const { runId } = createRun(projectDir, 'test-wf', workflowYaml, ['s1']);
    ratchetCheck(projectDir, runId, 85, 'accuracy');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bestScore).toBe(85);
  });

  it('GET /api/tasks/:id includes metricName after ratchetCheck writes to KG', async () => {
    const { runId } = createRun(projectDir, 'test-wf', workflowYaml, ['s1']);
    ratchetCheck(projectDir, runId, 72, 'f1_score');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metricName).toBe('f1_score');
  });

  it('when both KG bestScore and metric.json exist, the higher score wins', async () => {
    const { runId } = createRun(projectDir, 'test-wf', workflowYaml, ['s1']);

    // Write a metric.json with score 60 in stage s1
    const metricPath = join(runDir(projectDir, runId), 'stages', 's1', 'metric.json');
    writeFileSync(metricPath, JSON.stringify({ hasMetric: true, value: 60, metric: 'old_metric' }));

    // Write KG bestScore of 90 via ratchetCheck
    ratchetCheck(projectDir, runId, 90, 'kg_metric');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bestScore).toBe(90);
    expect(body.metricName).toBe('kg_metric');
  });

  it('when only KG bestScore exists (no metric files), dashboard still shows it', async () => {
    const { runId } = createRun(projectDir, 'test-wf', workflowYaml, ['s1']);

    // Only write to KG — no metrics_*.json, no metric.json, no verdict_*.json
    ratchetCheck(projectDir, runId, 77, 'precision');

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bestScore).toBe(77);
    expect(body.metricName).toBe('precision');
  });
});
