import { isDeepStrictEqual } from 'node:util';
import { basename, dirname } from 'node:path';
import type { Result } from '../contract/brief.js';
import type { JournalPayload, RunObservation, RunObligation, Writer } from '../contract/runtime.js';
import { endOperation, isUnconfirmedClosure, observeRun, probeOwner, stopRun,
  type Claim, type ProcessPorts, type RunContext } from '../host/process.js';
import { appendEvents, readAccountingPending, intervalOpen, ownerRecordedClosed, isFinal, readProjection, reclaimRecordOperations, reconcileClaims, releaseRunResources } from '../records/state.js';
import { publishRunStatus } from './status.js';

/** Failed closure and explicitly requested claim retirement are obligations; ordinary refusals are caller answers. */
export async function attendRun(writer: Writer, result: unknown, claim = false): Promise<Result<null>> {
  const payloads: JournalPayload[] = [];
  if (isUnconfirmedClosure(result)) {
    payloads.push({ type: 'obligation', open: true, obligation: {
      kind: 'closure-unconfirmed', detail: result.detail, owner: result.closure.owner, members: result.closure.members
    } });
    if (claim) payloads.push({ type: 'obligation', open: true, obligation: {
      kind: 'claim-unreleased', detail: result.detail, owner: result.closure.owner, members: result.closure.members
    } });
  } else if ((result as RunObligation | undefined)?.kind === 'claim-unreleased') {
    payloads.push({ type: 'obligation', open: true, obligation: result as RunObligation });
  }
  if (!payloads.length) return { ok: true, value: null };
  const recorded = await appendEvents(writer, null, payloads); if (!recorded.ok) return recorded;
  publishRunStatus({ database: writer.journal.database, storeRoot: dirname(dirname(writer.journal.root)),
    run: basename(writer.journal.root) }, new Date().toISOString(), null);
  return { ok: true, value: null };
}

/** One owner for interrupted closure, accounting and claim settlement. Host owns the bounded authenticated drain.
 * An execution writer holds the exclusive execution claim for the new activation; only predecessor groups are drained. */
export async function reconcileRun(writer: Writer, ports: ProcessPorts, context: RunContext, retained: readonly Claim[],
  stop: boolean): Promise<Result<RunObservation>> {
  const current = await readProjection(writer.journal); if (!current.ok) return current;
  const unit = current.value.launch.unit;
  let observed = await observeRun(unit, context); if (!observed.ok) return observed;
  if (!isDeepStrictEqual(observed.value.unit, unit)) return bad('conflict', 'Unit pin mismatch');
  if (!stop && observed.value.state === 'active' && writer.kind !== 'execution') return bad('conflict', 'Run unit is active');
  if (!stop && observed.value.state === 'unknown') return bad('unknown', 'Run unit state unknown');
  if (stop || observed.value.state === 'inactive' && observed.value.owner !== null || isFinal(current.value.status) || current.value.obligations.some(o => o.kind === 'closure-unconfirmed')) {
    observed = await stopRun(unit, ports, context);
    if (!observed.ok) { const attended = await attendRun(writer, observed); return attended.ok ? observed : attended; }
  }
  if (stop && observed.value.state === 'active') return observed;
  if (observed.value.state !== 'inactive' && !(observed.value.state === 'active' && writer.kind === 'execution')) return bad('unknown', 'Run closure is not confirmed');
  const proof = await appendEvents(writer, null, [{ type: 'run_observed', observation: observed.value }]); if (!proof.ok) return proof;
  let cursor = proof.value;
  const fresh = await readProjection(writer.journal); if (!fresh.ok) return fresh;
  const owners = new Map(fresh.value.intervals.filter(intervalOpen).map(i => [i.owner.authority, i.owner]));
  for (const obligation of fresh.value.obligations) if (obligation.owner)
    owners.set(obligation.owner.authority, obligation.owner);
  for (const entry of fresh.value.owners) owners.set(entry.owner.authority, entry.owner);
  for (const owner of owners.values()) {
    if (writer.kind === 'execution' && isDeepStrictEqual(owner, writer.owner)) continue;
    if (ownerRecordedClosed(fresh.value, owner)) continue;
    const state = await probeOwner(owner);
    if (!stop && state === 'live') return bad('conflict', 'Run owner is live');
    const closed = await endOperation(owner);
    if (!closed.ok) { const attended = await attendRun(writer, closed); return attended.ok ? closed : attended; }
    const recorded = await appendEvents(writer, cursor, [{ type: 'owner_closed', owner }]); if (!recorded.ok) return recorded;
    cursor = recorded.value;
  }
  const records = await reclaimRecordOperations(writer.journal);
  if (!records.ok) { const attended = await attendRun(writer, records, true); return attended.ok ? records : attended; }
  const claims = await reconcileClaims(writer.journal, retained);
  if (!claims.ok) { const attended = await attendRun(writer, claims, true); return attended.ok ? claims : attended; }
  const payloads: JournalPayload[] = fresh.value.obligations.filter(o => o.kind !== 'accounting-unsettled')
    .map(obligation => ({ type: 'obligation', obligation, open: false }));
  const pending = readAccountingPending(writer.journal); if (!pending.ok) return pending;
  if (pending.value) payloads.push({ type: 'accounting_interrupted' });
  if (payloads.length) {
    const settled = await appendEvents(writer, cursor, payloads); if (!settled.ok) return settled;
    cursor = settled.value;
  }
  // An execution writer reconciles predecessors while retaining its own live activation.
  if (writer.kind === 'execution') return observed;
  const retired = await releaseRunResources(writer.journal, { cursor, retained });
  if (!retired.ok) {
    const failure: RunObligation = { kind: 'claim-unreleased', detail: retired.detail, members: [] };
    const attended = await attendRun(writer, failure); if (!attended.ok) return attended;
  }
  return observed;
}
function bad(kind: 'conflict' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }
