import { ignoreRetired } from '../contract/retirement.mjs';
import { isDeepStrictEqual } from 'node:util';
import { dispatchableFrontier } from './decisions.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendEvents, readEvents, planStageStates } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { readEvidence } from '../records/evidence.js';
import { validateRecordRef } from '../records/evidence.js';
import { hashInputs, frozenInputsMatch, verifyRuntime } from '../records/content.js';
import { parseBrief, type Id, type Result } from '../contract/brief.js';
import { parsePlan, type AdmittedPlan, type Plan, type Stage } from '../contract/plan.js';
import { parseLaunch, type Launch, type ControlIntent, type RunProjection, type Writer } from '../contract/runtime.js';
import type { ContentScope } from '../records/content.js';

/** Verify exact approved brief/setup/runtime/input identities, and commit admitted+initial plan in one transaction. The initial graph is Launch.plan when given; otherwise the brief's `decompose` declaration selects one ordinary plan stage using explicit plannerRole, and its absence selects the fixed work/gate/repair graph (roles `work` and `gate`; a missing one is refused by id). Never chooses a role by prose or calls a model. Returns invalid/conflict/unavailable/unknown. */
export async function admitLaunch(launch: Launch, plannerRole: Id, writer: Writer, scope: ContentScope): Promise<Result<RunProjection>> {
  const parsed = parseLaunch(launch);
  if (!parsed.ok) return parsed;
  launch = parsed.value;
  if (!launch.roles.some(role => role.id === plannerRole)) return invalid('Unknown explicit planner role');
  if (!same(scope.brief, launch.brief) || scope.layout.location.run !== launch.run || scope.layout.project !== launch.project
    || scope.journal.root !== writer.journal.root || !same(scope.inputBaseline, launch.setup.inputs) || !same(scope.outputBaseline, launch.setup.outputs))
    return invalid('Launch scope differs from approved setup');
  const bytes = await readEvidence(writer.journal, launch.brief.bytes);
  if (!bytes.ok) return bytes;
  if (hash(bytes.value) !== launch.brief.bytes.sha256 || launch.brief.digest !== launch.brief.bytes.sha256) return invalid('Brief digest mismatch');
  const brief = parseBrief(bytes.value);
  if (!brief.ok) return brief;
  if (!same(brief.value, launch.brief.declaration)) return invalid('Brief declaration mismatch');
  const runtime = await verifyRuntime(scope.layout.location.storeRoot, launch.runtime);
  if (!runtime.ok) return runtime;
  if (!same(runtime.value, launch.runtime)) return invalid('Runtime identity mismatch');
  const inputs = await hashInputs(scope);
  if (!inputs.ok) return inputs;
  if (!same(inputs.value, launch.setup.inputs))
    return invalid('Prepared input identities changed');
  for (const ref of [...launch.setup.inputs, ...launch.setup.outputs]) {
    const evidence = await validateRecordRef(writer.journal, ref);
    if (!evidence.ok) return evidence;
  }
  const events = await readEvents(writer.journal, 0);
  if (!events.ok) return events;
  if (events.value.some(event => event.payload.type === 'admitted')) return { ok: false, kind: 'conflict', detail: 'Already admitted' };
  const prepared = events.value.flatMap(event => event.payload.type === 'setup_prepared' ? [event.payload] : []).at(-1);
  if (!prepared || !same(prepared.unit, launch.unit) || !same(prepared.request.brief, launch.brief)
    || prepared.request.target !== launch.project || prepared.request.project !== launch.setup.project || !same(prepared.request.runtime, launch.runtime))
    return invalid('Missing exact setup identity');
  if (!same(prepared.measured, launch.setup)) return invalid('Setup evidence differs from preparation');
  const revision = newId();
  let admitted: AdmittedPlan;
  if (launch.plan || !brief.value.decompose) {
    const checked = await checkPlan(writer.journal, launch.plan ?? fixedPlan(launch), revision, launch, [], [], []);
    if (!checked.ok) return checked;
    admitted = checked.value;
  } else {
    const plan: Plan = { stages: [{ id: newId(), role: plannerRole, purpose: 'plan', after: [],
      instruction: 'Return a revision-bound pending delivery graph for the approved brief.', }] };
    admitted = { plan, revision, digest: hash(JSON.stringify(plan)), executed: [] };
  }
  const committed = await appendEvents(writer, events.value.at(-1)?.seq ?? 0,
    [{ type: 'admitted', launch }, { type: 'plan_committed', plan: admitted }]);
  return committed.ok ? readProjection(writer.journal) : committed;
}

