import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node';
import { READY_AWARE_STARTUP_DEADLINE_MS, READY_AWARE_STARTUP_EXTENSION_MS, ReadyAwareForkWorker } from '../vitest.config.js';
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
