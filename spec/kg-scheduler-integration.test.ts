import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runDir } from '../src/store.js';
import {
  readKG, writeKG, addNode, ratchetCheck, detectPlateau, summarizeKG,
} from '../src/knowledge-graph.js';

let projectDir: string;
let runId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'kg-sched-int-'));
  runId = `kg-sched-int-${randomBytes(6).toString('hex')}`;
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: KG summary + campaign context ordering simulation
// ---------------------------------------------------------------------------
describe('KG summary injection ordering (scheduler line 1613)', () => {
  it('KG summary is prepended BEFORE campaign context — KG appears first in final prompt', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Maximize F1' });
    addNode(projectDir, runId, { type: 'dead_end', label: 'Bad approach' });
    const kgSummary = summarizeKG(readKG(projectDir, runId));

    // Simulate scheduler logic: campaign context prepended first, then KG prepended
    const originalPrompt = 'You are a planner. Decide what to explore next.';
    const campaignCtx = '=== CAMPAIGN ===\nIteration 3, previous score: 0.8\n=== END CAMPAIGN ===\n\n';

    // Step 1: campaign context prepend (scheduler line 1612)
    let resolvedPrompt = campaignCtx + originalPrompt;
    // Step 2: KG summary prepend (scheduler line 1614)
    if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;

    // The KG summary ends up BEFORE campaign context
    const kgIdx = resolvedPrompt.indexOf('Knowledge Graph Summary');
    const campaignIdx = resolvedPrompt.indexOf('=== CAMPAIGN ===');
    const promptIdx = resolvedPrompt.indexOf('You are a planner');

    expect(kgIdx).toBeLessThan(campaignIdx);
    expect(campaignIdx).toBeLessThan(promptIdx);
    // This documents the current behavior: KG → Campaign → Prompt
  });

  it('empty KG does not affect campaign context + prompt ordering', () => {
    const kgSummary = summarizeKG(readKG(projectDir, runId));
    const originalPrompt = 'Plan next iteration.';
    const campaignCtx = '=== CAMPAIGN ===\ndata\n=== END CAMPAIGN ===\n\n';

    let resolvedPrompt = campaignCtx + originalPrompt;
    if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;

    // No KG summary, so campaign context is first
    expect(resolvedPrompt.startsWith('=== CAMPAIGN ===')).toBe(true);
  });

  it('KG summary only injected for stages with no dependencies (simulated)', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    const kgSummary = summarizeKG(readKG(projectDir, runId));

    // Stage with dependencies: KG summary should NOT be injected
    const hasDeps = true;
    const originalPrompt = 'Execute sub-task.';
    let withDeps = originalPrompt;
    if (!hasDeps && kgSummary) withDeps = kgSummary + '\n\n' + withDeps;
    expect(withDeps).toBe(originalPrompt); // no KG injected

    // Stage without dependencies: KG summary SHOULD be injected
    const noDeps = false;
    let withoutDeps = originalPrompt;
    if (!noDeps && kgSummary) withoutDeps = kgSummary + '\n\n' + withoutDeps;
    expect(withoutDeps).toContain('Knowledge Graph Summary');
  });
});

// ---------------------------------------------------------------------------
// Test 2: ratchetCheck with no metric — bestScore stays undefined
// ---------------------------------------------------------------------------
describe('ratchetCheck with no metric (scheduler line 1148-1156)', () => {
  it('when no ratchetCheck is called, bestScore remains undefined', () => {
    // Simulate: findCampaignMetric returns null, so ratchetCheck is never called
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBeUndefined();
  });

  it('after adding nodes but no ratchetCheck, bestScore stays undefined', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'G1' });
    addNode(projectDir, runId, { type: 'approach', label: 'A1' });
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBeUndefined();
  });

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
});

// ---------------------------------------------------------------------------
// Test 3: ratchetCheck equal-score edge case
// ---------------------------------------------------------------------------
describe('ratchetCheck equal-score behavior', () => {
  it('equal score is NOT an improvement (uses > not >=)', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    const result = ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(result.improved).toBe(false);
    expect(result.previousBest).toBe(80);
    expect(result.currentScore).toBe(80);
  });

  it('equal score marks approach as dead_end even though score matches best', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Stagnant approach' });
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy', undefined, approach.id);
    const kg = readKG(projectDir, runId);
    const updated = kg.nodes.find(n => n.id === approach.id)!;
    // Equal score → not improved → approach marked dead_end
    expect(updated.type).toBe('dead_end');
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
});

