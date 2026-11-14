import { runRecordPath, stageWorkPath } from '../../run-layout.js';
import { currentDispatchAdmissionReport, archiveDispatchAdmissionRefusal } from '../sched_admission/dispatch-retry.js';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from '../../engine-fs.js';
/** Admit planner topology; ordinary dependencies and conditions own its DAG duties. */
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
    // Historical snapshot ledgers are readable artifacts, never a second budget owner.
    // Their iteration-local counters cannot establish a run-wide remaining budget.
    const budget = state.dispatchAdmission;
    const invalid = budget && (!Number.isSafeInteger(budget.refusals) || budget.refusals < 0
      || !Number.isSafeInteger(budget.maxRefusals) || budget.maxRefusals < 1);
    const code = invalid ? 'dispatch_budget_invalid'
      : !budget && (existsSync(runRecordPath(directory, 'plan_retry_state.json'))
        || state.dispatchedStages !== undefined) ? 'legacy_retry_state_unsupported'
      : budget && budget.refusals >= budget.maxRefusals ? 'dispatch_retry_exhausted' : undefined;
    if (code) {
      writeFileSync(runRecordPath(directory, 'dispatch_admission.json'), JSON.stringify({ version: 1, pass: false,
        checkedAt: new Date().toISOString(), errors: [{ code, field: 'dispatch', stageId: planner.id, message: code }], warnings: [] }));
      return { kind: 'settled', state: concludeRun(state, { status: 'failed', reasonCode: 'dispatch_refused', detail: code }) };
    }
    state.dispatchAdmission ??= { refusals: 0, maxRefusals: Math.max(0, Math.floor(loadDefaults().plan_stage_retries)) + 1 };
    writeRunState(project, run, state);
    const stages = injectDispatchedStages(planner.id, roles, sorted, state, project, run);
    state = readRunState(project, run);
    if (stages.length) {
      injected.add(planner.id);
      continue;
    }
    state.decisionGraph ??= emptyDecisionGraph();
    const graph = state.decisionGraph;
    const key = `${decisionKey(state, planner)}/dispatch`;
    const budgetAfter = state.dispatchAdmission!;
    const count = budgetAfter.refusals++;
    writeRunState(project, run, state);
    const record = { key, stageId: planner.id, iteration: state.currentIteration ?? 1, outcome: 'defaulted' as const,
      successor: 'replan', reason: 'Complete dispatch refused by admission; recorded successor: replan.' };
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
    try { archived = archiveDispatchAdmissionRefusal({ runDirPath: directory, stageId: planner.id, attemptIndex: count + 1, rawDispatchText: readFileSync(stageWorkPath(directory, 'dispatch.yaml'), 'utf8') }); } catch { /* missing/invalid YAML is retained by the ordinary output record */ }
    if (budgetAfter.refusals >= budgetAfter.maxRefusals) {
      let diagnostic = '';
      try { diagnostic = (JSON.parse(readFileSync(runRecordPath(directory, 'dispatch_admission.json'), 'utf8')).errors as Array<{message: string}>).map(error => error.message).join('; '); } catch { /* missing admission remains an explicit refusal */ }
      return { kind: 'settled', state: concludeRun(state, { status: admission?.errors.some(error => error.code === 'stage_role_unknown') ? 'escalated' : 'failed', reasonCode: 'dispatch_refused', detail: `Planner dispatch refused after ${count + 1} attempts: ${record.reason}; ${diagnostic}; see ${runRecordPath(directory, 'dispatch_admission.json')}.` }) };
    }
    const retryDetail = archived ? `${record.reason}\nDurable rejected proposal: ${runRecordPath(directory, archived.proposalPath)}\nDurable admission report: ${runRecordPath(directory, archived.admissionPath)}` : record.reason;
    state.stages[planner.id] = { ...rependStageStatus(state.stages[planner.id], count + 1, retryDetail), admissionFailure: { code: 'dispatch_refused', attemptIndex: state.stages[planner.id].attempts?.at(-1)?.index ?? 0 } };
    writeStageStatus(project, run, planner.id, state.stages[planner.id]);
    writeRunState(project, run, state);
    recordRunEvent(project, run, { type: 'plan_dispatch_retry', runId: run, timestamp: new Date().toISOString(), iteration: state.currentIteration ?? 1, stageId: planner.id, detail: `plan retry ${count + 1}/${budgetAfter.maxRefusals - 1}: ${retryDetail}`, source: 'scheduler' });
  }
  return { kind: 'continue', state };
}
