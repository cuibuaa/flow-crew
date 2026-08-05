import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  readKG, writeKG, addNode, ratchetCheck, detectPlateau,
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

describe('detectPlateau', () => {
  it('returns false when not enough result nodes', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(detectPlateau(projectDir, runId, 3)).toBe(false);
  });

  it('returns true when last N results all equal bestScore', () => {
    // First call sets bestScore to 80
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    // Next two calls with same score — not improvements, but score equals bestScore
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(detectPlateau(projectDir, runId, 3)).toBe(true);
  });

  it('returns false when scores vary', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 85, 'accuracy');
    ratchetCheck(projectDir, runId, 83, 'accuracy');
    expect(detectPlateau(projectDir, runId, 3)).toBe(false);
  });
});
