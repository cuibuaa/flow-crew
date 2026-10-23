import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Admit complete planner proposals through one refusal path with bounded retry evidence.
import { PreparedPlanRetryCandidate, planRetryRequirement, preparePlanRetryCandidate, recordPlanRetryAdmission, recordPlanRetryRefusal } from '../../plan-retry-monotone.js';
import { attemptEventFields, recordRunEvent } from '../../run-events.js';
import { StageConfig, loadDefaults } from '../sched_admission/configuration.js';
import { archiveDispatchAdmissionRefusal, concludePlanRetryFailure, currentDispatchAdmissionReport, decideEmptyDispatchAction, diagnoseEmptyDispatch, planRetryRequirementsFromAdmission, restoreAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { log } from '../sched_admission/shared.js';
import { observeStableBlockage } from '../sched_policy/guidance.js';
import { STAGE_STATUS, StageStatus, StoreState, isPendingStageStatus, readRunState, runDir, writeRunState, writeStageStatus } from '../../store.js';
import { concludeRepeatedBlockage, injectDispatchedStages } from './services.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function admitPlannerDispatches(
  sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, runDirPath: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  injectedDispatchStages: Set<string>,
): {kind: 'settled' | 'continue'; state: StoreState} {
    // Inject dispatched stages
    for (const stage of sorted) {
      if (stage.dynamic_dispatch && !injectedDispatchStages.has(stage.id) &&
          state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE) {
        const maxPlanRetries = Math.max(0, Math.floor(Number(loadDefaults().plan_stage_retries)));
        let preparedPlanRetry: PreparedPlanRetryCandidate;
        try {
          preparedPlanRetry = preparePlanRetryCandidate({
            runDirPath,
            stageId: stage.id,
            iteration: state.currentIteration ?? 1,
            attemptIndex: 1,
          });
        } catch (error) {
          const reason = `Plan retry incumbent integrity check failed before admission: ${error instanceof Error ? error.message : String(error)}`;
          return { kind: 'settled', state: concludePlanRetryFailure({ state, projectDir, runId, stageId: stage.id, reason }) };
        }
        injectedDispatchStages.add(stage.id);
        const injected = injectDispatchedStages(stage.id, roleRegistry, sorted, state, projectDir, runId);

        if (injected.length === 0) {
          if (state.admittedRealityChecks) restoreAdmittedRealityChecks(runDirPath, state);
          // Check if there are static fallback stages
          const hasStaticFollowUp = sorted.some(s =>
            s.id !== stage.id && state.stages[s.id] && isPendingStageStatus(state.stages[s.id].status)
          );
          if (!hasStaticFollowUp) {
            const refusedAttempt = state.stages[stage.id]?.attempts?.at(-1);
            if (refusedAttempt && refusedAttempt.disposition !== 'discarded') {
              refusedAttempt.disposition = 'discarded';
              writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
              recordRunEvent(projectDir, runId, {
                type: 'attempt_results_updated', runId, timestamp: new Date().toISOString(),
                stageId: stage.id, ...attemptEventFields(refusedAttempt), source: 'scheduler',
                detail: 'planner result refused by dispatch admission',
              });
            }
            // A dynamic_dispatch (plan) stage exited 0 (worker.ts marks exit-0
            // 'complete' with no semantic check) but produced ZERO valid injected
            // stages and there is no static follow-up. This is usually a TRANSIENT
            // LLM flake (truncated/empty/unparseable dispatch.yaml) — previously
            // fatal, which punted to the human and bypassed the re-plan + retry
            // machinery. Make it a BOUNDED RETRY of the plan stage instead, and
            // only escalate (with the SPECIFIC parse/unknown-role detail) once the
            // budget is exhausted — or immediately if the failure is genuine (every
            // stage names an unknown role: re-planning the same brief just repeats it).
            const dispatchPath = join(runDir(projectDir, runId), 'dispatch.yaml');
            const dispatchExists = existsSync(dispatchPath);
            let rawDispatchText: string | null = null;
            if (dispatchExists) { try { rawDispatchText = readFileSync(dispatchPath, 'utf-8'); } catch { /* best effort */ } }
            const structuralDiagnosis = diagnoseEmptyDispatch(dispatchExists, rawDispatchText, [...roleRegistry.keys()]);
            const archivedRefusal = dispatchExists && rawDispatchText !== null && structuralDiagnosis.transient
              ? archiveDispatchAdmissionRefusal({
                  runDirPath,
                  stageId: stage.id,
                  attemptIndex: preparedPlanRetry.attemptIndex,
                  rawDispatchText,
                })
              : undefined;
            const diagnosis = archivedRefusal
              ? {
                  transient: true,
                  unknownRoles: [],
                  detail: [
                    'dispatch admission rejected the complete proposal before stage injection.',
                    'Exact admission errors:',
                    ...archivedRefusal.report.errors.map((error) => `- ${error.message}`),
                    `Durable rejected proposal: ${join(runDirPath, archivedRefusal.proposalPath)}`,
                    `Durable admission report: ${join(runDirPath, archivedRefusal.admissionPath)}`,
                  ].join('\n'),
                }
              : structuralDiagnosis;
            const admissionReport = archivedRefusal?.report ?? currentDispatchAdmissionReport(runDirPath);
            const unsatisfied = [
              ...(admissionReport?.errors.length ? planRetryRequirementsFromAdmission(admissionReport) : [planRetryRequirement({ code: 'dispatch_structure', field: 'stages', message: diagnosis.detail }, 'structure')]),
            ];
            let ratchet;
            try {
              ratchet = recordPlanRetryRefusal({
                runDirPath,
                prepared: preparedPlanRetry,
                maxAttempts: maxPlanRetries + 1,
                unsatisfied,

              });
            } catch (error) {
              const reason = `Plan retry incumbent integrity check failed while recording an admission refusal: ${error instanceof Error ? error.message : String(error)}`;
              return { kind: 'settled', state: concludePlanRetryFailure({ state, projectDir, runId, stageId: stage.id, reason }) };
            }
            const blockage = observeStableBlockage({
              runDirPath,
              kind: 'planner_dispatch_refusal',
              stageId: stage.id,
              detail: diagnosis.transient ? 'transient invalid dispatch' : 'unresolvable dispatch roles',
              evidenceDigest: createHash('sha256')
                .update(rawDispatchText ?? '<missing dispatch>', 'utf8')
                .digest('hex'),
            });
            if (blockage?.escalatedNow) {
              return { kind: 'settled', state: concludeRepeatedBlockage(state, {
                projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1,
              }) ?? state };
            }
            if (ratchet.stop) {
              return { kind: 'settled', state: concludePlanRetryFailure({
                state,
                projectDir,
                runId,
                stageId: stage.id,
                reason: ratchet.reason ?? `Planner could not satisfy ${unsatisfied.map((item) => item.id).join(', ')}`,
              }) };
            }
            const decision = decideEmptyDispatchAction(diagnosis);

            if (decision.action === 'retry') {
              // Re-pend against the observed refusal. The next complete proposal
              // is admitted independently; evidence never rewrites its bytes.
              const nextRetry = ratchet.state.attempts.length;
              injectedDispatchStages.delete(stage.id); // allow re-injection after the re-run
              const replanStatus: StageStatus = {
                ...state.stages[stage.id],
                status: STAGE_STATUS.PENDING,
                retries: nextRetry,
                error: diagnosis.detail,
                admissionFailure: { code: 'dispatch_refused', attemptIndex: state.stages[stage.id].attempts?.at(-1)?.index ?? 0 },
              };
              writeStageStatus(projectDir, runId, stage.id, replanStatus);
              state.stages[stage.id] = replanStatus;
              writeRunState(projectDir, runId, state);
              log.warn({ stage: stage.id, retry: nextRetry, max: maxPlanRetries, detail: decision.detail }, 'Plan stage emitted no valid dispatch — bounded re-plan retry');
              recordRunEvent(projectDir, runId, {
                type: 'plan_dispatch_retry',
                runId,
                timestamp: new Date().toISOString(),
                iteration: state.currentIteration ?? 1,
                stageId: stage.id,
                detail: `plan retry ${nextRetry}/${maxPlanRetries}: ${decision.detail}`,
              });
              break; // restart the while(true) loop → ready stages now include the re-pended plan stage
            }

            // Escalate with specifics (NOT the generic "refine the brief" punt).
            log.error({ stage: stage.id, status: decision.status, unknownRoles: diagnosis.unknownRoles }, decision.reason);
            state = concludeRun(state, { status: decision.status, reasonCode: 'dispatch_refused', detail: decision.reason, eventFields: () => ({
              iteration: state.currentIteration ?? 1,
              stageId: stage.id,
              detail: `${decision.status}: ${decision.reason}`,
            }) });
            return { kind: 'settled', state };
          }
          log.info({ stage: stage.id }, 'No dispatch.yaml — falling back to static stages');
        } else {
          try {
            recordPlanRetryAdmission({
              runDirPath,
              prepared: preparedPlanRetry,

            });
          } catch (error) {
            const reason = `Plan retry incumbent integrity check failed while recording admission: ${error instanceof Error ? error.message : String(error)}`;
            return { kind: 'settled', state: concludePlanRetryFailure({ state, projectDir, runId, stageId: stage.id, reason }) };
          }
        }

        state = readRunState(projectDir, runId);
      }
    }
  return {kind: 'continue', state};
}
