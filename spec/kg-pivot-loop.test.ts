import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  readKG, writeKG, addNode, addEdge, markDeadEnd, updateMetadata, kgPath,
  type KnowledgeGraph, type KGNode,
} from '../src/knowledge-graph.js';
import {
  checkCampaignHealth,
  recoverTerminalStudyCompletion,
  type CampaignEntry,
} from '../src/scheduler.js';
import { runDir } from '../src/store.js';

let projectDir: string;
let runId: string;

function freshDir() {
  const dir = join(tmpdir(), 'kg-pivot-' + randomBytes(6).toString('hex'));
  const rid = 'run-' + randomBytes(4).toString('hex');
  mkdirSync(runDir(dir, rid), { recursive: true });
  return { dir, rid };
}

function emptyKG(): KnowledgeGraph {
  const now = new Date().toISOString();
  return { nodes: [], edges: [], metadata: { createdAt: now, updatedAt: now } };
}

beforeEach(() => {
  const f = freshDir();
  projectDir = f.dir;
  runId = f.rid;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── GROUP A: Dead End Auto-Marking ──────────────────────────────────────────

describe('Group A: Dead End Auto-Marking', () => {
  it('A1: plateau detected → approach node type changes to dead_end', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'Linear regression' });
    markDeadEnd(projectDir, runId, node.id, 'plateau detected');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === node.id)!.type).toBe('dead_end');
  });

  it('A2: repeated_failure detected → approach node type changes to dead_end', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'SVM approach' });
    markDeadEnd(projectDir, runId, node.id, 'repeated_failure on gate eval');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === node.id)!.type).toBe('dead_end');
  });

  it('A3: regression detected → approach node type changes to dead_end', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'Deep net' });
    markDeadEnd(projectDir, runId, node.id, 'regression: 3 consecutive declines');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === node.id)!.type).toBe('dead_end');
  });

  it('A4: dead end node gets a reason field with the alert message', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'XGBoost' });
    const reason = 'plateau: 5 entries within ±5%';
    markDeadEnd(projectDir, runId, node.id, reason);
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === node.id)!.reason).toBe(reason);
  });

  it('A5: dead end marking preserves all other node fields', () => {
    const node = addNode(projectDir, runId, {
      type: 'approach', label: 'Random Forest', details: 'ensemble method',
      source: 'paper.pdf', score: 72, stageId: 'stage-1',
    });
    markDeadEnd(projectDir, runId, node.id, 'plateau');
    const kg = readKG(projectDir, runId);
    const updated = kg.nodes.find(n => n.id === node.id)!;
    expect(updated.type).toBe('dead_end');
    expect(updated.reason).toBe('plateau');
    expect(updated.label).toBe('Random Forest');
    expect(updated.details).toBe('ensemble method');
    expect(updated.source).toBe('paper.pdf');
    expect(updated.score).toBe(72);
    expect(updated.stageId).toBe('stage-1');
  });

  it('A6: no approach node exists → markDeadEnd returns null, no crash', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Improve accuracy' });
    const result = markDeadEnd(projectDir, runId, 'nonexistent-id', 'plateau');
    expect(result).toBeNull();
  });

  it('A7: KG file does not exist → markDeadEnd returns null, no crash', () => {
    // Use a fresh dir without writing any KG
    const f = freshDir();
    // Don't write any KG file — but the directory exists
    const result = markDeadEnd(f.dir, f.rid, 'some-id', 'plateau');
    expect(result).toBeNull();
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('A8: multiple approaches — only the failing one gets marked dead_end', () => {
    const a = addNode(projectDir, runId, { type: 'approach', label: 'A' });
    const b = addNode(projectDir, runId, { type: 'approach', label: 'B' });
    const c = addNode(projectDir, runId, { type: 'approach', label: 'C' });
    markDeadEnd(projectDir, runId, b.id, 'regression');
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === a.id)!.type).toBe('approach');
    expect(kg.nodes.find(n => n.id === b.id)!.type).toBe('dead_end');
    expect(kg.nodes.find(n => n.id === c.id)!.type).toBe('approach');
  });
});

