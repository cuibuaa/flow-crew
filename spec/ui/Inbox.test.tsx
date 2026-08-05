// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Inbox from "../../ui/src/components/Inbox";
import ToastContainer from "../../ui/src/components/Toast";
import type { InboxItem, InboxOverview, InboxPatchItem } from "../../ui/src/types";

const approval: InboxItem = {
  runId: "run-approval",
  projectDir: "/tmp/project",
  requestId: "deploy-production",
  action: "deploy",
  target: "production",
  risk: "external",
  title: "Deploy the release",
  body: "Impact: production traffic. Rollback: deploy the previous release.",
  createdAt: "2026-07-30T00:00:00.000Z",
  state: "pending",
  standingRuleEligible: { ok: true },
  campaignId: "campaign-a",
  campaignName: "Campaign A",
};

const deferred = {
  id: 17,
  name: "Waiting task",
  projectDir: "/tmp/project",
  runId: "run-busy",
  status: "deferred" as const,
  deferReason: "project busy (run run-active)",
  notBefore: "2026-07-31T18:30:00.000Z",
};

const stale = {
  id: "campaign-stale",
  name: "Stale campaign",
  status: "stale" as const,
  staleRunId: "run-stale",
};

const pendingPatch: InboxPatchItem = {
  index: 0,
  ts: "2026-07-30T01:00:00.000Z",
  campaignId: "campaign-patch",
  campaignName: "Patch campaign",
  reason: "Tighten the risk controls",
  severity: "high",
  patch: { type: "brief_patch", section: "## Risk", op: "append", value: "Require rollback evidence." },
  patchSummary: "append ## Risk: Require rollback evidence.",
  briefVersion: "v1",
  latestVersion: "v2",
};

function makeOverview(overrides: Partial<InboxOverview> = {}): InboxOverview {
  return {
    approvals: { status: "complete", items: [] },
    deferred: { status: "complete", items: [] },
    stale: { status: "complete", items: [] },
    patches: { status: "complete", items: [], coverage: { succeeded: 0, failed: 0 } },
    campaignCount: 0,
    ...overrides,
  };
}

const loadOverview = vi.fn();
const loadBriefDiff = vi.fn();
const resolveItem = vi.fn();
const reviewPatch = vi.fn();
const markRunFailed = vi.fn();

function view() {
  return render(
    <MemoryRouter>
      <ToastContainer />
      <Inbox
        loadOverview={loadOverview}
        loadBriefDiff={loadBriefDiff}
        resolveItem={resolveItem}
        reviewPatch={reviewPatch}
        markRunFailed={markRunFailed}
      />
    </MemoryRouter>,
  );
}

