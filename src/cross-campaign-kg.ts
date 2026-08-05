import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlFile } from './jsonl.js';
import { fcGlobalDir } from './store.js';

export interface KGNode {
  id: string;
  type: 'symptom' | 'diagnosis' | 'patch' | 'outcome';
  campaignId: string;
  campaignStartedAt: string;
  metadata: Record<string, any>;
}

export interface KGEdge {
  from: string;
  to: string;
  relation: 'caused_by' | 'fixed_by' | 'resulted_in' | 'related_to';
  weight?: number;
}

export interface KGSuggestion {
  symptomNode: KGNode;
  suggestedPatch?: KGNode;
  outcomeNode: KGNode;
  similarity: number;
  reason: string;
}

interface CampaignArc {
  campaignId: string;
  symptom: KGNode['metadata'];
  diagnosis: KGNode['metadata'];
  patch?: KGNode['metadata'];
  outcome: KGNode['metadata'];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashId(parts: unknown[]): string {
  return createHash('sha256').update(stableJson(parts)).digest('hex').slice(0, 24);
}

function nodeId(campaignId: string, type: KGNode['type'], metadata: Record<string, any>): string {
  return hashId([campaignId, type, metadata]);
}

function nodesPath(): string {
  return join(ensureKGStore(), 'nodes.jsonl');
}

function edgesPath(): string {
  return join(ensureKGStore(), 'edges.jsonl');
}

function shallowMatches<T extends Record<string, any>>(value: T, filter?: Partial<T>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, expected]) => expected === undefined || value[key] === expected);
}

function clampWeight(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function topRejection(counts: unknown): string | undefined {
  if (!counts || typeof counts !== 'object') return undefined;
  let best: string | undefined;
  let bestCount = -Infinity;
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value > bestCount) {
      best = key;
      bestCount = value;
    }
  }
  return best;
}

function findOutcome(symptom: KGNode, nodes: KGNode[], edges: KGEdge[]): { patch?: KGNode; outcome?: KGNode } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const diagnosis = edges
    .filter((edge) => edge.from === symptom.id && edge.relation === 'caused_by')
    .map((edge) => byId.get(edge.to))
    .find((node): node is KGNode => node?.type === 'diagnosis');
  if (!diagnosis) return {};
  const patch = edges
    .filter((edge) => edge.from === diagnosis.id && edge.relation === 'fixed_by')
    .map((edge) => byId.get(edge.to))
    .find((node): node is KGNode => node?.type === 'patch');
  if (patch) {
    const outcome = edges
      .filter((edge) => edge.from === patch.id && edge.relation === 'resulted_in')
      .map((edge) => byId.get(edge.to))
      .find((node): node is KGNode => node?.type === 'outcome');
    return { patch, outcome };
  }
  const outcome = edges
    .filter((edge) => edge.from === diagnosis.id && edge.relation === 'resulted_in')
    .map((edge) => byId.get(edge.to))
    .find((node): node is KGNode => node?.type === 'outcome');
  return { outcome };
}

export function ensureKGStore(): string {
  const root = join(fcGlobalDir(), 'cross-campaign-kg');
  mkdirSync(root, { recursive: true });
  return root;
}

export function appendNode(node: KGNode): void {
  const full = {
    ...node,
    id: node.id || nodeId(node.campaignId, node.type, node.metadata),
  };
  writeFileSync(nodesPath(), JSON.stringify(full) + '\n', { encoding: 'utf-8', flag: 'a' });
}

export function appendEdge(edge: KGEdge): void {
  writeFileSync(edgesPath(), JSON.stringify({ ...edge, weight: clampWeight(edge.weight) }) + '\n', { encoding: 'utf-8', flag: 'a' });
}

// Batched appends: write a whole set of nodes/edges in ONE append so a multi-record
// arc can't interleave with another process's concurrent append (which would tear
// lines / corrupt the jsonl). One write() per set instead of per record.
function appendNodes(nodes: KGNode[]): void {
  if (nodes.length === 0) return;
  const payload = nodes.map((n) => JSON.stringify({ ...n, id: n.id || nodeId(n.campaignId, n.type, n.metadata) })).join('\n') + '\n';
  writeFileSync(nodesPath(), payload, { encoding: 'utf-8', flag: 'a' });
}
function appendEdges(edges: KGEdge[]): void {
  if (edges.length === 0) return;
  const payload = edges.map((e) => JSON.stringify({ ...e, weight: clampWeight(e.weight) })).join('\n') + '\n';
  writeFileSync(edgesPath(), payload, { encoding: 'utf-8', flag: 'a' });
}

