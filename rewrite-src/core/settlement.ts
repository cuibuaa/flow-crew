import { putEvidence } from '../records/state.js';
import { isDeepStrictEqual } from 'node:util';
import { answerSchema } from '../contract/answers.js';
import { appendEvents, readEvents, nextLifecycle } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { readEvidence } from '../records/evidence.js';
import { validateRecordRef } from '../records/evidence.js';
import { admitPlan, admitRelations } from './admission.js';
import { outcomeFacts } from './retry.js';
import { randomUUID } from 'node:crypto';
import { decideNext, commandEvidenceFailure } from './decisions.js';
import type { Result } from '../contract/brief.js';
import type { Stage } from '../contract/plan.js';
import { commandRefs, type AttemptReceipt, type Checkpoint, type JournalPayload, type RunProjection, type Writer } from '../contract/runtime.js';
import { settleFrozenInputs, captureCheckpoint, captureTree, type ContentScope, type FrozenSettlement } from '../records/content.js';

/** Authenticated settled attempt/checkpoint and refreshed journal fold; never an alternative gate verdict. Value only; unsafe frozen/closure facts cannot yield executable content. */
export interface SettledFacts {
  readonly projection: RunProjection;
  readonly stage: Stage;
  readonly receipt: AttemptReceipt;
  readonly frozen: FrozenSettlement;
  readonly checkpoint: Checkpoint;
}

