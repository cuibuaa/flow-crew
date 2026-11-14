import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Collect gate facts and choose confirmed recovery routes. Contract refusal receives only the campaign publisher.
import { GateVerdict, RUN_STATUS, STAGE_STATUS, StoreState, isTerminalRunStatus, runDir } from '../../store.js';
import { StageConfig } from '../sched_admission/configuration.js';

import { isStageInSkippedBranch } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';



import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGateContract } from './gate-contract.js';
import { readGateEvaluation } from './gate-verdict.js';
import { projectGateVerdict, readGateVerdictDocument } from './gate-evidence.js';
import { archiveRejectedGateRuntimeFacts, archivedGateRejections, gateArchiveCoordinate } from './gate-archives.js';

export interface GateRuntimeFacts {
  allPass: boolean;
  failedGateIds: string[];
  /** Settled gates with a validated rejection; pending gates are excluded. */
  rejectedGateIds: string[];
  contractRefusals: Array<{ id: string; reason: string }>;
  evaluations: Array<{
    id: string;
    status?: string;
    attempts: number;
    authoredVerdict: GateVerdict | null;
    effectiveVerdict: GateVerdict | null;
    rejectionKind?: GateRecoveryFact['rejectionKind'];
  }>;
}

export interface GateRecoveryFact {
  gateId: string;
  authoredVerdict: GateVerdict | null;
  effectiveVerdict: GateVerdict | null;
  rejectionKind:
    | 'repairable_failure'
    | 'irreparable_rejection'
    | 'engine_contract_or_evidence_rejection'
    | 'unclassified_rejection';
}

export function classifyGateRecoveryFact(
  gateId: string,
  authoredVerdict: GateRecoveryFact['authoredVerdict'],
  effectiveVerdict: GateRecoveryFact['effectiveVerdict'],
): GateRecoveryFact {
  const kind = effectiveVerdict?.refusal?.kind;
  const rejectionKind: GateRecoveryFact['rejectionKind'] = kind === 'repairability'
    ? 'engine_contract_or_evidence_rejection'
    : effectiveVerdict?.repairability?.disposition === 'irreparable'
    ? 'irreparable_rejection'
    : effectiveVerdict?.pass === false
      && (effectiveVerdict.repairability?.disposition === 'repairable' || authoredVerdict?.pass === false)
    ? 'repairable_failure'
    : kind || authoredVerdict?.pass === true && effectiveVerdict?.pass === false
    ? 'engine_contract_or_evidence_rejection'
    : effectiveVerdict?.pass === false
    ? 'repairable_failure'
    : 'unclassified_rejection';
  return { gateId, authoredVerdict, effectiveVerdict, rejectionKind };
}

export function collectGateRuntimeFacts(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): GateRuntimeFacts {
  const stagesById = new Map(allStages.map(stage => [stage.id, stage]));
  const gateStages = uniqueGateStages(allStages).filter(stage => !isStageInSkippedBranch(stage.id, stagesById, state, 'settlement'));
  if (gateStages.length === 0) {
    return { allPass: true, failedGateIds: [], rejectedGateIds: [], contractRefusals: [], evaluations: [] };
  }
  // Load the campaign gate contract once per check; reused across all gates.
  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  const failedGateIds: string[] = [];
  const rejectedGateIds: string[] = [];
  const contractRefusals: GateRuntimeFacts['contractRefusals'] = [];
  const evaluations: GateRuntimeFacts['evaluations'] = [];
  for (const g of gateStages) {
    const gateStatus = state.stages[g.id]?.status;
    // Process completion and semantic acceptance are separate facts.
    if (gateStatus !== STAGE_STATUS.COMPLETE
      && !(gateStatus === STAGE_STATUS.FAILED && state.stages[g.id]?.gate?.refusal?.kind === 'validation_regression')) {
      failedGateIds.push(g.id);
      evaluations.push({ id: g.id, status: gateStatus, attempts: state.stages[g.id]?.attempts?.length ?? 0,
        authoredVerdict: null, effectiveVerdict: null });
      continue;
    }
    let authoredVerdict = readGateVerdictDocument(runId ? runDir(projectDir, runId) : join(projectDir, 'docs'), g.id)?.project() ?? null;
    if (!authoredVerdict && runId && !state.stages[g.id]?.gate && !state.stages[g.id]?.acceptedFrom) {
      const archived = archivedGateRejections(runDir(projectDir, runId), g.id).at(-1);
      try { authoredVerdict = projectGateVerdict(JSON.parse(readFileSync(archived!.verdictPath, 'utf8'))); }
      catch { /* No archived authored verdict. */ }
    }
    const verdict = readGateEvaluation(projectDir, g.id, runId, contract);
    const recoveryFact = classifyGateRecoveryFact(g.id, authoredVerdict, verdict);
    evaluations.push({
      id: g.id,
      status: gateStatus,
      attempts: state.stages[g.id]?.attempts?.length ?? 0,
      authoredVerdict,
      effectiveVerdict: verdict,
      ...(verdict?.pass === false ? { rejectionKind: recoveryFact.rejectionKind } : {}),
    });
    if (verdict && verdict.pass === true) continue; // explicit pass (contract-honored if any)
    // Missing verdict or explicit fail → treat as failure
    failedGateIds.push(g.id);
    if (verdict?.pass === false) {
      rejectedGateIds.push(g.id);
      if (verdict.refusal?.kind === 'numeric_evidence') {
        contractRefusals.push({ id: g.id, reason: verdict.reason ?? 'Missing numeric gate evidence' });
      }
    }
  }
  return {
    allPass: failedGateIds.length === 0,
    failedGateIds,
    rejectedGateIds,
    contractRefusals,
    evaluations,
  };
}

/** Find ALL retry_to stages that reference any of the failed gate IDs */
export function findAllRetryToStages(allStages: StageConfig[], failedGateIds: string[]): StageConfig[] {
  const failedSet = new Set(failedGateIds);
  return allStages.filter(s => referencesFailedGate(s, id => failedSet.has(id)));
}

/** Confirmed independent findings alone authorize admitted repair routes. */
export function findGateRecoveryStages(
  allStages: StageConfig[],
  rejectedGateIds: string[],
  rejectionFacts: Readonly<Record<string, GateRecoveryFact | undefined>> = {},
): StageConfig[] {
  const selected = new Map<string, StageConfig>();
  for (const gateId of rejectedGateIds) {
    const fact = rejectionFacts[gateId];
    const rejectionKind = fact?.rejectionKind ?? 'unclassified_rejection';

    if (rejectionKind === 'irreparable_rejection') continue;

    // Repair admission depends only on confirmed reviewer reproductions.
    // Comparison and other acceptance evidence do not enter this judgment.
    if (fact?.effectiveVerdict?.findings?.confirmed.length) {
      for (const repair of findAllRetryToStages(allStages, [gateId])) selected.set(repair.id, repair);
      continue;
    }


  }
  return [...selected.values()];
}

/** The authors whose results a gate reviews: its non-gate ancestors up to the nearest gates, which review the rest. */
export function gateReviewedAuthorIds(gate: StageConfig, allStages: StageConfig[]): string[] {
  const byId = new Map(allStages.map(stage => [stage.id, stage]));
  const reviewed = new Set<string>();
  const queue = [...(gate.depends_on ?? [])];
  while (queue.length > 0) {
    const stage = byId.get(queue.shift()!);
    if (!stage || stage.is_gate || reviewed.has(stage.id)) continue;
    reviewed.add(stage.id);
    queue.push(...(stage.depends_on ?? []));
  }
  return [...reviewed];
}

/** A gate confirms or rejects this author's result: one that reviews the author, or the gate its repair returns to. */
export function isGateReviewed(stage: StageConfig, allStages: StageConfig[]): boolean {
  return Boolean(stage.retry_to?.length) || allStages.some((gate) => gate.is_gate && gateReviewedAuthorIds(gate, allStages).includes(stage.id));
}

export function createGateContractRefusalHandler(writeCampaignEntry: (projectDir: string, state: StoreState) => void) {
  function terminateForGateContractRefusal(
    state: StoreState,
    facts: GateRuntimeFacts,
    projectDir: string,
    runId: string,
    iteration: number,
  ): boolean {
    const irreparable = facts.evaluations.filter((entry) => entry.rejectionKind === 'irreparable_rejection');
    if (facts.contractRefusals.length === 0 && irreparable.length === 0) return false;
    if (isTerminalRunStatus(state.status)) return true;
    if (irreparable.length > 0) archiveRejectedGateRuntimeFacts(runDir(projectDir, runId), gateArchiveCoordinate(iteration, 1), facts);
    const detail = irreparable.length > 0
      ? irreparable.map((entry) => `${entry.id}: ${entry.effectiveVerdict?.reason ?? 'gate rejected'}; ${entry.effectiveVerdict?.repairability?.evidence}`).join('; ')
      : facts.contractRefusals
      .map((refusal) => `${refusal.id}: ${refusal.reason}`)
      .join('; ');
    concludeRun(state, {
      status: irreparable.length > 0 ? RUN_STATUS.ESCALATED : RUN_STATUS.FAILED,
      reasonCode: irreparable.length > 0 ? 'irreparable_gate_rejection' : 'gate_contract_refusal',
      detail: `${irreparable.length > 0 ? 'Irreparable gate rejection' : 'Gate contract refusal'} before repair dispatch — ${detail}`,
      eventFields: () => ({ iteration, detail: state.failureReason }), writeCampaignEntry,
    });
    log.error({ runId, iteration, contractRefusals: facts.contractRefusals }, 'Gate contract refused before product repair');
    return true;
  }
  return terminateForGateContractRefusal;
}

function uniqueGateStages(allStages: StageConfig[]): StageConfig[] {
  const seen = new Set<string>();
  return allStages.filter((stage) => {
    if (!stage.is_gate || seen.has(stage.id)) return false;
    seen.add(stage.id);
    return true;
  });
}

function referencesFailedGate(stage: StageConfig, isFailed: (id: string) => boolean): boolean {
  return Boolean(stage.retry_to && stage.retry_to.some(isFailed));
}
