import { useEffect } from "react";
import { colorFor } from "../lib/d3-graph";
import type { CampaignKGNode } from "../types";

interface NodeDetailPanelProps {
  node: CampaignKGNode | null;
  onClose: () => void;
}

function metadataFor(node: CampaignKGNode): Record<string, unknown> {
  if (node.metadata) return node.metadata;
  if (node.meta) return { meta: node.meta };
  return {};
}

export default function NodeDetailPanel({ node, onClose }: NodeDetailPanelProps) {
  useEffect(() => {
    if (!node) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [node, onClose]);

  if (!node) return null;

  const color = colorFor(node.type);
  const campaign = node.campaign ?? node.campaignId ?? "—";

  return (
    <div className="node-detail-backdrop show" onClick={onClose} data-testid="node-detail-backdrop">
      <aside className="node-detail-panel show" data-testid="node-detail-panel" aria-label={`Node details for ${node.label ?? node.id}`} onClick={(event) => event.stopPropagation()}>
        <div className="node-detail-header">
          <div className="node-detail-title">
            <span className="node-detail-dot" style={{ background: color }} />
            <span>{node.type}</span>
          </div>
          <button type="button" className="node-detail-close" aria-label="Close node detail panel" onClick={onClose}>✕</button>
        </div>

        <div className="node-detail-body">
          <section className="node-detail-section">
            <h3>ID</h3>
            <code>{node.id}</code>
          </section>
          <section className="node-detail-section">
            <h3>Type</h3>
            <div className="node-detail-type">
              <span className="node-detail-swatch" style={{ background: color }} />
              <code>{node.type}</code>
            </div>
          </section>
          <section className="node-detail-section">
            <h3>Label</h3>
            <code>{node.label ?? "—"}</code>
          </section>
          <section className="node-detail-section">
            <h3>Campaign</h3>
            <code>{campaign}</code>
          </section>
          <section className="node-detail-section">
            <h3>Metadata</h3>
            <pre>{JSON.stringify(metadataFor(node), null, 2)}</pre>
          </section>
        </div>
      </aside>
    </div>
  );
}
