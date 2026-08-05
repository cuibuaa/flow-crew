import { EventEmitter } from "node:events";
// Upgrade warning: the custom pool/worker exports below are Vitest experimental
// APIs. Before upgrading Vitest, verify the vitest/node exports and types, the
// createPoolWorker contract, the real `started` handshake, and the ready-aware
// worker regression tests. If the API disappears, temporarily remove this pool
// and fall back to maxWorkers: 1; the measured root-suite cost is
// 437.80s -> 1131.80s.
import {
  ForksPoolWorker,
  type PoolOptions,
  type PoolWorker,
  type WorkerRequest,
} from "vitest/node";
import { defineConfig } from "vitest/config";

export const READY_AWARE_STARTUP_EXTENSION_MS = 50_000;
export const READY_AWARE_STARTUP_DEADLINE_MS = 120_000;

interface ReadyAwareForkWorkerDependencies {
  delegate?: PoolWorker;
  writeDiagnostic?: (message: string) => void;
  now?: () => number;
}

/**
 * Vitest 4.1.5 starts its 60s handshake clock before a worker imports and
 * initializes jsdom. On drvfs, the loaded probe measured concurrent jsdom
 * imports taking up to 117s, so a healthy worker can be rejected before it
 * reports `started`.
 *
 * This wrapper never retries a test. It buffers only run/collect until the
 * underlying ForksPoolWorker sends its real startup acknowledgement, with a
 * separate bounded deadline and an explicit diagnostic when the extension is
 * used. Other worker errors and all test results pass through unchanged.
 */
export class ReadyAwareForkWorker implements PoolWorker {
  readonly name = "forks";
  readonly cacheFs = true;

  private readonly delegate: PoolWorker;
  private readonly events = new EventEmitter();
  private readonly pending: WorkerRequest[] = [];
  private startupExtended = false;
  private startupStartedAt = 0;
  private startupExtensionTimer?: NodeJS.Timeout;
  private startupDeadlineTimer?: NodeJS.Timeout;
  private realStartupComplete = false;
  private startupFailed = false;
  private readonly writeDiagnostic: (message: string) => void;
  private readonly now: () => number;

  constructor(options: PoolOptions, dependencies: ReadyAwareForkWorkerDependencies = {}) {
    this.delegate = dependencies.delegate ?? new ForksPoolWorker(options);
    this.writeDiagnostic =
      dependencies.writeDiagnostic ?? ((message) => process.stderr.write(message));
    this.now = dependencies.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.delegate.start();
    this.delegate.on("error", (error) => this.events.emit("error", error));
    this.delegate.on("exit", (code) => this.events.emit("exit", code));
    this.delegate.on("message", this.handleDelegateMessage);
  }

  on(event: string, callback: (arg: unknown) => void): void {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void): void {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest): void {
    if (message.type === "start") {
      this.startupStartedAt = this.now();
      this.startupExtensionTimer = setTimeout(() => {
        this.startupExtended = true;
        this.writeDiagnostic(
          `[flowcrew-vitest] worker startup exceeded ${READY_AWARE_STARTUP_EXTENSION_MS}ms; ` +
            "waiting for the real ready signal (startup only, no test retry).\n",
        );
        this.events.emit("message", {
          __vitest_worker_response__: true,
          type: "started",
        });
      }, READY_AWARE_STARTUP_EXTENSION_MS);
      this.startupDeadlineTimer = setTimeout(() => {
        this.startupFailed = true;
        this.pending.length = 0;
        this.clearStartupTimers();
        this.events.emit(
          "error",
          new Error(
            `[flowcrew-vitest] worker did not become ready within ${READY_AWARE_STARTUP_DEADLINE_MS}ms; ` +
              "failed without retrying tests",
          ),
        );
      }, READY_AWARE_STARTUP_DEADLINE_MS);
      this.delegate.send(message);
      return;
    }

    if (
      (message.type === "run" || message.type === "collect") &&
      (this.startupFailed || !this.realStartupComplete)
    ) {
      if (this.startupFailed) return;
      this.pending.push(message);
      return;
    }
    this.delegate.send(message);
  }

