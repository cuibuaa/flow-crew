import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchRunDetail, fetchRunStageOutput, fetchRunSummary, type StageOutputResponse } from "../api";
import type { RealityGateCheckDiagnostic, RealityGateOutputTail, RunDetailData, RunStage } from "../types";
import ActivityFeed from "./ActivityFeed";
import {
  formatDuration,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  parseRunSummary,
  realRunStages,
  runElapsedMs,
  runFailureHistory,
  runStatusDescription,
  runStatusTone,
  runUsageTotal,
  stageAttemptLedger,
  type ParsedRunSummary,
  type ParsedSummarySection,
  type SummarySectionKind,
} from "./run/model";
import StageDAG from "./StageDAG";
import { showToast } from "./Toast";
import "../run-page.css";

const OUTPUT_TAIL_BYTES = 256 * 1024;
const RUN_REFRESH_MS = 5_000;

type SummaryLoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; summary: ParsedRunSummary }
  | { kind: "error"; message: string };

type LiveConnection = "idle" | "connecting" | "streaming" | "reconnecting" | "unavailable";

function fmtBytes(bytes?: number | null): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtInteger(value?: number | null): string {
  return value == null ? "unknown" : new Intl.NumberFormat("en-US").format(value);
}

function isTerminalStageStatus(status?: string): boolean {
  return status === "complete" || status === "completed" || status === "failed" || status === "skipped";
}

function stageStatusTone(status?: string): string {
  if (status === "complete" || status === "completed") return "shipped";
  if (status === "failed") return "rejected";
  if (status === "running") return "running";
  return status || "idle";
}

