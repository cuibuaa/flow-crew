import { commandDeclarationIdentity } from '../exec/command.js';
import { commandContext } from '../exec/policy.js';
import { readEvents } from '../records/state.js';
import { changedTreePaths, frozenInputsMatch } from '../records/content.js';
import { nextLifecycle, reservationOpen, attemptOpen, pendingGuidance } from '../records/state.js';
import { isDeepStrictEqual } from 'node:util';
import type { AnswerContext } from '../contract/answers.js';
import type { DeclaredCommand, Hash, Result } from '../contract/brief.js';
import type { Stage } from '../contract/plan.js';
import { commandBasis, commandEvidenceLabel, currentCommandReceipts, type AttemptReceipt, type BaseRun, type Checkpoint, type CommandReceipt, type CommandReuse, type Journal, type Conclusion, type GateTransition, type OutputReceipt, type RunProjection } from '../contract/runtime.js';

/** One common-loop next result based only on admitted dependencies and typed facts; never encodes a research/engineering branch. Refusals use Result; unknown/parked facts never become completion. */
export type Next =
  | { readonly kind: 'stage'; readonly stage: Stage; readonly context: AnswerContext }
  | { readonly kind: 'transition'; readonly transition: GateTransition }
  | { readonly kind: 'publication'; readonly checkpoint: Checkpoint }
  | { readonly kind: 'stop'; readonly conclusion: Conclusion };

type CommandFailure = { readonly reason: 'command_missing' | 'command_unfinished' | 'command_nonzero'; readonly detail: string };
type RequiredCommandResult =
  | ({ readonly kind: 'satisfied'; readonly dependencyIntersection: readonly [] } & CommandReuse)
  | { readonly kind: 'run'; readonly failure: CommandFailure; readonly evidence?: CommandReuse };

/** What a required command's result is compared with: the delivered/current tree and the input identities recorded beside it. */
type Target = Pick<Checkpoint, 'tree' | 'inputHashes'>;

/** What a stored base run says, from the stored data alone (its exit included, so it does not depend on its caller's filtering):
 * `passes on the base tree` / `fails on the base tree too` for a complete run, otherwise `base run did not complete: ` followed by
 * `<state>: <reason>` and the stored detail (a), or `<kind>: <detail>` (b, c). */
export const baseConclusion = (base: BaseRun) => {
  const ended = base.ok ? base.execution : undefined;
  if (ended?.state === 'complete') return ended.exit === 0 ? 'passes on the base tree' : 'fails on the base tree too';
  const text = base.ok ? [`${ended!.state}: ${ended!.reason}`, base.refusal && `${base.refusal.kind}: ${base.refusal.detail}`, base.detail]
    : [base.kind, base.detail];
  return `base run did not complete: ${text.filter(Boolean).join(': ')}`;
};

/** The reuse rule for any declared command, required or not. The latest reservation decides; the receipt's key (declared inputs included) must still describe the target.
 * Undeclared commands depend on every author change: they count only while command executions alone lead to the target.
 * Declared commands count while the Git diff to the target misses their dependencies. Unknown history or diff runs. */
