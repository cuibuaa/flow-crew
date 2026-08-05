import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchOlderCampaignRuns } from "./client";
import { formatDuration, formatTokens, statusClass } from "./format";
import { BriefHistoryDisclosure, ResearchKnowledgeSummary } from "./LazyEvidence";
import RunTitleDisclosure from "./RunTitleDisclosure";
import SourceNotice, { IssueNotice } from "./SourceNotice";
import type {
  CampaignAttentionItem,
  CampaignOperatorView,
  CampaignRunPage,
  EngineeringNarrative,
  ResearchMetricGroup,
  ResearchNarrative,
  SourceResult,
} from "./types";

type LoadOlder = (id: string, cursor: string) => Promise<SourceResult<CampaignRunPage>>;
const CONCLUSION_PREVIEW_LENGTH = 180;

function Status({ value, explanation }: { value: string; explanation?: string | null }) {
  return <span className={`campaign-canonical-status ${statusClass(value)}`} title={explanation ?? undefined}>{value}</span>;
}

function ErrorOrEmpty({ unavailable, empty }: { unavailable: boolean; empty: string }) {
  return <p className="campaign-plain-answer">{unavailable ? "Unable to determine" : empty}</p>;
}

function previewText(value: string): string {
  if (value.length <= CONCLUSION_PREVIEW_LENGTH) return value;
  const prefix = value.slice(0, CONCLUSION_PREVIEW_LENGTH + 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > CONCLUSION_PREVIEW_LENGTH * 0.7 ? boundary : CONCLUSION_PREVIEW_LENGTH).trimEnd()}…`;
}

function RunConclusion({ value }: { value: string }) {
  if (value.length <= CONCLUSION_PREVIEW_LENGTH) return <p className="campaign-run-conclusion">{value}</p>;
  return (
    <details className="campaign-run-conclusion campaign-run-conclusion-details">
      <summary>{previewText(value)}</summary>
      <p>{value}</p>
    </details>
  );
}

function simulationSource(source: string | undefined): boolean {
  return Boolean(source && /(?:^|[:/_.-])(?:mock|test|fixture|simulation|simulated)(?:$|[:/_.-])/iu.test(source));
}

function AttentionItem({ item, expanded = false }: { item: CampaignAttentionItem; expanded?: boolean }) {
  const simulated = item.simulated ?? simulationSource(item.source);
  return (
    <article>
      <strong>{item.title}</strong>
      <span>{item.reason}</span>
      {item.kind === "brief_review" ? (
        <span className="campaign-attention-source">
          Source: {item.source ?? "not recorded"}
          {simulated ? <em className="campaign-simulation-badge">Simulation/test source</em> : null}
        </span>
      ) : null}
      <Link to={item.href}>{!expanded && (item.kind === "approval" || item.kind === "brief_review") ? "Open in Inbox" : "Open"}</Link>
    </article>
  );
}

function metricLabel(metric: string): string {
  const words = metric
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bpct\b/g, "percent")
    .replace(/\bms\b/g, "milliseconds");
  return words ? words[0].toUpperCase() + words.slice(1) : "Campaign measurement";
}

function ResearchGroup({ group }: { group: ResearchMetricGroup }) {
  const label = metricLabel(group.metric);
  const values = group.points.map((point, index) => `Measurement ${index + 1}: ${point.value}`);
  const bestIndex = group.best
    ? group.points.findIndex((point) => point.round === group.best?.round && point.value === group.best?.value)
    : -1;
  return (
    <div className="campaign-research-group">
      <div className="campaign-evidence-heading"><strong>{label}</strong><span>{group.points.length} accepted measurement{group.points.length === 1 ? "" : "s"}</span></div>
      {group.hasTrend ? (
        <div className="campaign-research-trend" aria-label={`${label} accepted measurement trend`}>{values.join(" → ")}</div>
      ) : (
        <div className="campaign-research-no-trend">{values.join(" · ")} · Not enough comparable measurements to establish a trend</div>
      )}
      {group.best ? <div className="campaign-research-best">Best measurement{bestIndex >= 0 ? ` (${bestIndex + 1})` : ""}: {group.best.value}</div> : null}
      {group.hasTrend && !group.best ? <div className="campaign-research-no-best">Direction evidence is insufficient to name a best result</div> : null}
    </div>
  );
}

function ResearchPanel({ campaignId, source }: { campaignId: string; source: SourceResult<ResearchNarrative | null> }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div className="campaign-conclusion-panel" data-testid="research-conclusion">
      <h3>Research measurements</h3>
      <SourceNotice source={source} label="Research evidence" />
      {source.value?.latestCanonicalStatus ? (
        <div className="campaign-delivery-status"><span>Latest canonical outcome</span><Status value={source.value.latestCanonicalStatus} /></div>
      ) : null}
      {source.value?.selected ? <ResearchGroup group={source.value.selected} /> : <ErrorOrEmpty unavailable={source.status === "unavailable"} empty="No accepted measurement evidence" />}
      {source.value ? (
        <details className="campaign-evidence-details" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>Research evidence details</summary>
          {source.value.otherMetrics.map((group) => <ResearchGroup group={group} key={group.metricKey} />)}
          {source.value.confirmNotes.map((note) => <p className="campaign-negative-note" key={note}>{note}</p>)}
          <ResearchKnowledgeSummary campaignId={campaignId} active={detailsOpen} />
        </details>
      ) : null}
    </div>
  );
}

function EngineeringPanel({ source }: { source: SourceResult<EngineeringNarrative | null> }) {
  const latest = source.value?.latest;
  return (
    <div className="campaign-conclusion-panel" data-testid="engineering-conclusion">
      <h3>Latest engineering run</h3>
      <SourceNotice source={source} label="Engineering evidence" />
      {latest ? (
        <>
          <div className="campaign-delivery-status">
            <RunTitleDisclosure shortName={latest.shortName} fullTitle={latest.fullTitle} />
            <Status value={latest.status} explanation={latest.statusExplanation} />
          </div>
          <RunConclusion value={latest.conclusion} />
          <details className="campaign-evidence-details">
            <summary>Execution evidence</summary>
            {latest.commits.length ? <p>Commits: {latest.commits.join(" · ")}</p> : <p>No structured commit record</p>}
            {latest.filesChanged.length ? <p>Changed files: {latest.filesChanged.join(" · ")}</p> : null}
            {latest.gates.length ? <ul>{latest.gates.map((gate) => <li key={gate}>{gate}</li>)}</ul> : <p>No gate evidence to display</p>}
            <Link to={latest.href}>Open the complete run details for {latest.shortName}</Link>
          </details>
        </>
      ) : <ErrorOrEmpty unavailable={source.status === "unavailable"} empty="No terminal engineering run yet" />}
    </div>
  );
}

function Conclusions({ view }: { view: CampaignOperatorView }) {
  const kind = view.identity.classification.kind;
  const recent = view.runs.value.items[0];
  const hasConcern = view.identity.classification.status === "partial"
    || [view.research.status, view.engineering.status].some((status) => status !== "complete")
    || [view.research.value?.latestCanonicalStatus, view.engineering.value?.latest?.status]
      .some((status) => status && !["complete", "shipped", "ceiling_hit"].includes(status));
  return (
    <section className="campaign-decision-region campaign-conclusions" aria-labelledby="campaign-conclusions-title" data-answers={hasConcern ? "Q3 Q5" : "Q3"}>
      <div className="campaign-region-heading">
        <div><h2 id="campaign-conclusions-title">Latest campaign outcome</h2></div>
        {kind === "mixed" || kind === "unknown" || view.identity.classification.status === "partial"
          ? <span className="campaign-classification">{kind}{view.identity.classification.status === "partial" ? " · partial" : ""}</span>
          : null}
      </div>
      {view.identity.classification.status === "partial" ? (
        <IssueNotice
          status="partial"
          issues={view.identity.classification.issues}
          label="Campaign classification evidence"
        />
      ) : null}
      {kind === "unknown" ? (
        <div className="campaign-unknown-conclusion">
          <strong>Not enough evidence to classify this campaign</strong>
          <span>{view.identity.classification.reasons.join("; ")}</span>
          {recent ? <><Status value={recent.status} explanation={recent.statusExplanation} /><RunConclusion value={recent.conclusion} /></> : null}
        </div>
      ) : null}
      <div className={`campaign-conclusion-layout ${kind}`}>
        {(kind === "research" || kind === "mixed") ? <ResearchPanel campaignId={view.identity.id} source={view.research} /> : null}
        {(kind === "engineering" || kind === "mixed") ? <EngineeringPanel source={view.engineering} /> : null}
        {kind === "unknown" && view.research.value ? <ResearchPanel campaignId={view.identity.id} source={view.research} /> : null}
        {kind === "unknown" && view.engineering.value ? <EngineeringPanel source={view.engineering} /> : null}
      </div>
    </section>
  );
}

function RunLedger({
  campaignId,
  initial,
  loadOlder,
}: {
  campaignId: string;
  initial: SourceResult<CampaignRunPage>;
  loadOlder: LoadOlder;
}) {
  const [ledger, setLedger] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const campaignRef = useRef(campaignId);
  const paginationWasUsed = ledger.value.items.length > initial.value.items.length;

  useEffect(() => {
    if (campaignRef.current !== campaignId) {
      campaignRef.current = campaignId;
      setLedger(initial);
      return;
    }
    setLedger((current) => {
      const existing = new Map(current.value.items.map((row) => [row.runId, row]));
      for (const row of initial.value.items) existing.set(row.runId, row);
      return {
        ...initial,
        value: {
          ...initial.value,
          items: [...existing.values()],
          shown: existing.size,
          nextCursor: current.value.items.length > initial.value.items.length ? current.value.nextCursor : initial.value.nextCursor,
          truncated: current.value.items.length > initial.value.items.length ? current.value.truncated : initial.value.truncated,
        },
      };
    });
  }, [campaignId, initial]);

  const loadMore = async () => {
    const cursor = ledger.value.nextCursor;
    if (!cursor || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await loadOlder(campaignId, cursor);
      setLedger((current) => {
        const rows = new Map(current.value.items.map((row) => [row.runId, row]));
        for (const row of next.value.items) rows.set(row.runId, row);
        const issues = new Map(
          [...(current.issues ?? []), ...(next.issues ?? [])]
            .map((issue) => [`${issue.code}\u0000${issue.summary}`, issue]),
        );
        return {
          status: current.status === "complete" ? next.status : current.status,
          ...(issues.size ? { issues: [...issues.values()] } : {}),
          coverage: next.coverage,
          value: { ...next.value, items: [...rows.values()], shown: rows.size },
        };
      });
      setAnnouncement(`Loaded ${next.value.items.length} older runs`);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="campaign-decision-region campaign-ledger" aria-labelledby="campaign-ledger-title" data-answers="Q2 Q3 Q5">
      <div className="campaign-region-heading">
        <div><h2 id="campaign-ledger-title">Run history</h2></div>
        <span className="campaign-coverage">Showing {ledger.value.items.length}/{ledger.value.total}</span>
      </div>
      <SourceNotice source={ledger} label="Run history" />
      {!ledger.value.items.length ? <ErrorOrEmpty unavailable={ledger.status === "unavailable"} empty="No run records yet" /> : (
        <div className="campaign-run-list" role="list">
          {ledger.value.items.map((run) => (
            <article className={`campaign-run-row ${run.zeroWork ? "zero-work" : ""}`} key={run.runId} role="listitem">
              <RunTitleDisclosure shortName={run.shortName} fullTitle={run.fullTitle} />
              <Status value={run.status} explanation={run.statusExplanation} />
              <RunConclusion value={run.conclusion} />
              <span className="campaign-run-duration">{formatDuration(run.durationMs, run.durationPartial)}</span>
              {run.commits.length ? <span className="campaign-run-commit" title={run.commits.join(" · ")}>commit {run.commits[0].slice(0, 10)}</span> : null}
              {run.zeroWork ? <details className="campaign-zero-work"><summary>No delivery evidence</summary><span>{run.zeroWorkReason}</span></details> : null}
              <Link className="campaign-run-open" to={run.href} aria-label={`Open run details for ${run.fullTitle}`}>Details →</Link>
            </article>
          ))}
        </div>
      )}
      {loadError ? <p className="campaign-source-notice unavailable" role="alert">Older runs failed to load: {loadError}</p> : null}
      {ledger.value.nextCursor || paginationWasUsed ? (
        <button
          className="campaign-load-more"
          type="button"
          aria-disabled={loading || !ledger.value.nextCursor}
          aria-busy={loading}
          onClick={() => void loadMore()}
        >
          {loading ? "Loading…" : ledger.value.nextCursor ? "Load older runs" : "All runs loaded"}
        </button>
      ) : null}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </section>
  );
}

function costEvidenceSummary(view: CampaignOperatorView): string {
  const cost = view.cost.value;
  const total = cost.runCoverage.total;
  if (!total) return "No run cost telemetry was available";
  const incomplete = cost.runCoverage.failed;
  // Older in-memory callers may not have the split coverages yet. Network
  // responses still go through the strict client contract; this fallback only
  // keeps the presentation truthful for those already-loaded views.
  const wallCoverage = cost.wallCoverage ?? cost.runCoverage;
  const tokenCoverage = cost.tokenCoverage ?? cost.runCoverage;
  const causes = [
    wallCoverage.failed
      ? `wall-clock timing is incomplete for ${wallCoverage.failed} run${wallCoverage.failed === 1 ? "" : "s"}`
      : "",
    tokenCoverage.failed
      ? `token or attempt telemetry is incomplete for ${tokenCoverage.failed} run${tokenCoverage.failed === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean).join("; ");
  return `${incomplete} of ${total} runs have incomplete cost evidence${causes ? `: ${causes}` : ""}. Affected totals are lower bounds.`;
}

