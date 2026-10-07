import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runDir } from '../src/store.js';
import {
  readKG, writeKG, addNode, addEdge, summarizeKG, ratchetCheck,
  type KnowledgeGraph,
} from '../src/knowledge-graph.js';

let projectDir: string;
let runId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-planner-'));
  runId = `planner-integration-test-${randomBytes(6).toString('hex')}`;
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('summarizeKG format for planner consumption', () => {
  it('returns empty string for empty KG — planner gets no KG context', () => {
    const kg = readKG(projectDir, runId);
    expect(summarizeKG(kg)).toBe('');
  });

  it('includes header with node and edge counts', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    addNode(projectDir, runId, { type: 'approach', label: 'A1' });
    const kg = readKG(projectDir, runId);
    const summary = summarizeKG(kg);
    expect(summary).toContain('Knowledge Graph Summary');
    expect(summary).toContain('2 nodes');
    expect(summary).toContain('0 edges');
  });

  it('includes goals so planner knows what to optimize', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Maximize F1 score' });
    addNode(projectDir, runId, { type: 'goal', label: 'Minimize latency' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Goals:');
    expect(summary).toContain('Maximize F1 score');
    expect(summary).toContain('Minimize latency');
  });

  it('includes approaches with scores so planner can compare', () => {
    addNode(projectDir, runId, { type: 'approach', label: 'XGBoost', score: 0.85 });
    addNode(projectDir, runId, { type: 'approach', label: 'Random Forest', score: 0.78 });
    addNode(projectDir, runId, { type: 'approach', label: 'Untested approach' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Approaches:');
    expect(summary).toContain('XGBoost (score: 0.85)');
    expect(summary).toContain('Random Forest (score: 0.78)');
    expect(summary).toContain('Untested approach');
    // Untested approach should NOT have a score annotation
    expect(summary).not.toContain('Untested approach (score:');
  });

  it('includes dead ends so planner avoids them', () => {
    addNode(projectDir, runId, { type: 'dead_end', label: 'Linear SVM — overfits' });
    addNode(projectDir, runId, { type: 'dead_end', label: 'Naive Bayes — too simple' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Dead Ends:');
    expect(summary).toContain('Linear SVM — overfits');
    expect(summary).toContain('Naive Bayes — too simple');
  });

  it('includes user hints so planner prioritizes them', () => {
    addNode(projectDir, runId, { type: 'user_hint', label: 'Try dropout regularization' });
    addNode(projectDir, runId, { type: 'user_hint', label: 'Use batch size 32' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('User Hints:');
    expect(summary).toContain('Try dropout regularization');
    expect(summary).toContain('Use batch size 32');
  });

  it('includes bestScore when set', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Improve accuracy' });
    const kg = readKG(projectDir, runId);
    kg.metadata.bestScore = 0.92;
    writeKG(projectDir, runId, kg);
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Best Score: 0.92');
  });

  it('omits bestScore line when not set', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).not.toContain('Best Score');
  });

  it('omits sections for missing node types', () => {
    // KG with only a goal — no approaches, dead ends, or hints
    addNode(projectDir, runId, { type: 'goal', label: 'Only goal' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Goals:');
    expect(summary).not.toContain('Approaches:');
    expect(summary).not.toContain('Dead Ends:');
    expect(summary).not.toContain('User Hints:');
  });
});

describe('edge cases for planner context', () => {
  it('KG with only dead ends — planner should see what to avoid', () => {
    addNode(projectDir, runId, { type: 'dead_end', label: 'Bad approach 1' });
    addNode(projectDir, runId, { type: 'dead_end', label: 'Bad approach 2' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Dead Ends:');
    expect(summary).toContain('Bad approach 1');
    expect(summary).toContain('Bad approach 2');
    expect(summary).not.toContain('Goals:');
    expect(summary).not.toContain('Approaches:');
  });

  it('KG with only user hints — planner should see suggestions', () => {
    addNode(projectDir, runId, { type: 'user_hint', label: 'Focus on data augmentation' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('User Hints:');
    expect(summary).toContain('Focus on data augmentation');
    expect(summary).not.toContain('Goals:');
  });

  it('KG with findings and insights — not shown in summary sections', () => {
    addNode(projectDir, runId, { type: 'finding', label: 'Data is skewed' });
    addNode(projectDir, runId, { type: 'insight', label: 'Feature X is important' });
    const summary = summarizeKG(readKG(projectDir, runId));
    // These types exist in the KG but summarizeKG only shows goals, approaches, dead_ends, user_hints
    expect(summary).toContain('2 nodes');
    expect(summary).not.toContain('Data is skewed');
    expect(summary).not.toContain('Feature X is important');
  });

  it('edge count is reflected in summary header', () => {
    const n1 = addNode(projectDir, runId, { type: 'goal', label: 'G' });
    const n2 = addNode(projectDir, runId, { type: 'approach', label: 'A' });
    addEdge(projectDir, runId, { from: n1.id, to: n2.id, type: 'explored_by' });
    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('1 edges');
  });
});