// mtime+size-keyed parse cache. getNodes/getEdges are called once per campaign
// in the dashboard list build (500+ calls); re-reading and re-parsing the whole
// jsonl each time was pure waste. appends change the file size, busting the cache.
let _nodesCache: { key: string; data: KGNode[] } | null = null;
let _edgesCache: { key: string; data: KGEdge[] } | null = null;

function fileCacheKey(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return 'absent'; }
}

function loadNodesCached(): KGNode[] {
  const key = fileCacheKey(nodesPath());
  if (_nodesCache && _nodesCache.key === key) return _nodesCache.data;
  const path = nodesPath();
  const data = existsSync(path) ? readJsonlFile<KGNode>(path) : [];
  _nodesCache = { key, data };
  return data;
}

function loadEdgesCached(): KGEdge[] {
  const key = fileCacheKey(edgesPath());
  if (_edgesCache && _edgesCache.key === key) return _edgesCache.data;
  const path = edgesPath();
  const data = existsSync(path) ? readJsonlFile<KGEdge>(path) : [];
  _edgesCache = { key, data };
  return data;
}

export function getNodes(filter?: Partial<KGNode>): KGNode[] {
  return loadNodesCached().filter((node) => shallowMatches(node, filter));
}

export function getEdges(filter?: Partial<KGEdge>): KGEdge[] {
  return loadEdgesCached().filter((edge) => shallowMatches(edge, filter));
}

export function persistCampaignArc(arc: CampaignArc): void {
  const campaignStartedAt = typeof arc.symptom.campaignStartedAt === 'string'
    ? arc.symptom.campaignStartedAt
    : new Date().toISOString();
  const makeNode = (type: KGNode['type'], metadata: Record<string, any>): KGNode => ({
    id: nodeId(arc.campaignId, type, metadata),
    type,
    campaignId: arc.campaignId,
    campaignStartedAt,
    metadata,
  });

  const symptom = makeNode('symptom', arc.symptom);
  const diagnosis = makeNode('diagnosis', arc.diagnosis);
  const outcome = makeNode('outcome', arc.outcome);
  if (arc.patch) {
    const patch = makeNode('patch', arc.patch);
    appendNodes([symptom, diagnosis, patch, outcome]);
    appendEdges([
      { from: symptom.id, to: diagnosis.id, relation: 'caused_by', weight: 1 },
      { from: diagnosis.id, to: patch.id, relation: 'fixed_by', weight: 1 },
      { from: patch.id, to: outcome.id, relation: 'resulted_in', weight: 1 },
    ]);
    return;
  }

  appendNodes([symptom, diagnosis, outcome]);
  appendEdges([
    { from: symptom.id, to: diagnosis.id, relation: 'caused_by', weight: 1 },
    { from: diagnosis.id, to: outcome.id, relation: 'resulted_in', weight: 1 },
  ]);
}

export function findSimilar(currentContext: {
  campaignId: string;
  projectDir: string;
  briefMetric?: string;
  earlyRejections?: Record<string, number>;
}): KGSuggestion[] {
  const nodes = getNodes();
  const edges = getEdges();
  const currentTopRejection = topRejection(currentContext.earlyRejections);
  const suggestions: KGSuggestion[] = [];

  for (const symptom of nodes.filter((node) => node.type === 'symptom' && node.campaignId !== currentContext.campaignId)) {
    const reasons: string[] = [];
    let similarity = 0;
    if (symptom.metadata.projectDir === currentContext.projectDir) {
      similarity += 0.5;
      reasons.push('same projectDir');
    }
    if (currentContext.briefMetric && symptom.metadata.briefMetric === currentContext.briefMetric) {
      similarity += 0.3;
      reasons.push('same brief metric');
    }
    const symptomTopRejection = topRejection(symptom.metadata.counts);
    if (currentTopRejection && symptomTopRejection && currentTopRejection === symptomTopRejection) {
      similarity += 0.2;
      reasons.push(`same top rejection: ${currentTopRejection}`);
    }
    similarity = Math.min(1, similarity);
    if (similarity < 0.3) continue;
    const linked = findOutcome(symptom, nodes, edges);
    if (!linked.outcome) continue;
    suggestions.push({
      symptomNode: symptom,
      suggestedPatch: linked.patch,
      outcomeNode: linked.outcome,
      similarity,
      reason: reasons.join(' + '),
    });
  }

  return suggestions
    .sort((a, b) => b.similarity - a.similarity || b.symptomNode.campaignStartedAt.localeCompare(a.symptomNode.campaignStartedAt))
    .slice(0, 5);
}
