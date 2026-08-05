import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BriefAdmissionRequestError,
  cancelTask,
  fetchCampaignBriefDiff,
  fetchInboxOverview,
  resolveInboxItem,
  reviewCampaignPatch,
} from "../api";
import type {
  BriefAdmissionSubmission,
  BriefPreflightResponse,
  DeferredInboxItem,
  InboxDecision,
  InboxItem,
  InboxOverview,
  InboxPatchItem,
  InboxSource,
  InboxSourceCoverage,
  InboxStaleItem,
} from "../types";
import { BriefPreflightPanel } from "./NewRunModal";
import { showToast } from "./Toast";

const POLL_MS = 15_000;
const SOURCE_KEYS = ["approvals", "deferred", "stale", "patches"] as const;

type InboxSourceKey = typeof SOURCE_KEYS[number];

interface DiffView {
  loading?: boolean;
  text?: string;
  error?: string;
}

interface ResolutionNotice {
  key: string;
  title: string;
  message: string;
}

interface BriefAdmissionReview {
  preflight: BriefPreflightResponse;
  acknowledged: boolean;
  decision: InboxDecision;
  always: boolean;
}

const SOURCE_LABELS: Record<InboxSourceKey, string> = {
  approvals: "Pending approvals",
  deferred: "Deferred tasks",
  stale: "Stale run alerts",
  patches: "Brief patches",
};

function waitingTime(createdAt: string): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - created) / 60_000));
  if (minutes < 1) return "less than 1 minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function decisionLabel(decision: InboxDecision): string {
  return decision === "approve" ? "approved" : "denied";
}

function retryLabel(notBefore?: string | null): string {
  if (!notBefore) return "The daemon will retry when the blocking condition clears";
  const value = Date.parse(notBefore);
  return Number.isFinite(value) ? new Date(value).toLocaleString() : notBefore;
}

function patchKey(item: Pick<InboxPatchItem, "campaignId" | "index">): string {
  return `${item.campaignId}:${item.index}`;
}

function patchPreview(item: InboxPatchItem): string {
  const value = item.patch.value.split("\n").map((line) => `+ ${line}`).join("\n");
  return [
    `--- ${item.briefVersion ?? "current brief"}`,
    "+++ proposed patch",
    `@@ ${item.patch.section} · ${item.patch.op} @@`,
    value,
  ].join("\n");
}

function simulationSource(source: string | undefined): boolean {
  return Boolean(source && /(?:^|[:/_.-])(?:mock|test|fixture|simulation|simulated)(?:$|[:/_.-])/iu.test(source));
}

function diffVersions(item: InboxPatchItem): { from: string; to: string } | null {
  const from = item.fromVersion ?? item.from_version ?? item.briefVersion;
  const explicitTo = item.toVersion ?? item.to_version;
  const to = explicitTo ?? (item.latestVersion && item.latestVersion !== from ? item.latestVersion : undefined);
  return from && to && from !== to ? { from, to } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEnumString<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isCoverage(value: unknown): value is InboxSourceCoverage {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.succeeded) && isNonNegativeInteger(value.failed);
}

function isInboxResolution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.decision === "approve" || value.decision === "deny")
    && isNonEmptyString(value.by)
    && isNonEmptyString(value.at)
    && isOptionalString(value.reason)
    && (value.always === undefined || typeof value.always === "boolean");
}

function isInboxItem(value: unknown): value is InboxItem {
  if (!isRecord(value) || !isRecord(value.standingRuleEligible)) return false;
  const standingRule = value.standingRuleEligible;
  return isNonEmptyString(value.runId)
    && isNonEmptyString(value.projectDir)
    && isNonEmptyString(value.requestId)
    && isNonEmptyString(value.action)
    && isOptionalString(value.target)
    && isEnumString(value.risk, ["external", "exec", "write", "unknown"] as const)
    && isNonEmptyString(value.title)
    && isOptionalString(value.body)
    && isNonEmptyString(value.createdAt)
    && (value.atIteration === undefined || isNonNegativeInteger(value.atIteration))
    && isOptionalString(value.stageId)
    && isEnumString(value.state, ["pending", "approved", "denied"] as const)
    && (value.resolution === undefined || isInboxResolution(value.resolution))
    && typeof standingRule.ok === "boolean"
    && isOptionalString(standingRule.reason)
    && isOptionalString(value.campaignId)
    && isOptionalString(value.campaignName);
}

