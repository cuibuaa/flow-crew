import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DeclaredCommand, Hash, Id } from '../contract/brief.js';
import type { AttemptAddress, Invocation } from '../contract/runtime.js';
import { readEvents, intervalOpen, reservationOpen, attemptOpen, pendingReceipts, commandInterrupted, workAdmission, nextLifecycle, pendingGuidance, readProjection, type JournalPayload } from '../records/state.js';
import type { LiveInvocation } from '../contract/live.js';
import { authorActivity, quietObservation, type ExecutionActivity } from '../host/process.js';
import { captureTree, materializeCheckpoint, preserveOutputs, readCheckpoint } from '../records/content.js';
import { readEvidence, decodeRefusal } from '../records/evidence.js';
import { identifyCommand } from '../exec/command.js';
import { decideNext, decidePublication, reviewCommandEvidence, selectedCommandIds, stageDepends, commandPause } from './decisions.js';
import { reserveInvocation, reconstructBackstop, decideRetry, type RetryDecision } from './retry.js';
import { commitDecision } from './commit.js';
import { settle, type SettledFacts } from './settlement.js';
import type { Result } from '../contract/brief.js';
import { type AttemptReceipt, type AttemptRequest, type CommandReceipt, type Conclusion, type RunProjection, type RunStatusFile, type Writer } from '../contract/runtime.js';
import type { ContentScope } from '../records/content.js';
import type { CommandRequest } from '../exec/command.js';

/** Clock observation within one birth-bound unit; never compares monotonic values across boots. Value only; wall time is evidence, never a quality rule. */
export interface ClockReading {
  readonly at: string;
  readonly monotonicMs: number;
}

/** Runtime ports injected by ops, with no upward import; never permits callbacks to select routes or mint invocations. Result failures remain closed kinds; AttemptReceipt carries execution endings. */
export interface WorkflowPorts {
  attempt(request: AttemptRequest): Promise<Result<AttemptReceipt>>;
  command(request: CommandRequest): Promise<Result<CommandReceipt>>;
  publishStatus(observation: ClockReading, activeElapsedMs: number | null): Promise<Result<RunStatusFile>>;
  recordActivity(activity: ExecutionActivity): void;
  now(): ClockReading;
}

/** One writer/project claim and concrete runtime callbacks for the common serial loop; never supplies project-specific policy. Value only. */
export interface WorkflowRequest {
  readonly writer: Writer;
  readonly scope: ContentScope;
  readonly ports: WorkflowPorts;
  readonly abort: AbortSignal;
}

/** Caller reconciles prior activations before entering this serial loop; open accounting here is live bookkeeping.
 * Drive recovery, observed active time, identified plan/work/gate calls, selected commands, atomic revision/settlement/transition and publication. Close observation intervals before park/exit; publish status after committed batches and while active. Never runs across unresolved owners/reservations; the delivery gate phase includes every required declared command. Returns honest Conclusion or invalid/conflict/unavailable/unknown; status publication failure never rewrites a gate verdict. */
export async function runWorkflow(request: WorkflowRequest): Promise<Result<Conclusion>> {
  const { writer, scope, ports, abort } = request;
  let loaded = await readProjection(writer.journal);
  if (!loaded.ok && loaded.kind === 'unknown') {
    const recovered = await reconstructBackstop(writer);
    if (!recovered.ok) return recovered;
    loaded = await readProjection(writer.journal);
  }
  if (!loaded.ok) return loaded;
  let projection = loaded.value;
  if (projection.restoring) return { ok: false, kind: 'unknown', detail: 'Checkpoint restoration is incomplete; execution is fenced' };
  const start = ports.now();
  const interval = newId();
  let opened = false;
  let returned: { address: AttemptAddress; receipt: AttemptReceipt } | undefined;
  let recovered: { stage: Id; charge: Exclude<Invocation['charge'], 'command'>; previous: AttemptAddress } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let snapshot: Promise<void> | undefined;
  let observationError: unknown;
  let active: { invocation: Invocation; live?: LiveInvocation; activity: ExecutionActivity; offered: Set<string>; delivered: string[] } | undefined;
  const observe = async () => {
    const current = active;
    if (!current) return;
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return;
    if (current.live && current.invocation.address.kind === 'stage' && !abort.aborted && fresh.value.status !== 'cancelled') {
      for (const guide of pendingGuidance(fresh.value)) {
        if (guide.kind !== 'guide' || current.offered.has(guide.id)) continue;
        current.offered.add(guide.id);
        const bytes = await readEvidence(writer.journal,guide.intervention.content);
        if (!bytes.ok) continue;
        // A provider resolves 'delivered' only once it consumed the text, which can take a whole turn: do not hold the
        // observation tick (status, activity) for it. The provider settles every steer by the end of its invocation.
        void current.live.steer(new TextDecoder().decode(bytes.value)).then(outcome => {
          if (outcome === 'delivered') current.delivered.push(guide.id);
        }, error => { observationError = error; });
      }
    }
    const activity = {...current.activity,observation:quietObservation(current.activity,Date.parse(ports.now().at))};
    ports.recordActivity(activity);
  };
  const elapsed = () => Math.max(0, Math.ceil(ports.now().monotonicMs - start.monotonicMs));
  const publish = async (p: RunProjection) => { await ports.publishStatus(ports.now(), p.intervals.some(intervalOpen) ? (opened ? elapsed() : null) : 0); };
  const refresh = async (): Promise<Result<RunProjection>> => {
    const fresh = await readProjection(writer.journal);
    if (fresh.ok) { projection = fresh.value; await publish(projection); }
    return fresh;
  };
  const commit = async (payloads: readonly JournalPayload[]): Promise<Result<RunProjection>> => {
    const saved = await commitDecision(writer, () => ({ok:true,value:{value:null,records:payloads}}));
    if (!saved.ok) return saved;
    projection=saved.value.projection;
    await publish(projection);
    return {ok:true,value:projection};
  };
  const retain = async (): Promise<Result<RunProjection>> => {
    const fresh = await refresh();
    if (!fresh.ok) { opened = false; return fresh; }
    if (!returned) return fresh;
    const saved = projection.attempts.some(receipt => isDeepStrictEqual(receipt.address, returned!.address))
      ? fresh : await commit([{ type: 'attempt_settled', receipt: returned.receipt }]);
    if (!saved.ok) { opened = false; return saved; }
    if (returned.receipt.closure !== 'dead') opened = false;
    returned = undefined;
    return saved;
  };
  function finish(conclusion:Conclusion): Promise<Result<Conclusion>>;
  function finish(decide:(p:RunProjection)=>Promise<Result<Conclusion | null>>,records:readonly JournalPayload[]): Promise<Result<Conclusion | null>>;
  async function finish(decide:Conclusion | ((p:RunProjection)=>Promise<Result<Conclusion | null>>),records:readonly JournalPayload[]=[]): Promise<Result<Conclusion | null>> {
    const closed=await commitDecision(writer,async p=> {
      const decision=typeof decide === 'function' ? await decide(p) : {ok:true as const,value:decide};
      if (!decision.ok) return decision;
      const fenced=p.status === 'cancelled' || p.intents.some(intent=>intent.kind === 'cancel');
      const final=fenced ? {status:'cancelled' as const,reason:'cancelled' as const,detail:'cancelled'}
        : p.conclusion && nextLifecycle(p.status,'run') === null ? p.conclusion : decision.value;
      return {ok:true,value:{value:final,records:final === null ? [] : [...records,
        ...(opened ? [{type:'active_time_closed' as const,interval,spentMs:elapsed()}] : []),
        ...(!p.conclusion || nextLifecycle(p.status,'run') !== null ? [{type:'lifecycle' as const,conclusion:final}] : [])]}};
    });
    if (!closed.ok) return closed;
    projection=closed.value.projection;
    if (closed.value.value !== null) opened=false;
    await publish(projection);
    return {ok:true,value:closed.value.value === null ? null : projection.conclusion ?? closed.value.value};
  }
  const attemptConclusion = async (conclusion: Conclusion, receipt: AttemptReceipt): Promise<Conclusion> => {
    const diagnostics: string[] = [];
    for (const ref of receipt.evidence) {
      const bytes = await readEvidence(writer.journal, ref);
      if (!bytes.ok) { diagnostics.push(`${bytes.kind}: ${bytes.detail}; diagnostic ${ref.path}`); continue; }
      const refusal = decodeRefusal(bytes.value);
      if (refusal) diagnostics.push(`${refusal.kind}: ${refusal.detail}; diagnostic ${ref.path}`);
    }
    return { ...conclusion, detail: [conclusion.detail, ...diagnostics].join('; ') };
  };
  const execute = async (): Promise<Result<Conclusion>> => {
    await publish(projection);
    const admission = workAdmission(projection);
    if (!admission.ok) return admission;
    if (admission.value !== null) return { ok: true, value: admission.value };
    for (const raw of pendingReceipts(projection)) {
      if (raw.closure !== 'dead' && !attemptOpen(projection, raw)) {
        const retained = await commit([{type:'attempt_settled',receipt:raw}]);
        if (!retained.ok) return retained;
        continue;
      }
      const resumed = await settle(projection, raw, writer, scope);
      if (!resumed.ok) return resumed;
      projection = resumed.value.projection;
    }
    if (projection.conclusion?.reason === 'backstop' && projection.status === 'parked') return { ok: true, value: projection.conclusion };
    if (projection.intervals.some(intervalOpen) || projection.reservations.some(reservationOpen)
      || projection.owners.some(item => !isDeepStrictEqual(item.owner, writer.owner) && (item.state === 'live' || item.state === 'unknown'))
      || projection.invocations.some(invocation => invocation.address.kind === 'stage' && invocation.charge !== 'command'
        && !projection.closedInvocations.some(closed => isDeepStrictEqual(closed, invocation))
        && !projection.attempts.some(receipt => isDeepStrictEqual({ kind: 'stage', ...receipt.address }, invocation.address))))
      return { ok: false, kind: 'unknown', detail: 'Unresolved execution ownership, invocation, reservation or time' };
    const previous = projection.attempts.at(-1);
    if (previous && previous.ending !== 'delivered') {
      const history = await readEvents(writer.journal, 0);
      if (!history.ok) return history;
      const reservedAt = history.value.find(event => event.payload.type === 'invocation_reserved'
        && event.payload.invocation.charge !== 'command'
        && isDeepStrictEqual(event.payload.invocation.address, {kind:'stage',...previous.address}))?.seq;
      // Resume consumes the preceding stop for every ending. The retained receipt
      // remains evidence; closure reconciliation above must precede new effects.
      const continued = reservedAt !== undefined && projection.intents.some(intent => intent.kind === 'resume'
        && intent.expectedCursor >= reservedAt);
      if (!continued) {
        const decision = decideRetry({ projection, receipt: previous });
        if (decision.kind === 'retry') recovered = { stage: previous.address.stage,
          charge: decision.charge as Exclude<Invocation['charge'], 'command'>, previous: previous.address };
        else if (decision.kind === 'park' || decision.kind === 'stop') return await finish(await attemptConclusion(decision.conclusion, previous));
      }
    }
    const opening = await commit([{ type: 'active_time_opened', interval: { id: interval, owner: writer.owner,
      openedAt: start.at, spentMs: null } }]);
    if (!opening.ok) return opening;
    opened = true;
    // This is an observation cadence, never a verdict timeout. Slow callbacks cannot overlap.
    timer = setInterval(() => {
      if (snapshot) return;
      snapshot = (async () => {
        await observe();
        const fresh = await readProjection(writer.journal);
        if (fresh.ok) await publish(fresh.value);
      })().catch(error=>{observationError=error;}).finally(() => { snapshot = undefined; });
    }, 5000);
    timer.unref();
    let retry = recovered;
    const handleRetry = async (decision: RetryDecision, receipt: AttemptReceipt): Promise<Result<Conclusion> | null> => {
      if (decision.kind === 'park' || decision.kind === 'stop') return await finish(await attemptConclusion(decision.conclusion, receipt));
      if (decision.kind === 'retry') {
        retry = { stage: receipt.address.stage, charge: decision.charge as Exclude<Invocation['charge'], 'command'>, previous: receipt.address };
        const reset = await commit([{ type: 'stage_settled', stage: receipt.address.stage, state: 'pending', evidence: [] }]);
        if (!reset.ok) return reset;
      }
      return null;
    };
    // The tree capture this loop step already holds, if any: set by the restore's authentication, a selection read or a command's after-read,
    // dropped whenever something that can write may have run since. Every other boundary reads the project itself.
    let held: Hash | undefined;
    const commands = async (declared: readonly DeclaredCommand[], address: Parameters<typeof reserveInvocation>[0]['address'], againstBase = false): Promise<Result<readonly CommandReceipt[] | Conclusion>> => {
      const receipts: CommandReceipt[] = [];
      for (const command of declared) {
        if (address.kind === 'stage' && commandInterrupted(projection, address, command.id)) continue;
        if (abort.aborted) return { ok: true, value: { status: 'cancelled', reason: 'cancelled', detail: 'cancelled' } };
        // Each scheduled request gets a new execution identity. Only its reservation may be reused.
        const key = await identifyCommand(command, scope, undefined, held);
        if (!key.ok) return key;
        const fresh = await refresh();
        if (!fresh.ok) return fresh;
        const reserved = await reserveInvocation({ charge: 'command', address, command: { id: command.id, key: key.value },
          activeInterval: interval }, projection, writer);
        if (!reserved.ok) return reserved;
        const paid = await refresh();
        if (!paid.ok) return paid;
        if (reserved.value.kind === 'stop') return { ok: true, value: reserved.value.conclusion };
        if (reserved.value.kind === 'reused') { receipts.push(reserved.value.receipt); continue; }
        if (!reserved.value.reservation) return { ok: false, kind: 'invalid', detail: 'Command has no reservation' };
        if (abort.aborted || projection.intents.some(intent => intent.kind === 'cancel'))
          return { ok: true, value: { status: 'cancelled', reason: 'cancelled', detail: 'cancelled' } };
        held = undefined;
        const measured = await ports.command({ command, key: key.value, reservation: reserved.value.reservation, ...(againstBase ? { againstBase } : {}) });
        if (!measured.ok) { opened = false; await refresh(); return measured; }
        if (!isDeepStrictEqual(measured.value.key, key.value) || measured.value.command !== command.id)
          return { ok: false, kind: 'invalid', detail: 'Command receipt differs from requested identity' };
        receipts.push(measured.value);
        // Its after-read was taken once the process group was proven closed; an unproven group means nothing is held.
        if (!(measured.value.execution.state === 'unfinished' && measured.value.execution.reason === 'closure_unknown')) held = measured.value.after;
        const recorded = await refresh();
        if (!recorded.ok) return recorded;
        const pause = commandPause(projection.run, measured.value);
        if (pause) return { ok: true, value: pause };
      }
      return { ok: true, value: receipts };
    };
    for (;;) {
      held = undefined;
      const fresh = await refresh();
      if (!fresh.ok) return fresh;
      if (projection.status === 'parked' && projection.conclusion) return await finish(projection.conclusion);
      if (abort.aborted) return await finish({ status: 'cancelled', reason: 'cancelled', detail: 'cancelled' });
      if (projection.status === 'cancelled' || projection.intents.some(intent => intent.kind === 'cancel'))
        return await finish({ status: 'cancelled', reason: 'cancelled', detail: 'cancelled' });
      const next = decideNext(projection);
      if (!next.ok) return next;
      if (next.value.kind === 'stop') return await finish(next.value.conclusion);
      if (next.value.kind === 'transition') {
        const transitioned = await commit([next.value.transition]);
        if (!transitioned.ok) return transitioned;
        continue;
      }
      if (next.value.kind === 'publication') {
        const checkpoint = next.value.checkpoint;
        const tree = await captureTree(scope);
        if (!tree.ok) return tree;
        if (tree.value !== checkpoint.tree) return { ok: false, kind: 'conflict', detail: 'Delivery tree changed after gate' };
        const outputs = await preserveOutputs(scope, checkpoint);
        if (!outputs.ok) return outputs;
        const finished = await finish(async p=> {
          const next=decideNext(p);
          if (!next.ok) return next;
          return next.value.kind === 'publication' ? decidePublication(writer.journal,p,next.value.checkpoint,outputs.value)
            : {ok:true,value:null};
        },[{type:'outputs_preserved',receipt:outputs.value}]);
        if (finished.ok && finished.value === null) continue;
        return finished as Result<Conclusion>;
      }
      const { stage, context } = next.value;
      const guidance = stage.purpose === 'gate' ? [] : pendingGuidance(projection);
      const continuation = guidance.length && projection.stageStates.some(state=>state.stage === stage.id && state.state === 'settled')
        ? projection.attempts.filter(receipt=>receipt.address.stage === stage.id).at(-1)?.address : undefined;
      const previous = continuation ?? (retry?.stage === stage.id ? retry.previous : undefined);
      const address: AttemptAddress = previous ? {...previous,invocation:previous.invocation+1}
        : {run:projection.run,stage:stage.id,attempt:newId(),invocation:1};
      if (continuation) {
        const reset = await commit(projection.plan.plan.stages.filter(item=>stageDepends(projection,item.id,stage.id)).map(item=>({type:'stage_settled' as const,stage:item.id,state:'pending' as const,evidence:[]})));
        if (!reset.ok) return reset;
      }
      if (stage.baseCheckpoint && !continuation) {
        const base = await readCheckpoint(writer.journal, stage.baseCheckpoint);
        if (!base.ok) return base;
        const materialized = await materializeCheckpoint(scope, writer, base.value);
        if (!materialized.ok) return materialized;
        held = materialized.value;
        const restored = await refresh();
        if (!restored.ok) return restored;
      }
      // The target tree is the one just captured (commands may have written); input identities come from the latest checkpoint.
      const target = (tree: string) => ({tree,inputHashes:projection.checkpoints.at(-1)?.inputHashes ?? []});
      let selectedIds = stage.commands ?? [];
      if (context.final || selectedIds.length) {
        const tree = held ? { ok: true as const, value: held } : await captureTree(scope);
        if (!tree.ok) return tree;
        held = tree.value;
        selectedIds = await selectedCommandIds(stage, projection, writer.journal, target(tree.value), context.final);
      }
      const selected = selectedIds.map(id => projection.brief.declaration.commands.find(command => command.id === id)!);
      if (selected.length) {
        const measured = await commands(selected, { kind: 'stage', ...address }, context.final);
        if (!measured.ok) return measured;
        if (!Array.isArray(measured.value)) return await finish(measured.value as Conclusion);
      }
      const charge = guidance.length ? 'continuation' : retry?.stage === stage.id ? retry.charge : stage.purpose === 'plan' ? 'plan' : 'work';
      const paid = await reserveInvocation({ address: { kind: 'stage', ...address }, charge, activeInterval: interval }, projection, writer);
      if (!paid.ok) return paid;
      const recorded = await refresh();
      if (!recorded.ok) return recorded;
      if (paid.value.kind === 'stop') return await finish(paid.value.conclusion);
      if (paid.value.kind !== 'reserved') return { ok: false, kind: 'invalid', detail: 'Model invocation cannot reuse a command' };
      const running = await commit([{ type: 'stage_settled', stage: stage.id, state: 'running', evidence: [] }]);
      if (!running.ok) return running;
      const role = projection.launch.roles.find(role => role.id === stage.role);
      if (!role) return { ok: false, kind: 'invalid', detail: 'Unknown stage role' };
      if (abort.aborted || projection.intents.some(intent => intent.kind === 'cancel'))
        return await finish({ status: 'cancelled', reason: 'cancelled', detail: 'cancelled' });
      active = {invocation:paid.value.invocation,offered:new Set(guidance.map(guide=>guide.id)),delivered:[],activity:{
        invocation:paid.value.invocation,source:stage.purpose === 'gate' ? 'gate' : 'author',stage:stage.id,state:'current',lastEventAt:null,lastTool:null,
        summary:null,toolRunning:false,observation:'unknown'}};
      const current = active;
      await observe();
      let commandReview: import('../contract/runtime.js').AttemptRequest['commandReview'];
      if (context.final) {
        const tree = held ? { ok: true as const, value: held } : await captureTree(scope);
        if (!tree.ok) return tree;
        held = tree.value;
        commandReview = await reviewCommandEvidence(writer.journal, projection, stage, true, target(tree.value));
      }
      const invoked = await ports.attempt({ ...(held ? {before: held} : {}), ...(commandReview ? {commandReview} : {}), address, brief: projection.brief, plan: projection.plan, stage, role, invocation: paid.value.invocation,
        evidence: [...projection.attempts.flatMap(receipt => [...(receipt.answerRef ? [receipt.answerRef] : []), ...receipt.evidence]),
          ...projection.received.filter(raw => !projection.attempts.some(receipt => isDeepStrictEqual(receipt.address, raw.address)))
            .flatMap(raw => [raw.audit, ...raw.evidence])], context,
        live:{...(stage.purpose === 'gate' ? {} : {onLive:(live:LiveInvocation)=>{current.live=live;}}),
          onActivity:event=>{current.activity=authorActivity(current.activity,event);}},
        ...(guidance.length ? { guidance: guidance.flatMap(intent => intent.kind === 'guide'
          ? [{ intent: intent.id, cursor: intent.expectedCursor, intervention: intent.intervention }] : []) } : {}) });
      if (invoked.ok) returned={address,receipt:invoked.value};
      if (snapshot) await snapshot;
      if (returned && current.delivered.length) returned={...returned,receipt:{...returned.receipt,
        guidance:[...new Set([...(returned.receipt.guidance ?? []),...current.delivered])]}};
      if (observationError) throw observationError;
      current.live=undefined;
      current.activity={...current.activity,state:'ended',toolRunning:false};
      await observe();
      active=undefined;
      if (!invoked.ok) { opened = false; await refresh(); return invoked; }
      const settled = await settle(projection, returned!.receipt, writer, scope);
      const settledSnapshot = await retain();
      if (!settledSnapshot.ok) return settledSnapshot;
      if (projection.conclusion && nextLifecycle(projection.status, 'run') === null) return await finish(projection.conclusion);
      const receipt = projection.attempts.find(receipt => isDeepStrictEqual(receipt.address, address));
      const action = settlementAction(settled);
      if (action === 'park') {
        return await finish(await attemptConclusion({ status: 'parked', reason: 'recovery_unknown', detail: settled.ok ? 'Settlement unavailable or unknown' : `${settled.kind}: ${settled.detail}` }, receipt ?? invoked.value));
      }
      if (!receipt) return { ok: false, kind: 'unknown', detail: 'Settlement receipt unavailable' };
      if (action === 'isolation_refused') return await finish(await attemptConclusion({ status: 'failed', reason: 'isolation_refused', detail: 'Frozen restoration not proven' }, receipt));
      retry = undefined;
      const decision = decideRetry({ projection, receipt });
      const stopped = await handleRetry(decision, receipt);
      if (stopped) return stopped;
    }
  };
  let outcome: Result<Conclusion>;
  try { outcome = await execute(); }
  catch (error) { outcome = { ok: false, kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }; }
  finally {
    if (timer) clearInterval(timer);
    if (snapshot) await snapshot;
  }
  if (returned) { const retained = await retain(); if (!retained.ok) return retained; }
  if (opened) {
    const closed = await commit([{ type: 'active_time_closed', interval, spentMs: elapsed() }]);
    if (!closed.ok) return closed;
  }
  return outcome;
}
function newId(): Id { return `r_${randomUUID()}`; }

// Every settlement outcome routes through this closed typed-fact table. Details are evidence only.
function settlementAction(result: Result<SettledFacts>): 'retry' | 'isolation_refused' | 'park' {
  type Fact = SettledFacts['frozen']['state'] | 'invalid_answer' | 'invalid_plan' | Extract<Result<never>, { ok: false }>['kind'];
  const table: Record<Fact, 'retry' | 'isolation_refused' | 'park'> = {
    unchanged: 'retry', restored: 'retry', quarantined: 'isolation_refused',
    invalid_answer: 'retry', invalid_plan: 'retry', conflict: 'park', output_changed: 'park', invalid: 'park', unavailable: 'park', unknown: 'park',
  };
  const fact: Fact = !result.ok ? result.kind : result.value.frozen.state !== 'unchanged' ? result.value.frozen.state
    : result.value.receipt.ending === 'invalid_answer' || result.value.receipt.ending === 'invalid_plan' ? result.value.receipt.ending : 'unchanged';
  return table[fact];
}
