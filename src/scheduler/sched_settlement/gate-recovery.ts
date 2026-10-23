import { concludeRun } from '../sched_policy/run-completion.js';
// Boundary: Collect gate facts and choose exact recovery routes; project verified research settlement. Contract refusal receives only the campaign publisher.
import { resolveResearchPaths } from '../../research-paths.js';
import { GateVerdict, RUN_STATUS, ResearchConfig, STAGE_STATUS, StoreState, isTerminalRunStatus, runDir, stageDir } from '../../store.js';
import { RESEARCH_DECISION_STATUS_ALIASES, StageConfig } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport, stageScopeOwnsPath } from '../sched_admission/dispatch.js';
import { isStageInSkippedBranch, transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { appendSchedulerGuidanceOnce } from '../sched_policy/guidance.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract } from './gate-contract.js';
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
    | 'omitted_research_outcome'
    | 'engine_contract_or_evidence_rejection'
    | 'unclassified_rejection';
}

export function classifyGateRecoveryFact(
  gateId: string,
  authoredVerdict: GateRecoveryFact['authoredVerdict'],
  effectiveVerdict: GateRecoveryFact['effectiveVerdict'],
): GateRecoveryFact {
  const kind = effectiveVerdict?.refusal?.kind;
  const rejectionKind: GateRecoveryFact['rejectionKind'] = kind === 'validation_regression'
    ? 'repairable_failure'
    : kind === 'validation_unresolved' || kind === 'repairability'
    ? 'engine_contract_or_evidence_rejection'
    : effectiveVerdict?.repairability?.disposition === 'irreparable'
    ? 'irreparable_rejection'
    : effectiveVerdict?.pass === false
      && (effectiveVerdict.repairability?.disposition === 'repairable' || authoredVerdict?.pass === false)
    ? 'repairable_failure'
    : kind === 'research_outcome_absent'
    ? 'omitted_research_outcome'
    : kind || authoredVerdict?.pass === true && effectiveVerdict?.pass === false
    ? 'engine_contract_or_evidence_rejection'
    : effectiveVerdict?.pass === false
    ? 'repairable_failure'
    : 'unclassified_rejection';
  return { gateId, authoredVerdict, effectiveVerdict, rejectionKind };
}

/**
 * Return the non-passing entries from the same raw verdict selected by
 * readGateEvaluation. Undefined means that verdict supplied no structured
 * criterion map, so callers may fall back to admitted refs or the gate ID.
 */
