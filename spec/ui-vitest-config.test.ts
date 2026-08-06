import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const UI_ROOT = join(PROJECT_ROOT, "ui");
const PUBLIC_UI_TEST_ROOT = join(PROJECT_ROOT, "spec", "ui");
const rootRequire = createRequire(join(PROJECT_ROOT, "package.json"));
const uiRequire = createRequire(join(UI_ROOT, "package.json"));
const ROOT_DEPENDENCIES = dirname(dirname(rootRequire.resolve("typescript/package.json")));
const UI_DEPENDENCIES = dirname(dirname(uiRequire.resolve("vitest/package.json")));
const VITEST_CLI = join(dirname(uiRequire.resolve("vitest/package.json")), "vitest.mjs");
const EXPECTED_UI_TESTS = [
  "spec/ui/Inbox.test.tsx",
  "spec/ui/Truthfulness.test.tsx",
  "spec/ui/static-reachability.test.tsx",
];

interface UiTestList {
  cases: number;
  files: string[];
}

function listUiTests(cwd: string, args: string[], sandbox: string): UiTestList {
  const result = spawnSync(process.execPath, [VITEST_CLI, "list", "--json", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: join(sandbox, "home"),
      FC_HOME: join(sandbox, "fc-home"),
      NO_COLOR: "1",
    },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(report)) throw new Error("Vitest list did not return an array");
  const files = report.map((row) => {
    if (!row || typeof row !== "object" || typeof Reflect.get(row, "file") !== "string") {
      throw new Error("Vitest list row has no file path");
    }
    return resolve(cwd, Reflect.get(row, "file") as string).replaceAll("\\", "/");
  });
  return { cases: report.length, files: [...new Set(files)].sort() };
}

function relativeFiles(list: UiTestList, repositoryRoot: string): string[] {
  return list.files
    .map((file) => relative(repositoryRoot, file).replaceAll("\\", "/"))
    .sort();
}

describe("H-M7-ui-cwd-discovery", () => {
  it("discovers the governed UI tests from both working directories and a clean archive", () => {
    // realpath the sandbox: on macOS tmpdir() is /var/folders/... and /var is a
    // symlink to /private/var. Vitest reports test files by their resolved path,
    // so an unresolved root makes relative() emit a chain of ../.. instead of the
    // expected spec/ui/... paths.
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "flowcrew-ui-vitest-config-")));
    try {
      mkdirSync(join(sandbox, "home"), { recursive: true });
      mkdirSync(join(sandbox, "fc-home"), { recursive: true });
      const fromRepository = listUiTests(
        PROJECT_ROOT,
        ["--config", join(UI_ROOT, "vitest.config.ts")],
        sandbox,
      );
      const fromUi = listUiTests(UI_ROOT, [], sandbox);

      expect(fromRepository).toEqual(fromUi);
      expect(fromUi.cases).toBe(58);
      expect(relativeFiles(fromUi, PROJECT_ROOT)).toEqual(EXPECTED_UI_TESTS);
      expect(fromUi.files.every((file) => file.startsWith(`${PUBLIC_UI_TEST_ROOT.replaceAll("\\", "/")}/`)))
        .toBe(true);

      const archiveRoot = join(sandbox, "archive");
      const archiveUiRoot = join(archiveRoot, "ui");
      mkdirSync(join(archiveRoot, "spec"), { recursive: true });
      mkdirSync(archiveUiRoot, { recursive: true });
      copyFileSync(join(PROJECT_ROOT, "package.json"), join(archiveRoot, "package.json"));
      copyFileSync(join(UI_ROOT, "package.json"), join(archiveUiRoot, "package.json"));
      copyFileSync(
        join(UI_ROOT, "vitest.config.ts"),
        join(archiveUiRoot, "vitest.config.ts"),
      );
      cpSync(join(PROJECT_ROOT, "spec", "ui"), join(archiveRoot, "spec", "ui"), {
        recursive: true,
      });
      cpSync(join(UI_ROOT, "src"), join(archiveUiRoot, "src"), { recursive: true });
      symlinkSync(
        ROOT_DEPENDENCIES,
        join(archiveRoot, basename(ROOT_DEPENDENCIES)),
        "dir",
      );
      symlinkSync(
        UI_DEPENDENCIES,
        join(archiveUiRoot, basename(UI_DEPENDENCIES)),
        "dir",
      );

      const fromArchiveRepository = listUiTests(
        archiveRoot,
        ["--config", join(archiveUiRoot, "vitest.config.ts")],
        sandbox,
      );
      const fromArchiveUi = listUiTests(archiveUiRoot, [], sandbox);
      expect(fromArchiveRepository).toEqual(fromArchiveUi);
      expect(fromArchiveUi.cases).toBe(fromUi.cases);
      expect(relativeFiles(fromArchiveUi, archiveRoot)).toEqual(EXPECTED_UI_TESTS);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
