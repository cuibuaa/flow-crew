import { afterAll, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface VitestFileIsolation {
  root: string;
  home: string;
  fcHome: string;
  cleanup: () => void;
}

interface VitestIsolationRegistry {
  roots: Set<string>;
  cleanupRoot: (root: string) => void;
  cleanupAll: () => void;
}

const isolationRegistryKey = Symbol.for("flowcrew.vitest.file-isolation.registry");

function getIsolationRegistry(): VitestIsolationRegistry {
  const existing = Reflect.get(process, isolationRegistryKey) as VitestIsolationRegistry | undefined;
  if (existing) return existing;

  const roots = new Set<string>();
  const cleanupRoot = (root: string) => {
    rmSync(root, { recursive: true, force: true });
  };
  const registry: VitestIsolationRegistry = {
    roots,
    cleanupRoot,
    cleanupAll: () => {
      for (const root of roots) {
        try {
          cleanupRoot(root);
        } catch {
          // Process exit cleanup is best-effort; afterAll reports synchronous failures.
        }
      }
    },
  };
  Reflect.set(process, isolationRegistryKey, registry);
  process.once("exit", registry.cleanupAll);
  return registry;
}

function createVitestFileIsolation(): VitestFileIsolation {
  const root = mkdtempSync(join(tmpdir(), "flowcrew-vitest-file-"));
  const home = join(root, "home");
  const fcHome = join(home, ".fc");
  mkdirSync(fcHome, { recursive: true });
  const registry = getIsolationRegistry();
  registry.roots.add(root);

  return {
    root,
    home,
    fcHome,
    cleanup: () => {
      registry.cleanupRoot(root);
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousFcHome = process.env.FC_HOME;
const previousIsolationRoot = process.env.FLOWCREW_VITEST_ROOT;
const isolation = createVitestFileIsolation();

// setupFiles run before the test module graph. HOME covers modules that call
// homedir() directly; the setter covers store.ts's process-level override.
process.env.HOME = isolation.home;
process.env.USERPROFILE = isolation.home;
delete process.env.FC_HOME;
process.env.FLOWCREW_VITEST_ROOT = isolation.root;

const store = await import("./src/store.js");
const runEvents = await import("./src/run-events.js");
store.setFcGlobalDir(isolation.fcHome);

// Only browser-environment files pay to install DOM matchers. Test-file
// environment pragmas are resolved before setupFiles run.
if (expect.getState().environment === "jsdom") {
  await import("@testing-library/jest-dom/vitest");
}

afterAll(() => {
  // Keep the loaded store pointed at the disposable root while teardown runs;
  // a late callback must never fall back to the developer's real ~/.fc.
  // Cancel the known 250ms summary-refresh debounce synchronously instead of
  // sleeping in every spec file. The process registry remains the final
  // fallback for unrelated callbacks that outlive teardown.
  store.setFcGlobalDir(isolation.fcHome);
  runEvents.clearAttemptSummaryRefreshDebounce();
  isolation.cleanup();
  restoreEnv("HOME", previousHome);
  restoreEnv("USERPROFILE", previousUserProfile);
  restoreEnv("FC_HOME", previousFcHome);
  restoreEnv("FLOWCREW_VITEST_ROOT", previousIsolationRoot);
});
