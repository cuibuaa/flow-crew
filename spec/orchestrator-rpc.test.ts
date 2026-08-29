import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net, { type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { cmdTask } from '../src/cli-task.js';
import { createDaemonRpcErrorLogger } from '../src/cli-daemon.js';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  DaemonUnavailableError,
  RpcOutcomeUnknownError,
  formatDaemonRegistration,
  rpcErrorExitCode,
  sendRpc,
  startRpcServer,
  type RegisterRpcResponse,
} from '../src/orchestrator-rpc.js';
import type { CancellationResult } from '../src/run-control.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

let tempDir: string;
let socketPath: string;
let server: Server | undefined;
const peerSockets = new Set<Socket>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-rpc-${randomBytes(4).toString('hex')}-`));
  socketPath = join(tempDir, 'daemon.sock');
});

afterEach(async () => {
  for (const socket of peerSockets) socket.destroy();
  peerSockets.clear();
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sendRpc delivery truth', () => {
  it('keeps the compatibility default timeout at 2000ms', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(2_000);
  });

  it('reports a pre-write connection failure as daemon unavailable', async () => {
    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'status' }, 100));

    expect(error).toBeInstanceOf(DaemonUnavailableError);
    expect(error.name).toBe('DaemonUnavailableError');
    expect((error as DaemonUnavailableError).exitCode).toBe(1);
    expect(rpcErrorExitCode(error)).toBe(1);
    expect(error.message).toBe('daemon not running. Start with: flowcrew daemon start');
  });

  it('reports an accepted and written request with no response as outcome unknown', async () => {
    let received = '';
    await listen((socket) => {
      socket.on('data', (chunk) => { received += chunk.toString('utf-8'); });
    });

    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'cancel', id: 1825 }, 100));

    expect(JSON.parse(received)).toEqual({ cmd: 'cancel', id: 1825 });
    expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
    expect((error as RpcOutcomeUnknownError).exitCode).toBe(2);
    expect(rpcErrorExitCode(error)).toBe(2);
    expect(error.message).toContain('may already have been delivered and taken effect');
    expect(error.message).toContain('flowcrew task list');
    expect(error.message).toContain('flowcrew daemon status');
    expect(error.message).not.toContain('daemon not running');
  });

  it('passes through a daemon-declared error unchanged', async () => {
    await listen((socket) => {
      socket.once('data', () => socket.end(JSON.stringify({ error: 'daemon-declared-error' })));
    });

    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'status' }, 100));

    expect(error.constructor).toBe(Error);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('daemon-declared-error');
    expect(rpcErrorExitCode(error)).toBe(1);
  });

  it('treats a peer close after reading the request as outcome unknown', async () => {
    let received = '';
    await listen((socket) => {
      socket.once('data', (chunk) => {
        received += chunk.toString('utf-8');
        socket.end();
      });
    });

    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'cancel', id: 7 }, 100));

    expect(JSON.parse(received)).toEqual({ cmd: 'cancel', id: 7 });
    expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
    expect(error.message).toContain('may already have been delivered and taken effect');
    expect(error.message).toContain('flowcrew daemon status');
    expect(error.message).not.toContain('daemon not running');
  });

  it('uses successful write state when a later socket error fires', async () => {
    const fakeSocket = Object.assign(new EventEmitter(), {
      destroyed: false,
      write(_payload: string, callback: (error?: Error | null) => void) {
        callback();
        return true;
      },
      destroy() {
        this.destroyed = true;
        return this;
      },
    });
    const createConnection = vi.spyOn(net, 'createConnection')
      .mockReturnValue(fakeSocket as unknown as Socket);

    try {
      const pending = sendRpc('/controlled-socket', { cmd: 'cancel', id: 8 }, 1_000);
      fakeSocket.emit('connect');
      fakeSocket.emit('error', new Error('peer reset'));
      const error = await rejectionOf(pending);

      expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
      expect(error.message).toContain('peer reset');
      expect(error.message).toContain('may already have been delivered and taken effect');
      expect(error.message).toContain('flowcrew daemon status');
      expect(error.message).not.toContain('daemon not running');
    } finally {
      createConnection.mockRestore();
    }
  });

  it('maps task CLI connection failure to 1 and post-write timeout to 2', async () => {
    const missing = new Capture();
    const missingCode = await cmdTask(
      ['task', 'list', '--port', socketPath],
      { stdout: missing.stdout as any, stderr: missing.stderr as any, rpcTimeoutMs: 100 },
    );

    expect(missingCode).toBe(1);
    expect(missing.errorText()).toContain('daemon not running');

    await listen((socket) => {
      socket.on('data', () => {});
    });
    const silent = new Capture();
    const silentCode = await cmdTask(
      ['task', 'cancel', '7', '--port', socketPath],
      { stdout: silent.stdout as any, stderr: silent.stderr as any, rpcTimeoutMs: 100 },
    );

    expect(silentCode).toBe(2);
    expect(silent.errorText()).toContain('may already have been delivered and taken effect');
    expect(silent.errorText()).toContain('flowcrew daemon status');
    expect(silent.errorText()).not.toContain('daemon not running');
  });

  it('returns and formats the daemon pid and loaded build on registration', async () => {
    const build = 'a'.repeat(64);
    server = await startRpcServer(socketPath, (request) => {
      if (request.cmd !== 'register') return { error: 'unexpected command' };
      return { id: 17, unit: 'flowcrew-task-17.service', pid: 4321, build };
    });

    const response = await sendRpc<RegisterRpcResponse>(socketPath, {
      cmd: 'register',
      task: { brief_text: 'identity probe', projectDir: tempDir },
    });

    expect(response).toEqual({ id: 17, unit: 'flowcrew-task-17.service', pid: 4321, build });
    expect(formatDaemonRegistration(response)).toBe(
      `Task #17 registered (daemon pid=4321, build=${build}). Unit: flowcrew-task-17.service`,
    );
    expect(formatDaemonRegistration({ id: 18, unit: 'legacy.service' })).toContain(
      'daemon pid=UNVERIFIED, build=UNVERIFIED',
    );
    expect(formatDaemonRegistration({ id: 18, unit: 'legacy.service' })).toContain('flowcrew daemon status');
  });

  it('round-trips run-id cancellation and its observable pending state', async () => {
    server = await startRpcServer(socketPath, (request) => {
      expect(request).toEqual({ cmd: 'cancel-run', runId: 'run-e13', unit: 'campaign-e13.service' });
      return {
        ok: false,
        status: 'cancelling',
        runId: 'run-e13',
        observation: {
          unit: 'campaign-e13.service',
          unitState: 'deactivating',
          runReadable: true,
          schedulerPid: 4321,
          schedulerAlive: true,
          launchInFlight: false,
        },
        message: 'scheduler is still exiting',
      };
    });

    const response = await sendRpc<CancellationResult>(socketPath, {
      cmd: 'cancel-run',
      runId: 'run-e13',
      unit: 'campaign-e13.service',
    });

    expect(response).toMatchObject({ ok: false, status: 'cancelling', runId: 'run-e13' });
    expect(response.observation).toMatchObject({ unitState: 'deactivating', schedulerAlive: true });
  });

  it('logs handler errors with command and stack even after the client disconnects', async () => {
    const logPath = join(tempDir, 'daemon.log');
    const marker = 'RPC_HANDLER_DISCONNECTED_MARKER';
    let releaseHandler!: () => void;
    const clientDisconnected = new Promise<void>((resolveDisconnected) => { releaseHandler = resolveDisconnected; });
    server = await startRpcServer(
      socketPath,
      async () => {
        await clientDisconnected;
        throw new Error(marker);
      },
      { onHandlerError: createDaemonRpcErrorLogger(logPath, () => new Date('2026-07-31T12:00:00.000Z')) },
    );

    const client = net.createConnection(socketPath);
    const clientClosed = new Promise<void>((resolveClosed) => { client.once('close', () => resolveClosed()); });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('error', reject);
        client.once('connect', () => {
          client.write(JSON.stringify({ cmd: 'status' }), () => {
            client.destroy();
            resolve();
          });
        });
      });
      await clientClosed;
    } finally {
      releaseHandler();
    }
    await waitUntil(() => existsSync(logPath) && readFileSync(logPath, 'utf-8').includes(marker));

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('ERROR cmd=status');
    expect(log).toContain(`Error: ${marker}`);
    expect(log).toContain('2026-07-31T12:00:00.000Z');
  });
});

async function listen(onConnection: (socket: Socket) => void): Promise<void> {
  server = net.createServer((socket) => {
    peerSockets.add(socket);
    socket.once('close', () => peerSockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, () => {
      server!.off('error', reject);
      resolve();
    });
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected promise to reject');
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await waitForPathEvent(tempDir, () => predicate() ? true : undefined);
}

class Capture {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];

  constructor() {
    this.stdout.on('data', (chunk) => this.stdoutChunks.push(Buffer.from(chunk)));
    this.stderr.on('data', (chunk) => this.stderrChunks.push(Buffer.from(chunk)));
  }

  errorText(): string {
    return Buffer.concat(this.stderrChunks).toString('utf-8');
  }
}