function isDeferredItem(value: unknown): value is DeferredInboxItem {
  if (!isRecord(value)) return false;
  const validId = isNonEmptyString(value.id)
    || (typeof value.id === "number" && Number.isInteger(value.id) && value.id >= 0);
  return validId
    && isOptionalString(value.name)
    && isNonEmptyString(value.projectDir)
    && (value.runId === undefined || value.runId === null || isNonEmptyString(value.runId))
    && value.status === "deferred"
    && isNonEmptyString(value.deferReason)
    && (value.notBefore === undefined || value.notBefore === null || typeof value.notBefore === "string");
}

function isStaleItem(value: unknown): value is InboxStaleItem {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && value.status === "stale"
    && isOptionalString(value.staleRunId);
}

function isPatchItem(value: unknown): value is InboxPatchItem {
  if (!isRecord(value) || !isRecord(value.patch)) return false;
  const patch = value.patch;
  return isNonNegativeInteger(value.index)
    && isNonEmptyString(value.ts)
    && isNonEmptyString(value.campaignId)
    && isNonEmptyString(value.campaignName)
    && isNonEmptyString(value.reason)
    && (value.severity === undefined || isEnumString(value.severity, ["low", "medium", "high"] as const))
    && patch.type === "brief_patch"
    && isNonEmptyString(patch.section)
    && isEnumString(patch.op, ["append", "replace_value", "edit"] as const)
    && typeof patch.value === "string"
    && isNonEmptyString(value.patchSummary)
    && isOptionalString(value.source)
    && isOptionalString(value.briefVersion)
    && isOptionalString(value.fromVersion)
    && isOptionalString(value.toVersion)
    && isOptionalString(value.from_version)
    && isOptionalString(value.to_version)
    && isOptionalString(value.latestVersion)
    && isOptionalString(value.runId);
}

function isInboxSource<T>(value: unknown, isItem: (item: unknown) => item is T): value is InboxSource<T> {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isItem)) return false;
  const coverage = value.coverage;
  if (value.status === "complete") {
    return value.error === undefined
      && (coverage === undefined || (isCoverage(coverage) && coverage.failed === 0));
  }
  if (value.status === "partial") {
    return isNonEmptyString(value.error)
      && isCoverage(coverage)
      && coverage.succeeded > 0
      && coverage.failed > 0;
  }
  if (value.status === "unavailable") {
    return value.items.length === 0
      && isNonEmptyString(value.error)
      && (coverage === undefined || (isCoverage(coverage) && coverage.succeeded === 0 && coverage.failed > 0));
  }
  return false;
}

function isInboxOverview(value: unknown): value is InboxOverview {
  if (!isRecord(value)) return false;
  return isInboxSource(value.approvals, isInboxItem)
    && isInboxSource(value.deferred, isDeferredItem)
    && isInboxSource(value.stale, isStaleItem)
    && isInboxSource(value.patches, isPatchItem)
    && (value.campaignCount === null || isNonNegativeInteger(value.campaignCount));
}

function overviewTotal(overview: InboxOverview): number {
  return SOURCE_KEYS.reduce((total, key) => total + overview[key].items.length, 0);
}

function focusAfterMutation(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(
      "[data-inbox-item] button:not(:disabled), [data-inbox-item] a, [data-testid='inbox-empty']",
    )?.focus();
  });
}