// ---------------------------------------------------------------------------
// Test 4: detectPlateau edge cases and scheduler integration gap
// ---------------------------------------------------------------------------
describe('detectPlateau edge cases', () => {
  it('detectPlateau is not called by the scheduler (dead code)', () => {
    // This test documents that detectPlateau exists but is never invoked by the scheduler.
    // The scheduler only calls ratchetCheck. detectPlateau is available but unused.
    // Verify it works correctly in isolation anyway.
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(detectPlateau(projectDir, runId, 3)).toBe(true);
  });

  it('plateau with window=1 detects single stagnant result', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(detectPlateau(projectDir, runId, 1)).toBe(true);
  });

  it('no plateau when most recent score differs from best', () => {
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    ratchetCheck(projectDir, runId, 85, 'accuracy'); // regression
    // Most recent is 85, best is 90 → not a plateau
    expect(detectPlateau(projectDir, runId, 3)).toBe(false);
  });

  it('plateau detection after improvement then stagnation', () => {
    ratchetCheck(projectDir, runId, 70, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy'); // improvement
    ratchetCheck(projectDir, runId, 80, 'accuracy'); // stagnant
    ratchetCheck(projectDir, runId, 80, 'accuracy'); // stagnant
    // Last 3 are all 80 = bestScore → plateau
    expect(detectPlateau(projectDir, runId, 3)).toBe(true);
  });

  it('returns false when bestScore is undefined', () => {
    expect(detectPlateau(projectDir, runId)).toBe(false);
  });

  it('returns false with fewer results than window', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    expect(detectPlateau(projectDir, runId, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Concurrent KG writes — race condition in addNode
// ---------------------------------------------------------------------------
describe('concurrent KG writes', () => {
  it('rapid sequential addNode calls all persist', () => {
    // Sequential calls should all persist since they're synchronous
    for (let i = 0; i < 10; i++) {
      addNode(projectDir, runId, { type: 'finding', label: `Node-${i}` });
    }
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(kg.nodes.some(n => n.label === `Node-${i}`)).toBe(true);
    }
  });

  it('concurrent addNode calls may lose writes (documents race condition)', async () => {
    // addNode does read-modify-write without locking.
    // If two calls read the same state simultaneously, one write is lost.
    // Since addNode is synchronous and Node.js is single-threaded,
    // true concurrency requires worker_threads or child_process.
    // But we can demonstrate the pattern is vulnerable by simulating it:
    const kg1 = readKG(projectDir, runId);
    const kg2 = readKG(projectDir, runId);

    // Both read empty graph. Now both add a node and write.
    kg1.nodes.push({ id: 'a', type: 'finding', label: 'From writer 1', timestamp: new Date().toISOString() });
    kg2.nodes.push({ id: 'b', type: 'finding', label: 'From writer 2', timestamp: new Date().toISOString() });

    writeKG(projectDir, runId, kg1);
    writeKG(projectDir, runId, kg2);

    // Writer 2 overwrites writer 1's changes
    const final = readKG(projectDir, runId);
    expect(final.nodes).toHaveLength(1);
    expect(final.nodes[0].label).toBe('From writer 2');
    // This documents the race condition: writer 1's node is lost
  });
});

// ---------------------------------------------------------------------------
// Test 6: ratchetCheck + summarizeKG integration (full ratchet loop)
// ---------------------------------------------------------------------------
describe('ratchet loop integration with KG summary', () => {
  it('ratchet results appear in subsequent KG summaries', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Optimize metric' });
    ratchetCheck(projectDir, runId, 0.75, 'f1');
    ratchetCheck(projectDir, runId, 0.82, 'f1');
    ratchetCheck(projectDir, runId, 0.80, 'f1'); // regression

    const summary = summarizeKG(readKG(projectDir, runId));
    expect(summary).toContain('Best Score: 0.82');
    expect(summary).toContain('Goals: Optimize metric');
  });

  it('dead_end approaches from ratchet appear in summary', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Bad Strategy' });
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    ratchetCheck(projectDir, runId, 70, 'accuracy', undefined, approach.id);

    const kg = readKG(projectDir, runId);
    const summary = summarizeKG(kg);
    // After being marked dead_end, it should appear in Dead Ends section
    expect(summary).toContain('Dead Ends:');
    expect(summary).toContain('Bad Strategy');
    // It should NOT appear in Approaches section anymore
    expect(summary).not.toContain('Approaches:');
  });

  it('multiple ratchet iterations build up result nodes', () => {
    for (let i = 0; i < 5; i++) {
      ratchetCheck(projectDir, runId, 70 + i * 5, 'accuracy');
    }
    const kg = readKG(projectDir, runId);
    const results = kg.nodes.filter(n => n.type === 'result');
    expect(results).toHaveLength(5);
    expect(kg.metadata.bestScore).toBe(90);
  });

  it('metricName is set on first ratchetCheck and updated on improvement', () => {
    ratchetCheck(projectDir, runId, 80, 'accuracy');
    let kg = readKG(projectDir, runId);
    expect(kg.metadata.metricName).toBe('accuracy');

    // Different metric name on improvement
    ratchetCheck(projectDir, runId, 90, 'f1_score');
    kg = readKG(projectDir, runId);
    expect(kg.metadata.metricName).toBe('f1_score');
  });

  it('metricName is NOT updated when score does not improve', () => {
    ratchetCheck(projectDir, runId, 90, 'accuracy');
    ratchetCheck(projectDir, runId, 80, 'f1_score');
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.metricName).toBe('accuracy');
  });
});

// ---------------------------------------------------------------------------
// Test 7: ratchetCheck with stageId tracking
// ---------------------------------------------------------------------------
describe('ratchetCheck stageId tracking', () => {
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