// ─── GROUP B: Research Injection ─────────────────────────────────────────────

describe('Group B: Research Injection', () => {
  function buildPlannerPrompt(basePrompt: string, researchInjection?: { alertType: string; message: string }): string {
    let prompt = basePrompt;
    if (researchInjection) {
      prompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${researchInjection.alertType}. ${researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation. Check dead_end nodes in the knowledge graph to understand what has been tried and failed.\n\n` + prompt;
    }
    return prompt;
  }

  it('B1: researchInjection set → planner prompt contains pivot warning', () => {
    const prompt = buildPlannerPrompt('Plan next steps', { alertType: 'plateau', message: '3 entries within ±5%' });
    expect(prompt).toContain('PIVOT REQUIRED');
  });

  it('B2: pivot warning includes the alert type', () => {
    const prompt = buildPlannerPrompt('Plan', { alertType: 'regression', message: 'scores declining' });
    expect(prompt).toContain('regression');
  });

  it('B3: pivot warning includes the alert message', () => {
    const prompt = buildPlannerPrompt('Plan', { alertType: 'plateau', message: '5 entries within ±5%' });
    expect(prompt).toContain('5 entries within ±5%');
  });

  it('B4: planner prompt mentions research stage when pivot required', () => {
    const prompt = buildPlannerPrompt('Plan', { alertType: 'plateau', message: 'stalled' });
    expect(prompt).toContain('research stage');
  });

  it('B5: prompt mentions checking dead_end nodes', () => {
    const prompt = buildPlannerPrompt('Plan', { alertType: 'repeated_failure', message: 'gate fails' });
    expect(prompt).toContain('dead_end');
  });

  it('B6: without researchInjection, planner prompt has no pivot warning', () => {
    const prompt = buildPlannerPrompt('Plan next steps');
    expect(prompt).not.toContain('PIVOT REQUIRED');
    expect(prompt).toBe('Plan next steps');
  });

  it('B7: research injection works across multiple consecutive iterations', () => {
    const p1 = buildPlannerPrompt('Plan', { alertType: 'plateau', message: 'msg1' });
    const p2 = buildPlannerPrompt('Plan', { alertType: 'regression', message: 'msg2' });
    expect(p1).toContain('plateau');
    expect(p1).toContain('msg1');
    expect(p2).toContain('regression');
    expect(p2).toContain('msg2');
  });
});

// ─── GROUP C: Findings → Approach Pipeline ───────────────────────────────────

describe('Group C: Findings → Approach Pipeline', () => {
  it('C1: researcher adds finding nodes to KG', () => {
    const node = addNode(projectDir, runId, { type: 'finding', label: 'LoRA is effective for fine-tuning' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes).toHaveLength(1);
    expect(kg.nodes[0].type).toBe('finding');
    expect(kg.nodes[0].id).toBe(node.id);
  });

  it('C2: finding nodes have source URLs', () => {
    addNode(projectDir, runId, { type: 'finding', label: 'LoRA paper', source: 'https://arxiv.org/abs/2106.09685' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes[0].source).toBe('https://arxiv.org/abs/2106.09685');
  });

  it('C3: planner reads findings from KG in next iteration', () => {
    addNode(projectDir, runId, { type: 'finding', label: 'Finding A' });
    addNode(projectDir, runId, { type: 'finding', label: 'Finding B' });
    addNode(projectDir, runId, { type: 'approach', label: 'Old approach' });
    const kg = readKG(projectDir, runId);
    const findings = kg.nodes.filter(n => n.type === 'finding');
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.label)).toContain('Finding A');
    expect(findings.map(f => f.label)).toContain('Finding B');
  });

  it('C4: planner creates new approach nodes based on findings', () => {
    addNode(projectDir, runId, { type: 'finding', label: 'LoRA works' });
    addNode(projectDir, runId, { type: 'approach', label: 'Use LoRA fine-tuning' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.filter(n => n.type === 'finding')).toHaveLength(1);
    expect(kg.nodes.filter(n => n.type === 'approach')).toHaveLength(1);
  });

  it('C5: new approach nodes connected to finding nodes with edges', () => {
    const finding = addNode(projectDir, runId, { type: 'finding', label: 'LoRA works' });
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Use LoRA' });
    addEdge(projectDir, runId, { from: finding.id, to: approach.id, type: 'supports' });
    const kg = readKG(projectDir, runId);
    expect(kg.edges).toHaveLength(1);
    expect(kg.edges[0]).toEqual({ from: finding.id, to: approach.id, type: 'supports' });
  });

  it('C6: dead_end nodes are identifiable for avoidance', () => {
    const node = addNode(projectDir, runId, { type: 'approach', label: 'INT8 quantization' });
    markDeadEnd(projectDir, runId, node.id, 'plateau');
    const kg = readKG(projectDir, runId);
    const deadEnds = kg.nodes.filter(n => n.type === 'dead_end');
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].label).toBe('INT8 quantization');
  });
});

// ─── GROUP D: KG Metadata Score Tracking ─────────────────────────────────────

describe('Group D: KG Metadata Score Tracking', () => {
  it('D1: updateMetadata sets bestScore', () => {
    updateMetadata(projectDir, runId, 85, 'accuracy');
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(85);
  });

  it('D2: updateMetadata sets metricName', () => {
    updateMetadata(projectDir, runId, 85, 'accuracy');
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.metricName).toBe('accuracy');
  });

  it('D3: updateMetadata refreshes updatedAt on the logical clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      writeKG(projectDir, runId, emptyKG());
      const before = readKG(projectDir, runId).metadata.updatedAt;
      vi.setSystemTime(new Date('2026-08-01T00:00:00.001Z'));
      updateMetadata(projectDir, runId, 50, 'f1');
      const after = readKG(projectDir, runId).metadata.updatedAt;
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('D4: bestScore only updates when score improves (monotonic)', () => {
    updateMetadata(projectDir, runId, 85, 'accuracy');
    updateMetadata(projectDir, runId, 70, 'accuracy');
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(85);
  });

  it('D5: if no metric update, metadata is unchanged', () => {
    const kg = emptyKG();
    kg.metadata.bestScore = 90;
    kg.metadata.metricName = 'accuracy';
    writeKG(projectDir, runId, kg);
    const read = readKG(projectDir, runId);
    expect(read.metadata.bestScore).toBe(90);
  });

  it('D6: updateMetadata on non-existent KG creates it with the score', () => {
    const f = freshDir();
    updateMetadata(f.dir, f.rid, 42, 'loss');
    const kg = readKG(f.dir, f.rid);
    expect(kg.metadata.bestScore).toBe(42);
    expect(kg.metadata.metricName).toBe('loss');
    rmSync(f.dir, { recursive: true, force: true });
  });
});

// ─── GROUP E: Full Loop Integration ──────────────────────────────────────────

describe('Group E: Full Loop Integration', () => {
  function buildPlannerPrompt(basePrompt: string, researchInjection?: { alertType: string; message: string }): string {
    let prompt = basePrompt;
    if (researchInjection) {
      prompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${researchInjection.alertType}. ${researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation. Check dead_end nodes in the knowledge graph to understand what has been tried and failed.\n\n` + prompt;
    }
    return prompt;
  }

  it('end-to-end: approach fails → dead_end → research injection → findings → new approach', () => {
    // Create goal + approach
    addNode(projectDir, runId, { type: 'goal', label: 'Improve accuracy to 90%' });
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Linear regression' });
    // Mark dead end
    markDeadEnd(projectDir, runId, approach.id, 'plateau: no improvement');
    // Simulate research injection
    const prompt = buildPlannerPrompt('Plan', { alertType: 'plateau', message: 'no improvement' });
    expect(prompt).toContain('PIVOT REQUIRED');
    // Add findings
    const finding = addNode(projectDir, runId, { type: 'finding', label: 'Neural nets outperform linear models' });
    // Add new approach connected to finding
    const newApproach = addNode(projectDir, runId, { type: 'approach', label: 'Neural network' });
    addEdge(projectDir, runId, { from: finding.id, to: newApproach.id, type: 'supports' });
    // Verify full chain
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.filter(n => n.type === 'dead_end')).toHaveLength(1);
    expect(kg.nodes.filter(n => n.type === 'finding')).toHaveLength(1);
    expect(kg.nodes.filter(n => n.type === 'approach')).toHaveLength(1);
    expect(kg.edges).toHaveLength(1);
  });

  it('multiple pivots: A fails → B fails → C is active', () => {
    const a = addNode(projectDir, runId, { type: 'approach', label: 'Approach A' });
    markDeadEnd(projectDir, runId, a.id, 'regression');
    const b = addNode(projectDir, runId, { type: 'approach', label: 'Approach B' });
    markDeadEnd(projectDir, runId, b.id, 'plateau');
    const c = addNode(projectDir, runId, { type: 'approach', label: 'Approach C' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.find(n => n.id === a.id)!.type).toBe('dead_end');
    expect(kg.nodes.find(n => n.id === b.id)!.type).toBe('dead_end');
    expect(kg.nodes.find(n => n.id === c.id)!.type).toBe('approach');
  });

  it('user hint + auto-pivot: user_hint and dead_end nodes are identifiable', () => {
    const approach = addNode(projectDir, runId, { type: 'approach', label: 'Old approach' });
    markDeadEnd(projectDir, runId, approach.id, 'plateau');
    addNode(projectDir, runId, { type: 'user_hint', label: 'Try transformer architecture' });
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.filter(n => n.type === 'user_hint')).toHaveLength(1);
    expect(kg.nodes.filter(n => n.type === 'dead_end')).toHaveLength(1);
  });

  it('research injection does not interfere with normal prompts', () => {
    const withInjection = buildPlannerPrompt('Base plan', { alertType: 'plateau', message: 'stalled' });
    const without = buildPlannerPrompt('Base plan');
    expect(withInjection).toContain('PIVOT REQUIRED');
    expect(withInjection).toContain('Base plan');
    expect(without).toBe('Base plan');
    expect(without).not.toContain('PIVOT REQUIRED');
  });

  it('recovery — after successful pivot, campaign health resets', () => {
    const entries: CampaignEntry[] = [
      { seq: 1, runId: 'r1', score: 80, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-01T00:00:00Z' },
      { seq: 2, runId: 'r2', score: 75, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-02T00:00:00Z' },
      { seq: 3, runId: 'r3', score: 70, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-03T00:00:00Z' },
      { seq: 4, runId: 'r4', score: 90, metric: 'acc', gate: 'eval', pass: true, timestamp: '2024-01-04T00:00:00Z' },
      { seq: 5, runId: 'r5', score: 92, metric: 'acc', gate: 'eval', pass: true, timestamp: '2024-01-05T00:00:00Z' },
    ];
    const alert = checkCampaignHealth(entries);
    expect(alert).toBeNull();
  });
});

// ─── GROUP F: Edge Cases ─────────────────────────────────────────────────────

describe('Group F: Edge Cases', () => {
  it('F1: empty KG — markDeadEnd and updateMetadata handle gracefully', () => {
    writeKG(projectDir, runId, emptyKG());
    const result = markDeadEnd(projectDir, runId, 'nonexistent', 'plateau');
    expect(result).toBeNull();
    updateMetadata(projectDir, runId, 50, 'f1');
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(50);
  });

  it('F2: KG with only goal node — markDeadEnd with non-existent ID returns null', () => {
    addNode(projectDir, runId, { type: 'goal', label: 'Goal' });
    const result = markDeadEnd(projectDir, runId, 'does-not-exist', 'plateau');
    expect(result).toBeNull();
  });

  it('F3: large KG (50+ nodes) — operations complete', () => {
    const labels = Array.from({ length: 50 }, (_, index) => `Approach ${index}`);
    for (const label of labels) {
      addNode(projectDir, runId, { type: 'approach', label });
    }
    const kg = readKG(projectDir, runId);
    expect(kg.nodes.map((node) => node.label).toSorted()).toEqual(labels.toSorted());
    const target = kg.nodes[25];
    markDeadEnd(projectDir, runId, target.id, 'plateau');
    updateMetadata(projectDir, runId, 99, 'accuracy');
    const updated = readKG(projectDir, runId);
    expect(updated.nodes.find(n => n.id === target.id)!.type).toBe('dead_end');
    expect(updated.metadata.bestScore).toBe(99);
  });

  it('F4: rapid iterations — no race conditions on KG file writes', () => {
    for (let i = 0; i < 10; i++) {
      updateMetadata(projectDir, runId, i * 10, 'metric');
    }
    const kg = readKG(projectDir, runId);
    expect(kg.metadata.bestScore).toBe(90);
  });

  it('F5: invalid KG JSON — operations handle error, file still exists', () => {
    const p = kgPath(projectDir, runId);
    writeFileSync(p, '{invalid json!!!');
    expect(() => markDeadEnd(projectDir, runId, 'x', 'reason')).toThrow();
    expect(existsSync(p)).toBe(true);
  });

  it('F6: missing metadata fields — updateMetadata populates them', () => {
    const kg = emptyKG();
    delete (kg.metadata as any).bestScore;
    delete (kg.metadata as any).metricName;
    writeKG(projectDir, runId, kg);
    updateMetadata(projectDir, runId, 77, 'recall');
    const updated = readKG(projectDir, runId);
    expect(updated.metadata.bestScore).toBe(77);
    expect(updated.metadata.metricName).toBe('recall');
  });
});

// ─── GROUP G: Terminal Study Completion Contract ─────────────────────────────

describe('Group G: Terminal Study Completion Contract', () => {
  it('G1: stable final study completion evidence recovers a running run before re-plan', () => {
    const gateId = 'btc_transfer_multiphase_gate';
    mkdirSync(join(runDir(projectDir, runId), 'stages', gateId), { recursive: true });
    writeFileSync(join(runDir(projectDir, runId), `pre_gate_verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      model_success: false,
      study_complete: true,
      reason: 'study_complete_without_model_success',
      metric: 'BTCTransferRobustScore',
      value: 93.34564328835455,
      threshold: 300,
    }));

    const recovered = recoverTerminalStudyCompletion(projectDir, runId, {
      runId,
      workflowName: 'default',
      projectDir,
      status: 'running',
      stages: {
        plan: { status: 'complete', retries: 0 },
        [gateId]: { status: 'pending', retries: 0 },
      },
      dispatchedStages: [{ id: gateId, is_gate: true }],
      startedAt: '2026-05-04T00:00:00.000Z',
      currentIteration: 11,
      campaignAlert: {
        type: 'regression',
        action: 'inject_researcher',
        message: '2 consecutive score declines',
        source: 'campaign_health',
        triggeredAt: '2026-05-04T00:00:00.000Z',
        iteration: 11,
      },
      researchInjection: {
        source: 'campaign_health',
        triggeredAt: '2026-05-04T00:00:00.000Z',
        iteration: 11,
        alertType: 'regression',
        message: '2 consecutive score declines',
      },
    });

    expect(recovered?.status).toBe('complete');
    expect(recovered?.stages[gateId].status).toBe('complete');
    expect(recovered?.campaignAlert).toBeUndefined();
    expect(recovered?.researchInjection).toBeUndefined();
  });

  it('G2: intermediate phase progress verdict remains non-terminal', () => {
    const gateId = 'qa_phase3_adaptation_protocols';
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    writeFileSync(join(runDir(projectDir, runId), `pre_gate_verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      phase_complete: true,
      continue_next_phase: true,
      reason: 'phase3_complete_continue_next_phase',
    }));

    const recovered = recoverTerminalStudyCompletion(projectDir, runId, {
      runId,
      workflowName: 'default',
      projectDir,
      status: 'running',
      stages: { [gateId]: { status: 'complete', retries: 0 } },
      dispatchedStages: [{ id: gateId, is_gate: true }],
      startedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(recovered).toBeNull();
  });
});