/** Admit a whole pending graph against launch's finite roles/commands/checkpoints and settled history. Normal work is the last gate dependency cone; repair targets outside it are dormant. Require one unique last normal gate covering all ordinary work, no orphan nodes, explicit repair/return, and safe bases. A sole bootstrap plan is the sole no-gate exception. Never judges criterion prose or commits history. Returns invalid/conflict/unavailable/unknown. */
export async function admitPlan(journal: import('../contract/runtime.js').Journal, proposal: Plan, revision: Id, projection: RunProjection, planner?: Id, human?: ControlIntent & {kind:'guide'}): Promise<Result<AdmittedPlan>> {
  proposal = ignoreRetired(proposal, 'plan') as Plan;
  if (human && human.intervention.replacement?.baseRevision !== projection.plan.revision)
    return invalid('Human replacement requires the current plan revision');
  const bootstrap = planner && projection.plan.plan.stages.length === 1 && projection.plan.plan.stages[0].id === planner
    && !projection.launch.plan && projection.revisions.length === 1;
  const boundary = planner && [...projection.transitions].reverse().find(item => item.outcome === 'rejected_repairable'
    && projection.revisions.flatMap(item => item.plan.stages).some(stage => stage.id === item.stage && stage.purpose === 'gate' && stage.repair?.stage === planner));
  if (planner && !bootstrap && !boundary) return invalid(`Planning requires bootstrap or an independent repair return: planner ${planner}`);
  const attempted = new Set(projection.attempts.map(receipt => receipt.address.stage));
  const settled = projection.stageStates.filter(state => (state.state === 'settled' || state.state === 'skipped') && state.stage !== (boundary && boundary.stage)).map(state => state.stage).concat(planner ? [planner] : []);
  const definitions = new Map(projection.revisions.flatMap(item => (ignoreRetired(item.plan, 'plan') as Plan).stages).map(stage => [stage.id, stage]));
  for (const stage of proposal.stages) {
    const previous = definitions.get(stage.id);
    if (previous && !same(previous, stage) && !(human && !attempted.has(stage.id)) && !(boundary && stage.id === boundary.stage && stage.purpose === 'gate' && previous.purpose === 'gate'
      && same({ ...previous, after: stage.after }, stage))) return invalid(`Admitted stage definition is frozen; only unattempted operator replacements or rejecting-gate dependencies may change: ${stage.id}`);
    if (previous && !projection.plan.plan.stages.some(current => current.id === stage.id) && !attempted.has(stage.id))
      return invalid(`Retired stage identity reused: ${stage.id}`);
  }
  // A human replacement retires omitted pending requests. Their immutable
  // definitions/receipts remain in revisions/history, not in the executable graph.
  const retained = [...definitions.values()].filter(stage => (attempted.has(stage.id) && !human || settled.includes(stage.id)) && !proposal.stages.some(next => next.id === stage.id));
  // Immutable visited definitions may still refer to dormant repair nodes removed from the pending suffix.
  for (const stage of retained) for (const id of [...stage.after, ...(stage.purpose === 'gate' && stage.repair ? [stage.repair.stage] : [])]) {
    const dependency = definitions.get(id);
    if (dependency && !retained.some(item => item.id === id) && !proposal.stages.some(item => item.id === id)) retained.push(dependency);
  }
  const checked = await checkPlan(journal, proposal, revision, projection.launch, projection.checkpoints, settled, retained);
  if (!checked.ok) return checked;
  for (const transition of projection.transitions) if (transition.outcome === 'rejected_repairable') {
    const resolved = projection.transitions.some(next => next.stage === transition.stage && next.attempt !== transition.attempt
      && projection.attempts.findIndex(receipt => receipt.address.attempt === next.attempt) > projection.attempts.findIndex(receipt => receipt.address.attempt === transition.attempt));
    const gate = definitions.get(transition.stage);
    const next = [...retained, ...proposal.stages].find(stage => stage.id === transition.stage);
    if (!resolved && (!gate || gate.purpose !== 'gate' || !next || next.purpose !== 'gate' || !same(gate.repair, next.repair)))
      return invalid(`Outstanding repair return removed: gate ${transition.stage}, repair ${gate?.purpose === 'gate' ? gate.repair?.stage : 'unknown'}`);
  }
  const admitted = { ...checked.value, executed: projection.attempts.flatMap(receipt => receipt.answerRef ? [receipt.answerRef] : []) };
  // Ask the execution owner about the candidate revision before publishing it.
  const frontier = dispatchableFrontier({ ...projection, status: 'running', conclusion: undefined,
    plan: admitted, revisions: [...projection.revisions, admitted],
    stageStates: planStageStates(projection.stageStates.map(state => state.stage === planner
      ? {...state,state:'settled' as const} : state),admitted) });
  return frontier.ok ? { ok: true, value: admitted } : frontier;
}