function campaignTypeExplanation(kind: CampaignOperatorView["identity"]["classification"]["kind"]): string {
  switch (kind) {
    case "engineering": return "Implementation work is evaluated through run outcomes and execution evidence; research measurements are not required.";
    case "research": return "Accepted measurements are used to compare research outcomes.";
    case "mixed": return "This campaign contains both implementation outcomes and accepted research measurements.";
    case "unknown": return "The available records are not sufficient to determine the campaign type.";
  }
}

function CampaignMetadata({ view }: { view: CampaignOperatorView }) {
  const kind = view.identity.classification.kind;
  return (
    <details className="campaign-metadata">
      <summary>Campaign metadata</summary>
      <dl>
        <div><dt>ID</dt><dd><code>{view.identity.id}</code></dd></div>
        <div><dt>Earliest start</dt><dd>{view.identity.startedAt ?? "unknown"} ({view.identity.startedAtSource})</dd></div>
        <div><dt>Campaign type</dt><dd><strong>{kind}</strong> · {campaignTypeExplanation(kind)}</dd></div>
      </dl>
    </details>
  );
}

export default function CampaignPage({
  view,
  refreshError,
  loadOlder = fetchOlderCampaignRuns,
}: {
  view: CampaignOperatorView;
  refreshError?: string | null;
  loadOlder?: LoadOlder;
}) {
  const attention = view.attention.value;
  const activity = view.activity.value;
  const costAnswers = view.cost.status === "complete" ? "Q4" : "Q4 Q5";
  const wallCostCoverage = view.cost.value.wallCoverage ?? view.cost.value.runCoverage;
  const tokenCostCoverage = view.cost.value.tokenCoverage ?? view.cost.value.runCoverage;
  return (
    <article className="campaign-operator-page" data-testid="campaign-operator-page">
      <header className="campaign-page-heading">
        <div>
          <div className="eyebrow">CAMPAIGN</div>
          <h1>{view.identity.name}</h1>
          <BriefHistoryDisclosure campaignId={view.identity.id} />
        </div>
        {refreshError ? <p className="campaign-refresh-error" role="alert">Refresh failed. Showing data generated at {new Date(view.generatedAt).toLocaleTimeString()}: {refreshError}</p> : null}
      </header>

      <section className="campaign-decision-region campaign-cost" aria-labelledby="campaign-cost-title" data-answers={costAnswers}>
        <div className="campaign-region-heading compact">
          <div><h2 id="campaign-cost-title">Campaign cost</h2></div>
          <div className="campaign-cost-answer">
            {view.cost.status === "unavailable" ? "Cost totals unavailable" : <>
              <strong>{wallCostCoverage.failed
                ? `At least ${formatDuration(view.cost.value.wallMs)} of run wall-clock time`
                : `Total run wall-clock time ${formatDuration(view.cost.value.wallMs)}`}</strong>
              <span>{tokenCostCoverage.failed
                ? `At least ${formatTokens(view.cost.value.tokens)} total tokens (including supervisor)`
                : `Total tokens ${formatTokens(view.cost.value.tokens)} (including supervisor)`}</span>
            </>}
          </div>
        </div>
        <SourceNotice source={view.cost} label="Cost evidence" summary={costEvidenceSummary(view)} />
      </section>

      <section className="campaign-decision-region campaign-attention" aria-labelledby="campaign-attention-title" data-answers="Q1 Q5">
        <div className="campaign-region-heading"><div><h2 id="campaign-attention-title">Attention required</h2></div>{attention.total ? <span className="campaign-count">{attention.total}</span> : null}</div>
        <SourceNotice source={view.attention} label="Campaign attention list" />
        {view.attention.status === "complete" && attention.total === 0 ? <p className="campaign-plain-answer">Nothing needs your attention</p> : null}
        {attention.items.length ? (
          <div className="campaign-attention-list">
            {attention.items.slice(0, attention.shown).map((item) => <AttentionItem item={item} key={item.id} />)}
            {attention.items.length > attention.shown ? <details><summary>Show {attention.items.length - attention.shown} more</summary>{attention.items.slice(attention.shown).map((item) => <AttentionItem item={item} key={item.id} expanded />)}</details> : null}
          </div>
        ) : null}
      </section>

      <section className="campaign-decision-region campaign-activity" aria-labelledby="campaign-activity-title" data-answers="Q2 Q5">
        <div className="campaign-region-heading"><div><h2 id="campaign-activity-title">Current run activity</h2></div>{activity.total ? <span className="campaign-count">{activity.total}</span> : null}</div>
        <SourceNotice source={view.activity} label="Current run activity" />
        {view.activity.status === "complete" && activity.total === 0 ? <p className="campaign-plain-answer">No run is executing or waiting</p> : null}
        {activity.items.length ? <div className="campaign-activity-list">
          {activity.items.slice(0, activity.shown).map((item) => <article key={item.runId}><RunTitleDisclosure shortName={item.shortName} fullTitle={item.fullTitle} /><Status value={item.status} explanation={item.statusExplanation} /><span>{formatDuration(item.durationMs, item.durationPartial)}</span><span className={item.anomaly ? "campaign-anomaly" : "campaign-worker"}>{item.anomaly ?? (item.worker === "live" ? "worker verified" : item.statusExplanation)}</span><Link to={item.href}>Details →</Link></article>)}
          {activity.items.length > activity.shown ? <details><summary>Show {activity.items.length - activity.shown} more runs</summary>{activity.items.slice(activity.shown).map((item) => <article key={item.runId}><RunTitleDisclosure shortName={item.shortName} fullTitle={item.fullTitle} /><Status value={item.status} explanation={item.statusExplanation} /><span>{formatDuration(item.durationMs, item.durationPartial)}</span><span className={item.anomaly ? "campaign-anomaly" : "campaign-worker"}>{item.anomaly ?? (item.worker === "live" ? "worker verified" : item.statusExplanation)}</span><Link to={item.href}>Details →</Link></article>)}</details> : null}
        </div> : null}
      </section>

      <Conclusions view={view} />
      <RunLedger campaignId={view.identity.id} initial={view.runs} loadOlder={loadOlder} />
      <CampaignMetadata view={view} />
    </article>
  );
}
