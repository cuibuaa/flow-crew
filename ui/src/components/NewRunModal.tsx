import { useEffect, useState } from "react";
import { BriefAdmissionRequestError, preflightBrief } from "../api";
import type { BriefAdmissionSubmission, BriefPreflightResponse, Campaign } from "../types";

const initialDraft = {
  campaign: "standalone",
  campaignName: "",
  campaignId: "",
  projectDir: "",
  workflow: "default",
  brief: "# Task: example brief\n\n## Goal\nImplement X.\n",
  supervise: true,
  maxIter: 8,
};

export type NewRunDraft = typeof initialDraft;

type NewRunModalProps = {
  open?: boolean;
  isOpen?: boolean;
  campaigns?: Campaign[];
  defaultCampaignId?: string;
  onClose: () => void;
  onShip?: (draft: NewRunDraft, admission: BriefAdmissionSubmission) => Promise<void> | void;
  onSubmit?: (draft: NewRunDraft, admission: BriefAdmissionSubmission) => Promise<void> | void;
};

export function BriefPreflightPanel({
  preflight,
  acknowledged,
  onAcknowledgedChange,
}: {
  preflight: BriefPreflightResponse;
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
}) {
  return (
    <section className="brief-preflight" aria-live="polite" aria-label="Brief preflight result">
      <div className="brief-preflight-heading">
        <strong>Brief preflight</strong>
        <code title={preflight.report.digest}>{preflight.report.digest.slice(0, 12)}</code>
      </div>
      <dl className="brief-preflight-summary">
        <div><dt>Contract</dt><dd>{preflight.report.contractReady ? "Ready" : "Problems found"}</dd></div>
        <div><dt>Frontmatter</dt><dd>{preflight.report.frontmatter.status}</dd></div>
        <div><dt>Input</dt><dd>{preflight.report.inputKind === "plain_text" ? "Single-line plain text" : "Structured brief"}</dd></div>
      </dl>
      <ul className="brief-preflight-findings">
        {preflight.report.findings.map((finding) => (
          <li className={`brief-finding ${finding.level}`} key={finding.fingerprint}>
            <strong>{finding.level === "ok" ? "Pass" : finding.level === "warn" ? "Warning" : "Problem"}</strong>
            <span>{finding.message}</span>
            {finding.risk ? <small>Risk: {finding.risk}</small> : null}
            {finding.suggestion ? <small>Suggestion: {finding.suggestion}</small> : null}
          </li>
        ))}
      </ul>
      {preflight.report.requiresAcknowledgement ? (
        <label className="brief-acknowledgement">
          <input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledgedChange(event.target.checked)} />
          I reviewed these warnings or contract problems and want to continue with this exact brief.
        </label>
      ) : <p className="brief-preflight-ready">No consequential findings require acknowledgement.</p>}
    </section>
  );
}

export default function NewRunModal({ open, isOpen, campaigns, defaultCampaignId, onClose, onShip, onSubmit }: NewRunModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<BriefPreflightResponse | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const visible = open ?? isOpen ?? false;
  const ship = onShip ?? onSubmit;
  const submitUnavailable = !ship;
  const maxIterInvalid = !Number.isInteger(draft.maxIter) || draft.maxIter < 1;
  useEffect(() => {
    if (!visible) return;
    setSubmitError(null);
    setPreflight(null);
    setAcknowledged(false);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const campaign = defaultCampaignId ?? "standalone";
    setDraft((current) => current.campaign === campaign ? current : { ...current, campaign });
  }, [defaultCampaignId, visible]);

  const updateBrief = (brief: string) => {
    setDraft((current) => ({ ...current, brief }));
    setPreflight(null);
    setAcknowledged(false);
    setSubmitError(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ship || submitting || maxIterInvalid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (!preflight) {
        setPreflight(await preflightBrief(draft.brief));
        setAcknowledged(false);
        return;
      }
      if (preflight.report.requiresAcknowledgement && !acknowledged) return;
      await ship(draft, {
        briefPreflightDigest: preflight.report.digest,
        briefPreflightReceipt: preflight.receipt,
        ...(preflight.report.requiresAcknowledgement ? { acknowledgeBriefWarnings: true } : {}),
      });
    } catch (err) {
      if (err instanceof BriefAdmissionRequestError) {
        setPreflight(err.preflight);
        setAcknowledged(false);
      }
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;
  return (
    <div className="modal-backdrop show" data-testid="new-run-modal">
      <form className="modal" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
        <h2>+ New Run</h2>
        <div className="form-row"><label htmlFor="new-run-campaign">Campaign attachment</label><select id="new-run-campaign" value={draft.campaign} onChange={(event) => setDraft({ ...draft, campaign: event.target.value })}><option value="standalone">Standalone (no campaign)</option>{(campaigns ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>Attach to existing: {campaign.name}</option>)}<option value="new">+ Create new campaign…</option></select></div>
        {draft.campaign === "new" ? (
          <div className="new-campaign-fields">
            <div className="form-row"><label htmlFor="new-run-campaign-name">Campaign name</label><input id="new-run-campaign-name" required value={draft.campaignName} onChange={(event) => setDraft({ ...draft, campaignName: event.target.value })} /></div>
            <div className="form-row"><label htmlFor="new-run-campaign-id">Campaign id slug <span>lowercase letters, numbers, and dashes</span></label><input id="new-run-campaign-id" required pattern="[a-z0-9-]+" value={draft.campaignId} onChange={(event) => setDraft({ ...draft, campaignId: event.target.value })} /></div>
          </div>
        ) : null}
        <div className="form-row"><label htmlFor="new-run-project-dir">Working directory <span>(where agents read/write code · runs storage stays in ~/.fc/)</span></label><input id="new-run-project-dir" value={draft.projectDir} onChange={(event) => setDraft({ ...draft, projectDir: event.target.value })} /></div>
        <div className="form-row"><label htmlFor="new-run-workflow">Workflow</label><select id="new-run-workflow" value={draft.workflow} onChange={(event) => setDraft({ ...draft, workflow: event.target.value })}><option value="default">default (plan → execute → review)</option><option value="engineering">engineering (with QA gate retry)</option><option value="research-mode">research-mode (campaign-loop with greedy_stack)</option></select></div>
        <div className="form-row"><label htmlFor="new-run-brief">Brief content</label><textarea id="new-run-brief" required value={draft.brief} onChange={(event) => updateBrief(event.target.value)} /></div>
        {preflight ? <BriefPreflightPanel preflight={preflight} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} /> : null}
        <div className="form-row inline-controls">
          <label><input type="checkbox" checked={draft.supervise} onChange={(event) => setDraft({ ...draft, supervise: event.target.checked })} /> Supervise run</label>
          <label>Max iterations <input type="number" min={1} step={1} aria-invalid={maxIterInvalid} value={draft.maxIter} onChange={(event) => setDraft({ ...draft, maxIter: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })} /></label>
        </div>
        {maxIterInvalid ? <div className="field-error" role="alert">Max iterations must be at least 1.</div> : null}
        {submitUnavailable ? <div className="form-error" role="status">Run creation is not connected yet.</div> : null}
        {submitError ? <div className="form-error" role="alert">Unable to continue: {submitError}</div> : null}
        <div className="footer"><button className="btn ghost" type="button" disabled={submitting} onClick={onClose}>cancel</button><button className="btn" type="submit" disabled={submitUnavailable || maxIterInvalid || submitting || Boolean(preflight?.report.requiresAcknowledgement && !acknowledged)}>{submitting ? (preflight ? "Starting…" : "Checking…") : (preflight ? "Start run" : "Check brief")}</button></div>
      </form>
    </div>
  );
}