/** The default graph for a brief that does not declare decomposition: one author, one independent gate over the required commands, and one repair stage the gate returns to. The roles are the configured roles whose ids are `work` and `gate`; a missing one is refused by `checkPlan`, which names the id. Nothing here is written by a model. Non-required declared commands stay available to the author and the gate without being run. */
export function fixedPlan(launch: Launch): Plan {
  return { stages: [
    { id: 'work', role: 'work', purpose: 'work', after: [], instruction: 'Deliver the whole brief.' },
    { id: 'gate', role: 'gate', purpose: 'gate', after: ['work'], commands: launch.brief.declaration.commands.filter(command => command.required).map(command => command.id),
      repair: { stage: 'repair', returnsTo: 'gate' } },
    { id: 'repair', role: 'work', purpose: 'work', after: [],
      instruction: 'Fix every finding of the gate\'s latest rejection, which is in the admitted evidence, then verify the changed outcome.' },
  ] };
}

async function checkPlan(journal: import('../contract/runtime.js').Journal, proposal: Plan, revision: Id, launch: Launch, checkpoints: RunProjection['checkpoints'], settled: readonly Id[], retained: readonly Stage[]): Promise<Result<AdmittedPlan>> {
  if (proposal.stages.some(stage => settled.includes(stage.id))) return invalid(`Pending suffix redefines settled stage: ${proposal.stages.filter(stage => settled.includes(stage.id)).map(stage => stage.id).join(', ')}`);
  const combined: Plan = { ...proposal, stages: [...retained, ...proposal.stages] };
  const checkpointIds: Id[] = [];
  for (const checkpoint of checkpoints) if (checkpoint.state === 'safe' && checkpoint.brief === launch.brief.digest
    && await frozenInputsMatch(journal, launch.brief, checkpoint.inputHashes, launch.setup.inputs)) checkpointIds.push(checkpoint.id);
  const parsed = parsePlan(combined, { roleIds: launch.roles.map(role => role.id), commandIds: launch.brief.declaration.commands.map(command => command.id),
    checkpointIds, settledStageIds: [] });
  if (!parsed.ok) return parsed;
  const stages = new Map([...retained, ...parsed.value.stages].map(stage => [stage.id, stage]));
  const ancestors = (id: Id, seen = new Set<Id>()): Set<Id> => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const parent of stages.get(id)?.after ?? []) ancestors(parent, seen);
    return seen;
  };
  const gates = [...stages.values()].filter(stage => stage.purpose === 'gate');
  const last = gates.filter(gate => !gates.some(other => other.id !== gate.id && ancestors(other.id).has(gate.id)));
  if (last.length !== 1) return invalid(`Graph requires one unique last delivery gate: last gates [${last.map(gate => gate.id).join(', ')}]; stages [${[...stages.keys()].join(', ')}]`);
  const normal = ancestors(last[0].id);
  const repairPlanners = new Set(gates.flatMap(gate => gate.purpose === 'gate' && gate.repair ? [gate.repair.stage] : []));
  if ([...stages.values()].some(stage => stage.purpose === 'plan' && !settled.includes(stage.id)
    && (normal.has(stage.id) || !repairPlanners.has(stage.id))))
    return invalid(`Pending planners require an independent repair boundary: ${[...stages.values()].filter(stage => stage.purpose === 'plan' && !settled.includes(stage.id) && (normal.has(stage.id) || !repairPlanners.has(stage.id))).map(stage => stage.id).join(', ')}`);
  const accounted = new Set([...normal, ...retained.map(stage => stage.id)]);
  for (const gate of gates) if (normal.has(gate.id) && gate.purpose === 'gate' && gate.repair)
    for (const id of ancestors(gate.repair.stage)) accounted.add(id);
  if ([...stages.keys()].some(id => !accounted.has(id))) return invalid(`Orphan stage outside delivery or repair cone: ${[...stages.keys()].filter(id => !accounted.has(id)).join(', ')}`);
  return { ok: true, value: { plan: parsed.value, revision, digest: hash(JSON.stringify(parsed.value)), executed: [] } };
}
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function newId(): Id { return `r_${randomUUID()}`; }
function invalid(detail: string): Result<never> { return { ok: false, kind: 'invalid', detail }; }
