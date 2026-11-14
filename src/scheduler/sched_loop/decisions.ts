import { isReadOnlyStage } from '../sched_scope/frozen-inputs.js';
import { runRecordPath } from '../../run-layout.js';
import { topoSort } from '../sched_admission/frontier.js';
import { normalizedProjectPath, parseDeclaredScope, scopeMatchesProjectPath } from '../sched_admission/scope-services.js';
import { readEvidence } from '../../evidence-ledger.js';
import type { AuditFinding } from '../../scoped-audit-repair.js';
/** Settle declared edges at idle boundaries. All execution uses the ordinary scheduler. */
import { existsSync } from 'node:fs';
import { unlinkSync } from '../../engine-fs.js';
import { emptyDecisionGraph, validateDecision, type DecisionRecord } from '../../decision-graph.js';
import { changedPaths } from '../../decision-context.js';
import { readRunEvents, recordRunEvent } from '../../run-events.js';
import { STAGE_STATUS, readStageOutput, rependStageStatus, writeStageStatus, writeRunState, isPendingStageStatus, type StoreState } from '../../store.js';
import { loadDefaults, type StageConfig } from '../sched_admission/configuration.js';
import { collectGateRuntimeFacts, classifyGateRecoveryFact, findGateRecoveryStages, gateReviewedAuthorIds } from '../sched_settlement/gate-recovery.js';
import { archiveGateRoundEvidence, archiveRejectedGateRuntimeFacts, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { terminateForGateContractRefusal, writeRepairRoundDiffArtifact } from './services.js';

export function decisionKey(state: StoreState, stage: StageConfig): string {
  const status = state.stages[stage.id], attempt = status?.attempts?.at(-1);
  return `${attempt?.iteration ?? state.currentIteration ?? 1}/${stage.id}/${attempt?.index ?? 0}/${attempt?.startedAt ?? status?.completedAt ?? ''}`;
}
export function declaredDecision(stage: StageConfig, stages: StageConfig[], state?: StoreState): StageConfig['decision'] {
  if (stage.decision) return stage.decision;
  // Compatibility decoding of typed historical topology, never prose.
  if (stage.is_gate) return { successors: ['continue', ...stages.filter(s => s.retry_to?.includes(stage.id)).map(s => s.id), stage.id], default: stage.id, kind: 'successor' };
  if (stage.retry_to?.length) {
    const group = topoSort(stages).filter(candidate => candidate.retry_to?.some(id => stage.retry_to!.includes(id)));
    const gateTime = Math.max(...stage.retry_to.map(id => Date.parse(state?.stages[id]?.attempts?.at(-1)?.completedAt ?? '0')));
    const next = group.slice(group.findIndex(candidate => candidate.id === stage.id) + 1).find(candidate => {
      const status = state?.stages[candidate.id];
      return status?.status !== STAGE_STATUS.COMPLETE || Date.parse(status.attempts?.at(-1)?.startedAt ?? '0') <= gateTime;
    });
    const successors = [...group.map(candidate => candidate.id), ...stage.retry_to];
    return { successors, default: next?.id ?? stage.retry_to[0], kind: 'successor' };
  }
  return undefined;
}

function repend(id: string, state: StoreState): void {
  state.stages[id] = rependStageStatus(state.stages[id], 0);
}
function publishTarget(id: string, state: StoreState, project: string, run: string, directory: string): void {
  writeStageStatus(project, run, id, state.stages[id]);
  const verdict = runRecordPath(directory, `verdict_${id}.json`);
  if (existsSync(verdict)) unlinkSync(verdict);
}

function event(record: DecisionRecord, state: StoreState, project: string, run: string): void {
  recordRunEvent(project, run, { type: `decision_${record.outcome === 'chosen' ? 'chosen' : record.outcome === 'refused' ? 'refused' : 'defaulted'}`,
    runId: run, timestamp: new Date().toISOString(), iteration: record.iteration, stageId: record.stageId,
    detail: JSON.stringify(record), source: 'scheduler' });
}

/** Events are a projection of committed choices; recover the state/event publication gap without repeating work. */
export function reconcileDecisionEvents(state: StoreState, project: string, run: string): void {
  if (!state.decisionGraph?.records.length) return;
  const published = new Set(readRunEvents(project, run).flatMap(event => {
    if (!['decision_chosen', 'decision_defaulted', 'decision_refused'].includes(event.type)) return [];
    try { return [JSON.parse(event.detail ?? '{}').key]; } catch { return []; }
  }));
  for (const record of state.decisionGraph.records) if (!published.has(record.key)) event(record, state, project, run);
}

export function settleDecisions(sorted: StageConfig[], state: StoreState, project: string, run: string, directory: string): StoreState {
  if (Object.values(state.stages).some(s => s.status === STAGE_STATUS.RUNNING)) return state;
  state.decisionGraph ??= emptyDecisionGraph();
  const graph = state.decisionGraph;
  graph.maxVisits ??= Math.max(0, Math.floor(state.maxRetries ?? loadDefaults().gate_retry_loops));
  if (state.maxRetries !== undefined) graph.maxVisits = Math.min(graph.maxVisits, Math.max(0, Math.floor(state.maxRetries)));
  const iteration = state.currentIteration ?? 1;
  // Decode already-admitted legacy work once; a crash cannot spend its repair/technical allowance again.
  if (!graph.records.length && state.gateRetryRound?.iteration === iteration) {
    const pending = sorted.filter(stage => stage.retry_to?.length && isPendingStageStatus(state.stages[stage.id]?.status ?? '')
      && state.stages[stage.id]?.attempts?.at(-1)
      && (state.stages[stage.id].attempts!.at(-1)!.iteration === undefined || state.stages[stage.id].attempts!.at(-1)!.iteration === iteration));
    for (const repair of pending) {
      const gateId = repair.retry_to![0], gate = sorted.find(stage => stage.id === gateId);
      if (!gate) continue;
      graph.enabled[repair.id] = gateId;
      const record: DecisionRecord = { key: decisionKey(state, gate), stageId: gateId, iteration, outcome: 'chosen', successor: repair.id, reason: 'Retain unfinished admitted repair and its spent budget.' };
      graph.records.push(record); event(record, state, project, run);
      graph.visits[`${iteration}/${gateId}`] = Math.max(0, state.gateRetryRound.round - 1);
    }
  }
  for (const source of [...sorted]) {
    const declaration = declaredDecision(source, sorted, state), status = state.stages[source.id];
    if (!declaration || status?.status !== STAGE_STATUS.COMPLETE && !(source.is_gate && status?.status === STAGE_STATUS.FAILED)) continue;
    if (source.retry_to?.length && !graph.enabled[source.id]) continue;
    const key = decisionKey(state, source);
    if (graph.records.some(record => record.key === key)) continue;
    const stage = { ...source, decision: declaration };
    let choice: ReturnType<typeof validateDecision>;
    let unconfirmedRejection = false;
    let gateAccepted: boolean | undefined;
    let rejectedFindings: AuditFinding[] = [];
    if (source.is_gate) {
      const facts = collectGateRuntimeFacts([source], state, project, run);
      const fact = facts.evaluations[0];
      gateAccepted = fact?.effectiveVerdict?.pass === true;
      rejectedFindings = fact?.effectiveVerdict?.findings?.confirmed ?? [];
      if (fact?.rejectionKind === 'irreparable_rejection' || facts.contractRefusals.length) {
        if (terminateForGateContractRefusal(state, facts, project, run, iteration)) return state;
      }
      const recoveries = facts.rejectedGateIds.length ? findGateRecoveryStages(sorted, facts.rejectedGateIds,
        fact ? { [source.id]: classifyGateRecoveryFact(source.id, fact.authoredVerdict, fact.effectiveVerdict) } : {}) : [];
      const successor = facts.allPass ? 'continue' : recoveries[0]?.id ?? declaration.default;
      choice = validateDecision(stage, JSON.stringify({ successor, reason: facts.allPass ? 'Effective independent gate accepted.' : fact?.effectiveVerdict?.reason ?? 'Invalid or absent gate result; take the declared default without accepting work.' }));
      if (!fact?.effectiveVerdict && !facts.allPass) choice.outcome = 'defaulted';
      if (fact?.effectiveVerdict?.pass === false && !fact.effectiveVerdict.findings?.confirmed.length && !recoveries.length && !facts.contractRefusals.length) {
        unconfirmedRejection = true;
        choice.outcome = 'refused';
        choice.reason = `Gate criteria rejected; no confirmed finding authorizes repair. ${choice.reason}`;
      }
    } else if (source.retry_to?.length && !source.decision) {
      choice = validateDecision(stage, JSON.stringify({ successor: declaration.default, reason: 'Completed repair returns to its rejecting gate.' }));
    } else {
      choice = validateDecision(stage, readStageOutput(project, run, source.id), source.decision?.kind === 'review' ? changedPaths(project, state) : []);
    }
    const record: DecisionRecord = { ...choice, ...(gateAccepted === undefined ? {} : { gateAccepted }), planRevision: state.queryState?.planRevision?.revision, declaredSuccessors: declaration.successors, key, stageId: source.id, iteration };
    for (const [target, owner] of Object.entries(graph.enabled)) if (owner === source.id) delete graph.enabled[target];
    graph.records.push(record);
    const targetsToPublish: string[] = [];
    const target = choice.successor;
    const destination = sorted.find(s => s.id === target);
    const used = graph.visits[`${iteration}/${target}`] ?? 0;
    const limit = graph.maxVisits;
    const resumed = destination && isPendingStageStatus(state.stages[target]?.status ?? '') && (state.stages[target]?.attempts?.length ?? 0) > 0;
    const revisiting = Boolean(destination && (state.stages[target]?.attempts?.length || state.stages[target]?.status === STAGE_STATUS.COMPLETE));
    // Gap identity belongs to the report, not the author's responsibility map.
    const ledger = source.is_gate ? readEvidence(directory) : [];
    const gaps = source.is_gate ? gateReviewedAuthorIds(source, sorted).flatMap(id => {
      const attempt = state.stages[id]?.attempts?.at(-1);
      if (attempt?.endingCause !== 'environment_gap') return [];
      const fact = ledger.find(entry => entry.kind === 'attempt' && entry.stageId === id
        && entry.attemptIndex === attempt.index && entry.attemptStartedAt === attempt.startedAt);
      return [{ id, blocks: fact?.kind === 'attempt' ? fact.environmentGap?.blocks : undefined,
        unknownCriterionIds: fact?.kind === 'attempt' ? fact.environmentGap?.unknownCriterionIds ?? [] : [] }];
    }) : [];
    const unspecified = gaps.filter(({ blocks }) => !blocks || !blocks.criterion_ids.length && !blocks.paths.length);
    if (unspecified.length) record.reason += ` Environment gaps without declared blocks: ${unspecified.map(gap => gap.id).join(', ')}; relatedness unknown.`;
    const repeatedGap = state.stages[target]?.attempts?.at(-1)?.endingCause === 'environment_gap' ? target
      : gateAccepted === false ? gaps.find(({ blocks, unknownCriterionIds }) => blocks && (blocks.criterion_ids.length || blocks.paths.length)
        && rejectedFindings.some(finding => (!blocks.criterion_ids.length || finding.criterion_ids.some(id => blocks.criterion_ids.includes(id) && !unknownCriterionIds.includes(id)))
          && (!blocks.paths.length || finding.paths.some(raw => {
            const path = normalizedProjectPath(raw);
            return path !== undefined && blocks.paths.some(block => {
              const declaration = parseDeclaredScope(block);
              return declaration.kind !== 'unknown' && scopeMatchesProjectPath(declaration, path);
            });
          }))))?.id : undefined;
    if (repeatedGap || unconfirmedRejection || (state.currentIteration ?? 1) > (state.maxIterations ?? loadDefaults().max_iterations) || target !== 'continue' && target !== 'replan' && !destination
      || target !== 'continue' && (revisiting || source.is_gate) && !resumed && used >= limit) {
      record.outcome = 'refused'; record.reason = repeatedGap ? `Environment gap already reported by ${repeatedGap}; no further attempt on that gap authorized. ${record.reason}` : unconfirmedRejection ? record.reason : `Successor refused: unknown destination or exhausted visit budget (${used}/${limit}). ${record.reason}`;
      delete record.successor;
    } else if (target === 'replan') {
      const planner = sorted.find(s => s.dynamic_dispatch);
      const replans = graph.visits[`${iteration}/replan`] ?? 0;
      if (!planner || replans >= limit) { record.outcome = 'refused'; record.reason = 'Replan refused: no declared plan stage or replan budget exhausted.'; delete record.successor; }
      else {
        graph.replan = { stageId: planner.id, reason: choice.reason };
        graph.visits[`${iteration}/replan`] = replans + 1;
        graph.enabled[planner.id] = source.id;
        repend(planner.id, state); targetsToPublish.push(planner.id);
      }
    } else if (destination) {
      if (source.is_gate) {
        const facts = collectGateRuntimeFacts(sorted, state, project, run);
        const coordinate = gateArchiveCoordinate(iteration, used + 1);
        archiveRejectedGateRuntimeFacts(directory, coordinate, facts);
        archiveGateRoundEvidence(directory, coordinate, [source.id], new Map(facts.evaluations.filter(fact => fact.effectiveVerdict).map(fact => [fact.id, fact.effectiveVerdict!])));
        state.gateRetryRound = { iteration, round: used + 1 };
      }
      graph.enabled[target] = source.id;
      graph.visits[`${iteration}/${target}`] = used + Number(!resumed && (revisiting || source.is_gate));
      if (destination.is_gate && !isReadOnlyStage(source)) finishRepairEvidence(directory, state, sorted, destination.id);
      if (state.stages[target]?.status !== STAGE_STATUS.PENDING) { repend(target, state); targetsToPublish.push(target); }
    }
    writeRunState(project, run, state);
    for (const id of targetsToPublish) publishTarget(id, state, project, run, directory);
    event(record, state, project, run);
  }
  writeRunState(project, run, state);
  return state;
}

function finishRepairEvidence(directory: string, state: StoreState, sorted: StageConfig[], gateId: string): void {
  const coordinate = state.gateRetryRound;
  if (!coordinate) return;
  const records = state.decisionGraph?.records ?? [];
  const lastGate = [...records].reverse().find(record => record.stageId === gateId && record.iteration === coordinate.iteration);
  const start = lastGate ? records.indexOf(lastGate) : 0;
  const selected = new Set(records.slice(Math.max(0, start)).flatMap(record => record.successor ? [record.successor] : []));
  const rejectedAt = state.stages[gateId]?.attempts?.at(-1)?.completedAt ?? state.stages[gateId]?.completedAt;
  const repairs = sorted.filter(stage => !isReadOnlyStage(stage) && !stage.dynamic_dispatch
    && (selected.has(stage.id) || stage.retry_to?.includes(gateId))
    && state.stages[stage.id]?.attempts?.some(attempt => Date.parse(attempt.startedAt) >= Date.parse(rejectedAt ?? '')));
  const statuses = Object.fromEntries(repairs.map(stage => [stage.id, { ...state.stages[stage.id],
    attempts: state.stages[stage.id].attempts?.filter(attempt => Date.parse(attempt.startedAt) >= Date.parse(rejectedAt ?? '')) }]));
  writeRepairRoundDiffArtifact({ runDirPath: directory, ...coordinate, repairStages: repairs, statuses });
}
