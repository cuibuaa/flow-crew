import { reservationOpen, nextLifecycle } from '../records/state.js';
import { isDeepStrictEqual } from 'node:util';
import { answerSchema, type AnswerContext } from '../contract/answers.js';
import type { Result } from '../contract/brief.js';
import type { Stage } from '../contract/plan.js';
import { type Checkpoint, type CommandReceipt, type Conclusion, type GateTransition, type OutputReceipt, type RunProjection } from '../contract/runtime.js';

/** One common-loop next result based only on admitted dependencies and typed facts; never encodes a research/engineering branch. Refusals use Result; unknown/parked facts never become completion. */
export type Next =
  | { readonly kind: 'stage'; readonly stage: Stage; readonly context: AnswerContext }
  | { readonly kind: 'transition'; readonly transition: GateTransition }
  | { readonly kind: 'publication'; readonly checkpoint: Checkpoint }
  | { readonly kind: 'stop'; readonly conclusion: Conclusion };

/** Select one serial frontier/explicit repair-return transition or delivery boundary. Derive AnswerContext.final only for the unique last normal gate, false for all other gates; Dedicated repair targets outside the normal dependency cone remain dormant until routed; normal ancestor targets may be explicitly revisited by repair. Never inspects narrative, command scores or overrides current gate outcome. Returns invalid/conflict/unknown for inconsistent/uncertain replay. */
export function decideNext(projection: RunProjection): Result<Next> {
  if (projection.status === 'cancelled' || projection.intents.some(intent => intent.kind === 'cancel'))
    return ok({ kind: 'stop', conclusion: conclusion('cancelled', 'cancelled') });
  if (projection.conclusion && nextLifecycle(projection.status, 'run') === null) return ok({ kind: 'stop', conclusion: projection.conclusion });
  if (projection.reservations.some(reservationOpen) || projection.attempts.some(receipt => receipt.closure !== 'dead'))
    return { ok: false, kind: 'unknown', detail: 'Unresolved execution facts' };
  const stages = effectiveStages(projection);
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const depends = (id: string, ancestor: string, seen = new Set<string>()): boolean => {
    if (id === ancestor) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.after ?? []).some(parent => depends(parent, ancestor, seen));
  };
  const gates = stages.filter(stage => stage.purpose === 'gate');
  const last = gates.filter(gate => !gates.some(other => other.id !== gate.id && depends(other.id, gate.id)));
  const bootstrap = gates.length === 0 && stages.length === 1 && stages[0].purpose === 'plan' && projection.revisions.length === 1 && !projection.launch.plan;
  if (!bootstrap && last.length !== 1) return invalid('No unique delivery gate');
  const latest = (id: string) => projection.attempts.filter(receipt => receipt.address.stage === id).at(-1);
  const settled = (id: string): boolean => {
    const stage = byId.get(id);
    if (!projection.stageStates.some(state => state.stage === id && (state.state === 'settled' || state.state === 'skipped'))) return false;
    if (stage?.purpose !== 'gate') return true;
    const receipt = latest(id);
    return !!receipt && projection.transitions.some(item => item.stage === id && item.attempt === receipt.address.attempt
      && (item.outcome === 'accepted' || item.outcome === 'accepted_blocked'));
  };
  const context = (stage: Stage): AnswerContext => ({ purpose: stage.purpose, final: stage.id === last[0]?.id,
    revision: projection.plan.revision, roleIds: projection.launch.roles.map(role => role.id),
    commandIds: projection.brief.declaration.commands.map(command => command.id), checkpointIds: projection.checkpoints.filter(item => item.state === 'safe').map(item => item.id),
    criterionIds: projection.brief.declaration.criteria.map(item => item.id), resultIds: projection.brief.declaration.results.map(item => item.id),
    allowBlocked: projection.brief.declaration.allowBlocked,
    settledStageIds: [...new Set([...projection.stageStates.filter(item => settled(item.stage)).map(item => item.stage),
      ...(stage.purpose === 'plan' ? [stage.id] : [])])] });
  const select = (stage: Stage): Result<Next> => ok({ kind: 'stage', stage, context: context(stage) });
  const pairs = projection.transitions.map(item => JSON.stringify([item.stage, item.attempt]));
  if (new Set(pairs).size !== pairs.length) return invalid('Duplicate gate transition attempt');
  // A committed rejection is an outstanding return obligation until a newer delivered gate visit.
  for (const transition of [...projection.transitions].reverse()) {
    if (transition.outcome !== 'rejected_repairable') continue;
    const gate = byId.get(transition.stage);
    if (!gate || gate.purpose !== 'gate' || !gate.repair || transition.next !== gate.repair.stage) return invalid('Missing explicit repair return');
    const rejectedIndex = projection.attempts.findIndex(receipt => receipt.address.stage === gate.id && receipt.address.attempt === transition.attempt);
    if (rejectedIndex < 0) return invalid('Transition has no gate receipt');
    const newerGate = projection.attempts.slice(rejectedIndex + 1).some(receipt => receipt.address.stage === gate.id && receipt.ending === 'delivered');
    if (newerGate) continue;
    const repair = byId.get(gate.repair.stage);
    if (!repair || repair.purpose === 'gate') return invalid('Missing admitted repair target');
    const repaired = projection.attempts.slice(rejectedIndex + 1).some(receipt => receipt.address.stage === repair.id && receipt.ending === 'delivered');
    if (repaired) {
      const pending = stages.find(stage => stage.id !== gate.id && depends(gate.id, stage.id)
        && !projection.stageStates.some(state => state.stage === stage.id && (state.state === 'settled' || state.state === 'skipped'))
        && stage.after.every(parent => projection.stageStates.some(state => state.stage === parent && state.state === 'settled')));
      return select(pending ?? gate);
    }
    // Dependencies of dormant repair targets are ordinary admitted work, never inferred steps.
    const needed = stages.find(stage => depends(repair.id, stage.id) && stage.id !== repair.id
      && !projection.stageStates.some(state => state.stage === stage.id && (state.state === 'settled' || state.state === 'skipped'))
      && stage.after.every(parent => projection.stageStates.some(state => state.stage === parent && state.state === 'settled')));
    return select(needed ?? repair);
  }
  for (const gate of gates) {
    const receipt = latest(gate.id);
    if (!receipt || receipt.ending !== 'delivered') continue;
    if (receipt.answer?.kind !== 'gate' || !receipt.answerRef) return invalid('Delivered gate lacks authenticated answer');
    const parsed = answerSchema(context(gate)).parse(receipt.answer);
    if (!parsed.ok) return parsed;
    const outcome = receipt.answer.answer.outcome;
    const applied = projection.transitions.find(item => item.stage === gate.id && item.attempt === receipt.address.attempt);
    if (applied && applied.outcome !== outcome) return invalid('Transition contradicts gate answer');
    if (!applied) {
      if (outcome === 'rejected_repairable' && !gate.repair) return ok({ kind: 'stop', conclusion: conclusion('failed', 'gate_irreparable', receipt.answerRef) });
      return ok({ kind: 'transition', transition: { type: 'gate_transition', stage: gate.id, attempt: receipt.address.attempt,
        outcome, next: outcome === 'rejected_repairable' ? gate.repair!.stage : null, evidence: [receipt.answerRef] } });
    }
    if (outcome === 'rejected_irreparable') return ok({ kind: 'stop', conclusion: conclusion('failed', 'gate_irreparable', receipt.answerRef) });
  }
  const normal = bootstrap ? stages : stages.filter(stage => depends(last[0].id, stage.id));
  const frontier = normal.find(stage => !settled(stage.id) && stage.after.every(settled));
  if (frontier) return select(frontier);
  if (bootstrap) return { ok: false, kind: 'conflict', detail: 'Settled bootstrap requires revision consumption' };
  if (normal.some(stage => !settled(stage.id))) return invalid('Blocked dependency frontier');
  const gateReceipt = latest(last[0].id);
  const checkpoint = projection.checkpoints.find(item => gateReceipt && same(item.address, gateReceipt.address));
  if (!checkpoint || checkpoint.state !== 'safe') return invalid('No safe delivery checkpoint');
  return ok({ kind: 'publication', checkpoint });
}

