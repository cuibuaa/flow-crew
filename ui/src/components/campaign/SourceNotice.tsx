import { Link } from "react-router-dom";
import type { SourceIssue, SourceResult, SourceStatus } from "./types";

function affectedRunCount(issues: SourceIssue[]): number {
  return new Set(issues.flatMap((issue) => issue.affectedRuns.map((run) => run.runId))).size;
}

function defaultSummary(issues: SourceIssue[]): string {
  if (!issues.length) return "No diagnostic details were supplied";
  const affected = affectedRunCount(issues);
  if (issues.length === 1) {
    return `${issues[0].summary}${affected ? ` · ${affected} run${affected === 1 ? "" : "s"} affected` : ""}`;
  }
  return `${issues.length} evidence problems${affected ? ` · ${affected} run${affected === 1 ? "" : "s"} affected` : ""}`;
}

export function IssueNotice({
  status,
  issues,
  label,
  summary,
}: {
  status: Exclude<SourceStatus, "complete">;
  issues: SourceIssue[];
  label: string;
  summary?: string;
}) {
  return (
    <div className={`campaign-source-notice ${status}`} role="alert">
      <div>
        <strong>{status === "partial" ? `${label} incomplete` : `${label} unavailable`}</strong>
        <span>: {summary ?? defaultSummary(issues)}</span>
      </div>
      {issues.length ? (
        <details className="campaign-source-issues">
          <summary>Review affected runs and diagnostics</summary>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.code}:${issue.summary}`}>
                <span>{issue.summary}</span>
                {issue.affectedRuns.length ? (
                  <span className="campaign-issue-runs">
                    {issue.affectedRuns.map((run) => <Link key={run.runId} to={run.href}>{run.shortName}</Link>)}
                  </span>
                ) : null}
                {issue.details?.length ? <ul>{issue.details.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default function SourceNotice({
  source,
  label,
  summary,
}: {
  source: SourceResult<unknown>;
  label: string;
  summary?: string;
}) {
  if (source.status === "complete") return null;
  return <IssueNotice status={source.status} issues={source.issues ?? []} label={label} summary={summary} />;
}
