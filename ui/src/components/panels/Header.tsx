import type { Campaign } from "../../types";

export default function Header({ campaign = {}, onViewBrief, onClickIterate }: { campaign?: Partial<Campaign> | null; onViewBrief?: () => void; onClickIterate?: () => void }) {
  const safeCampaign = campaign ?? {};
  const hasNoRuns = (safeCampaign.runs?.length ?? 0) === 0;
  const phaseCount = safeCampaign.phases?.length ?? 0;
  return (
    <div className="campaign-header" data-testid="panel-header">
      <div>
        <h1>{safeCampaign.name ?? safeCampaign.id ?? "Unnamed campaign"}</h1>
        <div className="subtitle">id: <code>{safeCampaign.id ?? "—"}</code> · status: <code>{safeCampaign.status ?? "unknown"}</code>{hasNoRuns && phaseCount > 0 ? <> · <code>{phaseCount} imported phases</code></> : null}</div>
        <div className="badges">
          {(safeCampaign.badges ?? []).filter(Boolean).map((badge, index) => (
            <span className={`badge ${badge.kind ?? ""}`} key={`${badge.text ?? index}-${index}`}>{hasNoRuns && phaseCount > 0 && /\bruns?\b/i.test(badge.text ?? "") ? `${phaseCount} phases` : badge.text ?? ""}</span>
          ))}
        </div>
      </div>
      <div className="header-actions">
        <button className="btn ghost" type="button" onClick={onViewBrief}>brief</button>
        <button className="btn" type="button" onClick={onClickIterate}>+ iterate</button>
      </div>
    </div>
  );
}
