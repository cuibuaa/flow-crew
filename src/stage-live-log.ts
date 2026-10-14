import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Indices restart when a later plan reuses a stage ID. Bind stream and input
// evidence to the same execution identity, including its start time.
export function stageAttemptKey(index: number, startedAt: string): string {
  return `attempt_${index}_${createHash('sha256').update(startedAt).digest('hex').slice(0, 24)}`;
}

function stageAttempt(runDir: string, stageId: string, index?: number): { index: number; startedAt: string } | undefined {
  try {
    const status = JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf8'));
    return index === undefined ? status.attempts?.at(-1)
      : status.attempts?.find((attempt: { index: number }) => attempt.index === index);
  } catch { return undefined; }
}

/** Native streams and engine diagnostics share one file per stage attempt.
 * Standalone invocations without an attempt keep the legacy stage-level slot. */
export function stageLiveLogPath(runDir: string, stageId: string, attemptIndex?: number, startedAt?: string): string {
  startedAt ??= attemptIndex === undefined ? undefined : stageAttempt(runDir, stageId, attemptIndex)?.startedAt;
  return attemptIndex === undefined ? readStageLiveLogPath(runDir, stageId)
    : join(runDir, 'stages', stageId, `live_${stageAttemptKey(attemptIndex, startedAt ?? '')}.log`);
}

/** Old runs have only live.log. Resolve on each read so followers also notice
 * a new attempt, including one whose stream is shorter than its predecessor. */
export function readStageLiveLogPath(runDir: string, stageId: string, attemptIndex?: number): string {
  const stageDir = join(runDir, 'stages', stageId);
  const attempt = stageAttempt(runDir, stageId, attemptIndex);
  attemptIndex ??= attempt?.index;
  if (attemptIndex !== undefined) {
    const path = stageLiveLogPath(runDir, stageId, attemptIndex, attempt?.startedAt);
    if (existsSync(path)) return path;
  }
  return join(stageDir, 'live.log');
}