export function structuredFailingGateCriteria(
  runDirPath: string,
  stageId: string,
): string[] | undefined {
  const verdict = readGateVerdictDocument(runDirPath, stageId)?.value;
  const rawCriteria = verdict?.criteria;
  if (!rawCriteria || typeof rawCriteria !== 'object' || Array.isArray(rawCriteria)) return undefined;
  const entries = Object.entries(rawCriteria as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  return entries.flatMap(([criterionId, evidence]) => {
    const status = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      && typeof (evidence as Record<string, unknown>).status === 'string'
      ? ((evidence as Record<string, unknown>).status as string).trim().toLowerCase()
      : '';
    return status === 'pass' ? [] : [criterionId];
  });
}

export function researchAdvanceEligible(input: {
  gatesSettled: boolean;
  stageFailed: boolean;
}): boolean {
  return input.gatesSettled && !input.stageFailed;
}

export interface GateRetryDiagnosticArtifact {
  file: string;
  pass?: boolean;
  parseError?: string;
}

export function gateRetryDiagnosticSnapshot(
  allStages: StageConfig[],
  state: StoreState,
  projectDir: string,
  runId: string,
  runDirPath: string,
  runtimeFacts: GateRuntimeFacts,
): {
  verdictArtifacts: GateRetryDiagnosticArtifact[];
  gates: Array<{
    id: string;
    status?: string;
    attempts: number;
    effectiveVerdict: GateVerdict | null;
    metricArtifact?: Record<string, unknown>;
    metricParseError?: string;
  }>;
  contract: GateContract | null;
} {
  const verdictArtifacts: GateRetryDiagnosticArtifact[] = [];
  let verdictFiles: string[] = [];
  try {
    verdictFiles = readdirSync(runDirPath)
      .filter((file) => /^verdict_.*\.json$/.test(file))
      .sort();
  } catch { /* run directory is expected to exist; retain an empty diagnostic on failure */ }
  for (const file of verdictFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(runDirPath, file), 'utf-8')) as Record<string, unknown>;
      verdictArtifacts.push({ file, ...(typeof parsed.pass === 'boolean' ? { pass: parsed.pass } : {}) });
    } catch (error) {
      verdictArtifacts.push({ file, parseError: error instanceof Error ? error.message : String(error) });
    }
  }

  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  const evaluations = new Map(runtimeFacts.evaluations.map((evaluation) => [evaluation.id, evaluation]));
  const gates = uniqueGateStages(allStages).map((stage) => {
    const status = state.stages[stage.id];
    const metricPath = join(runDirPath, 'stages', stage.id, 'metric.json');
    let metricArtifact: Record<string, unknown> | undefined;
    let metricParseError: string | undefined;
    if (existsSync(metricPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metricPath, 'utf-8')) as Record<string, unknown>;
        metricArtifact = Object.fromEntries([
          'hasMetric', 'metric', 'value', 'score', 'higherIsBetter', 'threshold', 'pass',
          'phaseComplete', 'phase_complete', 'nextPhase', 'next_phase',
        ].flatMap((key) => key in parsed ? [[key, parsed[key]]] : []));
      } catch (error) {
        metricParseError = error instanceof Error ? error.message : String(error);
      }
    }
    const evaluation = evaluations.get(stage.id);
    return {
      id: stage.id,
      status: status?.status,
      attempts: status?.attempts?.length ?? 0,
      effectiveVerdict: evaluation?.effectiveVerdict ?? null,
      ...(metricArtifact ? { metricArtifact } : {}),
      ...(metricParseError ? { metricParseError } : {}),
    };
  });
  return { verdictArtifacts, gates, contract };
}

