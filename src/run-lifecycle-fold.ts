import { RUN_STATUS_SEMANTICS, type RunStatus } from './lifecycle-status.js';

export interface LifecycleCursor {
  version: 2;
  sequence: number;
  status: RunStatus;
  observedAt: string;
}

/** Only complete, versioned lifecycle records are facts. Append order wins;
 * diagnostic/completion notices and torn or malformed rows carry no status.
 * This function has no filesystem, clock, snapshot or cursor input. */
export function foldRunLifecycle(bytes: string | Uint8Array): LifecycleCursor | undefined {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let result: LifecycleCursor | undefined;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.lifecycleVersion !== 1
        || !['run_status_changed', 'run_status_imported'].includes(row.type)
        || typeof row.runStatus !== 'string' || !Object.hasOwn(RUN_STATUS_SEMANTICS, row.runStatus)
        || typeof row.timestamp !== 'string') continue;
    result = { version: 2, sequence: (result?.sequence ?? 0) + 1,
      status: row.runStatus as RunStatus, observedAt: row.timestamp };
  }
  return result;
}
