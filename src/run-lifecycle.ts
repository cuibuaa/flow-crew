import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './engine-fs.js';
import { appendDurableTextRecord, flushTextRecords } from './append-boundary.js';
import { engineDirectory, hasSeparatedRunLayout, runRecordPath } from './run-layout.js';
import { hasLifecycleAuthority, LIFECYCLE_AUTHORITY } from './run-lifecycle-authority.js';
import { foldRunLifecycle, type LifecycleCursor } from './run-lifecycle-fold.js';
import { readLegacyRunStatus } from './legacy-run-status.js';
import { isTerminalRunStatus, requireKnownRunStatus } from './lifecycle-status.js';

interface LifecycleRecord {
  runId: string;
  status: unknown;
  lifecycleAuthority?: typeof LIFECYCLE_AUTHORITY;
  lifecycleCursor?: LifecycleCursor;
}
const logPath = (directory: string): string => join(directory, 'events.jsonl');
const cursorPath = (directory: string): string => runRecordPath(directory, 'run_event_status.json');
function readCursor(directory: string): unknown {
  try { return JSON.parse(readFileSync(cursorPath(directory), 'utf8')); }
  catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function readLog(directory: string): string {
  try { return readFileSync(logPath(directory), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
function requireFold(bytes: string): LifecycleCursor {
  const folded = foldRunLifecycle(bytes);
  if (!folded) throw new Error('Declared run has no complete lifecycle event');
  return folded;
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function wrapUpNotice(decision: Record<string, unknown>): Record<string, unknown> {
  return { type: 'operator_wrap_up_required', runId: decision.runId, timestamp: decision.timestamp,
    runStatus: decision.runStatus, observationId: decision.observationId, source: 'scheduler', level: 'warning',
    detail: `run reached terminal status ${decision.runStatus}; any linked open fc_tasks entry requires human wrap-up and explicit completion; terminal state is not acceptance` };
}

/** Retain the existing wrap-up obligation across short/torn batch writes. Its
 * only source is the recorded decision, never a snapshot or cursor. */
function completeLifecycleNotices(directory: string, bytes: string): void {
  const decisions: Array<Record<string, unknown>> = [], noticed = new Set<unknown>();
  for (const line of bytes.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row?.type === 'operator_wrap_up_required') noticed.add(row.observationId);
      if (row?.type === 'run_status_changed' && row.lifecycleVersion === 1 && row.wrapUpRequired === true
          && typeof row.observationId === 'string') decisions.push(row);
    } catch { /* malformed append retained */ }
  }
  const missing = decisions.filter(row => !noticed.has(row.observationId));
  if (missing.length) appendDurableTextRecord(logPath(directory), missing.map(row => JSON.stringify(wrapUpNotice(row))).join('\n'));
}

/** Admission's declaration is recorded before the first lifecycle append. It
 * keeps that first append readable even if the first snapshot never publishes. */
export function readRunSnapshot(directory: string, read: (path: string) => string = path => readFileSync(path, 'utf8')): Record<string, unknown> {
  try { return JSON.parse(read(join(directory, 'run.json'))) as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const admission = JSON.parse(read(join(engineDirectory(directory), '.run-reservation.json')));
    if (!hasLifecycleAuthority(admission)) throw error;
    return { runId: admission.runId, projectDir: admission.projectDir, storageLayout: 2,
      lifecycleAuthority: admission.lifecycleAuthority, workflowName: admission.workflowName,
      startedAt: admission.startedAt, stages: {}, status: undefined };
  }
}

/** Read projection only; the injected byte reader keeps watch's read capability explicit. */
export function projectRunLifecycle<T extends { status?: unknown; lifecycleAuthority?: unknown }>(
  directory: string, record: T, read: (path: string) => string = path => readFileSync(path, 'utf8'),
): T {
  if (!hasLifecycleAuthority(record)) return Object.assign(record, { status: readLegacyRunStatus(record) });
  const folded = requireFold(read(logPath(directory)));
  return Object.assign(record, { status: folded.status, lifecycleCursor: folded });
}

/** Caller owns the run lock. Cache reconciliation never appends a lifecycle decision. */
export function reconcileRunLifecycle(directory: string): void {
  let record: LifecycleRecord;
  try { record = readRunSnapshot(directory) as unknown as LifecycleRecord; }
  catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!hasLifecycleAuthority(record)) return;
  const eventBytes = readLog(directory);
  const folded = foldRunLifecycle(eventBytes);
  // Declaration precedes the first fact during admission. There is no status
  // to cache yet; a declared existing snapshot still fails closed on reads.
  if (!folded && record.status === undefined) return;
  if (!folded) throw new Error('Declared run has no complete lifecycle event');
  completeLifecycleNotices(directory, eventBytes);
  const cursor = readCursor(directory);
  const stale = record.status !== folded.status || !equal(record.lifecycleCursor, folded);
  if (!stale && equal(cursor, folded)) return;
  // Also retries an append whose fsync failed after its bytes became visible.
  flushTextRecords(logPath(directory));
  if (stale) writeSnapshot(directory, { ...record, status: folded.status, lifecycleCursor: folded });
  if (!equal(cursor, folded)) atomicWrite(cursorPath(directory), JSON.stringify(folded) + '\n');
}

function writeSnapshot(directory: string, record: LifecycleRecord): void {
  atomicWrite(join(directory, 'run.json'), JSON.stringify(record) + '\n', {
    stagingDirectory: hasSeparatedRunLayout(directory) ? engineDirectory(directory) : undefined,
  });
}

/** The one lifecycle decision boundary, called under the run lock BEFORE any
 * status-bearing projection. Snapshot/cursor values never fill a declared log. */
export function recordRunLifecycle(directory: string, record: LifecycleRecord, previous?: LifecycleRecord): void {
  const declared = hasLifecycleAuthority(record);
  if (previous && hasLifecycleAuthority(previous) && !declared) throw new Error('Cannot remove lifecycle authority');
  const bytes = readLog(directory);
  completeLifecycleNotices(directory, bytes);
  const prior = declared && previous ? requireFold(bytes) : foldRunLifecycle(bytes);
  const status = requireKnownRunStatus(record.status, 'publish lifecycle');
  const changing = declared ? prior?.status !== status : previous?.status !== status;
  if (changing) {
    const timestamp = new Date().toISOString();
    const observationId = `lifecycle:${(prior?.sequence ?? 0) + 1}`;
    const wrapUpRequired = isTerminalRunStatus(status) && !isTerminalRunStatus(declared ? prior?.status : previous?.status);
    const events: Array<Record<string, unknown>> = [{ type: 'run_status_changed', lifecycleVersion: 1, runId: record.runId,
      timestamp, runStatus: status, source: 'scheduler', observationId, ...(wrapUpRequired ? { wrapUpRequired } : {}) }];
    if (wrapUpRequired) events.push(wrapUpNotice(events[0]));
    // One durable batch publishes the decision and its existing wrap-up obligation.
    appendDurableTextRecord(logPath(directory), events.map(event => JSON.stringify(event)).join('\n'));
  } else if (declared && !previous) flushTextRecords(logPath(directory));
  if (declared) record.lifecycleCursor = changing ? requireFold(readLog(directory)) : prior;
}

/** Cursor is just a cache; it is written only after the durable decision. */
export function writeRunLifecycleCursor(directory: string, record: LifecycleRecord): void {
  if (hasLifecycleAuthority(record) && !equal(readCursor(directory), record.lifecycleCursor)) {
    atomicWrite(cursorPath(directory), JSON.stringify(record.lifecycleCursor) + '\n');
  }
}

/** Accepted legacy resume only, under the run lock. The import's presence is
 * an idempotence key, never an authority selector. A crash before declaration
 * leaves legacy display intact; retry flushes and adopts the SAME import. */
export function importLegacyRunLifecycle(directory: string): void {
  const record = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')) as LifecycleRecord;
  if (hasLifecycleAuthority(record)) return;
  const status = requireKnownRunStatus(record.status, 'import legacy lifecycle');
  const bytes = readLog(directory);
  const imported = bytes.split('\n').some(line => {
    try { const row = JSON.parse(line); return row.type === 'run_status_imported'
      && row.lifecycleVersion === 1 && row.snapshotSource === 'run.json' && row.runId === record.runId
      && foldRunLifecycle(line + '\n') !== undefined; }
    catch { return false; }
  });
  if (!imported) appendDurableTextRecord(logPath(directory), JSON.stringify({
    type: 'run_status_imported', lifecycleVersion: 1, runId: record.runId,
    timestamp: new Date().toISOString(), runStatus: status, snapshotSource: 'run.json', snapshotStatus: record.status,
  }));
  else flushTextRecords(logPath(directory));
  const folded = requireFold(readLog(directory));
  record.lifecycleAuthority = LIFECYCLE_AUTHORITY;
  record.status = folded.status;
  record.lifecycleCursor = folded;
  writeSnapshot(directory, record);
  writeRunLifecycleCursor(directory, record);
}
