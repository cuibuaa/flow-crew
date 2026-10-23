// Boundary: Compose existing typed admission, policy, scope and settlement services; exports individual effects, never a context or facade dependency.
import { createDispatchAdmission } from '../sched_admission/dispatch.js';
import { createReadyFinder } from '../sched_admission/frontier.js';
import { createApprovalMonitor } from '../sched_policy/approvals.js';
import { createCampaignWriters } from '../sched_policy/campaign.js';
import { createDispatchInjector } from '../sched_policy/dispatch-injection.js';
import { createBlockageConcluder } from '../sched_policy/guidance.js';
import { createResearchAdvancer } from '../sched_policy/research.js';
import { createTerminalEvaluator } from '../sched_policy/terminal.js';
import { listProjectFilesAt } from '../sched_scope/path-capabilities.js';
import { createScopeReconciler } from '../sched_scope/reconciliation.js';
import { createRepairDiffWriter } from '../sched_scope/repair-diff.js';
import { settleFrameworkRollbackPath } from '../sched_scope/rollback-baseline.js';
import { pendingScopePlanningInputs } from '../sched_scope/scope-planning.js';
import { createScopeSafeStageRunner } from '../sched_scope/stage-group.js';
import { createPlainCompletionArchiver } from '../sched_settlement/completion.js';
import { canonicalGateRoundArtifactDir, gateArchiveCoordinate } from '../sched_settlement/gate-archives.js';
import { loadGateContract } from '../sched_settlement/gate-contract.js';
import { createGateContractRefusalHandler } from '../sched_settlement/gate-recovery.js';
import { validationDeltaMatchesExecution, settledGateValidationExecution, validationExecutionId } from '../sched_settlement/gate-validation.js';
import { readGateEvaluation, readTerminalStudyCompletionEvidence } from '../sched_settlement/gate-verdict.js';
import { createPlanSettlement } from '../sched_settlement/scoped-repair.js';

export const findAllReady = createReadyFinder({ loadGateContract, readGateEvaluation });
export const inspectDispatchAdmission = createDispatchAdmission();
// Each unit captures only the services owned by the remaining scheduler.
export const { appendIterationLog, writeCampaignEntry, writeCampaignEntryUnlessPaused } = createCampaignWriters({ readGateEvaluation, readTerminalStudyCompletionEvidence, pendingScopePlanningInputs });
export const concludeRepeatedBlockage = createBlockageConcluder(writeCampaignEntry).concludeRepeatedBlockage;
export const { tryParkOnApprovalRequest, inspectApprovalRequests, monitorApprovalRequests } = createApprovalMonitor({ writeCampaignEntryUnlessPaused });
export const { tryAdvanceResearch } = createResearchAdvancer({ listProjectFilesAt, settleFrameworkRollbackPath, writeCampaignEntry });
export const { ensureTerminalArtifactValidation, tryTerminateOnTerminalState, concludeDeclaredTerminalAtQuiescence } = createTerminalEvaluator({ validationDeltaMatchesExecution, settledGateValidationExecution, validationExecutionId, writeCampaignEntry, concludeRepeatedBlockage });
export const { injectDispatchedStages } = createDispatchInjector({ inspectDispatchAdmission });
export const { writeRepairRoundDiffArtifact } = createRepairDiffWriter({ gateArchiveCoordinate, canonicalGateRoundArtifactDir });
export const { reconcileStageScope, reconcileCompletedStageAttempts } = createScopeReconciler();
export const { runScopeSafeStageGroup } = createScopeSafeStageRunner({ monitorApprovalRequests, reconcileCompletedStageAttempts });

// Settlement effects receive only their consumed service.
export const terminateForGateContractRefusal = createGateContractRefusalHandler(writeCampaignEntry);
export const archiveDeclaredOutputsBeforePlainCompletion = createPlainCompletionArchiver(writeCampaignEntry);
export const { consumePlanRevisions } = createPlanSettlement(inspectDispatchAdmission);
