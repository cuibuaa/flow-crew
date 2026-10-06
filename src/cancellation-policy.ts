import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface CanonicalRunIdentity {
  runId: string;
  directory: string;
  projectDir?: string;
}

export function requireSafeRunId(runId: string): void {
  if (!runId || runId === '.' || runId.includes('..') || /[/\\]/.test(runId)) {
    throw new Error(`RUN_IDENTITY_INVALID: invalid run id ${runId}`);
  }
}

/** Control authority follows the physical directory, never an alias spelling.
 * Archive readers do not use this check: old and unknown records remain data. */
export function resolveRunIdentity(directory: string, expectedRoot?: string): CanonicalRunIdentity {
  const physical = realpathSync(directory);
  const runId = basename(physical);
  requireSafeRunId(runId);
  if (expectedRoot && dirname(physical) !== realpathSync(expectedRoot)) {
    throw new Error('RUN_IDENTITY_OUTSIDE_ROOT: run control requires a directory in the selected run store');
  }
  let record: { runId?: unknown; projectDir?: unknown } | undefined;
  for (const name of ['run.json', '.run-reservation.json']) {
    const file = join(physical, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error('RUN_IDENTITY_PROJECTION_ALIAS: run control requires its own regular identity record');
      }
      record = JSON.parse(readFileSync(file, 'utf8'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (record?.runId !== undefined && record.runId !== runId) {
    throw new Error(`RUN_IDENTITY_BINDING: recorded run ${String(record.runId)} does not match physical directory ${runId}`);
  }
  return { runId, directory: physical, ...(typeof record?.projectDir === 'string' ? { projectDir: record.projectDir } : {}) };
}

/** Reservations and pre-initialization launch claims keep their safe new ID. */
export function canonicalRunId(root: string, runId: string): string {
  requireSafeRunId(runId);
  try {
    return resolveRunIdentity(join(root, runId), root).runId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return runId;
  }
}

export function cancelledRunPublicationError(runId: string): Error {
  return new Error(`RUN_CANCELLED: run ${runId} has acknowledged cancellation; start a new run instead of publishing or resuming this one`);
}

export function canonicalRunDirectory(directory: string): string {
  try { return realpathSync(directory); } catch { return resolve(directory); }
}
