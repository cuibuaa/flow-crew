import { EXIT_CODE } from './exit-code.js';
import { mkdirSync } from './engine-fs.js';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { assertCommandSocketAuthority, assertUnixSocketPath } from './daemon-identity.js';
import net from 'node:net';
import type { Server } from 'node:net';
import type { TaskCreateInput, TaskEntry, TaskListFilter } from './task-registry.js';
import { fcGlobalDir } from './store.js';
import type { CancellationResult } from './run-control.js';
import type { SupervisorLogSource, UnitStatus } from './supervision.js';
import type { OperationalProjection } from './cli-events.js';
import type { DeploymentStatus } from './orchestrator.js';

/** A caller stopped observing; this says nothing about the command's outcome. */
export class RpcInProgress {
  readonly status = 'in-progress';
  readonly code = 'RPC_IN_PROGRESS';
  readonly message = 'Request still in progress; inspect current state before issuing another command.';
}

export interface RpcWaitOptions {
  signal?: AbortSignal;
}

/** The only declared waiting limit. Abort retires the client observation, never
 * work in the daemon. The result is also usable with injected request senders. */
export async function waitForRpc<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  waitMs?: number,
): Promise<T | RpcInProgress> {
  if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647)) {
    throw new Error('RPC wait must be a nonnegative number within the Node timer range');
  }
  const controller = new AbortController();
  if (waitMs === undefined) return operation(controller.signal);
  let timer: ReturnType<typeof setTimeout>;
  const limited = new Promise<RpcInProgress>(resolve => {
    timer = setTimeout(() => {
      const result = new RpcInProgress();
      resolve(result);
      controller.abort(result);
    }, waitMs);
  });
  try {
    return await Promise.race([operation(controller.signal), limited]);
  } finally {
    clearTimeout(timer!);
  }
}

export class DaemonUnavailableError extends Error {
  readonly exitCode = EXIT_CODE.failed;

  constructor(message = 'daemon not running. Start with: flowcrew daemon start') {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

export class RpcOutcomeUnknownError extends Error {
  readonly exitCode = EXIT_CODE.outcomeUnknown;

  constructor(detail: string) {
    super(
      `${detail} The command may already have been delivered and taken effect. `
      + 'Verify current state before retrying (for tasks: flowcrew task list). '
      + 'Confirm the receiving daemon identity and build with: flowcrew daemon status.',
    );
    this.name = 'RpcOutcomeUnknownError';
  }
}

/** A daemon-declared rejection has a known outcome, unlike a lost response. */
export class RpcRemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RpcRemoteError';
  }
}

function rpcFailure(error: unknown): { ok: false; code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  // Preserve existing error codes at the boundary, including older coded messages.
  const code = (error as { code?: string } | null)?.code
    ?? /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? 'RPC_REFUSED';
  return { ok: false, code, message };
}

export function rpcErrorExitCode(error: unknown): number {
  return error instanceof RpcInProgress ? EXIT_CODE.inProgress
    : error instanceof RpcOutcomeUnknownError ? error.exitCode : EXIT_CODE.failed;
}

export type RpcRequest =
  | { cmd: 'register'; task: TaskCreateInput; acknowledgement?: 'persisted' }
  | { cmd: 'list'; filter?: TaskListFilter }
  | { cmd: 'show'; id: number; raw?: boolean }
  | ({ cmd: 'cancel' } & ({ id: number } | { runId: string; unit?: string }))
  | { cmd: 'retry'; id: number }
  | { cmd: 'resume'; id: number }
  | { cmd: 'tail'; id: number; lines?: number; follow?: boolean }
  | { cmd: 'status' }
  | { cmd: 'hold' | 'hold-status' }
  | { cmd: 'continue'; abandonHold?: string }
  | { cmd: 'stop' };

export interface RegisterRpcResponse {
  new_attempt?: number;
  id: number;
  unit: string;
  pid: number;
  build: string;
  /** New unbound task persisted; launch is drained independently by the daemon. */
  acknowledgement?: 'persisted';
}

export interface TaskListRpcResponse {
  tasks: TaskShowEntry[];
  registry_unreadable_records?: number;
}

