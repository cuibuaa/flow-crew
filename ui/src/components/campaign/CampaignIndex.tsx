import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CampaignOperatorIndex } from "./types";
import SourceNotice from "./SourceNotice";

const CAMPAIGNS_PER_PAGE = 24;

function attentionText(status: string, count: number | null): string {
  if (status === "unavailable") return "Attention status unavailable";
  if (status === "partial") return count ? `At least ${count} item${count === 1 ? "" : "s"}` : "Attention list incomplete";
  return count ? `${count} item${count === 1 ? "" : "s"} need attention` : "Nothing needs attention";
}

export default function CampaignIndex({ index, onNewRun }: { index: CampaignOperatorIndex; onNewRun?: () => void }) {
  const source = index.campaigns;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(source.value.items.length / CAMPAIGNS_PER_PAGE));
  const visibleItems = source.value.items.slice(page * CAMPAIGNS_PER_PAGE, (page + 1) * CAMPAIGNS_PER_PAGE);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  if (source.status === "unavailable") {
    return (
      <div className="campaign-index" data-testid="campaign-index">
        <h1>Campaigns</h1>
        <SourceNotice source={source} label="Campaign index" />
      </div>
    );
  }
  return (
    <div className="campaign-index" data-testid="campaign-index">
      <div className="campaign-index-heading">
        <div>
          <div className="eyebrow">OPERATOR CAMPAIGNS</div>
          <h1>Campaigns</h1>
          <p>See what needs attention, what is running, and the latest outcome.</p>
        </div>
        {onNewRun ? <button className="btn" type="button" onClick={onNewRun}>+ New Run</button> : null}
      </div>
      <SourceNotice source={source} label="Campaign index" />
      {!source.value.items.length ? (
        <div className="campaign-index-empty">
          <strong>No campaigns yet</strong>
          <span>Create or select a campaign when starting a run.</span>
          {onNewRun ? <button className="btn" type="button" onClick={onNewRun}>Create the first run</button> : null}
        </div>
      ) : (
        <>
        <div className="campaign-index-list" role="list">
          {visibleItems.map((campaign) => (
            <article className="campaign-index-row" key={campaign.id} role="listitem">
              <div className="campaign-index-name">
                <h2><Link to={campaign.href}>{campaign.name}</Link></h2>
                <code>{campaign.id}</code>
              </div>
              <div className={`campaign-index-signal ${campaign.attention.status}`}>
                <span className="campaign-index-label">Attention required</span>
                <strong>{attentionText(campaign.attention.status, campaign.attention.count)}</strong>
              </div>
              <div className={`campaign-index-signal ${campaign.activity.needsIntervention ? "needs-intervention" : ""}`}>
                <span className="campaign-index-label">Current run activity</span>
                <strong>{campaign.activity.summary}</strong>
              </div>
              <div className="campaign-index-result">
                <span className="campaign-index-label">Latest campaign outcome</span>
                {campaign.recent.runStatus ? <code>{campaign.recent.runStatus}</code> : null}
                <span>{campaign.recent.conclusion}</span>
              </div>
              <Link className="campaign-index-open" to={campaign.href} aria-label={`Open campaign ${campaign.name}`}>Open →</Link>
            </article>
          ))}
        </div>
        {pageCount > 1 ? (
          <nav className="campaign-pagination" aria-label="Campaign index pages">
            <button type="button" className="btn ghost" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>Previous</button>
            <span>Page {page + 1} of {pageCount} · {source.value.items.length} campaigns</span>
            <button type="button" className="btn ghost" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button>
          </nav>
        ) : null}
        </>
      )}
    </div>
  );
}
