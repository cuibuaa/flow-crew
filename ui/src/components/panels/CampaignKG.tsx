import { useState } from "react";
import NodeDetailPanel from "../NodeDetailPanel";
import { colorFor, edgeSource, edgeTarget, layoutGraph } from "../../lib/d3-graph";
import type { CampaignKGEdge, CampaignKGNode } from "../../types";

export default function CampaignKG({ campaignId, nodes, edges, emptyState = "omit" }: { campaignId: string; nodes?: CampaignKGNode[]; edges?: CampaignKGEdge[]; emptyState?: "omit" | "show" }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const ownNodes = (nodes ?? []).filter((node) => node && (node.campaign ?? node.campaignId) === campaignId);
  if (ownNodes.length === 0) {
    if (emptyState === "omit") return null;
    return (
      <div className="section" data-testid="panel-campaign-kg-empty">
        <h2>Knowledge graph <span className="h2-hint">relationships for this campaign</span></h2>
        <div className="kg-mini-empty">No knowledge graph relationships yet. They appear after a completed campaign records a finding and follow-up action.</div>
      </div>
    );
  }
  const selectedNode = ownNodes.find((node) => node.id === selectedNodeId) ?? null;
  const ids = new Set(ownNodes.map((node) => node.id));
  const ownEdges = (edges ?? []).filter((edge) => edge && ids.has(edgeSource(edge)) && ids.has(edgeTarget(edge)));
  const placed = layoutGraph(ownNodes, 640, 220, ownEdges);
  const byId = new Map(placed.map((node) => [node.id, node]));
  const selectNode = (nodeId: string) => setSelectedNodeId(nodeId);
  return (
    <div className="section" data-testid="panel-campaign-kg">
      <h2>Knowledge graph <span className="h2-hint">{ownNodes.length} nodes for this campaign</span></h2>
      <div className="kg-mini">
        <svg viewBox="0 0 640 220" role="group" aria-label="campaign knowledge graph">
          {ownEdges.map((edge, index) => {
            const source = byId.get(edgeSource(edge));
            const target = byId.get(edgeTarget(edge));
            if (!source || !target) return null;
            return <line key={edge.id ?? index} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={edge.kind === "similarity" ? "#a78bfa" : "#3a4a6a"} strokeDasharray={edge.kind === "similarity" ? "4 3" : undefined} />;
          })}
          {placed.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x},${node.y})`}
              className="kg-node"
              data-testid={`kg-node-${node.type}`}
              role="button"
              tabIndex={0}
              aria-label={`Open details for ${node.label ?? node.text ?? node.id}`}
              style={{ color: colorFor(node.type) }}
              onClick={() => selectNode(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectNode(node.id);
                }
              }}
            >
              <title>{node.label ?? node.text ?? node.type}</title>
              <circle r="18" fill={`${colorFor(node.type)}2a`} stroke={colorFor(node.type)} strokeWidth="1.5" />
              <text textAnchor="middle" y="4" fill={colorFor(node.type)} fontSize="9">{(node.label ?? node.text ?? node.type).slice(0, 10)}</text>
              <text textAnchor="middle" y="32" fill="#6b748a" fontSize="9">{node.type}</text>
            </g>
          ))}
        </svg>
      </div>
      <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNodeId(null)} />
    </div>
  );
}
