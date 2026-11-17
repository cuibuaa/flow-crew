import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DeclaredCommand, Id } from '../contract/brief.js';
import type { AttemptAddress, JournalPayload, Invocation } from '../contract/runtime.js';
import { appendEvents, readEvents, intervalOpen, reservationOpen, workAdmission, nextLifecycle } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { readCommand } from '../records/state.js';
import { captureTree, materializeCheckpoint, preserveOutputs, readCheckpoint } from '../records/content.js';
import { identifyCommand } from '../exec/command.js';
import { decideNext, decidePublication } from './decisions.js';
import { reserveInvocation, reconstructBackstop, decideRetry, type RetryDecision } from './retry.js';
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
 * Drive recovery, observed active time, identified plan/work/gate calls, selected commands, atomic revision/settlement/transition and publication. Close observation intervals before park/exit; publish status after committed batches and while active. Never runs across unresolved owners/reservations or launches a hidden final command sweep. Returns honest Conclusion or invalid/conflict/unavailable/unknown; status publication failure never rewrites a gate verdict. */
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
  const elapsed = () => Math.max(0, Math.ceil(ports.now().monotonicMs - start.monotonicMs));
  const publish = async (p: RunProjection) => { await ports.publishStatus(ports.now(), p.intervals.some(intervalOpen) ? (opened ? elapsed() : null) : 0); };
  const refresh = async (): Promise<Result<RunProjection>> => {
    const fresh = await readProjection(writer.journal);
    if (fresh.ok) { projection = fresh.value; await publish(projection); }
    return fresh;
  };
  const commit = async (payloads: readonly JournalPayload[]): Promise<Result<RunProjection>> => {
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return fresh;
    projection = fresh.value;
    const appended = await appendEvents(writer, projection.cursor, payloads);
    return appended.ok ? refresh() : appended;
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
  const finish = async (conclusion: Conclusion): Promise<Result<Conclusion>> => {
    const fresh = await readProjection(writer.journal);
    if (!fresh.ok) return fresh;
    projection = fresh.value;
    const fenced = projection.status === 'cancelled' || projection.intents.some(intent => intent.kind === 'cancel');
    const spentMs = elapsed();
    const final = fenced ? { status: 'cancelled' as const, reason: 'cancelled' as const, detail: 'cancelled' } : conclusion;
    const closed = await commit([...(opened ? [{ type: 'active_time_closed' as const, interval, spentMs }] : []),
      ...(!projection.conclusion || nextLifecycle(projection.status, 'run') !== null ? [{ type: 'lifecycle' as const, conclusion: final }] : [])]);
    if (!closed.ok) return closed;
    opened = false;
    return { ok: true, value: closed.value.conclusion ?? final };
  };
  const execute = async (): Promise<Result<Conclusion>> => {
    await publish(projection);
    const admission = workAdmission(projection);
    if (!admission.ok) return admission;
    if (admission.value !== null) return { ok: true, value: admission.value };
    for (const raw of projection.received.filter(raw => !projection.attempts.some(item => isDeepStrictEqual(item.address, raw.address)))) {
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
      const decision = decideRetry({ projection, receipt: previous });
      if (decision.kind === 'retry') recovered = { stage: previous.address.stage, charge: decision.charge as Exclude<Invocation['charge'], 'command'>, previous: previous.address };
      else if (decision.kind === 'park' || decision.kind === 'stop') {
        const history = await readEvents(writer.journal, 0);
        if (!history.ok) return history;
        const settledAt = history.value.find(event => event.payload.type === 'attempt_settled' && isDeepStrictEqual(event.payload.receipt.address, previous.address))?.seq;
        const resumedQuota = previous.ending === 'quota' && decision.kind === 'park' && settledAt !== undefined
          && projection.intents.some(intent => intent.kind === 'resume' && intent.expectedCursor >= settledAt);
        if (!resumedQuota) return await finish(decision.conclusion);
        // A known-closed park resumes the frontier as a fresh purpose-charged attempt (R7).
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
        const fresh = await readProjection(writer.journal);
        if (fresh.ok) await publish(fresh.value);
      })().finally(() => { snapshot = undefined; });
    }, 5000);
    timer.unref();
    let retry = recovered;
    const handleRetry = async (decision: RetryDecision, receipt: AttemptReceipt): Promise<Result<Conclusion> | null> => {
      if (decision.kind === 'park' || decision.kind === 'stop') return await finish(decision.conclusion);
      if (decision.kind === 'retry') {
        retry = { stage: receipt.address.stage, charge: decision.charge as Exclude<Invocation['charge'], 'command'>, previous: receipt.address };
        const reset = await commit([{ type: 'stage_settled', stage: receipt.address.stage, state: 'pending', evidence: [] }]);
        if (!reset.ok) return reset;
      }
      return null;
    };
    const commands = async (declared: readonly DeclaredCommand[], address: Parameters<typeof reserveInvocation>[0]['address']): Promise<Result<readonly CommandReceipt[] | Conclusion>> => {
      const receipts: CommandReceipt[] = [];
      for (const command of declared) {
        if (abort.aborted) return { ok: true, value: { status: 'cancelled', reason: 'cancelled', detail: 'cancelled' } };
        const observation = [...(projection.plan.plan.observations ?? []), ...projection.attempts.flatMap(item =>
          item.ending === 'delivered' && item.answer?.kind === 'work' ? item.answer.answer.observations ?? [] : [])].filter(item => item.command === command.id).at(-1);
        if (!observation) return { ok: false, kind: 'invalid', detail: 'Command requires an admitted source/product observation' };
        let key = await identifyCommand(command, scope, undefined, observation);
        for (const receipt of projection.commands.filter(item => item.command === command.id)) {
          const candidate = await identifyCommand(command, scope, receipt.key.execution, observation);
          if (!candidate.ok) return candidate;
          if (isDeepStrictEqual(candidate.value, receipt.key)) { key = candidate; break; }
        }
        if (!key.ok) return key;
        const existing = await readCommand(writer.journal, key.value);
        if (!existing.ok) return existing;
        if (existing.value) {
          if (existing.value.state !== 'committed') return { ok: false, kind: 'unknown', detail: 'Unresolved command reservation' };
          receipts.push(existing.value.receipt);
          continue;
        }
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
        const measured = await ports.command({ command, key: key.value, reservation: reserved.value.reservation });
        if (!measured.ok) { opened = false; await refresh(); return measured; }
        if (!isDeepStrictEqual(measured.value.key, key.value) || measured.value.command !== command.id)
          return { ok: false, kind: 'invalid', detail: 'Command receipt differs from requested identity' };
        receipts.push(measured.value);
        const recorded = await refresh();
        if (!recorded.ok) return recorded;
      }
      return { ok: true, value: receipts };
    };
    for (;;) {
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
        const preserved = await commit([{ type: 'outputs_preserved', receipt: outputs.value }]);
        if (!preserved.ok) return preserved;
        const publication = decidePublication(projection, checkpoint, outputs.value);
        return publication.ok ? await finish(publication.value) : publication;
      }
      const { stage, context } = next.value;
      const address: AttemptAddress = retry?.stage === stage.id
        ? { ...retry.previous, invocation: retry.previous.invocation + 1 }
        : { run: projection.run, stage: stage.id, attempt: newId(), invocation: 1 };
      const guidance = stage.purpose === 'gate' ? [] : projection.intents.filter(intent => intent.kind === 'guide'
        && !projection.attempts.some(receipt => receipt.guidance?.includes(intent.id)));
      if (stage.baseCheckpoint) {
        const base = await readCheckpoint(writer.journal, stage.baseCheckpoint);
        if (!base.ok) return base;
        const materialized = await materializeCheckpoint(scope, writer, base.value);
        if (!materialized.ok) return materialized;
        const restored = await refresh();
        if (!restored.ok) return restored;
      }
      if (stage.commands?.length) {
        const measured = await commands(stage.commands.map(id => projection.brief.declaration.commands.find(command => command.id === id)!), { kind: 'stage', ...address });
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
      const invoked = await ports.attempt({ address, brief: projection.brief, plan: projection.plan, stage, role, invocation: paid.value.invocation,
        evidence: projection.attempts.flatMap(receipt => receipt.answerRef ? [receipt.answerRef] : receipt.evidence), context,
        ...(guidance.length ? { guidance: guidance.flatMap(intent => intent.kind === 'guide'
          ? [{ intent: intent.id, cursor: intent.expectedCursor, intervention: intent.intervention }] : []) } : {}) });
      if (!invoked.ok) { opened = false; await refresh(); return invoked; }
      returned = { address, receipt: invoked.value };
      let settlementCursor = projection.cursor;
      let settled = await settle(projection, invoked.value, writer, scope);
      // A stale caller settles nothing. Re-read and reconcile this same paid result before dispatching again.
      while (settlementAction(settled) === 'reread') {
        const fresh = await refresh();
        if (!fresh.ok) return fresh;
        if (projection.attempts.some(receipt => isDeepStrictEqual(receipt.address, address))) break;
        if (projection.cursor === settlementCursor && !settled.ok) {
          settled = { ok: false, kind: 'unknown', detail: 'Settlement conflict without journal progress' };
          break;
        }
        settlementCursor = projection.cursor;
        settled = await settle(projection, invoked.value, writer, scope);
      }
      const settledSnapshot = await retain();
      if (!settledSnapshot.ok) return settledSnapshot;
      if (projection.conclusion && nextLifecycle(projection.status, 'run') === null) return await finish(projection.conclusion);
      const receipt = projection.attempts.find(receipt => isDeepStrictEqual(receipt.address, address));
      const action = settlementAction(settled);
      if (action === 'park') {
        return await finish({ status: 'parked', reason: 'recovery_unknown', detail: settled.ok ? 'Settlement unavailable or unknown' : settled.detail });
      }
      if (!receipt) return { ok: false, kind: 'unknown', detail: 'Settlement receipt unavailable' };
      if (action === 'isolation_refused') return await finish({ status: 'failed', reason: 'isolation_refused', detail: 'Frozen restoration not proven' });
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
    const fresh = await readProjection(writer.journal); if (!fresh.ok) return fresh;
    const closed = await appendEvents(writer, fresh.value.cursor, [{ type: 'active_time_closed', interval, spentMs: elapsed() }]);
    if (!closed.ok) return closed;
    opened = false; const refreshed = await refresh(); if (!refreshed.ok) return refreshed;
  }
  return outcome;
}
function newId(): Id { return `r_${randomUUID()}`; }

// Every settlement outcome routes through this closed typed-fact table. Details are evidence only.
function settlementAction(result: Result<SettledFacts>): 'retry' | 'isolation_refused' | 'reread' | 'park' {
  type Fact = SettledFacts['frozen']['state'] | 'invalid_answer' | 'invalid_plan' | Extract<Result<never>, { ok: false }>['kind'];
  const table: Record<Fact, 'retry' | 'isolation_refused' | 'reread' | 'park'> = {
    unchanged: 'retry', restored: 'retry', quarantined: 'isolation_refused',
    invalid_answer: 'retry', invalid_plan: 'retry', conflict: 'reread', invalid: 'park', unavailable: 'park', unknown: 'park',
  };
  const fact: Fact = !result.ok ? result.kind : result.value.frozen.state !== 'unchanged' ? result.value.frozen.state
    : result.value.receipt.ending === 'invalid_answer' || result.value.receipt.ending === 'invalid_plan' ? result.value.receipt.ending : 'unchanged';
  return table[fact];
}