/** Decide final lifecycle from last full-brief gate bound to selected safe tree, no pending normal work, all required complete-zero source-bound command keys, and preserved output bytes. Labels are membership only; diagnostics cannot veto the gate. Never runs commands or infers success from text. Returns complete/accepted_blocked or exact incomplete/failed Conclusion, and invalid/conflict/unknown for unsafe facts. */
export function decidePublication(projection: RunProjection, checkpoint: Checkpoint, outputs: OutputReceipt): Result<Conclusion> {
  const next = decideNext(projection);
  if (!next.ok) return next;
  if (next.value.kind === 'stop') return ok(next.value.conclusion);
  if (next.value.kind !== 'publication' || !same(next.value.checkpoint, checkpoint)
    || checkpoint.state !== 'safe' || checkpoint.brief !== projection.brief.digest || !same(checkpoint.inputHashes, projection.launch.setup.inputs))
    return invalid('Publication requires the current gate and selected safe delivery tree');
  const receipt = projection.attempts.find(item => same(item.address, checkpoint.address));
  if (!receipt || receipt.answer?.kind !== 'gate' || !receipt.answerRef || receipt.after !== checkpoint.tree || receipt.before !== receipt.after)
    return invalid('Gate is not bound to delivery tree');
  const gate = receipt.answer.answer;
  if (gate.outcome !== 'accepted' && gate.outcome !== 'accepted_blocked') return invalid('Gate did not accept');
  if (projection.checkpoints.at(-1)?.tree !== checkpoint.tree) return invalid('Tree changed after selected gate');
  const commandFailure = commandEvidenceFailure(projection, checkpoint, gate);
  if (commandFailure) return ok(conclusion('incomplete', commandFailure, receipt.answerRef));
  if (!outputs.preserved) return ok(conclusion('incomplete', 'outputs_unpreserved', receipt.answerRef));
  return ok(conclusion(gate.outcome === 'accepted' ? 'complete' : 'accepted_blocked',
    gate.outcome === 'accepted' ? 'completed' : 'accepted_blocked', receipt.answerRef));
}

