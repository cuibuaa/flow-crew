import type { WorkspacePhase } from "../../types";

/** Compact result display: keep small magnitudes at 2 decimals, larger ones at 1. */
function formatResult(value: number): string {
  return Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
}

export default function Phases({ phases, onCommitClick }: { phases?: WorkspacePhase[] | null; onCommitClick?: (commit: string) => void }) {
  const safePhases = (phases ?? []).filter((phase) => phase?.name);
  if (safePhases.length === 0) return null;
  const max = Math.max(...safePhases.map((p) => p.elapsed_min ?? 0), 1);
  return (
    <div className="section" data-testid="panel-phases">
      <h2>Phases <span className="h2-hint">{safePhases.length} attempts · direction → result · commits clickable</span></h2>
      <div className="trend-chart">
        {safePhases.map((phase, index) => {
          const verdict = phase.status === "complete" ? "shipped" : phase.status === "in_progress" ? "interim" : "unstable";
          const commits = (phase.commit_chain?.length ? phase.commit_chain : phase.commit ? [phase.commit] : []) ?? [];
          // Lead with the research direction (round label) when we have it; fall back to the seq name.
          const heading = phase.direction ?? phase.name;
          return (
            <div className="trend-row" key={`${phase.name}-${index}`}>
              <span className="label" title={phase.direction ? `${phase.direction} (${phase.name})` : phase.name}>
                {heading}
                {phase.direction ? <span className="phase-seq"> · {phase.name}</span> : null}
              </span>
              <div className="bar-container">
                <div className={`bar ${verdict}`} style={{ width: `${Math.max(2, ((phase.elapsed_min ?? 0) / max) * 100).toFixed(1)}%` }}>
                  <span className="bar-value">
                    {phase.result != null ? <strong className="phase-result">{formatResult(phase.result)}</strong> : null}
                    {phase.result != null ? " · " : ""}{phase.elapsed_min ?? "?"}m · att {phase.attempt ?? "?"}
                  </span>
                </div>
              </div>
              <span className={`verdict ${verdict}`} title={phase.notes ?? phase.status ?? undefined}>
                {commits.length ? commits.map((commit) => (
                  <button className="commit-pill" data-testid="commit-pill" key={commit} type="button" onClick={() => onCommitClick?.(commit)} title={commit}>{commit.split(" ")[0].slice(0, 7)}</button>
                )) : phase.status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
