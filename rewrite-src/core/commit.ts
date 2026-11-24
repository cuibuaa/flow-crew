import type { Result } from '../contract/brief.js';
import type { RunProjection, Writer } from '../contract/runtime.js';
import { appendEvents, readProjection, type JournalPayload } from '../records/state.js';

/** Re-decide only after a cursor race with journal progress. Epoch/claim/semantic refusals return immediately. */
export async function commitDecision<T>(writer: Writer, decide: (projection: RunProjection) =>
  Result<{ value: T; records: readonly JournalPayload[] }> | Promise<Result<{ value: T; records: readonly JournalPayload[] }>>
): Promise<Result<{ value: T; projection: RunProjection }>> {
  let attempted = -1;
  for (;;) {
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return fresh;
    if (fresh.value.cursor <= attempted) return { ok: false, kind: 'conflict', detail: 'Decision conflict without journal progress' };
    const decision = await decide(fresh.value);
    if (!decision.ok) return decision;
    if (!decision.value.records.length) return { ok: true, value: { value: decision.value.value, projection: fresh.value } };
    const appended = await appendEvents(writer, fresh.value.cursor, decision.value.records);
    if (!appended.ok) {
      if (!appended.staleCursor) return appended;
      attempted = fresh.value.cursor;
      continue;
    }
    const saved = await readProjection(writer.journal);
    return saved.ok ? { ok: true, value: { value: decision.value.value, projection: saved.value } } : saved;
  }
}