export async function requiredCommandResult(journal: Journal, projection: RunProjection, command: DeclaredCommand,
  target: Target): Promise<RequiredCommandResult> {
  const latest = projection.reservations.findLast(item => item.identity === command.id);
  let run: Extract<RequiredCommandResult,{kind:'run'}> = {kind:'run', failure:latest && latest.state !== 'committed'
    ? {reason:'command_unfinished' as const,detail:`interrupted request ${JSON.stringify(latest.invocation.address)} (${latest.state}); effect remains unknown`}
    : {reason:'command_missing' as const,detail:'missing applicable committed receipt for delivery tree'}};
  if (!latest || latest.state !== 'committed' || projection.restoring || projection.reclaimed) return run;
  // state.ts:41-47 and :613-617 already bind this receipt to the reservation's identity and key.
  const receipt = latest.receipt;
  if (receipt.key.declaration !== commandDeclarationIdentity(command)
    || latest.invocation.address.kind !== 'stage' || receipt.key.generation?.sha256 !== receipt.before) return run;
  if (receipt.after === undefined) return {...run,failure:{reason:'command_unfinished',detail:`outputs not pinned: ${receipt.unpinned?.detail}`}};
  const sourceAddress = latest.invocation.address;
  const {stage, attempt, invocation} = sourceAddress;
  const evidence: CommandReuse = {receipt,sourceTree:receipt.after,source:{stage,attempt,invocation}};
  run = {...run,evidence};
  try {
    const events = await readEvents(journal, 0);
    if (!events.ok) return run;
    const window = events.value.filter(event => event.seq <= projection.cursor);
    const start = window.findIndex(event => event.payload.type === 'command' && same(event.payload.receipt, receipt));
    if (start < 0 || !projection.plan.plan.stages.some(stage => stage.id === sourceAddress.stage)
      || window.slice(start + 1).some(({payload}) => payload.type === 'checkpoint_restore_started'
        || payload.type === 'checkpoint_materialized' || payload.type === 'run_reclaimed'
        || payload.type === 'attempt_settled' && payload.receipt.ending === 'isolation_failure'
        || payload.type === 'checkpoint' && payload.checkpoint.state !== 'safe')) return run;
    if (projection.authority && (!receipt.key.execution
      || !same(commandContext(projection.authority, command, receipt.key.execution.id), receipt.key.execution))) return run;
    if (receipt.execution.state !== 'complete') return {...run,failure:{reason:'command_unfinished',detail:JSON.stringify(receipt.execution)}};
    // A non-zero exit that the base tree shares is the environment's, not the change's: it stays shown but does not block.
    const basis = commandBasis(receipt);
    if (receipt.execution.exit !== 0 && basis !== 'pre-existing') return {...run,failure:{reason:'command_nonzero',
      detail:`exit ${receipt.execution.exit}${receipt.base ? `; ${baseConclusion(receipt.base)}` : ''}`}};
    const inputs = command.inputs.map(id => target.inputHashes[projection.brief.declaration.inputs.findIndex(input => input.id === id)]?.sha256);
    if (!same(receipt.key.inputHashes, inputs)) return run;
    if (!command.dependsOn) {
      if (!commandApplicable(projection, receipt, receipt.after, target.tree)) return run;
    } else if (receipt.after !== target.tree) {
      const changed = await changedTreePaths(journal, receipt.after, target.tree);
      if (!changed.ok || changed.value.some(path => path === 'project' || command.dependsOn!.some(dependency =>
        path === dependency || path.startsWith(dependency + '/') || dependency.startsWith(path + '/')))) return run;
    }
    return {kind:'satisfied',...evidence,dependencyIntersection:[]};
  } catch { return run; }
}

/** The commands a stage runs: its own, and on the final gate every required one, except those whose passing receipt on unchanged
 * declared inputs still applies to the target. One reuse rule (`requiredCommandResult`) for every stage and every command, required
 * or not, so a resume or a repeated stage runs only what lacks such a receipt. */
export async function selectedCommandIds(stage: Stage, projection: RunProjection, journal: Journal,
  target: Target, final: boolean): Promise<string[]> {
  const declared = projection.brief.declaration.commands;
  const selected = new Set([...(stage.commands ?? []), ...(final ? declared.filter(command => command.required).map(command => command.id) : [])]);
  for (const command of declared.filter(command => selected.has(command.id)))
    if ((await requiredCommandResult(journal, projection, command, target)).kind === 'satisfied') selected.delete(command.id);
  return [...selected];
}

/** Project the owner's chosen receipts into the existing review evidence channel. */
export async function reviewCommandEvidence(journal: Journal, projection: RunProjection, stage: Stage, final: boolean,
  target: Target) {
  const required = projection.brief.declaration.commands.filter(command => command.required);
  const commands = currentCommandReceipts(final
    ? projection.commands.filter(receipt => !required.some(command => command.id === receipt.command))
    : projection.commands, stage, projection.brief);
  const reusedCommands: CommandReuse[] = [];
  if (final) for (const command of required) {
    const result = await requiredCommandResult(journal, projection, command, target);
    const evidence = result.kind === 'satisfied' ? result : result.evidence;
    if (!evidence) continue;
    const {receipt,sourceTree,source,dependencyIntersection} = evidence;
    commands.push(receipt);
    reusedCommands.push({receipt,sourceTree,source,...(dependencyIntersection ? {dependencyIntersection} : {})});
  }
  return {commands,reusedCommands};
}

