import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchM3Campaign, fetchM3CampaignBriefDiff, fetchM3CampaignIterations, fetchM3CampaignKGHints, fetchM3CampaignPendingReview, fetchM3CampaignRevisions, fetchM3Campaigns, reviewM3CampaignKGHint, reviewM3CampaignPatch } from "../api";
import type { M3CampaignIteration, M3CampaignRevision, M3CampaignSummary, M3KGSuggestion, M3PendingReview } from "../types";

const REJECTION_REASONS = ["no-op", "unstable_seeds", "stress_crashed", "liquidation_event", "outlier_too_high"];

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function shortSha(value: unknown): string {
  const raw = text(value);
  return raw === "none" ? raw : raw.slice(0, 12);
}

function goalLabel(goal: unknown): string {
  if (!goal || typeof goal !== "object") return "none";
  const data = goal as Record<string, unknown>;
  const metric = data.metric ?? data.name ?? "metric";
  const range = data.validRange ?? data.valid_range ?? data.range;
  return range ? `${text(metric)} ${text(range)}` : text(metric);
}

function patchSummary(value: unknown): string {
  if (!value) return "none";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return text(value);
  const patch = value as Record<string, unknown>;
  const parts = [patch.section, patch.op ?? patch.operation, patch.value ?? patch.summary].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.map(text).join(" ") : text(value);
}

function symptomSummary(hint: M3KGSuggestion): string {
  const metadata = hint.symptomNode.metadata ?? {};
  const counts = metadata.counts && typeof metadata.counts === "object" ? metadata.counts as Record<string, unknown> : {};
  const top = Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])[0];
  return [metadata.kind, top ? `${top[0]}=${top[1]}` : undefined].filter(Boolean).map(text).join(" ");
}

function ruleLabel(iteration: M3CampaignIteration): string {
  const diagnosis = iteration.diagnosis;
  const diagRule = diagnosis && typeof diagnosis === "object" ? (diagnosis as Record<string, unknown>).rule ?? (diagnosis as Record<string, unknown>).rule_fired : undefined;
  return text(iteration.rule_fired ?? iteration.rule ?? diagRule);
}

function outcomeClass(outcome: unknown): string {
  switch (outcome) {
    case "valid_ship": return "border-rc-success bg-rc-success/10 text-rc-success";
    case "invalid_ship": return "border-rc-error bg-rc-error/10 text-rc-error";
    case "ceiling": return "border-rc-warning bg-rc-warning/10 text-rc-warning";
    case "stuck": return "border-rc-muted bg-rc-muted/10 text-rc-text-secondary";
    default: return "border-rc-border bg-rc-card text-rc-text-secondary";
  }
}

