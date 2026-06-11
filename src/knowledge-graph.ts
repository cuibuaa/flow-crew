import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runDir } from './store.js';

export type KGNodeType = 'goal' | 'approach' | 'finding' | 'result' | 'insight' | 'dead_end' | 'user_hint';
export type KGEdgeType = 'explored_by' | 'found_that' | 'measured_as' | 'sourced_from' | 'supports' | 'contradicts' | 'combines_with' | 'depends_on';

export interface KGNode {
  id: string;
  type: KGNodeType;
  label: string;
  details?: string;
  source?: string;
  score?: number;
  reason?: string;
  timestamp: string;
  stageId?: string;
}

export interface KGEdge {
  from: string;
  to: string;
  type: KGEdgeType;
  label?: string;
}

export interface KnowledgeGraph {
  nodes: KGNode[];
  edges: KGEdge[];
  metadata: {
    bestScore?: number;
    metricName?: string;
    createdAt: string;
    updatedAt: string;
  };
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw err;
  }
}

function emptyGraph(): KnowledgeGraph {
  const now = new Date().toISOString();
  return { nodes: [], edges: [], metadata: { createdAt: now, updatedAt: now } };
}

export function kgPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), 'knowledge_graph.json');
}

export function readKG(projectDir: string, runId: string): KnowledgeGraph {
  const p = kgPath(projectDir, runId);
  if (!existsSync(p)) return emptyGraph();
  // Missing → empty (the KG may not exist yet). A CORRUPT file, however, must NOT be
  // silently reset here: the mutating callers below (markDeadEnd/addNode/updateMetadata)
  // would then overwrite and DESTROY the graph. Surface the corruption instead;
  // display-only callers use readKGSafe() to stay corruption-tolerant.
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/** Corruption-tolerant read for display/throwaway contexts: returns an empty graph
 * instead of throwing on a missing OR malformed KG. Never use for read-modify-write
 * (it would mask corruption and let the writer overwrite a recoverable file). */
export function readKGSafe(projectDir: string, runId: string): KnowledgeGraph {
  try { return readKG(projectDir, runId); } catch { return emptyGraph(); }
}

export function writeKG(projectDir: string, runId: string, kg: KnowledgeGraph): void {
  const p = kgPath(projectDir, runId);
  mkdirSync(runDir(projectDir, runId), { recursive: true });
  kg.metadata.updatedAt = new Date().toISOString();
  atomicWrite(p, JSON.stringify(kg, null, 2));
}

export function addNode(projectDir: string, runId: string, node: Omit<KGNode, 'id' | 'timestamp'>): KGNode {
  const kg = readKG(projectDir, runId);
  const full: KGNode = { ...node, id: randomBytes(6).toString('hex'), timestamp: new Date().toISOString() };
  kg.nodes.push(full);
  writeKG(projectDir, runId, kg);
  return full;
}

export function updateNode(projectDir: string, runId: string, nodeId: string, updates: Partial<Pick<KGNode, 'type' | 'label' | 'details' | 'score'>>): KGNode | null {
  const kg = readKG(projectDir, runId);
  const node = kg.nodes.find(n => n.id === nodeId);
  if (!node) return null;
  if (updates.type !== undefined) node.type = updates.type;
  if (updates.label !== undefined) node.label = updates.label;
  if (updates.details !== undefined) node.details = updates.details;
  if (updates.score !== undefined) node.score = updates.score;
  writeKG(projectDir, runId, kg);
  return node;
}

export function removeNode(projectDir: string, runId: string, nodeId: string): boolean {
  const kg = readKG(projectDir, runId);
  const idx = kg.nodes.findIndex(n => n.id === nodeId);
  if (idx === -1) return false;
  kg.nodes.splice(idx, 1);
  kg.edges = kg.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  writeKG(projectDir, runId, kg);
  return true;
}

export function addEdge(projectDir: string, runId: string, edge: KGEdge): KGEdge {
  const kg = readKG(projectDir, runId);
  kg.edges.push(edge);
  writeKG(projectDir, runId, kg);
  return edge;
}

export function summarizeKG(kg: KnowledgeGraph): string {
  if (kg.nodes.length === 0) return '';
  const byType = (t: KGNodeType) => kg.nodes.filter(n => n.type === t);
  const lines: string[] = [`Knowledge Graph Summary (${kg.nodes.length} nodes, ${kg.edges.length} edges):`];
  const goals = byType('goal');
  if (goals.length) lines.push(`Goals: ${goals.map(n => n.label).join(', ')}`);
  const approaches = byType('approach');
  if (approaches.length) lines.push(`Approaches: ${approaches.map(n => n.score !== undefined ? `${n.label} (score: ${n.score})` : n.label).join(', ')}`);
  const deadEnds = byType('dead_end');
  if (deadEnds.length) lines.push(`Dead Ends: ${deadEnds.map(n => n.label).join(', ')}`);
  const hints = byType('user_hint');
  if (hints.length) lines.push(`User Hints: ${hints.map(n => n.label).join(', ')}`);
  if (kg.metadata.bestScore !== undefined) lines.push(`Best Score: ${kg.metadata.bestScore}`);
  return lines.join('\n');
}

export interface RatchetResult {
  improved: boolean;
  previousBest?: number;
  currentScore: number;
  nodeId?: string;
}

/**
 * Ratchet check: compare score to best in KG, update accordingly.
 * Always adds a result node. Updates bestScore if improved.
 * Marks the approach as 'dead_end' if score didn't improve (when approachNodeId provided).
 */
export function ratchetCheck(
  projectDir: string,
  runId: string,
  score: number,
  metricName: string,
  stageId?: string,
  approachNodeId?: string,
): RatchetResult {
  const kg = readKG(projectDir, runId);
  const previousBest = kg.metadata.bestScore;
  const improved = previousBest === undefined || score > previousBest;

  const resultNode: KGNode = {
    id: randomBytes(6).toString('hex'),
    type: 'result',
    label: `${metricName}: ${score}`,
    details: `Score: ${score}, Previous best: ${previousBest ?? 'none'}`,
    score,
    timestamp: new Date().toISOString(),
    stageId,
  };
  kg.nodes.push(resultNode);

  if (improved) {
    kg.metadata.bestScore = score;
    kg.metadata.metricName = metricName;
    if (approachNodeId) {
      const approach = kg.nodes.find(n => n.id === approachNodeId);
      if (approach) {
        approach.details = (approach.details ?? '') + ' [PROMISING]';
      }
    }
  } else {
    if (approachNodeId) {
      const approach = kg.nodes.find(n => n.id === approachNodeId);
      if (approach && approach.type !== 'dead_end') {
        approach.type = 'dead_end';
        approach.details = (approach.details ?? '') + ` [Dead end: score ${score} did not improve over ${previousBest}]`;
      }
    }
  }

  writeKG(projectDir, runId, kg);
  return { improved, previousBest, currentScore: score, nodeId: resultNode.id };
}

/**
 * Check if the KG shows a plateau (no improvement over recent results).
 * Returns true if the last `window` result nodes all have the same score as bestScore.
 */
export function detectPlateau(projectDir: string, runId: string, window: number = 3): boolean {
  const kg = readKG(projectDir, runId);
  if (kg.metadata.bestScore === undefined) return false;
  const results = kg.nodes
    .map((n, i) => ({ ...n, _idx: i }))
    .filter(n => n.type === 'result' && n.score !== undefined)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b._idx - a._idx);
  if (results.length < window) return false;
  const recent = results.slice(0, window);
  return recent.every(r => r.score === kg.metadata.bestScore);
}

