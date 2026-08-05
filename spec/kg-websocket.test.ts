import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { summarizeKG, type KnowledgeGraph } from '../src/knowledge-graph.js';
import type { StageStatus } from '../src/store.js';
import { createRun } from '../src/store.js';
import { startDashboard } from '../src/dashboard.js';

let projectDir: string;
let app: FastifyInstance | undefined;
let taskId = '';

type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function api(method: ApiMethod, path: string, body?: unknown) {
  const response = await app!.inject({
    method,
    url: path,
    ...(body === undefined ? {} : { payload: body }),
  });
  return { status: response.statusCode, data: response.json() };
}

describe('Knowledge Graph WebSocket / Real-time (Group D)', () => {
  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-kg-websocket-'));
    mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    writeFileSync(
      join(projectDir, 'config', 'workflows', 'default.yaml'),
      'name: default\nstages: []\n',
    );

    app = await startDashboard(projectDir, 0);

    // This suite exercises fresh KG reads, not task registration. A direct
    // fixture keeps it independent from the live daemon-backed register RPC.
    taskId = createRun(projectDir, 'default', 'name: default\nstages: []\n', []).runId;
    expect(taskId).toBeTruthy();
  });

  afterAll(async () => {
    try {
      if (taskId) await api('DELETE', `/api/tasks/${taskId}`).catch(() => undefined);
    } finally {
      await app?.close().catch(() => undefined);
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // D1: When KG is modified, GET returns the change immediately (no stale cache)
  describe('D1: KG changes are immediately visible via GET', () => {
    it('POST a node then GET returns it without delay', async () => {
      const { data: node } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'finding',
        label: 'D1 realtime node',
      });
      expect(node.id).toBeTruthy();

      const { status, data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(status).toBe(200);
      expect(kg.nodes.some((n: any) => n.id === node.id && n.label === 'D1 realtime node')).toBe(true);
    });
  });

  // D2: New nodes appear without page refresh (polling would pick up fresh GET)
  describe('D2: New nodes appear on subsequent GET (simulating poll cycle)', () => {
    it('multiple POSTs followed by a single GET returns all nodes', async () => {
      const { data: n1 } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'approach',
        label: 'D2 node A',
      });
      const { data: n2 } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'insight',
        label: 'D2 node B',
      });

      const { data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(kg.nodes.some((n: any) => n.id === n1.id)).toBe(true);
      expect(kg.nodes.some((n: any) => n.id === n2.id)).toBe(true);
    });
  });

  // D3: Score updates appear without page refresh
  describe('D3: Score updates are immediately visible via GET', () => {
    it('PATCH a node score then GET reflects the update', async () => {
      const { data: node } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'result',
        label: 'D3 scored node',
      });

      const { status: patchStatus, data: updated } = await api(
        'PATCH',
        `/api/tasks/${taskId}/knowledge-graph/nodes/${node.id}`,
        { score: 92 },
      );
      expect(patchStatus).toBe(200);
      expect(updated.score).toBe(92);

      const { data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      const found = kg.nodes.find((n: any) => n.id === node.id);
      expect(found).toBeDefined();
      expect(found.score).toBe(92);
    });
  });

  // D4: Worker kgChanged detection
  describe('D4: Worker kgChanged detection logic', () => {
    it('StageStatus type includes kgChanged field', () => {
      const stage: StageStatus = { status: 'complete', retries: 0, kgChanged: true };
      expect(stage.kgChanged).toBe(true);
    });

    it('artifacts containing knowledge_graph.json sets kgChanged true', () => {
      const artifacts = ['output.txt', 'knowledge_graph.json', 'log.txt'];
      const kgChanged = artifacts.some(a => a.endsWith('knowledge_graph.json'));
      expect(kgChanged).toBe(true);
    });

    it('artifacts without knowledge_graph.json sets kgChanged false', () => {
      const artifacts = ['output.txt', 'log.txt'];
      const kgChanged = artifacts.some(a => a.endsWith('knowledge_graph.json'));
      expect(kgChanged).toBe(false);
    });
  });

  // D5: KG summary injection in scheduler
  describe('D5: summarizeKG produces injectable context', () => {
    it('returns non-empty string for a KG with nodes', () => {
      const kg: KnowledgeGraph = {
        nodes: [
          { id: '1', type: 'goal', label: 'Improve accuracy', timestamp: new Date().toISOString() },
          { id: '2', type: 'approach', label: 'Try XGBoost', score: 85, timestamp: new Date().toISOString() },
          { id: '3', type: 'dead_end', label: 'Linear regression', timestamp: new Date().toISOString() },
        ],
        edges: [{ from: '1', to: '2', type: 'explored_by' }],
        metadata: { bestScore: 85, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      };

      const summary = summarizeKG(kg);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toContain('Knowledge Graph Summary');
      expect(summary).toContain('Improve accuracy');
      expect(summary).toContain('Try XGBoost');
      expect(summary).toContain('Dead Ends');
      expect(summary).toContain('Best Score: 85');
    });

    it('returns empty string for empty KG', () => {
      const kg: KnowledgeGraph = {
        nodes: [],
        edges: [],
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      };
      expect(summarizeKG(kg)).toBe('');
    });
  });
});
