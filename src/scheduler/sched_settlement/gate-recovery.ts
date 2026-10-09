// Boundary: Collect gate facts and choose exact recovery routes; project verified research settlement. Contract refusal receives only the campaign publisher.
import { resolveResearchPaths } from '../../research-paths.js';
import { recordRunEvent } from '../../run-events.js';
import { GateVerdict, RUN_STATUS, ResearchConfig, STAGE_STATUS, StoreState, isTerminalRunStatus, runDir, stageDir, writeRunState } from '../../store.js';
import { RESEARCH_DECISION_STATUS_ALIASES, StageConfig } from '../sched_admission/configuration.js';
import { DispatchAdmissionReport, stageScopeOwnsPath } from '../sched_admission/dispatch.js';
import { transitivelyDependsOn } from '../sched_admission/frontier.js';
import { log } from '../sched_admission/shared.js';
import { CAMPAIGN_PHASE_COMPLETE_SENTINEL, findCampaignPhaseMetadata } from '../sched_policy/campaign.js';
import { appendSchedulerGuidanceOnce } from '../sched_policy/guidance.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateContract, loadGateContract } from './gate-contract.js';
import { readGateVerdict } from './gate-verdict.js';
import { gateVerdictContentDigest, projectGateVerdict, readWrittenGateVerdict, validateSettledGateVerdict } from './gate-evidence.js';
import { archiveRejectedGateRuntimeFacts, gateArchiveCoordinate } from './gate-archives.js';

export interface GateRuntimeFacts {
  allPass: boolean;
  failedGateIds: string[];
  /** Completed gates with a validated pass:false fact; pending gates are excluded. */
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
    | 'authored_substantive_failure'
    | 'irreparable_rejection'
    | 'omitted_research_outcome'
    | 'engine_contract_or_evidence_rejection'
    | 'unclassified_rejection';
}

export function readAuthoredGateVerdict(
  projectDir: string,
  stageId: string,
  runId?: string,
): GateVerdict | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  const value = readWrittenGateVerdict(base, stageId);
  return value ? projectGateVerdict(value) : null;
}

export function classifyGateRecoveryFact(
  gateId: string,
  authoredVerdict: GateRecoveryFact['authoredVerdict'],
  effectiveVerdict: GateRecoveryFact['effectiveVerdict'],
): GateRecoveryFact {
  const reason = effectiveVerdict?.reason;
  const explicitEngineContractRejection = authoredVerdict?.pass === true
    && effectiveVerdict?.pass === false
    && /^(?:Gate contract violation:|Gate criterion contract violation:|Gate verdict contradiction:|Validation baseline delta\b)/i.test(reason ?? '');
  const rejectionKind: GateRecoveryFact['rejectionKind'] = effectiveVerdict?.contractViolation
    ? 'engine_contract_or_evidence_rejection'
    : authoredVerdict?.pass === false
    && effectiveVerdict?.pass === false && effectiveVerdict.repairability?.disposition === 'irreparable'
    ? 'irreparable_rejection'
    : explicitEngineContractRejection
    ? 'engine_contract_or_evidence_rejection'
    : rejectionReportsOmittedOutcome(reason)
      ? 'omitted_research_outcome'
      : authoredVerdict?.pass === false
      ? 'authored_substantive_failure'
      : authoredVerdict?.pass === true && effectiveVerdict?.pass === false
        ? 'engine_contract_or_evidence_rejection'
        : 'unclassified_rejection';
  return { gateId, authoredVerdict, effectiveVerdict, rejectionKind };
}

/**
 * Return the non-passing entries from the same raw verdict selected by
 * readGateVerdict. Undefined means that verdict supplied no structured
 * criterion map, so callers may fall back to admitted refs or the gate ID.
 */
