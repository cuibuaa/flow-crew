import { useEffect, useState } from "react";
import type { Campaign } from "../types";

const initialDraft = {
  source: "paste",
  campaign: "standalone",
  campaignName: "",
  campaignId: "",
  projectDir: "",
  workflow: "default",
  brief: "# Task: example brief\n\n## Goal\nImplement X.\n",
  supervise: true,
  noCampaign: false,
  maxIter: 8,
};

type NewRunModalProps = {
  open?: boolean;
  isOpen?: boolean;
  campaigns?: Campaign[];
  defaultCampaignId?: string;
  onClose: () => void;
  onShip?: (draft: typeof initialDraft) => Promise<void> | void;
  onSubmit?: (draft: typeof initialDraft) => Promise<void> | void;
};

export default function NewRunModal({ open, isOpen, campaigns, defaultCampaignId, onClose, onShip, onSubmit }: NewRunModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const visible = open ?? isOpen ?? false;
  const ship = onShip ?? onSubmit;
  const submitUnavailable = !ship;
  const maxIterInvalid = !Number.isInteger(draft.maxIter) || draft.maxIter < 1;
  useEffect(() => {
    if (!visible || !defaultCampaignId) return;
    setDraft((current) => current.campaign === defaultCampaignId ? current : { ...current, campaign: defaultCampaignId, noCampaign: false });
  }, [defaultCampaignId, visible]);
  if (!visible) return null;
  return (
    <div className="modal-backdrop show" data-testid="new-run-modal">
      <form className="modal" onSubmit={(event) => { event.preventDefault(); void ship?.(draft); }}>
        <h2>+ New Run</h2>
        <div className="form-row"><label htmlFor="new-run-source">Brief source</label><select id="new-run-source" value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })}><option value="paste">Paste text below</option><option value="upload">Upload .md file</option></select></div>
        <div className="form-row"><label htmlFor="new-run-campaign">Campaign attachment</label><select id="new-run-campaign" value={draft.campaign} onChange={(event) => setDraft({ ...draft, campaign: event.target.value })}><option value="standalone">Standalone (no campaign)</option>{(campaigns ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>Attach to existing: {campaign.name}</option>)}<option value="new">+ Create new campaign…</option></select></div>
        {draft.campaign === "new" ? (
          <div className="new-campaign-fields">
            <div className="form-row"><label htmlFor="new-run-campaign-name">Campaign name</label><input id="new-run-campaign-name" required value={draft.campaignName} onChange={(event) => setDraft({ ...draft, campaignName: event.target.value })} /></div>
            <div className="form-row"><label htmlFor="new-run-campaign-id">Campaign id slug <span>lowercase letters, numbers, and dashes</span></label><input id="new-run-campaign-id" required pattern="[a-z0-9-]+" value={draft.campaignId} onChange={(event) => setDraft({ ...draft, campaignId: event.target.value })} /></div>
          </div>
        ) : null}
        <div className="form-row"><label htmlFor="new-run-project-dir">Working directory <span>(where agents read/write code · runs storage stays in ~/.fc/)</span></label><input id="new-run-project-dir" value={draft.projectDir} onChange={(event) => setDraft({ ...draft, projectDir: event.target.value })} /></div>
        <div className="form-row"><label htmlFor="new-run-workflow">Workflow</label><select id="new-run-workflow" value={draft.workflow} onChange={(event) => setDraft({ ...draft, workflow: event.target.value })}><option value="default">default (plan → execute → review)</option><option value="engineering">engineering (with QA gate retry)</option><option value="research-mode">research-mode (campaign-loop with greedy_stack)</option></select></div>
        {draft.source === "upload" ? (
          <div className="form-row">
            <label htmlFor="new-run-upload">Markdown file <span>.md or text/markdown</span></label>
            <input id="new-run-upload" type="file" accept=".md,text/markdown" />
          </div>
        ) : (
          <div className="form-row"><label htmlFor="new-run-brief">Brief content</label><textarea id="new-run-brief" value={draft.brief} onChange={(event) => setDraft({ ...draft, brief: event.target.value })} /></div>
        )}
        <div className="form-row inline-controls">
          <label><input type="checkbox" checked={draft.supervise} onChange={(event) => setDraft({ ...draft, supervise: event.target.checked })} /> --supervise</label>
          <label><input type="checkbox" checked={draft.noCampaign} onChange={(event) => setDraft({ ...draft, noCampaign: event.target.checked })} /> --no-campaign</label>
          <label>max-iter <input type="number" min={1} step={1} aria-invalid={maxIterInvalid} value={draft.maxIter} onChange={(event) => setDraft({ ...draft, maxIter: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })} /></label>
        </div>
        {maxIterInvalid ? <div className="field-error" role="alert">Max iterations must be at least 1.</div> : null}
        {submitUnavailable ? <div className="form-error" role="status">Run creation is not connected yet.</div> : null}
        <div className="footer"><button className="btn ghost" type="button" onClick={onClose}>cancel</button><button className="btn" type="submit" disabled={submitUnavailable || maxIterInvalid}>Ship it</button></div>
      </form>
    </div>
  );
}