export default function Inbox({
  loadOverview = fetchInboxOverview,
  loadBriefDiff = fetchCampaignBriefDiff,
  resolveItem = resolveInboxItem,
  reviewPatch = reviewCampaignPatch,
  markRunFailed = cancelTask,
}: {
  loadOverview?: typeof fetchInboxOverview;
  loadBriefDiff?: typeof fetchCampaignBriefDiff;
  resolveItem?: typeof resolveInboxItem;
  reviewPatch?: typeof reviewCampaignPatch;
  markRunFailed?: typeof cancelTask;
}) {
  const [overview, setOverview] = useState<InboxOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [briefAdmissionReviews, setBriefAdmissionReviews] = useState<Record<string, BriefAdmissionReview>>({});
  const [resolutionNotices, setResolutionNotices] = useState<ResolutionNotice[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffView>>({});
  const mounted = useRef(false);
  const trustedOverview = useRef<InboxOverview | null>(null);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async (showLoading = false): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    if (showLoading && !trustedOverview.current) setLoading(true);
    try {
      const next = await loadOverview();
      if (!isInboxOverview(next)) throw new Error("invalid inbox overview response");
      if (!mounted.current || sequence !== refreshSequence.current) return false;
      trustedOverview.current = next;
      setOverview(next);
      setPageError(null);
      setRefreshError(null);
      setLastSuccessAt(new Date());
      return true;
    } catch (error) {
      if (!mounted.current || sequence !== refreshSequence.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (trustedOverview.current) {
        setRefreshError(message);
      } else {
        setPageError(message);
        showToast(`Inbox failed to load: ${message}`);
      }
      return false;
    } finally {
      if (mounted.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, [loadOverview]);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const setItemError = (key: string, message?: string) => {
    setItemErrors((current) => {
      const next = { ...current };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  };

  const resolveApproval = async (
    item: InboxItem,
    decision: InboxDecision,
    always = false,
    admission?: BriefAdmissionSubmission,
  ) => {
    const key = `approval:${item.runId}:${item.requestId}`;
    if (resolving) return;
    setResolving(key);
    setItemError(key);
    try {
      const result = await resolveItem(item.runId, item.requestId, {
        decision,
        ...(always ? { always: true } : {}),
        ...admission,
      });
      if (!result.won) {
        if (result.winner) {
          const at = new Date(result.winner.at).toLocaleString();
          const message = `${result.winner.by} already marked this request ${decisionLabel(result.winner.decision)} at ${at}`;
          setResolutionNotices((current) => [
            { key, title: item.title, message },
            ...current.filter((notice) => notice.key !== key),
          ]);
        } else {
          showToast(result.error ?? "Approval decision did not take effect");
        }
      } else {
        showToast(result.resumed ? `Request ${decisionLabel(decision)}; run resumed` : `Request ${decisionLabel(decision)}`, "success");
      }
      setBriefAdmissionReviews((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (await refresh()) focusAfterMutation();
    } catch (error) {
      if (error instanceof BriefAdmissionRequestError) {
        setBriefAdmissionReviews((current) => ({
          ...current,
          [key]: {
            preflight: error.preflight,
            acknowledged: false,
            decision,
            always,
          },
        }));
        setItemError(key, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setItemError(key, `Approval failed: ${message}`);
      showToast(`Approval failed: ${message}`);
    } finally {
      if (mounted.current) setResolving(null);
    }
  };

  const markFailed = async (item: InboxStaleItem) => {
    const key = `stale:${item.id}`;
    if (!item.staleRunId || resolving) return;
    setResolving(key);
    setItemError(key);
    try {
      await markRunFailed(item.staleRunId);
      showToast(`The stale run for ${item.name} was marked failed`, "success");
      if (await refresh()) focusAfterMutation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setItemError(key, `Marking the run failed did not take effect: ${message}`);
      showToast(`Marking the run failed did not take effect: ${message}`);
    } finally {
      if (mounted.current) setResolving(null);
    }
  };

  const decidePatch = async (item: InboxPatchItem, decision: "accept" | "reject") => {
    const itemKey = `patch:${patchKey(item)}`;
    if (resolving) return;
    setResolving(itemKey);
    setItemError(itemKey);
    try {
      await reviewPatch(item.campaignId, item.index, decision);
      showToast(decision === "accept" ? "Brief patch accepted" : "Brief patch rejected", "success");
      setDiffs((current) => {
        const next = { ...current };
        delete next[patchKey(item)];
        return next;
      });
      if (await refresh()) focusAfterMutation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setItemError(itemKey, `Patch review failed: ${message}`);
      showToast(`Patch review failed: ${message}`);
      await refresh();
    } finally {
      if (mounted.current) setResolving(null);
    }
  };

  const toggleDiff = async (item: InboxPatchItem) => {
    const key = patchKey(item);
    if (diffs[key]) {
      setDiffs((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    setDiffs((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const versions = diffVersions(item);
      const text = versions
        ? await loadBriefDiff(item.campaignId, versions.from, versions.to)
        : patchPreview(item);
      if (mounted.current) setDiffs((current) => ({ ...current, [key]: { text } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current) setDiffs((current) => ({ ...current, [key]: { error: message } }));
      showToast(`Diff failed to load: ${message}`);
    }
  };

  const total = overview ? overviewTotal(overview) : 0;
  const sourceIssues = overview
    ? SOURCE_KEYS.filter((key) => overview[key].status !== "complete")
    : [];
  const incompleteCount = overview
    ? sourceIssues.filter((key) => overview[key].status === "partial").length
    : 0;
  const unavailableCount = overview
    ? sourceIssues.filter((key) => overview[key].status === "unavailable").length
    : 0;
  const countLabel = !overview
    ? (loading ? "Loading" : "Status unknown")
    : sourceIssues.length
      ? `${total} items loaded · ${incompleteCount} incomplete sources · ${unavailableCount} unavailable sources`
      : `${total} pending item${total === 1 ? "" : "s"}`;

  return (
    <div className="inbox-view" data-testid="inbox-view">
      <div className="campaign-header">
        <div>
          <h1>Inbox queue</h1>
          <div className="subtitle">Everything waiting for your decision or intervention</div>
        </div>
        <span className={`badge${sourceIssues.length || pageError ? " error" : total ? " warn" : ""}`}>{countLabel}</span>
      </div>

      {!overview ? (
        pageError ? (
          <div className="empty-state error-state" role="alert" data-testid="inbox-error">
            Inbox unavailable: {pageError}
          </div>
        ) : (
          <div className="empty-state" role="status">Loading Inbox…</div>
        )
      ) : (
        <>
          {refreshError ? (
            <div className="empty-state error-state inbox-refresh-error" role="alert" data-testid="inbox-refresh-error">
              Refresh failed. Showing the last successful result{lastSuccessAt ? ` (${lastSuccessAt.toLocaleString()})` : ""}: {refreshError}
            </div>
          ) : null}

          {resolutionNotices.length ? (
            <section className="inbox-resolution-results" aria-label="Approval results" data-testid="inbox-resolution-results">
              {resolutionNotices.map((notice) => (
                <article className="inbox-card resolution-card" key={notice.key}>
                  <div role="status" aria-live="polite" aria-atomic="true" data-testid={`inbox-resolution-${notice.key}`}>
                    <h2>Approval result: {notice.title}</h2>
                    <p className="inbox-body">{notice.message}</p>
                  </div>
                  <div className="inbox-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => setResolutionNotices((current) => current.filter((item) => item.key !== notice.key))}
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {sourceIssues.length ? (
            <div className="inbox-source-errors" data-testid="inbox-source-errors">
              {sourceIssues.map((key) => {
                const source = overview[key];
                const condition = source.status === "partial" ? " incomplete" : " unavailable";
                return (
                  <div
                    className="inbox-source-error"
                    data-testid={`inbox-source-error-${key}`}
                    key={key}
                    role="alert"
                    tabIndex={0}
                  >
                    <strong>{SOURCE_LABELS[key]}{condition}</strong>: {source.error}
                  </div>
                );
              })}
            </div>
          ) : null}

          {total === 0 && !sourceIssues.length ? (
            <div className="empty-state inbox-empty" data-testid="inbox-empty" tabIndex={-1}>Nothing needs your attention</div>
          ) : total > 0 ? (
            <div className="inbox-sections">
              {overview.approvals.items.length ? (
                <section className="inbox-group" data-testid="inbox-approvals">
                  <h2>Pending approvals <span>{overview.approvals.items.length}</span></h2>
                  <div className="inbox-list">
                    {overview.approvals.items.map((item) => {
                      const itemKey = `approval:${item.runId}:${item.requestId}`;
                      const busy = resolving === itemKey;
                      const briefReview = briefAdmissionReviews[itemKey];
                      const campaign = item.campaignName ?? item.campaignId;
                      const runHref = item.campaignId
                        ? `/campaign/${encodeURIComponent(item.campaignId)}/run/${encodeURIComponent(item.runId)}`
                        : `/run/${encodeURIComponent(item.runId)}`;
                      return (
                        <article className="inbox-card" data-inbox-item key={`${item.runId}:${item.requestId}`} aria-busy={busy}>
                          <div className="inbox-card-head">
                            <div>
                              <div className="inbox-action"><strong>{item.action}</strong>{item.target ? <><span>→</span><code>{item.target}</code></> : null}</div>
                              <h3>{item.title}</h3>
                            </div>
                            <span className={`badge risk-${item.risk}`}>{item.risk}</span>
                          </div>
                          {item.body ? <p className="inbox-body">{item.body}</p> : null}
                          <div className="inbox-meta">
                            <span>run <Link className="mono" to={runHref}>{item.runId}</Link></span>
                            <span>{campaign ? `campaign ${campaign}` : "Standalone"}</span>
                            <span>Waiting for {waitingTime(item.createdAt)}</span>
                          </div>
                          {itemErrors[itemKey] ? <div className="inbox-item-error" role="alert">{itemErrors[itemKey]}</div> : null}
                          {briefReview ? (
                            <>
                              <BriefPreflightPanel
                                preflight={briefReview.preflight}
                                acknowledged={briefReview.acknowledged}
                                onAcknowledgedChange={(acknowledged) => setBriefAdmissionReviews((current) => ({
                                  ...current,
                                  [itemKey]: { ...briefReview, acknowledged },
                                }))}
                              />
                              <div className="inbox-actions">
                                <button
                                  className="btn ghost"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setBriefAdmissionReviews((current) => {
                                      const next = { ...current };
                                      delete next[itemKey];
                                      return next;
                                    });
                                    setItemError(itemKey);
                                  }}
                                >Cancel brief review</button>
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={busy || (briefReview.preflight.report.requiresAcknowledgement && !briefReview.acknowledged)}
                                  onClick={() => void resolveApproval(
                                    item,
                                    briefReview.decision,
                                    briefReview.always,
                                    {
                                      briefPreflightDigest: briefReview.preflight.report.digest,
                                      briefPreflightReceipt: briefReview.preflight.receipt,
                                      ...(briefReview.preflight.report.requiresAcknowledgement
                                        ? { acknowledgeBriefWarnings: true }
                                        : {}),
                                    },
                                  )}
                                >Continue decision and resume</button>
                              </div>
                            </>
                          ) : (
                            <div className="inbox-actions">
                              <button className="btn" type="button" disabled={busy} onClick={() => void resolveApproval(item, "approve")}>Approve and resume</button>
                              <button className="btn ghost" type="button" disabled={busy} onClick={() => void resolveApproval(item, "deny")}>Deny</button>
                              {item.standingRuleEligible.ok ? <button className="btn ghost always" type="button" disabled={busy} onClick={() => void resolveApproval(item, "approve", true)}>Always allow</button> : null}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {overview.deferred.items.length ? (
                <section className="inbox-group" data-testid="inbox-deferred">
                  <h2>Deferred tasks <span>{overview.deferred.items.length}</span></h2>
                  <div className="inbox-list">
                    {overview.deferred.items.map((item) => (
                      <article className="inbox-card wait-card" data-inbox-item key={item.id}>
                        <div className="inbox-card-head"><div><div className="inbox-action"><strong>deferred</strong></div><h3>{item.name ?? item.id}</h3></div><span className="badge warn">waiting</span></div>
                        <p className="inbox-body"><strong>Waiting for: </strong>{item.deferReason}</p>
                        <div className="inbox-meta">
                          <span>Expected retry: {retryLabel(item.notBefore)}</span>
                          {item.runId ? <span>Related run <Link className="mono" to={`/run/${encodeURIComponent(item.runId)}`}>{item.runId}</Link></span> : null}
                          <span className="mono">{item.projectDir}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {overview.stale.items.length ? (
                <section className="inbox-group" data-testid="inbox-stale">
                  <h2>Intervention required <span>{overview.stale.items.length}</span></h2>
                  <div className="inbox-list">
                    {overview.stale.items.map((item) => {
                      const itemKey = `stale:${item.id}`;
                      const busy = resolving === itemKey;
                      const href = item.staleRunId ? `/run/${encodeURIComponent(item.staleRunId)}` : `/campaign/${encodeURIComponent(item.id)}`;
                      return (
                        <article className="inbox-card stale-card" data-inbox-item key={item.id} aria-busy={busy}>
                          <div className="inbox-card-head"><div><div className="inbox-action"><strong>stale run</strong></div><h3>{item.name}</h3></div><span className="badge error">stale</span></div>
                          <p className="inbox-body">The daemon stopped updating this run before it wrote a terminal status. Inspect it and close it explicitly.</p>
                          {!item.staleRunId ? <p className="inbox-body">The underlying run cannot be located; inspect the campaign history.</p> : null}
                          {itemErrors[itemKey] ? <div className="inbox-item-error" role="alert">{itemErrors[itemKey]}</div> : null}
                          <div className="inbox-actions">
                            <Link className="btn ghost" to={href}>{item.staleRunId ? "Open run" : "Open campaign"}</Link>
                            <button className="btn danger" type="button" disabled={busy || !item.staleRunId} onClick={() => void markFailed(item)}>Mark failed</button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {overview.patches.items.length ? (
                <section className="inbox-group" data-testid="inbox-patches">
                  <h2>Brief patches awaiting review <span>{overview.patches.items.length}</span></h2>
                  <div className="inbox-list">
                    {overview.patches.items.map((item) => {
                      const key = patchKey(item);
                      const itemKey = `patch:${key}`;
                      const diff = diffs[key];
                      const busy = resolving === itemKey;
                      const diffId = `patch-diff-${key}`;
                      return (
                        <article className="inbox-card patch-card" data-inbox-item key={key} aria-busy={busy}>
                          <div className="inbox-card-head"><div><div className="inbox-action"><strong>{item.patch.op}</strong><span>→</span><code>{item.patch.section}</code></div><h3>{item.reason}</h3></div><span className={`badge risk-${item.severity ?? "unknown"}`}>{item.severity ?? "review"}</span></div>
                          <p className="inbox-body">{item.patchSummary}</p>
                          <div className="inbox-meta">
                            <span>campaign {item.campaignName}</span>
                            {item.briefVersion ? <span>Based on {item.briefVersion}</span> : null}
                            <span>Source: <code>{item.source ?? "not recorded"}</code></span>
                            {simulationSource(item.source) ? <span className="badge simulation-source">Simulation/test source</span> : null}
                            {item.runId ? <span>run <Link className="mono" to={`/run/${encodeURIComponent(item.runId)}`}>{item.runId}</Link></span> : null}
                          </div>
                          {diff ? (
                            <pre
                              aria-label={`${item.campaignName} brief patch diff`}
                              className={`brief-patch-diff${diff.error ? " error" : ""}`}
                              data-testid={diffId}
                              id={diffId}
                              role={diff.error ? "alert" : undefined}
                              tabIndex={0}
                            >
                              {diff.loading ? "Loading diff…" : diff.error ? `Diff unavailable: ${diff.error}` : diff.text}
                            </pre>
                          ) : null}
                          {itemErrors[itemKey] ? <div className="inbox-item-error" role="alert">{itemErrors[itemKey]}</div> : null}
                          <div className="inbox-actions">
                            <button className="btn ghost" type="button" aria-controls={diffId} aria-expanded={Boolean(diff)} onClick={() => void toggleDiff(item)}>{diff ? "Hide diff" : "View diff"}</button>
                            <button className="btn" type="button" disabled={busy} onClick={() => void decidePatch(item, "accept")}>Accept patch</button>
                            <button className="btn ghost" type="button" disabled={busy} onClick={() => void decidePatch(item, "reject")}>Reject patch</button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
