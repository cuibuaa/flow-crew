import { putEvidence } from '../records/state.js';
import { reconcileRun, attendRun } from './reconcile.js';
import { protectedStatePaths } from '../records/state.js';
import { claim, release, workAdmission, nextLifecycle, isFinal, acceptsGuidance, pendingReceipts, reservationOpen } from '../records/state.js';
import { gitAuthority } from '../records/content.js';
import { resolve, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JournalPayload, RunProjection, OwnedProgram } from '../contract/runtime.js';
import { idSchema } from '../contract/brief.js';
import { observeRun, startRun, isUnconfirmedClosure, type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { readProjection, recordHeldBytes } from '../records/state.js';
import { validateRecordRef } from '../records/evidence.js';
import { validateRecordLayout } from '../records/content.js';
import { frozenInputsMatch, hashInputs, readCheckpoint, materializeCheckpoint, captureTree } from '../records/content.js';
import { randomUUID } from 'node:crypto';
import { parsePlan, type AdmittedPlan } from '../contract/plan.js';
import { admitLaunch, admitPlan } from '../core/admission.js';
import { reconstructBackstop } from '../core/retry.js';
import { runWorkflow } from '../core/loop.js';
import { publishRunStatus } from './status.js';
import type { Result } from '../contract/brief.js';
import { parseControlIntent, parseOperation, parseRunObservation, type Conclusion, type ControlIntent, type Launch, type Operation,
  type RunLocation, type RuntimeConfig, type RunRef, type Journal, type Writer } from '../contract/runtime.js';
import type { ExecutionContext } from '../exec/attempt.js';
import type { TransportContext } from '../exec/transport.js';
import type { ProcessPorts, ProcessPortsFactory, RunContext } from '../host/process.js';
import type { ContentScope } from '../records/content.js';
import type { WorkflowPorts, WorkflowRequest } from '../core/loop.js';

/**  Explicit addressed short command. */
export type RunOperationRequest = {
  readonly location: RunLocation;
} & (
    { readonly intent: ControlIntent & { readonly kind: 'start' | 'cancel' | 'resume' | 'status' | 'guide' } }
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
  return underControl(location, intent.unit, async ({ journal, writer, claims }) => {
    const process = services.process(writer);
    const events = await readEvents(journal, 0);
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
    // A run is started once: a later start is a conflict, the control for a started run is resume.
    if (intent.kind === 'start' && events.value.some(event => event.payload.type === 'control_intent' && event.payload.intent.kind === 'start'))
      return refusal('conflict', 'Run already started; use status, resume or cancel');
    const current = await readProjection(journal);
    if (!current.ok) return current;
    let projection = current.value;
    if (!isDeepStrictEqual(projection.launch.unit, intent.unit)) return refusal('conflict', 'Pinned unit mismatch');
    const ended = isFinal(projection.status);
    // The one way a recorded run is launched: `start` is a run's first launch, `resume` a later one, and both answer to the same rules.
    if (intent.kind === 'start' || intent.kind === 'resume') {
      if (nextLifecycle(projection.status, 'resume') === null || projection.intents.some(i => i.kind === 'cancel'))
        return refusal('conflict', 'Terminal or cancelled runs cannot be started or resumed');
      const running = await observeRun(intent.unit, services.unitContext);
      if (!running.ok) return running;
      if (running.value.state === 'active' && projection.status === 'parked')
        return refusal('conflict', 'The prior activation is still closing; wait for it to finish before resuming');
      if (running.value.state === 'active') return parseOperation({ intent, state: 'acknowledged', cursor: projection.cursor,
        observation: running.value, evidence: running.value.evidence, detail: 'Already running' });
      const scope = await claimScope(location, projection.launch, { writer, claims }, services);
      if (!scope.ok) return scope;
      const inputs = await hashInputs(scope.value);
      if (!inputs.ok) return inputs;
      if (!await frozenInputsMatch(journal, projection.brief, inputs.value, projection.launch.setup.inputs)) return refusal('conflict', 'Frozen input identity changed');
      const closed = await reconcileRun(writer, process, services.unitContext, claims, false);
      if (!closed.ok) return closed;
      const reconciled = await readProjection(journal); if (!reconciled.ok) return reconciled;
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
      const content = await validateRecordRef(journal, intent.intervention.content);
      if (!content.ok) return content;
      const observation = await observeRun(intent.unit, services.unitContext);
      if (!observation.ok) return observation;
      if (observation.value.state === 'inactive') {
        const reconciled = await reconcileRun(writer, process, services.unitContext, claims, false);
        if (!reconciled.ok) return reconciled;
        const fresh = await readProjection(journal); if (!fresh.ok) return fresh;
        projection = fresh.value;
      }
    }
    if (intent.kind === 'guide' && intent.intervention.replacement) {
      if (projection.reservations.some(reservationOpen) || projection.invocations.some(item => item.charge !== 'command' && item.address.kind === 'stage'
        && !projection.closedInvocations.some(closed => isDeepStrictEqual(closed, item)) && !projection.attempts.some(receipt =>
          isDeepStrictEqual({ kind: 'stage', ...receipt.address }, item.address)))) return refusal('conflict',
            'Wait for the current step to finish or for the run to park');
      const proposed = parsePlan(intent.intervention.replacement.plan, {
        roleIds: projection.launch.roles.map(item => item.id),
        commandIds: projection.brief.declaration.commands.map(item => item.id),
          checkpointIds: projection.checkpoints.filter(item => item.state === 'safe').map(item => item.id),
        settledStageIds: projection.stageStates.filter(item => item.state === 'settled').map(item => item.stage)
      });
      if (!proposed.ok) return proposed;
      const admitted = await admitPlan(writer.journal, proposed.value, 'revision_' + randomUUID(), projection, undefined, intent);
      if (!admitted.ok) return admitted;
      replacement = admitted.value;
    }
    // The original pre-admission boundary stays in the intent; CAS uses refreshed journal facts.
    const appended = existing ? { ok: true as const, value: existing.seq } : await appendEvents(writer, replacement ? projection.cursor : null, [{ type: 'control_intent', intent }, ...(replacement ? [{ type: 'plan_committed' as const,
      plan: replacement }] : [])]);
    if (!appended.ok) return appended;
    const firstRefresh = await refresh(location, writer);
    void firstRefresh;
    let observation: Operation['observation'] = null;
    let state: Operation['state'] = 'acknowledged';
    let detail = 'Intent committed';
    let hostFailure: unknown;
    if (intent.kind === 'start' || intent.kind === 'resume' || intent.kind === 'cancel') {
      if (intent.kind === 'start' || intent.kind === 'resume') {
        for (let index = claims.length - 1; index >= 0; index--) if (claims[index].resource === resolve(projection.launch.project)) {
          const handed = await release(claims[index]);
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
          : intent.kind === 'cancel' ? 'acknowledged'
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
  });
}

/** Commit the one launch record (admission plus its initial plan, decided earlier by `initialPlan`) for a prepared run. Nothing starts: the run is `pending` until a start intent. */
export async function admitRun(location: RunLocation, launch: Launch, plan: AdmittedPlan, services: RunServices): Promise<Result<RunProjection>> {
  return underControl(location, launch.unit, async ({ writer, claims }) => {
    const scope = await claimScope(location, launch, { writer, claims }, services);
    if (!scope.ok) return scope;
    return admitLaunch(launch, plan, writer, scope.value);
  });
}

/** The one way an operation takes a run's control claim and journal writer; `body` borrows `claims` for what it takes in turn, and all are released after. */
export async function underControl<T>(location: RunLocation, unit: RunRef | null, body: (control: { journal: Journal; writer: Writer; claims: Claim[] }) => Promise<Result<T>>): Promise<Result<T>> {
  const claims: Claim[] = [];
  let attentionWriter: Writer | undefined;
  return withClaims(async () => {
    const holder = join(resolve(location.storeRoot), 'runs', location.run);
    const control = await claim(join(holder, 'control'), unit, { database: location.database, holder });
    if (!control.ok) return control;
    claims.push(control.value);
    const journal = await openJournal(location, 'read');
    if (!journal.ok) return journal;
    const opened = await openWriter(journal.value, control.value, 'control');
    if (!opened.ok) return opened;
    attentionWriter = opened.value;
    return body({ journal: journal.value, writer: opened.value, claims });
  }, claims, () => attentionWriter);
}
/** The run's copy, claimed for this operation, with the content scope every check over it uses. */
async function claimScope(location: RunLocation, launch: Launch, control: { writer: Writer; claims: Claim[] }, services: RunServices): Promise<Result<ContentScope>> {
  const project = await claim(resolve(launch.project), launch.unit, { database: location.database, holder: join(resolve(location.storeRoot), 'runs', location.run) });
  if (!project.ok) return project;
  control.claims.push(project.value);
  return scopeFor(location, launch, control.writer, project.value, services);
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
      const released = await release(held.value); if (!released.ok) return released; if (!recovered.ok) return recovered;
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
    // Only an admitted activation owns a fatal outcome; refused controls/predecessors do not.
    const prepare = async (): Promise<Result<WorkflowRequest>> => {
      const scope = await scopeFor(location, refreshed.value.launch, writer, project.value, services);
      if (!scope.ok) return scope;
      const checkpoint = refreshed.value.restoring
        ? refreshed.value.checkpoints.find(item => item.id === refreshed.value.restoring)
        : refreshed.value.checkpoints.at(-1);
      const pendingSettlement = pendingReceipts(refreshed.value).length > 0;
      if (checkpoint && (!pendingSettlement || refreshed.value.restoring)) {
        if (checkpoint.state !== 'safe') return refusal('conflict', 'Quarantined checkpoint cannot execute');
        const stored = await readCheckpoint(journal.value, checkpoint.id);
        if (!stored.ok) return stored;
        const tree = await captureTree(scope.value);
        if (!tree.ok) return tree;
        if (refreshed.value.restoring || tree.value !== stored.value.tree) {
          const materialized = await materializeCheckpoint(scope.value, writer, stored.value);
          if (!materialized.ok) return materialized;
          const published = await refresh(location, writer);
          void published;
        }
      }
      const ports = services.workflowPorts(scope.value, writer, process, abort);
      return {ok:true,value:{writer,scope:scope.value,ports,abort}};
    };
    let prepared: Result<WorkflowRequest>;
    try { prepared = await prepare(); }
    catch (error) { prepared = refusal('unknown', error instanceof Error ? error.message : String(error)); }
    let result: Result<Conclusion>;
    try { result = prepared.ok ? await runWorkflow(prepared.value) : prepared; }
    catch (error) { result = refusal('unknown', error instanceof Error ? error.message : String(error)); }
    if (!result.ok && !isUnconfirmedClosure(result)) {
      const current = await readProjection(journal.value); if (!current.ok) return current;
      if (!isFinal(current.value.status)) {
        const diagnostic = await putEvidence(writer.journal, Buffer.from(JSON.stringify({ refusal: result })));
        if (!diagnostic.ok) return diagnostic;
        const recorded = await appendEvents(writer, null, [{ type: 'lifecycle', conclusion: {
          status: 'parked', reason: 'recovery_unknown', detail: `${result.kind}: ${result.detail}; diagnostic ${diagnostic.value.path}`,
          ...(!prepared.ok && refreshed.value.intents.filter(intent => intent.kind === 'start' || intent.kind === 'resume').at(-1)?.kind === 'resume'
            ? {cause:'resume_refused' as const} : {})
        } }]);
        if (!recorded.ok) return recorded;
      }
    }
    return result;
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
  if (authority?.kind === 'execution') await recordHeldBytes(authority);
  // Keep the journal writer until all other releases can report an unconfirmed closure.
  const ordered = claims.reverse().sort((a, b) => Number(a.owner.authority === authority?.owner.authority)
    - Number(b.owner.authority === authority?.owner.authority));
  for (const held of ordered) {
    const released = await release(held);
    if (!released.ok) { result = released; await attend(true); }
  }
  if (authority) publishRunStatus({ database: authority.journal.database,
    storeRoot: dirname(dirname(authority.journal.root)), run: authority.journal.root.split('/').at(-1)! }, new Date().toISOString(), null);
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
  const runtimeRoot = dirname(join(resolve(location.storeRoot), launch.runtime.path));
  if (resolve(services.configRoot) !== join(runtimeRoot, 'config') || !isDeepStrictEqual(services.configuration.roles, launch.roles))
    return refusal('conflict', 'Configuration does not match pinned launch');
  const layout = await validateRecordLayout({ location, project: launch.project, protectedRoots: [writer.journal.root, runtimeRoot,
    ...protectedStatePaths(location.database)] });
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
    // The controller must outlive replacement of the mutable project root.
    cwd: join(resolve(location.storeRoot), 'runs', location.run), env: {
      ...services.privateEnvironment, FLOWCREW_STORE_ROOT: resolve(location.storeRoot),
      FLOWCREW_RUNTIME_ROOT: runtimeRoot, FC_HOME: dirname(location.database)
    }
  };
}
