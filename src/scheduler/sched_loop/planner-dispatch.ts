import { preparePlanRetryCandidate, recordPlanRetryAdmission, recordPlanRetryRefusal, planRetryRequirement } from '../../plan-retry-monotone.js';
import { currentDispatchAdmissionReport, planRetryRequirementsFromAdmission, archiveDispatchAdmissionRefusal } from '../sched_admission/dispatch-retry.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Admit the planner's declared topology, then release it through the same decision ledger. */
import { StageConfig, loadDefaults } from '../sched_admission/configuration.js';
import { attemptEventFields, recordRunEvent } from '../../run-events.js';
import { STAGE_STATUS, StoreState, readRunState, rependStageStatus, writeRunState, writeStageStatus } from '../../store.js';
import { injectDispatchedStages } from './services.js';
import { concludeRun } from '../sched_policy/run-completion.js';
import { emptyDecisionGraph } from '../../decision-graph.js';
import { decisionKey } from './decisions.js';

export function admitPlannerDispatches(sorted: StageConfig[], state: StoreState, project: string, run: string, directory: string,
  roles: Map<string, { name: string; description: string }>, injected: Set<string>): { kind: 'settled' | 'continue'; state: StoreState } {
  for (const planner of [...sorted]) {
    if (!planner.dynamic_dispatch || injected.has(planner.id) || state.stages[planner.id]?.status !== STAGE_STATUS.COMPLETE) continue;
    const prepared = preparePlanRetryCandidate({ runDirPath: directory, stageId: planner.id, iteration: state.currentIteration ?? 1, attemptIndex: 1 });
    const stages = injectDispatchedStages(planner.id, roles, sorted, state, project, run);
    state = readRunState(project, run);
    state.decisionGraph ??= emptyDecisionGraph();
    const graph = state.decisionGraph;
    const key = `${decisionKey(state, planner)}/dispatch`;
    if (stages.length) {
      recordPlanRetryAdmission({ runDirPath: directory, prepared });
      injected.add(planner.id);
      const ids = new Set(stages.map(stage => stage.id));
      const roots = stages.filter(stage => stage.depends_on.every(id => !ids.has(id)));
      const record = { key, declaredSuccessors: roots.map(stage => stage.id), stageId: planner.id, iteration: state.currentIteration ?? 1, outcome: 'chosen' as const,
        successor: roots[0]?.id ?? stages[0].id, reason: `Admitted planner topology; declared entry set: ${roots.map(stage => stage.id).join(', ')}. Ordinary dependencies retain all duties.` };
      graph.records.push(record);
      recordRunEvent(project, run, { type: 'decision_chosen', runId: run, timestamp: new Date().toISOString(), stageId: planner.id, detail: JSON.stringify(record), source: 'scheduler' });
      writeRunState(project, run, state);
      continue;
    }
    const count = prepared.attemptIndex - 1;
    const limit = Math.max(0, Math.floor(loadDefaults().plan_stage_retries));
    const record = { key, stageId: planner.id, iteration: state.currentIteration ?? 1, outcome: 'defaulted' as const,
      successor: 'replan', reason: 'Complete dispatch refused by bounded admission; default is replan. See dispatch_admission.json.' };
    graph.records.push(record);
    recordRunEvent(project, run, { type: 'decision_defaulted', runId: run, timestamp: new Date().toISOString(), stageId: planner.id, detail: JSON.stringify(record), source: 'scheduler' });
    const refused = state.stages[planner.id]?.attempts?.at(-1);
    if (refused && refused.disposition !== 'discarded') {
      refused.disposition = 'discarded';
      writeStageStatus(project, run, planner.id, state.stages[planner.id]);
      recordRunEvent(project, run, { type: 'attempt_results_updated', runId: run, timestamp: new Date().toISOString(), stageId: planner.id, ...attemptEventFields(refused), source: 'scheduler', detail: 'planner result refused by dispatch admission' });
    }
    const admission = currentDispatchAdmissionReport(directory);
    let archived: ReturnType<typeof archiveDispatchAdmissionRefusal> | undefined;
    try { archived = archiveDispatchAdmissionRefusal({ runDirPath: directory, stageId: planner.id, attemptIndex: prepared.attemptIndex, rawDispatchText: readFileSync(join(directory, 'dispatch.yaml'), 'utf8') }); } catch { /* missing/invalid YAML is retained by the ordinary output record */ }
    const ratchet = recordPlanRetryRefusal({ runDirPath: directory, prepared, maxAttempts: limit + 1,
      unsatisfied: admission?.errors.length ? planRetryRequirementsFromAdmission(admission) : [planRetryRequirement({ code: 'dispatch_structure', field: 'stages', message: 'No admissible complete plan.' }, 'structure')] });
    if (ratchet.stop) {
      let diagnostic = '';
      try { diagnostic = (JSON.parse(readFileSync(join(directory, 'dispatch_admission.json'), 'utf8')).errors as Array<{message: string}>).map(error => error.message).join('; '); } catch { /* missing admission remains an explicit refusal */ }
      return { kind: 'settled', state: concludeRun(state, { status: admission?.errors.some(error => error.code === 'stage_role_unknown') ? 'escalated' : 'failed', reasonCode: 'dispatch_refused', detail: `Planner dispatch refused after ${count + 1} attempts: ${ratchet.reason ?? record.reason}; ${diagnostic}; see ${directory}/dispatch_admission.json.` }) };
    }
    graph.visits[`${state.currentIteration ?? 1}/dispatch_refusal`] = count + 1;
    const retryDetail = archived ? `${record.reason}\nDurable rejected proposal: ${join(directory, archived.proposalPath)}\nDurable admission report: ${join(directory, archived.admissionPath)}` : record.reason;
    state.stages[planner.id] = { ...rependStageStatus(state.stages[planner.id], count + 1, retryDetail), admissionFailure: { code: 'dispatch_refused', attemptIndex: state.stages[planner.id].attempts?.at(-1)?.index ?? 0 } };
    writeStageStatus(project, run, planner.id, state.stages[planner.id]);
    writeRunState(project, run, state);
    recordRunEvent(project, run, { type: 'plan_dispatch_retry', runId: run, timestamp: new Date().toISOString(), iteration: state.currentIteration ?? 1, stageId: planner.id, detail: `plan retry ${count + 1}/${ratchet.state.maxAttempts - 1}: ${retryDetail}`, source: 'scheduler' });
  }
  return { kind: 'continue', state };
}
