// Boundary: Admit idle-boundary plan amendments through the existing revision transaction; receives the shared full-dispatch admission predicate.
import { inspectArtifactDeclarations } from '../../artifact-declarations.js';
import { BriefCriteriaArtifact } from '../../brief-criteria.js';
import { RevisionAdmission, applyPlanRevision, recordAdmittedPlan } from '../../plan-revisions.js';
import { recordRunEvent } from '../../run-events.js';
import { STAGE_STATUS, StoreState, atomicWrite, writeRunState } from '../../store.js';
import { StageConfig, WorkflowConfig, parseDispatchedStageConfig, refreshRunQueryState } from '../sched_admission/configuration.js';
import { readBriefCriteriaForAdmission, stageScopeOwnsPath, type createDispatchAdmission, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { parseDeclaredScope, topoSort } from '../sched_admission/frontier.js';
import { inspectRealityCheckReachability } from '../sched_admission/reality-reads.js';
import { resolveDeclaredInputWriteBindings, scopeRequestAlreadyAuthorized } from '../sched_scope/path-capabilities.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

export function createPlanSettlement(inspectDispatchAdmission: ReturnType<typeof createDispatchAdmission>) {

  const revisionScopeContained = (scope: string, capabilities: readonly string[]): boolean =>
    capabilities.includes(scope) || scopeRequestAlreadyAuthorized(parseDeclaredScope(scope), capabilities.map(parseDeclaredScope));

  function publishRevisedWorkflow(stages: StageConfig[], sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, directory: string, workflow: WorkflowConfig): void {
    sorted.splice(0, sorted.length, ...topoSort(stages));
    refreshRunQueryState(state, sorted);
    writeRunState(projectDir, runId, state);
    atomicWrite(join(directory, 'workflow.yaml'), stringifyYaml({ ...workflow, stages: sorted }));
  }

  function admitRevisionCandidate(stages: StageConfig[], state: StoreState, projectDir: string, directory: string, roles: Map<string, { name: string; description: string }>): RevisionAdmission {
    let criteria: BriefCriteriaArtifact | undefined;
    try { criteria = readBriefCriteriaForAdmission(directory); }
    catch (error) { return { pass: false, errors: [`PLAN_REVISION_CRITERIA_UNREADABLE: ${String(error)}`] }; }
    const briefPath = join(directory, 'task_brief.md');
    const declaredInputs = existsSync(briefPath) ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(briefPath, 'utf8')) : [];
    const report = inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: stages.find((stage) => stage.dynamic_dispatch)?.id ?? 'plan',
      terminalStates: state.terminalStates, research: state.research,
      criteria: criteria?.criteria.length === 0 && !state.briefAdmission ? undefined : criteria,
      criterionDischarges: validatedCriterionDischarges(directory, state, criteria?.briefDigest), declaredInputs, projectDir, runDir: directory });
    for (const stage of stages) if (!roles.has(stage.role)) report.errors.push(`PLAN_REVISION_ROLE_UNKNOWN: ${stage.id}.role ${stage.role} is not configured`);
    const checksPath = join(directory, 'reality_checks.md');
    if (existsSync(checksPath)) report.errors.push(...inspectRealityCheckReachability({ markdown: readFileSync(checksPath, 'utf8'), projectDir, runDir: directory, stages, terminalStates: state.terminalStates, research: state.research }));
    report.pass = report.errors.length === 0;
    return report;
  }

  /** A single idle scheduling boundary; rejected amendments leave the current plan intact. */
  function consumePlanRevisions(sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, directory: string, workflow: WorkflowConfig, roles: Map<string, { name: string; description: string }>): StoreState {
    if (Object.values(state.stages).some((stage) => stage.status === STAGE_STATUS.RUNNING)) return state;
    const bootstrap = sorted.some((stage) => stage.dynamic_dispatch);
    if (!state.planControl && bootstrap) {
      // Bootstrap duties still obey scope, ownership and read binding. Criteria
      // coverage belongs to the future dispatch, not the planner-only shell.
      const byId = new Map(sorted.map((stage) => [stage.id, stage]));
      const errors = inspectArtifactDeclarations({ stages: sorted, projectDir, runDir: directory,
        scopeOwns: (stage, path) => stageScopeOwnsPath(byId.get(stage.id)!, path) });
      if (errors.length) {
        state.status = 'failed'; state.failureReason = errors.join('; '); state.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, state);
        return state;
      }
    }
    // A dynamic planner's complete proposal records its admitted plan at injection.
    // Static workflows have their complete topology at this initial boundary.
    if (!state.planControl && !bootstrap && sorted.every((stage) => stage.artifact_contract)) {
      const admission = admitRevisionCandidate(sorted, state, projectDir, directory, roles);
      if (admission.pass) {
        refreshRunQueryState(state, sorted);
        recordAdmittedPlan(state, sorted, directory, 'Initial typed workflow admitted', true, admission);
        writeRunState(projectDir, runId, state);
      } else {
        state.status = 'failed'; state.failureReason = admission.errors.join('; '); state.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, state);
        return state;
      }
    }
    for (const stage of [...sorted]) {
      if (!/^[a-z][a-z0-9_]{0,19}$/.test(stage.id)) continue;
      const requestPath = join(directory, 'stages', stage.id, 'plan_revision_request.json');
      if (!existsSync(requestPath)) continue;
      const text = readFileSync(requestPath, 'utf8');
      if (!text.trim()) continue; // untouched native write-capability slot
      const digest = createHash('sha256').update(text).digest('hex');
      const refusalPath = join(directory, 'stages', stage.id, `plan_revision_refusal_${digest}.json`);
      if (existsSync(refusalPath)) continue;
      try {
        const request = JSON.parse(text) as { requestId?: unknown; stageId?: unknown };
        if (request.stageId !== stage.id) throw new Error('PLAN_REVISION_STAGE_BINDING: request carrier and stageId differ');
        if (typeof request.requestId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(request.requestId)
          && existsSync(join(directory, 'stages', stage.id, `plan_revision_decision_${request.requestId}.json`))) continue;
        const result = applyPlanRevision({ projectDir, runId, request,
          parseStage: parseDispatchedStageConfig,
          admit: (candidate, current) => admitRevisionCandidate(candidate, current, projectDir, directory, roles),
          scopeContained: revisionScopeContained,
        });
        state = result.state;
        if (result.decision.pending) continue;
        if (result.decision.accepted && result.stages) {
          publishRevisedWorkflow(result.stages, sorted, state, projectDir, runId, directory, workflow);
        }
        recordRunEvent(projectDir, runId, { type: 'plan_revision_decided', runId, timestamp: result.decision.at, stageId: stage.id, requestId: result.decision.requestId, detail: result.decision.accepted ? `admitted revision ${result.decision.revision}: ${state.queryState?.planRevision?.reason}` : result.decision.errors.join('; '), source: 'scheduler' });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        atomicWrite(refusalPath, `${JSON.stringify({ version: 1, accepted: false, requestDigest: digest, reason }, null, 2)}\n`);
        recordRunEvent(projectDir, runId, { type: 'plan_revision_decided', runId, timestamp: new Date().toISOString(), stageId: stage.id, detail: reason, source: 'scheduler', level: 'warning' });
      }
    }
    refreshRunQueryState(state, sorted);
    writeRunState(projectDir, runId, state);
    return state;
  }
  return { consumePlanRevisions };
}