/** Select one serial frontier/explicit repair-return transition or delivery boundary. Derive AnswerContext.final only for the unique last normal gate, false for all other gates; Dedicated repair targets outside the normal dependency cone remain dormant until routed; normal ancestor targets may be explicitly revisited by repair. Never inspects narrative, command scores or overrides current gate outcome. Returns invalid/conflict/unknown for inconsistent/uncertain replay. */
function decideUnguidedNext(projection: RunProjection): Result<Next> {
  if (projection.status === 'cancelled' || projection.intents.some(intent => intent.kind === 'cancel'))
    return ok({ kind: 'stop', conclusion: conclusion('cancelled', 'cancelled') });
  if (projection.conclusion && nextLifecycle(projection.status, 'run') === null) return ok({ kind: 'stop', conclusion: projection.conclusion });
  if (projection.reservations.some(reservationOpen) || projection.attempts.some(receipt => attemptOpen(projection, receipt)))
    return { ok: false, kind: 'unknown', detail: `Unresolved execution facts; run flowcrew resume ${projection.run} to reconcile owned processes and accounting` };
  const stages = projection.plan.plan.stages;
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const depends = (id: string, ancestor: string) => stageDepends(projection,id,ancestor);
  const gates = stages.filter(stage => stage.purpose === 'gate');
  const last = gates.filter(gate => !gates.some(other => other.id !== gate.id && depends(other.id, gate.id)));
  const bootstrap = gates.length === 0 && stages.length === 1 && stages[0].purpose === 'plan' && projection.revisions.length === 1 && !projection.launch.plan;
  if (!bootstrap && last.length !== 1) return invalid('No unique delivery gate');
  const delivered = (receipt: AttemptReceipt) => receipt.ending === 'delivered' && receipt.closure === 'dead';
  // Resetting a stage invalidates the applicability of its earlier review, while retaining the receipt.
  const latest = (id: string) => byId.get(id)?.purpose === 'gate'
    && !projection.stageStates.some(state=>state.stage === id && state.state === 'settled') ? undefined
    : projection.attempts.filter(receipt => receipt.address.stage === id).at(-1);
  const settled = (id: string): boolean => {
    const stage = byId.get(id);
    if (!projection.stageStates.some(state => state.stage === id && (state.state === 'settled' || state.state === 'skipped'))) return false;
    if (stage?.purpose !== 'gate') return true;
    const receipt = latest(id);
    return !!receipt && delivered(receipt) && projection.transitions.some(item => item.stage === id && item.attempt === receipt.address.attempt
      && (item.outcome === 'accepted' || item.outcome === 'accepted_blocked'));
  };
  const context = (stage: Stage): AnswerContext => stageContext(projection,stage,stage.id === last[0]?.id,settled);
  const select = (stage: Stage): Result<Next> => {
    return ok({ kind: 'stage', stage, context: context(stage) });
  };
  const pairs = projection.transitions.map(item => JSON.stringify([item.stage, item.attempt]));
  if (new Set(pairs).size !== pairs.length) return invalid('Duplicate gate transition attempt');
  // A committed rejection is an outstanding return obligation until a newer delivered gate visit.
  for (const transition of [...projection.transitions].reverse()) {
    if (transition.outcome !== 'rejected_repairable') continue;
    const gate = byId.get(transition.stage);
    if (!gate || gate.purpose !== 'gate' || !gate.repair || transition.next !== gate.repair.stage) return invalid('Missing explicit repair return');
    if (!latest(gate.id)) continue;
    const rejectedIndex = projection.attempts.findLastIndex(receipt => receipt.address.stage === gate.id
      && receipt.address.attempt === transition.attempt && delivered(receipt));
    if (rejectedIndex < 0) return invalid('Transition has no gate receipt');
    const newerGate = projection.attempts.slice(rejectedIndex + 1).some(receipt => receipt.address.stage === gate.id && delivered(receipt));
    if (newerGate) continue;
    const repair = byId.get(gate.repair.stage);
    if (!repair || repair.purpose === 'gate') return invalid('Missing admitted repair target');
    const repaired = projection.attempts.slice(rejectedIndex + 1).some(receipt => receipt.address.stage === repair.id && delivered(receipt));
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
    if (!receipt || !delivered(receipt)) continue;
    if (receipt.answer?.kind !== 'gate' || !receipt.answerRef) return invalid('Delivered gate lacks authenticated answer');
    // Settlement authenticated and validated this answer under its receiving contract.
    // Replay consumes that fact without applying today's answer grammar.
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

/** Admitted dependency relation shared by review routing and continuation invalidation. */
export function stageDepends(projection: Pick<RunProjection,'plan'>, id: string, ancestor: string, seen=new Set<string>()): boolean {
  if (id === ancestor) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return !!projection.plan.plan.stages.find(stage=>stage.id === id)?.after.some(parent=>stageDepends(projection,parent,ancestor,seen));
}

function stageContext(projection: RunProjection, stage: Stage, final: boolean,
  settled: (id: string) => boolean): AnswerContext {
  return {purpose:stage.purpose,final,revision:projection.plan.revision,roleIds:projection.launch.roles.map(role=>role.id),
    commandIds:projection.brief.declaration.commands.map(command=>command.id),checkpointIds:projection.checkpoints.filter(item=>item.state === 'safe').map(item=>item.id),
    briefTexts:[projection.brief.declaration.body, ...(projection.brief.declaration.title ? [projection.brief.declaration.title] : []),
      ...projection.brief.declaration.criteria.map(item=>item.text)],
    criterionIds:projection.brief.declaration.criteria.map(item=>item.id),resultIds:projection.brief.declaration.results.map(item=>item.id),
    allowBlocked:projection.brief.declaration.allowBlocked,settledStageIds:[...new Set([...projection.stageStates.filter(item=>settled(item.stage)).map(item=>item.stage),
      ...(stage.purpose === 'plan' ? [stage.id] : [])])]};
}

/** Review cannot outrun author guidance, including when every author was already settled. */
export function decideNext(projection: RunProjection): Result<Next> {
  const next = decideUnguidedNext(projection);
  if (!next.ok || next.value.kind === 'stop' || !pendingGuidance(projection).length) return next;
  // Settlement still authenticates the paid frontier; guidance routes its successor after retention.
  if (projection.invocations.some(invocation=>invocation.charge !== 'command' && invocation.address.kind === 'stage'
    && !projection.attempts.some(receipt=>same(invocation.address,{kind:'stage',...receipt.address}))
    && !projection.closedInvocations.some(closed=>same(invocation,closed)))) return next;
  if (next.value.kind === 'stage' && next.value.stage.purpose !== 'gate') return next;
  const stages = projection.plan.plan.stages;
  const boundary = next.value.kind === 'stage' ? next.value.stage.id
    : next.value.kind === 'transition' ? next.value.transition.stage : next.value.checkpoint.address.stage;
  const authors = stages.filter(stage => stage.purpose !== 'gate' && stageDepends(projection,boundary,stage.id));
  const author = [...projection.attempts].reverse().map(receipt=>authors.find(stage=>stage.id === receipt.address.stage)).find(Boolean) ?? authors.at(-1);
  if (!author) return invalid('Pending guidance has no applicable author stage');
  return ok({kind:'stage',stage:author,context:stageContext(projection,author,false,id=>!stageDepends(projection,id,author.id)
    && projection.stageStates.some(state=>state.stage === id && ['settled','skipped'].includes(state.state)))});
}

/** Follow engine-owned transitions to the next actual dispatch/publication boundary. */
export function dispatchableFrontier(projection: RunProjection): Result<Next> {
  const next = decideNext(projection);
  return next.ok && next.value.kind === 'transition'
    ? dispatchableFrontier({...projection,transitions:[...projection.transitions,next.value.transition]}) : next;
}

/** Decide final lifecycle from last full-brief gate bound to selected safe tree, no pending normal work, all required applicable complete-zero command receipts, and preserved output bytes. Labels are membership only; diagnostics cannot veto the gate. Never runs commands or infers success from text. Returns complete/accepted_blocked or exact incomplete/failed Conclusion, and invalid/conflict/unknown for unsafe facts. */
export async function decidePublication(journal: import('../contract/runtime.js').Journal, projection: RunProjection, checkpoint: Checkpoint, outputs: OutputReceipt): Promise<Result<Conclusion>> {
  const next = decideNext(projection);
  if (!next.ok) return next;
  if (next.value.kind === 'stop') return ok(next.value.conclusion);
  if (next.value.kind !== 'publication' || !same(next.value.checkpoint, checkpoint)
    || checkpoint.state !== 'safe' || checkpoint.brief !== projection.brief.digest || !await frozenInputsMatch(journal, projection.brief, checkpoint.inputHashes, projection.launch.setup.inputs))
    return invalid('Publication requires the current gate and selected safe delivery tree');
  const receipt = projection.attempts.find(item => same(item.address, checkpoint.address));
  if (!receipt || receipt.answer?.kind !== 'gate' || !receipt.answerRef || receipt.before !== checkpoint.tree)
    return invalid('Gate is not bound to delivery tree');
  const gate = receipt.answer.answer;
  if (gate.outcome !== 'accepted' && gate.outcome !== 'accepted_blocked') return invalid('Gate did not accept');
  if (projection.checkpoints.at(-1)?.tree !== checkpoint.tree) return invalid('Tree changed after selected gate');
  const sources = (receipt.reusedCommands ?? []).map(item =>
    `${item.receipt.command}: ${commandEvidenceLabel(item,receipt.address).source}`);
  const failure = await publicationFailure(journal, projection, checkpoint, outputs);
  if (failure) return ok({ ...failure,detail:[failure.detail,...sources].join('; '),authoredGate:receipt.answerRef });
  const result = conclusion(gate.outcome === 'accepted' ? 'complete' : 'accepted_blocked',
    gate.outcome === 'accepted' ? 'completed' : 'accepted_blocked', receipt.answerRef);
  return ok({...result,detail:[result.detail,...sources].join('; ')});
}

/** One owner selects the outcome and diagnostics from every measured/unknown delivery failure. */
async function publicationFailure(journal: Journal, projection: RunProjection, checkpoint: Checkpoint, outputs: OutputReceipt): Promise<Pick<Conclusion, 'status' | 'reason' | 'detail'> | null> {
  // Missing and nonzero commands precede output loss; unfinished evidence follows.
  const rank = {command_missing:0,command_nonzero:1,outputs_unpreserved:2,command_unfinished:3} as const;
  type Failure = {status:'incomplete';reason:keyof typeof rank;detail:string};
  const failures: Failure[] = [];
  for (const command of projection.brief.declaration.commands.filter(item => item.required)) {
    const result = await requiredCommandResult(journal, projection, command, checkpoint);
    if (result.kind === 'run') failures.push({status:'incomplete',reason:result.failure.reason,
      detail:`${command.id}: ${result.failure.detail}`});
  }
  if (!outputs.preserved) failures.push({ status: 'incomplete', reason: 'outputs_unpreserved', detail: outputs.detail });
  if (!failures.length) return null;
  failures.sort((a, b) => rank[a.reason] - rank[b.reason]
    || a.detail.localeCompare(b.detail));
  return { ...failures[0], detail: failures.map(item => item.detail).join('; ') };
}

/** Whole-generation continuity: after the receipt only command executions that start from the tree it left may follow, so no
 * author change or restore intervenes. Commands in the final gate phase may write delivered bytes. */
function commandApplicable(projection: RunProjection, receipt: CommandReceipt, after: Hash, target: string): boolean {
  const start = projection.lineage.findIndex(item => item.kind === 'command' && same(item.receipt, receipt));
  if (start < 0) return false;
  let tree = after;
  for (const item of projection.lineage.slice(start + 1)) {
    if (item.kind === 'checkpoint' ? item.checkpoint.tree !== tree
      : item.receipt.before !== tree || item.receipt.key.generation?.sha256 !== tree) return false;
    if (item.kind === 'command') { if (item.receipt.after === undefined) return false; tree = item.receipt.after; }
  }
  return tree === target;
}

/** The one owner of "this command's result stops the run for an operator": a receipt whose after-tree could not be pinned because
 * something outside its containment kept writing a declared output. The receipt, streams and the tree it left are kept; resume runs
 * the command again (a command with a passing receipt on unchanged inputs is not run again) and cancel keeps the evidence.
 * Every other receipt continues the run; a command that passes its time limit is not stopped at all (see `onLimit`). */
export function commandPause(run: string, receipt: CommandReceipt): Conclusion | undefined {
  if (receipt.after !== undefined) return undefined;
  const ended = receipt.execution.state === 'complete' ? `exit ${receipt.execution.exit}` : receipt.execution.reason;
  return { status: 'parked', reason: 'command_unfinished',
    detail: `${receipt.command} ended (${ended}) but its outputs could not be pinned (${receipt.unpinned?.detail.trim()}); something outside its containment may still be writing to a declared output. Its receipt and streams are kept; stop the writer, then flowcrew resume ${run} runs it again (commands that passed are not run again), or flowcrew cancel ${run} keeps the evidence.` };
}

function conclusion(status: Conclusion['status'], reason: Conclusion['reason'], authoredGate?: Conclusion['authoredGate']): Conclusion {
  return { status, reason, detail: reason, ...(authoredGate ? { authoredGate } : {}) };
}
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function ok<T>(value: T): Result<T> { return { ok: true, value }; }
function invalid(detail: string): Result<never> { return { ok: false, kind: 'invalid', detail }; }
