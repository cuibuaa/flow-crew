import { basename, dirname, isAbsolute, join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import {
  DaemonUnavailableError,
  defaultSocketPath,
  RpcOutcomeUnknownError,
  sendRpc,
  type RpcRequest,
  type RpcResponse,
} from './orchestrator-rpc.js';
import {
  unitIsStopped,
  type CancellationObservation,
  type CancellationResult,
} from './run-control.js';
import { isUnitStatus } from './supervision.js';
import { TaskRegistry, type TaskEntry } from './task-registry.js';

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
    && typeof value.launchInFlight === 'boolean';
}

/**
 * RPC success is only authoritative when it contains the coordinator's full
 * observation and that observation proves every stop barrier. A legacy
 * `{ok:true}` therefore cannot be mistaken for convergence.
 */
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
  const observation = value.observation;
  return observation.unitState.kind !== 'terminal-unknown'
    && unitIsStopped(observation.unitState)
    && observation.runReadable
    && !observation.schedulerAlive
    && !observation.launchInFlight;
}

function taskFromShowResponse(value: unknown, taskId: number): TaskEntry | undefined {
  if (!isRecord(value) || !isRecord(value.task)) return undefined;
  const task = value.task;
  if (task.id !== taskId || typeof task.systemd_unit !== 'string') return undefined;
  if (task.run_id !== undefined && typeof task.run_id !== 'string') return undefined;
  return task as unknown as TaskEntry;
}

function explicitlyUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:unknown|unsupported)\s+(?:rpc\s+)?command|command\s+(?:is\s+)?(?:unknown|unsupported)/i.test(error.message);
}

function mayFallbackAfter(error: unknown): boolean {
  if (error instanceof RpcOutcomeUnknownError) return false;
  return error instanceof DaemonUnavailableError || explicitlyUnsupported(error);
}

function clientRuntime(options: CancellationClientOptions): {
  request: (request: RpcRequest) => Promise<RpcResponse>;
  local: () => LocalCancellationControl;
} {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const request = options.sendRequest ?? ((rpcRequest: RpcRequest) => (
    sendRpc<RpcResponse>(socketPath, rpcRequest, options.rpcTimeoutMs)
  ));
  let localControl = options.localControl;
  return {
    request,
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
    if (!mayFallbackAfter(error)) throw error;
    return fallback();
  }
  if (isCancellationResult(response, { runId })) return response;
  // A complete but legacy/incomplete response has a known delivery outcome.
  // Re-run the idempotent coordinator locally so it verifies all barriers and
  // settles run.json; this is never used for an ambiguous transport failure.
  return fallback();
}

export async function cancelTaskThroughControlPlane(
  taskId: number,
  options: CancellationClientOptions = {},
): Promise<CancellationResult> {
  const runtime = clientRuntime(options);
  let task: TaskEntry | undefined;
  try {
    task = taskFromShowResponse(await runtime.request({ cmd: 'show', id: taskId }), taskId);
  } catch (error) {
    if (!mayFallbackAfter(error)) throw error;
    return runtime.local().cancel(taskId);
  }
  if (!task) return runtime.local().cancel(taskId);

  if (task.run_id) {
    const runId = isAbsolute(task.run_id) ? basename(task.run_id) : task.run_id;
    // The daemon protocol is run-id first. If compatibility finalization is
    // needed, retain the registry task binding (including legacy absolute run
    // paths) instead of re-deriving that binding from the socket root.
    return requestRunCancellation(
      runId,
      task.systemd_unit,
      runtime.request,
      () => runtime.local().cancel(taskId),
    );
  }

  let response: RpcResponse;
  try {
    response = await runtime.request({ cmd: 'cancel', id: taskId });
  } catch (error) {
    if (!mayFallbackAfter(error)) throw error;
    return runtime.local().cancel(taskId);
  }
  if (isCancellationResult(response, { taskId })) return response;
  return runtime.local().cancel(taskId);
}