function initialStageId(run?: RunDetailData | null): string | undefined {
  if (!run) return undefined;
  const stages = realRunStages(run.stages);
  if (!isTerminalRunStatus(run.status)) return stages.find((stage) => stage.status === "running")?.id ?? stages[0]?.id;
  return stages.find((stage) => stage.status === "failed")?.id ?? stages[0]?.id;
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

function visibleSummaryLines(section: ParsedSummarySection, limit?: number): string[] {
  if (limit == null || section.lines.length <= limit) return section.lines;
  if (section.kind !== "delivery") return section.lines.slice(0, limit);
  const commitHeading = section.lines.findIndex((line) => /^\*\*Commits\b/i.test(line));
  if (commitHeading < 0) return section.lines.slice(0, limit);
  const fileLines = section.lines.slice(0, commitHeading).slice(0, Math.max(1, limit - 2));
  return [...fileLines, ...section.lines.slice(commitHeading, commitHeading + 2)].slice(0, limit);
}

function SummarySection({ section, limit }: { section: ParsedSummarySection; limit?: number }) {
  const shown = visibleSummaryLines(section, limit);
  return (
    <section className={`run-summary-section ${section.kind}`} data-summary-section={section.heading}>
      <h3>{section.heading}</h3>
      {shown.length > 0 ? (
        <ul>
          {shown.map((line, index) => <li key={`${line}-${index}`}>{stripInlineMarkdown(line)}</li>)}
        </ul>
      ) : <p className="run-muted">This section was recorded without readable lines.</p>}
      {shown.length < section.lines.length ? (
        <p className="run-truncation">Showing {shown.length} of {section.lines.length} recorded lines; the full record is available below.</p>
      ) : null}
    </section>
  );
}

function SummarySections({ summary, kinds, limit }: {
  summary: Extract<ParsedRunSummary, { kind: "terminal" }>;
  kinds?: SummarySectionKind[];
  limit?: number;
}) {
  const sections = kinds ? summary.sections.filter((section) => kinds.includes(section.kind)) : summary.sections;
  return <>{sections.map((section) => <SummarySection key={`${section.kind}-${section.heading}`} section={section} limit={limit} />)}</>;
}

function capturedTailLabel(stream: "stdout" | "stderr", output: RealityGateOutputTail): string {
  const scope = output.truncated
    ? `${fmtInteger(output.capturedChars)} of ${fmtInteger(output.sourceChars)} characters; tail truncated`
    : `${fmtInteger(output.capturedChars)} characters`;
  return `Captured ${stream} (${scope})`;
}

function RealityGateCheck({ check }: { check: RealityGateCheckDiagnostic }) {
  const severity = check.advisory ? "advisory" : "blocking";
  const outputs = (["stdout", "stderr"] as const)
    .map((stream) => ({ stream, output: check[stream] }))
    .filter((item): item is { stream: "stdout" | "stderr"; output: RealityGateOutputTail } => Boolean(item.output));
  return (
    <article className={`reality-check ${severity}`} data-severity={severity}>
      <div className="reality-check-head">
        <span className={`reality-severity ${severity}`}>{check.advisory ? "ADVISORY" : "BLOCKING"}</span>
        <strong>{check.name}</strong>
        <code>{check.type}</code>
      </div>
      <p>{check.details || "No check details were recorded."}</p>
      {outputs.length > 0 ? (
        <details className="reality-check-output">
          <summary>Show captured check output</summary>
          {outputs.map(({ stream, output }) => (
            <div key={stream} className="reality-output-stream">
              <div>{capturedTailLabel(stream, output)}</div>
              <pre>{output.tail || "(captured stream was empty)"}</pre>
            </div>
          ))}
        </details>
      ) : null}
    </article>
  );
}

function RealityGateDiagnostics({ run }: { run: RunDetailData }) {
  const failed = run.realityGate?.results?.filter((check) => !check.pass) ?? [];
  if (failed.length === 0) {
    return run.status === "reality_gate_failed" ? (
      <div className="run-local-alert error" role="alert" data-testid="reality-gate-diagnostics-unavailable">
        Reality Gate rejected this run, but structured per-check diagnostics are unavailable.
      </div>
    ) : null;
  }
  return (
    <section className="reality-gate-diagnostics" data-testid="reality-gate-diagnostics" aria-labelledby="reality-gate-title">
      <h3 id="reality-gate-title">Reality Gate evidence <span>{failed.length} non-passing {failed.length === 1 ? "check" : "checks"}</span></h3>
      <div className="reality-check-list">
        {failed.map((check, index) => <RealityGateCheck key={`${check.name}-${index}`} check={check} />)}
      </div>
    </section>
  );
}

function StageAttemptHistory({ stages, nowMs }: { stages: RunStage[]; nowMs: number }) {
  if (stages.length === 0) return <div className="empty-state">No workflow stages were recorded.</div>;
  return (
    <div className="attempt-history-list">
      {stages.map((stage) => {
        const ledger = stageAttemptLedger(stage, nowMs);
        return (
          <article className="attempt-history-stage" key={stage.id} data-testid={`attempt-ledger-${stage.id}`}>
            <header>
              <strong>{stage.id}</strong>
              <span className={`outcome-badge ${stageStatusTone(stage.status)}`}>{stage.status}</span>
              <span>{ledger.executions} {ledger.executions === 1 ? "execution" : "executions"} · {ledger.failedAttemptsExact ? ledger.failedAttempts : `at least ${ledger.failedAttempts}`} failed</span>
            </header>
            {ledger.rows.length > 0 ? (
              <ol className="attempt-ledger">
                {ledger.rows.map((attempt) => (
                  <li key={attempt.key} className={attempt.status === "failed" ? "failed" : ""}>
                    <span>Attempt {attempt.index}{attempt.current ? " · current" : ""}</span>
                    <code>{attempt.status}</code>
                    <span>{formatDuration(attempt.durationMs)}</span>
                    {attempt.current && !attempt.recorded ? <span className="run-muted">start time unavailable in this view</span> : null}
                    {attempt.error ? <span className="attempt-error">{attempt.error}</span> : null}
                  </li>
                ))}
              </ol>
            ) : ledger.legacyAggregate ? (
              <p className="run-muted">Legacy aggregate: {stage.status} · {formatDuration(ledger.aggregateDurationMs)} cumulative. Per-attempt history is unavailable.</p>
            ) : <p className="run-muted">This stage has no recorded execution.</p>}
          </article>
        );
      })}
    </div>
  );
}

export default function RunDetail({ run: providedRun }: { run?: RunDetailData }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStageId = searchParams.get("stage") ?? undefined;
  const [run, setRun] = useState<RunDetailData | null>(providedRun ?? null);
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(requestedStageId ?? initialStageId(providedRun));
  const [pageError, setPageError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<SummaryLoadState>({ kind: "loading" });
  const [logOpen, setLogOpen] = useState(() => Boolean(providedRun && !isTerminalRunStatus(providedRun.status) && realRunStages(providedRun.stages).some((stage) => stage.status === "running")));
  const [log, setLog] = useState<StageOutputResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);
  const [liveConnection, setLiveConnection] = useState<LiveConnection>("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (providedRun || !id) return;
    let cancelled = false;
    fetchRunDetail(id).then((data) => {
      if (cancelled) return;
      setRun(data);
      const nextStageId = requestedStageId ?? initialStageId(data);
      setSelectedStageId(nextStageId);
      setLogOpen(!isTerminalRunStatus(data.status) && realRunStages(data.stages).some((stage) => stage.id === nextStageId && stage.status === "running"));
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setPageError(message);
      showToast(`Run detail failed to load: ${message}`);
    });
    return () => { cancelled = true; };
  }, [id, providedRun, requestedStageId]);

  useEffect(() => {
    const runId = providedRun?.runId ?? id;
    if (!runId) return;
    let cancelled = false;
    setSummaryState({ kind: "loading" });
    fetchRunSummary(runId).then((content) => {
      if (cancelled) return;
      setSummaryState(content == null ? { kind: "missing" } : { kind: "ready", summary: parseRunSummary(content) });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setSummaryState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [providedRun?.runId, id, run?.status]);

  useEffect(() => {
    if (!run || isTerminalRunStatus(run.status)) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run?.status]);

  useEffect(() => {
    if (providedRun || !id || !run || isTerminalRunStatus(run.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchRunDetail(id).then((next) => {
        if (cancelled) return;
        setRun(next);
        setRefreshError(null);
      }).catch((error: unknown) => {
        if (!cancelled) setRefreshError(error instanceof Error ? error.message : String(error));
      });
    }, RUN_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [providedRun, id, run?.status]);

  const stages = realRunStages(run?.stages);
  const terminalRun = run ? isTerminalRunStatus(run.status) : false;
  const selected = useMemo<RunStage | undefined>(() => {
    if (!run) return undefined;
    return stages.find((stage) => stage.id === selectedStageId) ?? stages.find((stage) => stage.id === initialStageId(run)) ?? stages[0];
  }, [run, stages, selectedStageId]);
  const selectedIsTerminal = isTerminalStageStatus(selected?.status);
  const selectedIsLive = Boolean(run && !terminalRun && selected?.status === "running");

  const selectStage = (stageId: string, openOutput = false) => {
    setSelectedStageId(stageId);
    const stage = stages.find((candidate) => candidate.id === stageId);
    setLogOpen(openOutput || Boolean(!terminalRun && stage?.status === "running"));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("stage", stageId);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    if (!logOpen || !run || !selected) return;
    let cancelled = false;
    setLogLoading(false);
    setLog(null);
    setLiveError(null);
    setLiveConnection("idle");

    if (isTerminalStageStatus(selected.status)) {
      setLogLoading(true);
      fetchRunStageOutput(run.runId, selected.id, { tailBytes: OUTPUT_TAIL_BYTES })
        .then((response) => { if (!cancelled) setLog(response); })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          const absent = /(?:404|not found)/i.test(message);
          setLog({
            text: absent
              ? "(This terminal stage produced no output.md.)"
              : `(The terminal stage output is unavailable: ${message})`,
            totalBytes: null,
            tailBytes: null,
            truncated: false,
          });
          if (!absent) showToast(`Terminal stage output is unavailable: ${message}`);
        })
        .finally(() => { if (!cancelled) setLogLoading(false); });
      return () => { cancelled = true; };
    }

    if (!selectedIsLive) return () => { cancelled = true; };
    setLog({ text: "", totalBytes: 0, tailBytes: null, truncated: false });
    setLiveConnection("connecting");
    let source: EventSource;
    try {
      source = new EventSource(`/api/tasks/${encodeURIComponent(run.runId)}/stages/${encodeURIComponent(selected.id)}/live`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLiveConnection("unavailable");
      setLiveError(message);
      return () => { cancelled = true; };
    }
    source.onopen = () => {
      if (!cancelled) setLiveConnection("streaming");
    };
    source.onmessage = (event) => {
      if (cancelled) return;
      let chunk = event.data;
      try {
        const decoded = JSON.parse(event.data) as unknown;
        if (typeof decoded === "string") chunk = decoded;
      } catch { /* Retain plain-text compatibility. */ }
      const bytes = new TextEncoder().encode(chunk).byteLength;
      setLiveConnection("streaming");
      setLog((current) => ({
        text: `${current?.text ?? ""}${chunk}`,
        totalBytes: (current?.totalBytes ?? 0) + bytes,
        tailBytes: null,
        truncated: false,
      }));
    };
    source.onerror = () => {
      if (cancelled) return;
      setLiveConnection("reconnecting");
      void fetchRunDetail(run.runId).then((next) => {
        if (!cancelled) {
          setRun(next);
          setRefreshError(null);
        }
      }).catch((error: unknown) => {
        if (!cancelled) setRefreshError(error instanceof Error ? error.message : String(error));
      });
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [logOpen, run?.runId, selected?.id, selected?.status, selectedIsLive]);

  const loadFullLog = async () => {
    if (!run || !selected || fullLoading || !selectedIsTerminal) return;
    setFullLoading(true);
    try {
      setLog(await fetchRunStageOutput(run.runId, selected.id, { full: true }));
    } catch (error) {
      showToast(`Full terminal stage output is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFullLoading(false);
    }
  };

  if (pageError) {
    return <div className="empty-state error-state" role="alert">Run detail is unavailable: {pageError}. <Link to="/campaign">Return to Workspaces</Link></div>;
  }
  if (!run) return <div className="empty-state" role="status">Loading run detail…</div>;

  const campaignId = run.campaignId ?? "";
  const runningStages = stages.filter((stage) => stage.status === "running");
  const failures = runFailureHistory(stages);
  const usage = runUsageTotal(run);
  const elapsed = runElapsedMs(run, nowMs);
  const failedChecks = run.realityGate?.results?.filter((check) => !check.pass) ?? [];
  const genuineSummary = summaryState.kind === "ready" && summaryState.summary.kind === "terminal" ? summaryState.summary : null;
  const progressSummary = summaryState.kind === "ready" && summaryState.summary.kind === "progress" ? summaryState.summary : null;
  const outputPreview = selected ? (run.stage_outputs ?? {})?.[selected.id] ?? "(no output captured)" : "(no stage selected)";
  const displayedLog = log?.text
    || (selectedIsLive && logOpen ? "(This stage has not produced live output yet.)" : outputPreview);
  const statusTone = runStatusTone(run.status);
  const selectedLedger = selected ? stageAttemptLedger(selected, nowMs) : null;
  const needsIntervention = !isSuccessfulRunStatus(run.status) && terminalRun;

  const stageLog = selected ? (
    <section className="stage-detail-panel run-log-panel" data-testid="stage-detail-panel" aria-labelledby="selected-stage-title" data-answers="Q2 Q5">
      <div className="sd-head">
        <div>
          <span className="run-card-label">Selected stage</span>
          <strong className="sd-name" id="selected-stage-title">{selected.id}</strong>
        </div>
        <span className={`outcome-badge ${stageStatusTone(selected.status)}`}>{selected.status}</span>
      </div>
      <p className="stage-summary" data-testid="stage-summary">
        {selectedLedger?.recordedAttempts ?? 0} recorded {(selectedLedger?.recordedAttempts ?? 0) === 1 ? "attempt" : "attempts"}
        {selectedLedger?.current ? " + current execution" : ""}; {selectedLedger?.failedAttemptsExact === false ? `at least ${selectedLedger.failedAttempts}` : selectedLedger?.failedAttempts ?? 0} failed.
        {selectedLedger?.current ? ` Current attempt duration: ${formatDuration(selectedLedger.rows.find((row) => row.current)?.durationMs)}.` : ""}
      </p>
      <details className="stage-output-disclosure" open={logOpen} onToggle={(event) => setLogOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>Show stage log</summary>
        <div className="stage-output-meta" data-testid="stage-output-meta" aria-live="polite">
          {logLoading
            ? "Loading terminal stage output…"
            : selectedIsLive
              ? `Live log · ${liveConnection === "streaming" ? "streaming" : liveConnection} (${fmtBytes(log?.totalBytes ?? 0)} received)`
              : selectedIsTerminal
                ? log
                  ? log.totalBytes == null
                    ? "Terminal stage output is unavailable"
                    : log.truncated
                      ? `Showing last ${fmtBytes(log.tailBytes)} of ${fmtBytes(log.totalBytes)}`
                      : `Full terminal log (${fmtBytes(log.totalBytes)})`
                  : "Recorded preview — expand to load terminal stage output"
                : "This stage is not executing and has no live log."}
          {selectedIsTerminal && log?.truncated ? (
            <button type="button" className="btn ghost" disabled={fullLoading} aria-busy={fullLoading} onClick={loadFullLog}>
              {fullLoading ? "Loading…" : "Load full log"}
            </button>
          ) : null}
        </div>
        {liveError ? <div className="run-local-alert error" role="alert">Live log connection is unavailable: {liveError}</div> : null}
        <div className="stage-output-preview" data-testid="stage-output-preview" tabIndex={0} aria-label={`${selectedIsLive ? "Live log" : "Recorded output"} for ${selected.id}`}>
          {displayedLog}
        </div>
      </details>
    </section>
  ) : (
    <section className="stage-detail-panel run-log-panel run-no-stage" data-testid="stage-detail-panel" data-answers="Q2">
      <h2>Stage log</h2>
      <p>No stage is currently available to inspect.</p>
    </section>
  );

  return (
    <div className={`run-page ${terminalRun ? "terminal" : "live"}`} data-testid="run-detail" data-run-scene={terminalRun ? "terminal" : "non-terminal"}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <button className="breadcrumb-back" type="button" onClick={() => navigate(-1)}>Back</button>
        <Link to={campaignId ? `/campaign/${encodeURIComponent(campaignId)}` : "/campaign"}>{campaignId ? `Campaign: ${campaignId}` : "Workspaces"}</Link>
        <span aria-hidden="true">/</span>
        <span className="mono">run {run.runId}</span>
      </nav>

      <header className="run-page-heading">
        <div>
          <div className="run-eyebrow">{terminalRun ? "RUN RESULT" : "LIVE RUN"}</div>
          <h1 className="run-title">{terminalRun ? "Run result" : run.status === "running" ? "Run in progress" : "Run status"}</h1>
          <div className="run-context"><code>{run.runId}</code> · workflow <code>{run.workflowName || "unknown"}</code> · project <code>{(run.projectDir ?? "unknown").split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown"}</code></div>
        </div>
        {failures.failedStageIds.length > 0 ? (
          <div className="header-actions" aria-label="Failure inspection actions">
            <button className="btn" type="button" onClick={() => selectStage(failures.failedStageIds[0], true)}>Inspect failed stage</button>
            <button className="btn ghost" type="button" onClick={() => void navigator.clipboard?.writeText(run.failureReason || `${run.status}: ${failures.failedStageIds.join(", ")}`)}>Copy failure summary</button>
          </div>
        ) : null}
      </header>

      <section className="run-status-strip" aria-labelledby="run-status-heading" data-answers={terminalRun ? "Q3 Q4 Q5" : "Q2 Q4 Q5"}>
        <div className={`run-status-answer ${statusTone}`}>
          <span id="run-status-heading">{terminalRun ? "Canonical outcome" : "Canonical status"}</span>
          <strong data-testid="canonical-run-status">{run.status}</strong>
          <p>{runStatusDescription(run.status)}</p>
        </div>
        <div className="run-total-answer" data-testid="run-wall-time">
          <span>{terminalRun ? "Total wall time" : "Run elapsed"}</span>
          <strong>{formatDuration(elapsed)}</strong>
          <p>{terminalRun ? "From run start to recorded completion." : "Wall clock since the run started; not the current attempt duration."}</p>
        </div>
        <div className="run-total-answer" data-testid="run-cost-summary">
          <span>{usage.complete ? "Total recorded usage" : "Known recorded usage"}</span>
          <strong>{fmtInteger(usage.tokens)} tokens</strong>
          <p>{usage.complete ? "Complete run total, including supervisor." : "Known portion only, including recorded supervisor usage; unsettled or unavailable fields are not treated as zero."}</p>
        </div>
      </section>

      {refreshError ? (
        <div className="run-local-alert error" role="alert" data-testid="run-refresh-error">
          Run status update failed: {refreshError}. The last successfully loaded details remain visible.
        </div>
      ) : null}

      {!terminalRun && run.status === "parked" ? (
        <div className="approval-waiting" role="status" data-testid="parked-approval-banner" data-answers="Q2 Q5">
          <strong>Awaiting approval</strong>
          <span>No worker is active for this run. Review the pending decision before work can continue.</span>
          <Link className="btn" to="/inbox">Open approval in Inbox</Link>
        </div>
      ) : null}

      {!terminalRun && run.status === "awaiting_approval" ? (
        <div className="approval-waiting" role="status" data-testid="legacy-approval-banner" data-answers="Q2 Q5">
          <strong>Legacy plan approval pending</strong>
          <span>No stage is executing. This legacy plan-review state is separate from the consequential-action inbox.</span>
        </div>
      ) : null}

      {!terminalRun ? (
        <>
          <section className="run-signal-bar" aria-label="Run signals" data-testid="run-signals" data-answers="Q2 Q5">
            <div className="run-signal unknown"><strong>Stall signal unknown</strong><span>No trustworthy worker heartbeat is recorded.</span></div>
            <div className={failures.failedAttempts > 0 ? "run-signal error" : "run-signal neutral"}>
              <strong>{failures.failedAttemptsExact ? failures.failedAttempts : `at least ${failures.failedAttempts}`} recorded failed {failures.failedAttempts === 1 ? "attempt" : "attempts"}</strong>
              <span>{failures.stageIds.length > 0 ? `Affected: ${failures.stageIds.join(", ")}` : "No failed attempt is present in the available ledger."}</span>
            </div>
            {failedChecks.length > 0 ? <div className="run-signal error"><strong>{failedChecks.length} non-passing gate {failedChecks.length === 1 ? "check" : "checks"}</strong><span>{failedChecks.map((check) => check.name).join(", ")}</span></div> : null}
          </section>
          <div className="run-live-layout">
            <section className="run-current-work" aria-labelledby="current-work-title" data-answers="Q2 Q5">
              <div className="run-section-heading">
                <div><span className="run-card-label">CURRENT WORK</span><h2 id="current-work-title">{runningStages.length > 0 ? `${runningStages.length} active ${runningStages.length === 1 ? "stage" : "stages"}` : "No active stage"}</h2></div>
              </div>
              {runningStages.length > 0 ? (
                <div className="running-stage-list">
                  {runningStages.map((stage) => {
                    const ledger = stageAttemptLedger(stage, nowMs);
                    const currentDuration = ledger.rows.find((attempt) => attempt.current)?.durationMs;
                    return (
                      <button type="button" className={selected?.id === stage.id ? "active" : ""} key={stage.id} onClick={() => selectStage(stage.id)} aria-pressed={selected?.id === stage.id}>
                        <strong>{stage.id}</strong>
                        <span>{stage.role || "role unknown"}{stage.is_gate ? " · gate" : ""}</span>
                        <span>{ledger.recordedAttempts} recorded {ledger.recordedAttempts === 1 ? "attempt" : "attempts"} + current execution</span>
                        <span>Current attempt: {formatDuration(currentDuration)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="run-empty-answer">No stage is executing, so there is no current live log. The canonical status above explains whether this run is waiting or paused.</p>
              )}
              <div className="stage-progress-block">
                <h3>Stage progress</h3>
                {stages.length > 0 ? (
                  <ol className="stage-progress-list">
                    {stages.map((stage, index) => {
                      const ledger = stageAttemptLedger(stage, nowMs);
                      return (
                        <li key={stage.id}>
                          <button type="button" onClick={() => selectStage(stage.id)} aria-label={`Inspect ${stage.id}, status ${stage.status}`}>
                            <span>{index + 1}</span><strong>{stage.id}</strong><code>{stage.status}</code><small>{ledger.executions}×</small>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                ) : <div className="empty-state">No workflow stages were recorded.</div>}
              </div>
            </section>
            {stageLog}
          </div>
          {run.failureReason ? <div className="run-local-alert error" role="alert" data-testid="run-failure-reason">Recorded run issue: {run.failureReason}</div> : null}
          <RealityGateDiagnostics run={run} />
        </>
      ) : (
        <div className="run-terminal-layout">
          <section className="run-terminal-summary" aria-labelledby="terminal-summary-title" data-answers="Q3 Q5">
            <div className="run-section-heading">
              <div><span className="run-card-label">CONCLUSION &amp; DELIVERY</span><h2 id="terminal-summary-title">What this run produced</h2></div>
            </div>
            {summaryState.kind === "loading" ? <p className="run-muted" role="status">Loading the recorded terminal summary…</p> : null}
            {summaryState.kind === "missing" ? <div className="run-local-alert warning">No terminal summary was recorded. The conclusion and delivery are unknown from this view.</div> : null}
            {summaryState.kind === "error" ? <div className="run-local-alert error" role="alert">Terminal summary could not be read: {summaryState.message}. Run status and execution history remain available.</div> : null}
            {progressSummary ? <div className="run-local-alert warning">Recorded progress exists, but it is not a terminal summary. It is kept in the audit section and is not presented as the final conclusion.</div> : null}
            {genuineSummary ? (
              <div className="terminal-summary-grid" data-testid="run-summary">
                <div>
                  <h3 className="terminal-column-title">Conclusion</h3>
                  {genuineSummary.sections.some((section) => section.kind === "conclusion")
                    ? <SummarySections summary={genuineSummary} kinds={["conclusion"]} limit={3} />
                    : <p className="run-muted">The terminal summary contains no dedicated conclusion section.</p>}
                </div>
                <div>
                  <h3 className="terminal-column-title">Files and commits</h3>
                  {genuineSummary.sections.some((section) => section.kind === "delivery")
                    ? <SummarySections summary={genuineSummary} kinds={["delivery"]} limit={4} />
                    : <p className="run-muted">Delivery evidence is not recorded in the terminal summary; this does not prove that nothing changed.</p>}
                </div>
                {genuineSummary.sections.some((section) => section.kind === "attention") ? (
                  <div className="terminal-attention"><SummarySections summary={genuineSummary} kinds={["attention"]} limit={3} /></div>
                ) : null}
              </div>
            ) : null}
          </section>

          <aside className="run-terminal-facts" aria-labelledby="terminal-facts-title" data-answers="Q3 Q5">
            <div className="run-section-heading"><div><span className="run-card-label">EXECUTION HISTORY</span><h2 id="terminal-facts-title">Failures and intervention</h2></div></div>
            <dl className="terminal-fact-list">
              <div><dt>Failed attempts</dt><dd data-testid="failed-attempt-count">{failures.failedAttemptsExact ? failures.failedAttempts : `at least ${failures.failedAttempts}`}</dd></div>
              <div><dt>Stages that failed at least once</dt><dd>{failures.stageIds.length > 0 ? failures.stageIds.join(", ") : "none recorded"}</dd></div>
              <div><dt>Final failed stages</dt><dd>{failures.failedStageIds.length > 0 ? failures.failedStageIds.join(", ") : "none recorded"}</dd></div>
              <div><dt>Operator intervention</dt><dd>{needsIntervention ? "Review this non-success outcome." : "No intervention is implied by the successful terminal status."}</dd></div>
            </dl>
            {run.failureReason ? <div className="run-local-alert error" role="alert" data-testid="run-failure-reason">{run.failureReason}</div> : null}
            <RealityGateDiagnostics run={run} />
          </aside>
        </div>
      )}

      {terminalRun ? stageLog : null}

      {genuineSummary ? (
        <details className="run-record-details">
          <summary>Full recorded terminal summary</summary>
          <div className="full-summary-body"><SummarySections summary={genuineSummary} /></div>
        </details>
      ) : progressSummary ? (
        <details className="run-record-details">
          <summary>Recorded progress (not a terminal summary)</summary>
          <pre tabIndex={0} aria-label="Recorded run progress">{progressSummary.raw}</pre>
        </details>
      ) : null}

      <details className="section run-audit-details" data-testid="run-audit-details">
        <summary>Execution history and diagnostics</summary>
        <div className="run-audit-body">
          <section aria-labelledby="attempt-history-title">
            <h2 id="attempt-history-title">Stage attempt history</h2>
            <StageAttemptHistory stages={stages} nowMs={nowMs} />
          </section>
          <section aria-labelledby="execution-structure-title">
            <h2 id="execution-structure-title">Execution structure</h2>
            <div className="stage-nav-layout">
              <StageDAG stages={stages} selectedStageId={selected?.id} onSelect={(stageId) => selectStage(stageId)} />
              <div className="stage-index" aria-label="Stage index">
                {stages.map((stage, index) => (
                  <button className={`stage-index-row ${selected?.id === stage.id ? "active" : ""}`} type="button" key={stage.id} onClick={() => selectStage(stage.id)} aria-label={`Inspect ${stage.id}, status ${stage.status}`}>
                    <span className="stage-ordinal">{index + 1}</span>
                    <span className="stage-index-id">{stage.id}</span>
                    <span className={`outcome-badge ${stageStatusTone(stage.status)}`}>{stage.status}</span>
                  </button>
                ))}
              </div>
            </div>
            {selected ? (
              <div className="audit-stage-meta">
                <div className="sd-meta-row"><span className="k">role</span><span>{selected.role || "unknown"}</span></div>
                <div className="sd-meta-row"><span className="k">gate</span><span>{selected.is_gate ? "yes" : "no"}</span></div>
                <div className="sd-meta-row"><span className="k">depends on</span><span className="mono">{selected.depends_on?.join(", ") || "none"}</span></div>
                <div className="sd-meta-row"><span className="k">retry target</span><span className="mono">{selected.retry_to?.join(", ") || "none"}</span></div>
              </div>
            ) : null}
          </section>
          <section aria-labelledby="recent-activity-title">
            <h2 id="recent-activity-title">Operator-readable activity</h2>
            <ActivityFeed events={run.events ?? []} />
          </section>
        </div>
      </details>
    </div>
  );
}
