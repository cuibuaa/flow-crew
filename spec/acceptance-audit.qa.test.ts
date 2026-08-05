import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSource } from "./purity.js";
import { TaskRegistry } from "../src/task-registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRegistry(): TaskRegistry {
  const baseDir = mkdtempSync(join(tmpdir(), "flowcrew-e5a-acceptance-"));
  temporaryDirectories.push(baseDir);
  return new TaskRegistry({ baseDir });
}

function requiredEnvViolations(source: string) {
  return scanSource(source, "spec/env-probe.test.ts")
    .filter(({ rule }) => rule === "required-env-without-skip");
}

describe("acceptance audit", () => {
  it("does not classify an always-runnable diagnostic toggle as required input", () => {
    const source = [
      "const diagnostics = process.env.OPTIONAL_DIAGNOSTICS === '1';",
      "it('always runs', () => expect(typeof diagnostics).toBe('boolean'));",
    ].join("\n");

    expect(requiredEnvViolations(source)).toEqual([]);
  });

  it("does not let one skipped suite hide an unconditional dependency on the same env key", () => {
    const source = [
      "const measurementPath = process.env.SHARED_MEASUREMENTS;",
      "describe.skipIf(!measurementPath)('optional evidence', () => {});",
      "it('still requires evidence', () => expect(measurementPath).toBeDefined());",
    ].join("\n");

    expect(requiredEnvViolations(source)).toContainEqual(expect.objectContaining({
      line: 1,
      rule: "required-env-without-skip",
    }));
  });

  it("accepts an explicit undefined comparison that skips when input is missing", () => {
    const source = [
      "const measurementPath = process.env.OPTIONAL_MEASUREMENTS;",
      "describe.skipIf(measurementPath === undefined)('optional evidence', () => {});",
    ].join("\n");

    expect(requiredEnvViolations(source)).toEqual([]);
  });

  it("quarantines an invalid UTF-8 row after preserving the original bytes in backup", () => {
    const registry = temporaryRegistry();
    registry.create({ name: "preserved", projectDir: registry.baseDir });
    appendFileSync(registry.registryPath, Buffer.from([0xff, 0x0a]));
    const original = readFileSync(registry.registryPath);
    expect(registry.health()).toEqual({ unreadableRecords: 1 });

    const report = registry.repair({ apply: true });

    expect(report.quarantinedRecords).toBe(1);
    expect(existsSync(report.backupPath!)).toBe(true);
    expect(readFileSync(report.backupPath!)).toEqual(original);
    expect(existsSync(report.quarantinePath!)).toBe(true);
    expect(registry.health()).toEqual({ unreadableRecords: 0 });
  });

  it("keeps update fail-closed while naming both repair preview and apply commands", () => {
    const registry = temporaryRegistry();
    const task = registry.create({ name: "damaged", projectDir: registry.baseDir });
    appendFileSync(registry.registryPath, "{damaged row\n", "utf-8");

    expect(() => registry.update(task.id, { notes: "must not append" })).toThrowError(
      /flowcrew doctor --repair-registry[\s\S]*flowcrew doctor --repair-registry --apply/,
    );
  });
});
