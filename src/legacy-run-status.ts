import { resolveRunStatus } from './lifecycle-status.js';

/** Historical display only. No transition, import, recovery or persistence. */
export function readLegacyRunStatus(record: { status?: unknown }): unknown {
  const resolution = resolveRunStatus(record.status);
  return resolution.kind === 'known' ? resolution.status : record.status;
}
