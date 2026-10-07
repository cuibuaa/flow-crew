// Boundary: Admit complete planner proposals through one refusal path with exact preflight and bounded retry evidence.
import { PreparedPlanRetryCandidate, planRetryPairDigest, planRetryPreflightRequirement, planRetryRequirement, preparePlanRetryCandidate, recordPlanRetryAdmission, recordPlanRetryRefusal } from '../../plan-retry-monotone.js';
import { demoteRealityCheckAdvisories, formatRealityCheckPreflightFindings, inspectRealityChecks, type RealityCheckPreflightReport } from '../../reality-check-preflight.js';
import { recordRunEvent } from '../../run-events.js';
import { StageConfig, StageConfigSchema, loadDefaults } from '../sched_admission/configuration.js';
import { archiveDispatchAdmissionRefusal, concludePlanRetryFailure, currentDispatchAdmissionReport, decideEmptyDispatchAction, decideRealityCheckPreflightAction, diagnoseEmptyDispatch, planRetryRequirementsFromAdmission, restoreAdmittedRealityChecks, writeRealityCheckPreflightArtifact } from '../sched_admission/dispatch-retry.js';
import { log } from '../sched_admission/shared.js';
import { observeStableBlockage } from '../sched_policy/guidance.js';
import { readRunValidationBaseline } from '../sched_settlement/gate-validation.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { STAGE_STATUS, StageStatus, StoreState, isPendingStageStatus, readRunState, runDir, writeRunState, writeStageStatus } from '../../store.js';
import { concludeRepeatedBlockage, injectDispatchedStages } from './services.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDispatchDocument } from '../../dispatch-document.js';

export function admitPlannerDispatches(
  sorted: StageConfig[], state: StoreState, projectDir: string, runId: string, runDirPath: string,
  roleRegistry: Map<string, {name: string; description: string}>,
  injectedDispatchStages: Set<string>, planStageRetries: Map<string, number>, taskDescription?: string,
): {kind: 'settled' | 'continue'; state: StoreState} {
    // Inject dispatched stages
    for (const stage of sorted) {
      if (stage.dynamic_dispatch && !injectedDispatchStages.has(stage.id) &&
          state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE) {
        const maxPlanRetries = Math.max(0, Math.floor(Number(loadDefaults(projectDir).plan_stage_retries)));
        const retriesUsed = planStageRetries.get(stage.id) ?? 0;
        let preparedPlanRetry: PreparedPlanRetryCandidate;
        try {
          preparedPlanRetry = preparePlanRetryCandidate({
            runDirPath,
            stageId: stage.id,
            iteration: state.currentIteration ?? 1,
            attemptIndex: retriesUsed + 1,
          });
        } catch (error) {
          const reason = `Plan retry incumbent integrity check failed before admission: ${error instanceof Error ? error.message : String(error)}`;
          return { kind: 'settled', state: concludePlanRetryFailure({ state, projectDir, runId, stageId: stage.id, reason }) };
        }
        const plannerChecksPath = join(runDirPath, 'reality_checks.md');
        let exactTaskBrief = state.taskDescription ?? taskDescription ?? '';
        try {
          const persistedBriefPath = join(runDirPath, 'task_brief.md');
          if (existsSync(persistedBriefPath)) exactTaskBrief = readFileSync(persistedBriefPath, 'utf-8');
        } catch { /* state.taskDescription remains the admitted fallback */ }

        let preflight: RealityCheckPreflightReport | undefined;
        if (exactTaskBrief.trim()) {
          const plannerChecks = existsSync(plannerChecksPath)
            ? readFileSync(plannerChecksPath, 'utf-8')
            : '';
          const validationBaseline = readRunValidationBaseline(runDirPath)?.baseline
            ?? readShipSetupReadyValidationBaseline(projectDir, exactTaskBrief);
          const artifactContracts: NonNullable<StageConfig['artifact_contract']>[] = [];
          try {
            const items = readDispatchDocument(preparedPlanRetry.effective.dispatch).stages;
            if (Array.isArray(items)) for (const item of items) {
              const parsed = StageConfigSchema.safeParse(item);
              if (parsed.success && parsed.data.artifact_contract && !parsed.data.condition && !parsed.data.retry_to?.length) artifactContracts.push(parsed.data.artifact_contract);
            }
          } catch { /* Whole-plan admission owns malformed dispatch diagnostics. */ }
          preflight = inspectRealityChecks(exactTaskBrief, plannerChecks, {
            validationBaseline,
            projectDir,
            artifactContracts,
          });
          if (preflight.advisoryFindings.length > 0) {
            const rewrite = demoteRealityCheckAdvisories(plannerChecks, preflight.advisoryFindings);
            if (rewrite.markdown !== plannerChecks) {
              writeFileSync(plannerChecksPath, rewrite.markdown, 'utf-8');
              preparedPlanRetry.effective = {
                ...preparedPlanRetry.effective,
                realityChecks: rewrite.markdown,
              };
              preparedPlanRetry.effectivePairDigest = planRetryPairDigest(preparedPlanRetry.effective);
            }
            writeRealityCheckPreflightArtifact(
              runDirPath,
              stage.id,
              preflight,
              preflight.refusingFindings.length ? 'refused' : 'admitted_with_advisories',
              rewrite.demotedCheckIndexes,
            );
            const detail = formatRealityCheckPreflightFindings(preflight.advisoryFindings);
            log.warn(
              { stage: stage.id, demotedCheckIndexes: rewrite.demotedCheckIndexes, detail },
              'Planner Reality-Gate intent findings admitted as runtime advisories before dispatch',
            );
            recordRunEvent(projectDir, runId, {
              type: 'reality_gate_advisory',
              runId,
              timestamp: new Date().toISOString(),
              iteration: state.currentIteration ?? 1,
              stageId: stage.id,
              level: 'warning',
              detail: `Pre-dispatch lint demoted check indexes ${rewrite.demotedCheckIndexes.join(', ') || 'none'} to advisory: ${detail}`,
            });
          } else {
            writeRealityCheckPreflightArtifact(runDirPath, stage.id, preflight, preflight.refusingFindings.length ? 'refused' : 'admitted');
          }
        }

        injectedDispatchStages.add(stage.id);
        const injected = injectDispatchedStages(stage.id, roleRegistry, sorted, state, projectDir, runId, false, preflight);

        if (injected.length === 0) {
          if (state.admittedRealityChecks) restoreAdmittedRealityChecks(runDirPath, state);
          // Check if there are static fallback stages
          const hasStaticFollowUp = sorted.some(s =>
            s.id !== stage.id && state.stages[s.id] && isPendingStageStatus(state.stages[s.id].status)
          );
          if (!hasStaticFollowUp || preflight?.refusingFindings.length) {
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
                    ...archivedRefusal.report.errors.map((error) => `- ${error}`),
                    `Durable rejected proposal: ${join(runDirPath, archivedRefusal.proposalPath)}`,
                    `Durable admission report: ${join(runDirPath, archivedRefusal.admissionPath)}`,
                  ].join('\n'),
                }
              : structuralDiagnosis;
            const admissionReport = archivedRefusal?.report ?? currentDispatchAdmissionReport(runDirPath);
            const unsatisfied = [
              ...(admissionReport?.errors.length ? planRetryRequirementsFromAdmission(admissionReport) : [planRetryRequirement(diagnosis.detail, 'structure')]),
              ...(preflight?.refusingFindings ?? []).map((finding) => planRetryPreflightRequirement({ ...finding, detail: finding.message })),
            ];
            let ratchet;
            try {
              ratchet = recordPlanRetryRefusal({
                runDirPath,
                prepared: preparedPlanRetry,
                maxAttempts: maxPlanRetries + 1,
                unsatisfied,
                stopOnRepeat: !preflight?.refusingFindings.length,

              });
            } catch (error) {
              const reason = `Plan retry incumbent integrity check failed while recording an admission refusal: ${error instanceof Error ? error.message : String(error)}`;
              return { kind: 'settled', state: concludePlanRetryFailure({ state, projectDir, runId, stageId: stage.id, reason }) };
            }
            const blockage = observeStableBlockage({
              runDirPath,
              kind: preflight?.refusingFindings.length ? 'planner_reality_preflight' : 'planner_dispatch_refusal',
              stageId: stage.id,
              detail: preflight?.refusingFindings.length ? preflight.refusingFindings.map(finding => finding.code).sort().join(',') : diagnosis.transient ? 'transient invalid dispatch' : 'unresolvable dispatch roles',
              evidenceDigest: createHash('sha256')
                .update(preflight?.refusingFindings.length ? JSON.stringify(preflight.refusingFindings.map(({ code, checkIndex, checkName, checkType, evidence }) => ({ code, checkIndex, checkName, checkType, evidence }))) : rawDispatchText ?? '<missing dispatch>', 'utf8')
                .digest('hex'),
              threshold: state.campaignTriggers?.repeatedFailureAfter,
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
            const decision = preflight?.refusingFindings.length
              ? decideRealityCheckPreflightAction(preflight.refusingFindings, retriesUsed, maxPlanRetries)
              : decideEmptyDispatchAction(diagnosis, retriesUsed, maxPlanRetries);

            if (decision.action === 'retry') {
              // Re-pend against the observed refusal. The next complete proposal
              // is admitted independently; evidence never rewrites its bytes.
              planStageRetries.set(stage.id, decision.nextRetry);
              injectedDispatchStages.delete(stage.id); // allow re-injection after the re-run
              const replanStatus: StageStatus = {
                ...state.stages[stage.id],
                status: STAGE_STATUS.PENDING,
                retries: decision.nextRetry,
                error: decision.error,
              };
              writeStageStatus(projectDir, runId, stage.id, replanStatus);
              state.stages[stage.id] = replanStatus;
              writeRunState(projectDir, runId, state);
              log.warn({ stage: stage.id, retry: decision.nextRetry, max: maxPlanRetries, detail: decision.detail }, 'Plan stage emitted no valid dispatch — bounded re-plan retry');
              recordRunEvent(projectDir, runId, {
                type: 'plan_dispatch_retry',
                runId,
                timestamp: new Date().toISOString(),
                iteration: state.currentIteration ?? 1,
                stageId: stage.id,
                detail: `plan retry ${decision.nextRetry}/${maxPlanRetries}: ${decision.detail}`,
              });
              break; // restart the while(true) loop → ready stages now include the re-pended plan stage
            }

            // Escalate with specifics (NOT the generic "refine the brief" punt).
            log.error({ stage: stage.id, status: decision.status, unknownRoles: diagnosis.unknownRoles }, decision.reason);
            state.status = decision.status;
            state.failureReason = decision.reason;
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            recordRunEvent(projectDir, runId, {
              type: 'run_completed',
              runId,
              timestamp: state.completedAt,
              iteration: state.currentIteration ?? 1,
              stageId: stage.id,
              detail: `${decision.status}: ${decision.reason}`,
            });
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
