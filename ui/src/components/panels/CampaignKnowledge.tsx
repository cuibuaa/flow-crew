import { useState } from "react";
import { Link } from "react-router-dom";
import type { CampaignKGNode, WorkspacePhase } from "../../types";

/** Compact result display: keep small magnitudes at 2 decimals, larger ones at 1. */
function formatResult(value: number): string {
  return Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
}

interface KnItem { text: string; runId?: string; url?: string }

/** Collect a node type's substance, deduped by text, preserving the aggregator's newest-first order. */
function collect(nodes: CampaignKGNode[], type: string): KnItem[] {
  const seen = new Set<string>();
  const out: KnItem[] = [];
  for (const node of nodes) {
    if (node.type !== type) continue;
    const text = (node.text ?? node.label ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const url = typeof node.source === "string" && /^https?:\/\//.test(node.source) ? node.source : undefined;
    out.push({ text, runId: node.runId ?? node.meta, url });
  }
  return out;
}

function KnList({ icon, title, items, cap }: { icon: string; title: string; items: KnItem[]; cap: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, cap);
  const remaining = items.length - shown.length;
  return (
    <div className="kn-group">
      <div className="kn-group-title">{icon} {title} <span className="kn-count">{items.length}</span></div>
      <ul className="kn-list">
        {shown.map((item, index) => (
          <li className="kn-item" key={`${index}-${item.text.slice(0, 24)}`}>
            {item.url
              ? <a className="kn-text" href={item.url} target="_blank" rel="noreferrer" title={item.url}>{item.text}</a>
              : item.runId
                ? <Link className="kn-text" to={`/run/${encodeURIComponent(item.runId)}`} title={`${item.text}\n(open run ${item.runId})`}>{item.text}</Link>
                : <span className="kn-text" title={item.text}>{item.text}</span>}
          </li>
        ))}
      </ul>
      {remaining > 0 ? <button type="button" className="kn-more" onClick={() => setExpanded(true)}>… {remaining} more</button> : null}
      {expanded && items.length > cap ? <button type="button" className="kn-more" onClick={() => setExpanded(false)}>show less</button> : null}
    </div>
  );
}

/**
 * Campaign-level knowledge digest. Instead of a dense force graph (illegible at campaign scale,
 * with the substance hidden behind 10-char node circles), this surfaces the actual learnings as
 * ranked, deduped, clickable text: the best direction+result, the key findings, and the dead ends.
 * The relational per-run graph still lives on the run detail page.
 */
export default function CampaignKnowledge({ campaignId, nodes, phases }: { campaignId: string; nodes?: CampaignKGNode[]; phases?: WorkspacePhase[] | null }) {
  const own = (nodes ?? []).filter((node) => (node.campaign ?? node.campaignId) === campaignId);
  const insights = collect(own, "insight");
  const findings = collect(own, "finding");
  const deadEnds = collect(own, "dead_end");
  const sources = collect(own, "source");
  const runCount = new Set(own.map((node) => node.runId ?? node.meta).filter(Boolean)).size;
  const best = (phases ?? [])
    .filter((phase) => typeof phase.result === "number")
    .sort((a, b) => (b.result as number) - (a.result as number))[0];

  if (!insights.length && !findings.length && !deadEnds.length && !sources.length && !best) {
    return (
      <div className="section" data-testid="panel-campaign-knowledge-empty">
        <h2>Knowledge <span className="h2-hint">campaign learnings</span></h2>
        <div className="kg-mini-empty">No findings recorded yet. They appear as runs record findings and dead ends.</div>
      </div>
    );
  }

  return (
    <div className="section" data-testid="panel-campaign-knowledge">
      <h2>Knowledge <span className="h2-hint">synthesized from {runCount} run{runCount === 1 ? "" : "s"}</span></h2>
      {best ? (
        <div className="kn-best">
          <span className="kn-best-icon">🏆</span>
          <span className="kn-best-label">Best</span>
          {best.runId
            ? <Link className="kn-best-dir" to={`/run/${encodeURIComponent(best.runId)}`}>{best.direction ?? best.name}</Link>
            : <span className="kn-best-dir">{best.direction ?? best.name}</span>}
          <span className="kn-best-arrow">→</span>
          <strong className="kn-best-result">{formatResult(best.result as number)}</strong>
        </div>
      ) : null}
      <KnList icon="✨" title="Insights" items={insights} cap={6} />
      <KnList icon="💡" title="Findings" items={findings} cap={10} />
      <KnList icon="⛔" title="Dead ends" items={deadEnds} cap={6} />
      <KnList icon="📚" title="Sources" items={sources} cap={8} />
    </div>
  );
}
