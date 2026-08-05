// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import RunDetail from "../ui/src/components/RunDetail";
import { NON_TERMINAL_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../ui/src/components/run/model";
import type { RunDetailData } from "../ui/src/types";

vi.mock("../ui/src/api", () => ({
  fetchRunDetail: vi.fn(),
  fetchRunStageOutput: vi.fn(),
  fetchRunSummary: vi.fn(async () => null),
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
    kg: { nodes: [{ id: "internal", type: "finding", label: "planner-only finding" }], edges: [] },
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
  it.each(NON_TERMINAL_RUN_STATUSES)("renders %s as a truthful non-terminal scene", (status) => {
    const out = markup(fixture(status));
    expect(out).toContain('data-run-scene="non-terminal"');
    expect(out).toContain(`data-testid="canonical-run-status">${status}`);
    expect(out).not.toContain("generated after the run completed");
    expect(out).toContain("Stall signal unknown");
    expect(out).toContain("Current attempt: unknown");
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
    expect(out).not.toContain("planner-only finding");
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
