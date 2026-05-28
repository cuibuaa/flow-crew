import type { CampaignKGEdge, CampaignKGNode } from "../types";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3";

export const KG_COLORS: Record<string, string> = {
  symptom: "#f87171",
  diagnosis: "#fbbf24",
  patch: "#5b9eff",
  outcome: "#4ade80",
  goal: "#5b9eff",
  approach: "#a78bfa",
  finding: "#fbbf24",
  insight: "#06b6d4",
  result: "#4ade80",
};

export const FALLBACK_KG_COLOR = "#94a3b8";

export function colorFor(type: string | undefined): string {
  return type ? KG_COLORS[type] ?? FALLBACK_KG_COLOR : FALLBACK_KG_COLOR;
}

export function edgeSource(edge: CampaignKGEdge): string {
  return String(edge.source ?? edge.from ?? "");
}

export function edgeTarget(edge: CampaignKGEdge): string {
  return String(edge.target ?? edge.to ?? "");
}

export function layoutGraph(nodes: CampaignKGNode[], width: number, height: number, edges: CampaignKGEdge[] = []): Array<CampaignKGNode & { x: number; y: number }> {
  if (nodes.length === 0) return [];
  const cx = width / 2;
  const cy = height / 2;
  const lanes: Record<string, number> = {
    symptom: width * 0.15,
    diagnosis: width * 0.38,
    patch: width * 0.62,
    outcome: width * 0.85,
    goal: width * 0.18,
    approach: width * 0.34,
    finding: width * 0.5,
    insight: width * 0.66,
    result: width * 0.82,
  };
  const simulationNodes = nodes.map((node, index) => {
    const angle = nodes.length <= 1 ? -Math.PI / 2 : (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    return {
      ...node,
      x: lanes[node.type] ?? cx + Math.cos(angle) * Math.min(width, height) * 0.25,
      y: cy + Math.sin(angle) * Math.min(width, height) * 0.18,
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const simulationLinks = edges
    .map((edge) => ({ source: edgeSource(edge), target: edgeTarget(edge) }))
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target));

  forceSimulation(simulationNodes)
    .force("link", forceLink(simulationLinks).id((node) => (node as CampaignKGNode).id).distance(78).strength(0.6))
    .force("charge", forceManyBody().strength(-150))
    .force("center", forceCenter(cx, cy))
    .force("collide", forceCollide(28))
    .force("x", forceX((node) => lanes[(node as CampaignKGNode).type] ?? cx).strength(0.18))
    .force("y", forceY(cy).strength(0.05))
    .stop()
    .tick(90);

  return simulationNodes.map((node) => ({
    ...node,
    x: Math.min(width - 28, Math.max(28, node.x ?? cx)),
    y: Math.min(height - 34, Math.max(28, node.y ?? cy)),
  }));
}
