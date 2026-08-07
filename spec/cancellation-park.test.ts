import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import {
  cancelRunThroughControlPlane,
  type LocalCancellationControl,
} from '../src/cancellation-client.js';
import { cmdTask } from '../src/cli-task.js';
import { cancelRunWithControlPlane } from '../src/dashboard.js';
import { Orchestrator, type SupervisorBackend, type UnitStatus } from '../src/orchestrator.js';
import {
  RpcOutcomeUnknownError,
  startRpcServer,
  type RpcRequest,
  type RpcResponse,
} from '../src/orchestrator-rpc.js';
import { invalidateRunLockCache, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import type { CancellationResult } from '../src/run-control.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  RUN_STATUS,
  setFcGlobalDir,
  STAGE_STATUS,
  writeRunState,
} from '../src/store.js';
import { TASK_STATUS, TaskRegistry, type TaskEntry } from '../src/task-registry.js';

let fixtureRoot: string;
let projectDir: string;
let registry: TaskRegistry;
let socketPath: string;
let server: Server | undefined;
let originalFcHome: string;

beforeAll(() => {
  originalFcHome = fcGlobalDir();
});

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), `flowcrew-e13b-${randomBytes(4).toString('hex')}-`));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(fixtureRoot);
  invalidateRunLockCache();
  registry = new TaskRegistry({ baseDir: fixtureRoot });
  socketPath = join(fixtureRoot, 'daemon.sock');
});

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  invalidateRunLockCache();
  setFcGlobalDir(originalFcHome);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(originalFcHome);
});

class FakeSystemd implements SupervisorBackend {
  state: UnitStatus = { kind: 'terminal', exitCode: 0 };
  stopCalls = 0;

  async isActive(): Promise<UnitStatus> { return this.state; }
  async runUnit(): Promise<void> { this.state = { kind: 'active' }; }
  async stopUnit(): Promise<void> { this.stopCalls += 1; this.state = { kind: 'terminal', exitCode: 0 }; }
  async journalTail(): Promise<string> { return ''; }
}

function completeCancellation(overrides: Partial<CancellationResult> = {}): CancellationResult {
  return {
    ok: true,
    status: 'cancelled',
    runId: 'run-bound',
    observation: {
      unit: 'flowcrew-e13b.service',
      unitState: { kind: 'terminal', exitCode: 0 },
      runReadable: true,
      schedulerPid: null,
      schedulerAlive: false,
      launchInFlight: false,
    },
    message: 'Cancellation confirmed.',
    ...overrides,
  };
}

function capture(): {
  stdout: PassThrough;
  stderr: PassThrough;
  output: () => string;
  error: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  stdout.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));
  stderr.on('data', (chunk) => errorChunks.push(Buffer.from(chunk)));
  return {
    stdout,
    stderr,
    output: () => Buffer.concat(outputChunks).toString('utf-8'),
    error: () => Buffer.concat(errorChunks).toString('utf-8'),
  };
}

function boundTask(runId: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return registry.create({
    name: 'E13b bound task',
    projectDir,
    run_id: runId,
    status: TASK_STATUS.RUNNING,
    systemd_unit: 'flowcrew-e13b.service',
    ...overrides,
  });
}