function rejectionCount(iteration: M3CampaignIteration, reason: string): number {
  const pools = [iteration.rejections, iteration.rejection_counts, iteration.rejectionCounts];
  for (const pool of pools) {
    if (!pool || typeof pool !== "object") continue;
    const data = pool as Record<string, unknown>;
    const value = data[reason] ?? data[reason.replace("-", "_")];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function versionsFrom(iterations: M3CampaignIteration[], revisions: M3CampaignRevision[]): string[] {
  const found = new Set<string>();
  for (const entry of iterations) {
    const version = entry.brief_version ?? entry.briefVersion;
    if (typeof version === "string") found.add(version);
  }
  for (const revision of revisions) {
    for (const key of ["version", "from_version", "to_version", "from", "to"]) {
      const version = revision[key];
      if (typeof version === "string") found.add(version);
    }
  }
  return Array.from(found).filter((version) => /^v\d+$/.test(version)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function DiffLine({ line }: { line: string }) {
  const cls = line.startsWith("+") && !line.startsWith("+++")
    ? "text-rc-success bg-rc-success/10"
    : line.startsWith("-") && !line.startsWith("---")
      ? "text-rc-error bg-rc-error/10"
      : "text-rc-text-secondary";
  return <div className={`whitespace-pre-wrap px-3 py-0.5 font-mono text-xs ${cls}`}>{line || " "}</div>;
}

function CampaignList() {
  const nav = useNavigate();
  const [campaigns, setCampaigns] = useState<M3CampaignSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchM3Campaigns().then(setCampaigns).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold text-rc-text">Campaigns</h2>
      </div>
      {error && <div className="rounded-card border border-rc-error bg-rc-error/10 p-3 text-sm text-rc-error">{error}</div>}
      <div className="overflow-hidden rounded-card border border-rc-border bg-rc-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-rc-code text-xs uppercase text-rc-muted">
            <tr>
              <th className="px-4 py-3">Campaign id</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Iterations done</th>
              <th className="px-4 py-3">Started at</th>
              <th className="px-4 py-3">Latest outcome</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id} className="cursor-pointer border-t border-rc-border hover:bg-rc-hover" onClick={() => nav(`/campaign/${encodeURIComponent(campaign.id)}`)}>
                <td className="px-4 py-3 font-mono text-rc-text">{campaign.id}</td>
                <td className="px-4 py-3 text-rc-text-secondary">{campaign.status}</td>
                <td className="px-4 py-3 font-mono">{campaign.iterations_done}</td>
                <td className="px-4 py-3 text-rc-text-secondary">{campaign.started_at}</td>
                <td className="px-4 py-3">{campaign.latest_outcome ?? "none"}</td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td className="px-4 py-8 text-center text-rc-muted" colSpan={5}>No campaigns found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CampaignDetail() {
  const { id = "" } = useParams();
  const [summary, setSummary] = useState<M3CampaignSummary | null>(null);
  const [iterations, setIterations] = useState<M3CampaignIteration[]>([]);
  const [revisions, setRevisions] = useState<M3CampaignRevision[]>([]);
  const [diff, setDiff] = useState("");
  const [fromVersion, setFromVersion] = useState("v1");
  const [toVersion, setToVersion] = useState("v2");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "similar" | "pending">("overview");
  const [pendingReview, setPendingReview] = useState<M3PendingReview[]>([]);
  const [kgHints, setKgHints] = useState<M3KGSuggestion[]>([]);

  useEffect(() => {
    if (!id) return;
    Promise.all([fetchM3Campaign(id), fetchM3CampaignIterations(id), fetchM3CampaignRevisions(id)])
      .then(([nextSummary, nextIterations, nextRevisions]) => {
        setSummary(nextSummary);
        setIterations(nextIterations);
        setRevisions(nextRevisions);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  const reloadPendingReview = () => {
    if (!id) return;
    fetchM3CampaignPendingReview(id).then(setPendingReview).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    reloadPendingReview();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    fetchM3CampaignKGHints(id).then(setKgHints).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  const versions = useMemo(() => versionsFrom(iterations, revisions), [iterations, revisions]);

  useEffect(() => {
    if (versions.length > 0) {
      setFromVersion((current) => versions.includes(current) ? current : versions[0]);
      setToVersion((current) => versions.includes(current) ? current : versions[Math.min(1, versions.length - 1)]);
    }
  }, [versions]);

  useEffect(() => {
    if (!id || !fromVersion || !toVersion) return;
    fetchM3CampaignBriefDiff(id, fromVersion, toVersion).then(setDiff).catch((err) => setDiff(`# ${err instanceof Error ? err.message : String(err)}`));
  }, [id, fromVersion, toVersion]);

  const maxRejection = Math.max(1, ...iterations.flatMap((iteration) => REJECTION_REASONS.map((reason) => rejectionCount(iteration, reason))));

  const decidePendingReview = async (index: number, decision: "accept" | "reject") => {
    await reviewM3CampaignPatch(id, index, decision);
    reloadPendingReview();
    fetchM3CampaignRevisions(id).then(setRevisions).catch(() => undefined);
  };

  const sendKGHintToReview = async (index: number) => {
    await reviewM3CampaignKGHint(id, index);
    reloadPendingReview();
    setActiveTab("pending");
  };

  if (error) return <div className="rounded-card border border-rc-error bg-rc-error/10 p-4 text-rc-error">{error}</div>;
  if (!summary) return <div className="text-rc-muted">Loading campaign...</div>;

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h2 className="text-2xl font-semibold text-rc-text">{summary.id}</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-card border border-rc-border bg-rc-card p-3"><div className="text-xs text-rc-muted">Project</div><div className="truncate font-mono text-sm">{summary.projectDir ?? "none"}</div></div>
          <div className="rounded-card border border-rc-border bg-rc-card p-3"><div className="text-xs text-rc-muted">Brief</div><div className="truncate font-mono text-sm">{summary.briefDir ?? "none"}</div></div>
          <div className="rounded-card border border-rc-border bg-rc-card p-3"><div className="text-xs text-rc-muted">Goal</div><div className="truncate text-sm">{goalLabel(summary.goal)}</div></div>
          <div className="rounded-card border border-rc-border bg-rc-card p-3"><div className="text-xs text-rc-muted">Budget</div><div className="truncate font-mono text-sm">{text(summary.budget)}</div></div>
        </div>
      </div>

      <div className="flex gap-2 border-b border-rc-border">
        <button className={`px-3 py-2 text-sm ${activeTab === "overview" ? "border-b-2 border-rc-accent text-rc-text" : "text-rc-muted"}`} onClick={() => setActiveTab("overview")}>Overview</button>
        <button className={`px-3 py-2 text-sm ${activeTab === "similar" ? "border-b-2 border-rc-accent text-rc-text" : "text-rc-muted"}`} onClick={() => setActiveTab("similar")}>Similar Past Campaigns ({kgHints.length})</button>
        <button className={`px-3 py-2 text-sm ${activeTab === "pending" ? "border-b-2 border-rc-accent text-rc-text" : "text-rc-muted"}`} onClick={() => setActiveTab("pending")}>Pending Review ({pendingReview.length})</button>
      </div>

      {activeTab === "pending" ? (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-rc-text">Pending Review</h3>
          <div className="space-y-3">
            {pendingReview.map((entry) => (
              <article key={`${entry.index}-${entry.ts}`} className="rounded-card border border-rc-border bg-rc-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="font-mono text-xs text-rc-muted">#{entry.index} {entry.severity ?? "medium"}</div>
                    <div className="text-sm text-rc-text">{entry.reason}</div>
                    <div className="break-words font-mono text-xs text-rc-text-secondary">{entry.patchSummary ?? patchSummary(entry.patch)}</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button className="rounded-input border border-rc-success px-3 py-1 text-sm text-rc-success hover:bg-rc-success/10" onClick={() => decidePendingReview(entry.index, "accept")}>Accept</button>
                    <button className="rounded-input border border-rc-error px-3 py-1 text-sm text-rc-error hover:bg-rc-error/10" onClick={() => decidePendingReview(entry.index, "reject")}>Reject</button>
                  </div>
                </div>
              </article>
            ))}
            {pendingReview.length === 0 && <div className="rounded-card border border-rc-border bg-rc-card p-4 text-sm text-rc-muted">No pending reviews</div>}
          </div>
        </div>
      ) : activeTab === "similar" ? (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-rc-text">Similar Past Campaigns</h3>
          <div className="space-y-3">
            {kgHints.map((hint, index) => (
              <article key={`${hint.symptomNode.id}-${index}`} className="rounded-card border border-rc-border bg-rc-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <div className="font-mono text-xs text-rc-muted">{hint.symptomNode.campaignId} · {Math.round(hint.similarity * 100)}% · {hint.reason}</div>
                    <div className="text-sm text-rc-text">Outcome: {text(hint.outcomeNode.metadata?.kind)} {hint.outcomeNode.metadata?.result !== undefined ? `(${text(hint.outcomeNode.metadata.result)})` : ""}</div>
                    <div className="text-sm text-rc-text-secondary">Symptom: {symptomSummary(hint) || "none"}</div>
                    <div className="break-words font-mono text-xs text-rc-text-secondary">Patch: {patchSummary(hint.suggestedPatch?.metadata)}</div>
                  </div>
                  {hint.suggestedPatch && (
                    <button className="rounded-input border border-rc-accent px-3 py-1 text-sm text-rc-accent hover:bg-rc-accent/10" onClick={() => sendKGHintToReview(index)}>Apply this patch to current brief</button>
                  )}
                </div>
              </article>
            ))}
            {kgHints.length === 0 && <div className="rounded-card border border-rc-border bg-rc-card p-4 text-sm text-rc-muted">No similar past campaigns</div>}
          </div>
        </div>
      ) : (
      <>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-rc-text">Iteration Timeline</h3>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {iterations.map((iteration, index) => (
            <article key={index} className={`min-w-64 rounded-card border p-4 ${outcomeClass(iteration.outcome)}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">Iteration {text(iteration.iter ?? index + 1)}</span>
                <span className="rounded-input bg-rc-code px-2 py-0.5 text-xs">{text(iteration.outcome)}</span>
              </div>
              <dl className="mt-3 space-y-1 text-xs">
                <div><dt className="inline text-rc-muted">Commit </dt><dd className="inline font-mono">{shortSha(iteration.completing_commit ?? iteration.commit_sha ?? iteration.commit)}</dd></div>
                <div><dt className="inline text-rc-muted">Brief </dt><dd className="inline font-mono">{text(iteration.brief_version ?? iteration.briefVersion)}</dd></div>
                <div><dt className="inline text-rc-muted">Rule </dt><dd className="inline">{ruleLabel(iteration)}</dd></div>
                <div><dt className="inline text-rc-muted">Patch </dt><dd className="inline">{patchSummary(iteration.patch_applied ?? iteration.patch)}</dd></div>
              </dl>
            </article>
          ))}
          {iterations.length === 0 && <div className="rounded-card border border-rc-border bg-rc-card p-4 text-sm text-rc-muted">No iterations logged</div>}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-rc-text">Rejections Heatmap</h3>
        <div className="overflow-auto rounded-card border border-rc-border bg-rc-card">
          <table className="w-full text-center text-xs">
            <thead className="bg-rc-code text-rc-muted">
              <tr><th className="px-3 py-2 text-left">Iteration</th>{REJECTION_REASONS.map((reason) => <th key={reason} className="px-3 py-2">{reason}</th>)}</tr>
            </thead>
            <tbody>
              {iterations.map((iteration, index) => (
                <tr key={index} className="border-t border-rc-border">
                  <td className="px-3 py-2 text-left font-mono">{text(iteration.iter ?? index + 1)}</td>
                  {REJECTION_REASONS.map((reason) => {
                    const count = rejectionCount(iteration, reason);
                    return <td key={reason} className="px-3 py-2"><span className="inline-block min-w-8 rounded-input px-2 py-1" style={{ backgroundColor: `rgba(248, 113, 113, ${0.08 + (count / maxRejection) * 0.55})` }}>{count}</span></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold text-rc-text">Brief Diff</h3>
          <select className="rounded-input border border-rc-border bg-rc-code px-2 py-1 text-sm" value={fromVersion} onChange={(event) => setFromVersion(event.target.value)}>
            {versions.map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
          <span className="text-rc-muted">to</span>
          <select className="rounded-input border border-rc-border bg-rc-code px-2 py-1 text-sm" value={toVersion} onChange={(event) => setToVersion(event.target.value)}>
            {versions.map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
        </div>
        <div className="max-h-96 overflow-auto rounded-card border border-rc-border bg-rc-code py-2">
          {(diff || "No diff available").split("\n").map((line, index) => <DiffLine key={`${index}-${line}`} line={line} />)}
        </div>
      </div>
      </>
      )}
    </section>
  );
}

export default function Campaigns() {
  const { id } = useParams();
  return id ? <CampaignDetail /> : <CampaignList />;
}
