import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

const CASES = [
  { id: 1, file: "engine-generalization-contracts.test.ts", anchor: "1 — reserves the framework research manifest" },
  { id: 2, file: "engine-generalization-supervisor.test.ts", anchor: "replays the recorded two-GUIDE case" },
  { id: 3, file: "engine-generalization-contracts.test.ts", anchor: "3 — compares and reports rounds" },
  { id: 4, file: "engine-generalization-contracts.test.ts", anchor: "4 — keeps a declared but skipped gate non-passing" },
  { id: 5, file: "engine-generalization-contracts.test.ts", anchor: "5 — rejects terminal condition sets" },
  { id: 6, file: "engine-generalization-brief.test.ts", anchor: "recorded already-crossed target" },
  { id: 7, file: "engine-generalization-setup.test.ts", anchor: "refuses before the first command" },
  { id: 8, file: "engine-generalization-artifacts.test.ts", anchor: "recorded exit-zero replay" },
  { id: 9, file: "engine-generalization-runtime.test.ts", anchor: "9 — routes authored/effective rejection facts" },
  { id: 10, file: "engine-generalization-runtime.test.ts", anchor: "10 — binds a versioned-shape advisory" },
  { id: 11, file: "engine-generalization-contracts.test.ts", anchor: "11 — intersects exact, tree, glob, alias" },
  { id: 12, file: "engine-generalization-runtime.test.ts", anchor: "12 — revalidates terminal writes" },
  { id: 13, file: "engine-generalization-runtime.test.ts", anchor: "13 — rejects reused normalized round evidence" },
  { id: 14, file: "engine-generalization-setup.test.ts", anchor: "declared-input stability binding" },
  { id: 15, file: "engine-generalization-brief.test.ts", anchor: "anti-anchoring field polarity is mention-local" },
  { id: 16, file: "engine-generalization-runtime.test.ts", anchor: "16 — names a proven configured-command intersection" },
  { id: 17, file: "engine-generalization-runtime.test.ts", anchor: "17 — carries the exact no-candidate shape" },
  { id: 18, file: "engine-generalization-setup.test.ts", anchor: "portable existing-worktree inventory" },
  { id: 19, file: "engine-generalization-artifacts.test.ts", anchor: "lexical suffixes are not promoted" },
] as const;

describe("engine-generalization QA replay inventory", () => {
  it("enumerates each numbered situation exactly once", () => {
    expect(CASES.map(({ id }) => id)).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
  });

  it.each(CASES)("maps item $id to a runnable published-spec anchor", ({ file, anchor }) => {
    const source = readFileSync(join(PROJECT_ROOT, "spec", file), "utf8");
    expect(source).toContain(anchor);
    expect(source).not.toMatch(/\b(?:describe|it|test)\.skip\s*\(/u);
  });
});
