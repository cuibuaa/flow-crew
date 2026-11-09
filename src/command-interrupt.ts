import { runRecordPath, requestPath } from './run-layout.js';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { CommandActivitySnapshot } from './command-activity.js';
import { isRunningRunStatus, isRunningStageStatus } from './store.js';

export const COMMAND_INTERRUPT_VERSION = 1;
const DEFAULT_INTERRUPT_REASON = 'Operator requested interruption of the active command.';

export interface StageCommandInterruptSignal {
  version: 1;
  requestId: string;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  invocationIndex?: number;
  commandId: string;
  command: string;
  commandFingerprint: string;
  guidanceId: string;
  reason: string;
  requestedAt: string;
  source: 'operator';
}

export type ParsedStageCommandInterrupt =
  | { ok: true; signal: StageCommandInterruptSignal }
  | { ok: false; error: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function commandFingerprint(command: string): string {
  return createHash('sha256')
    .update(command, 'utf8')
    .digest('hex');
}

export function parseStageCommandInterrupt(text: string): ParsedStageCommandInterrupt {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, error: 'invalid JSON' }; }
  if (value.version !== COMMAND_INTERRUPT_VERSION) return { ok: false, error: 'unsupported version' };
  for (const field of [
    'requestId', 'stageId', 'attemptStartedAt', 'commandId',
    'commandFingerprint', 'guidanceId', 'requestedAt',
  ]) {
    if (!nonEmpty(value[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (!Number.isSafeInteger(value.attemptIndex) || Number(value.attemptIndex) < 0) {
    return { ok: false, error: 'attemptIndex must be a non-negative safe integer' };
  }
  if (typeof value.command !== 'string') return { ok: false, error: 'command must be a string' };
  if (value.invocationIndex !== undefined && (!Number.isSafeInteger(value.invocationIndex) || Number(value.invocationIndex) < 1)) return { ok: false, error: 'invalid invocationIndex' };
  if (value.source !== 'operator') return { ok: false, error: 'source must be operator' };
  if (value.reason !== undefined && typeof value.reason !== 'string') return { ok: false, error: 'reason must be a string' };
  value.reason = (value.reason as string | undefined)?.trim() || DEFAULT_INTERRUPT_REASON;
  const signal = value as unknown as StageCommandInterruptSignal;
  if (commandFingerprint(signal.command) !== signal.commandFingerprint) {
    return { ok: false, error: 'command fingerprint mismatch' };
  }
  return { ok: true, signal };
}

function publishCreateOnly(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, body, { encoding: 'utf-8', flag: 'wx' });
  try {
    linkSync(temp, path);
  } catch (error) {
    if (existsSync(path)) throw new Error(`An interrupt request is already pending at ${path}`, { cause: error });
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

/** Publish an operator interrupt bound to the invocation with commands proved active now.
 * The engine records validated guidance before the request can stop the adapter. */
export function requestStageCommandInterrupt(input: {
  runDir: string;
  stageId: string;
  reason?: string;
  requestedAt?: string;
}): StageCommandInterruptSignal {
  const reason = input.reason?.trim() || DEFAULT_INTERRUPT_REASON;
  const runState = JSON.parse(readFileSync(runRecordPath(input.runDir, 'run.json'), 'utf-8')) as {
    runId?: unknown;
    status?: unknown;
    stages?: Record<string, {
      status?: unknown;
      attempts?: Array<{ index?: unknown; startedAt?: unknown; status?: unknown }>;
    }>;
  };
  if (!isRunningRunStatus(String(runState.status ?? ''))) {
    throw new Error(`Run ${basename(input.runDir)} is not running`);
  }
  if (!isRunningStageStatus(String(runState.stages?.[input.stageId]?.status ?? ''))) {
    throw new Error(`Stage ${input.stageId} is not running`);
  }
  const activity = JSON.parse(readFileSync(
    runRecordPath(input.runDir, 'stages', input.stageId, 'command_activity.json'),
    'utf-8',
  )) as CommandActivitySnapshot;
  if (activity.version !== 1 || activity.stageId !== input.stageId || activity.streamClosed) {
    throw new Error(`Stage ${input.stageId} has no current command lifecycle`);
  }
  if (!Number.isSafeInteger(activity.attemptIndex) || !activity.attemptStartedAt) {
    throw new Error(`Stage ${input.stageId} command lifecycle has no valid attempt identity`);
  }
  const currentAttempt = runState.stages?.[input.stageId]?.attempts?.at(-1);
  if (!currentAttempt
    || !isRunningStageStatus(String(currentAttempt.status ?? ''))
    || currentAttempt.index !== activity.attemptIndex
    || currentAttempt.startedAt !== activity.attemptStartedAt) {
    throw new Error(`Stage ${input.stageId} command lifecycle is stale for the current attempt`);
  }
  if (activity.active.length === 0) throw new Error(`Stage ${input.stageId} has no active commands`);
  const active = activity.active[0];
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const signal: StageCommandInterruptSignal = {
    version: COMMAND_INTERRUPT_VERSION,
    requestId: randomUUID(),
    stageId: input.stageId,
    attemptIndex: activity.attemptIndex,
    attemptStartedAt: activity.attemptStartedAt,
    commandId: active.id,
    ...(activity.invocationIndex === undefined ? {} : { invocationIndex: activity.invocationIndex }),
    command: active.command ?? '',
    commandFingerprint: commandFingerprint(active.command ?? ''),
    guidanceId: randomUUID(),
    reason,
    requestedAt,
    source: 'operator',
  };
  // This is a request slot. The owning engine validates the active command
  // and publishes guidance/events from its own memory before stopping it.
  publishCreateOnly(
    requestPath(input.runDir, 'signals', `interrupt_${input.stageId}.json`),
    `${JSON.stringify(signal, null, 2)}\n`,
  );
  return signal;
}
