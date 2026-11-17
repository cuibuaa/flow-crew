import { isDeepStrictEqual } from 'node:util';
import { appendEvents, readEvents, intervalOpen, reservationOpen, nextLifecycle } from '../records/state.js';
import { readCommand, reserveCommand } from '../records/state.js';
import type { Id, Result } from '../contract/brief.js';
import { type InvocationSite, type AttemptReceipt, type CommandKey, type CommandReceipt, type Conclusion, type Invocation, type Reservation, type RunProjection, type Writer, type Backstop, type JournalPayload, type StageState, initialBackstop } from '../contract/runtime.js';

/** Invocation ownership read from committed state; no numeric prepayment or allowance. */
export type InvocationAccount = Pick<RunProjection, 'run' | 'cursor' | 'status' | 'reservations' | 'intervals'>;

/** One identified invocation request; elapsed time is observation only. Value only; uncertain prior intervals block reservation. */
export type InvocationRequest = {
  readonly activeInterval: Id;
} & (
  | { readonly charge: Exclude<Invocation['charge'], 'command'>; readonly address: Extract<InvocationSite, { kind: 'stage' }>; readonly command?: never }
  | { readonly charge: 'command'; readonly address: InvocationSite; readonly command: { readonly id: Id; readonly key: CommandKey } }
);

/** Invocation reservation outcome, including committed reuse of an already committed command; never treats reservation uncertainty as absence. Value only. */
export type InvocationDecision =
  | { readonly kind: 'reserved'; readonly invocation: Invocation; readonly reservation: Reservation | null }
  | { readonly kind: 'reused'; readonly receipt: CommandReceipt }
  | { readonly kind: 'stop'; readonly conclusion: Conclusion };

/** Current typed ending and optional core plan-admission refusal for a possible new invocation; unknown append outcomes must be reconciled before retry. Never consumes reason/diagnostic prose. Value only. */
export interface RetryRequest {
  readonly projection: RunProjection;
  readonly receipt: AttemptReceipt;
  readonly admissionRefusal?: Extract<Result<never>, { readonly ok: false }>;
}

/** Retry/park/stop from typed outcomes; never alters model/effort. Unknowns stay parked/stopped, quota may carry native resetAt. Value only. */
export type RetryDecision =
  | { readonly kind: 'settled' }
  | { readonly kind: 'retry'; readonly charge: Invocation['charge'] }
  | { readonly kind: 'park'; readonly conclusion: Conclusion; readonly resumeAt: string | null }
  | { readonly kind: 'stop'; readonly conclusion: Conclusion };

/** Atomically identify one model invocation or command reservation; committed reuse never reexecutes. Retired numeric provenance is not enforced. Returns typed stop, or invalid/conflict/unavailable/unknown. */
export async function reserveInvocation(request: InvocationRequest, projection: InvocationAccount, writer: Writer): Promise<Result<InvocationDecision>> {
  if (request.address.run !== projection.run) return { ok: false, kind: 'invalid', detail: 'Invocation address mismatch' };
  if (projection.status === 'cancelled') return { ok: true, value: { kind: 'stop', conclusion: conclusion('cancelled', 'cancelled') } };
  if (nextLifecycle(projection.status, 'run') === null) return { ok: false, kind: 'conflict', detail: 'Inactive invocation' };
  const interval = projection.intervals.find(item => item.id === request.activeInterval);
  if (!interval || !intervalOpen(interval) || !isDeepStrictEqual(interval.owner, writer.owner))
    return { ok: false, kind: 'conflict', detail: 'No current owned execution interval' };
  const cursor = projection.cursor;
  if (request.charge === 'command') {
    const existing = await readCommand(writer.journal, request.command.key);
    if (!existing.ok) return existing;
    if (existing.value) return existing.value.state === 'committed'
      ? { ok: true, value: { kind: 'reused', receipt: existing.value.receipt } }
      : { ok: false, kind: 'unknown', detail: 'Command reservation unresolved' };
  }
  if (projection.reservations.some(reservationOpen))
    return { ok: false, kind: 'unknown', detail: 'Unsettled command reservation' };
  const invocation: Invocation = request.charge === 'command'
    ? { charge: 'command', address: request.address }
    : { charge: request.charge, address: request.address };
  if (request.charge === 'command') {
    const reserved = await reserveCommand(writer, cursor, request.command.id, request.command.key, invocation);
    if (!reserved.ok) return reserved;
    return reserved.value.state === 'committed'
      ? { ok: true, value: { kind: 'reused', receipt: reserved.value.receipt } }
      : reserved.value.state === 'uncertain' ? { ok: false, kind: 'unknown', detail: 'Uncertain command reservation' }
        : { ok: true, value: { kind: 'reserved', invocation: reserved.value.invocation, reservation: reserved.value } };
  }
  const committed = await appendEvents(writer, cursor, [{ type: 'invocation_reserved', invocation }]);
  return committed.ok ? { ok: true, value: { kind: 'reserved', invocation, reservation: null } } : committed;
}

