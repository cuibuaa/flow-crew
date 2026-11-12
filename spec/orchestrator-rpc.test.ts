import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net, { type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { cmdTask } from '../src/cli-task.js';
import { cmdDaemon, createDaemonRpcErrorLogger } from '../src/cli-daemon.js';
import {
  RpcInProgress,
  DaemonUnavailableError,
  RpcOutcomeUnknownError,
  RpcRemoteError,
  formatDaemonRegistration,
  rpcErrorExitCode,
  sendRpc,
  startRpcServer,
  type RegisterRpcResponse,
} from '../src/orchestrator-rpc.js';
import { cancelTaskThroughControlPlane } from '../src/cancellation-client.js';
import type { CancellationResult } from '../src/run-control.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
// The daemon loads stage integrity, whose publication observer sees the socket removal.
import '../src/engine-integrity.js';

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sendRpc delivery truth', () => {
  it.each(['status', 'cancel', 'hold', 'continue', 'resume'] as const)(
    'waits for a live %s answer regardless of clock advancement', async cmd => {
      const received = deferred<Socket>();
      await listen(socket => socket.once('data', () => received.resolve(socket)));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let settled = false;
      const pending = sendRpc(socketPath, cmd === 'cancel' || cmd === 'resume' ? { cmd, id: 8 } : { cmd });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const peer = await received.promise;
      await vi.advanceTimersByTimeAsync(1_000_000_000_000);
      expect(settled).toBe(false);
      peer.end(JSON.stringify({ ok: true, result: { ok: true } }));
      expect(await pending).toEqual({ ok: true });
    },
  );

  it('keeps cancellation waiting without local fallback until the daemon answers', async () => {
    const received = deferred<Socket>();
    await listen(socket => socket.once('data', () => received.resolve(socket)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const local = { cancel: vi.fn(), cancelRun: vi.fn() };
    let settled = false;
    const pending = cancelTaskThroughControlPlane(8, { socketPath, localControl: local });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const peer = await received.promise;
    await vi.advanceTimersByTimeAsync(1_000_000_000_000);
    expect(settled).toBe(false);
    expect(local.cancel).not.toHaveBeenCalled();
    const answer: CancellationResult = {
      ok: true, status: 'cancelled', taskId: 8, message: 'cancelled',
      observation: { unit: null, unitState: { kind: 'absent' }, runReadable: false,
        schedulerPid: null, schedulerAlive: false, launchInFlight: false },
    };
    peer.end(JSON.stringify({ ok: true, result: answer }));
    expect(await pending).toEqual(answer);
    expect(local.cancel).not.toHaveBeenCalled();
  });

  it('reports a pre-write connection failure as daemon unavailable', async () => {
    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'status' }));

    expect(error).toBeInstanceOf(DaemonUnavailableError);
    expect(error.name).toBe('DaemonUnavailableError');
    expect((error as DaemonUnavailableError).exitCode).toBe(1);
    expect(rpcErrorExitCode(error)).toBe(1);
    expect(error.message).toBe('daemon not running. Start with: flowcrew daemon start');
  });

  it('reports a real refused socket as unavailable', async () => {
    const previous = net.createServer();
    const previousPath = join(tempDir, 'previous.sock');
    await new Promise<void>(done => previous.listen(previousPath, done));
    linkSync(previousPath, socketPath);
    await new Promise<void>(done => previous.close(() => done()));
    expect(await rejectionOf(sendRpc(socketPath, { cmd: 'status' }))).toBeInstanceOf(DaemonUnavailableError);
  });

  it.each(['rpc', 'cancellation'] as const)('returns one in-progress result for a declared %s wait', async caller => {
    const received = deferred<Socket>();
    await listen(socket => socket.once('data', () => received.resolve(socket)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const local = { cancel: vi.fn(), cancelRun: vi.fn() };
    const pending = caller === 'rpc' ? sendRpc(socketPath, { cmd: 'status' }, 100)
      : cancelTaskThroughControlPlane(8, { socketPath, rpcTimeoutMs: 100, localControl: local });
    await received.promise;
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toBeInstanceOf(RpcInProgress);
    expect(result).toMatchObject({ status: 'in-progress', code: 'RPC_IN_PROGRESS' });
    expect(rpcErrorExitCode(result)).toBe(5);
    expect(local.cancel).not.toHaveBeenCalled();
  });

  it('applies a declared cancellation API limit to an injected sender without fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const local = { cancel: vi.fn(), cancelRun: vi.fn() };
    const pending = cancelTaskThroughControlPlane(8, {
      socketPath, rpcTimeoutMs: 100, localControl: local, sendRequest: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeInstanceOf(RpcInProgress);
    expect(local.cancel).not.toHaveBeenCalled();
  });

  it.each(['hold', 'hold-status', 'continue'] as const)('daemon %s waits by default and returns in progress only at a declared limit', async cmd => {
    const received = deferred<Socket>();
    let onRequest = (socket: Socket) => received.resolve(socket);
    await listen(socket => socket.once('data', () => onRequest(socket)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const output = new Capture();
    const args = ['daemon', cmd, '--socket', socketPath];
    const opts = { distDir: tempDir, stdout: output.stdout as never, stderr: output.stderr as never };
    let settled = false;
    const pending = cmdDaemon(args, opts);
    void pending.then(() => { settled = true; });
    const peer = await received.promise;
    await vi.advanceTimersByTimeAsync(1_000_000_000_000);
    expect(settled).toBe(false);
    expect(output.outputText()).toBe('');
    expect(output.errorText()).toBe('');
    peer.end(JSON.stringify({ ok: true, result: { ready: true, released: true, tasks: [], errors: [] } }));
    expect(await pending).toBe(0);
    const second = deferred<void>();
    onRequest = () => second.resolve();
    const limitedOutput = new Capture();
    const limited = cmdDaemon([...args, '--timeout-ms', '100'], {
      ...opts, stdout: limitedOutput.stdout as never, stderr: limitedOutput.stderr as never,
    });
    await second.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await limited).toBe(5);
    expect(JSON.parse(limitedOutput.outputText())).toMatchObject({ status: 'in-progress', code: 'RPC_IN_PROGRESS' });
    expect(limitedOutput.errorText()).toBe('');
  });

  it('passes through a daemon-declared error unchanged', async () => {
    await listen((socket) => {
      socket.once('data', () => socket.end(JSON.stringify({ error: 'daemon-declared-error' })));
    });

    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'status' }));

    expect(error).toBeInstanceOf(RpcRemoteError);
    expect((error as RpcRemoteError).code).toBe('RPC_REFUSED');
    expect(error.message).toBe('daemon-declared-error');
    expect(rpcErrorExitCode(error)).toBe(1);
  });

  it('preserves typed error codes and wraps success on the wire', async () => {
    server = await startRpcServer(socketPath, (request) => {
      if (request.cmd === 'status') return { ok: true };
      throw Object.assign(new Error('held by operator'), { code: 'DEPLOYMENT_HELD' });
    });
    expect(await sendRpc(socketPath, { cmd: 'status' })).toEqual({ ok: true });
    const failure = await rejectionOf(sendRpc(socketPath, { cmd: 'retry', id: 3 }));
    expect(failure).toMatchObject({ code: 'DEPLOYMENT_HELD', message: 'held by operator' });
    const wire = await new Promise<string>((resolve, reject) => {
      const peer = net.createConnection(socketPath);
      let data = '';
      peer.on('error', reject);
      peer.on('connect', () => peer.write(JSON.stringify({ cmd: 'status' })));
      peer.on('data', chunk => { data += chunk; });
      peer.on('end', () => resolve(data));
    });
    expect(JSON.parse(wire)).toEqual({ ok: true, result: { ok: true } });
  });

  it('keeps an existing UPPER_SNAKE error code through the boundary', async () => {
    server = await startRpcServer(socketPath, () => { throw new Error('BRIEF_NOT_ADMITTED: review required'); });
    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'status' }));
    expect(error).toMatchObject({ code: 'BRIEF_NOT_ADMITTED', message: 'BRIEF_NOT_ADMITTED: review required' });
  });

  it.each([
    [], {}, { ok: true, result: null }, { ok: false, message: 'refused' },
    { ok: false, code: 'REFUSED' }, { ok: 'bad', result: {} },
  ])('keeps an invalid response outcome unknown: %j', async payload => {
    await listen(socket => { socket.once('data', () => socket.end(JSON.stringify(payload))); });
    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'register', task: { projectDir: tempDir } }));
    expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
    expect(rpcErrorExitCode(error)).toBe(2);
  });

  it('treats a peer close after reading the request as outcome unknown', async () => {
    let received = '';
    await listen((socket) => {
      socket.once('data', (chunk) => {
        received += chunk.toString('utf-8');
        socket.end();
      });
    });

    const error = await rejectionOf(sendRpc(socketPath, { cmd: 'cancel', id: 7 }));

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
      const pending = sendRpc('/controlled-socket', { cmd: 'cancel', id: 8 });
      fakeSocket.emit('connect');
      fakeSocket.emit('error', new Error('peer reset'));
      fakeSocket.emit('close');
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

  it.each(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EAGAIN', 'EMFILE'])('classifies connect %s only from its evidence', async code => {
    const peer = fakeSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(peer as unknown as Socket);
    const pending = rejectionOf(sendRpc(socketPath, { cmd: 'status' }));
    const failure = Object.assign(new Error('connect failed'), { code });
    peer.emit('error', failure);
    peer.emit('close');
    const error = await pending;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') expect(error).toBeInstanceOf(DaemonUnavailableError);
    else {
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(DaemonUnavailableError);
      expect(error).not.toBeInstanceOf(RpcOutcomeUnknownError);
      const local = { cancel: vi.fn(), cancelRun: vi.fn() };
      const cancellation = rejectionOf(cancelTaskThroughControlPlane(8, { socketPath, localControl: local }));
      peer.emit('error', failure);
      peer.emit('close');
      expect(await cancellation).toBe(failure);
      expect(local.cancel).not.toHaveBeenCalled();
    }
  });

  it('does not call a written request unknown while its connection remains open after an error', async () => {
    const peer = fakeSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(peer as unknown as Socket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const pending = rejectionOf(sendRpc(socketPath, { cmd: 'status' }));
    void pending.then(() => { settled = true; });
    peer.emit('connect');
    peer.emit('error', new Error('reset'));
    await vi.advanceTimersByTimeAsync(1_000_000_000_000);
    expect(settled).toBe(false);
    peer.emit('close');
    expect(await pending).toBeInstanceOf(RpcOutcomeUnknownError);
  });

  it('maps CLI absence, declared wait, remote refusal and broken delivery to distinct results', async () => {
    const missing = new Capture();
    expect(await cmdTask(['task', 'list', '--socket', socketPath], {
      stdout: missing.stdout as never, stderr: missing.stderr as never,
    })).toBe(1);
    expect(missing.errorText()).toContain('daemon not running');

    const received = deferred<Socket>();
    let mode: 'held' | 'closed' | 'refused' = 'held';
    await listen(socket => socket.once('data', () => {
      if (mode === 'closed') socket.end();
      else if (mode === 'refused') socket.end(JSON.stringify({ error: 'refused' }));
      else received.resolve(socket);
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const held = new Capture();
    const pending = cmdTask(['task', 'cancel', '7', '--socket', socketPath], {
      stdout: held.stdout as never, stderr: held.stderr as never, rpcTimeoutMs: 100,
    });
    await received.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(5);
    expect(JSON.parse(held.outputText())).toMatchObject({ status: 'in-progress', code: 'RPC_IN_PROGRESS' });
    expect(held.errorText()).toBe('');
    mode = 'closed';
    const closed = new Capture();
    expect(await cmdTask(['task', 'list', '--socket', socketPath], {
      stdout: closed.stdout as never, stderr: closed.stderr as never,
    })).toBe(2);
    expect(closed.errorText()).toContain('may already have been delivered');
    mode = 'refused';
    const refused = new Capture();
    expect(await cmdTask(['task', 'list', '--socket', socketPath], {
      stdout: refused.stdout as never, stderr: refused.stderr as never,
    })).toBe(1);
    expect(refused.errorText()).toContain('refused');
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
      expect(request).toEqual({ cmd: 'cancel', runId: 'run-e13', unit: 'campaign-e13.service' });
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
      cmd: 'cancel',
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

  outputText(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf-8');
  }

  errorText(): string {
    return Buffer.concat(this.stderrChunks).toString('utf-8');
  }
}

describe('startRpcServer after an unclean daemon exit', () => {
  it('preserves a listener even when connection establishment is held beyond all former limits', async () => {
    await listen(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: true }))));
    const inode = statSync(socketPath).ino;
    const peer = fakeSocket();
    const connect = vi.spyOn(net, 'createConnection').mockReturnValue(peer as unknown as Socket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const starting = rejectionOf(startRpcServer(socketPath, () => ({ ok: true })));
    void starting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000_000_000_000);
    expect(settled).toBe(false);
    expect(statSync(socketPath).ino).toBe(inode);
    peer.emit('connect');
    expect((await starting).message).toContain('already active');
    connect.mockRestore();
    expect(statSync(socketPath).ino).toBe(inode);
    expect(await sendRpc(socketPath, { cmd: 'status' })).toEqual({ ok: true });
  });

  it('refuses to displace an established listener that never sends an answer', async () => {
    await listen(() => {});
    const inode = statSync(socketPath).ino;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const starting = rejectionOf(startRpcServer(socketPath, () => ({ ok: true })));
    await vi.advanceTimersByTimeAsync(1_000_000_000_000);
    expect((await starting).message).toContain('already active');
    expect(statSync(socketPath).ino).toBe(inode);
    expect(server!.listening).toBe(true);
  });

  it.each(['EACCES', 'EAGAIN', 'EMFILE'])('does not unlink on probe %s', async code => {
    await listen(() => {});
    const inode = statSync(socketPath).ino;
    const peer = fakeSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(peer as unknown as Socket);
    const starting = rejectionOf(startRpcServer(socketPath, () => ({ ok: true })));
    const failure = Object.assign(new Error('probe failed'), { code });
    peer.emit('error', failure);
    expect(await starting).toBe(failure);
    expect(statSync(socketPath).ino).toBe(inode);
  });

  it('preserves a new listener when a negative result for an old socket is held', async () => {
    const previous = net.createServer();
    const previousPath = join(tempDir, 'previous.sock');
    await new Promise<void>(done => previous.listen(previousPath, done));
    linkSync(previousPath, socketPath);
    await new Promise<void>(done => previous.close(() => done()));
    const peer = fakeSocket();
    const connect = vi.spyOn(net, 'createConnection').mockReturnValue(peer as unknown as Socket);
    const starting = rejectionOf(startRpcServer(socketPath, () => ({ ok: true })));
    rmSync(socketPath);
    await listen(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: true }))));
    const inode = statSync(socketPath).ino;
    peer.emit('error', Object.assign(new Error('old connect refused'), { code: 'ECONNREFUSED' }));
    expect((await starting).message).toContain('needs inspection');
    connect.mockRestore();
    expect(statSync(socketPath).ino).toBe(inode);
    expect(await sendRpc(socketPath, { cmd: 'status' })).toEqual({ ok: true });
  });

  it.each(['refused', 'missing'] as const)('preserves a listener published immediately after the %s socket stat snapshot', async state => {
    if (state === 'refused') {
      const previous = net.createServer();
      const previousPath = join(tempDir, 'previous.sock');
      await new Promise<void>(done => previous.listen(previousPath, done));
      linkSync(previousPath, socketPath);
      await new Promise<void>(done => previous.close(() => done()));
    }
    const replacementPath = join(tempDir, 'replacement.sock');
    const live = net.createServer(socket => {
      peerSockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peerSockets.delete(socket));
      socket.once('data', () => socket.end(JSON.stringify({ ok: true, result: { ok: true } })));
    });
    await new Promise<void>(done => live.listen(replacementPath, done));
    const nativeStat = fs.statSync;
    let interleaved = false;
    const inspect = vi.spyOn(fs, 'statSync').mockImplementation(((path, options) => {
      const snapshot = nativeStat(path, options);
      if (path === socketPath && options?.throwIfNoEntry === false && !interleaved) {
        renameSync(replacementPath, socketPath);
        interleaved = true;
      }
      return snapshot;
    }) as typeof statSync);
    try {
      await expect(startRpcServer(socketPath, () => ({ ok: true }))).rejects.toThrow();
      expect(interleaved).toBe(true);
      expect(live.listening).toBe(true);
      expect(await sendRpc(socketPath, { cmd: 'status' })).toEqual({ ok: true });
    } finally {
      inspect.mockRestore();
      for (const socket of peerSockets) socket.destroy();
      await new Promise<void>(done => live.close(() => done()));
    }
  });

  it('leaves a refused socket for explicit owner cleanup after an unclean exit', async () => {
    // A second name for a listening socket survives the listener's close, like a socket left by SIGKILL.
    const previous = net.createServer();
    const previousPath = join(tempDir, 'previous.sock');
    await new Promise<void>(resolve => previous.listen(previousPath, resolve));
    linkSync(previousPath, socketPath);
    await new Promise<void>(resolve => previous.close(() => resolve()));
    expect(existsSync(socketPath)).toBe(true);
    const inode = statSync(socketPath).ino;
    await expect(startRpcServer(socketPath, () => ({ ok: true }))).rejects.toThrow('needs inspection');
    expect(statSync(socketPath).ino).toBe(inode);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeSocket() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    write(_payload: string, callback: (error?: Error | null) => void) { callback(); return true; },
    destroy() { this.destroyed = true; return this; },
  });
}
