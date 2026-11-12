import { dirname, join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import {
  DaemonUnavailableError,
  RpcInProgress,
  commandSocketPath,
  sendRpc,
  waitForRpc,
  type RpcWaitOptions,
  type RpcRequest,
  type RpcResponse,
} from './orchestrator-rpc.js';
import {
  type CancellationObservation,
  type CancellationResult,
} from './run-control.js';
import { isUnitStatus } from './supervision.js';
import { TaskRegistry } from './task-registry.js';
import { canonicalRunId } from './cancellation-policy.js';

export interface LocalCancellationControl {
  cancel(taskId: number): Promise<CancellationResult>;
  cancelRun(runId: string, unit?: string): Promise<CancellationResult>;
}

export interface CancellationClientOptions {
  socketPath?: string;
  rpcTimeoutMs?: number;
  sendRequest?: (request: RpcRequest, options?: RpcWaitOptions) => Promise<RpcResponse>;
  localControl?: LocalCancellationControl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCancellationObservation(value: unknown): value is CancellationObservation {
  if (!isRecord(value)) return false;
  return (value.unit === null || typeof value.unit === 'string')
    && isUnitStatus(value.unitState)
    && typeof value.runReadable === 'boolean'
    && (value.schedulerPid === null
      || (Number.isSafeInteger(value.schedulerPid) && Number(value.schedulerPid) > 0))
    && typeof value.schedulerAlive === 'boolean'
    && typeof value.launchInFlight === 'boolean'
    && (value.commandFateKnown === undefined || typeof value.commandFateKnown === 'boolean')
    && (value.activeCommandPids === undefined || (Array.isArray(value.activeCommandPids)
      && value.activeCommandPids.every(pid => Number.isSafeInteger(pid) && pid > 0)));
}

/** A complete response acknowledges the durable control decision. Its process
 * observation remains evidence, including unresolved fate, rather than a veto. */
export function isCancellationResult(
  value: unknown,
  expected: { runId?: string; taskId?: number } = {},
): value is CancellationResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.message !== 'string') return false;
  if (!['cancelled', 'cancelling', 'already-terminal', 'outcome-unknown'].includes(String(value.status))) return false;
  if (!isCancellationObservation(value.observation)) return false;
  if (value.runId !== undefined && typeof value.runId !== 'string') return false;
  if (value.taskId !== undefined && !Number.isSafeInteger(value.taskId)) return false;
  if (expected.runId !== undefined && value.runId !== expected.runId) return false;
  if (expected.taskId !== undefined && value.taskId !== expected.taskId) return false;

  if (!value.ok) {
    return value.status === 'cancelling'
      || (value.status === 'outcome-unknown' && value.observation.unitState.kind === 'terminal-unknown');
  }
  if (value.status === 'cancelling' || value.status === 'outcome-unknown') return false;
  return true;
}

function clientRuntime(options: CancellationClientOptions): {
  request: (request: RpcRequest) => Promise<RpcResponse | RpcInProgress>;
  local: () => LocalCancellationControl;
  runsDirectory: string;
} {
  const socketPath = commandSocketPath(options.socketPath);
  const send = options.sendRequest ?? ((request: RpcRequest, wait?: RpcWaitOptions) => sendRpc(socketPath, request, wait));
  let localControl = options.localControl;
  return {
    request: request => waitForRpc(signal => send(request, { signal }), options.rpcTimeoutMs),
    runsDirectory: join(dirname(socketPath), 'runs'),
    local: () => {
      if (!localControl) {
        const baseDir = dirname(socketPath);
        localControl = new Orchestrator({
          registry: new TaskRegistry({ baseDir }),
          cancellation: { runsDir: join(baseDir, 'runs') },
        });
      }
      return localControl;
    },
  };
}

export function cancelRunThroughControlPlane(
  runId: string,
  unit?: string,
  options?: CancellationClientOptions & { rpcTimeoutMs?: undefined },
): Promise<CancellationResult>;
export function cancelRunThroughControlPlane(
  runId: string,
  unit: string | undefined,
  options: CancellationClientOptions,
): Promise<CancellationResult | RpcInProgress>;
export async function cancelRunThroughControlPlane(
  runId: string,
  unit?: string,
  options: CancellationClientOptions = {},
): Promise<CancellationResult | RpcInProgress> {
  const runtime = clientRuntime(options);
  runId = canonicalRunId(runtime.runsDirectory, runId);
  return requestCancellation(
    { cmd: 'cancel', runId, ...(unit ? { unit } : {}) }, { runId }, runtime,
    () => runtime.local().cancelRun(runId, unit),
  );
}

async function requestCancellation(
  request: Extract<RpcRequest, { cmd: 'cancel' }>,
  expected: { runId?: string; taskId?: number },
  runtime: ReturnType<typeof clientRuntime>,
  fallback: () => Promise<CancellationResult>,
): Promise<CancellationResult | RpcInProgress> {
  let response: RpcResponse | RpcInProgress;
  try {
    response = await runtime.request(request);
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) throw error;
    return fallback();
  }
  // A complete legacy reply has a known delivery outcome; local cancellation is
  // idempotent. An ambiguous transport failure above must remain unknown.
  return response instanceof RpcInProgress || isCancellationResult(response, expected) ? response : fallback();
}

export function cancelTaskThroughControlPlane(
  taskId: number,
  options?: CancellationClientOptions & { rpcTimeoutMs?: undefined },
): Promise<CancellationResult>;
export function cancelTaskThroughControlPlane(
  taskId: number,
  options: CancellationClientOptions,
): Promise<CancellationResult | RpcInProgress>;
export async function cancelTaskThroughControlPlane(
  taskId: number,
  options: CancellationClientOptions = {},
): Promise<CancellationResult | RpcInProgress> {
  const runtime = clientRuntime(options);
  return requestCancellation(
    { cmd: 'cancel', id: taskId }, { taskId }, runtime,
    () => runtime.local().cancel(taskId),
  );
}
