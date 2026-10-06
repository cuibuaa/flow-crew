// Boundary: Admit audit finding repairs and idle-boundary plan amendments through the existing revision transaction; receives the shared full-dispatch admission predicate.
import { inspectArtifactDeclarations } from '../../artifact-declarations.js';
import { BriefCriteriaArtifact } from '../../brief-criteria.js';
import { RevisionAdmission, applyPlanRevision, recordAdmittedPlan } from '../../plan-revisions.js';
import { recordRunEvent } from '../../run-events.js';
import { AuditFindingsSchema, buildScopedRepair } from '../../scoped-audit-repair.js';
import { STAGE_STATUS, StoreState, atomicWrite, writeRunState } from '../../store.js';
import { StageConfig, WorkflowConfig, parseDispatchedStageConfig, refreshRunQueryState } from '../sched_admission/configuration.js';
import { readBriefCriteriaForAdmission, stageScopeOwnsPath, type createDispatchAdmission, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { parseDeclaredScope, topoSort } from '../sched_admission/frontier.js';
import { inspectRealityCheckReachability } from '../sched_admission/reality-reads.js';
import { resolveDeclaredInputWriteBindings, scopeRequestAlreadyAuthorized } from '../sched_scope/path-capabilities.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { GateRuntimeFacts } from './gate-recovery.js';

export function createPlanSettlement(inspectDispatchAdmission: ReturnType<typeof createDispatchAdmission>) {

  const revisionScopeContained = (scope: string, capabilities: readonly string[]): boolean =>
    capabilities.includes(scope) || scopeRequestAlreadyAuthorized(parseDeclaredScope(scope), capabilities.map(parseDeclaredScope));

  function publishRevisedWorkflow(stages: StageConfig[], sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, directory: string, workflow: WorkflowConfig): void {
    sorted.splice(0, sorted.length, ...topoSort(stages));
    refreshRunQueryState(state, sorted);
    writeRunState(projectDir, runId, state);
    atomicWrite(join(directory, 'workflow.yaml'), stringifyYaml({ ...workflow, stages: sorted }));
  }

  /** Turn settled declared audit findings into bounded revision transactions. */
  function admitScopedAuditRepairs(sorted: StageConfig[], state: StoreState, facts: GateRuntimeFacts, projectDir: string, runId: string, directory: string, workflow: WorkflowConfig, roles: Map<string, { name: string; description: string }>): StoreState {
    for (const evaluation of facts.evaluations) {
      if (evaluation.effectiveVerdict?.pass === true) {
        const findings = state.queryState?.findings ?? [];
        let changed = false;
        for (const finding of findings) if (finding.gateId === evaluation.id && finding.status === 'open') { finding.status = 'resolved'; changed = true; }
        if (changed) writeRunState(projectDir, runId, state);
        continue;
      }
      const gate = sorted.find((stage) => stage.id === evaluation.id);
      if (!gate || state.stages[gate.id]?.status !== STAGE_STATUS.COMPLETE || evaluation.authoredVerdict?.pass !== false) continue;
      const verdictPath = join(directory, `verdict_${gate.id}.json`);
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(readFileSync(verdictPath, 'utf8')) as Record<string, unknown>; } catch { continue; }
      if (raw.audit_findings === undefined) continue;
      const parsed = AuditFindingsSchema.safeParse(raw.audit_findings);
      if (!parsed.success) continue; // readGateVerdict records the precise malformed declaration refusal.
      state.queryState ??= { version: 1 };
      state.queryState.findings ??= [];
      const evidenceDirectory = join(directory, 'audit_findings');
      mkdirSync(evidenceDirectory, { recursive: true });
      const evidenceName = `${gate.id}_${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}.json`;
      const evidencePath = join(evidenceDirectory, evidenceName);
      if (!existsSync(evidencePath)) atomicWrite(evidencePath, `${JSON.stringify(raw, null, 2)}\n`);
      for (const finding of parsed.data.findings) {
        const id = `${gate.id}:${finding.id}`;
        if (!state.queryState.findings.some((entry) => entry.id === id)) state.queryState.findings.push({ id, status: 'open', paths: finding.paths, gateId: gate.id, reason: finding.reason, criterionIds: finding.criterion_ids, invalidatesPlan: finding.invalidates_plan, evidencePath: `audit_findings/${evidenceName}` });
      }
      writeRunState(projectDir, runId, state);
      if (parsed.data.findings.some((finding) => finding.invalidates_plan)) continue;
      for (const finding of parsed.data.findings) {
        const refusal = join(directory, `scoped_repair_refusal_${gate.id}_${finding.id}.json`);
        if (existsSync(refusal)) continue;
        try {
          if (!gate.artifact_contract?.produces.some((artifact) => artifact.root === 'run' && artifact.path === `verdict_${gate.id}.json`)) throw new Error('SCOPED_REPAIR_VERDICT_UNBOUND: authoring gate must declare its exact run verdict output');
          const repair = buildScopedRepair(gate, finding);
          if (sorted.some((stage) => stage.id === repair.id)) continue;
          const revision = state.queryState?.planRevision;
          const attempt = state.stages[gate.id]?.attempts?.at(-1);
          if (!revision || !attempt) throw new Error('SCOPED_REPAIR_PLAN_UNBOUND: admitted plan and settled gate execution are required');
          const result = applyPlanRevision({ projectDir, runId,
            request: { version: 1, requestId: repair.id, runId, stageId: gate.id, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, baseRevision: revision.revision, baseDigest: revision.digest, reason: `Scoped repair of ${gate.id} finding ${finding.id}: ${finding.reason}`, stages: [...sorted, repair] },
            parseStage: parseDispatchedStageConfig,
            admit: (candidate, current) => admitRevisionCandidate(candidate, current, projectDir, directory, roles),
            scopeContained: revisionScopeContained,
          });
          state = result.state;
          if (!result.decision.accepted || !result.stages) throw new Error(result.decision.errors.join('; '));
          publishRevisedWorkflow(result.stages, sorted, state, projectDir, runId, directory, workflow);
          recordRunEvent(projectDir, runId, { type: 'plan_revision_decided', runId, timestamp: result.decision.at, stageId: gate.id, requestId: repair.id, detail: `admitted scoped repair ${repair.id} revision ${result.decision.revision}`, source: 'scheduler' });
        } catch (error) {
          atomicWrite(refusal, `${JSON.stringify({ version: 1, findingId: finding.id, reason: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
        }
      }
    }
    return state;
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
  return { admitScopedAuditRepairs, consumePlanRevisions };
}