export function structuredFailingGateCriteria(
  runDirPath: string,
  stageId: string,
): string[] | undefined {
  const verdict = readWrittenGateVerdict(runDirPath, stageId);
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
  supervisorRejectPending: boolean;
}): boolean {
  return input.gatesSettled && !input.stageFailed && !input.supervisorRejectPending;
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
  const gateStages = uniqueGateStages(allStages);
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
    // A gate only passes after it completed and wrote an explicit pass verdict.
    // Pending/running/skipped/missing gates must block run completion.
    if (gateStatus !== STAGE_STATUS.COMPLETE) {
      failedGateIds.push(g.id);
      evaluations.push({
        id: g.id,
        status: gateStatus,
        attempts: state.stages[g.id]?.attempts?.length ?? 0,
        authoredVerdict: null,
        effectiveVerdict: null,
      });
      continue;
    }
    const authoredVerdict = readAuthoredGateVerdict(projectDir, g.id, runId);
    let verdict = readGateVerdict(projectDir, g.id, runId, contract);
    if (verdict?.repairability && (!g.artifact_contract?.produces.some((artifact) => artifact.root === 'run'
        && artifact.path === `verdict_${g.id}.json` && artifact.kind === 'file' && !artifact.when)
        || !runId || validateSettledGateVerdict(runDir(projectDir, runId), runId, g.id, state.stages[g.id]?.attempts?.at(-1), gateVerdictContentDigest(verdict)))) {
      verdict = { pass: false, contractViolation: 'repairability', reason: 'Gate contract violation: repairability requires the exact declared unchanged verdict and protected receipt of the current settled completed gate execution; rerun the gate' };
    }
    const recoveryFact = classifyGateRecoveryFact(g.id, authoredVerdict, verdict);
    evaluations.push({
      id: g.id,
      status: gateStatus,
      attempts: state.stages[g.id]?.attempts?.length ?? 0,
      authoredVerdict,
      effectiveVerdict: verdict ? {
        ...projectGateVerdict(verdict as unknown as Record<string, unknown>),
        ...(verdict.contractViolation ? { contractViolation: verdict.contractViolation } : {}),
      } : null,
      ...(verdict?.pass === false ? { rejectionKind: recoveryFact.rejectionKind } : {}),
    });
    if (verdict && verdict.pass === true) continue; // explicit pass (contract-honored if any)
    // Missing verdict or explicit fail → treat as failure
    failedGateIds.push(g.id);
    if (verdict?.pass === false) {
      rejectedGateIds.push(g.id);
      if (verdict.reason?.startsWith('Gate contract violation: missing required numeric gate value')) {
        contractRefusals.push({ id: g.id, reason: verdict.reason });
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
    const effective = readGateVerdict(projectDir, gate.id, runId, contract, false);
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

/** Find the retry_to stage that references any of the failed gate IDs */
export function findRetryToStage(allStages: StageConfig[], failedGateIds: string[]): StageConfig | null {
  const failedSet = new Set(failedGateIds);
  for (const s of allStages) {
    if (referencesFailedGate(s, id => failedSet.has(id))) return s;
  }
  return null;
}

/** Find ALL retry_to stages that reference any of the failed gate IDs */
export function findAllRetryToStages(allStages: StageConfig[], failedGateIds: string[]): StageConfig[] {
  const failedSet = new Set(failedGateIds);
  return allStages.filter(s => referencesFailedGate(s, id => failedSet.has(id)));
}

export const OMITTED_OUTCOME_REJECTION = /(?:\b(?:no|missing|absent|unavailable)\b.{0,80}\b(?:measurement|measured result|result|outcome|evidence)\b|\b(?:measurement|measured result|outcome)\b.{0,80}\b(?:missing|absent|unavailable)\b)/i;

export const NEGATED_OUTCOME_OMISSION = /(?:\b(?:no|not|without)\s+(?:longer\s+)?(?:missing|absent|unavailable)\b.{0,80}\b(?:measurement|measured result|result|outcome|evidence)\b|\bno\s+(?:measurement|measured result|result|outcome|evidence)\b.{0,40}\b(?:is|are|was|were|remains?)\s+(?:missing|absent|unavailable)\b|\b(?:measurement|measured result|result|outcome|evidence)\b.{0,40}\b(?:is|are|was|were|remains?)\s+(?:not|no longer)\s+(?:missing|absent|unavailable)\b)/i;

export function rejectionReportsOmittedOutcome(reason: string | undefined): boolean {
  if (!reason || NEGATED_OUTCOME_OMISSION.test(reason)) return false;
  return OMITTED_OUTCOME_REJECTION.test(reason);
}

/** Add a completed research outcome producer only when the gate's effective
 * reason says the outcome itself is absent. Ordinary report-quality rejection
 * continues to select only retry_to repair stages. */
export function findGateRecoveryStages(
  allStages: StageConfig[],
  rejectedGateIds: string[],
  rejectionReasons: Readonly<Record<string, string | undefined>>,
  research?: ResearchConfig,
  rejectionFacts: Readonly<Record<string, GateRecoveryFact | undefined>> = {},
): StageConfig[] {
  const byId = new Map(allStages.map((stage) => [stage.id, stage]));
  const selected = new Map<string, StageConfig>();
  const paths = research ? resolveResearchPaths(research) : undefined;
  const outcomePaths = paths ? [paths.resultFile, `${paths.resultFile}.no_candidate.json`] : [];
  for (const gateId of rejectedGateIds) {
    const fact = rejectionFacts[gateId];
    const rejectionKind = fact?.rejectionKind
      ?? (rejectionReportsOmittedOutcome(rejectionReasons[gateId])
        ? 'omitted_research_outcome'
        : 'unclassified_rejection');

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

    // An authored substantive failure still means the product work was judged
    // bad, so retain the declared retry_to repair route. Unknown legacy facts
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

export function lastGatePassed(state: StoreState, dispatchedStageIds: string[], allStages: StageConfig[], projectDir?: string, runId?: string): boolean {
  // If there are is_gate stages, use verdict-based checking
  const gateStages = allStages.filter(s => s.is_gate && dispatchedStageIds.includes(s.id));
  if (gateStages.length > 0 && projectDir) {
    const { allPass } = checkGates(gateStages, state, projectDir, runId);
    return allPass;
  }

  // No is_gate stages: check verdict.json (legacy) then exit codes
  if (projectDir) {
    const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
    const verdictPath = join(base, 'verdict.json');
    try {
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      return verdict.pass === true;
    } catch { /* no verdict.json — fall through to exit code check */ }
  }

  // Find terminal stages
  const hasDependent = new Set<string>();
  for (const s of allStages) {
    if (dispatchedStageIds.includes(s.id)) {
      for (const dep of s.depends_on ?? []) {
        if (dispatchedStageIds.includes(dep)) hasDependent.add(dep);
      }
    }
  }
  const terminalIds = dispatchedStageIds.filter(id => !hasDependent.has(id));
  if (terminalIds.length === 0) return true;

  return terminalIds.every(id => {
    const ss = state.stages[id];
    if (!ss) return false;
    if (ss.status === STAGE_STATUS.SKIPPED) return true;
    return ss.status === STAGE_STATUS.COMPLETE && (ss.exitCode === undefined || ss.exitCode === 0);
  });
}

export function shouldContinuePhaseAfterGatePass(projectDir: string, state: StoreState): boolean {
  const phase = findCampaignPhaseMetadata(projectDir, state);
  if (!phase) return false;
  if (phase.phaseComplete === false) return true;
  const nextPhase = phase.nextPhase?.trim().toLowerCase();
  return phase.phaseComplete === true && Boolean(nextPhase && nextPhase !== CAMPAIGN_PHASE_COMPLETE_SENTINEL);
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
    state.status = irreparable.length > 0 ? RUN_STATUS.ESCALATED : RUN_STATUS.FAILED;
    state.failureReason = `${irreparable.length > 0 ? 'Irreparable gate rejection' : 'Gate contract refusal'} before repair dispatch — ${detail}`;
    state.completedAt = new Date().toISOString();
    writeRunState(projectDir, runId, state);
    writeCampaignEntry(projectDir, state);
    recordRunEvent(projectDir, runId, {
      type: 'run_completed',
      runId,
      timestamp: state.completedAt,
      iteration,
      detail: state.failureReason,
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
