import { reviewCommandEvidence, decideNext } from './decisions.js';
import { pendingGuidance, putEvidence, nextLifecycle } from '../records/state.js';
import { isDeepStrictEqual } from 'node:util';
import { answerSchema } from '../contract/answers.js';
import { readEvidence, decodeRefusal } from '../records/evidence.js';
import { validateRecordRef } from '../records/evidence.js';
import { admitPlan } from './admission.js';
import { outcomeFacts } from './retry.js';
import { randomUUID } from 'node:crypto';
import { commitDecision } from './commit.js';
import type { Result } from '../contract/brief.js';
import type { Stage } from '../contract/plan.js';
import { commandRefs, gateReview, type AttemptReceipt, type Checkpoint, type JournalPayload, type RunProjection, type Writer } from '../contract/runtime.js';
import { settleFrozenInputs, captureCheckpoint, captureTree, restoreTree, changedTreePaths, type ContentScope, type FrozenSettlement } from '../records/content.js';

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
  const received = await commitDecision(writer,current=> {
    if (projection.plan.revision !== current.plan.revision || receipt.address.run !== current.run
      || scope.journal.root !== writer.journal.root || !isDeepStrictEqual(scope.brief, current.brief)) return conflict('Stale attempt context');
    const invocation = current.invocations.filter(item => item.charge !== 'command').at(-1);
    if (!invocation || invocation.address.kind !== 'stage' || !isDeepStrictEqual({ ...receipt.address, kind: 'stage' }, invocation.address)
      || current.attempts.some(item => isDeepStrictEqual(item.address, receipt.address))) return conflict('Stale or unpaid attempt address');
    if (receipt.guidance?.length) {
      const stage = current.plan.plan.stages.find(item => item.id === receipt.address.stage);
      const guides = pendingGuidance({...current,guideDeliveries:current.guideDeliveries?.filter(delivery=>!isDeepStrictEqual(delivery.invocation,receipt.address))});
      if (stage?.purpose === 'gate' || new Set(receipt.guidance).size !== receipt.guidance.length
        || receipt.guidance.some(id=>!guides.some(guide=>guide.id === id)))
        return conflict('Uncommitted or consumed guidance');
    }
    const prior=current.received.find(item=>isDeepStrictEqual(item.address,receipt.address));
    if (prior && !isDeepStrictEqual(prior,receipt)) return conflict('Raw receipt identity differs');
    return {ok:true,value:{value:null,records:prior ? [] : [{type:'attempt_received',receipt}]}};
  });
  if (!received.ok) return received;
  const current = received.value.projection;
  const original = receipt;
  const record = async (decide: (p:RunProjection)=>readonly JournalPayload[] = ()=>[]): Promise<Result<RunProjection>> => {
    // Retain the exact exec DTO as immutable evidence whenever settlement changes its typed ending.
    if (receipt !== original) {
      const raw = await putEvidence(writer.journal, new TextEncoder().encode(JSON.stringify(original)));
      if (!raw.ok) return raw;
      receipt = { ...receipt, evidence: [...receipt.evidence, raw.value] };
    }
    const recorded=await commitDecision(writer,async p=> {
      if (p.attempts.some(item=>isDeepStrictEqual(item.address,receipt.address))) return conflict('Attempt already settled');
      const facts=decide(p), diagnostics:string[]=[];
      if (facts.some(fact=>fact.type === 'lifecycle')) for (const ref of receipt.evidence) {
        const bytes=await readEvidence(writer.journal,ref);
        if (!bytes.ok) return bytes;
        const refusal=decodeRefusal(bytes.value);
        if (refusal) diagnostics.push(`${refusal.kind}: ${refusal.detail}; diagnostic ${ref.path}`);
      }
      const payloads=facts.map(fact=>fact.type === 'lifecycle' && diagnostics.length ? {
        ...fact,conclusion:{...fact.conclusion,detail:[fact.conclusion.detail,...diagnostics].join('; ')}
      } : fact);
      return {ok:true,value:{value:null,records:[{type:'attempt_settled',receipt},...payloads]}};
    });
    return recorded.ok ? {ok:true,value:recorded.value.projection} : recorded;
  };
  const refuse = async (refusal: Extract<Result<never>, { ok: false }>): Promise<Result<true>> => {
    const saved = await putEvidence(writer.journal, Buffer.from(JSON.stringify({ refusal })));
    if (!saved.ok) return saved;
    receipt = { ...receipt, evidence: [...receipt.evidence, saved.value] };
    return { ok: true, value: true };
  };
  const raw = async (failure: Extract<Result<never>, { ok: false }>): Promise<Result<SettledFacts>> => {
    const saved = await refuse(failure);
    if (!saved.ok) return saved;
    const recorded = await record();
    return recorded.ok ? failure : recorded;
  };
  if (receipt.closure !== 'dead') return raw({ ok: false, kind: 'unknown', detail: 'Descendant closure not proven' });
  // Cancellation fences release, never raw evidence. No routing or schema acceptance is needed for this late receipt.
  if (current.status === 'cancelled' || current.intents.some(intent => intent.kind === 'cancel')) {
    const recorded = await record();
    return recorded.ok ? { ok: false, kind: 'unknown', detail: 'Late receipt retained after cancellation' } : recorded;
  }
  const next = decideNext(current);
  if (!next.ok) return raw(next);
  if (next.value.kind !== 'stage' || next.value.stage.id !== receipt.address.stage) return conflict('Attempt is not current serial frontier');
  const stage = next.value.stage;
  let validAnswer = true;
  // validateRecordRef already streams and authenticates both digests; these bytes are not consumed here.
  for (const ref of [receipt.audit, ...receipt.evidence, ...receipt.usage.raw, ...(receipt.answerRef ? [receipt.answerRef] : [])]) {
    const checked = await validateRecordRef(writer.journal, ref);
    if (!checked.ok) {
      if (checked.kind !== 'invalid') return raw(checked);
      const saved = await refuse(checked); if (!saved.ok) return raw(saved);
      validAnswer = false; break;
    }
  }
  if (receipt.ending === 'delivered' || receipt.answer !== undefined) {
    if (!receipt.answer || !receipt.answerRef) { validAnswer = false; const saved = await refuse({ ok: false, kind: 'invalid', detail: 'Delivered answer requires a parsed answer and authenticated answerRef' }); if (!saved.ok) return raw(saved); }
    else {
      const bytes = await readEvidence(writer.journal, receipt.answerRef);
      if (!bytes.ok && bytes.kind !== 'invalid') return raw(bytes);
      if (!bytes.ok) { validAnswer = false; const saved = await refuse(bytes); if (!saved.ok) return raw(saved); }
      else {
        let decoded: unknown;
        try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)); }
        catch (error) { validAnswer = false; const saved = await refuse({ ok: false, kind: 'invalid', detail: `Answer must be valid JSON: ${String(error)}` }); if (!saved.ok) return raw(saved); }
        const parsed = answerSchema(next.value.context).parse(decoded);
        if (!parsed.ok || !isDeepStrictEqual(parsed.value, receipt.answer)) {
          validAnswer = false;
          const saved = await refuse(!parsed.ok ? parsed : { ok: false, kind: 'invalid', detail: 'Parsed answer differs from authenticated answerRef' });
          if (!saved.ok) return raw(saved);
        }
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
  const observed = frozen.value.state === 'unchanged' ? { ok: true as const, value: receipt.after } : await captureTree(scope);
  if (!observed.ok) return raw(observed);
  // A plan or gate stage reviews the work and never delivers it: whatever its tools left behind is not delivered, so the tree it
  // reviewed (`before`) is the one this settlement binds. The bytes it left stay recorded in `receipt.after`.
  const tree = stage.purpose === 'work' || observed.value === receipt.before ? observed : await restoreTree(scope, receipt.before);
  if (!tree.ok) return raw(tree);
  const safe = frozen.value.state !== 'quarantined' && (original.ending !== 'isolation_failure' || restored);
  // Decide once: isolation/frozen violation, exec failure, then delivered-answer validation.
  let ending: AttemptReceipt['ending'] = !safe ? 'isolation_failure'
    : original.ending !== 'delivered' ? original.ending
      : restored ? 'isolation_failure'
      : !validAnswer ? stage.purpose === 'plan' ? 'invalid_plan' : 'invalid_answer' : 'delivered';
  if (!safe || restored) {
    const paths = receipt.before !== receipt.after ? await changedTreePaths(writer.journal, receipt.before, receipt.after) : { ok: true as const, value: [] };
    if (!paths.ok) return raw(paths);
    const saved = await refuse({ ok: false, kind: 'invalid', detail: `Stage ${stage.id}: frozen inputs must retain their admitted identities. Changed paths: ${paths.value.join(', ')}; frozen state: ${frozen.value.state}; declared frozen inputs: ${current.brief.declaration.inputs.filter(input => input.frozen).map(input => `${input.id} (${input.path})`).join(', ')}` });
    if (!saved.ok) return raw(saved);
  }
  const delivered = { ...current, attempts: [...current.attempts, receipt],
    stageStates: current.stageStates.map(state => state.stage === stage.id ? { ...state, state: 'settled' as const } : state) };
  let admitted: Awaited<ReturnType<typeof admitPlan>> | undefined;
  if (ending === 'delivered' && receipt.answer?.kind === 'plan') {
    admitted = receipt.answer.answer.baseRevision === current.plan.revision
      ? await admitPlan(writer.journal, receipt.answer.answer.plan, 'revision_' + randomUUID(), delivered, stage.id)
      : { ok: false, kind: 'invalid', detail: `Stale plan base: expected ${current.plan.revision}, received ${receipt.answer.answer.baseRevision}` };
    if (!admitted.ok) ending = 'invalid_plan';
  }
  const unknownMap = original.ending === 'delivered' && original.answer?.kind === 'gate'
    && !isDeepStrictEqual(Object.keys(original.answer.answer.criteria ?? {}).sort(), [...next.value.context.criterionIds].sort());
  if (ending !== original.ending || !validAnswer) receipt = { ...receipt, ending,
    ...(!validAnswer ? { answer: undefined } : {}) };
  if (admitted && !admitted.ok) {
    const saved = await refuse(admitted);
    if (!saved.ok) return raw(saved);
  }
  const checkpoint = await captureCheckpoint(scope, receipt.address, current.checkpoints.at(-1)?.id ?? null,
    safe ? 'safe' : 'quarantined', [...receipt.evidence, receipt.audit, ...frozen.value.evidence, ...(receipt.answerRef ? [receipt.answerRef] : [])],
    frozen.value.inputs);
  if (!checkpoint.ok) return raw(checkpoint);
  if (!isDeepStrictEqual(checkpoint.value.address, receipt.address) || checkpoint.value.brief !== current.brief.digest
    || checkpoint.value.tree !== tree.value || checkpoint.value.state !== (safe ? 'safe' : 'quarantined'))
    return raw({ ok: false, kind: 'unknown', detail: 'Checkpoint identity mismatch' });
  // Publication alone owns the required-command delivery floor. Retrying a truthful
  // gate envelope cannot turn an unfinished host measurement into a completed one.
  if (receipt.ending === 'delivered' && receipt.answer?.kind === 'gate'
    && ['accepted','accepted_blocked'].includes(receipt.answer.answer.outcome)) {
    const reviewed = await suppliedCommandReview(current,receipt,stage,writer,{tree:receipt.before,inputHashes:checkpoint.value.inputHashes});
    if (!reviewed.ok && reviewed.kind !== 'invalid') return raw(reviewed);
    if (!reviewed.ok) { const saved = await refuse(reviewed); if (!saved.ok) return raw(saved); receipt = {...receipt,ending:'invalid_answer'}; }
  }
  const settled = await record(fresh=> {
    const fenced = nextLifecycle(fresh.status, 'run') === null || fresh.intents.some(intent => intent.kind === 'cancel');
    return [
    { type: 'checkpoint' as const, checkpoint: checkpoint.value },
    ...(!fenced && admitted?.ok && receipt.ending === 'delivered' ? [{ type: 'plan_committed' as const, plan: admitted.value }] : []),
    ...(!fenced && safe ? [{ type: 'stage_settled' as const, stage: stage.id,
      state: receipt.ending === 'delivered' ? 'settled' as const : 'pending' as const,
      evidence: [...(receipt.answerRef ? [receipt.answerRef] : []), ...receipt.evidence] },
      ...(!unknownMap ? outcomeFacts(fresh, receipt, fresh.stageStates.find(item => item.stage === stage.id)!, receipt.ending === 'delivered', validAnswer && safe && receipt.answer?.kind === 'gate'
        && (receipt.answer.answer.outcome === 'rejected_repairable' || receipt.answer.answer.outcome === 'rejected_irreparable')) : [{type:'lifecycle' as const,conclusion:{status:'parked' as const,reason:'recovery_unknown' as const,detail:'Independent criterion map is unresolved'}}])] : []),
    ];
  });
  return settled.ok ? { ok: true, value: { projection: settled.value, stage, receipt, frozen: frozen.value, checkpoint: checkpoint.value } } : settled;
}
function conflict(detail: string): Extract<Result<never>, { ok: false }> { return { ok: false, kind: 'conflict', detail }; }