/** Registry fields plus authoritative run.json fields merged by the daemon read path. */
export interface TaskShowEntry extends TaskEntry {
  run?: { status: string; failureReason?: string; completedAt?: string };
  engine_history?: import('./store.js').StoreState['engineHistory'];
  continuation_failure?: import('./store.js').StoreState['continuationFailure'];
  /** A scheduler identity verified against the bound run, independent of the launch unit. */
  scheduler_live?: { pid: number };
  operational?: OperationalProjection;
  run_verdict?: string;
  terminal_status_mismatch?: {
    lifecycle_status: string;
    terminal_status: string;
    terminal_artifact: string;
  };
}

export interface TaskShowRpcResponse {
  task: TaskShowEntry;
  recent_ticks: string[];
  unit_status?: UnitStatus;
  exit_code?: number;
}

export interface TaskTailRpcResponse {
  output: string;
  source?: SupervisorLogSource;
}

export interface DaemonStatusRpcResponse {
  uptime: number;
  watched_tasks: number;
  registry_unreadable_records: number;
  /** Cached by the daemon's incremental registry reader; absent on legacy daemons. */
  registry_bytes?: number;
  registry_records?: number;
  registry_tasks?: number;
  pid: number;
  startedAt: string;
  socketPath: string;
  build: string;
  buildFiles: number;
  buildNewestMtimeMs: number;
}

export type RpcResponse =
  | DeploymentStatus
  | RegisterRpcResponse
  | TaskListRpcResponse
  | TaskShowRpcResponse
  | { ok: true }
  | CancellationResult
  | { new_attempt: number; unit: string }
  | TaskTailRpcResponse
  | DaemonStatusRpcResponse
  | { error: string };

export interface RpcHandlerError {
  request: RpcRequest;
  error: Error;
}

export interface RpcServerOptions {
  /** Runs after the response has been queued, including a disconnected client. */
  onResponse?: (request: RpcRequest, response: RpcResponse) => void;
  onHandlerError?: (failure: RpcHandlerError) => void;
}

export function formatDaemonRegistration(
  response: Pick<RegisterRpcResponse, 'id' | 'unit'> & Partial<Pick<RegisterRpcResponse, 'pid' | 'build'>>,
): string {
  const pid = Number.isInteger(response.pid) && (response.pid ?? 0) > 0 ? response.pid : 'UNVERIFIED';
  const build = typeof response.build === 'string' && response.build.length > 0 ? response.build : 'UNVERIFIED';
  const suffix = pid === 'UNVERIFIED' || build === 'UNVERIFIED'
    ? '. Confirm the receiving process with: flowcrew daemon status.'
    : '';
  return `Task #${response.id} registered (daemon pid=${pid}, build=${build}). Unit: ${response.unit}${suffix}`;
}

export function defaultSocketPath(): string {
  const path = join(fcGlobalDir(), 'daemon.sock');
  assertUnixSocketPath(path);
  return path;
}

/** FC_HOME selects the daemon; only an explicit socket overrides it. */
export function commandSocketPath(explicit?: string): string {
  const path = explicit ?? defaultSocketPath();
  assertCommandSocketAuthority(path, homedir(), fcGlobalDir());
  return path;
}

export function sendRpc<T extends RpcResponse = RpcResponse>(
  socketPath: string,
  request: RpcRequest,
  options?: RpcWaitOptions,
): Promise<T>;
export function sendRpc<T extends RpcResponse = RpcResponse>(
  socketPath: string,
  request: RpcRequest,
  waitMs: number | undefined,
): Promise<T | RpcInProgress>;
export async function sendRpc<T extends RpcResponse = RpcResponse>(
  socketPath: string,
  request: RpcRequest,
  options?: number | RpcWaitOptions,
): Promise<T | RpcInProgress> {
  if (typeof options === 'number') {
    return waitForRpc(signal => requestOnConnection<T>(socketPath, request, signal), options);
  }
  return requestOnConnection<T>(socketPath, request, options?.signal);
}