describe('cancellation entry convergence', () => {
  it('uses run-id first and locally completes a legacy daemon cancellation without numeric mutation', async () => {
    const created = createRun(
      projectDir,
      'default',
      'name: default\nstages:\n  - id: work\n    role: worker\n',
      ['work'],
    );
    const state = readRunState(projectDir, created.runId);
    state.status = RUN_STATUS.RUNNING;
    state.stages.work.status = STAGE_STATUS.RUNNING;
    writeRunState(projectDir, created.runId, state);
    // Legacy registries may bind the same run by absolute path. The wire must
    // still use its safe run id while local convergence retains that binding.
    const task = boundTask(created.runDirPath);
    const systemd = new FakeSystemd();
    const local = new Orchestrator({
      registry,
      systemd,
      cancellation: { runsDir: join(fixtureRoot, 'runs'), signalGraceMs: 0, timeoutMs: 50 },
    });
    const requests: RpcRequest[] = [];
    server = await startRpcServer(socketPath, (request): RpcResponse => {
      requests.push(request);
      if (request.cmd === 'show') return { task, recent_ticks: [] };
      if (request.cmd === 'cancel-run') return { error: 'unknown command' };
      if (request.cmd === 'cancel') throw new Error('legacy numeric mutation must not be sent');
      return { error: 'unexpected command' };
    });
    const io = capture();

    const code = await cmdTask(
      ['task', 'cancel', String(task.id), '--socket', socketPath],
      {
        stdout: io.stdout as unknown as NodeJS.WriteStream,
        stderr: io.stderr as unknown as NodeJS.WriteStream,
        cancellationClient: { localControl: local },
      },
    );

    const finalRun = readRunState(projectDir, created.runId);
    expect(code).toBe(0);
    expect(io.output()).toBe(`Task #${task.id} cancelled\n`);
    expect(io.error()).toBe('');
    expect(requests).toEqual([
      { cmd: 'show', id: task.id },
      { cmd: 'cancel-run', runId: created.runId, unit: task.systemd_unit },
    ]);
    expect(systemd.stopCalls).toBe(1);
    expect(registry.get(task.id)).toMatchObject({ status: TASK_STATUS.CANCELLED });
    expect(finalRun).toMatchObject({
      status: RUN_STATUS.STOPPED,
      failureReason: 'Cancelled by user',
      completedAt: expect.any(String),
    });
  });

  it('accepts only complete confirmed RPC results and never retries an outcome-unknown mutation', async () => {
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => completeCancellation({ taskId: 1 })),
      cancelRun: vi.fn(async () => completeCancellation()),
    };

    const current = await cancelRunThroughControlPlane('run-bound', undefined, {
      sendRequest: vi.fn(async () => completeCancellation()),
      localControl: local,
    });
    expect(current.ok).toBe(true);
    expect(local.cancelRun).not.toHaveBeenCalled();

    const pending = completeCancellation({
      ok: false,
      status: 'cancelling',
      observation: {
        unit: 'flowcrew-e13b.service',
        unitState: { kind: 'deactivating' },
        runReadable: true,
        schedulerPid: process.pid,
        schedulerAlive: true,
        launchInFlight: false,
      },
    });
    await expect(cancelRunThroughControlPlane('run-bound', undefined, {
      sendRequest: vi.fn(async () => pending),
      localControl: local,
    })).resolves.toBe(pending);
    expect(local.cancelRun).not.toHaveBeenCalled();

    await cancelRunThroughControlPlane('run-bound', undefined, {
      sendRequest: vi.fn(async () => ({ ok: true })),
      localControl: local,
    });
    expect(local.cancelRun).toHaveBeenCalledTimes(1);

    await expect(cancelRunThroughControlPlane('run-bound', undefined, {
      sendRequest: vi.fn(async () => { throw new RpcOutcomeUnknownError('connection closed.'); }),
      localControl: local,
    })).rejects.toBeInstanceOf(RpcOutcomeUnknownError);
    expect(local.cancelRun).toHaveBeenCalledTimes(1);
  });

  it('routes the Dashboard default cancel entry through the same run-id client contract', async () => {
    const runId = 'dashboard-shared-client';
    const requests: RpcRequest[] = [];
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => completeCancellation({ taskId: 1 })),
      cancelRun: vi.fn(async () => completeCancellation({ runId })),
    };

    const result = await cancelRunWithControlPlane(runId, {
      localControl: local,
      sendRequest: vi.fn(async (request): Promise<RpcResponse> => {
        requests.push(request);
        return completeCancellation({
          runId,
          observation: {
            unit: null,
            unitState: { kind: 'terminal', exitCode: 0 },
            runReadable: true,
            schedulerPid: null,
            schedulerAlive: false,
            launchInFlight: false,
          },
        });
      }),
    });

    expect(result).toMatchObject({ ok: true, runId });
    expect(requests).toEqual([{ cmd: 'cancel-run', runId }]);
    expect(local.cancelRun).not.toHaveBeenCalled();
  });

  it('returns a complete daemon result without constructing or invoking local cancellation', async () => {
    const remote = completeCancellation({ runId: 'daemon-owned-result' });
    const local: LocalCancellationControl = {
      cancel: async () => { throw new Error('daemon result fell back to local task cancellation'); },
      cancelRun: async () => { throw new Error('daemon result fell back to local run cancellation'); },
    };

    await expect(cancelRunThroughControlPlane('daemon-owned-result', undefined, {
      sendRequest: async () => remote,
      localControl: local,
    })).resolves.toBe(remote);
  });

  it('maps an outcome-unknown CLI mutation to exit 2 without starting local cancellation', async () => {
    const task = boundTask('run-bound');
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => completeCancellation({ taskId: task.id })),
      cancelRun: vi.fn(async () => completeCancellation()),
    };
    const sendRequest = vi.fn(async (request: RpcRequest): Promise<RpcResponse> => {
      if (request.cmd === 'show') return { task, recent_ticks: [] };
      throw new RpcOutcomeUnknownError('daemon connection closed after delivery.');
    });
    const io = capture();

    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stderr: io.stderr as unknown as NodeJS.WriteStream,
      cancellationClient: { sendRequest, localControl: local },
    });

    expect(code).toBe(2);
    expect(io.output()).toBe('');
    expect(io.error()).toContain('may already have been delivered and taken effect');
    expect(local.cancel).not.toHaveBeenCalled();
    expect(local.cancelRun).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', completeCancellation({ ok: false, status: 'cancelling' }), completeCancellation(), 1],
    ['incomplete', { ok: true } as RpcResponse, completeCancellation({ ok: false, status: 'cancelling' }), 1],
  ])('does not print CLI success for a %s cancellation response', async (_name, remote, localResult, expectedCode) => {
    const task = boundTask('run-bound');
    const local: LocalCancellationControl = {
      cancel: vi.fn(async () => localResult),
      cancelRun: vi.fn(async () => localResult),
    };
    const io = capture();
    const sendRequest = vi.fn(async (request: RpcRequest): Promise<RpcResponse> => (
      request.cmd === 'show' ? { task, recent_ticks: [] } : remote
    ));

    const code = await cmdTask(['task', 'cancel', String(task.id)], {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stderr: io.stderr as unknown as NodeJS.WriteStream,
      cancellationClient: { sendRequest, localControl: local },
    });

    expect(code).toBe(expectedCode);
    expect(io.output()).toBe('');
    expect(io.error()).toContain('Cancellation still in progress');
  });
});

