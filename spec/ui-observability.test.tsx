// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import RunDetail from "../ui/src/components/RunDetail";
import type { RunDetailData, RunStage } from "../ui/src/types";

vi.mock("../ui/src/api", () => ({
  fetchRunDetail: vi.fn(),
  fetchRunStageOutput: vi.fn(),
  fetchRunSummary: vi.fn(async () => null),
}));

function runDetail(stage: RunStage, extra: Partial<RunDetailData> = {}): RunDetailData {
  return {
    runId: "run-ui-observability",
    workflowName: "observability-test",
    status: "complete",
    stages: [stage],
    kg: { nodes: [], edges: [] },
    events: [],
    stage_outputs: {},
    ...extra,
  };
}

function renderRun(run: RunDetailData) {
  document.body.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <RunDetail run={run} />
    </MemoryRouter>,
  );
  return document.body;
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe("run-detail execution observability", () => {
  it("shows every attempt result and duration instead of an overwritten aggregate", () => {
    renderRun(runDetail({
      id: "acceptance_gate",
      role: "qa",
      depends_on: [],
      is_gate: true,
      status: "complete",
      retries: 0,
      reruns: 1,
      duration_ms: 150_000,
      attempts: [
        {
          index: 1,
          startedAt: "2026-07-31T00:00:00.000Z",
          completedAt: "2026-07-31T00:01:30.000Z",
          status: "failed",
          duration_ms: 90_000,
        },
        {
          index: 2,
          startedAt: "2026-07-31T00:02:00.000Z",
          completedAt: "2026-07-31T00:03:00.000Z",
          status: "complete",
          duration_ms: 60_000,
        },
      ],
      artifact_count: 1,
    }));

    const history = byTestId("attempt-ledger-acceptance_gate");
    expect(history.textContent).toContain("2 executions · 1 failed");
    expect(history.textContent).toContain("Attempt 1failed1.5m");
    expect(history.textContent).toContain("Attempt 2complete1.0m");
  });

  it("labels a legacy aggregate when per-attempt history is absent", () => {
    renderRun(runDetail({
      id: "build",
      role: "coder",
      depends_on: [],
      status: "complete",
      retries: 0,
      duration_ms: 45_000,
      artifact_count: 2,
    }));

    const history = byTestId("attempt-ledger-build");
    expect(history.textContent).toContain("1 execution · 0 failed");
    expect(history.textContent).toContain("Legacy aggregate: complete · 45.0s cumulative");
    expect(history.textContent).toContain("Per-attempt history is unavailable");
  });

  it("includes supervisor usage once in the run total without a stage row or DAG node", () => {
    renderRun(runDetail({
      id: "build",
      role: "coder",
      depends_on: [],
      status: "complete",
      duration_ms: 1_000,
    }, {
      supervisor: {
        status: "complete",
        calls: 7,
        tokens_in: 8_765,
        tokens_out: 12_345,
        duration_ms: 90_000,
        startedAt: "2026-07-31T00:00:00.000Z",
        completedAt: "2026-07-31T00:01:30.000Z",
        attempts: [],
      },
    }));

    const usage = byTestId("run-cost-summary");
    expect(usage.textContent).toContain("21,110 tokens");
    expect(usage.textContent).toContain("including recorded supervisor usage");

    const dag = byTestId("stage-dag");
    expect(dag.querySelector('[data-testid="dag-node-build"]')).not.toBeNull();
    expect(dag.textContent).not.toContain("_supervisor");
    expect(document.querySelector('[data-testid="dag-node-_supervisor"]')).toBeNull();
    expect(document.body.textContent).not.toContain("_supervisor");
    expect(document.body.textContent?.match(/21,110 tokens/g)).toHaveLength(1);
  });
});