function requestOnConnection<T extends RpcResponse>(
  socketPath: string,
  request: RpcRequest,
  signal?: AbortSignal,
): Promise<T> {
  assertUnixSocketPath(socketPath);
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = net.createConnection(socketPath);
    let raw = '';
    let requestWritten = false;
    let connected = false;
    let settled = false;
    let connectionError: Error | undefined;
    const onAbort = () => rejectOnce(signal!.reason);
    const rejectOnce = (error: unknown, destroy = true) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (destroy && !socket.destroyed) socket.destroy();
      reject(error);
    };
    const resolveOnce = (response: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    };
    const transportFailure = (detail: string): Error => (
      requestWritten ? new RpcOutcomeUnknownError(detail) : connectionError ?? new Error(detail)
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('connect', () => {
      if (settled) return;
      connected = true;
      try {
        socket.write(JSON.stringify(request), (error) => {
          if (settled) return;
          if (error) {
            connectionError = error;
            socket.destroy();
            return;
          }
          requestWritten = true;
        });
      } catch (error) {
        connectionError = error instanceof Error ? error : new Error(String(error));
        socket.destroy();
      }
    });
    socket.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    socket.on('error', (error) => {
      connectionError = error;
      if (!connected && isAbsentSocket(error)) rejectOnce(new DaemonUnavailableError());
      // Other errors are not evidence of absence. A written request becomes
      // unknown only when the connection actually closes without its answer.
    });
    socket.on('end', () => {
      if (settled) return;
      if (raw.trim().length === 0) {
        rejectOnce(transportFailure('daemon connection closed without a response.'), false);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || ('ok' in parsed && typeof parsed.ok !== 'boolean')) throw new Error('invalid response');
        if ('result' in parsed || 'code' in parsed || (parsed.ok === false && !('status' in parsed))) {
          if (parsed.ok === false && typeof parsed.code === 'string' && typeof parsed.message === 'string') {
            rejectOnce(new RpcRemoteError(parsed.code, parsed.message), false);
          } else if (parsed.ok === true && parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)) {
            resolveOnce(parsed.result as T);
          } else throw new Error('invalid envelope');
        } else if ('error' in parsed) {
          // Accept the previous daemon's {error} shape for one deployment cycle.
          if (typeof parsed.error !== 'string') throw new Error('invalid legacy error');
          const failure = rpcFailure(new Error(parsed.error));
          rejectOnce(new RpcRemoteError(failure.code, failure.message), false);
        } else if (Object.keys(parsed).length) {
          resolveOnce(parsed as T); // Previous daemon's unwrapped success.
        } else throw new Error('invalid legacy response');
      } catch {
        rejectOnce(transportFailure('daemon connection closed with an invalid response.'), false);
      }
    });
    socket.on('close', () => {
      if (!settled) {
        rejectOnce(transportFailure(`daemon connection closed before a complete response${connectionError ? `: ${connectionError.message}` : ''}.`), false);
      }
    });
  });
}

export async function startRpcServer(
  socketPath: string,
  handler: (request: RpcRequest) => Promise<RpcResponse> | RpcResponse,
  opts: RpcServerOptions = {},
): Promise<Server> {
  assertUnixSocketPath(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true });
  if (fs.statSync(socketPath, { throwIfNoEntry: false })) {
    const live = await probeSocket(socketPath);
    if (live) throw new Error(`daemon socket already active: ${socketPath}`);
    // A negative connect result cannot authorize a later unlink: another
    // listener could bind between those operations. Leave cleanup to the owner.
    throw new Error(`daemon socket needs inspection before removal: ${socketPath}`);
  }

  const server = net.createServer((socket) => {
    let raw = '';
    let handled = false;
    // Swallow EPIPE / connection reset from clients that disconnect mid-write.
    // Without this listener Node escalates socket errors to an uncaught
    // exception that crashes the whole daemon.
    socket.on('error', () => {});
    const safeEnd = (payload: string) => {
      try {
        if (!socket.destroyed && socket.writable) socket.end(payload);
      } catch { /* socket already closed */ }
    };
    socket.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    socket.on('data', async () => {
      if (handled) return;
      let req: RpcRequest;
      try {
        req = JSON.parse(raw) as RpcRequest;
      } catch (err) {
        if (err instanceof SyntaxError) return;
        safeEnd(JSON.stringify(rpcFailure(err)));
        return;
      }
      handled = true;
      try {
        const res = await handler(req);
        safeEnd(JSON.stringify('error' in res ? rpcFailure(new Error(res.error)) : { ok: true, result: res }));
        try { opts.onResponse?.(req, res); } catch { /* durable queue survives notification failure */ }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { opts.onHandlerError?.({ request: req, error }); } catch { /* logging must not hide the RPC error */ }
        safeEnd(JSON.stringify(rpcFailure(error)));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function isAbsentSocket(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
}

async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (error) => {
      socket.destroy();
      if (isAbsentSocket(error)) resolve(false);
      else reject(error);
    });
  });
}
