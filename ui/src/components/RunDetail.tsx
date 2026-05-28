import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchRunDetail } from "../api";
import type { RunDetailData, RunStage } from "../types";
import ActivityFeed from "./ActivityFeed";
import CampaignKG from "./panels/CampaignKG";
import StageDAG from "./StageDAG";

function fmtMs(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function RunDetail({ run: providedRun }: { run?: RunDetailData }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [run, setRun] = useState<RunDetailData | null>(providedRun ?? null);
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(
    searchParams.get("stage") ?? (providedRun?.status === "failed" ? providedRun?.stages?.find((stage) => stage.status === "failed")?.id : undefined) ?? providedRun?.stages?.[0]?.id,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providedRun || !id) return;
    fetchRunDetail(id).then((data) => {
      setRun(data);
      const stages = data.stages ?? [];
      setSelectedStageId(searchParams.get("stage") ?? (data.status === "failed" ? stages.find((stage) => stage.status === "failed")?.id : undefined) ?? stages.find((stage) => stage.status === "complete")?.id ?? stages[0]?.id);
    }).catch((err: Error) => setError(err.message));
  }, [id, providedRun, searchParams]);

  const selectStage = (stageId: string) => {
    setSelectedStageId(stageId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("stage", stageId);
      return next;
    }, { replace: true });
  };

  const stages = run?.stages ?? [];
  const selected = useMemo<RunStage | undefined>(() => stages.find((stage) => stage.id === selectedStageId) ?? stages[0], [stages, selectedStageId]);
  if (error) return <div className="empty-state">run detail unavailable: {error}</div>;
  if (!run) return <div className="empty-state">loading run detail…</div>;
  const campaignId = run.campaignId ?? "";
  const outputPreview = selected ? (run.stage_outputs ?? {})[selected.id] ?? "(no output captured)" : "(no output captured)";
  const runKgNodes = (run.kg?.nodes ?? []).map((node) => ({ ...node, campaign: run.runId }));
  const runKgEdges = run.kg?.edges ?? [];
  const failedStage = stages.find((stage) => stage.status === "failed");
  const failureReason = run.status === "failed" ? run.failureReason ?? (failedStage ? `${failedStage.id} failed` : "") : "";
  return (
    <div data-testid="run-detail">
      <div className="breadcrumb">
        <button className="breadcrumb-back" type="button" onClick={() => navigate(-1)}>Back</button>
        <Link to={campaignId ? `/campaign/${encodeURIComponent(campaignId)}` : "/"}>{campaignId ? `Campaign: ${campaignId}` : "Workspaces"}</Link>
        <span>/</span>
        <span className="mono">run {run.runId}</span>
      </div>
      <div className="campaign-header">
        <div>
          <h1 className="run-title">{run.runId}</h1>
          <div className="subtitle">workflow=<code>{run.workflowName ?? ""}</code> · project=<code>{(run.projectDir ?? "").split("/").pop()}</code></div>
          <div className="badges">
            <span className={`badge ${run.status === "complete" ? "success" : run.status === "failed" ? "error" : "accent"}`}>{run.status}</span>
            <span className="badge">iter {run.iteration ?? "?"}/{run.maxIterations ?? "?"}</span>
            <span className="badge">{run.duration_min ?? "—"}m</span>
            {campaignId ? <span className="badge">campaign: {campaignId}</span> : null}
          </div>
        </div>
        {run.status === "failed" ? (
          <div className="header-actions recovery-actions" aria-label="Failed run recovery actions">
            <button className="btn" type="button" onClick={() => failedStage && selectStage(failedStage.id)}>Retry failed stage</button>
            <button className="btn ghost" type="button" onClick={() => void navigator.clipboard?.writeText(failureReason || "Run failed")}>Copy failure summary</button>
            {failedStage ? <button className="btn ghost" type="button" onClick={() => selectStage(failedStage.id)}>Show failed stage</button> : null}
          </div>
        ) : null}
      </div>
      {failureReason ? <div className="empty-state error-state" data-testid="run-failure-reason">{failureReason}</div> : null}
      <div className="section" data-testid="run-section-dag">
        <h2>Stage DAG <span className="h2-hint">{stages.length} stages · click a node to inspect</span></h2>
        <div className="stage-nav-layout">
          <StageDAG stages={stages} selectedStageId={selected?.id} onSelect={selectStage} />
          <div className="stage-index" aria-label="Stage index">
            {stages.map((stage, index) => (
              <button className={`stage-index-row ${selected?.id === stage.id ? "active" : ""}`} type="button" key={stage.id} onClick={() => selectStage(stage.id)}>
                <span className="stage-ordinal">{index + 1}</span>
                <span className="stage-index-id">{stage.id}</span>
                <span className={`outcome-badge ${stage.status === "complete" ? "shipped" : stage.status === "failed" ? "rejected" : stage.status}`}>{stage.status.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="run-split">
        <div className="stage-detail-panel" data-testid="stage-detail-panel">
          <div className="sd-head"><span className="sd-name">{selected?.id ?? "—"}</span><span className={`outcome-badge ${selected?.status === "complete" ? "shipped" : selected?.status === "running" ? "running" : selected?.status === "failed" ? "rejected" : "idle"}`}>{(selected?.status ?? "unknown").toUpperCase()}</span></div>
          <div className="sd-meta-row"><span className="k">role</span><span>{selected?.role ?? "—"}</span></div>
          <div className="sd-meta-row"><span className="k">gate</span><span>{selected?.is_gate ? "✓ gate" : "—"}</span></div>
          <div className="sd-meta-row"><span className="k">depends_on</span><span className="mono">{selected?.depends_on?.join(", ") || "—"}</span></div>
          <div className="sd-meta-row"><span className="k">retry_to</span><span className="mono">{selected?.retry_to?.join(", ") || "—"}</span></div>
          <div className="sd-meta-row"><span className="k">duration</span><span className="mono">{fmtMs(selected?.duration_ms)}</span></div>
          <div className="sd-meta-row"><span className="k">retries</span><span className="mono">{selected?.retries ?? 0}</span></div>
          <div className="sd-meta-row"><span className="k">artifacts</span><span className="mono">{selected?.artifact_count ?? 0}</span></div>
          <div className="stage-summary" data-testid="stage-summary">
            <strong>{selected?.id ?? "Selected stage"}</strong> is {(selected?.status ?? "unknown").replace("_", " ")} with {selected?.artifact_count ?? 0} artifacts and {selected?.retries ?? 0} retries.
          </div>
          <details className="stage-output-disclosure">
            <summary>Show first 2KB log</summary>
            <div className="stage-output-preview" data-testid="stage-output-preview" tabIndex={0} aria-label="Stage output preview">{outputPreview}</div>
          </details>
        </div>
        <ActivityFeed events={run.events ?? []} />
      </div>
      {runKgNodes.length > 0 ? <CampaignKG campaignId={run.runId} nodes={runKgNodes} edges={runKgEdges} emptyState="show" /> : null}
      {run.status === "awaiting_approval" ? <div className="section" data-testid="plan-review-section"><h2>Plan review <span className="h2-hint">awaiting approval</span></h2><div className="empty-state">Plan is waiting for approval.</div></div> : null}
    </div>
  );
}
