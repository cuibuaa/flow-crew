import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CommandActivitySnapshot } from './command-activity.js';
import { appendGuidanceEnvelope } from './guidance.js';
import { appendRunEventAtRunDir } from './run-events.js';
import { isRunningRunStatus, isRunningStageStatus } from './store.js';

export const COMMAND_INTERRUPT_VERSION = 1;

export interface StageCommandInterruptSignal {
  version: 1;
  requestId: string;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
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
    .update(command.trim().replace(/\s+/g, ' '), 'utf8')
    .digest('hex');
}

export function parseStageCommandInterrupt(text: string): ParsedStageCommandInterrupt {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, error: 'invalid JSON' }; }
  if (value.version !== COMMAND_INTERRUPT_VERSION) return { ok: false, error: 'unsupported version' };
  for (const field of [
    'requestId', 'stageId', 'attemptStartedAt', 'commandId', 'command',
    'commandFingerprint', 'guidanceId', 'reason', 'requestedAt',
  ]) {
    if (!nonEmpty(value[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (!Number.isSafeInteger(value.attemptIndex) || Number(value.attemptIndex) < 0) {
    return { ok: false, error: 'attemptIndex must be a non-negative safe integer' };
  }
  if (value.source !== 'operator') return { ok: false, error: 'source must be operator' };
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

/** Publish an operator interrupt bound to the one command proved active now.
 * Guidance is durable before the one-shot signal can stop the adapter. */
export function requestStageCommandInterrupt(input: {
  runDir: string;
  stageId: string;
  reason: string;
  requestedAt?: string;
}): StageCommandInterruptSignal {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Interrupt reason must not be empty');
  const runState = JSON.parse(readFileSync(join(input.runDir, 'run.json'), 'utf-8')) as {
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
    join(input.runDir, 'stages', input.stageId, 'command_activity.json'),
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
  if (activity.active.length !== 1) {
    throw new Error(`Stage ${input.stageId} has ${activity.active.length} active commands; expected exactly one`);
  }
  const active = activity.active[0];
  if (!active.command?.trim()) throw new Error(`The active command for stage ${input.stageId} has no attributable command text`);
  const knownStageIds = Object.keys(runState.stages ?? {});
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const guidance = appendGuidanceEnvelope({
    runDir: input.runDir,
    target: input.stageId,
    source: 'operator',
    body: reason,
    knownStageIds,
    createdAt: requestedAt,
  });
  const signal: StageCommandInterruptSignal = {
    version: COMMAND_INTERRUPT_VERSION,
    requestId: randomUUID(),
    stageId: input.stageId,
    attemptIndex: activity.attemptIndex,
    attemptStartedAt: activity.attemptStartedAt,
    commandId: active.id,
    command: active.command,
    commandFingerprint: commandFingerprint(active.command),
    guidanceId: guidance.id,
    reason,
    requestedAt,
    source: 'operator',
  };
  // Keep the event ahead of the signal: once the worker can observe the
  // interrupt, the request is already present in the durable event sequence.
  appendRunEventAtRunDir(input.runDir, {
    type: 'stage_command_interrupt_requested',
    runId: typeof runState.runId === 'string' ? runState.runId : basename(input.runDir),
    timestamp: requestedAt,
    stageId: input.stageId,
    attemptIndex: activity.attemptIndex,
    attemptStartedAt: activity.attemptStartedAt,
    requestId: signal.requestId,
    guidanceId: guidance.id,
    commandId: active.id,
    command: active.command,
    commandFingerprint: signal.commandFingerprint,
    detail: reason,
    source: 'operator',
  });
  publishCreateOnly(
    join(input.runDir, 'signals', `interrupt_${input.stageId}.json`),
    `${JSON.stringify(signal, null, 2)}\n`,
  );
  return signal;
}
