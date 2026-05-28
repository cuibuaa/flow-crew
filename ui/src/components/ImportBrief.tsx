import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createTask, executeTask, fetchRunCampaigns } from "../api";
import { cleanCampaignDisplayName, getCampaignDisplayName } from "../types";
import type { CampaignSelectionMode, CampaignSummary } from "../types";

export default function ImportBrief() {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignMode, setCampaignMode] = useState<CampaignSelectionMode>("standalone");
  const [campaignId, setCampaignId] = useState("");
  const [newCampaignName, setNewCampaignName] = useState("");
  const [campaignLoadError, setCampaignLoadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    fetchRunCampaigns()
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
  }, []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setContent(reader.result as string);
    reader.readAsText(file);
  };

  const resolvedCampaignId = campaignMode === "existing" ? (campaignId || undefined) : undefined;
  const resolvedCampaignName = campaignMode === "new" ? (cleanCampaignDisplayName(newCampaignName) || undefined) : undefined;
  const canSubmit =
    Boolean(name.trim()) &&
    Boolean(content.trim()) &&
    (campaignMode !== "existing" || Boolean(campaignId)) &&
    (campaignMode !== "new" || Boolean(resolvedCampaignName));

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) return;
    setSubmitting(true);
    try {
      const { id } = await createTask({
        name: name.trim(),
        workflow: "default",
        plan: [],
        planFile: content,
        campaignId: resolvedCampaignId,
        campaignName: resolvedCampaignName,
      });
      await executeTask(id);
      nav(`/task/${id}/plan`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-rc-text">Import Task Brief</h2>

      {error && <div className="text-rc-error text-sm">{error}</div>}

      <div>
        <label className="block text-sm text-rc-text-secondary mb-1">Task Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm focus:outline-none focus:border-rc-accent"
          placeholder="e.g. Implement retry loop"
        />
      </div>

      <section className="space-y-3">
        <div>
          <label className="block text-sm text-rc-text-secondary mb-1">Campaign scope</label>
          <p className="text-xs text-rc-muted">Attach this import to an existing campaign, start a new campaign, or keep it standalone.</p>
        </div>

        <div className="grid grid-cols-3 gap-2 text-sm">
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
                <div className="text-sm font-medium text-rc-text">Existing campaigns</div>
                <div className="text-xs text-rc-muted">Pick an existing campaign before submitting the brief.</div>
              </div>
              <span className="text-[11px] font-mono text-rc-muted">{campaigns.length} total</span>
            </div>
            {campaigns.length > 0 ? (
              <div className="max-h-48 space-y-2 overflow-auto pr-1" aria-label="Existing campaigns">
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
              <div className="text-xs text-rc-muted">No existing campaigns are available. Start a new campaign or keep this task standalone.</div>
            )}
          </div>
        )}

        {campaignMode === "new" && (
          <div>
            <label className="block text-sm text-rc-text-secondary mb-1">New campaign name</label>
            <input
              value={newCampaignName}
              onChange={(e) => setNewCampaignName(e.target.value)}
              className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm focus:outline-none focus:border-rc-accent"
              placeholder="e.g. btc-5m-stability"
            />
            <p className="mt-1 text-xs text-rc-muted">The entered name is stored as-is. Internal new-campaign markers are never shown or submitted.</p>
          </div>
        )}

        {campaignMode === "standalone" && (
          <div className="rounded-card border border-dashed border-rc-border px-3 py-2 text-xs text-rc-muted">
            This imported brief will run without campaign history.
          </div>
        )}
      </section>

      <div>
        <label className="block text-sm text-rc-text-secondary mb-1">Task Brief</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm font-mono focus:outline-none focus:border-rc-accent resize-y"
          placeholder="Paste your task brief here..."
        />
      </div>

      <div className="flex items-center gap-3">
        <input ref={fileRef} type="file" accept=".md,.txt" onChange={handleFile} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          className="btn-ghost px-4 py-2 text-sm border border-rc-border"
        >
          Upload file
        </button>
        <div className="flex-1" />
        <button
          onClick={() => nav("/")}
          className="btn-ghost px-4 py-2 text-sm border border-rc-border"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !canSubmit}
          className="btn-accent px-5 py-2 text-sm font-medium"
        >
          {submitting ? "Submitting…" : "Submit & Plan"}
        </button>
      </div>
    </div>
  );
}
