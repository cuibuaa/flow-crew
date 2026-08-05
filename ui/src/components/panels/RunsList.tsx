import { formatMetric } from "../../lib/metric-format";
import type { MetricFormat, WorkspaceRun } from "../../types";

const iconByOutcome: Record<string, string> = { shipped: "✓", rejected: "✘", failed: "✘", running: "◐", parked: "◆", complete: "✓", reality_gate_failed: "⊘", needs_summary: "…", awaiting_approval: "?", ceiling_hit: "⊟", escalated: "↑" };
const iconClassByOutcome: Record<string, string> = { shipped: "success", rejected: "error", failed: "error", running: "running", parked: "parked", complete: "success", reality_gate_failed: "error" };
const badgeClassByOutcome: Record<string, string> = { failed: "rejected" };
const badgeLabelByOutcome: Record<string, string> = { reality_gate_failed: "GATE FAIL", needs_summary: "NEEDS SUM", awaiting_approval: "AWAITING", parked: "WAITING", ceiling_hit: "CEILING", escalated: "ESCALATED" };

function runStartedAt(run: WorkspaceRun): number {
  const value = run.started_at ?? run.startedAt;
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

export default function RunsList({ runs, metricFormat = "raw", onRunClick }: { runs?: WorkspaceRun[]; metricFormat?: MetricFormat; onRunClick?: (run: WorkspaceRun) => void }) {
  const safeRuns = (runs ?? [])
    .filter((run) => run?.id)
    .map((run, index) => ({ run, index }))
    .sort((left, right) => {
      const startedDelta = runStartedAt(right.run) - runStartedAt(left.run);
      return startedDelta === 0 ? left.index - right.index : startedDelta;
    })
    .map(({ run }) => run);
  return (
    <div className="section" data-testid="panel-runs">
      <h2>Runs <span className="h2-hint">recent</span></h2>
      {safeRuns.length === 0 ? <div className="empty-state" data-testid="runs-empty">No recorded run rows yet. Imported campaign phases may still appear above.</div> : (
        <div className="runs-table">
          {safeRuns.map((run) => {
            const outcome = run.outcome ?? "idle";
            return (
              <button className="run-row" key={run.full_id ?? run.id} type="button" onClick={() => onRunClick?.(run)} data-testid="run-row">
                <span className={`icon ${iconClassByOutcome[outcome] ?? ""}`}>{iconByOutcome[outcome] ?? "·"}</span>
                <span className="id">{run.id}{run.hasSummary ? <span className="run-summary-flag" title="Run summary available" aria-label="has summary" style={{ marginLeft: 6, opacity: 0.7 }}>📄</span> : null}</span>
                <span className="run-iter">{run.iter ?? ""}</span>
                <span className="metric">{run.metric != null ? formatMetric(metricFormat, run.metric) : "—"}</span>
                <span className="run-summary">{run.summary ?? ""}</span>
                <span className="duration">{run.duration ?? ""}</span>
                <span className={`outcome-badge ${badgeClassByOutcome[outcome] ?? outcome}`} title={outcome.toUpperCase()}>{badgeLabelByOutcome[outcome] ?? outcome.toUpperCase()}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
