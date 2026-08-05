import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addSubTaskNode, readKG } from '../src/knowledge-graph.js';
import { createRun, readRunState, writeRunState } from '../src/store.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'subtask-test-'));
});

// ---- Unit tests for addSubTaskNode ----

describe('addSubTaskNode', () => {
  it('adds an approach node to the parent KG linking to the child', () => {
    const { runId: parentId } = createRun(projectDir, 'w', 'name: w\nstages: []\n', []);
    const node = addSubTaskNode(projectDir, parentId, 'child-001', 'Do research');
    expect(node.type).toBe('approach');
    expect(node.label).toContain('Sub-task: Do research');
    expect(node.source).toBe('child-001');
    expect(node.details).toContain('child-001');
    const kg = readKG(projectDir, parentId);
    expect(kg.nodes.some(n => n.id === node.id)).toBe(true);
  });

  it('includes stageId when provided', () => {
    const { runId: parentId } = createRun(projectDir, 'w', 'name: w\nstages: []\n', []);
    const node = addSubTaskNode(projectDir, parentId, 'child-002', 'Stage task', 'stage-1');
    expect(node.stageId).toBe('stage-1');
  });
});

// ---- API tests ----

describe('Sub-task API endpoints', () => {
  let app: any;
  let parentRunId: string;

  async function createAdmittedSubtask(
    parentId: string,
    payload: { name?: string; brief?: string; workflow?: string; budget?: { totalTokens?: number; totalTimeMs?: number } },
  ) {
    const exactBrief = payload.brief ?? payload.name ?? '';
    const checked = await app.inject({
      method: 'POST',
      url: '/api/brief-preflight',
      payload: { brief: exactBrief },
    });
    expect(checked.statusCode).toBe(200);
    const preflight = checked.json();
    return app.inject({
      method: 'POST',
      url: `/api/tasks/${parentId}/subtasks`,
      payload: {
        ...payload,
        briefPreflightDigest: preflight.report.digest,
        briefPreflightReceipt: preflight.receipt,
        ...(preflight.report.requiresAcknowledgement ? { acknowledgeBriefWarnings: true } : {}),
      },
    });
  }

  beforeEach(async () => {
    mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    mkdirSync(join(projectDir, '.fc', 'runs'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'workflows', 'default.yaml'), 'name: default\nstages: []\n');

    // Create a parent run
    const { runId } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
    parentRunId = runId;

    const { startDashboard } = await import('../src/dashboard.js');
    app = await startDashboard(projectDir, 0);
  }, 30000);

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = undefined;
  });

  // 1. parentTaskId set correctly
  it('POST /api/tasks/:id/subtasks sets parentTaskId on child', async () => {
    const res = await createAdmittedSubtask(parentRunId, { name: 'child task' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.parentTaskId).toBe(parentRunId);
    expect(body.id).toBeTruthy();
    // Verify persisted state
    const childState = readRunState(projectDir, body.id);
    expect(childState.parentTaskId).toBe(parentRunId);
  });

  // 2a. Budget inheritance — parent has budget, no explicit budget
  it('child gets half of parent remaining budget when no explicit budget', async () => {
    const parentState = readRunState(projectDir, parentRunId);
    parentState.budget = { totalTokens: 1000, totalTimeMs: 2000, usedTokens: 200, usedTimeMs: 400 };
    writeRunState(projectDir, parentRunId, parentState);

    const res = await createAdmittedSubtask(parentRunId, { name: 'budget child' });
    expect(res.statusCode).toBe(200);
    const childState = readRunState(projectDir, res.json().id);
    // remaining: 800 tokens, 1600 ms → child gets 400, 800
    expect(childState.budget!.totalTokens).toBe(400);
    expect(childState.budget!.totalTimeMs).toBe(800);
    expect(childState.budget!.usedTokens).toBe(0);
    expect(childState.budget!.usedTimeMs).toBe(0);
  });

  // 2b. Explicit budget overrides inheritance
  it('uses explicit budget when provided', async () => {
    const parentState = readRunState(projectDir, parentRunId);
    parentState.budget = { totalTokens: 1000, totalTimeMs: 2000, usedTokens: 0, usedTimeMs: 0 };
    writeRunState(projectDir, parentRunId, parentState);

    const res = await createAdmittedSubtask(parentRunId, {
      name: 'explicit budget',
      budget: { totalTokens: 100, totalTimeMs: 200 },
    });
    expect(res.statusCode).toBe(200);
    const childState = readRunState(projectDir, res.json().id);
    expect(childState.budget!.totalTokens).toBe(100);
    expect(childState.budget!.totalTimeMs).toBe(200);
  });

  // 2c. No budget on parent → no budget on child
  it('child has no budget when parent has no budget', async () => {
    const res = await createAdmittedSubtask(parentRunId, { name: 'no budget child' });
    expect(res.statusCode).toBe(200);
    const childState = readRunState(projectDir, res.json().id);
    expect(childState.budget).toBeUndefined();
  });

  // 3. POST returns 400 when name is missing
  it('returns 400 when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${parentRunId}/subtasks`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // 4. GET /api/tasks/:id/subtasks lists child tasks
  it('GET /api/tasks/:id/subtasks lists children', async () => {
    // Create two subtasks
    const r1 = await createAdmittedSubtask(parentRunId, { name: 'child A' });
    const r2 = await createAdmittedSubtask(parentRunId, { name: 'child B' });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/api/tasks/${parentRunId}/subtasks`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(2);
    const names = body.map((s: any) => s.name);
    expect(names).toContain('child A');
    expect(names).toContain('child B');
  });

  // 5. GET returns empty array when no subtasks
  it('GET /api/tasks/:id/subtasks returns empty for no children', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/tasks/${parentRunId}/subtasks`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  // 6. Subtasks of one parent don't appear under another
  it('subtasks are scoped to their parent', async () => {
    await createAdmittedSubtask(parentRunId, { name: 'child of parent1' });

    // Create a second parent
    const { runId: parent2 } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
    const res = await app.inject({
      method: 'GET',
      url: `/api/tasks/${parent2}/subtasks`,
    });
    expect(res.json()).toEqual([]);
  });
});
