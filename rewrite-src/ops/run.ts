import { reconcileRun, attendRun } from './reconcile.js';
import { protectedStatePaths } from '../records/state.js';
import { claim, release, workAdmission, nextLifecycle, isFinal, acceptsGuidance, reservationOpen } from '../records/state.js';
import { gitAuthority } from '../records/content.js';
import { resolve, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JournalPayload, RunProjection, OwnedProgram } from '../contract/runtime.js';
import { idSchema } from '../contract/brief.js';
import { observeRun, startRun, isUnconfirmedClosure, type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { validateRecordRef } from '../records/evidence.js';
import { validateRecordLayout } from '../records/content.js';
import { verifyRuntime, hashInputs, readCheckpoint, materializeCheckpoint, captureTree } from '../records/content.js';
import { randomUUID } from 'node:crypto';
import { parsePlan, type AdmittedPlan } from '../contract/plan.js';
import { admitLaunch, admitPlan } from '../core/admission.js';
import { reconstructBackstop } from '../core/retry.js';
import { runWorkflow } from '../core/loop.js';
import { publishRunStatus } from './status.js';
import type { Id, Result } from '../contract/brief.js';
import { parseControlIntent, parseLaunch, parseOperation, parseRunObservation, type Conclusion, type ControlIntent, type Launch, type Operation,
  type RunLocation, type RuntimeConfig, type RunRef, type Writer } from '../contract/runtime.js';
import type { ExecutionContext } from '../exec/attempt.js';
import type { TransportContext } from '../exec/transport.js';
import type { ProcessPorts, ProcessPortsFactory, RunContext } from '../host/process.js';
import type { ContentScope } from '../records/content.js';
import type { WorkflowPorts } from '../core/loop.js';

/**  Explicit addressed short command. */
export type RunOperationRequest = {
  readonly location: RunLocation;
} & (
    | { readonly intent: ControlIntent & { readonly kind: 'start' }; readonly launch: Launch; readonly plannerRole: Id }
    | { readonly intent: ControlIntent & { readonly kind: 'cancel' | 'resume' | 'status' | 'guide' } }
  );

/**  Main supplies verified config/root/environment and unbound process factory. */
export interface RunServices {
  readonly configuration: RuntimeConfig;
  readonly unitContext: RunContext;
  readonly process: ProcessPortsFactory;
  readonly configRoot: ExecutionContext['configRoot'];
  readonly privateEnvironment: TransportContext['privateEnvironment'];
  workflowPorts(scope: ContentScope, writer: Writer, process: ProcessPorts, abort: AbortSignal): WorkflowPorts;
}

/** Commit an addressed intent before its effects; acknowledgement does not assert closure or completion. */
export async function operateRun(request: RunOperationRequest, services: RunServices): Promise<Result<Operation>> {
  const parsed = parseControlIntent(request.intent);
  if (!parsed.ok) return parsed;
  const { location, intent } = request;
  if (location.run !== intent.run || !idSchema.safeParse(location.run).success) return refusal('invalid', 'Run address mismatch');
  if (intent.kind === 'start') {
    if (!('launch' in request)) return refusal('invalid', 'Missing launch');
    const launch = parseLaunch(request.launch);
    if (!launch.ok) return launch;
    request = { ...request, launch: launch.value };
    if (launch.value.run !== location.run || !isDeepStrictEqual(launch.value.unit, intent.unit)) return refusal('invalid', 'Launch intent mismatch');
  }
  const claims: Claim[] = [];
  let attentionWriter: Writer | undefined;
  const execute = async (): Promise<Result<Operation>> => {
    const control = await claim(join(resolve(location.storeRoot), 'runs', location.run, 'control'), intent.unit, { database: location.database,
      holder: join(resolve(location.storeRoot), 'runs', location.run) });
    if (!control.ok) return control;
    claims.push(control.value);
    const journal = await openJournal(location, 'read');
    if (!journal.ok) return journal;
    const opened = await openWriter(journal.value, control.value, 'control');
    if (!opened.ok) return opened;
    const writer = opened.value; attentionWriter = writer;
    const process = services.process(writer);
    const events = await readEvents(journal.value, 0);
    if (!events.ok) return events;
    const existing = events.value.find(event => event.payload.type === 'control_intent' && event.payload.intent.id === intent.id);
    if (existing?.payload.type === 'control_intent' && !isDeepStrictEqual(existing.payload.intent, intent))
      return refusal('conflict', 'Intent id reused with different fields');
    if (existing?.payload.type === 'control_intent' && intent.kind !== 'cancel') {
      const settled = [...events.value].reverse().find(event => event.payload.type === 'control_settled' &&
        event.payload.operation.intent.id === intent.id);
      const published = await refresh(location, writer);
      void published;
      if (settled?.payload.type === 'control_settled') return { ok: true, value: settled.payload.operation };
      const observed = await observeRun(intent.unit, services.unitContext);
      const reconciled = intent.kind === 'status' || intent.kind === 'guide'
        || ((intent.kind === 'start' || intent.kind === 'resume') && observed.ok && observed.value.state === 'active');
      if (reconciled) {
        const operation = parseOperation({
          intent, state: 'acknowledged', cursor: existing.seq, observation: observed.ok ? observed.value : null,
          evidence: observed.ok ? observed.value.evidence : [], detail: 'Reconciled committed intent without repeating unit side effects'
        });
        if (!operation.ok) return operation;
        const recorded = await appendFresh(writer, [{ type: 'control_settled', operation: operation.value }]);
        if (!recorded.ok) return recorded;
        const refreshed = await refresh(location, writer);
        return refreshed.ok ? operation : refreshed;
      }
      return parseOperation({
        intent, state: 'unknown', cursor: existing.seq, observation: observed.ok ? observed.value : null,
        evidence: [], detail: 'Intent committed; side effects require reconciliation'
      });
    }
    const tail = events.value.filter(event => event.seq > intent.expectedCursor);
    const admittedTail = request.intent.kind === 'start' && 'launch' in request && tail.length === 2
      && tail[0].payload.type === 'admitted' && isDeepStrictEqual(parseLaunch(tail[0].payload.launch), parseLaunch(request.launch))
      && tail[1].payload.type === 'plan_committed';
    if (intent.kind === 'start' && (events.value.at(-1)?.seq ?? 0) !== intent.expectedCursor && !admittedTail) return refusal('conflict', 'Stale intent boundary');
    let projection: RunProjection;
    if (request.intent.kind === 'start' && 'launch' in request) {
      if (!admittedTail && events.value.some(event => event.payload.type === 'admitted')) return refusal('conflict', 'Run already admitted');
      const project = await claim(resolve(request.launch.project), intent.unit, { database: location.database,
        holder: join(resolve(location.storeRoot), 'runs', location.run) });
      if (!project.ok) return project;
      claims.push(project.value);
      const scope = await scopeFor(location, request.launch, writer, project.value, services);
      if (!scope.ok) return scope;
      const inputs = await hashInputs(scope.value);
      if (!inputs.ok) return inputs;
      const admitted = admittedTail ? await readProjection(journal.value) : await admitLaunch(request.launch, request.plannerRole, writer,
        scope.value);
      if (!admitted.ok) return admitted;
      projection = admitted.value;
      const published = await publishRunStatus(location, new Date().toISOString(), null);
      void published;
    } else {
      const current = await readProjection(journal.value);
      if (!current.ok) return current;
      projection = current.value;
    }
    if (!isDeepStrictEqual(projection.launch.unit, intent.unit)) return refusal('conflict', 'Pinned unit mismatch');
    const ended = isFinal(projection.status);
    if (intent.kind === 'resume') {
      if (nextLifecycle(projection.status, 'resume') === null || projection.intents.some(i => i.kind === 'cancel'))
        return refusal('conflict', 'Terminal or cancelled runs cannot resume');
      const running = await observeRun(intent.unit, services.unitContext);
      if (!running.ok) return running;
      if (running.value.state === 'active' && projection.status === 'parked')
        return refusal('conflict', 'The prior activation is still closing; wait for it to finish before resuming');
      if (running.value.state === 'active') return parseOperation({ intent, state: 'acknowledged', cursor: projection.cursor,
        observation: running.value, evidence: running.value.evidence, detail: 'Already running' });
      const project = await claim(resolve(projection.launch.project), intent.unit, { database: location.database,
        holder: join(resolve(location.storeRoot), 'runs', location.run) });
      if (!project.ok) return project;
      claims.push(project.value);
      const scope = await scopeFor(location, projection.launch, writer, project.value, services);
      if (!scope.ok) return scope;
      const inputs = await hashInputs(scope.value);
      if (!inputs.ok) return inputs;
      if (!isDeepStrictEqual(inputs.value, projection.launch.setup.inputs)) return refusal('conflict', 'Frozen input identity changed');
      const closed = await reconcileRun(writer, process, services.unitContext, claims, false);
      if (!closed.ok) return closed;
      const reconciled = await readProjection(journal.value); if (!reconciled.ok) return reconciled;
      projection = reconciled.value;
      if (projection.checkpoints.at(-1)?.state === 'quarantined') return refusal('conflict', 'Quarantined recovery base');
      const observation = await observeRun(intent.unit, services.unitContext);
      if (!observation.ok) return observation;
      const observationParsed = parseRunObservation(observation.value);
      if (!observationParsed.ok) return observationParsed;
      if (!isDeepStrictEqual(observation.value.unit, intent.unit)) return refusal('conflict', 'Observed unit mismatch');
      if (observation.value.state === 'unknown') return refusal('unknown', 'Unit state unknown');

    }
    let replacement: AdmittedPlan | undefined;
    if (intent.kind === 'guide') {
      if (!acceptsGuidance(projection.status, projection.intents.some(item => item.kind === 'cancel')))
        return refusal('conflict', 'Terminal or cancelled runs cannot receive guidance');
      const content = await validateRecordRef(journal.value, intent.intervention.content);
      if (!content.ok) return content;
      const observation = await observeRun(intent.unit, services.unitContext);
      if (!observation.ok) return observation;
      if (observation.value.state === 'inactive') {
        const reconciled = await reconcileRun(writer, process, services.unitContext, claims, false);
        if (!reconciled.ok) return reconciled;
        const fresh = await readProjection(journal.value); if (!fresh.ok) return fresh;
        projection = fresh.value;
      }
    }
    if (intent.kind === 'guide' && intent.intervention.replacement) {
      if (projection.reservations.some(reservationOpen) || projection.invocations.some(item => item.charge !== 'command' && item.address.kind === 'stage'
        && !projection.closedInvocations.some(closed => isDeepStrictEqual(closed, item)) && !projection.attempts.some(receipt =>
          isDeepStrictEqual({ kind: 'stage', ...receipt.address }, item.address)))) return refusal('conflict',
            'Wait for the current step or park first');
      const proposed = parsePlan(intent.intervention.replacement.plan, {
        roleIds: projection.launch.roles.map(item => item.id),
        commandIds: projection.brief.declaration.commands.map(item => item.id),
          checkpointIds: projection.checkpoints.filter(item => item.state === 'safe').map(item => item.id),
        settledStageIds: projection.stageStates.filter(item => item.state === 'settled').map(item => item.stage)
      });
      if (!proposed.ok) return proposed;
      const admitted = admitPlan(proposed.value, 'revision_' + randomUUID(), projection, undefined, intent);
      if (!admitted.ok) return admitted;
      replacement = admitted.value;
    }
    // The original pre-admission boundary stays in the intent; CAS uses refreshed journal facts.
    const appended = existing ? { ok: true as const, value: existing.seq } : await appendEvents(writer, replacement ? projection.cursor : null, [{ type: 'control_intent', intent }, ...(replacement ? [{ type: 'plan_committed' as const,
      plan: replacement }] : [])]);
    if (!appended.ok) {
      if (appended.kind !== 'unknown') return appended;
      const reread = await readEvents(journal.value, 0);
      const committed = reread.ok ? reread.value.find(event => event.payload.type === 'control_intent' && isDeepStrictEqual(event.payload.intent,
        intent)) : undefined;
      return parseOperation({ intent, state: 'unknown', cursor: committed?.seq ?? null, observation: null, evidence: [],
        detail: 'Append outcome uncertain; no unit side effects performed' });
    }
    const firstRefresh = await refresh(location, writer);
    void firstRefresh;
    let observation: Operation['observation'] = null;
    let state: Operation['state'] = 'acknowledged';
    let detail = 'Intent committed';
    let hostFailure: unknown;
    if (intent.kind === 'start' || intent.kind === 'resume' || intent.kind === 'cancel') {
      if (intent.kind === 'start' || intent.kind === 'resume') {
        for (let index = claims.length - 1; index >= 0; index--) if (claims[index].resource === resolve(projection.launch.project)) {
          const handed = await release(claims[index], 'handoff');
          if (!handed.ok) return handed;
          claims.splice(index, 1);
        }
      }
      // Stopping authorizes no new execution; an open active interval must not prevent cancellation.
      const host = intent.kind === 'cancel'
        ? await reconcileRun(writer, process, services.unitContext, claims, true)
        : await startRun(intent.unit, entryProgram(location, projection.launch, services), process, services.unitContext);
      if (!host.ok) {
        hostFailure = host;
        const closurePending = isUnconfirmedClosure(host);
        state = closurePending ? 'not_confirmed_closed' : host.kind === 'unknown' ? 'unknown' : 'refused'; detail = host.detail;
      } else {
        const checked = parseRunObservation(host.value);
        if (!checked.ok) return checked;
        observation = checked.value;
        if (!isDeepStrictEqual(observation.unit, intent.unit)) return refusal('conflict', 'Host changed run identity');
        state = observation.state === 'unknown' ? 'unknown'
          : intent.kind === 'cancel' ? observation.state === 'active' ? 'in_progress' : 'acknowledged'
            : observation.state === 'active' ? 'acknowledged' : 'refused';
        detail = intent.kind === 'cancel' && ended && state === 'acknowledged' ? 'Already ended' : observation.detail;
      }
    }
    const operation = parseOperation({ intent, state, cursor: appended.value, observation, evidence: observation?.evidence ?? [], detail });
    if (!operation.ok) return operation;
    const attended = await attendRun(writer, hostFailure); if (!attended.ok) return attended;
    const settled = await appendFresh(writer, [...(observation ? [{ type: 'run_observed' as const, observation }] : []), {
      type: 'control_settled', operation: operation.value }]);
    if (!settled.ok) return settled;
    const published = await refresh(location, writer);
    void published;
    return operation;
  };
  return withClaims(execute, claims, () => attentionWriter);
}

/** Resume the pinned run under fresh ownership; unknown effects park without replay. */
export async function runUnitEntry(location: RunLocation, unit: RunRef, services: RunServices, abort: AbortSignal): Promise<Result<Conclusion>> {
  if (location.run !== unit.run || !idSchema.safeParse(location.run).success) return refusal('invalid', 'Unit entry address mismatch');
  const claims: Claim[] = [];
  let attentionWriter: Writer | undefined;
  const execute = async (): Promise<Result<Conclusion>> => {
    const journal = await openJournal(location, 'read');
    if (!journal.ok) return journal;
    let current = await readProjection(journal.value);
    if (!current.ok && current.kind === 'unknown') {
      const held = await claim(join(journal.value.root, 'execution'), unit, { database: location.database, holder: journal.value.root });
        if (!held.ok) return held;
      let recovered: Result<unknown>;
      try { const writer = await openWriter(journal.value, held.value, 'execution');
        recovered = writer.ok ? await reconstructBackstop(writer.value) : writer; }
      catch (error) { recovered = refusal('unknown', String(error)); }
      const released = await release(held.value, 'handoff'); if (!released.ok) return released; if (!recovered.ok) return recovered;
      current = await readProjection(journal.value);
    }
    if (!current.ok) return current;
    const projection = current.value;
    if (!isDeepStrictEqual(unit, projection.launch.unit)) return refusal('conflict', 'Entry pin mismatch');
    const initial = await publishRunStatus(location, new Date().toISOString(), null);
    void initial;
    const admission = workAdmission(projection);
    if (!admission.ok) return admission;
    if (admission.value !== null) return { ok: true, value: admission.value };
    const project = await claim(resolve(projection.launch.project), unit, { database: location.database, holder: journal.value.root });
    if (!project.ok) return project;
    claims.push(project.value);
    const execution = await claim(join(resolve(location.storeRoot), 'runs', location.run, 'execution'), unit, { database: location.database,
      holder: journal.value.root });
    if (!execution.ok) return execution;
    claims.push(execution.value);
    const opened = await openWriter(journal.value, execution.value, 'execution');
    if (!opened.ok) return opened;
    const writer = opened.value; attentionWriter = writer;
    const process = services.process(writer);
    const reconciled = await reconcileRun(writer, process, services.unitContext, claims, false);
    if (!reconciled.ok) return reconciled;
    const refreshed = await readProjection(journal.value);
    if (!refreshed.ok) return refreshed;
    const ready = workAdmission(refreshed.value);
    if (!ready.ok) return ready;
    if (ready.value !== null) return { ok: true, value: ready.value };
    const scope = await scopeFor(location, refreshed.value.launch, writer, project.value, services);
    if (!scope.ok) return scope;
    const checkpoint = refreshed.value.checkpoints.at(-1);
    if (checkpoint) {
      if (checkpoint.state !== 'safe') return refusal('conflict', 'Quarantined checkpoint cannot execute');
      const stored = await readCheckpoint(journal.value, checkpoint.id);
      if (!stored.ok) return stored;
      const tree = await captureTree(scope.value);
      if (!tree.ok) return tree;
      if (tree.value !== stored.value.tree) {
        const materialized = await materializeCheckpoint(scope.value, writer, stored.value);
        if (!materialized.ok) return materialized;
        const published = await refresh(location, writer);
        void published;
      }
    }
    const ports = services.workflowPorts(scope.value, writer, process, abort);
    const result = await runWorkflow({ writer, scope: scope.value, ports, abort });
    const final = await refresh(location, writer);
    void final; return result;
  };
  return withClaims(execute, claims, () => attentionWriter);
}

function refusal(kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }
async function withClaims<T>(execute: () => Promise<Result<T>>, claims: Claim[], writer: () => Writer | undefined): Promise<Result<T>> {
  let result: Result<T>;
  try { result = await execute(); }
  catch (error) { result = refusal('unknown', error instanceof Error ? error.message : String(error)); }
  const authority = writer();
  const attend = async (claim = false) => {
    if (!authority) return;
    const recorded = await attendRun(authority, result, claim); if (!recorded.ok) result = recorded;
  };
  await attend();
  // Keep the journal writer until all other releases can report an unconfirmed closure.
  const ordered = claims.reverse().sort((a, b) => Number(a.owner.authority === authority?.owner.authority)
    - Number(b.owner.authority === authority?.owner.authority));
  for (const held of ordered) {
    const released = await release(held, 'handoff');
    if (!released.ok) { result = released; await attend(true); }
  }
  return result;
}
async function appendFresh(writer: Writer, payloads: readonly JournalPayload[]): Promise<Result<number>> {
  return appendEvents(writer, null, payloads);
}
async function refresh(location: RunLocation, writer: Writer): Promise<Result<unknown>> {
  const projection = await readProjection(writer.journal);
  return projection.ok ? publishRunStatus(location, new Date().toISOString(), null) : projection;
}
async function scopeFor(location: RunLocation, launch: Launch, writer: Writer, projectClaim: Claim,
  services: RunServices): Promise<Result<ContentScope>> {
  const runtime = await verifyRuntime(location.storeRoot, launch.runtime);
  if (!runtime.ok) return runtime;
  const runtimeRoot = dirname(join(resolve(location.storeRoot), runtime.value.path));
  const configured = parseLaunch({ ...launch, roles: services.configuration.roles });
  if (resolve(services.configRoot) !== join(runtimeRoot, 'config') || !configured.ok || !isDeepStrictEqual(configured.value.roles, launch.roles))
    return refusal('conflict', 'Configuration does not match pinned launch');
  const layout = await validateRecordLayout({ location, project: launch.project, protectedRoots: [writer.journal.root, runtimeRoot,
    ...protectedStatePaths(location.database)], sharedCaches: services.configuration.sharedCaches });
  if (!layout.ok) return layout;
  const events = await readEvents(writer.journal, 0);
  if (!events.ok) return events;
  const authority = events.value.find(event => event.payload.type === 'run_authority')?.payload;
  if (authority?.type !== 'run_authority') return refusal('invalid', 'Missing prepared run authority');
  return {
    ok: true, value: {
      journal: writer.journal, layout: layout.value, brief: launch.brief,
      inputBaseline: launch.setup.inputs, outputBaseline: launch.setup.outputs, projectClaim, git: gitAuthority(location, launch.project),
        authority: authority.authority
    }
  };
}
function entryProgram(location: RunLocation, launch: Launch, services: RunServices): OwnedProgram {
  const runtimeRoot = dirname(join(resolve(location.storeRoot), launch.runtime.path));
  return {
    argv: [process.execPath, join(runtimeRoot, 'cli.js'), 'unit-entry', '--run', location.run, '--unit', JSON.stringify(launch.unit)],
    cwd: launch.project, env: {
      ...services.privateEnvironment, FLOWCREW_STORE_ROOT: resolve(location.storeRoot),
      FLOWCREW_RUNTIME_ROOT: runtimeRoot, FC_HOME: dirname(location.database)
    }, writableRoots: [launch.project, join(resolve(location.storeRoot), 'runs', location.run)]
  };
}
