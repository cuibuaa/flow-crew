import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchRunDetail, fetchRunStageOutput, fetchRunSummary, type StageOutputResponse } from "../api";
import type { RunDetailData, RunStage } from "../types";
import ActivityFeed from "./ActivityFeed";
import CampaignKG from "./panels/CampaignKG";
import CampaignKnowledge from "./panels/CampaignKnowledge";
import StageDAG from "./StageDAG";

function fmtMs(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtBytes(bytes?: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Lazily load on expand: start with a generous tail so huge codex transcripts
// don't block, then let the operator pull the full log on demand.
const OUTPUT_TAIL_BYTES = 256 * 1024;

// Lightweight render of the run summary markdown (summary.md). No markdown dep:
// drop the top H1 (the panel has its own title), then render `## ` sections with
// their bullet/plain lines. Mirrors the parsing the old monitor panel used.
function renderSummaryMarkdown(md: string) {
  const stripped = md.replace(/^#\s+[^\n]+\n*/, "");
  const sections = stripped.split(/^## /m).map((s) => s.trim()).filter(Boolean);
  return sections.map((sec, i) => {
    const [heading, ...rest] = sec.split("\n");
    const lines = rest.filter((l) => l.trim());
    return (
      <div key={i} style={{ marginBottom: 10 }}>
        {heading ? <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{heading.replace(/[#*`]/g, "").trim()}</div> : null}
        {lines.map((line, j) => {
          const bullet = /^\s*[-*]\s+/.test(line);
          const text = line.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, "");
          return (
            <div key={j} style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.85, paddingLeft: bullet ? 12 : 0 }}>
              {bullet ? "• " : ""}{text}
            </div>
          );
        })}
      </div>
    );
  });
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
  const [summary, setSummary] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<StageOutputResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);

  useEffect(() => {
    if (providedRun || !id) return;
    fetchRunDetail(id).then((data) => {
      setRun(data);
      const stages = data.stages ?? [];
      setSelectedStageId(searchParams.get("stage") ?? (data.status === "failed" ? stages.find((stage) => stage.status === "failed")?.id : undefined) ?? stages.find((stage) => stage.status === "complete")?.id ?? stages[0]?.id);
    }).catch((err: Error) => setError(err.message));
  }, [id, providedRun, searchParams]);

  useEffect(() => {
    const rid = providedRun?.runId ?? id;
    if (!rid) return;
    let cancelled = false;
    fetchRunSummary(rid).then((s) => { if (!cancelled) setSummary(s); });
    return () => { cancelled = true; };
  }, [providedRun?.runId, id]);

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

  // Lazily fetch the selected stage's log only when the disclosure is open; load
  // a generous tail first, full on demand. Replaces the old embedded 2KB preview.
  useEffect(() => {
    if (!logOpen || !run || !selected) return;
    let cancelled = false;
    setLogLoading(true);
    setLog(null);
    fetchRunStageOutput(run.runId, selected.id, { tailBytes: OUTPUT_TAIL_BYTES })
      .then((res) => { if (!cancelled) setLog(res); })
      .catch(() => { if (!cancelled) setLog({ text: "(failed to load output)", totalBytes: null, tailBytes: null, truncated: false }); })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [logOpen, run?.runId, selected?.id]);

  // Reset the lazily-loaded log when switching stages so the new stage's preview shows.
  useEffect(() => { setLog(null); }, [selectedStageId]);

  const loadFullLog = async () => {
    if (!run || !selected || fullLoading) return;
    setFullLoading(true);
    try {
      setLog(await fetchRunStageOutput(run.runId, selected.id, { full: true }));
    } catch { /* keep the tail already shown */ }
    finally { setFullLoading(false); }
  };

  if (error) return <div className="empty-state">run detail unavailable: {error}</div>;
  if (!run) return <div className="empty-state">loading run detail…</div>;
  const campaignId = run.campaignId ?? "";
  // Embedded 2KB preview is the instant fallback shown until the full log is lazily loaded on expand.
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
      {summary ? (
        <div className="section" data-testid="run-summary">
          <h2>Run Summary <span className="h2-hint">generated after the run completed</span></h2>
          <div className="run-summary-body">{renderSummaryMarkdown(summary)}</div>
        </div>
      ) : null}
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
          <details className="stage-output-disclosure" open={logOpen} onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Show stage log</summary>
            <div className="stage-output-meta" data-testid="stage-output-meta">
              {logLoading
                ? "Loading full log…"
                : log
                  ? (log.truncated
                      ? `Showing last ${fmtBytes(log.tailBytes)} of ${fmtBytes(log.totalBytes)}`
                      : `Full log (${fmtBytes(log.totalBytes)})`)
                  : "Preview (first 2KB) — expand to load the full log"}
              {log?.truncated ? (
                <button type="button" className="btn ghost" disabled={fullLoading} onClick={loadFullLog} style={{ marginLeft: 8 }}>
                  {fullLoading ? "Loading…" : "Load full log"}
                </button>
              ) : null}
            </div>
            <div className="stage-output-preview" data-testid="stage-output-preview" tabIndex={0} aria-label="Stage output">
              {log?.text ?? outputPreview}
            </div>
          </details>
        </div>
        <ActivityFeed events={run.events ?? []} />
      </div>
      {runKgNodes.length > 0 ? (
        <>
          <CampaignKnowledge campaignId={run.runId} nodes={runKgNodes} />
          <details className="kg-graph-details">
            <summary>Relational graph · {runKgNodes.length} nodes</summary>
            <CampaignKG campaignId={run.runId} nodes={runKgNodes} edges={runKgEdges} emptyState="show" />
          </details>
        </>
      ) : null}
      {run.status === "awaiting_approval" ? <div className="section" data-testid="plan-review-section"><h2>Plan review <span className="h2-hint">awaiting approval</span></h2><div className="empty-state">Plan is waiting for approval.</div></div> : null}
    </div>
  );
}
