import { concludeRun } from '../sched_policy/run-completion.js';
import { captureRepairRoundSnapshot, type RepairRoundSnapshot } from '../sched_scope/snapshots.js';
import { ensureRollbackBaseline } from '../sched_scope/rollback-baseline.js';
import { topoSort } from '../sched_admission/frontier.js';
import { stageScopeOwnsPath } from '../sched_admission/dispatch.js';
import type { AuditFinding } from '../../scoped-audit-repair.js';
/** Settle declared edges at idle boundaries. All execution uses the ordinary scheduler. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, mkdirSync, unlinkSync } from '../../engine-fs.js';
import { emptyDecisionGraph, validateDecision, type DecisionRecord } from '../../decision-graph.js';
import { changedPaths } from '../../decision-context.js';
import { readRunEvents, recordRunEvent } from '../../run-events.js';
import { RUN_STATUS, STAGE_STATUS, readStageOutput, rependStageStatus, writeStageStatus, writeRunState, isPendingStageStatus, type StoreState } from '../../store.js';
import { loadDefaults, type StageConfig, type WorkflowConfig } from '../sched_admission/configuration.js';
import { collectGateRuntimeFacts, classifyGateRecoveryFact, findGateRecoveryStages, gateReviewedAuthorIds } from '../sched_settlement/gate-recovery.js';
import { archiveGateRoundEvidence, archiveRejectedGateRuntimeFacts, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { injectDispatchedStages, terminateForGateContractRefusal, writeRepairRoundDiffArtifact } from './services.js';

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
  const verdict = join(directory, `verdict_${id}.json`);
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

export function settleDecisions(sorted: StageConfig[], state: StoreState, project: string, run: string, directory: string,
  workflow: WorkflowConfig, roles: Map<string, { name: string; description: string }>): StoreState {
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
    if (pending.length) saveRepairPreimage(project, directory, iteration, state.gateRetryRound.round, pending);
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
      const recoveries = facts.rejectedGateIds.length ? findGateRecoveryStages(sorted, facts.rejectedGateIds, state.research,
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
    if (source.decision?.kind === 'shape') {
      const raw = JSON.parse(readStageOutput(project, run, source.id));
      if (raw.metric_search === true && !state.research) {
        choice.missing_author_facts = [...new Set([...(choice.missing_author_facts ?? []), 'research.baseline', 'research.policy', 'research.stop'])];
      }
    }
    const record: DecisionRecord = { ...choice, ...(gateAccepted === undefined ? {} : { gateAccepted }), planRevision: state.queryState?.planRevision?.revision, declaredSuccessors: declaration.successors, key, stageId: source.id, iteration };
    for (const [target, owner] of Object.entries(graph.enabled)) if (owner === source.id) delete graph.enabled[target];
    if (choice.missing_author_facts?.length) {
      record.outcome = 'refused';
      delete record.successor;
      record.reason = `Author must add missing facts before launch: ${choice.missing_author_facts.join(', ')}. ${choice.reason}`;
      graph.records.push(record);
      event(record, state, project, run);
      concludeRun(state, { status: RUN_STATUS.FAILED, reasonCode: 'admission_refused', detail: record.reason });
      return state;
    }
    graph.records.push(record);
    const targetsToPublish: string[] = [];
    const target = choice.successor;
    const wallExhausted = state.research?.stop?.maxWallHours !== undefined
      && Date.now() - Date.parse(state.startedAt) >= state.research.stop.maxWallHours * 3_600_000;
    const destination = sorted.find(s => s.id === target);
    const fixedShape = source.decision?.kind === 'shape' && target === 'implement';
    const used = graph.visits[`${iteration}/${target}`] ?? 0;
    const limit = graph.maxVisits;
    const resumed = destination && isPendingStageStatus(state.stages[target]?.status ?? '') && (state.stages[target]?.attempts?.length ?? 0) > 0;
    const revisiting = Boolean(destination && (state.stages[target]?.attempts?.length || state.stages[target]?.status === STAGE_STATUS.COMPLETE));
    // A gap author's explicit responsibility confined to these finding criteria
    // cannot be erased by another author's broad or absent mapping. Otherwise
    // shared scope alone does not identify the confirmed defect as that gap.
    const gapOwners = source.is_gate && gateAccepted === false ? rejectedFindings.flatMap(finding => {
      const owners = gateReviewedAuthorIds(source, sorted).filter(id => {
        const author = sorted.find(stage => stage.id === id)!;
        return (!author.criterion_refs?.length || !finding.criterion_ids.length || finding.criterion_ids.some(ref => author.criterion_refs!.includes(ref)))
          && finding.paths.some(path => stageScopeOwnsPath(author, path));
      });
      const gaps = owners.filter(id => state.stages[id]?.attempts?.at(-1)?.endingCause === 'environment_gap');
      return owners.length === gaps.length ? gaps : gaps.filter(id => {
        const refs = sorted.find(stage => stage.id === id)!.criterion_refs;
        return refs?.length && refs.every(ref => finding.criterion_ids.includes(ref));
      });
    }) : [];
    const repeatedGap = [target, ...gapOwners]
      .find(id => state.stages[id]?.attempts?.at(-1)?.endingCause === 'environment_gap');
    if (repeatedGap || unconfirmedRejection || wallExhausted || (state.currentIteration ?? 1) > (state.maxIterations ?? loadDefaults().max_iterations) || target !== 'continue' && target !== 'replan' && !destination && !fixedShape
      || source.decision && destination?.is_gate && (destination.scope === undefined || destination.scope.length !== 0)
      || target !== 'continue' && (revisiting || source.is_gate) && !resumed && used >= limit) {
      record.outcome = 'refused'; record.reason = repeatedGap ? `Environment gap already reported by ${repeatedGap}; no new attempt can close that same gap. ${choice.reason}` : unconfirmedRejection ? choice.reason : `Successor refused: unknown destination, non-read-only gate, or exhausted visit budget (${used}/${limit}). ${choice.reason}`;
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
    } else if (fixedShape) {
      atomicWrite(join(directory, 'dispatch.yaml'), JSON.stringify({ stages: workflow.dispatch }));
      if (!injectDispatchedStages(source.id, roles, sorted, state, project, run).length) {
        record.outcome = 'refused'; record.reason = 'Fixed shape failed full dispatch admission; see dispatch_admission.json.'; delete record.successor;
      } else graph.enabled[target] = source.id;
    } else if (destination) {
      if (source.is_gate) {
        const facts = collectGateRuntimeFacts(sorted, state, project, run);
        const coordinate = gateArchiveCoordinate(iteration, used + 1);
        archiveRejectedGateRuntimeFacts(directory, coordinate, facts);
        archiveGateRoundEvidence(directory, coordinate, [source.id], new Map(facts.evaluations.filter(fact => fact.effectiveVerdict).map(fact => [fact.id, fact.effectiveVerdict!])));
        const group = sorted.filter(stage => stage.retry_to?.includes(source.id));
        if (group.length && !resumed) saveRepairPreimage(project, directory, iteration, used + 1, group);
        state.gateRetryRound = { iteration, round: used + 1 };
      }
      graph.enabled[target] = source.id;
      graph.visits[`${iteration}/${target}`] = used + Number(!resumed && (revisiting || source.is_gate));
      if (destination.is_gate && source.retry_to?.length) finishRepairEvidence(project, directory, state, sorted);
      if (state.stages[target]?.status !== STAGE_STATUS.PENDING) { repend(target, state); targetsToPublish.push(target); }
    }
    writeRunState(project, run, state);
    for (const id of targetsToPublish) publishTarget(id, state, project, run, directory);
    event(record, state, project, run);
  }
  writeRunState(project, run, state);
  return state;
}

function preimagePath(directory: string, iteration: number, round: number): string {
  return join(directory, 'gate_reevaluation', `iteration_${iteration}`, `round_${round}`, 'repair_preimage.json');
}
function saveRepairPreimage(project: string, directory: string, iteration: number, round: number, stages: StageConfig[]): void {
  const path = preimagePath(directory, iteration, round);
  if (existsSync(path)) return;
  const snapshot = captureRepairRoundSnapshot(project, stages, { runDirPath: directory });
  const { files, rollbackBaseline: _baseline, ...metadata } = snapshot;
  const images = [...files].map(([name, { bytes: _bytes, text: _text, backingPath: _path, ...image }]) => [name, image]);
  mkdirSync(join(directory, 'gate_reevaluation', `iteration_${iteration}`, `round_${round}`), { recursive: true });
  atomicWrite(path, JSON.stringify({ ...metadata, files: images }));
}
function finishRepairEvidence(project: string, directory: string, state: StoreState, sorted: StageConfig[]): void {
  const coordinate = state.gateRetryRound;
  if (!coordinate) return;
  const path = preimagePath(directory, coordinate.iteration, coordinate.round);
  if (!existsSync(path)) return;
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  const snapshot: RepairRoundSnapshot = { ...saved, files: new Map(saved.files), rollbackBaseline: ensureRollbackBaseline(project, directory).baseline };
  const repairs = sorted.filter(stage => (Object.hasOwn(snapshot.declaredScopes, stage.id) || stage.retry_to?.some(id => Object.keys(snapshot.declaredScopes).some(source => sorted.find(stage => stage.id === source)?.retry_to?.includes(id))))
    && Date.parse(state.stages[stage.id]?.attempts?.at(-1)?.startedAt ?? '0') >= Date.parse(snapshot.startedAt));
  for (const repair of repairs) for (const path of state.stages[repair.id]?.attempts?.at(-1)?.writes ?? []) {
    if (!path.startsWith('run:') && !snapshot.files.has(path)) snapshot.files.set(path, { exists: false, provenance: 'observed' });
  }
  writeRepairRoundDiffArtifact({ snapshot, projectDir: project, runDirPath: directory, ...coordinate, repairStages: repairs, statuses: state.stages });
}