export function collectGateRuntimeFacts(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): GateRuntimeFacts {
  const stagesById = new Map(allStages.map(stage => [stage.id, stage]));
  const gateStages = uniqueGateStages(allStages).filter(stage => !isStageInSkippedBranch(stage.id, stagesById, state));
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
      if (verdict.refusal?.kind === 'numeric_evidence' || verdict.refusal?.kind === 'validation_unresolved') {
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

export interface ResearchSettlementProjection {
  decision: 'ship' | 'stop_ceiling';
  terminalStatus: string;
  terminalPath: string;
  terminalOwner: string;
  gateId: string;
  verificationPassed: true;
  campaignSucceeded: boolean;
  evidenceDigest: string;
}

/**
 * Publish a terminal research decision from a completed settlement audit. The
 * gate's effective verdict answers "was verification successful?"; metric.pass
 * independently answers "did the campaign win?". A verified ceiling therefore
 * remains publishable while any failed effective gate blocks publication.
 */
export function recoverVerifiedResearchSettlement(
  allStages: StageConfig[],
  state: StoreState,
  projectDir: string,
  runId: string,
  runDirPath: string,
): ResearchSettlementProjection | null {
  if (!state.research || !state.terminalStates) return null;
  const runtime = collectGateRuntimeFacts(allStages, state, projectDir, runId);
  if (!runtime.allPass) return null;
  let admission: DispatchAdmissionReport;
  try {
    admission = JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return null;
  }
  if (!admission.pass) return null;

  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  for (const gate of [...allStages].reverse()) {
    if (!gate.is_gate || state.stages[gate.id]?.status !== STAGE_STATUS.COMPLETE) continue;
    const effective = readGateEvaluation(projectDir, gate.id, runId, contract);
    if (effective?.pass !== true) continue;
    let verdictBytes: Buffer;
    let metricBytes: Buffer;
    let verdict: Record<string, unknown>;
    let metric: Record<string, unknown>;
    try {
      verdictBytes = readFileSync(join(runDirPath, `verdict_${gate.id}.json`));
      metricBytes = readFileSync(join(stageDir(projectDir, runId, gate.id), 'metric.json'));
      verdict = JSON.parse(verdictBytes.toString('utf-8')) as Record<string, unknown>;
      metric = JSON.parse(metricBytes.toString('utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const phaseComplete = metric.phaseComplete === true || metric.phase_complete === true
      || verdict.phaseComplete === true || verdict.phase_complete === true;
    const metricOutcome = typeof metric.outcome === 'string' ? metric.outcome.trim() : '';
    const verdictOutcome = typeof verdict.outcome === 'string' ? verdict.outcome.trim() : metricOutcome;
    if (!phaseComplete || !metricOutcome || verdictOutcome !== metricOutcome || metricOutcome === 'continue') continue;
    const decision = RESEARCH_DECISION_STATUS_ALIASES.get(metricOutcome);
    if (decision !== 'ship' && decision !== 'stop_ceiling') continue;
    if (typeof metric.pass !== 'boolean') continue;
    const campaignSucceeded = metric.pass;
    // The terminal label and the domain comparison must agree. Audit success
    // remains independent: it authorizes publication of either truthful result.
    if ((decision === 'ship') !== campaignSucceeded) continue;
    const terminalPath = state.terminalStates[metricOutcome]?.paths?.[0];
    if (!terminalPath) continue;
    const terminalOwner = admission.terminalOwners[terminalPath];
    if (!terminalOwner || !allStages.some((stage) => stage.id === terminalOwner)) continue;
    const evidenceDigest = createHash('sha256')
      .update(verdictBytes)
      .update(metricBytes)
      .digest('hex');
    const projection: ResearchSettlementProjection = {
      decision,
      terminalStatus: metricOutcome,
      terminalPath,
      terminalOwner,
      gateId: gate.id,
      verificationPassed: true,
      campaignSucceeded,
      evidenceDigest,
    };
    const decisionPath = join(runDirPath, 'research_decision.json');
    let alreadyPublished = false;
    try {
      const existing = JSON.parse(readFileSync(decisionPath, 'utf-8')) as Record<string, unknown>;
      alreadyPublished = existing.evidenceDigest === evidenceDigest
        && existing.terminalPath === terminalPath
        && existing.terminalOwner === terminalOwner;
    } catch { /* first publication */ }
    if (!alreadyPublished) {
      writeFileSync(decisionPath, `${JSON.stringify({ version: 1, ...projection }, null, 2)}\n`, 'utf-8');
    }
    mkdirSync(join(runDirPath, 'signals'), { recursive: true });
    writeFileSync(join(runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
      version: 1,
      ...projection,
    }, null, 2)}\n`, 'utf-8');
    appendSchedulerGuidanceOnce(
      runDirPath,
      terminalOwner,
      `[research-settlement:${evidenceDigest}]`,
      `Audit ${gate.id} verified the terminal outcome while campaignSucceeded=${campaignSucceeded}. Read research_decision.json and write exactly ${terminalPath}; do not write another terminal path.`,
      Object.keys(state.stages),
    );
    return projection;
  }
  return null;
}

/** Check all is_gate stages. Preserve the established public result shape. */
export function checkGates(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): { allPass: boolean; failedGateIds: string[] } {
  const { allPass, failedGateIds } = collectGateRuntimeFacts(allStages, state, projectDir, runId);
  return { allPass, failedGateIds };
}

/** Find ALL retry_to stages that reference any of the failed gate IDs */
export function findAllRetryToStages(allStages: StageConfig[], failedGateIds: string[]): StageConfig[] {
  const failedSet = new Set(failedGateIds);
  return allStages.filter(s => referencesFailedGate(s, id => failedSet.has(id)));
}

/** Typed engine omissions may rerun an outcome producer; model prose cannot. */
export function findGateRecoveryStages(
  allStages: StageConfig[],
  rejectedGateIds: string[],
  research?: ResearchConfig,
  rejectionFacts: Readonly<Record<string, GateRecoveryFact | undefined>> = {},
): StageConfig[] {
  const byId = new Map(allStages.map((stage) => [stage.id, stage]));
  const selected = new Map<string, StageConfig>();
  const paths = research ? resolveResearchPaths(research) : undefined;
  const outcomePaths = paths ? [paths.resultFile, `${paths.resultFile}.no_candidate.json`] : [];
  for (const gateId of rejectedGateIds) {
    const fact = rejectionFacts[gateId];
    const rejectionKind = fact?.rejectionKind ?? 'unclassified_rejection';

    if (rejectionKind === 'irreparable_rejection') continue;

    // Evidence refusal cannot certify the product or justify an unchanged
    // model review. Mechanical validation settlement owns its own bounded work.
    if (rejectionKind === 'engine_contract_or_evidence_rejection') continue;

    if (rejectionKind === 'omitted_research_outcome' && research) {
      for (const candidate of allStages) {
        if (candidate.is_gate || candidate.retry_to?.length || candidate.dynamic_dispatch) continue;
        if (!transitivelyDependsOn(gateId, candidate.id, byId)) continue;
        if (!outcomePaths.some((path) => stageScopeOwnsPath(candidate, path))) continue;
        selected.set(candidate.id, candidate);
      }
      continue;
    }

    // A substantive rejection or measured regression requires product repair, so retain the declared retry_to repair route. Unknown legacy facts
    // also fail conservatively into that established route.
    for (const repair of findAllRetryToStages(allStages, [gateId])) {
      selected.set(repair.id, repair);
    }
  }
  return [...selected.values()];
}

export function gateIdsForRecoveryStages(
  allStages: StageConfig[],
  rejectedGateIds: readonly string[],
  recoveryStages: readonly StageConfig[],
  research?: ResearchConfig,
): string[] {
  const byId = new Map(allStages.map((stage) => [stage.id, stage]));
  const outcomePaths = research
    ? (() => {
        const paths = resolveResearchPaths(research);
        return [paths.resultFile, `${paths.resultFile}.no_candidate.json`];
      })()
    : [];
  return rejectedGateIds.filter((gateId) => recoveryStages.some((stage) => (
    (stage.is_gate && stage.id === gateId)
    || stage.retry_to?.includes(gateId)
    || (research !== undefined
      && !stage.is_gate
      && !stage.retry_to?.length
      && transitivelyDependsOn(gateId, stage.id, byId)
      && outcomePaths.some((path) => stageScopeOwnsPath(stage, path)))
  )));
}

/** The authors whose results a gate reviews: its non-gate ancestors up to the nearest gates, which review the rest. */
export function gateReviewedAuthorIds(gate: StageConfig, allStages: StageConfig[]): string[] {
  const byId = new Map(allStages.map((stage) => [stage.id, stage]));
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

/** Bind research outcome semantics only to a gate whose dependency closure
 * contains an ordinary stage that owns the mutable result/sidecar slot. */
export function isResearchOutcomeGate(
  stage: StageConfig,
  allStages: StageConfig[],
  research?: ResearchConfig,
): boolean {
  if (!research || !stage.is_gate) return false;
  const paths = resolveResearchPaths(research);
  const outcomePaths = [paths.resultFile, `${paths.resultFile}.no_candidate.json`];
  const byId = new Map(allStages.map((candidate) => [candidate.id, candidate]));
  return allStages.some((candidate) => (
    !candidate.is_gate
    && !candidate.retry_to?.length
    && !candidate.dynamic_dispatch
    && transitivelyDependsOn(stage.id, candidate.id, byId)
    && outcomePaths.some((path) => stageScopeOwnsPath(candidate, path))
  ));
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
