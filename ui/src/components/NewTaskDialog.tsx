import { useState, useEffect } from "react";
import { fetchCampaigns } from "../api";
import { cleanCampaignDisplayName, getCampaignDisplayName } from "../types";
import type { CampaignSelectionMode, CampaignSummary } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, campaignId?: string, campaignName?: string) => void;
}

export default function NewTaskDialog({ open, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignMode, setCampaignMode] = useState<CampaignSelectionMode>("standalone");
  const [campaignId, setCampaignId] = useState("");
  const [newCampaignName, setNewCampaignName] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [campaignLoadError, setCampaignLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCampaignMode("standalone");
    setCampaignId("");
    setNewCampaignName("");
    setSuggestion(null);
    setCampaignLoadError(null);
    fetchCampaigns()
      .then((data) => {
        setCampaigns(data);
        setCampaignLoadError(null);
        if (data.length > 0) setCampaignMode("existing");
      })
      .catch(() => {
        setCampaigns([]);
        setCampaignMode("standalone");
        setCampaignLoadError("Existing campaigns could not be loaded right now.");
      });
  }, [open]);

  useEffect(() => {
    if (!name || campaigns.length === 0) { setSuggestion(null); return; }
    const words = name.toLowerCase().split(/\s+/);
    const match = campaigns.find((campaign) => {
      const displayName = getCampaignDisplayName({ campaignName: campaign.name, campaignId: campaign.id }).toLowerCase();
      return words.some((word) => word && displayName.includes(word));
    });
    setSuggestion(match && (campaignMode !== "existing" || campaignId !== match.id) ? match.id : null);
  }, [name, campaigns, campaignId, campaignMode]);

  if (!open) return null;

  const resolvedCampaignId = campaignMode === "existing" ? (campaignId || undefined) : undefined;
  const resolvedCampaignName = campaignMode === "new" ? (cleanCampaignDisplayName(newCampaignName) || undefined) : undefined;
  const suggestedCampaign = suggestion ? campaigns.find((campaign) => campaign.id === suggestion) : undefined;
  const canSubmit =
    Boolean(name.trim()) &&
    (campaignMode !== "existing" || Boolean(campaignId)) &&
    (campaignMode !== "new" || Boolean(resolvedCampaignName));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-rc-bg border border-rc-border rounded-card shadow-xl p-6 w-[30rem] max-w-[calc(100vw-2rem)] space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-bold text-rc-text uppercase tracking-wider">New Task</h2>

        <label className="block text-xs text-rc-text-secondary">
          Task name
          <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. BTC wave 6"
            className="w-full mt-1 px-3 py-2 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent" />
        </label>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-rc-text">Campaign Scope</h3>
              <p className="mt-1 text-[11px] text-rc-muted">Choose an existing campaign, start a brand-new one, or keep this task standalone.</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <button
              type="button"
              onClick={() => setCampaignMode("existing")}
              className={`rounded-card border px-3 py-2 text-left transition-colors ${campaignMode === "existing" ? "border-rc-accent bg-rc-accent/10 text-rc-text" : "border-rc-border bg-rc-card text-rc-text-secondary"}`}
            >
              Existing
            </button>
            <button
              type="button"
              onClick={() => setCampaignMode("new")}
              className={`rounded-card border px-3 py-2 text-left transition-colors ${campaignMode === "new" ? "border-rc-accent bg-rc-accent/10 text-rc-text" : "border-rc-border bg-rc-card text-rc-text-secondary"}`}
            >
              New campaign
            </button>
            <button
              type="button"
              onClick={() => setCampaignMode("standalone")}
              className={`rounded-card border px-3 py-2 text-left transition-colors ${campaignMode === "standalone" ? "border-rc-accent bg-rc-accent/10 text-rc-text" : "border-rc-border bg-rc-card text-rc-text-secondary"}`}
            >
              Standalone
            </button>
          </div>

          {campaignLoadError && (
            <div className="rounded-card border border-rc-error/40 bg-rc-error/10 px-3 py-2 text-xs text-rc-error">
              {campaignLoadError}
            </div>
          )}

          {campaignMode === "existing" && (
            <div className="rounded-card border border-rc-border bg-rc-card/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-rc-text">Existing campaigns</div>
                  <div className="text-[11px] text-rc-muted">Visible up front so you can attach this task without creating a duplicate campaign.</div>
                </div>
                <span className="text-[10px] font-mono text-rc-muted">{campaigns.length} total</span>
              </div>
              {campaigns.length > 0 ? (
                <div className="max-h-44 space-y-2 overflow-auto pr-1" aria-label="Existing campaigns">
                  {campaigns.map((campaign) => {
                    const selected = campaignId === campaign.id;
                    const displayName = getCampaignDisplayName({ campaignName: campaign.name, campaignId: campaign.id });
                    return (
                      <button
                        key={campaign.id}
                        type="button"
                        onClick={() => setCampaignId(campaign.id)}
                        className={`w-full rounded-card border px-3 py-2 text-left transition-colors ${selected ? "border-rc-accent bg-rc-accent/10" : "border-rc-border bg-rc-code/40 hover:border-rc-border-hover"}`}
                      >
                        <div className="text-sm font-medium text-rc-text">{displayName}</div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-rc-muted">
                          <span>{campaign.runCount} runs</span>
                          {campaign.bestScore != null && <span>Best {campaign.bestScore.toFixed(2)}</span>}
                          {campaign.latestRun && <span>Latest {new Date(campaign.latestRun).toLocaleDateString()}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-rc-muted">No existing campaigns yet. Switch to <span className="text-rc-text">New campaign</span> or keep this task standalone.</div>
              )}
            </div>
          )}

          {campaignMode === "new" && (
            <label className="block text-xs text-rc-text-secondary">
              New campaign name
              <input type="text" value={newCampaignName} onChange={e => setNewCampaignName(e.target.value)} placeholder="e.g. btc-5m-stability"
                className="w-full mt-1 px-3 py-2 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent" />
              <span className="mt-1 block text-[11px] text-rc-muted">Only the real campaign name is stored. Internal creation markers are never shown or submitted.</span>
            </label>
          )}

          {campaignMode === "standalone" && (
            <div className="rounded-card border border-dashed border-rc-border px-3 py-2 text-xs text-rc-muted">
              This task will run outside of any campaign.
            </div>
          )}
        </section>

        {suggestion && (
          <div className="rounded-card border border-rc-accent/40 bg-rc-accent/10 px-3 py-2 text-xs text-rc-accent">
            <button
              type="button"
              className="text-left"
              onClick={() => {
                setCampaignMode("existing");
                setCampaignId(suggestion);
              }}
            >
              Use existing campaign "{getCampaignDisplayName({ campaignName: suggestedCampaign?.name, campaignId: suggestedCampaign?.id ?? suggestion })}" instead of creating a duplicate.
            </button>
          </div>
        )}

        <div className="flex space-x-2 pt-2">
          <button onClick={() => { if (canSubmit) onSubmit(name.trim(), resolvedCampaignId, resolvedCampaignName); }}
            disabled={!canSubmit}
            className="btn-accent px-4 py-2 text-sm font-medium disabled:opacity-50">
            Start Discussion
          </button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm border border-rc-border">Cancel</button>
        </div>
      </div>
    </div>
  );
}