/** Decide retry solely from typed Ending/admissionRefusal without an operational budget; delivered without admission refusal returns settled (no new call), semantic gate rejection is routed by decisions. Structural core admission refusal may request a paid correction, never a hidden planner call. Permanent auth/refused stops; isolation retries technically only with its exact safe checkpoint; no hidden corrective grace. Returns RetryDecision with explicit parked unknowns. */
export function decideRetry(request: RetryRequest): RetryDecision {
  const { projection, receipt, admissionRefusal } = request;
  if (projection.status === 'cancelled' || receipt.ending === 'cancelled' || projection.intents.some(intent => intent.kind === 'cancel'))
    return { kind: 'stop', conclusion: conclusion('cancelled', 'cancelled') };
  if (receipt.closure !== 'dead') return { kind: 'park', conclusion: conclusion('parked', 'recovery_unknown'), resumeAt: null };
  if (admissionRefusal && admissionRefusal.kind !== 'invalid')
    return { kind: 'park', conclusion: conclusion('parked', 'recovery_unknown'), resumeAt: null };
  const policy: Record<AttemptReceipt['ending'], 'settled' | 'correction' | 'work' | 'technical' | 'quota' | 'duration' | 'input' | 'auth' | 'refused' | 'isolation' | 'unknown' | 'cancelled'> = {
    delivered: 'settled', invalid_answer: 'correction', invalid_plan: 'correction', work_failed: 'work',
    technical_failure: 'technical', auth: 'auth', refused: 'refused', input_too_large: 'input', quota: 'quota',
    duration: 'duration', cancelled: 'cancelled', isolation_failure: 'isolation', closure_unknown: 'unknown', provider_unknown: 'unknown',
  };
  const action = admissionRefusal ? 'correction' : policy[receipt.ending];
  if (action === 'settled') return { kind: 'settled' };
  if (action === 'auth' || action === 'refused') return { kind: 'stop', conclusion: conclusion('failed', 'attempt_failed') };
  if (action === 'isolation' && !projection.checkpoints.some(checkpoint => checkpoint.state === 'safe'
    && isDeepStrictEqual(checkpoint.address, receipt.address)))
    return { kind: 'stop', conclusion: conclusion('failed', 'isolation_refused') };
  if (action === 'input' || action === 'duration') return { kind: 'park',
    conclusion: { ...conclusion('parked', 'attempt_failed'), detail: action === 'input' ? 'Provider context limit; complete input retained' : 'Provider session duration; closure retained' }, resumeAt: null };
  if (action === 'unknown') return { kind: 'park', conclusion: conclusion('parked', 'recovery_unknown'), resumeAt: null };
  if (projection.intervals.filter(intervalOpen).length > 1 || projection.reservations.some(reservationOpen))
    return { kind: 'park', conclusion: conclusion('parked', 'recovery_unknown'), resumeAt: null };
  if (action === 'quota') return { kind: 'park', conclusion: conclusion('parked', 'attempt_failed'), resumeAt: receipt.resetAt ?? null };
  if (action === 'cancelled') return { kind: 'stop', conclusion: conclusion('cancelled', 'cancelled') };
  return { kind: 'retry', charge: action === 'isolation' ? 'technical' : action };
}

function conclusion(status: Conclusion['status'], reason: Conclusion['reason']): Conclusion {
  return { status, reason, detail: reason };
}

/** The sole C2 reducer; admission supplies effective outcomes and engine obligation identity. */
export function reduceOutcome(previous: Backstop, event: { settlement: string; obligation: string;
  failed: boolean; firstCompletion: boolean; gate?: { accepted: boolean; passCount: number } }): Backstop {
  let { gateSuffix, failureSuffix, bestPassCount } = previous;
  if (event.failed) failureSuffix++;
  if (event.firstCompletion) failureSuffix = 0;
  if (event.gate?.accepted) { gateSuffix = 0; failureSuffix = 0; bestPassCount = null; }
  else if (event.gate) {
    const count = event.gate.passCount;
    gateSuffix = bestPassCount === null || count > bestPassCount ? 1 : gateSuffix + 1;
    bestPassCount = bestPassCount === null ? count : Math.max(bestPassCount, count);
  }
  return { ...previous, gateSuffix, failureSuffix, bestPassCount, settlement: event.settlement, obligation: event.obligation };
}

