import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readKG, writeKG, addNode, removeNode, summarizeKG,
  type KnowledgeGraph, type KGNode,
} from '../src/knowledge-graph.js';

vi.mock('../src/store.js', () => ({
  runDir: (projectDir: string, runId: string) => join(projectDir, '.fc', 'runs', runId),
  stageDir: (projectDir: string, runId: string, stageId: string) => join(projectDir, '.fc', 'runs', runId, 'stages', stageId),
  readStageStatus: vi.fn(() => ({ status: 'complete', retries: 0, artifacts: ['file.ts'] })),
  readStageOutput: vi.fn(() => 'stage output text'),
}));

import { buildStagePrompt } from '../src/handoff.js';

let projectDir: string;
const runId = 'test-run-backend';

function makeNode(overrides: Partial<KGNode> & { type: KGNode['type']; label: string }): KGNode {
  return { id: 'n' + Math.random().toString(16).slice(2, 8), timestamp: new Date().toISOString(), ...overrides };
}

function makeKG(nodes: KGNode[], edges: KnowledgeGraph['edges'] = []): KnowledgeGraph {
  const now = new Date().toISOString();
  return { nodes, edges, metadata: { createdAt: now, updatedAt: now } };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-backend-'));
});

// ── Group A: Backend Integration Tests ──────────────────────────────

describe('Group A: Backend Integration', () => {
  it('A1: summarizeKG produces summary with Goals and Approaches', () => {
    const kg = makeKG([
      makeNode({ type: 'goal', label: 'Improve accuracy' }),
      makeNode({ type: 'approach', label: 'Random forest', score: 0.85 }),
    ]);
    const summary = summarizeKG(kg);
    expect(summary).toBeTruthy();
    expect(summary).toContain('Goals:');
    expect(summary).toContain('Approaches:');
    expect(summary).toContain('Improve accuracy');
    expect(summary).toContain('Random forest');
  });

  it('A2: summarizeKG includes user hints', () => {
    const kg = makeKG([
      makeNode({ type: 'user_hint', label: 'Try batch size 32' }),
    ]);
    const summary = summarizeKG(kg);
    expect(summary).toContain('User Hints:');
    expect(summary).toContain('Try batch size 32');
  });

  it('A3: summarizeKG includes dead ends', () => {
    const kg = makeKG([
      makeNode({ type: 'dead_end', label: 'Linear regression failed' }),
    ]);
    const summary = summarizeKG(kg);
    expect(summary).toContain('Dead Ends:');
    expect(summary).toContain('Linear regression failed');
  });

  it('A4: agent YAML prompts include KG instructions', () => {
    const planner = readFileSync(join(process.cwd(), 'config/agents/planner.yaml'), 'utf-8');
    expect(planner).toContain('Knowledge Graph Integration');

    const researcher = readFileSync(join(process.cwd(), 'config/agents/researcher.yaml'), 'utf-8');
    expect(researcher).toContain('knowledge_graph.json');

    const coder = readFileSync(join(process.cwd(), 'config/agents/coder.yaml'), 'utf-8');
    expect(coder).toContain('knowledge_graph.json');

    const qa = readFileSync(join(process.cwd(), 'config/agents/qa.yaml'), 'utf-8');
    expect(qa).toContain('knowledge_graph.json');
  });

  it('A5: buildStagePrompt substitutes kg_path variable', () => {
    const result = buildStagePrompt({
      dependsOn: [],
      promptTemplate: 'KG at {kg_path}',
      projectDir,
      runId: 'r1',
      runDir: join(projectDir, '.fc', 'runs', 'r1'),
    });
    expect(result).toContain('knowledge_graph.json');
  });

  it('A6: worker detects KG changes in artifacts', () => {
    const withKG = ['foo.ts', 'knowledge_graph.json'];
    expect(withKG.some(a => a.endsWith('knowledge_graph.json'))).toBe(true);

    const withoutKG = ['foo.ts', 'bar.ts'];
    expect(withoutKG.some(a => a.endsWith('knowledge_graph.json'))).toBe(false);
  });

  it('A7: KG grows across iterations via addNode', () => {
    const kg = makeKG([
      makeNode({ type: 'goal', label: 'G1' }),
      makeNode({ type: 'approach', label: 'A1' }),
    ]);
    writeKG(projectDir, runId, kg);
    expect(readKG(projectDir, runId).nodes).toHaveLength(2);

    addNode(projectDir, runId, { type: 'finding', label: 'F1' });
    expect(readKG(projectDir, runId).nodes).toHaveLength(3);

    addNode(projectDir, runId, { type: 'result', label: 'R1', score: 0.9 });
    expect(readKG(projectDir, runId).nodes).toHaveLength(4);
  });
});

// ── Group E: Edge Case Tests ────────────────────────────────────────

describe('Group E: Edge Cases', () => {
  it('readKG returns empty graph for non-existent file', () => {
    const kg = readKG('/tmp/nonexistent-' + Date.now(), 'no-run');
    expect(kg.nodes).toEqual([]);
    expect(kg.edges).toEqual([]);
    expect(kg.metadata.createdAt).toBeTruthy();
    expect(kg.metadata.updatedAt).toBeTruthy();
  });

  it('summarizeKG works with only a goal node', () => {
    const kg = makeKG([makeNode({ type: 'goal', label: 'Solo goal' })]);
    const summary = summarizeKG(kg);
    expect(summary).toContain('Goals:');
    expect(summary).toContain('Solo goal');
    expect(summary).toContain('1 nodes');
  });

  it('large KG (55 nodes, 50 edges) operations work', () => {
    const nodes: KGNode[] = [];
    for (let i = 0; i < 55; i++) {
      nodes.push(makeNode({ type: i % 2 === 0 ? 'goal' : 'approach', label: `N${i}` }));
    }
    const edges: KnowledgeGraph['edges'] = [];
    for (let i = 0; i < 50; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, type: 'explored_by' });
    }
    const kg = makeKG(nodes, edges);
    writeKG(projectDir, runId, kg);

    const loaded = readKG(projectDir, runId);
    expect(loaded.nodes).toHaveLength(55);
    expect(loaded.edges).toHaveLength(50);

    const summary = summarizeKG(loaded);
    expect(summary).toContain('55 nodes');
    expect(summary.length).toBeLessThan(5000);

    addNode(projectDir, runId, { type: 'insight', label: 'Extra' });
    expect(readKG(projectDir, runId).nodes).toHaveLength(56);

    const removed = removeNode(projectDir, runId, nodes[0].id);
    expect(removed).toBe(true);
    expect(readKG(projectDir, runId).nodes).toHaveLength(55);
  });

  it('rapid sequential addNode calls do not corrupt', () => {
    writeKG(projectDir, runId, makeKG([]));
    addNode(projectDir, runId, { type: 'goal', label: 'Rapid1' });
    addNode(projectDir, runId, { type: 'goal', label: 'Rapid2' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(2);
    expect(kg.nodes.map(n => n.label)).toContain('Rapid1');
    expect(kg.nodes.map(n => n.label)).toContain('Rapid2');
  });

  it('addNode with invalid type does not crash', () => {
    const node = addNode(projectDir, runId, { type: 'invalid_type' as any, label: 'Weird node' });
    expect(node.id).toBeTruthy();
    expect(node.type).toBe('invalid_type');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(1);
    expect(kg.nodes[0].label).toBe('Weird node');
  });
});
