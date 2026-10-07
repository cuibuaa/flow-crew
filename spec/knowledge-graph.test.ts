import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  readKG, writeKG, addNode, updateNode, removeNode, addEdge, summarizeKG, kgPath,
} from '../src/knowledge-graph.js';
import { runDir } from '../src/store.js';

let projectDir: string;
let runId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-test-'));
  runId = 'kg-test-' + randomBytes(6).toString('hex');
});

afterEach(() => {
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('KG CRUD operations', () => {
  it('readKG returns empty graph when no file exists', () => {
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toEqual([]);
    expect(kg.edges).toEqual([]);
    expect(kg.metadata.createdAt).toBeTruthy();
    expect(kg.metadata.updatedAt).toBeTruthy();
  });

  it('addNode creates a goal node with id and timestamp', () => {
    const node = addNode(projectDir, runId, { type: 'goal', label: 'Improve accuracy' });
    expect(node.id).toBeTruthy();
    expect(node.timestamp).toBeTruthy();
    expect(node.type).toBe('goal');
    expect(node.label).toBe('Improve accuracy');
    // Verify persisted
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(1);
    expect(kg.nodes[0].id).toBe(node.id);
  });

  it('addNode creates user_hint nodes', () => {
    const node = addNode(projectDir, runId, { type: 'user_hint', label: 'Try batch size 32' });
    expect(node.type).toBe('user_hint');
    expect(node.label).toBe('Try batch size 32');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(1);
    expect(kg.nodes[0].type).toBe('user_hint');
  });

  it('updateNode changes type to dead_end', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'Linear regression' });
    const updated = updateNode(projectDir, runId, node.id, { type: 'dead_end' });
    expect(updated).not.toBeNull();
    expect(updated!.type).toBe('dead_end');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes[0].type).toBe('dead_end');
  });

  it('updateNode changes score', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'Random forest' });
    const updated = updateNode(projectDir, runId, node.id, { score: 0.95 });
    expect(updated!.score).toBe(0.95);
    const kg = readKG(projectDir, runId);
    expect(kg.nodes[0].score).toBe(0.95);
  });

  it('updateNode returns null for nonexistent node', () => {
    const result = updateNode(projectDir, runId, 'nonexistent', { label: 'x' });
    expect(result).toBeNull();
  });

  it('removeNode deletes node and cleans up edges', () => {
    const n1 = addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    const n2 = addNode(projectDir, runId, { type: 'approach', label: 'A1' });
    const n3 = addNode(projectDir, runId, { type: 'approach', label: 'A2' });
    addEdge(projectDir, runId, { from: n1.id, to: n2.id, type: 'explored_by' });
    addEdge(projectDir, runId, { from: n1.id, to: n3.id, type: 'explored_by' });
    addEdge(projectDir, runId, { from: n2.id, to: n3.id, type: 'supports' });

    const removed = removeNode(projectDir, runId, n2.id);
    expect(removed).toBe(true);

    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(2);
    expect(kg.nodes.find(n => n.id === n2.id)).toBeUndefined();
    // Edges referencing n2 should be gone
    expect(kg.edges.filter(e => e.from === n2.id || e.to === n2.id)).toHaveLength(0);
    // Edge between n1 and n3 should remain
    expect(kg.edges).toHaveLength(1);
    expect(kg.edges[0].from).toBe(n1.id);
    expect(kg.edges[0].to).toBe(n3.id);
  });

  it('removeNode returns false for nonexistent node', () => {
    expect(removeNode(projectDir, runId, 'nonexistent')).toBe(false);
  });

  it('addEdge creates edge referencing valid node IDs', () => {
    const n1 = addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    const n2 = addNode(projectDir, runId, { type: 'approach', label: 'A1' });
    const edge = addEdge(projectDir, runId, { from: n1.id, to: n2.id, type: 'explored_by' });
    expect(edge.from).toBe(n1.id);
    expect(edge.to).toBe(n2.id);
    expect(edge.type).toBe('explored_by');
    const kg = readKG(projectDir, runId);
    expect(kg.edges).toHaveLength(1);
  });

  it('persists correctly to knowledge_graph.json', () => {
    const node = addNode(projectDir, runId, { type: 'goal', label: 'Test persistence' });
    const filePath = kgPath(projectDir, runId);
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw.nodes).toHaveLength(1);
    expect(raw.nodes[0].id).toBe(node.id);
    expect(raw.nodes[0].label).toBe('Test persistence');
    expect(raw.metadata.updatedAt).toBeTruthy();
  });

  it('readKG returns all nodes and edges', () => {
    const n1 = addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    const n2 = addNode(projectDir, runId, { type: 'approach', label: 'A1' });
    addEdge(projectDir, runId, { from: n1.id, to: n2.id, type: 'explored_by' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(2);
    expect(kg.edges).toHaveLength(1);
    expect(kg.metadata).toBeTruthy();
  });
});

