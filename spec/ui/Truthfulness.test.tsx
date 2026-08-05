// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BriefAdmissionRequestError,
  deleteRunCampaign,
  fetchDashboardStatus,
  fetchInboxOverview,
  fetchRunSummary,
  fetchRunDetail,
  fetchRunStageOutput,
  fetchStandaloneRuns,
} from "../../ui/src/api";
import { AppRoutes, TopbarOnly } from "../../ui/src/App";
import Inbox from "../../ui/src/components/Inbox";
import NewRunModal from "../../ui/src/components/NewRunModal";
import RunDetail from "../../ui/src/components/RunDetail";
import ToastContainer from "../../ui/src/components/Toast";
import Workspaces from "../../ui/src/components/Workspaces";
import type {
  BriefPreflightResponse,
  Campaign,
  InboxItem,
  InboxOverview,
  RunDetailData,
  WorkspaceRun,
} from "../../ui/src/types";

vi.mock("../../ui/src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ui/src/api")>()),
  deleteRunCampaign: vi.fn(),
  fetchAgents: vi.fn(),
  fetchCampaignBriefDiff: vi.fn(),
  fetchDashboardStatus: vi.fn(),
  fetchInboxOverview: vi.fn(),
  fetchRunDetail: vi.fn(),
  fetchRunStageOutput: vi.fn(),
  fetchRunSummary: vi.fn(),
  fetchSettings: vi.fn(),
  fetchStandaloneRuns: vi.fn(),
  cancelTask: vi.fn(),
  createTask: vi.fn(),
  renameRunCampaign: vi.fn(),
  reviewCampaignPatch: vi.fn(),
  resolveInboxItem: vi.fn(),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderWorkspaces(campaigns?: Campaign[], initialEntry = "/campaign/running") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/campaign" element={<Workspaces initialCampaigns={campaigns} />} />
        <Route path="/campaign/:id" element={<Workspaces initialCampaigns={campaigns} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function p11Preflight(
  overrides: Partial<BriefPreflightResponse["report"]> = {},
  receipt = "b".repeat(64),
): BriefPreflightResponse {
  return {
    report: {
      version: 1,
      digest: "a".repeat(64),
      inputKind: "brief",
      frontmatter: { status: "valid" },
      contractReady: true,
      findings: [{
        code: "terminal_states_missing",
        fingerprint: "terminal-states-missing",
        level: "warn",
        message: "Terminal contract warning is visible",
        acknowledgementRequired: true,
        risk: "Terminal artifact paths have no contract.",
        suggestion: "Review the intended terminal contract.",
      }],
      requiresAcknowledgement: true,
      ...overrides,
    },
    receipt,
  };
}

function submitNewRunModal(): void {
  const form = screen.getByTestId("new-run-modal").querySelector("form");
  if (!form) throw new Error("New Run form is missing");
  fireEvent.submit(form);
}

describe("dashboard truthfulness", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.mocked(deleteRunCampaign).mockResolvedValue({ ok: true, orphaned: 0, removedHistory: true });
    vi.mocked(fetchDashboardStatus).mockResolvedValue({
      freshness: "fresh",
      pid: 123,
      startedAt: "2026-08-01T20:00:00.000Z",
      loadedBuild: null,
      diskBuild: null,
      diskIsNewer: null,
    });
    vi.mocked(fetchInboxOverview).mockResolvedValue({
      approvals: { status: "complete", items: [] },
      deferred: { status: "complete", items: [] },
      stale: { status: "complete", items: [] },
      patches: { status: "complete", items: [], coverage: { succeeded: 0, failed: 0 } },
      campaignCount: 0,
    });
    vi.mocked(fetchRunSummary).mockResolvedValue(null);
    vi.mocked(fetchStandaloneRuns).mockResolvedValue({ runs: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps New Run writable and shows exact brief findings before a separately acknowledged start", async () => {
    const checked = p11Preflight({
      contractReady: false,
      findings: [
        {
          code: "frontmatter_valid",
          fingerprint: "frontmatter-valid",
          level: "ok",
          message: "Frontmatter parsed successfully",
          acknowledgementRequired: false,
        },
        {
          code: "criterion_instrument_wording",
          fingerprint: "criterion-warning",
          level: "warn",
          message: "Criterion warning is visible",
          acknowledgementRequired: true,
        },
      ],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(checked), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunModal open campaigns={[]} onClose={() => {}} onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText("Brief content");
    fireEvent.change(textarea, { target: { value: "# Exact brief\n" } });
    expect(textarea).toHaveValue("# Exact brief\n");
    submitNewRunModal();

    expect(await screen.findByRole("region", { name: "Brief preflight result" })).toBeInTheDocument();
    expect(screen.getByText("Frontmatter parsed successfully")).toBeInTheDocument();
    expect(screen.getByText("Criterion warning is visible")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed these warnings/i }));
    submitNewRunModal();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ brief: "# Exact brief\n" }),
      {
        briefPreflightDigest: checked.report.digest,
        briefPreflightReceipt: checked.receipt,
        acknowledgeBriefWarnings: true,
      },
    ));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ brief: "# Exact brief\n" });
  });

  it("invalidates the report, receipt, and acknowledgement after any brief edit", async () => {
    const checked = p11Preflight();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(checked), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const onSubmit = vi.fn();
    render(<NewRunModal open campaigns={[]} onClose={() => {}} onSubmit={onSubmit} />);
    const textarea = screen.getByLabelText("Brief content");
    fireEvent.change(textarea, { target: { value: "# Before" } });
    submitNewRunModal();
    const acknowledgement = await screen.findByRole("checkbox", { name: /reviewed these warnings/i });
    fireEvent.click(acknowledgement);
    expect(acknowledgement).toBeChecked();

    fireEvent.change(textarea, { target: { value: "# Before\n" } });
    expect(screen.queryByRole("region", { name: "Brief preflight result" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /reviewed these warnings/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check brief" })).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still requires a separate Start action for a clean report without a warning checkbox", async () => {
    const checked = p11Preflight({ findings: [], requiresAcknowledgement: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(checked), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunModal open campaigns={[]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Brief content"), { target: { value: "# Clean brief" } });

    submitNewRunModal();
    expect(await screen.findByText("No consequential findings require acknowledgement.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox", { name: /reviewed these warnings/i })).not.toBeInTheDocument();
    submitNewRunModal();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ brief: "# Clean brief" }),
      {
        briefPreflightDigest: checked.report.digest,
        briefPreflightReceipt: checked.receipt,
      },
    ));
  });

  it("allows malformed YAML only after its failure is visible and explicitly acknowledged", async () => {
    const checked = p11Preflight({
      frontmatter: { status: "invalid", error: "Malformed YAML" },
      contractReady: false,
      findings: [{
        code: "frontmatter_invalid",
        fingerprint: "frontmatter-invalid",
        level: "fail",
        message: "Frontmatter parsing failed",
        acknowledgementRequired: true,
      }],
      requiresAcknowledgement: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(checked), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunModal open campaigns={[]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Brief content"), { target: { value: "---\ninvalid: [" } });
    submitNewRunModal();

    expect(await screen.findByText("Frontmatter parsing failed")).toBeInTheDocument();
    expect(screen.getByText("invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed these warnings/i }));
    submitNewRunModal();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("refreshes a server-side admission 409 and keeps New Run open for a new acknowledgement", async () => {
    const first = p11Preflight({
      digest: "1".repeat(64),
      findings: [{
        code: "terminal_states_missing",
        fingerprint: "terminal-states-missing",
        level: "warn",
        message: "Initial warning",
        acknowledgementRequired: true,
      }],
    }, "2".repeat(64));
    const refreshed = p11Preflight({
      digest: "3".repeat(64),
      findings: [{
        code: "criterion_instrument_wording",
        fingerprint: "criterion-warning",
        level: "warn",
        message: "Refreshed warning",
        acknowledgementRequired: true,
      }],
    }, "4".repeat(64));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(first), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new BriefAdmissionRequestError("Brief changed on the server", 409, refreshed))
      .mockResolvedValueOnce(undefined);
    render(<NewRunModal open campaigns={[]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Brief content"), { target: { value: "# Brief" } });
    submitNewRunModal();
    fireEvent.click(await screen.findByRole("checkbox", { name: /reviewed these warnings/i }));
    submitNewRunModal();

    expect(await screen.findByText("Refreshed warning")).toBeInTheDocument();
    expect(screen.getByTestId("new-run-modal")).toHaveTextContent("+ New Run");
    expect(screen.getByRole("alert")).toHaveTextContent("Brief changed on the server");
    const refreshedCheckbox = screen.getByRole("checkbox", { name: /reviewed these warnings/i });
    expect(refreshedCheckbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();

    fireEvent.click(refreshedCheckbox);
    submitNewRunModal();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][1]).toEqual({
      briefPreflightDigest: refreshed.report.digest,
      briefPreflightReceipt: refreshed.receipt,
      acknowledgeBriefWarnings: true,
    });
  });

  it("retains the enabled + New Run authoring entrance and writable editor", () => {
    renderWorkspaces([], "/campaign");
    const [button] = screen.getAllByRole("button", { name: "+ New Run" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(screen.getByTestId("new-run-modal")).toHaveTextContent("+ New Run");
    expect(screen.getByLabelText("Brief content")).not.toHaveAttribute("readonly");
  });

  it("shows an Inbox resume 409 and retries the unperformed decision only after acknowledgement", async () => {
    const approval: InboxItem = {
      runId: "run-admission",
      projectDir: "/tmp/project",
      requestId: "deploy-fixture",
      action: "deploy",
      risk: "external",
      title: "Deploy safely",
      createdAt: "2026-08-03T00:00:00.000Z",
      state: "pending",
      standingRuleEligible: { ok: true },
    };
    const overview = (items: InboxItem[]): InboxOverview => ({
      approvals: { status: "complete", items },
      deferred: { status: "complete", items: [] },
      stale: { status: "complete", items: [] },
      patches: { status: "complete", items: [], coverage: { succeeded: 0, failed: 0 } },
      campaignCount: 0,
    });
    const review = p11Preflight({
      digest: "5".repeat(64),
      findings: [{
        code: "terminal_states_missing",
        fingerprint: "terminal-states-missing",
        level: "warn",
        message: "Resume warning",
        acknowledgementRequired: true,
      }],
    }, "6".repeat(64));
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(overview([approval]))
      .mockResolvedValue(overview([]));
    const resolveItem = vi.fn()
      .mockRejectedValueOnce(new BriefAdmissionRequestError("Resume brief review required", 409, review))
      .mockResolvedValueOnce({ ok: true, won: true, resumed: true });
    render(
      <MemoryRouter>
        <Inbox loadOverview={loadOverview} resolveItem={resolveItem} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve and resume" }));

    expect(await screen.findByText("Resume warning")).toBeInTheDocument();
    expect(screen.getByText("Resume brief review required")).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue decision and resume" });
    expect(continueButton).toBeDisabled();
    expect(resolveItem).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed these warnings/i }));
    fireEvent.click(continueButton);
    await waitFor(() => expect(resolveItem).toHaveBeenCalledTimes(2));
    expect(resolveItem.mock.calls[1]).toEqual([
      approval.runId,
      approval.requestId,
      {
        decision: "approve",
        briefPreflightDigest: review.report.digest,
        briefPreflightReceipt: review.receipt,
        acknowledgeBriefWarnings: true,
      },
    ]);
  });

  it("keeps the navigation name-only instead of inventing one campaign-level status", () => {
    window.localStorage.setItem("fc.campaignFilter", "all");
    const campaigns: Campaign[] = [
      { id: "running", name: "Running", status: "running", runs: [] },
      { id: "parked", name: "Parked", status: "parked", runs: [] },
      { id: "stale", name: "Stale", status: "stale", runs: [] },
      { id: "failed", name: "Failed", status: "failed", runs: [] },
      { id: "complete", name: "Complete", status: "complete", runs: [] },
      { id: "idle", name: "Idle", status: "idle", runs: [] },
    ];
    renderWorkspaces(campaigns);

    for (const campaign of campaigns) {
      const row = screen.getByRole("treeitem", { name: new RegExp(campaign.name) });
      expect(row).toHaveTextContent(campaign.name);
      expect(row.querySelector(".status-dot")).toBeNull();
    }
  });

  it("keeps an old parked campaign in the Active filter", () => {
    window.localStorage.setItem("fc.campaignFilter", "active");
    renderWorkspaces([
      { id: "parked", name: "Waiting campaign", status: "parked", started_at: "2020-01-01T00:00:00Z", runs: [] },
      { id: "idle", name: "Old idle", status: "idle", started_at: "2020-01-01T00:00:00Z", runs: [] },
    ], "/campaign/parked");

    expect(screen.getByRole("treeitem", { name: /Waiting campaign/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Old idle/ })).not.toBeInTheDocument();
  });

  it("reserves the exact run total for the destructive delete confirmation", () => {
    window.localStorage.setItem("fc.campaignFilter", "all");
    const recentRuns = Array.from({ length: 12 }, (_, index) => ({ id: `run-${index}` }));
    renderWorkspaces([
      { id: "running", name: "Truth campaign", status: "running", runs: recentRuns, runs_total: 47 },
    ]);
    const row = screen.getByRole("treeitem", { name: /Truth campaign/ });

    expect(row.textContent).not.toContain("47");
    fireEvent.click(screen.getByRole("button", { name: "Manage campaign Truth campaign" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete campaign" }));
    expect(screen.getByRole("dialog", { name: "Delete campaign" })).toHaveTextContent("Move 47 runs to standalone?");
  });

  it("does not promote an unqualified metric or internal KPI into campaign navigation", () => {
    renderWorkspaces([{
      id: "running",
      name: "Metric campaign",
      status: "running",
      metric: { name: "quality", value: 8, format: "raw" },
      runs: [],
    }]);
    expect(screen.queryByText("latest quality")).not.toBeInTheDocument();
    expect(screen.queryByText(/Latest score/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no range set/)).not.toBeInTheDocument();
  });

  it("shows the exact standalone total while labelling status counts as a recent slice", async () => {
    const runs: WorkspaceRun[] = Array.from({ length: 30 }, (_, index) => ({
      id: `standalone-${index}`,
      outcome: index === 0 ? "failed" : "complete",
    }));
    vi.mocked(fetchStandaloneRuns).mockResolvedValue({ runs, total: 38 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/standalone-runs") throw new Error(`unexpected request: ${String(input)}`);
      return new Response(JSON.stringify(runs), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Total-Count": "38" },
      });
    }));

    renderWorkspaces([], "/campaign/__standalone");

    expect(await screen.findByText("38 runs not attached to any campaign")).toBeInTheDocument();
    expect(screen.getByText("Status counts and filters cover the 30 most recent runs shown.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "all 30" })).toBeInTheDocument();
  });

  it("retains a visible request error and emits a Toast instead of showing empty data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server offline")));
    render(
      <MemoryRouter initialEntries={["/campaign"]}>
        <ToastContainer />
        <Routes>
          <Route path="/campaign" element={<Workspaces />} />
          <Route path="/campaign/:id" element={<Workspaces />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("workspace-load-error")).toHaveTextContent("server offline");
    expect(await screen.findByText("Campaign index failed to load: server offline")).toBeInTheDocument();
  });

  it("makes a parked run's approval wait prominent and links to the inbox", () => {
    const run: RunDetailData = {
      runId: "parked-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "parked",
      stages: [],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(<MemoryRouter><RunDetail run={run} /></MemoryRouter>);

    const banner = screen.getByTestId("parked-approval-banner");
    expect(banner).toHaveTextContent("Awaiting approval");
    expect(within(banner).getByRole("link", { name: "Open approval in Inbox" })).toHaveAttribute("href", "/inbox");
  });

  it("keeps legacy plan approval separate from the parked-request inbox", () => {
    const run: RunDetailData = {
      runId: "legacy-approval-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "awaiting_approval",
      stages: [],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(<MemoryRouter><RunDetail run={run} /></MemoryRouter>);

    const banner = screen.getByTestId("legacy-approval-banner");
    expect(banner).toHaveTextContent("Legacy plan approval pending");
    expect(banner).toHaveTextContent("separate from the consequential-action inbox");
    expect(screen.queryByRole("link", { name: "Open approval in Inbox" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("parked-approval-banner")).not.toBeInTheDocument();
  });

  it("uses router-native topbar navigation without a document reload", async () => {
    render(
      <MemoryRouter initialEntries={["/run/r1"]}>
        <TopbarOnly />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/campaign"));
  });

  it("redirects the root landing route to the approval inbox", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/dashboard/status"
        ? {
            freshness: "fresh",
            pid: 123,
            startedAt: "2026-08-01T20:00:00.000Z",
            loadedBuild: null,
            diskBuild: null,
            diskIsNewer: null,
          }
        : url === "/api/inbox/overview"
          ? {
              approvals: { status: "complete", items: [] },
              deferred: { status: "complete", items: [] },
              stale: { status: "complete", items: [] },
              patches: { status: "complete", items: [], coverage: { succeeded: 0, failed: 0 } },
              campaignCount: 0,
            }
          : undefined;
      if (!body) throw new Error(`unexpected request: ${url}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/inbox"));
    expect(await screen.findByText("Nothing needs your attention")).toBeInTheDocument();
  });

  it.each([
    "/import",
    "/task/1837/monitor",
    "/task/run-1/plan",
    "/task/run-1/knowledge-graph",
  ])("keeps unsupported route %s visible and renders an explicit 404", async (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "This dashboard page is unavailable" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(route);
    expect(screen.getByTestId("not-found-page")).toHaveTextContent(route);
  });

  it("shows a global executable recovery step when the running dashboard build is stale", async () => {
    vi.mocked(fetchDashboardStatus).mockResolvedValue({
      freshness: "stale",
      pid: 456,
      startedAt: "2026-08-01T02:20:34.000Z",
      loadedBuild: { algorithm: "sha256", hash: "a".repeat(64), files: 10, newestMtimeMs: 1 },
      diskBuild: { algorithm: "sha256", hash: "b".repeat(64), files: 10, newestMtimeMs: 2 },
      diskIsNewer: true,
    });
    render(<MemoryRouter initialEntries={["/missing"]}><AppRoutes /></MemoryRouter>);

    const banner = await screen.findByTestId("dashboard-stale-banner");
    expect(banner).toHaveTextContent("Dashboard code is stale");
    expect(banner).toHaveTextContent("disk now contains a newer build");
    expect(banner).toHaveTextContent("Run on the dashboard host");
    expect(banner).toHaveTextContent(`kill 456 && PORT=${window.location.port || "3000"} flowcrew start`);
    expect(banner).not.toHaveTextContent("Restart the dashboard");
  });

  it("detects a dashboard that becomes stale while the page remains open", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDashboardStatus)
      .mockResolvedValueOnce({
        freshness: "fresh",
        pid: 456,
        startedAt: "2026-08-01T02:20:34.000Z",
        loadedBuild: { algorithm: "sha256", hash: "a".repeat(64), files: 10, newestMtimeMs: 1 },
        diskBuild: { algorithm: "sha256", hash: "a".repeat(64), files: 10, newestMtimeMs: 1 },
        diskIsNewer: false,
      })
      .mockResolvedValue({
        freshness: "stale",
        pid: 456,
        startedAt: "2026-08-01T02:20:34.000Z",
        loadedBuild: { algorithm: "sha256", hash: "a".repeat(64), files: 10, newestMtimeMs: 1 },
        diskBuild: { algorithm: "sha256", hash: "b".repeat(64), files: 10, newestMtimeMs: 2 },
        diskIsNewer: true,
      });
    const view = render(<MemoryRouter initialEntries={["/missing"]}><AppRoutes /></MemoryRouter>);

    try {
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByTestId("dashboard-stale-banner")).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(fetchDashboardStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("dashboard-stale-banner")).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("streams growing live.log content for a running stage without requesting output.md", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly url: string;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(url: string | URL) {
        this.url = String(url);
        FakeEventSource.instances.push(this);
      }

      emit(chunk: string) {
        this.onmessage?.({ data: JSON.stringify(chunk) } as MessageEvent<string>);
      }
    }
    const previousEventSource = globalThis.EventSource;
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
    const running: RunDetailData = {
      runId: "running-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "running",
      stages: [{ id: "implement", role: "coder", depends_on: [], status: "running", retries: 0 }],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    vi.mocked(fetchRunDetail).mockResolvedValue(running);

    try {
      render(<MemoryRouter><RunDetail run={running} /></MemoryRouter>);
      const disclosure = screen.getByText("Show stage log").closest("details") as HTMLDetailsElement;
      expect(disclosure.open).toBe(true);
      disclosure.open = true;
      fireEvent(disclosure, new Event("toggle", { bubbles: true }));
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      expect(FakeEventSource.instances[0].url).toBe("/api/tasks/running-run/stages/implement/live");
      expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("has not produced live output yet");

      act(() => FakeEventSource.instances[0].emit("first live line\n"));
      expect(await screen.findByText(/first live line/)).toBeInTheDocument();
      act(() => FakeEventSource.instances[0].emit("second growing line\n"));
      expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("first live line");
      expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("second growing line");
      expect(screen.getByTestId("stage-output-meta")).toHaveTextContent("Live log · streaming");
      expect(vi.mocked(fetchRunStageOutput)).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent("failed to load");

      vi.mocked(fetchRunDetail).mockRejectedValueOnce(new Error("live refresh offline"));
      act(() => FakeEventSource.instances[0].onerror?.());
      expect(screen.getByTestId("stage-output-meta")).toHaveTextContent("Live log · reconnecting");
      expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("first live line");
      expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("second growing line");
      expect(await screen.findByTestId("run-refresh-error")).toHaveTextContent("live refresh offline");
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: previousEventSource });
    }
  });

  it("uses output.md for a terminal stage", async () => {
    vi.mocked(fetchRunStageOutput).mockResolvedValue({
      text: "terminal output.md truth",
      totalBytes: 24,
      tailBytes: 24,
      truncated: false,
    });
    const terminal: RunDetailData = {
      runId: "terminal-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "complete",
      stages: [{ id: "verify", role: "qa", depends_on: [], status: "complete", retries: 0 }],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(<MemoryRouter><RunDetail run={terminal} /></MemoryRouter>);
    const disclosure = screen.getByText("Show stage log").closest("details") as HTMLDetailsElement;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle", { bubbles: true }));

    expect(await screen.findByText("terminal output.md truth")).toBeInTheDocument();
    expect(fetchRunStageOutput).toHaveBeenCalledWith("terminal-run", "verify", { tailBytes: 256 * 1024 });
  });

  it("keeps the last trustworthy run visible when a background refresh fails", async () => {
    vi.useFakeTimers();
    const running: RunDetailData = {
      runId: "refreshing-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "running",
      stages: [],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    vi.mocked(fetchRunDetail).mockResolvedValueOnce(running).mockRejectedValueOnce(new Error("refresh endpoint offline"));
    const view = render(
      <MemoryRouter initialEntries={["/run/refreshing-run"]}>
        <Routes><Route path="/run/:id" element={<RunDetail />} /></Routes>
      </MemoryRouter>,
    );

    try {
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("running");
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
      expect(screen.getByTestId("run-refresh-error")).toHaveTextContent("refresh endpoint offline");
      expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("running");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps the terminal tail visible when loading the full log fails", async () => {
    vi.mocked(fetchRunStageOutput)
      .mockResolvedValueOnce({ text: "trustworthy terminal tail", totalBytes: 400_000, tailBytes: 256 * 1024, truncated: true })
      .mockRejectedValueOnce(new Error("full output offline"));
    const terminal: RunDetailData = {
      runId: "terminal-tail",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "complete",
      stages: [{ id: "verify", role: "qa", depends_on: [], status: "complete", retries: 0 }],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(
      <MemoryRouter>
        <ToastContainer />
        <RunDetail run={terminal} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("Show stage log"));
    expect(await screen.findByText("trustworthy terminal tail")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load full log" }));
    await waitFor(() => expect(fetchRunStageOutput).toHaveBeenLastCalledWith("terminal-tail", "verify", { full: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Full terminal stage output is unavailable: full output offline");
    expect(screen.getByTestId("stage-output-preview")).toHaveTextContent("trustworthy terminal tail");
  });

  it("explains a terminal stage that produced no output.md without a generic load-failure claim", async () => {
    vi.mocked(fetchRunStageOutput).mockRejectedValue(new Error("404 Not Found"));
    const terminal: RunDetailData = {
      runId: "terminal-without-output",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "failed",
      stages: [{ id: "verify", role: "qa", depends_on: [], status: "failed", retries: 0 }],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(<MemoryRouter><RunDetail run={terminal} /></MemoryRouter>);
    const disclosure = screen.getByText("Show stage log").closest("details") as HTMLDetailsElement;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle", { bubbles: true }));

    expect(await screen.findByText("(This terminal stage produced no output.md.)")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("failed to load");
  });

  it("shows blocking reality-gate evidence immediately and advisory evidence distinctly", () => {
    const gateRun: RunDetailData = {
      runId: "gate-run",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "reality_gate_failed",
      failureReason: "Reality gate blocked: required-build-proof",
      stages: [],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
      realityGate: {
        pass: false,
        checkedAt: "2026-08-01T20:00:00.000Z",
        checksRun: 2,
        results: [
          {
            name: "required-build-proof",
            type: "exec-script-exit-zero",
            pass: false,
            advisory: false,
            details: "script exited 3",
            stderr: { tail: "artifact checksum mismatch", sourceChars: 26, capturedChars: 26, truncated: false },
          },
          { name: "optional-tool", type: "exec-script-exit-zero", pass: false, advisory: true, details: "script exited 6" },
        ],
      },
    };
    render(<MemoryRouter><RunDetail run={gateRun} /></MemoryRouter>);

    const diagnostics = screen.getByTestId("reality-gate-diagnostics");
    expect(diagnostics).toHaveTextContent("required-build-proof");
    expect(diagnostics).toHaveTextContent("script exited 3");
    expect(within(diagnostics).getByText("BLOCKING").closest("article")).toHaveAttribute("data-severity", "blocking");
    expect(within(diagnostics).getByText("ADVISORY").closest("article")).toHaveAttribute("data-severity", "advisory");
    const output = within(diagnostics).getByText("Show captured check output").closest("details") as HTMLDetailsElement;
    expect(output.open).toBe(false);
    fireEvent.click(within(diagnostics).getByText("Show captured check output"));
    expect(output.open).toBe(true);
    expect(diagnostics).toHaveTextContent("artifact checksum mismatch");
  });

  it("treats only a generated terminal summary as the conclusion and delivery", async () => {
    vi.mocked(fetchRunSummary).mockResolvedValue([
      "# Run Summary",
      "",
      "## What was done",
      "- Rebuilt the operator-facing run page.",
      "",
      "## Risks / Notes",
      "- Verify the live stream in the browser.",
      "",
      "## Files changed (5)",
      "- `ui/src/components/RunDetail.tsx` (+10/-2)",
      "- `ui/src/run-page.css` (+8/-0)",
      "- `ui/src/api.ts` (+4/-1)",
      "- `spec/run-page-ui.test.tsx` (+12/-0)",
      "- `spec/run-page-model.test.ts` (+20/-0)",
      "",
      "**Commits (1):**",
      "- abc123 truthful result page",
      "",
      "## Tests",
      "- 12 passed",
    ].join("\n"));
    const terminal: RunDetailData = {
      runId: "terminal-summary",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "complete",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:01:00.000Z",
      stages: [],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: {},
    };
    render(<MemoryRouter><RunDetail run={terminal} /></MemoryRouter>);

    const summary = await screen.findByTestId("run-summary");
    expect(summary).toHaveTextContent("Rebuilt the operator-facing run page");
    expect(summary).toHaveTextContent("ui/src/components/RunDetail.tsx (+10/-2)");
    expect(summary).toHaveTextContent("abc123 truthful result page");
    expect(summary).toHaveTextContent("Verify the live stream in the browser");
    expect(summary).not.toHaveTextContent("12 passed");
  });

  it("keeps progress fallback and summary read failures local to the terminal conclusion", async () => {
    const terminal: RunDetailData = {
      runId: "terminal-local-error",
      projectDir: "/tmp/project",
      workflowName: "default",
      status: "incomplete",
      stages: [{ id: "research", role: "researcher", depends_on: [], status: "complete", retries: 0 }],
      kg: { nodes: [], edges: [] },
      events: [],
      stage_outputs: { research: "useful partial result" },
    };
    vi.mocked(fetchRunSummary).mockResolvedValueOnce("# Progress\n\nStill evaluating candidates.");
    const progressView = render(<MemoryRouter><RunDetail run={terminal} /></MemoryRouter>);
    expect(await screen.findByText(/Recorded progress exists, but it is not a terminal summary/)).toBeInTheDocument();
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("incomplete");
    expect(screen.getByTestId("stage-detail-panel")).toHaveTextContent("research");
    progressView.unmount();

    vi.mocked(fetchRunSummary).mockRejectedValueOnce(new Error("summary endpoint offline"));
    render(<MemoryRouter><RunDetail run={{ ...terminal, runId: "terminal-summary-error" }} /></MemoryRouter>);
    expect(await screen.findByText(/Terminal summary could not be read: summary endpoint offline/)).toBeInTheDocument();
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("incomplete");
    expect(screen.getByTestId("run-cost-summary")).toBeInTheDocument();
  });
});