/** The audit binds answer, invocation and exact input bytes; the gate's `review` record binds the command evidence it was supplied. No gate history echo. */
async function suppliedCommandReview(projection: RunProjection, receipt: AttemptReceipt, stage: Stage, writer: Writer, target: Pick<Checkpoint, 'tree' | 'inputHashes'>): Promise<Result<true>> {
  const audit = await readEvidence(writer.journal,receipt.audit);
  if (!audit.ok) return audit;
  try {
    const carrier = JSON.parse(new TextDecoder().decode(audit.value));
    if (!isDeepStrictEqual(carrier.address,receipt.address)) return {ok:false,kind:'invalid',detail:`Gate ${stage.id} review must bind its exact invocation address, supplied command receipts and authenticated history`};
    const review = await readEvidence(writer.journal,carrier.review);
    if (!review.ok) return review;
    const supplied = JSON.parse(new TextDecoder().decode(review.value));
    const next = decideNext(projection);
    const {commands,reusedCommands} = await reviewCommandEvidence(writer.journal, projection, stage,
      next.ok && next.value.kind === 'stage' && next.value.context.final,
      target);
    const matches = isDeepStrictEqual(supplied,gateReview(projection,commands,reusedCommands)) && isDeepStrictEqual(receipt.reusedCommands ?? [],reusedCommands);
    return matches ? {ok:true,value:true} : {ok:false,kind:'invalid',detail:`Gate ${stage.id} review must bind its exact invocation address, supplied command receipts and authenticated history`};
  } catch { return {ok:false,kind:'invalid',detail:`Gate ${stage.id} review must bind its exact invocation address, supplied command receipts and authenticated history`}; }
}
