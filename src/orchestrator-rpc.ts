import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import type { Server } from 'node:net';
import type { TaskCreateInput, TaskEntry, TaskListFilter } from './task-registry.js';
import { fcGlobalDir } from './store.js';
import type { CancellationResult } from './run-control.js';
import type { SupervisorLogSource, UnitStatus } from './supervision.js';

export const DEFAULT_RPC_TIMEOUT_MS = 2_000;

export class DaemonUnavailableError extends Error {
  readonly exitCode = 1;

  constructor(message = 'daemon not running. Start with: flowcrew daemon start') {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

export class RpcOutcomeUnknownError extends Error {
  readonly exitCode = 2;

  constructor(detail: string) {
    super(
      `${detail} The command may already have been delivered and taken effect. `
      + 'Verify current state before retrying (for tasks: flowcrew task list). '
      + 'Confirm the receiving daemon identity and build with: flowcrew daemon status.',
    );
    this.name = 'RpcOutcomeUnknownError';
  }
}

export function rpcErrorExitCode(error: unknown): number {
  return error instanceof RpcOutcomeUnknownError ? error.exitCode : 1;
}

export type RpcRequest =
  | { cmd: 'register'; task: TaskCreateInput }
  | { cmd: 'list'; filter?: TaskListFilter }
  | { cmd: 'show'; id: number }
  | { cmd: 'cancel'; id: number }
  | { cmd: 'cancel-run'; runId: string; unit?: string }
  | { cmd: 'retry'; id: number }
  | { cmd: 'tail'; id: number; lines?: number; follow?: boolean }
  | { cmd: 'status' }
  | { cmd: 'stop' };

export interface RegisterRpcResponse {
  id: number;
  unit: string;
  pid: number;
  build: string;
}

export interface TaskListRpcResponse {
  tasks: TaskEntry[];
  registry_unreadable_records?: number;
}

/** Registry fields plus authoritative run.json fields merged by the daemon read path. */
export interface TaskShowEntry extends Omit<TaskEntry, 'status'> {
  status: string;
  run_verdict?: string;
  failure_reason?: string;
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
  pid: number;
  startedAt: string;
  socketPath: string;
  build: string;
  buildFiles: number;
  buildNewestMtimeMs: number;
}

export type RpcResponse =
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
  return join(fcGlobalDir(), 'daemon.sock');
}

export async function sendRpc<T extends RpcResponse = RpcResponse>(
  socketPath: string,
  request: RpcRequest,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    let requestWritten = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };
    const rejectOnce = (error: Error, destroy = true) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (destroy && !socket.destroyed) socket.destroy();
      reject(error);
    };
    const resolveOnce = (response: T) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve(response);
    };
    const transportFailure = (detail: string): Error => (
      requestWritten ? new RpcOutcomeUnknownError(detail) : new DaemonUnavailableError()
    );

    timer = setTimeout(() => {
      rejectOnce(transportFailure(`daemon response timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.on('connect', () => {
      try {
        socket.write(JSON.stringify(request), (error) => {
          if (settled) return;
          if (error) {
            rejectOnce(transportFailure(`daemon connection failed while sending the request: ${error.message}.`));
            return;
          }
          requestWritten = true;
        });
      } catch (error) {
        rejectOnce(transportFailure(`daemon connection failed while sending the request: ${error instanceof Error ? error.message : String(error)}.`));
      }
    });
    socket.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    socket.on('error', (error) => {
      rejectOnce(transportFailure(`daemon connection failed before a complete response: ${error.message}.`));
    });
    socket.on('end', () => {
      if (settled) return;
      if (raw.trim().length === 0) {
        rejectOnce(transportFailure('daemon connection closed without a response.'), false);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as T;
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          const daemonError = (parsed as { error?: unknown }).error;
          if (typeof daemonError === 'string') rejectOnce(new Error(daemonError), false);
          else rejectOnce(new RpcOutcomeUnknownError('daemon returned an invalid error response.'), false);
        } else {
          resolveOnce(parsed);
        }
      } catch {
        rejectOnce(new RpcOutcomeUnknownError('daemon connection closed with an invalid response.'), false);
      }
    });
    socket.on('close', () => {
      if (!settled) {
        rejectOnce(transportFailure('daemon connection closed before a complete response.'), false);
      }
    });
  });
}

export async function startRpcServer(
  socketPath: string,
  handler: (request: RpcRequest) => Promise<RpcResponse> | RpcResponse,
  opts: RpcServerOptions = {},
): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    const live = await probeSocket(socketPath);
    if (live) throw new Error(`daemon socket already active: ${socketPath}`);
    rmSync(socketPath, { force: true });
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
        safeEnd(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      handled = true;
      try {
        const res = await handler(req);
        safeEnd(JSON.stringify(res));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        try { opts.onHandlerError?.({ request: req, error }); } catch { /* logging must not hide the RPC error */ }
        safeEnd(JSON.stringify({ error: error.message }));
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

async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
