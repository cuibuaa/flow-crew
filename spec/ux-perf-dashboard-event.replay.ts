import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';

let originalFcRoot: string;
let root: string;
let projectDir: string;
let distDir: string;
let app: FastifyInstance | undefined;

beforeAll(() => {
  originalFcRoot = fcGlobalDir();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-ux-dashboard-event-'));
  projectDir = join(root, 'project');
  distDir = join(root, 'dist');
  setFcGlobalDir(join(root, 'fc-home'));
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'dashboard.js'), 'export const build = "loaded";\n', 'utf-8');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(originalFcRoot);
});

describe('reality-gate run-detail evidence replay', () => {
  it('retains canonical event detail and exposes the same bounded operational projection', async () => {
    const created = createRun(projectDir, 'default', 'name: default\nstages:\n  - id: implement\n    role: coder\n', ['implement']);
    const state = readRunState(projectDir, created.runId);
    state.status = 'running';
    state.stages.implement = {
      status: 'running',
      retries: 1,
      attempts: [{ index: 2, status: 'running', startedAt: '2026-09-03T10:01:00.000Z' }],
    };
    writeRunState(projectDir, created.runId, state);
    writeFileSync(join(fcGlobalDir(), 'runs', created.runId, 'events.jsonl'), `${JSON.stringify({
      type: 'scope_revision_decided',
      runId: created.runId,
      timestamp: '2026-09-03T10:01:30.000Z',
      stageId: 'implement',
      attemptIndex: 2,
      requestId: 'scope-17',
      decision: 'rejected',
      detail: 'request path digest did not match the active execution',
    })}\n`, 'utf-8');
    app = await startDashboard(projectDir, 0, { distDir });

    const response = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: [{
        type: 'scope_revision_decided',
        stageId: 'implement',
        attemptIndex: 2,
        requestId: 'scope-17',
        decision: 'rejected',
        detail: 'request path digest did not match the active execution',
      }],
      operational: {
        runStatus: 'failed',
        activeStages: [],
        latestReason: {
          type: 'scope_revision_decided',
          detail: 'request path digest did not match the active execution',
        },
        sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
      },
    });
  });
});
