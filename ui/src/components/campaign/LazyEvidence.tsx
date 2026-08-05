import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchCampaignBriefDiff,
  fetchCampaignBriefRevisions,
  fetchCampaignResearchKnowledge,
  type CampaignBriefRevision,
  type CampaignResearchKnowledgeItem,
} from "./client";

export function BriefHistoryDisclosure({ campaignId }: { campaignId: string }) {
  const [revisions, setRevisions] = useState<CampaignBriefRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<{ label: string; text: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const load = async () => {
    if (loading || revisions) return;
    setLoading(true);
    setError(null);
    try { setRevisions(await fetchCampaignBriefRevisions(campaignId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const loadDiff = async (revision: CampaignBriefRevision) => {
    setDiffError(null);
    try {
      const text = await fetchCampaignBriefDiff(campaignId, revision.from, revision.to);
      setDiff({ label: `${revision.from} → ${revision.to}`, text });
    } catch (reason) {
      setDiffError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <details className="campaign-brief-history" onToggle={(event) => { if (event.currentTarget.open) void load(); }}>
      <summary>Brief revisions</summary>
      <div className="campaign-lazy-evidence" aria-live="polite">
        {loading ? <span>Loading revision history…</span> : null}
        {error ? <span className="campaign-inline-error" role="alert">Brief history unavailable: {error}</span> : null}
        {revisions?.length === 0 ? <span>No brief revision records</span> : null}
        {revisions?.map((revision, index) => (
          <article key={`${revision.from}-${revision.to}-${index}`}>
            <strong>{revision.from} → {revision.to}</strong>
            <span>{revision.reason}</span>
            <button type="button" onClick={() => void loadDiff(revision)}>View diff</button>
          </article>
        ))}
        {diffError ? <span className="campaign-inline-error" role="alert">Diff unavailable: {diffError}</span> : null}
        {diff ? <pre aria-label={`${diff.label} brief diff`}>{diff.text}</pre> : null}
      </div>
    </details>
  );
}

function KnowledgeGroup({ title, items }: { title: string; items: CampaignResearchKnowledgeItem[] }) {
  if (!items.length) return null;
  return (
    <div className="campaign-knowledge-group">
      <strong>{title} · {items.length}</strong>
      <ul>{items.slice(0, 3).map((item) => <li key={item.id}>{item.runId ? <Link to={`/run/${encodeURIComponent(item.runId)}`}>{item.text}</Link> : item.text}</li>)}</ul>
      {items.length > 3 ? <span>{items.length - 3} more retained in the complete run and knowledge graph records</span> : null}
    </div>
  );
}

export function ResearchKnowledgeSummary({ campaignId, active }: { campaignId: string; active: boolean }) {
  const [items, setItems] = useState<CampaignResearchKnowledgeItem[] | null>(null);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || requested) return;
    setRequested(true);
    void fetchCampaignResearchKnowledge(campaignId)
      .then(setItems)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [active, campaignId, requested]);
  const findings = items?.filter((item) => item.type === "finding" || item.type === "insight") ?? [];
  const deadEnds = items?.filter((item) => item.type === "dead_end") ?? [];
  return (
    <div className="campaign-research-knowledge" aria-live="polite">
      {active && !items && !error ? <span>Loading findings and dead ends…</span> : null}
      {error ? <span className="campaign-inline-error" role="alert">Research knowledge summary unavailable: {error}</span> : null}
      {items?.length === 0 ? <span>No findings or dead-end records</span> : null}
      <KnowledgeGroup title="Key findings" items={findings} />
      <KnowledgeGroup title="Disproved approaches" items={deadEnds} />
    </div>
  );
}
