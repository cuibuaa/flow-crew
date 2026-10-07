import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  readKG, writeKG, addNode, ratchetCheck,
} from '../src/knowledge-graph.js';
import { runDir } from '../src/store.js';

let projectDir: string;
let runId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-ratchet-'));
  runId = 'ratchet-' + randomBytes(6).toString('hex');
});

afterEach(() => {
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ratchetCheck', () => {
  it('updates bestScore when score improves (first call)', () => {
    const result = ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(result.improved).toBe(true);
    expect(result.currentScore).toBe(80);
    expect(result.previousBest).toBeUndefined();
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(80);
  });

  it('updates bestScore on successive improvements', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    const result = ratchetCheck(projectDir, runId, 90, 'accuracy');
    expect(result.improved).toBe(true);
    expect(result.previousBest).toBe(80);
    expect(result.currentScore).toBe(90);
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(90);
  });

  it('does NOT update bestScore when score drops', () => {
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    const result = ratchetCheck(projectDir, runId, 70, 'accuracy');
    expect(result.improved).toBe(false);
    expect(result.previousBest).toBe(90);
    expect(result.currentScore).toBe(70);
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(90);
  });

  it('marks approach as dead_end on regression', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Bad approach' });
    // Set bestScore to 90
    const kg = readKG(projectDir, runId);
    kg.metadata.bestScore = 90;
    writeKG(projectDir, runId, kg);

    ratchetCheck(projectDir, runId, 70, 'accuracy', undefined, approach.id);
    const kg2 = readKG(projectDir, runId);
    const updated = kg2.nodes.find(n => n.id === approach.id)!;
    expect(updated.type).toBe('dead_end');
  });

  it('marks approach as promising on improvement', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Good approach' });
    ratchetCheck(projectDir, runId, 80, 'accuracy', undefined, approach.id);
    const kg = readKG(projectDir, runId);
    const updated = kg.nodes.find(n => n.id === approach.id)!;
    expect(updated.details).toContain('[PROMISING]');
  });

  it('always adds a result node', () => {
    ratchetCheck(projectDir, runId, 50, 'accuracy');
    const kg = readKG(projectDir, runId);
    const results = kg.nodes.filter(n => n.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(50);
  });

  it('result node persists even when score drops (KG survives rollback)', () => {
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    ratchetCheck(projectDir, runId, 70, 'accuracy');
    const kg = readKG(projectDir, runId);
    const results = kg.nodes.filter(n => n.type === 'result');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.score)).toContain(70);
    expect(results.map(r => r.score)).toContain(90);
  });
});

describe('ratchet signed scores and attribution', () => {
it('ratchetCheck with score 0 still sets bestScore (0 is a valid score)', () => {
    const result = ratchetCheck(projectDir, runId, 0, 'loss');
    expect(result.improved).toBe(true);
    expect(result.currentScore).toBe(0);
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(0);
  });
it('ratchetCheck with negative score works', () => {
    const result = ratchetCheck(projectDir, runId, -5, 'loss');
    expect(result.improved).toBe(true);
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(-5);
  });
it('approach already marked dead_end is not re-marked on subsequent regressions', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'A1', details: 'original' });
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    // First regression marks as dead_end
    ratchetCheck(projectDir, runId, 70, 'accuracy', undefined, approach.id);
    const kg1 = readKG(projectDir, runId);
    const after1 = kg1.nodes.find(n => n.id === approach.id)!;
    expect(after1.type).toBe('dead_end');
    const details1 = after1.details;

    // Second regression should NOT append another dead_end annotation
    ratchetCheck(projectDir, runId, 60, 'accuracy', undefined, approach.id);
    const kg2 = readKG(projectDir, runId);
    const after2 = kg2.nodes.find(n => n.id === approach.id)!;
    expect(after2.type).toBe('dead_end');
    // Details should not grow with duplicate dead_end messages
    expect(after2.details).toBe(details1);
  });
it('result node records stageId from gate', () => {
    const result = ratchetCheck(projectDir, runId, 85, 'accuracy', 'gate-stage-1');
    const kg = readKG(projectDir, runId);
    const resultNode = kg.nodes.find(n => n.id === result.nodeId)!;
    expect(resultNode.stageId).toBe('gate-stage-1');
  });
it('result node has undefined stageId when not provided', () => {
    const result = ratchetCheck(projectDir, runId, 85, 'accuracy');
    const kg = readKG(projectDir, runId);
    const resultNode = kg.nodes.find(n => n.id === result.nodeId)!;
    expect(resultNode.stageId).toBeUndefined();
  });
});