describe('summarizeKG', () => {
  it('returns empty string for empty graph', () => {
    const kg = readKG(projectDir, runId);
    expect(summarizeKG(kg)).toBe('');
  });

  it('includes goals, approaches, dead ends, and user hints', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Improve F1' });
    addNode(projectDir, runId, { type: 'approach', label: 'XGBoost', score: 0.8 });
    addNode(projectDir, runId, { type: 'dead_end', label: 'Linear SVM' });
    addNode(projectDir, runId, { type: 'user_hint', label: 'Try feature engineering' });
    const kg = readKG(projectDir, runId);
    const summary = summarizeKG(kg);
    expect(summary).toContain('Goals: Improve F1');
    expect(summary).toContain('XGBoost (score: 0.8)');
    expect(summary).toContain('Dead Ends: Linear SVM');
    expect(summary).toContain('User Hints: Try feature engineering');
    expect(summary).toContain('4 nodes');
  });
});

describe('KG realistic scenarios', () => {
  it('full workflow: goal → approaches → results → dead ends → summary', () => {
    const goal = addNode(projectDir, runId, { type: 'goal', label: 'Maximize accuracy' });
    const a1 = addNode(projectDir, runId, { type: 'approach', label: 'Random Forest', score: 0.82 });
    const a2 = addNode(projectDir, runId, { type: 'approach', label: 'Neural Net', score: 0.91 });
    addEdge(projectDir, runId, { from: goal.id, to: a1.id, type: 'explored_by' });
    addEdge(projectDir, runId, { from: goal.id, to: a2.id, type: 'explored_by' });
    addNode(projectDir, runId, { type: 'finding', label: 'RF overfits on small data' });

    // Mark RF as dead end
    updateNode(projectDir, runId, a1.id, { type: 'dead_end' });

    // Add user hint
    addNode(projectDir, runId, { type: 'user_hint', label: 'Try dropout regularization' });

    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(5);
    expect(kg.edges).toHaveLength(2);

    const summary = summarizeKG(kg);
    expect(summary).toContain('Maximize accuracy');
    expect(summary).toContain('Neural Net (score: 0.91)');
    expect(summary).toContain('Dead Ends');
    expect(summary).toContain('Random Forest');
    expect(summary).toContain('User Hints');
    expect(summary).toContain('dropout');
  });

  it('removing a node with multiple edges cleans all of them', () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      addNode(projectDir, runId, { type: 'approach', label: `N${i}` })
    );
    // Create a star topology: node[0] connected to all others
    for (let i = 1; i < 5; i++) {
      addEdge(projectDir, runId, { from: nodes[0].id, to: nodes[i].id, type: 'supports' });
    }
    // Also add edges between other nodes
    addEdge(projectDir, runId, { from: nodes[1].id, to: nodes[2].id, type: 'depends_on' });
    addEdge(projectDir, runId, { from: nodes[3].id, to: nodes[0].id, type: 'contradicts' });

    let kg = readKG(projectDir, runId);
    expect(kg.edges).toHaveLength(6);

    // Remove the hub node
    removeNode(projectDir, runId, nodes[0].id);
    kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(4);
    // Only the edge between nodes[1] and nodes[2] should survive
    expect(kg.edges).toHaveLength(1);
    expect(kg.edges[0].from).toBe(nodes[1].id);
    expect(kg.edges[0].to).toBe(nodes[2].id);
  });

  it('writeKG updates the updatedAt timestamp on the logical clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      const kg = readKG(projectDir, runId);
      const before = kg.metadata.updatedAt;
      vi.setSystemTime(new Date('2026-08-01T00:00:00.001Z'));
      writeKG(projectDir, runId, kg);
      const kg2 = readKG(projectDir, runId);
      expect(kg2.metadata.updatedAt).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('multiple addNode calls produce unique IDs', () => {
    const labels = Array.from({ length: 20 }, (_, index) => `F${index}`);
    const ids = new Set<string>();
    for (const label of labels) {
      const node = addNode(projectDir, runId, { type: 'finding', label });
      ids.add(node.id);
    }
    expect(ids.size).toBe(labels.length);
  });

  it('updateNode preserves fields not being updated', () => {
    const node = addNode(projectDir, runId, {
      type: 'approach', label: 'Original', details: 'Some details', score: 0.5,
    });
    updateNode(projectDir, runId, node.id, { score: 0.9 });
    const kg = readKG(projectDir, runId);
    const updated = kg.nodes[0];
    expect(updated.label).toBe('Original');
    expect(updated.details).toBe('Some details');
    expect(updated.type).toBe('approach');
    expect(updated.score).toBe(0.9);
  });

  it('addEdge with label persists the label', () => {
    const n1 = addNode(projectDir, runId, { type: 'goal', label: 'G' });
    const n2 = addNode(projectDir, runId, { type: 'finding', label: 'F' });
    addEdge(projectDir, runId, { from: n1.id, to: n2.id, type: 'found_that', label: 'discovered via experiment' });
    const kg = readKG(projectDir, runId);
    expect(kg.edges[0].label).toBe('discovered via experiment');
  });
});
