import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { startDashboard } from '../src/dashboard.js';
import vitestConfig, {
  NINE_P_FILESYSTEM_MAGIC,
  READY_AWARE_STARTUP_DEADLINE_MS,
  READY_AWARE_STARTUP_EXTENSION_MS,
  ReadyAwareForkWorker,
  VITEST_MAX_WORKERS,
  readyAwareForkPool,
  resolveVitestWorkerCount,
} from '../vitest.config.js';

interface VitestIsolationRegistry {
  roots: Set<string>;
  cleanupRoot: (root: string) => void;
  cleanupAll: () => void;
}

class FakePoolWorker implements PoolWorker {
  readonly name = 'forks';
  readonly cacheFs = true;
  readonly sent: WorkerRequest[] = [];
  readonly events = new EventEmitter();
  startCalls = 0;
  stopCalls = 0;

  on(event: string, callback: (arg: unknown) => void): void {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void): void {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest): void {
    this.sent.push(message);
  }

  deserialize(data: unknown): unknown {
    return data;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  respondStarted(error?: unknown): void {
    this.events.emit('message', {
      __vitest_worker_response__: true,
      type: 'started',
      ...(error === undefined ? {} : { error }),
    });
  }
}

function workerRequest(type: WorkerRequest['type']): WorkerRequest {
  return { __vitest_worker_request__: true, type } as WorkerRequest;
}

function createReadyAwareHarness() {
  const delegate = new FakePoolWorker();
  const diagnostics: string[] = [];
  const worker = new ReadyAwareForkWorker({} as PoolOptions, {
    delegate,
    writeDiagnostic: (message) => diagnostics.push(message),
  });
  const messages: unknown[] = [];
  const errors: unknown[] = [];
  worker.on('message', (message) => messages.push(message));
  worker.on('error', (error) => errors.push(error));
  return { delegate, diagnostics, errors, messages, worker };
}

function expectInside(path: string, root: string): void {
  expect(path.startsWith(`${root}${sep}`)).toBe(true);
}

let explicitRoot: string;
let previousGlobalDir: string;

beforeAll(() => {
  explicitRoot = mkdtempSync(join(tmpdir(), 'flowcrew-explicit-isolation-'));
  previousGlobalDir = fcGlobalDir();
  const isolatedGlobalDir = join(explicitRoot, 'fc-home');
  mkdirSync(isolatedGlobalDir, { recursive: true });
  setFcGlobalDir(isolatedGlobalDir);
});

afterAll(() => {
  setFcGlobalDir(previousGlobalDir);
  rmSync(explicitRoot, { recursive: true, force: true });
});

describe('root-suite file isolation', () => {
  it('points business modules at an explicit disposable FC root', () => {
    expect(existsSync(explicitRoot)).toBe(true);
    expect(fcGlobalDir()).toBe(join(explicitRoot, 'fc-home'));
    expectInside(fcGlobalDir(), explicitRoot);
  });

  it('keeps file isolation and three-worker concurrency without suite retry', () => {
    expect(vitestConfig.test?.pool).toBe(readyAwareForkPool);
    expect(vitestConfig.test?.fileParallelism).toBe(true);
    expect(vitestConfig.test?.maxWorkers).toBe(VITEST_MAX_WORKERS);
    expect(resolveVitestWorkerCount({
      logicalCpuCount: 6,
      platform: 'linux',
      filesystemType: 0xef53,
    })).toBe(6);
    expect(resolveVitestWorkerCount({
      logicalCpuCount: 2,
      platform: 'linux',
      filesystemType: 0xef53,
    })).toBe(2);
    expect(resolveVitestWorkerCount({
      logicalCpuCount: 6,
      platform: 'linux',
      filesystemType: NINE_P_FILESYSTEM_MAGIC,
    })).toBe(3);
    expect(resolveVitestWorkerCount({
      logicalCpuCount: 6,
      platform: 'win32',
      filesystemType: 0,
    })).toBe(3);
    expect(vitestConfig.test).not.toHaveProperty('retry');
  });

  it('tracks unique roots for process-exit cleanup and removes late recreation idempotently', () => {
    const registry = Reflect.get(
      process,
      Symbol.for('flowcrew.vitest.file-isolation.registry'),
    ) as VitestIsolationRegistry | undefined;
    expect(registry).toBeTruthy();
    expect(registry?.roots.has(process.env.FLOWCREW_VITEST_ROOT!)).toBe(true);
    expect(process.listeners('exit')).toContain(registry?.cleanupAll);

    const firstRoot = mkdtempSync(join(tmpdir(), 'flowcrew-vitest-file-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'flowcrew-vitest-file-'));
    const firstHome = join(firstRoot, 'home');
    const secondFcHome = join(secondRoot, 'home', '.fc');
    mkdirSync(firstHome, { recursive: true });
    mkdirSync(secondFcHome, { recursive: true });

    expect(firstRoot).not.toBe(secondRoot);
    expect(firstRoot).not.toBe(process.env.FLOWCREW_VITEST_ROOT);
    expect(secondRoot).not.toBe(process.env.FLOWCREW_VITEST_ROOT);
    expectInside(firstHome, firstRoot);
    expectInside(secondFcHome, secondRoot);

    registry!.roots.add(firstRoot);
    try {
      registry!.cleanupRoot(firstRoot);
      mkdirSync(firstHome, { recursive: true });
      writeFileSync(join(firstHome, 'late-callback.txt'), 'recreated after afterAll\n');
      registry!.cleanupRoot(firstRoot);
      expect(existsSync(firstRoot)).toBe(false);
    } finally {
      registry!.roots.delete(firstRoot);
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
    expect(existsSync(secondRoot)).toBe(false);
  });

  it('uses a random nonzero port and removes both timers and signal listeners on close', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-dashboard-lifecycle-'));
    mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    writeFileSync(
      join(projectDir, 'config', 'workflows', 'default.yaml'),
      'name: default\nstages: []\n',
    );

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');
    let app: FastifyInstance | undefined;

    try {
      app = await startDashboard(projectDir, 0);
      const address = app.server.address() as AddressInfo | null;
      expect(address).not.toBeNull();
      expect(address?.port).toBeGreaterThan(0);
      expect(address?.port).not.toBe(3000);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);

      const dashboardTimers = setIntervalSpy.mock.calls
        .map((args, index) => ({ delay: args[1], handle: setIntervalSpy.mock.results[index]?.value }))
        .filter(({ delay }) => delay === 60_000 || delay === 5 * 60_000);
      expect(dashboardTimers).toHaveLength(2);

      await app.close();
      await app.close();

      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      for (const { handle } of dashboardTimers) {
        expect(clearIntervalSpy.mock.calls.filter(([cleared]) => cleared === handle)).toHaveLength(1);
      }
      app = undefined;
    } finally {
      await app?.close().catch(() => undefined);
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('ready-aware Vitest fork startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through a fast real startup without extending or diagnosing it', async () => {
    const { delegate, diagnostics, errors, messages, worker } = createReadyAwareHarness();
    const start = workerRequest('start');
    const run = workerRequest('run');

    await worker.start();
    worker.send(start);
    worker.send(run);
    await vi.advanceTimersByTimeAsync(READY_AWARE_STARTUP_EXTENSION_MS - 1);
    delegate.respondStarted();
    await vi.advanceTimersByTimeAsync(READY_AWARE_STARTUP_DEADLINE_MS);

    expect(delegate.startCalls).toBe(1);
    expect(delegate.sent).toEqual([start, run]);
    expect(messages).toEqual([{ __vitest_worker_response__: true, type: 'started' }]);
    expect(errors).toEqual([]);
    expect(diagnostics).toEqual([]);
    await worker.stop();
  });

  it('buffers run and collect until delayed real readiness, then flushes in order', async () => {
    const { delegate, diagnostics, errors, messages, worker } = createReadyAwareHarness();
    const start = workerRequest('start');
    const runOne = workerRequest('run');
    const collect = workerRequest('collect');
    const runTwo = workerRequest('run');

    await worker.start();
    worker.send(start);
    worker.send(runOne);
    worker.send(collect);
    worker.send(runTwo);
    await vi.advanceTimersByTimeAsync(READY_AWARE_STARTUP_EXTENSION_MS);

    expect(delegate.sent).toEqual([start]);
    expect(messages).toEqual([{ __vitest_worker_response__: true, type: 'started' }]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('startup only, no test retry');

    delegate.respondStarted();

    expect(delegate.sent).toEqual([start, runOne, collect, runTwo]);
    expect(errors).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toContain('continuing queued tests without retry');
    await worker.stop();
  });

  it('fails at the hard startup deadline and never dispatches or retries queued tests', async () => {
    const { delegate, errors, worker } = createReadyAwareHarness();
    const start = workerRequest('start');
    const run = workerRequest('run');
    const collect = workerRequest('collect');

    await worker.start();
    worker.send(start);
    worker.send(run);
    worker.send(collect);
    await vi.advanceTimersByTimeAsync(READY_AWARE_STARTUP_DEADLINE_MS);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining('failed without retrying tests') }),
    );
    expect(delegate.sent).toEqual([start]);

    delegate.respondStarted();
    worker.send(workerRequest('run'));
    expect(delegate.sent).toEqual([start]);
    await worker.stop();
  });

  it('reports a delayed started error and does not flush the queued test', async () => {
    const { delegate, diagnostics, errors, worker } = createReadyAwareHarness();
    const start = workerRequest('start');
    const run = workerRequest('run');

    await worker.start();
    worker.send(start);
    worker.send(run);
    await vi.advanceTimersByTimeAsync(READY_AWARE_STARTUP_EXTENSION_MS);
    delegate.respondStarted(new Error('jsdom initialization failed'));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining('jsdom initialization failed') }),
    );
    expect(delegate.sent).toEqual([start]);
    expect(diagnostics).toHaveLength(1);
    await worker.stop();
  });
});