/**
 * Add a sub-task node to the parent's knowledge graph.
 * The node links the parent KG to the child task.
 */
export function addSubTaskNode(
  projectDir: string,
  parentRunId: string,
  childRunId: string,
  childName: string,
  stageId?: string,
): KGNode {
  return addNode(projectDir, parentRunId, {
    type: 'approach',
    label: `Sub-task: ${childName}`,
    details: `Child task ${childRunId}`,
    source: childRunId,
    stageId,
  });
}

export function markDeadEnd(projectDir: string, runId: string, nodeId: string, reason: string): KGNode | null {
  const p = kgPath(projectDir, runId);
  if (!existsSync(p)) return null;
  const kg = readKG(projectDir, runId);
  const node = kg.nodes.find(n => n.id === nodeId);
  if (!node) return null;
  node.type = 'dead_end';
  node.reason = reason;
  writeKG(projectDir, runId, kg);
  return node;
}

export function updateMetadata(projectDir: string, runId: string, score: number, metric: string): KnowledgeGraph['metadata'] {
  const kg = readKG(projectDir, runId);
  if (kg.metadata.bestScore === undefined || score > kg.metadata.bestScore) {
    kg.metadata.bestScore = score;
    kg.metadata.metricName = metric;
  }
  writeKG(projectDir, runId, kg);
  return kg.metadata;
}