/** Contextual settlement, completion and park are committed in the caller's same state transaction. */
export function outcomeFacts(projection: RunProjection, receipt: AttemptReceipt, stage: StageState, usable: boolean, rejected = false): JournalPayload[] {
  const gate = usable || rejected ? effectiveGate(receipt) : undefined;
  const completed = usable && !stage.completed && (!gate || gate.outcome === 'accepted' || gate.outcome === 'accepted_blocked');
  const backstop = reduceOutcome(projection.backstop, describeOutcome(receipt, stage.obligation, completed, gate));
  const park = backstop.gateSuffix >= 3 || backstop.failureSuffix >= 4;
  const fatal = gate?.outcome === 'rejected_irreparable';
  return [{ type: 'outcome_settled', address: receipt.address, obligation: stage.obligation, completed, backstop },
    ...(fatal ? [{type:'lifecycle' as const,conclusion:{status:'failed' as const,reason:'gate_irreparable' as const,detail:'Independent gate refused delivery',...(receipt.answerRef?{authoredGate:receipt.answerRef}:{})}}] : park ? [{ type: 'lifecycle' as const, conclusion: { status: 'parked' as const, reason: 'backstop' as const,
      detail: backstop.gateSuffix >= 3 ? 'C2 gate suffix reached 3' : 'C2 failure suffix reached 4' } }] : [])];
}

const failedEndings: readonly AttemptReceipt['ending'][] = ['technical_failure', 'invalid_answer', 'invalid_plan', 'work_failed', 'isolation_failure'];

// A partial answer in an unknown/quota/context ending remains evidence, not an effective verdict.
function effectiveGate(receipt: AttemptReceipt) {
  const gate = receipt.answer?.kind === 'gate' ? receipt.answer.answer : undefined;
  return gate && (receipt.ending === 'delivered' || failedEndings.includes(receipt.ending)
    && (gate.outcome === 'rejected_repairable' || gate.outcome === 'rejected_irreparable')) ? gate : undefined;
}

function describeOutcome(receipt: AttemptReceipt, obligation: string, firstCompletion: boolean, gate?: import('../contract/answers.js').GateAnswer): Parameters<typeof reduceOutcome>[1] {
  const failed = failedEndings.includes(receipt.ending);
  return { settlement: JSON.stringify(receipt.address), obligation, failed, firstCompletion,
    ...(gate && (firstCompletion || gate.outcome==='rejected_repairable' || gate.outcome==='rejected_irreparable') ? {gate:{accepted:gate.outcome==='accepted'||gate.outcome==='accepted_blocked',
      passCount:Object.values(gate.criteria).filter(item=>item.status==='pass').length}} : {}) };
}

/** Migration/recovery only: reconstruct the high-water from admitted settlement facts, never an old adjacent score. */
export async function reconstructBackstop(writer: Writer): Promise<Result<number>> {
  const events=await readEvents(writer.journal,0);if(!events.ok)return events;
  let backstop=initialBackstop(),found=false,parked=false;
  const receipts=new Map<string,AttemptReceipt>();
  const criteria=events.value.flatMap(event=>event.payload.type==='admitted'?[event.payload.launch.brief.declaration.criteria.map(item=>item.id).sort()]:[]).at(-1);
  for(const {payload:fact} of events.value){
    if(fact.type==='attempt_settled')receipts.set(JSON.stringify(fact.receipt.address),fact.receipt);
    if(fact.type==='outcome_settled'){
      const receipt=receipts.get(JSON.stringify(fact.address));
      if(!receipt || receipt.closure!=='dead' || typeof fact.obligation!=='string' || typeof fact.completed!=='boolean')return {ok:false,kind:'unknown',detail:'Admitted outcome identity cannot be reconstructed'};
      const gate=effectiveGate(receipt);
      if(gate && (!criteria || !isDeepStrictEqual(Object.keys(gate.criteria).sort(),criteria)
        || Object.values(gate.criteria).some(item=>!item||!['pass','fail','not_assessed'].includes(item.status))))return {ok:false,kind:'unknown',detail:'Admitted criterion map cannot be reconstructed'};
      backstop=reduceOutcome(backstop,describeOutcome(receipt,fact.obligation,fact.completed,gate));found=true;
    }
    if(fact.type==='control_intent' && fact.intent.kind==='resume' && parked){backstop={...initialBackstop(),segment:backstop.segment+1};parked=false;}
    if(fact.type==='lifecycle')parked=fact.conclusion.status==='parked'&&fact.conclusion.reason==='backstop';
  }
  if(!found)return {ok:false,kind:'unknown',detail:'No admitted C2 history to reconstruct; raw stage names cannot allocate progress'};
  const cursor=events.value.at(-1)?.seq??0;
  return appendEvents(writer,cursor,[{type:'backstop_reconstructed',basis:cursor,backstop}]);
}
