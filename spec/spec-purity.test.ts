import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverExternalTestFiles,
  environmentKeysWrittenBy,
  formatViolations,
  scanProjectTests,
  scanSource,
  scanTree,
} from "./purity.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const TEST_OWNED_ENV_KEYS = environmentKeysWrittenBy(
  readFileSync(join(PROJECT_ROOT, "vitest.setup.ts"), "utf-8"),
  "vitest.setup.ts",
);

describe("public and tracked-test purity", () => {
  it("keeps every spec source and tracked external test machine-independent", () => {
    const violations = scanProjectTests(PROJECT_ROOT, {
      testOwnedEnvKeys: TEST_OWNED_ENV_KEYS,
    });
    if (violations.length > 0) {
      throw new Error(`Public test purity violations:\n${formatViolations(violations)}`);
    }
  });

  it("keeps the retired legacy paths out of the index and their canonical copies in spec", () => {
    const discovered = discoverExternalTestFiles(PROJECT_ROOT)
      .map((file) => relative(PROJECT_ROOT, file).replaceAll("\\", "/"));
    expect(discovered).toEqual([]);
    for (const path of [
      "spec/acceptance-gate.qa.test.ts",
      "spec/api/campaign-schema.test.ts",
      "spec/dashboard-campaign.test.ts",
      "spec/dashboard-p3p4.test.ts",
      "spec/ui/Inbox.test.tsx",
      "spec/ui/Truthfulness.test.tsx",
      "spec/ui/static-reachability.test.tsx",
    ]) {
      expect(existsSync(join(PROJECT_ROOT, path)), path).toBe(true);
    }
  });

  it("detects every forbidden dependency category with file, line, and rule", () => {
    const cases = [
      { rule: "absolute-home", source: ["/", "home", "/alice/work"].join("") + "/file" },
      { rule: "wsl-mount", source: ["/", "mnt", "/c/work/file"].join("") },
      { rule: "windows-drive", source: ["C", ":", "\\", "work", "\\", "file"].join("") },
      { rule: "private-project", source: ["trading", "_bot"].join("") },
      { rule: "user-home-state", source: ["home", "dir()"].join("") },
      { rule: "network-client", source: ["fet", "ch('https://example.invalid')"].join("") },
      { rule: "real-history", source: ["task", " #", "123"].join("") },
      {
        rule: "real-history",
        source: ["20", "26", "-07-30T00-00-00-a1b2"].join(""),
      },
    ];

    cases.forEach(({ rule, source }) => {
      const violations = scanSource(`const safe = true;\n${source}`, "fixture.ts");
      expect(violations, rule).toContainEqual(expect.objectContaining({
        file: "fixture.ts",
        line: 2,
        rule,
      }));
    });

    const escaping = ["..", "/", "..", "/outside"].join("");
    expect(scanSource(`const path = '${escaping}';`, "fixture.ts")).toContainEqual(
      expect.objectContaining({ file: "fixture.ts", line: 1, rule: "parent-traversal" }),
    );

    const childModule = ["node", ":", "child", "_process"].join("");
    const childSource = [
      `import { spawnSync } from '${childModule}';`,
      "spawnSync('agent-cli', []);",
    ].join("\n");
    expect(scanSource(childSource, "fixture.ts")).toContainEqual(
      expect.objectContaining({ file: "fixture.ts", line: 2, rule: "child-process" }),
    );
  });

  it("resolves parent imports from their real file and rejects direct node_modules paths", () => {
    const localImport = ["..", "/", "..", "/src/components/Inbox"].join("");
    expect(scanSource(`import Inbox from '${localImport}';`, "ui/tests/ui/Inbox.test.tsx"))
      .toEqual([]);

    const dependencyPath = ["..", "/", "..", "/ui/", "node", "_modules/react"].join("");
    expect(scanSource(`import React from '${dependencyPath}';`, "tests/ui/probe.test.tsx"))
      .toContainEqual(expect.objectContaining({
        file: "tests/ui/probe.test.tsx",
        line: 1,
        rule: "direct-node-modules",
      }));
  });

  it("rejects externally required env input but accepts explicit skip and test-owned isolation", () => {
    const unsafe = [
      "const measurementPath = process.env.REQUIRED_MEASUREMENTS;",
      "if (!measurementPath) throw new Error('measurements required');",
      "const measurements = readFileSync(measurementPath, 'utf-8');",
    ].join("\n");
    expect(scanSource(unsafe, "spec/probe.test.ts")).toContainEqual(expect.objectContaining({
      file: "spec/probe.test.ts",
      line: 1,
      rule: "required-env-without-skip",
    }));

    const skipped = [
      "const measurementPath = process.env.OPTIONAL_MEASUREMENTS;",
      "const measurements = measurementPath ? readFileSync(measurementPath, 'utf-8') : undefined;",
      "const measuredIt = measurementPath ? it : it.skip;",
      "measuredIt('uses optional evidence', () => expect(measurements).toBeDefined());",
    ].join("\n");
    expect(scanSource(skipped, "spec/skipped.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const backwardsSkip = [
      "const measurementPath = process.env.BACKWARDS_MEASUREMENTS;",
      "const measuredIt = measurementPath ? it.skip : it;",
      "measuredIt('fails when evidence is absent', () => expect(measurementPath).toBeDefined());",
    ].join("\n");
    expect(scanSource(backwardsSkip, "spec/backwards-skip.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );

    const skipIfMissing = [
      "const measurementPath = process.env.SKIP_IF_MISSING;",
      "describe.skipIf(!measurementPath)('optional evidence', () => {});",
    ].join("\n");
    expect(scanSource(skipIfMissing, "spec/skip-if-missing.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const skipIfPresent = [
      "const measurementPath = process.env.SKIP_IF_PRESENT;",
      "describe.skipIf(measurementPath)('still runs when evidence is absent', () => {});",
    ].join("\n");
    expect(scanSource(skipIfPresent, "spec/skip-if-present.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );

    const isolated = [
      "const previous = process.env.FIXTURE_HOME;",
      "process.env.FIXTURE_HOME = temporaryHome;",
      "afterEach(() => { if (previous === undefined) delete process.env.FIXTURE_HOME;",
      "  else process.env.FIXTURE_HOME = previous; });",
    ].join("\n");
    expect(scanSource(isolated, "spec/isolated.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const setupOwned = "expect(process.env.SUITE_ISOLATION_ROOT).toBeDefined();";
    expect(scanSource(setupOwned, "spec/isolation.test.ts", {
      testOwnedEnvKeys: new Set(["SUITE_ISOLATION_ROOT"]),
    }).filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const defaulted = "const mode = process.env.OPTIONAL_MODE ?? 'portable-default';";
    expect(scanSource(defaulted, "spec/defaulted.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const throwingFallback = [
      "const fixture = process.env.REQUIRED_WITH_THROW ?? (() => {",
      "  throw new Error('external fixture required');",
      "})();",
    ].join("\n");
    expect(scanSource(throwingFallback, "spec/throwing-fallback.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );

    const destructured = [
      "const { REQUIRED_FIXTURE } = process.env;",
      "if (!REQUIRED_FIXTURE) throw new Error('fixture required');",
    ].join("\n");
    expect(scanSource(destructured, "spec/destructured.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );
  });

  it("allows an always-runnable diagnostic toggle that totalizes missing input", () => {
    const source = [
      "const diagnostics = process.env.OPTIONAL_DIAGNOSTICS === '1';",
      "it('always runs', () => expect(typeof diagnostics).toBe('boolean'));",
    ].join("\n");

    expect(scanSource(source, "spec/diagnostic-toggle.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);

    const requiredComparison = [
      "const enabled = process.env.REQUIRED_FLAG === '1';",
      "it('requires the flag', () => expect(enabled).toBe(true));",
    ].join("\n");
    expect(scanSource(requiredComparison, "spec/required-flag.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );
  });

  it("scopes missing-env skip protection to the guarded test instead of the whole key", () => {
    const source = [
      "const measurementPath = process.env.SHARED_MEASUREMENTS;",
      "describe.skipIf(!measurementPath)('optional evidence', () => {});",
      "it('unconditional evidence', () => expect(measurementPath).toBeDefined());",
    ].join("\n");

    expect(scanSource(source, "spec/mixed-env-scope.test.ts")).toContainEqual(
      expect.objectContaining({ line: 1, rule: "required-env-without-skip" }),
    );
  });

  it("recognizes an explicit undefined comparison that skips on missing input", () => {
    const source = [
      "const measurementPath = process.env.OPTIONAL_MEASUREMENTS;",
      "describe.skipIf(measurementPath === undefined)('optional evidence', () => {});",
    ].join("\n");

    expect(scanSource(source, "spec/explicit-undefined-skip.test.ts")
      .filter(({ rule }) => rule === "required-env-without-skip")).toEqual([]);
  });

  it("allows only isolated project-local Node child probes", () => {
    const childModule = ["node", ":", "child", "_process"].join("");
    const source = [
      `import { spawnSync } from '${childModule}';`,
      "spawnSync(process.execPath, ['script.js'], {",
      "  cwd: projectRoot,",
      "  env: { ...process.env, HOME: temporaryHome, FC_HOME: temporaryFcHome },",
      "});",
    ].join("\n");
    expect(scanSource(source, "spec/project-probe.test.ts")
      .filter(({ rule }) => rule === "child-process")).toEqual([]);
  });

  it("detects both direct user-home access forms and all network clients", () => {
    const requiredHome = ["process", ".env.", "HOME"].join("");
    expect(scanSource(requiredHome, "fixture.ts").map(({ rule }) => rule))
      .toEqual(expect.arrayContaining(["required-env-without-skip", "user-home-state"]));

    const sources = [
      ["axi", "os.get('/resource')"].join(""),
      ["node", "-", "fetch"].join(""),
    ];
    sources.forEach((source) => {
      expect(scanSource(source, "fixture.ts").map(({ rule }) => rule)).toContain("network-client");
    });
  });

  it("ignores comment trivia without hiding executable code on the same line", () => {
    const forbiddenPath = ["/", "home", "/alice/work/"].join("");
    const clientCall = ["fet", "ch('/resource')"].join("");
    const privateName = ["btc", "_explore"].join("");
    const commentsOnly = [
      `// ${forbiddenPath}`,
      `/* ${clientCall} */`,
      `const safe = true; // ${privateName}`,
    ].join("\n");
    expect(scanSource(commentsOnly, "comments.ts")).toEqual([]);

    const mixed = `/* ${forbiddenPath} */ ${clientCall}`;
    expect(scanSource(mixed, "mixed.ts")).toEqual([
      expect.objectContaining({ file: "mixed.ts", line: 1, rule: "network-client" }),
    ]);
  });

  it("does not mistake portable timestamps or diagnostic text for machine state", () => {
    const portable = [
      "const generatedAt = '2026-07-30T00:00:00.000Z';",
      "const message = 'guards:\\nall checks passed';",
    ].join("\n");
    expect(scanSource(portable, "portable.ts")).toEqual([]);
  });

  it("scans source files recursively", () => {
    const root = mkdtempSync(join(tmpdir(), "flowcrew-purity-"));
    try {
      const nested = join(root, "nested");
      mkdirSync(nested);
      const source = ["/", "home", "/alice/work/"].join("");
      writeFileSync(join(nested, "probe.ts"), source, "utf-8");
      writeFileSync(join(root, "ignored.txt"), source, "utf-8");

      expect(scanTree(root, root)).toEqual([
        expect.objectContaining({
          file: "nested/probe.ts",
          line: 1,
          rule: "absolute-home",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans ESM and CommonJS TypeScript module sources", () => {
    const root = mkdtempSync(join(tmpdir(), "flowcrew-purity-modules-"));
    try {
      const source = ["/", "home", "/alice/work/"].join("");
      writeFileSync(join(root, "probe.cts"), source, "utf-8");
      writeFileSync(join(root, "probe.mts"), source, "utf-8");

      expect(scanTree(root, root)).toEqual([
        expect.objectContaining({
          file: "probe.cts",
          line: 1,
          rule: "absolute-home",
        }),
        expect.objectContaining({
          file: "probe.mts",
          line: 1,
          rule: "absolute-home",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans only Git-tracked external tests in a checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "flowcrew-purity-tracked-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "spec"));
      mkdirSync(join(root, "tests"));
      mkdirSync(join(root, "ui", "tests", "ui"), { recursive: true });
      const forbidden = ["/", "home", "/alice/work/file"].join("");
      writeFileSync(join(root, "spec", "safe.ts"), "export {};\n", "utf-8");
      writeFileSync(join(root, "tests", "tracked.test.ts"), `const path = '${forbidden}';\n`, "utf-8");
      writeFileSync(join(root, "tests", "untracked.test.ts"), `const path = '${forbidden}';\n`, "utf-8");
      writeFileSync(join(root, "ui", "tests", "ui", "portable.test.tsx"), "export {};\n", "utf-8");
      const trackedPaths = ["tests/tracked.test.ts", "ui/tests/ui/portable.test.tsx"];

      expect(discoverExternalTestFiles(root, { trackedPaths }).map((file) => relative(root, file)))
        .toEqual(trackedPaths);
      expect(scanProjectTests(root, { trackedPaths })).toEqual([
        expect.objectContaining({
          file: "tests/tracked.test.ts",
          line: 1,
          rule: "absolute-home",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to every archived external test when Git metadata is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "flowcrew-purity-archive-"));
    try {
      mkdirSync(join(root, "spec"));
      mkdirSync(join(root, "tests"));
      mkdirSync(join(root, "ui", "tests", "ui"), { recursive: true });
      writeFileSync(join(root, "spec", "safe.ts"), "export {};\n", "utf-8");
      writeFileSync(
        join(root, "tests", "archive.test.ts"),
        "const fixture = process.env.ARCHIVE_ONLY_INPUT;\n",
        "utf-8",
      );
      writeFileSync(join(root, "ui", "tests", "ui", "portable.test.tsx"), "export {};\n", "utf-8");

      const discovered = discoverExternalTestFiles(root).map((file) => relative(root, file));
      expect(discovered).toEqual(["tests/archive.test.ts", "ui/tests/ui/portable.test.tsx"]);
      const violations = scanProjectTests(root);
      expect(formatViolations(violations)).toBe(
        "tests/archive.test.ts:1 [required-env-without-skip] "
          + "environment variable ARCHIVE_ONLY_INPUT is externally required; missing input must skip instead of fail",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans the complete spec tree even when Git reports no tracked paths", () => {
    const root = mkdtempSync(join(tmpdir(), "flowcrew-purity-untracked-spec-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "spec"));
      const forbidden = ["/", "home", "/alice/work/file"].join("");
      writeFileSync(join(root, "spec", "untracked-probe.ts"), `const path = '${forbidden}';\n`, "utf-8");

      expect(scanProjectTests(root, { trackedPaths: [] })).toEqual([
        expect.objectContaining({
          file: "spec/untracked-probe.ts",
          line: 1,
          rule: "absolute-home",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
