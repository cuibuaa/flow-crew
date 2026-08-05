import { describe, expect, it } from "vitest";
import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  humanizeRunEvents,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  parseRunSummary,
  realRunStages,
  runFailureHistory,
  runStatusDescription,
  runUsageTotal,
  stageAttemptLedger,
} from "../ui/src/components/run/model";
import type { RunDetailData, RunStage } from "../ui/src/types";

function run(overrides: Partial<RunDetailData> = {}): RunDetailData {
  return {
    runId: "fixture-run",
    status: "complete",
    stages: [],
    kg: { nodes: [], edges: [] },
    events: [],
    stage_outputs: {},
    ...overrides,
  };
}

describe("run-page presentation model", () => {
  it("uses the complete canonical status vocabulary for the only scene split", () => {
    expect(NON_TERMINAL_RUN_STATUSES).toEqual(["pending", "running", "parked", "awaiting_approval"]);
    expect(TERMINAL_RUN_STATUSES).toEqual([
      "complete",
      "failed",
      "shipped",
      "ceiling_hit",
      "escalated",
      "reality_gate_failed",
      "phase_complete",
      "stopped",
      "incomplete",
    ]);
    for (const status of NON_TERMINAL_RUN_STATUSES) expect(isTerminalRunStatus(status), status).toBe(false);
    for (const status of TERMINAL_RUN_STATUSES) expect(isTerminalRunStatus(status), status).toBe(true);
    expect(TERMINAL_RUN_STATUSES.filter(isSuccessfulRunStatus)).toEqual(["complete", "shipped", "ceiling_hit"]);
    expect(new Set(["ceiling_hit", "incomplete", "reality_gate_failed", "stopped"].map(runStatusDescription)).size).toBe(4);
    expect(runStatusDescription("phase_complete")).toContain("non-success outcome");
    expect(runStatusDescription("phase_complete")).not.toContain("successfully");
  });

  it("keeps a missing current-attempt start unknown instead of borrowing another clock", () => {
    const stage: RunStage = {
      id: "implementation",
      role: "coder",
      depends_on: [],
      status: "running",
      reruns: 1,
      attempts: [
        { index: 1, status: "failed", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z", duration_ms: 60_000 },
        { index: 2, status: "complete", startedAt: "2026-01-01T00:02:00.000Z", completedAt: "2026-01-01T00:03:30.000Z", duration_ms: 90_000 },
      ],
    };

    const early = stageAttemptLedger(stage, Date.parse("2026-01-01T00:04:00.000Z"));
    const late = stageAttemptLedger(stage, Date.parse("2030-01-01T00:00:00.000Z"));
    expect(early.recordedAttempts).toBe(2);
    expect(early.executions).toBe(3);
    expect(early.rows.map((attempt) => attempt.status)).toEqual(["failed", "complete", "running"]);
    expect(early.rows.at(-1)).toMatchObject({ current: true, recorded: false, durationMs: null });
    expect(late.rows.at(-1)?.durationMs).toBeNull();

    const futureLedger = stageAttemptLedger({
      ...stage,
      attempts: [
        ...stage.attempts!,
        { index: 3, status: "running", startedAt: "2026-01-01T00:04:00.000Z", duration_ms: 999 },
      ],
    }, Date.parse("2026-01-01T00:05:00.000Z"));
    expect(futureLedger.recordedAttempts).toBe(2);
    expect(futureLedger.rows.at(-1)).toMatchObject({ current: true, recorded: true, durationMs: 60_000 });
  });

  it("shows every rerun result and duration while retaining a truthful legacy aggregate", () => {
    const stage: RunStage = {
      id: "gate",
      role: "qa",
      depends_on: [],
      status: "failed",
      duration_ms: 6_000,
      attempts: [
        { index: 1, status: "failed", startedAt: "2026-01-01T00:00:00.000Z", duration_ms: 1_000 },
        { index: 2, status: "complete", startedAt: "2026-01-01T00:01:00.000Z", duration_ms: 2_000 },
        { index: 3, status: "failed", startedAt: "2026-01-01T00:02:00.000Z", duration_ms: 3_000 },
      ],
    };
    const ledger = stageAttemptLedger(stage);
    expect(ledger.executions).toBe(3);
    expect(ledger.failedAttempts).toBe(2);
    expect(ledger.rows.map(({ status, durationMs }) => [status, durationMs])).toEqual([
      ["failed", 1_000], ["complete", 2_000], ["failed", 3_000],
    ]);

    const legacy = stageAttemptLedger({ id: "legacy", role: "coder", depends_on: [], status: "complete", duration_ms: 45_000, reruns: 2 });
    expect(legacy).toMatchObject({ legacyAggregate: true, executions: 3, reruns: 2, aggregateDurationMs: 45_000 });
  });

  it("counts real stage aggregates plus supervisor once and marks unknown coverage partial", () => {
    const complete = run({
      stages: [
        { id: "build", role: "coder", depends_on: [], status: "complete", tokens_in: 100, tokens_out: 50 },
        { id: "verify", role: "qa", depends_on: [], status: "complete", attempts: [
          { index: 1, status: "complete", startedAt: "2026-01-01T00:00:00.000Z", tokens_in: 30, tokens_out: 20 },
        ] },
        { id: "_supervisor", role: "supervisor", depends_on: [], status: "complete", tokens_in: 999, tokens_out: 999 },
      ],
      supervisor: {
        status: "complete",
        calls: 1,
        tokens_in: 10,
        tokens_out: 5,
        duration_ms: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        attempts: [],
      },
    });
    expect(realRunStages(complete.stages).map((stage) => stage.id)).toEqual(["build", "verify"]);
    expect(runUsageTotal(complete)).toEqual({ tokens: 215, complete: true, notes: [] });

    const partial = run({ status: "running", stages: [{ id: "build", role: "coder", depends_on: [], status: "running", tokens_in: 7 }] });
    expect(runUsageTotal(partial)).toMatchObject({ tokens: 7, complete: false });
    expect(runUsageTotal(run())).toMatchObject({ tokens: 0, complete: false, notes: ["supervisor usage is unavailable"] });
  });

  it("recognizes only generated terminal summaries and keeps progress separate", () => {
    const terminal = parseRunSummary([
      "# Run Summary",
      "",
      "## What was done",
      "- Delivered the operator view.",
      "",
      "## Files changed (1)",
      "- `ui/src/example.tsx`",
      "",
      "**Commits (1):**",
      "- abc123 example",
      "",
      "## Tests",
      "- 12 passed",
    ].join("\n"));
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind === "terminal") {
      expect(terminal.sections.map(({ kind }) => kind)).toEqual(["conclusion", "delivery", "audit"]);
      expect(terminal.sections[1].lines).toContain("- abc123 example");
    }
    expect(parseRunSummary("# Progress\n\nStill working")).toEqual({ kind: "progress", raw: "# Progress\n\nStill working" });
  });

  it("localizes failures and translates activity without exposing maintenance identifiers", () => {
    const stages: RunStage[] = [
      { id: "build", role: "coder", depends_on: [], status: "complete", attempts: [
        { index: 1, status: "failed", startedAt: "2026-01-01T00:00:00.000Z" },
        { index: 2, status: "complete", startedAt: "2026-01-01T00:01:00.000Z" },
      ] },
      { id: "gate", role: "qa", depends_on: [], status: "failed", is_gate: true },
    ];
    expect(runFailureHistory(stages)).toEqual({
      failedAttempts: 2,
      failedAttemptsExact: false,
      stageIds: ["build", "gate"],
      failedStageIds: ["gate"],
      failedGateIds: ["gate"],
    });

    const activity = humanizeRunEvents([
      { ts: "2026-01-01T00:00:00.000Z", event: "stage_complete", stageId: "build" },
      { ts: "2026-01-01T00:01:00.000Z", event: "attempt_summary_refresh_requested" },
      { ts: "2026-01-01T00:02:00.000Z", event: "future_internal_event", message: "context retained" },
    ]);
    expect(activity.map(({ description }) => description)).toEqual(["Stage completed", "Run activity was recorded"]);
    expect(JSON.stringify(activity)).not.toContain("stage_complete");
    expect(JSON.stringify(activity)).not.toContain("attempt_summary_refresh_requested");
    expect(JSON.stringify(activity)).not.toContain("future_internal_event");
    expect(activity[0].context).toContain("Stage build");
    expect(activity[1].context).toContain("context retained");
  });
});