describe('parked resume durability', () => {
  it('leaves every byte of a parked run unchanged when an identity-bound live sibling owns the project', async () => {
    const parked = createRun(
      projectDir,
      'original-workflow',
      'name: original-workflow\nstages:\n  - id: original\n    role: planner\n',
      ['original'],
    );
    const parkedState = readRunState(projectDir, parked.runId);
    parkedState.status = RUN_STATUS.PARKED;
    parkedState.currentIteration = 7;
    parkedState.maxIterations = 41;
    parkedState.timeoutMs = 98_765;
    parkedState.autoApprove = false;
    parkedState.inheritCampaignContext = true;
    parkedState.taskDescription = '# Original parked brief';
    parkedState.parked = {
      requestId: 'e13b-byte-invariance',
      action: 'deploy',
      target: 'mainnet',
      reason: 'original parked reason',
      atIteration: 7,
      requestedAt: '2026-08-03T10:00:00.000Z',
      pausedAt: '2026-08-03T10:00:01.000Z',
    };
    writeRunState(projectDir, parked.runId, parkedState);

    const sibling = createRun(
      projectDir,
      'sibling-workflow',
      'name: sibling-workflow\nstages: []\n',
      [],
    );
    writeFileSync(join(sibling.runDirPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(sibling.runDirPath, sibling.runId, process.pid);
    const before = readFileSync(join(parked.runDirPath, 'run.json'), 'utf-8');
    const replacement = loadWorkflow(join(import.meta.dirname, '..', 'config', 'workflows', 'research.yaml'));
    const adapter = {
      async run(): Promise<never> {
        throw new Error('adapter must not run when the sibling owns admission');
      },
    } as Adapter;

    const result = await runWorkflow(
      replacement.config,
      replacement.raw,
      projectDir,
      adapter,
      new Map(),
      undefined,
      join(import.meta.dirname, '..', 'config', 'agents'),
      parked.runId,
      '# Replacement brief that must not be persisted',
      true,
      false,
      undefined,
      false,
    );

    expect(result.status).toBe(RUN_STATUS.PARKED);
    expect(result.parked?.requestId).toBe('e13b-byte-invariance');
    expect(readFileSync(join(parked.runDirPath, 'run.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(parked.runDirPath, 'scheduler.pid'))).toBe(false);
    expect(existsSync(join(parked.runDirPath, 'scheduler.identity.json'))).toBe(false);
    expect(existsSync(join(sibling.runDirPath, 'scheduler.pid'))).toBe(true);
    expect(existsSync(join(sibling.runDirPath, 'scheduler.identity.json'))).toBe(true);
  });
});