  deserialize(data: unknown): unknown {
    return this.delegate.deserialize(data);
  }

  async stop(): Promise<void> {
    this.clearStartupTimers();
    this.pending.length = 0;
    this.delegate.off("message", this.handleDelegateMessage);
    await this.delegate.stop();
  }

  private readonly handleDelegateMessage = (rawMessage: unknown): void => {
    const message = this.delegate.deserialize(rawMessage) as {
      type?: string;
      error?: unknown;
    } | null;
    if (message?.type !== "started") {
      this.events.emit("message", rawMessage);
      return;
    }
    if (this.startupFailed) return;

    this.realStartupComplete = true;
    this.clearStartupTimers();
    if (!this.startupExtended) {
      this.events.emit("message", rawMessage);
    } else if (message.error) {
      this.pending.length = 0;
      const detail = message.error instanceof Error ? message.error.message : String(message.error);
      this.events.emit(
        "error",
        new Error(
          `[flowcrew-vitest] worker reported a startup error after the extended handshake: ${detail}`,
        ),
      );
      return;
    } else {
      this.writeDiagnostic(
        `[flowcrew-vitest] worker ready after ${this.now() - this.startupStartedAt}ms; ` +
          "continuing queued tests without retry.\n",
      );
    }

    for (const queued of this.pending.splice(0)) this.delegate.send(queued);
  };

  private clearStartupTimers(): void {
    clearTimeout(this.startupExtensionTimer);
    clearTimeout(this.startupDeadlineTimer);
    this.startupExtensionTimer = undefined;
    this.startupDeadlineTimer = undefined;
  }
}

export const readyAwareForkPool = {
  name: "flowcrew-ready-forks",
  createPoolWorker: (options: PoolOptions): PoolWorker => new ReadyAwareForkWorker(options),
};

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: new URL("./ui/node_modules/react/index.js", import.meta.url).pathname },
      { find: /^react\/jsx-runtime$/, replacement: new URL("./ui/node_modules/react/jsx-runtime.js", import.meta.url).pathname },
      { find: /^react\/jsx-dev-runtime$/, replacement: new URL("./ui/node_modules/react/jsx-dev-runtime.js", import.meta.url).pathname },
      { find: /^react-dom$/, replacement: new URL("./ui/node_modules/react-dom/index.js", import.meta.url).pathname },
      { find: /^react-dom\/client$/, replacement: new URL("./ui/node_modules/react-dom/client.js", import.meta.url).pathname },
      { find: /^react-dom\/server$/, replacement: new URL("./ui/node_modules/react-dom/server.node.js", import.meta.url).pathname },
      { find: /^react-dom\/test-utils$/, replacement: new URL("./ui/node_modules/react-dom/test-utils.js", import.meta.url).pathname },
      { find: /^react-router-dom$/, replacement: new URL("./ui/node_modules/react-router-dom/dist/index.js", import.meta.url).pathname },
      { find: /^@testing-library\/react$/, replacement: new URL("./ui/node_modules/@testing-library/react/dist/@testing-library/react.esm.js", import.meta.url).pathname },
    ],
  },
  test: {
    // spec/ is the machine-independent public contract suite. The ignored
    // tests/ tree remains available for private, machine-local verification.
    include: [
      "spec/**/*.test.ts",
      "spec/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    setupFiles: [
      "./vitest.setup.ts",
      new URL("./node_modules/@testing-library/jest-dom/dist/vitest.mjs", import.meta.url).pathname,
    ],
    pool: readyAwareForkPool,
    fileParallelism: true,
    // The ready-aware pool passed 18/18 loaded invocations at this original
    // three-worker cap (the two-file probe exercised 12 concurrent forks).
    // Keep that cap: reducing it to one added serialization without carrying
    // the startup fix.
    maxWorkers: 3,
    isolate: true,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
