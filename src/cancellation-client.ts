import { dirname, join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import {
  DaemonUnavailableError,
  CANCELLATION_RPC_TIMEOUT_MS,
  defaultSocketPath,
  RpcOutcomeUnknownError,
  sendRpc,
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
  sendRequest?: (request: RpcRequest) => Promise<RpcResponse>;
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
  request: (request: RpcRequest) => Promise<RpcResponse>;
  local: () => LocalCancellationControl;
  runsDirectory: string;
} {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const request = options.sendRequest ?? ((rpcRequest: RpcRequest) => (
    sendRpc<RpcResponse>(
      socketPath,
      rpcRequest,
      options.rpcTimeoutMs ?? (/^cancel(?:-|$)/.test(rpcRequest.cmd) ? CANCELLATION_RPC_TIMEOUT_MS : undefined),
    )
  ));
  let localControl = options.localControl;
  return {
    request,
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

export async function cancelRunThroughControlPlane(
  runId: string,
  unit?: string,
  options: CancellationClientOptions = {},
): Promise<CancellationResult> {
  const runtime = clientRuntime(options);
  runId = canonicalRunId(runtime.runsDirectory, runId);
  return requestRunCancellation(
    runId,
    unit,
    runtime.request,
    () => runtime.local().cancelRun(runId, unit),
  );
}

async function requestRunCancellation(
  runId: string,
  unit: string | undefined,
  request: (request: RpcRequest) => Promise<RpcResponse>,
  fallback: () => Promise<CancellationResult>,
): Promise<CancellationResult> {
  let response: RpcResponse;
  try {
    response = await request({ cmd: 'cancel-run', runId, ...(unit ? { unit } : {}) });
  } catch (error) {
    if (error instanceof RpcOutcomeUnknownError) {
      try {
        const observed = await request({ cmd: 'cancel-status', runId, ...(unit ? { unit } : {}) });
        if (isCancellationResult(observed, { runId })) return observed;
      } catch { /* preserve the original ambiguous delivery error below */ }
      throw error;
    }
    if (!(error instanceof DaemonUnavailableError)) throw error;
    return fallback();
  }
  if (isCancellationResult(response, { runId })) return response;
  // A complete but legacy/incomplete response has a known delivery outcome.
  // Re-run the idempotent coordinator locally to record the decision and
  // attempt owned cleanup; this is never used for an ambiguous transport failure.
  return fallback();
}

export async function cancelTaskThroughControlPlane(
  taskId: number,
  options: CancellationClientOptions = {},
): Promise<CancellationResult> {
  const runtime = clientRuntime(options);
  let response: RpcResponse;
  try {
    response = await runtime.request({ cmd: 'cancel', id: taskId });
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) throw error;
    return runtime.local().cancel(taskId);
  }
  if (isCancellationResult(response, { taskId })) return response;
  return runtime.local().cancel(taskId);
}
