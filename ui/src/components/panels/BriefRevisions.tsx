import type { BriefRevision } from "../../types";

export default function BriefRevisions({ revisions }: { revisions?: BriefRevision[] | null }) {
  if (!revisions || revisions.length === 0) return null;
  return (
    <div className="section" data-testid="panel-brief-revisions" tabIndex={-1}>
      <h2>Brief revisions <span className="h2-hint">{revisions.length} versions</span></h2>
      <div className="revisions-strip">
        {revisions.map((revision, index) => (
          <div className="rev-pair" key={revision.version}>
            {index > 0 ? <div className="rev-arrow" data-testid="revision-arrow">→</div> : null}
            <div className={`rev-node ${revision.shipped ? "shipped" : ""}`}>
              <div className="ver">{revision.version}{revision.shipped ? " shipped" : ""}</div>
              <div className="reason">{revision.reason}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
