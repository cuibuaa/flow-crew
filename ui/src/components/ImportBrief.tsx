import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createTask, executeTask, fetchCampaigns } from "../api";
import type { CampaignSummary } from "../types";

export default function ImportBrief() {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [newCampaignName, setNewCampaignName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    fetchCampaigns().then(setCampaigns).catch(() => {});
  }, []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setContent(reader.result as string);
    reader.readAsText(file);
  };

  const resolvedCampaignId = campaignId === "__new__" && newCampaignName.trim()
    ? `new:${newCampaignName.trim()}`
    : campaignId === "__new__" ? undefined : (campaignId || undefined);

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) return;
    setSubmitting(true);
    try {
      const { id } = await createTask({ name: name.trim(), workflow: "default", discussion: [], plan: [], planFile: content, campaignId: resolvedCampaignId });
      await executeTask(id);
      nav(`/task/${id}/monitor`);
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-rc-text">Import Task Brief</h2>

      <div>
        <label className="block text-sm text-rc-text-secondary mb-1">Task Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm focus:outline-none focus:border-rc-accent"
          placeholder="e.g. Implement retry loop"
        />
      </div>

      <div>
        <label className="block text-sm text-rc-text-secondary mb-1">Campaign</label>
        <select value={campaignId} onChange={e => { setCampaignId(e.target.value); if (e.target.value !== "__new__") setNewCampaignName(""); }}
          className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm focus:outline-none focus:border-rc-accent">
          <option value="">None (standalone)</option>
          {campaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.runCount} runs)</option>
          ))}
          <option value="__new__">+ New campaign...</option>
        </select>
      </div>

      {campaignId === "__new__" && (
        <div>
          <label className="block text-sm text-rc-text-secondary mb-1">Campaign name</label>
          <input
            value={newCampaignName}
            onChange={(e) => setNewCampaignName(e.target.value)}
            className="w-full px-3 py-2 bg-rc-code border border-rc-border rounded-input text-rc-text text-sm focus:outline-none focus:border-rc-accent"
            placeholder="e.g. btc-5m-stability"
          />
        </div>
      )}

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
          disabled={submitting || !name.trim() || !content.trim()}
          className="btn-accent px-5 py-2 text-sm font-medium"
        >
          {submitting ? "Submitting…" : "Submit & Plan"}
        </button>
      </div>
    </div>
  );
}
