import { useState, useEffect } from "react";
import { fetchCampaigns } from "../api";
import type { CampaignSummary } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, campaignId?: string) => void;
}

export default function NewTaskDialog({ open, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [newCampaignName, setNewCampaignName] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchCampaigns().then(setCampaigns).catch(() => {});
    setName("");
    setCampaignId("");
    setNewCampaignName("");
    setSuggestion(null);
  }, [open]);

  useEffect(() => {
    if (!name || campaigns.length === 0) { setSuggestion(null); return; }
    const words = name.toLowerCase().split(/\s+/);
    const match = campaigns.find(c => words.some(w => c.name.toLowerCase().includes(w)));
    setSuggestion(match && campaignId !== match.id ? match.id : null);
  }, [name, campaigns, campaignId]);

  if (!open) return null;

  const resolvedCampaignId = campaignId === "__new__" && newCampaignName.trim()
    ? `new:${newCampaignName.trim()}`
    : campaignId === "__new__" ? undefined : (campaignId || undefined);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-rc-bg border border-rc-border rounded-card shadow-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-bold text-rc-text uppercase tracking-wider">New Task</h2>

        <label className="block text-xs text-rc-text-secondary">
          Task name
          <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. BTC wave 6"
            className="w-full mt-1 px-3 py-2 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent" />
        </label>

        <label className="block text-xs text-rc-text-secondary">
          Campaign
          <select value={campaignId} onChange={e => { setCampaignId(e.target.value); if (e.target.value !== "__new__") setNewCampaignName(""); }}
            className="w-full mt-1 px-3 py-2 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent">
            <option value="">None (standalone)</option>
            {campaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.runCount} runs)</option>
            ))}
            <option value="__new__">+ New campaign...</option>
          </select>
        </label>

        {campaignId === "__new__" && (
          <label className="block text-xs text-rc-text-secondary">
            Campaign name
            <input type="text" value={newCampaignName} onChange={e => setNewCampaignName(e.target.value)} placeholder="e.g. btc-5m-stability"
              className="w-full mt-1 px-3 py-2 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent" />
          </label>
        )}

        {suggestion && (
          <div className="text-xs text-rc-accent cursor-pointer" onClick={() => setCampaignId(suggestion)}>
            💡 Matches "{suggestion}" based on name — click to select
          </div>
        )}

        <div className="flex space-x-2 pt-2">
          <button onClick={() => { if (name.trim()) onSubmit(name.trim(), resolvedCampaignId); }}
            disabled={!name.trim()}
            className="btn-accent px-4 py-2 text-sm font-medium disabled:opacity-50">
            Start Discussion
          </button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm border border-rc-border">Cancel</button>
        </div>
      </div>
    </div>
  );
}
