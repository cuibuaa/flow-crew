import { afterAll } from "vitest";
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
const lateCallbackGraceMs = 300;

// setupFiles run before the test module graph. HOME covers modules that call
// homedir() directly; the setter covers store.ts's process-level override.
process.env.HOME = isolation.home;
process.env.USERPROFILE = isolation.home;
delete process.env.FC_HOME;
process.env.FLOWCREW_VITEST_ROOT = isolation.root;

const store = await import("./src/store.js");
store.setFcGlobalDir(isolation.fcHome);

afterAll(async () => {
  // Keep the loaded store pointed at the disposable root while teardown runs;
  // a late callback must never fall back to the developer's real ~/.fc. The
  // summary-refresh debounce is 250ms, so wait through that window and remove
  // the root again if such a callback recreates it. The process registry is a
  // final fallback for later callbacks.
  store.setFcGlobalDir(isolation.fcHome);
  isolation.cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, lateCallbackGraceMs));
  isolation.cleanup();
  restoreEnv("HOME", previousHome);
  restoreEnv("USERPROFILE", previousUserProfile);
  restoreEnv("FC_HOME", previousFcHome);
  restoreEnv("FLOWCREW_VITEST_ROOT", previousIsolationRoot);
});