describe("operator Inbox", () => {
  beforeEach(() => {
    loadOverview.mockResolvedValue(makeOverview());
    loadBriefDiff.mockResolvedValue("--- v1\n+++ v2\n+ Require rollback evidence.");
    resolveItem.mockResolvedValue({ ok: true, won: true, resumed: true });
    reviewPatch.mockResolvedValue({ remaining: 0, version: "v2" });
    markRunFailed.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders approval actions and omits permanent approval when ineligible", async () => {
    loadOverview.mockResolvedValue(makeOverview({
      approvals: { status: "complete", items: [{ ...approval, risk: "write", standingRuleEligible: { ok: false, reason: "external only" } }] },
    }));

    view();

    expect(await screen.findByText("Deploy the release")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-approvals")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and resume" })).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-deferred")).not.toBeInTheDocument();
  });

  it("shows a deferred task as waiting, including its reason and retry time", async () => {
    loadOverview.mockResolvedValue(makeOverview({ deferred: { status: "complete", items: [deferred] } }));

    view();

    const group = await screen.findByTestId("inbox-deferred");
    expect(group).toHaveTextContent("Deferred tasks");
    expect(group).toHaveTextContent("project busy (run run-active)");
    expect(group).toHaveTextContent("Expected retry");
    expect(screen.queryByTestId("inbox-stale")).not.toBeInTheDocument();
  });

  it("surfaces stale work and marks its underlying run failed", async () => {
    loadOverview.mockResolvedValue(makeOverview({ stale: { status: "complete", items: [stale] } }));

    view();

    const group = await screen.findByTestId("inbox-stale");
    expect(group).toHaveTextContent("Intervention required");
    expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute("href", "/run/run-stale");
    fireEvent.click(screen.getByRole("button", { name: "Mark failed" }));

    await waitFor(() => expect(markRunFailed).toHaveBeenCalledWith("run-stale"));
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("inbox-patches")).not.toBeInTheDocument();
  });

  it("loads an accessible brief diff and accepts the patch", async () => {
    loadOverview.mockResolvedValue(makeOverview({ patches: { status: "complete", items: [pendingPatch] } }));

    view();

    const group = await screen.findByTestId("inbox-patches");
    expect(group).toHaveTextContent("Tighten the risk controls");
    const disclosure = screen.getByRole("button", { name: "View diff" });
    expect(disclosure).toHaveAttribute("aria-controls", "patch-diff-campaign-patch:0");
    fireEvent.click(disclosure);
    const diff = await screen.findByTestId("patch-diff-campaign-patch:0");
    expect(diff).toHaveTextContent("Require rollback evidence");
    expect(diff).toHaveAttribute("tabindex", "0");
    expect(loadBriefDiff).toHaveBeenCalledWith("campaign-patch", "v1", "v2");

    fireEvent.click(screen.getByRole("button", { name: "Accept patch" }));
    await waitFor(() => expect(reviewPatch).toHaveBeenCalledWith("campaign-patch", 0, "accept"));
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
  });

  it("supports rejecting a pending brief patch", async () => {
    loadOverview.mockResolvedValue(makeOverview({ patches: { status: "complete", items: [pendingPatch] } }));
    view();
    await screen.findByTestId("inbox-patches");

    fireEvent.click(screen.getByRole("button", { name: "Reject patch" }));

    await waitFor(() => expect(reviewPatch).toHaveBeenCalledWith("campaign-patch", 0, "reject"));
  });

  it("shows only the exact empty state when all four item classes are empty", async () => {
    view();

    expect(await screen.findByText("Nothing needs your attention")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-approvals")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-deferred")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-stale")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-patches")).not.toBeInTheDocument();
  });

  it("shows the winning operator when an approval loses the first-wins race", async () => {
    loadOverview
      .mockResolvedValueOnce(makeOverview({ approvals: { status: "complete", items: [approval] } }))
      .mockResolvedValueOnce(makeOverview());
    resolveItem.mockResolvedValue({
      ok: true,
      won: false,
      winner: { decision: "approve", by: "alice", at: "2026-07-30T01:02:03.000Z" },
    });
    view();
    await screen.findByText("Deploy the release");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    const result = await screen.findByTestId("inbox-resolution-approval:run-approval:deploy-production");
    expect(result).toHaveTextContent(/alice already marked this request approved at/);
    expect(result).toHaveAttribute("role", "status");
    expect(result).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(loadOverview).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("inbox-resolution-results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("inbox-resolution-results")).not.toBeInTheDocument();
  });

  it("shows a page error for an unreachable aggregate request instead of pretending the inbox is empty", async () => {
    loadOverview.mockRejectedValue(new Error("server offline"));

    view();

    expect(await screen.findByTestId("inbox-error")).toHaveTextContent("server offline");
    expect(await screen.findByText("Inbox failed to load: server offline")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
  });

  it("rejects an invalid top-level payload as a page error", async () => {
    loadOverview.mockResolvedValue({ approvals: [] });

    view();

    expect(await screen.findByTestId("inbox-error")).toHaveTextContent("invalid inbox overview response");
  });

  it.each([
    ["approvals", { ...approval, runId: 42 }],
    ["deferred", { ...deferred, deferReason: null }],
    ["stale", { ...stale, name: null, status: "complete" }],
    ["patches", { ...pendingPatch, patch: { ...pendingPatch.patch, op: "delete" } }],
  ] as const)("rejects a malformed %s item before rendering it as trusted work", async (sourceKey, malformed) => {
    const invalid = makeOverview();
    invalid[sourceKey] = { status: "complete", items: [malformed] } as never;
    loadOverview.mockResolvedValue(invalid);

    view();

    expect(await screen.findByTestId("inbox-error")).toHaveTextContent("invalid inbox overview response");
    expect(screen.queryByTestId(`inbox-${sourceKey}`)).not.toBeInTheDocument();
  });

  it.each([
    ["approvals", "inbox-approvals"],
    ["deferred", "inbox-deferred"],
    ["stale", "inbox-stale"],
    ["patches", "inbox-patches"],
  ] as const)("localizes a %s source failure and keeps the other three groups", async (failedKey, failedTestId) => {
    const full = makeOverview({
      approvals: { status: "complete", items: [approval] },
      deferred: { status: "complete", items: [deferred] },
      stale: { status: "complete", items: [stale] },
      patches: { status: "complete", items: [pendingPatch] },
      campaignCount: 120,
    });
    full[failedKey] = { status: "unavailable", items: [], error: `${failedKey} offline` } as never;
    loadOverview.mockResolvedValue(full);

    view();

    expect(await screen.findByTestId(`inbox-source-error-${failedKey}`)).toHaveTextContent("unavailable");
    expect(screen.queryByTestId(failedTestId)).not.toBeInTheDocument();
    for (const testId of ["inbox-approvals", "inbox-deferred", "inbox-stale", "inbox-patches"]) {
      if (testId !== failedTestId) expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
  });

  it("labels items plus an error as incomplete rather than unavailable", async () => {
    loadOverview.mockResolvedValue(makeOverview({
      approvals: { status: "complete", items: [approval] },
      deferred: { status: "unavailable", items: [], error: "daemon offline" },
      patches: {
        status: "partial",
        items: [pendingPatch],
        error: "one campaign unreadable",
        coverage: { succeeded: 119, failed: 1 },
      },
      campaignCount: 120,
    }));

    view();

    expect(await screen.findByTestId("inbox-source-error-patches")).toHaveTextContent("incomplete");
    expect(screen.getByTestId("inbox-source-error-deferred")).toHaveTextContent("unavailable");
    expect(screen.getByText("2 items loaded · 1 incomplete sources · 1 unavailable sources")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-patches")).toHaveTextContent("Tighten the risk controls");
  });

  it("uses read coverage to label a partial empty result as incomplete", async () => {
    loadOverview.mockResolvedValue(makeOverview({
      patches: {
        status: "partial",
        items: [],
        error: "one campaign unreadable",
        coverage: { succeeded: 119, failed: 1 },
      },
      campaignCount: 120,
    }));

    view();

    expect(await screen.findByTestId("inbox-source-error-patches")).toHaveTextContent("incomplete");
    expect(screen.getByText("0 items loaded · 1 incomplete sources · 0 unavailable sources")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
  });

  it.each([
    { status: "complete", items: [], error: "should not exist" },
    { status: "partial", items: [], error: "missing coverage" },
    { status: "partial", items: [], error: "no successful reads", coverage: { succeeded: 0, failed: 1 } },
    { status: "unavailable", items: [pendingPatch], error: "cannot include items" },
  ])("rejects an invalid source-state combination %#", async (patches) => {
    loadOverview.mockResolvedValue(makeOverview({ patches: patches as never }));

    view();

    expect(await screen.findByTestId("inbox-error")).toHaveTextContent("invalid inbox overview response");
  });

  it("keeps the last trusted items when a later poll fails", async () => {
    vi.useFakeTimers();
    loadOverview
      .mockResolvedValueOnce(makeOverview({ approvals: { status: "complete", items: [approval] } }))
      .mockRejectedValueOnce(new Error("poll offline"));
    view();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Deploy the release")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS_FOR_TEST);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("inbox-refresh-error")).toHaveTextContent("poll offline");
    expect(screen.getByText("Deploy the release")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs your attention")).not.toBeInTheDocument();
  });

  it("loads a 120-campaign aggregate fixture with one inbox request", async () => {
    loadOverview.mockResolvedValue(makeOverview({ campaignCount: 120 }));

    view();

    expect(await screen.findByText("Nothing needs your attention")).toBeInTheDocument();
    expect(loadOverview).toHaveBeenCalledTimes(1);
  });
});

const POLL_MS_FOR_TEST = 15_000;
