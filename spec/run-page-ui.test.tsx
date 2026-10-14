// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTask, fetchRunDetail, fetchRunStageOutput, resumeTask } from "../ui/src/api";
import RunDetail from "../ui/src/components/RunDetail";
import { NON_TERMINAL_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../ui/src/components/run/model";
import type { RunDetailData } from "../ui/src/types";

vi.mock("../ui/src/api", () => ({
  fetchRunDetail: vi.fn(),
  fetchRunStageOutput: vi.fn(),
  fetchRunSummary: vi.fn(async () => null),
  cancelTask: vi.fn(),
  resumeTask: vi.fn(),
}));

function fixture(status: string): RunDetailData {
  return {
    runId: `fixture-${status}`,
    projectDir: "fixture-project",
    workflowName: "fixture-workflow",
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: TERMINAL_RUN_STATUSES.includes(status as never) ? "2026-01-01T00:03:00.000Z" : undefined,
    stages: [{
      id: "implementation",
      role: "coder",
      depends_on: [],
      status: NON_TERMINAL_RUN_STATUSES.includes(status as never) ? "running" : "complete",
      attempts: NON_TERMINAL_RUN_STATUSES.includes(status as never)
        ? [{ index: 1, status: "failed", startedAt: "2026-01-01T00:00:00.000Z", duration_ms: 1_000 }]
        : [{ index: 1, status: "complete", startedAt: "2026-01-01T00:00:00.000Z", duration_ms: 1_000 }],
    }],
    events: [
      { ts: "2026-01-01T00:00:00.000Z", event: "stage_complete", stage: "implementation" },
      { ts: "2026-01-01T00:00:01.000Z", event: "attempt_summary_refresh_requested" },
    ],
    stage_outputs: { implementation: "recorded output" },
  };
}

function markup(run: RunDetailData): string {
  return renderToStaticMarkup(<MemoryRouter><RunDetail run={run} /></MemoryRouter>);
}

describe("run-page canonical scenes", () => {
  it('shows same-ID archived iterations separately without putting them in the current DAG', () => {
    const data = fixture('complete');
    data.stageHistory = [1, 2].map(iteration => ({
      stageId: 'retired', iteration,
      status: { status: iteration === 1 ? 'failed' : 'complete', attempts: [{ index: 1, status: iteration === 1 ? 'failed' : 'complete', startedAt: `2026-01-01T00:0${iteration}:00.000Z`, duration_ms: 1000 }] },
    }));
    const out = markup(data);
    expect(out).toContain('retired [iteration 1, archived]');
    expect(out).toContain('retired [iteration 2, archived]');
    expect(out).toContain('data-testid="attempt-ledger-retired-iteration-1"');
    expect(out).toContain('data-testid="failed-attempt-count">1');
    expect(out).not.toContain('dag-node-retired');
    expect(out).toContain('Final failed stages</dt><dd>none recorded');
  });
  it.each(NON_TERMINAL_RUN_STATUSES)("renders %s as a truthful non-terminal scene", (status) => {
    const out = markup(fixture(status));
    expect(out).toContain('data-run-scene="non-terminal"');
    expect(out).toContain(`data-testid="canonical-run-status">${status}`);
    expect(out).not.toContain("generated after the run completed");
    expect(out).toContain("Stall signal unknown");
    expect(out).toContain("Current execution: unknown");
  });

  it.each(TERMINAL_RUN_STATUSES)("renders %s literally as a terminal result", (status) => {
    const out = markup(fixture(status));
    expect(out).toContain('data-run-scene="terminal"');
    expect(out).toContain(`data-testid="canonical-run-status">${status}`);
    expect(out).toContain("What this run produced");
    expect(out).not.toContain("Run in progress");
  });

  it("keeps modern parked approvals separate from legacy plan approval", () => {
    const parked = markup({ ...fixture("parked"), stages: [] });
    expect(parked).toContain('data-testid="parked-approval-banner"');
    expect(parked).toContain('href="/inbox"');

    const legacy = markup({ ...fixture("awaiting_approval"), stages: [] });
    expect(legacy).toContain('data-testid="legacy-approval-banner"');
    expect(legacy).toContain("legacy plan-review state");
    expect(legacy).not.toContain('href="/inbox"');
    expect(legacy).not.toContain('data-testid="parked-approval-banner"');
  });

  it("describes phase_complete as a distinct non-success terminal outcome", () => {
    const out = markup(fixture("phase_complete"));
    expect(out).toContain("phase_complete");
    expect(out).toContain("non-success outcome");
    expect(out).not.toContain("ended successfully");
  });

  it("keeps engine-only quantities out of the human DOM and humanizes retained activity", () => {
    const out = markup({
      ...fixture("complete"),
      stages: [...fixture("complete").stages, { id: "_supervisor", role: "supervisor", depends_on: [], status: "complete", tokens_in: 50, tokens_out: 25 }],
    });
    expect(out).not.toContain("_supervisor");
    expect(out).not.toContain("events.jsonl");
    expect(out).not.toContain("stage_complete");
    expect(out).not.toContain("attempt_summary_refresh_requested");
    expect(out).toContain("Stage completed");
  });

  it("keeps a failed gate and unavailable Reality Gate diagnostics visible", () => {
    const out = markup({
      ...fixture("reality_gate_failed"),
      failureReason: "Required delivery proof was rejected.",
      stages: [{ id: "delivery_gate", role: "qa", depends_on: [], status: "failed", is_gate: true }],
      realityGate: { pass: false, checkedAt: "2026-01-01T00:03:00.000Z", checksRun: 0, results: [] },
    });
    expect(out).toContain("Required delivery proof was rejected.");
    expect(out).toContain("Reality Gate rejected this run");
    expect(out).toContain("Inspect failed stage");
    expect(out).not.toContain("Retry failed stage");
  });
});

describe("registered run controls", () => {
  beforeEach(() => {
    vi.mocked(fetchRunStageOutput).mockResolvedValue({ text: "recorded output", totalBytes: 15, tailBytes: 15, truncated: false });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it.each(["stopped", "failed", "incomplete"])("offers Resume beside the disabled Cancel control for %s", status => {
    render(<MemoryRouter><RunDetail run={fixture(status)} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  });

  it.each(["running", "parked", "complete", "phase_complete"])("does not offer continuation for %s", status => {
    render(<MemoryRouter><RunDetail run={fixture(status)} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("cancels the displayed run and makes Resume available after settlement", async () => {
    const running = fixture("running");
    vi.mocked(cancelTask).mockResolvedValue({ ok: true });
    vi.mocked(fetchRunDetail).mockResolvedValue({ ...running, status: "stopped" });
    render(<MemoryRouter><RunDetail run={running} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
    expect(cancelTask).toHaveBeenCalledWith(running.runId);
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("stopped");
  });

  it("keeps the stopped status while resume is queued, then refreshes the same run", async () => {
    const stopped = fixture("stopped");
    vi.mocked(fetchRunDetail).mockResolvedValue(stopped);
    vi.mocked(resumeTask).mockResolvedValue({ new_attempt: 1, unit: "mock-resumed-launch" });
    render(<MemoryRouter initialEntries={[`/run/${stopped.runId}`]}><Routes><Route path="/run/:id" element={<RunDetail />} /></Routes></MemoryRouter>);
    await screen.findByRole("button", { name: "Resume" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume" })); });
    expect(resumeTask).toHaveBeenCalledWith(stopped.runId);
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("stopped");
    expect(screen.getByText("Resume queued; waiting for this run to continue.")).toBeInTheDocument();
    vi.mocked(fetchRunDetail).mockResolvedValue({ ...stopped, status: "running", completedAt: undefined });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("running");
    expect(screen.queryByText("Resume queued; waiting for this run to continue.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows a refused resume and leaves the saved run visible for inspection", async () => {
    vi.mocked(resumeTask).mockRejectedValue(new Error("run has no registered task to resume"));
    render(<MemoryRouter><RunDetail run={fixture("failed")} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("run has no registered task to resume");
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("failed");
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    expect(fetchRunDetail).not.toHaveBeenCalled();
  });

  it("clears queued controls on navigation and ignores the previous run's late refresh", async () => {
    const stopped = fixture("stopped");
    const completed = fixture("complete");
    let finishRefresh!: (run: RunDetailData) => void;
    vi.mocked(fetchRunDetail)
      .mockResolvedValueOnce(stopped)
      .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }))
      .mockResolvedValue(completed);
    vi.mocked(resumeTask).mockResolvedValue({ new_attempt: 1, unit: "mock-resumed-launch" });
    render(<MemoryRouter initialEntries={[`/run/${stopped.runId}`]}><Link to={`/run/${completed.runId}`}>Next run</Link><Routes><Route path="/run/:id" element={<RunDetail />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByText("Resume queued; waiting for this run to continue.");
    fireEvent.click(screen.getByRole("link", { name: "Next run" }));
    await waitFor(() => expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("complete"));
    await act(async () => { finishRefresh({ ...stopped, status: "running", completedAt: undefined }); });
    expect(screen.getByTestId("canonical-run-status")).toHaveTextContent("complete");
    expect(screen.queryByText("Resume queued; waiting for this run to continue.")).not.toBeInTheDocument();
  });
});
