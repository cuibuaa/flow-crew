import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startDashboard } from '../src/dashboard.js';
import { createRun } from '../src/store.js';

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

describe('Knowledge Graph API (Group B)', () => {
  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-kg-api-'));
    mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    writeFileSync(
      join(projectDir, 'config', 'workflows', 'default.yaml'),
      'name: default\nstages: []\n',
    );

    app = await startDashboard(projectDir, 0);

    // This suite exercises KG endpoints, not task registration. Create an
    // isolated run fixture directly so the public spec does not depend on a
    // live daemon or revive the removed dashboard-only creation path.
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

  // B1: GET returns correct graph structure
  describe('B1: GET /api/tasks/:id/knowledge-graph', () => {
    it('returns nodes array, edges array, and metadata object', async () => {
      const { status, data } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(status).toBe(200);
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
      expect(data.metadata).toBeDefined();
      expect(typeof data.metadata.createdAt).toBe('string');
      expect(typeof data.metadata.updatedAt).toBe('string');
    });
  });

  // B2: POST node
  describe('B2: POST /api/tasks/:id/knowledge-graph/nodes', () => {
    it('adds a user_hint node and returns it with id/type/label/timestamp', async () => {
      const { status, data: node } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'user_hint',
        label: 'Test hint',
        details: 'test details',
      });
      expect(status).toBe(200);
      expect(node.id).toBeTruthy();
      expect(node.type).toBe('user_hint');
      expect(node.label).toBe('Test hint');
      expect(typeof node.timestamp).toBe('string');

      // Verify GET returns the new node
      const { data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(kg.nodes.some((n: any) => n.id === node.id)).toBe(true);
    });
  });

  // B3: PATCH node
  describe('B3: PATCH /api/tasks/:id/knowledge-graph/nodes/:id', () => {
    it('updates a node type to dead_end', async () => {
      const { data: node } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'finding',
        label: 'To be updated',
      });

      const { status, data: updated } = await api('PATCH', `/api/tasks/${taskId}/knowledge-graph/nodes/${node.id}`, {
        type: 'dead_end',
      });
      expect(status).toBe(200);
      expect(updated.type).toBe('dead_end');
      expect(updated.label).toBe('To be updated');
    });
  });

  // B4: DELETE node removes node and edges
  describe('B4: DELETE /api/tasks/:id/knowledge-graph/nodes/:id', () => {
    it('deletes a node and its edges', async () => {
      const { data: nodeA } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'approach',
        label: 'Node A',
      });
      const { data: nodeB } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'finding',
        label: 'Node B',
      });

      // Add edge from A to B
      await api('POST', `/api/tasks/${taskId}/knowledge-graph/edges`, {
        from: nodeA.id,
        to: nodeB.id,
        type: 'found_that',
      });

      // Delete node A
      const { status } = await api('DELETE', `/api/tasks/${taskId}/knowledge-graph/nodes/${nodeA.id}`);
      expect(status).toBe(200);

      // Verify node and edge are gone
      const { data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(kg.nodes.some((n: any) => n.id === nodeA.id)).toBe(false);
      expect(kg.edges.some((e: any) => e.from === nodeA.id || e.to === nodeA.id)).toBe(false);
      // Node B should still exist
      expect(kg.nodes.some((n: any) => n.id === nodeB.id)).toBe(true);
    });
  });

  // B5: POST edge
  describe('B5: POST /api/tasks/:id/knowledge-graph/edges', () => {
    it('adds an edge between two nodes', async () => {
      const { data: n1 } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'goal',
        label: 'Edge test node 1',
      });
      const { data: n2 } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'result',
        label: 'Edge test node 2',
      });

      const { status, data: edge } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/edges`, {
        from: n1.id,
        to: n2.id,
        type: 'explored_by',
        label: 'test edge',
      });
      expect(status).toBe(200);
      expect(edge.from).toBe(n1.id);
      expect(edge.to).toBe(n2.id);
      expect(edge.type).toBe('explored_by');

      // Verify GET returns the edge
      const { data: kg } = await api('GET', `/api/tasks/${taskId}/knowledge-graph`);
      expect(kg.edges.some((e: any) => e.from === n1.id && e.to === n2.id && e.type === 'explored_by')).toBe(true);
    });
  });

  // B6: Error cases
  describe('B6: Error cases', () => {
    it('POST node with missing label returns 400', async () => {
      const { status } = await api('POST', `/api/tasks/${taskId}/knowledge-graph/nodes`, {
        type: 'finding',
      });
      expect(status).toBe(400);
    });

    it('PATCH non-existent node returns 404', async () => {
      const { status } = await api('PATCH', `/api/tasks/${taskId}/knowledge-graph/nodes/nonexistent999`, {
        type: 'dead_end',
      });
      expect(status).toBe(404);
    });

    it('DELETE non-existent node returns 404', async () => {
      const { status } = await api('DELETE', `/api/tasks/${taskId}/knowledge-graph/nodes/nonexistent999`);
      expect(status).toBe(404);
    });

    it('GET KG for non-existent task returns empty graph (not crash)', async () => {
      const { status, data } = await api('GET', '/api/tasks/nonexistent-task-id-xyz/knowledge-graph');
      expect(status).toBe(200);
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(data.nodes.length).toBe(0);
      expect(Array.isArray(data.edges)).toBe(true);
      expect(data.edges.length).toBe(0);
    });
  });
});