/** Authenticate exact current invocation/address/schema/answer, settleFrozenInputs, capture recoverable bytes and atomically commit attempt+checkpoint+stage facts after closure. If closure/capture is unsafe or unavailable, persist the raw receipt/usage without stage release before returning refusal; never fabricate a checkpoint. Never chooses retry/repair/publication or overrides gate findings with commands/author claims. Returns invalid/conflict/unavailable/unknown. */
export async function settle(projection: RunProjection, receipt: AttemptReceipt, writer: Writer, scope: ContentScope): Promise<Result<SettledFacts>> {
  const refreshed = await readProjection(writer.journal);
  if (!refreshed.ok) return refreshed;
  let current = refreshed.value;
  if (projection.cursor !== current.cursor || projection.plan.revision !== current.plan.revision || receipt.address.run !== current.run
    || scope.journal.root !== writer.journal.root || !isDeepStrictEqual(scope.brief, current.brief)) return conflict('Stale attempt context');
  const invocation = current.invocations.filter(item => item.charge !== 'command').at(-1);
  if (!invocation || invocation.address.kind !== 'stage' || !isDeepStrictEqual({ ...receipt.address, kind: 'stage' }, invocation.address)
    || current.attempts.some(item => isDeepStrictEqual(item.address, receipt.address))) return conflict('Stale or unpaid attempt address');
  if (receipt.guidance?.length) {
    const stage = current.plan.plan.stages.find(item => item.id === receipt.address.stage);
    const guides = current.intents.filter(item => item.kind === 'guide'
      && !current.attempts.some(attempt => attempt.guidance?.includes(item.id)));
    // Only guides committed before this invocation can have been delivered. Later guides stay pending.
    const events = await readEvents(writer.journal, 0);
    if (!events.ok) return events;
    const dispatched = events.value.find(event => event.payload.type === 'invocation_reserved'
      && isDeepStrictEqual(event.payload.invocation, invocation))!.seq;
    const eligible = guides.filter(guide => events.value.some(event => event.seq < dispatched
      && event.payload.type === 'control_intent' && event.payload.intent.id === guide.id));
    if (stage?.purpose === 'gate' || !isDeepStrictEqual(receipt.guidance, eligible.map(item => item.id)))
      return conflict('Uncommitted or consumed guidance');
  }
  const received = current.received.find(item => isDeepStrictEqual(item.address, receipt.address));
  if (received && !isDeepStrictEqual(received, receipt)) return conflict('Raw receipt identity differs');
  if (!received) {
    const saved = await appendEvents(writer, current.cursor, [{ type: 'attempt_received', receipt }]);
    if (!saved.ok) return saved;
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return fresh;
    current = fresh.value;
  }
  const original = receipt;
  const record = async (payloads: readonly JournalPayload[] = []): Promise<Result<RunProjection>> => {
    // Retain the exact exec DTO as immutable evidence whenever settlement changes its typed ending.
    if (receipt !== original) {
      const raw = await putEvidence(writer.journal, new TextEncoder().encode(JSON.stringify(original)));
      if (!raw.ok) return raw;
      receipt = { ...receipt, evidence: [...receipt.evidence, raw.value] };
    }
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return fresh;
    if (fresh.value.attempts.some(item => isDeepStrictEqual(item.address, receipt.address))) return conflict('Attempt already settled');
    const recorded = await appendEvents(writer, fresh.value.cursor, [{ type: 'attempt_settled', receipt }, ...payloads]);
    return recorded.ok ? readProjection(writer.journal) : recorded;
  };
  const raw = async (failure: Extract<Result<never>, { ok: false }>): Promise<Result<SettledFacts>> => {
    const recorded = await record();
    return recorded.ok ? failure : recorded;
  };
  if (receipt.closure !== 'dead') return raw({ ok: false, kind: 'unknown', detail: 'Descendant closure not proven' });
  // Cancellation fences release, never raw evidence. No routing or schema acceptance is needed for this late receipt.
  if (current.status === 'cancelled' || current.intents.some(intent => intent.kind === 'cancel'))
    return raw({ ok: false, kind: 'unknown', detail: 'Late receipt retained after cancellation' });
  const next = decideNext(current);
  if (!next.ok) return raw(next);
  if (next.value.kind !== 'stage' || next.value.stage.id !== receipt.address.stage) return conflict('Attempt is not current serial frontier');
  const stage = next.value.stage;
  let validAnswer = true;
  for (const ref of [receipt.audit, ...receipt.evidence, ...receipt.usage.raw, ...(receipt.answerRef ? [receipt.answerRef] : [])]) {
    const checked = await validateRecordRef(writer.journal, ref);
    if (!checked.ok) {
      if (checked.kind !== 'invalid') return raw(checked);
      validAnswer = false; break;
    }
    const bytes = await readEvidence(writer.journal, checked.value);
    if (!bytes.ok) {
      if (bytes.kind !== 'invalid') return raw(bytes);
      validAnswer = false; break;
    }
  }
  if (receipt.ending === 'delivered' || receipt.answer !== undefined) {
    if (!receipt.answer || !receipt.answerRef) validAnswer = false;
    else {
      const bytes = await readEvidence(writer.journal, receipt.answerRef);
      if (!bytes.ok && bytes.kind !== 'invalid') return raw(bytes);
      if (!bytes.ok) validAnswer = false;
      else {
        let decoded: unknown;
        try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)); }
        catch { validAnswer = false; }
        const parsed = answerSchema(next.value.context).parse(decoded);
        if (!parsed.ok || !isDeepStrictEqual(parsed.value, receipt.answer)) validAnswer = false;
      }
    }
  }
  if (receipt.answer?.kind === 'gate') for (const command of current.commands) {
    for (const ref of commandRefs(command)) {
      const checked = await validateRecordRef(writer.journal, ref);
      if (!checked.ok) return raw(checked);
    }
  }
  const frozen = await settleFrozenInputs(scope);
  if (!frozen.ok) return raw(frozen);
  // A restored tree can be a safe retry base; its invocation is still an isolation failure.
  const restored = frozen.value.state === 'restored';
  const tree = frozen.value.state === 'unchanged' ? { ok: true as const, value: receipt.after } : await captureTree(scope);
  if (!tree.ok) return raw(tree);
  const safe = frozen.value.state !== 'quarantined' && isDeepStrictEqual(frozen.value.inputs, current.launch.setup.inputs)
    && (original.ending !== 'isolation_failure' || restored)
    && (stage.purpose === 'work' || receipt.before === tree.value);
  // Decide once: isolation/frozen violation, exec failure, then delivered-answer validation.
  let ending: AttemptReceipt['ending'] = !safe ? 'isolation_failure'
    : original.ending !== 'delivered' ? original.ending
      : restored ? 'isolation_failure'
      : !validAnswer ? stage.purpose === 'plan' ? 'invalid_plan' : 'invalid_answer' : 'delivered';
  let admitted: ReturnType<typeof admitPlan> | undefined;
  if (ending === 'delivered' && receipt.answer?.kind === 'plan') {
    admitted = receipt.answer.answer.baseRevision === current.plan.revision
      ? admitPlan(receipt.answer.answer.plan, 'revision_' + randomUUID(), current, stage.id)
      : { ok: false, kind: 'invalid', detail: 'Stale plan base' };
    if (!admitted.ok) ending = 'invalid_plan';
  }
  if (ending === 'delivered' && receipt.answer?.kind === 'work' && !admitRelations(receipt.answer.answer.observations ?? [], current.brief.declaration).ok) ending = 'invalid_answer';
  const unknownMap = original.ending === 'delivered' && original.answer?.kind === 'gate'
    && !isDeepStrictEqual(Object.keys(original.answer.answer.criteria ?? {}).sort(), [...next.value.context.criterionIds].sort());
  if (ending !== original.ending || !validAnswer) receipt = { ...original, ending,
    ...(!validAnswer ? { answer: undefined, answerRef: undefined } : {}) };
  if (admitted && !admitted.ok) {
    const refusal = await putEvidence(writer.journal, Buffer.from(JSON.stringify({ admission: admitted })));
    if (!refusal.ok) return raw(refusal);
    receipt = { ...receipt, evidence: [...receipt.evidence, refusal.value] };
  }
  const checkpoint = await captureCheckpoint(scope, receipt.address, current.checkpoints.at(-1)?.id ?? null,
    safe ? 'safe' : 'quarantined', [...receipt.evidence, receipt.audit, ...frozen.value.evidence, ...(receipt.answerRef ? [receipt.answerRef] : [])]);
  if (!checkpoint.ok) return raw(checkpoint);
  if (!isDeepStrictEqual(checkpoint.value.address, receipt.address) || checkpoint.value.brief !== current.brief.digest
    || checkpoint.value.tree !== tree.value || checkpoint.value.state !== (safe ? 'safe' : 'quarantined'))
    return raw({ ok: false, kind: 'unknown', detail: 'Checkpoint identity mismatch' });
  if (receipt.ending === 'delivered' && next.value.context.final && receipt.answer?.kind === 'gate'
    && (receipt.answer.answer.outcome === 'accepted' || receipt.answer.answer.outcome === 'accepted_blocked')
    && commandEvidenceFailure({ ...current, lineage: [...current.lineage, { kind: 'checkpoint', checkpoint: checkpoint.value }] }, checkpoint.value, receipt.answer.answer)) {
    receipt = { ...receipt, ending: 'invalid_answer' };
  }
  const fresh = await readProjection(writer.journal);
  if (!fresh.ok) return raw(fresh);
  const fenced = nextLifecycle(fresh.value.status, 'run') === null || fresh.value.intents.some(intent => intent.kind === 'cancel');
  const settled = await record([
    { type: 'checkpoint', checkpoint: checkpoint.value },
    ...(!fenced && admitted?.ok && receipt.ending === 'delivered' ? [{ type: 'plan_committed' as const, plan: admitted.value }] : []),
    ...(!fenced && safe ? [{ type: 'stage_settled' as const, stage: stage.id,
      state: receipt.ending === 'delivered' ? 'settled' as const : 'pending' as const,
      evidence: receipt.answerRef ? [receipt.answerRef] : receipt.evidence },
      ...(!unknownMap ? outcomeFacts(fresh.value, receipt, fresh.value.stageStates.find(item => item.stage === stage.id)!, receipt.ending === 'delivered', validAnswer && safe && receipt.answer?.kind === 'gate'
        && (receipt.answer.answer.outcome === 'rejected_repairable' || receipt.answer.answer.outcome === 'rejected_irreparable')) : [{type:'lifecycle' as const,conclusion:{status:'parked' as const,reason:'recovery_unknown' as const,detail:'Independent criterion map is unresolved'}}])] : []),
  ]);
  return settled.ok ? { ok: true, value: { projection: settled.value, stage, receipt, frozen: frozen.value, checkpoint: checkpoint.value } } : settled;
}
function conflict(detail: string): Extract<Result<never>, { ok: false }> { return { ok: false, kind: 'conflict', detail }; }