/** The same direct-result/source floor admits effective passes and final publication. */
export function commandEvidenceFailure(projection: RunProjection, checkpoint: Checkpoint, gate: import('../contract/answers.js').GateAnswer): Conclusion['reason'] | null {
  for (const command of projection.brief.declaration.commands.filter(item => item.required)) {
    const measured = projection.commands.filter(item => item.command === command.id).at(-1);
    if (!measured) return 'command_missing';
    const attested = gate.commandEvidence?.find(item => item.command === command.id);
    const executions = projection.commands.filter(item => item.command === command.id).map(item => item.key.context);
    const committed = projection.reservations.some(item => item.state === 'committed' && same(item.receipt, measured) && same(item.key, measured.key));
    if (!committed || !attested || attested.context !== measured.key.context || !same(attested.executions, executions)
      || !commandApplicable(projection, measured, checkpoint)) return 'command_missing';
    if (measured.execution.state !== 'complete') return 'command_unfinished';
    if (measured.execution.exit !== 0) return 'command_nonzero';
  }
  return null;
}

/** No author/product exemption: a read-and-produced path remains an observed prerequisite. */
export function commandApplicable(projection: RunProjection, receipt: CommandReceipt, checkpoint: Checkpoint): boolean {
  const relation = receipt.key.observation;
  const declared = projection.brief.declaration.commands.find(item => item.id === receipt.command);
  if (!receipt.key.generation || receipt.key.generation.sha256 !== receipt.before || !relation || !declared || relation.command !== declared.id || !relation.criterionIds.length
    || relation.criterionIds.some(id => !projection.brief.declaration.criteria.some(item => item.id === id))
    || declared.inputs.some(id => !relation.sources.includes(projection.brief.declaration.inputs.find(item => item.id === id)!.path))) return false;
  const start = projection.lineage.findIndex(item => item.kind === 'command' && same(item.receipt, receipt));
  const end = projection.lineage.findIndex(item => item.kind === 'checkpoint' && item.checkpoint.id === checkpoint.id);
  if (start < 0 || end <= start) return false;
  const baseline = new Map(receipt.observed.before.map(item => [item.path, item.identity]));
  const matches = (observed: readonly {path: string; identity: unknown}[]) => relation.sources.every(path => baseline.has(path)
    && same(baseline.get(path), observed.find(item => item.path === path)?.identity));
  if (!matches(receipt.observed.after)) return false;
  return projection.lineage.slice(start + 1, end + 1).every(item => item.kind === 'checkpoint'
    ? matches(item.checkpoint.observed ?? []) : matches(item.receipt.observed.before) && matches(item.receipt.observed.after));
}

function effectiveStages(projection: RunProjection): Stage[] {
  const attempted = new Set(projection.attempts.map(receipt => receipt.address.stage));
  const history = new Map(projection.revisions.flatMap(revision => revision.plan.stages).map(stage => [stage.id, stage]));
  const stages = new Map([...history.values()].filter(stage => attempted.has(stage.id)).map(stage => [stage.id, stage]));
  for (const stage of projection.plan.plan.stages) stages.set(stage.id, stage);
  for (const stage of stages.values()) for (const id of [...stage.after, ...(stage.purpose === 'gate' && stage.repair ? [stage.repair.stage] : [])]) {
    const previous = history.get(id);
    if (!stages.has(id) && previous) stages.set(id, previous);
  }
  return [...stages.values()];
}
function conclusion(status: Conclusion['status'], reason: Conclusion['reason'], authoredGate?: Conclusion['authoredGate']): Conclusion {
  return { status, reason, detail: reason, ...(authoredGate ? { authoredGate } : {}) };
}
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function ok<T>(value: T): Result<T> { return { ok: true, value }; }
function invalid(detail: string): Result<never> { return { ok: false, kind: 'invalid', detail }; }
