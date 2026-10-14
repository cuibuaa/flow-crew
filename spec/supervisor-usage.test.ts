import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { startDashboard } from '../src/dashboard.js';
import { generateRunSummary } from '../src/run-summary.js';
import { createRun, readRunState, runDir, writeRunState, type SupervisorUsage } from '../src/store.js';
import { readRunStateView } from '../src/run-state-view.js';

let projectDir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-historical-usage-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

describe('recorded supervisor cost remains readable', () => {
  it('keeps successful and failed historical calls in state, summary and dashboard', async () => {
    const created = createRun(projectDir, 'recorded', 'name: recorded\nstages:\n  - id: work\n    role: coder\n', ['work']);
    const startedAt = new Date().toISOString();
    const usage: SupervisorUsage = {
      status: 'complete', calls: 3, tokens_in: 600, tokens_out: 60, duration_ms: 60,
      startedAt, completedAt: startedAt,
      attempts: [10, 20, 30].map((duration_ms, offset) => ({
        index: offset + 1, startedAt, completedAt: startedAt,
        status: offset === 1 ? 'complete' : 'failed', duration_ms, exitCode: offset === 2 ? 2 : 0,
        tokens_in: (offset + 1) * 100, tokens_out: (offset + 1) * 10,
        ...(offset === 0 ? { error: 'unparseable supervisor verdict' } : {}),
        ...(offset === 1 ? { verdict: 'WAIT' } : {}),
        ...(offset === 2 ? { error: 'adapter exit 2' } : {}),
      })),
    };
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete'; state.completedAt = startedAt; state.supervisor = usage;
    writeRunState(projectDir, created.runId, state);
    const directory = runDir(projectDir, created.runId);
    mkdirSync(join(directory, 'stages', '_supervisor'), { recursive: true });
    writeFileSync(join(directory, 'stages', '_supervisor', 'status.json'), JSON.stringify(usage));
    // Stored model accounting is input to readers; no supervisor runtime exists.
    expect(readRunState(projectDir, created.runId).supervisor).toEqual(usage);
    expect(readRunStateView(projectDir, created.runId).histories.supervisor).toEqual(usage);
    await generateRunSummary(projectDir, created.runId, {
      run: async () => ({ output: '## What was done\n- preserved recorded costs', exitCode: 0, duration_ms: 1 }),
    });
    expect(readFileSync(join(directory, 'summary.md'), 'utf-8')).toContain(
      '_supervisor: 3 calls, 0s cumulative, 660 tokens total (600 in + 60 out)',
    );
    app = await startDashboard(projectDir, 0);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.supervisor).toMatchObject({ calls: 3, tokens_in: 600, tokens_out: 60 });
    expect(body.stages.find((stage: { id: string }) => stage.id === '_supervisor')).toMatchObject({
      role: 'supervisor', attempts: expect.any(Array), calls: 3,
    });
  });
});
