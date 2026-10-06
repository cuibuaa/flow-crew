import { describe, expect, it } from "vitest";
import { isRecord, isNonNegativeInteger } from "../ui/src/lib/source-validation";
import { simulationSource } from "../ui/src/lib/simulation-source";
import { isRunStatus } from "../ui/src/lib/run-status";
import {
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "../ui/src/components/run/model";

describe("shared UI source predicates", () => {
  it("keeps malformed wire objects and counts out of both source readers", () => {
    for (const value of [null, undefined, false, 0, "", [], [1]]) {
      expect(isRecord(value)).toBe(false);
    }
    expect(isRecord({})).toBe(true);
    expect(isRecord({ items: [] })).toBe(true);
    for (const value of [null, undefined, "0", -1, 0.5, NaN, Infinity]) {
      expect(isNonNegativeInteger(value)).toBe(false);
    }
    for (const value of [0, 1, 1_000]) expect(isNonNegativeInteger(value)).toBe(true);
  });

  it("recognises bounded simulation labels without marking unrelated source names", () => {
    for (const source of ["llm:mock", "test/fixture", "provider.simulated", "SIMULATION", "test"]) {
      expect(simulationSource(source)).toBe(true);
    }
    for (const source of [undefined, "", "operator", "latest", "testimony", "mockingbird"]) {
      expect(simulationSource(source)).toBe(false);
    }
  });

  it("preserves the old model exports and distinguishes terminal from successful outcomes", () => {
    for (const status of NON_TERMINAL_RUN_STATUSES) {
      expect(isRunStatus(status)).toBe(true);
      expect(isTerminalRunStatus(status)).toBe(false);
      expect(isSuccessfulRunStatus(status)).toBe(false);
    }
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isRunStatus(status)).toBe(true);
      expect(isTerminalRunStatus(status)).toBe(true);
    }
    expect(isSuccessfulRunStatus("phase_complete")).toBe(false);
    expect(isSuccessfulRunStatus("ceiling_hit")).toBe(true);
    expect(isRunStatus("completed")).toBe(false);
    expect(isRunStatus("future_status")).toBe(false);
  });
});
