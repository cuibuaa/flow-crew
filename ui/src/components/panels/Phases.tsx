import type { WorkspacePhase } from "../../types";

export default function Phases({ phases, onCommitClick }: { phases?: WorkspacePhase[] | null; onCommitClick?: (commit: string) => void }) {
  const safePhases = (phases ?? []).filter((phase) => phase?.name);
  if (safePhases.length === 0) return null;
  const max = Math.max(...safePhases.map((p) => p.elapsed_min ?? 0), 1);
  return (
    <div className="section" data-testid="panel-phases">
      <h2>Phases <span className="h2-hint">{safePhases.length} phases · each row's commits clickable</span></h2>
      <div className="trend-chart">
        {safePhases.map((phase) => {
          const verdict = phase.status === "complete" ? "shipped" : phase.status === "in_progress" ? "interim" : "unstable";
          const commits = (phase.commit_chain?.length ? phase.commit_chain : phase.commit ? [phase.commit] : []) ?? [];
          return (
            <div className="trend-row" key={phase.name}>
              <span className="label">{phase.name}</span>
              <div className="bar-container">
                <div className={`bar ${verdict}`} style={{ width: `${Math.max(2, ((phase.elapsed_min ?? 0) / max) * 100).toFixed(1)}%` }}>
                  <span className="bar-value">{phase.elapsed_min ?? "?"}m · att {phase.attempt ?? "?"}</span>
                </div>
              </div>
              <span className={`verdict ${verdict}`}>
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
