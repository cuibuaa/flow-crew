/** Stage/session reuse and gate continuation lifecycle; reads/writes only the supplied run directory. */
import { type StageStatus, STAGE_STATUS, type StoreState } from '../../store.js';
import { type CodexSessionMetadata, readCodexSession } from '../../adapters/codex.js';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { type StageConfig } from './configuration.js';

export function isValidationStage(stage: StageConfig): boolean {
  const tagged = `${stage.id} ${stage.role}`;
  return stage.role.toLowerCase() === 'qa'
    || stage.is_gate === true
    || /(^|[\s_-])(gate|verify|verification)(?=$|[\s_-])/i.test(tagged);
}

function reusableDirectSuccessors(stage: StageConfig, allStages: StageConfig[]): StageConfig[] {
  if (isValidationStage(stage)) return [];
  return allStages.filter((candidate) =>
    candidate.depends_on.length === 1
    && candidate.depends_on[0] === stage.id
    && !isValidationStage(candidate),
  );
}

export function canReuseCodexSession(input: {
  stage: StageConfig;
  predecessor: StageConfig;
  allStages: StageConfig[];
  predecessorStatus: StageStatus | undefined;
  destinationStatus: StageStatus | undefined;
  session: CodexSessionMetadata | undefined;
}): boolean {
  const { stage, predecessor, allStages, predecessorStatus, destinationStatus, session } = input;
  if (stage.depends_on.length !== 1 || stage.depends_on[0] !== predecessor.id) return false;
  if (isValidationStage(stage) || isValidationStage(predecessor)) return false;
  const successors = reusableDirectSuccessors(predecessor, allStages);
  if (successors.length !== 1 || successors[0].id !== stage.id) return false;
  if (!session) return false;
  if (predecessorStatus?.status !== STAGE_STATUS.COMPLETE) return false;
  const attempts = predecessorStatus.attempts ?? [];
  if (attempts.length !== 1 || attempts[0].status !== STAGE_STATUS.COMPLETE) return false;
  if ((predecessorStatus.retries ?? 0) !== 0 || (predecessorStatus.reruns ?? 0) !== 0) return false;
  if ((destinationStatus?.retries ?? 0) !== 0 || (destinationStatus?.attempts?.length ?? 0) !== 0) return false;
  return true;
}

export function sessionResumeForStage(
  stage: StageConfig,
  allStages: StageConfig[],
  state: StoreState,
  runDirPath: string,
  enabled: boolean,
): { sessionId: string; ownerStageId: string } | undefined {
  // Own-stage continuation does not inherit another role's reasoning. It is
  // independent of the opt-in predecessor reuse experiment. Gates use their
  // correction-aware continuation path instead.
  const own = readCodexSession(runDirPath, stage.id);
  if (!stage.is_gate && own?.ownerStageId === stage.id
      && existsSync(join(runDirPath, 'stages', stage.id, 'codex_home'))
      && (state.stages[stage.id]?.attempts?.length ?? 0) > 0) {
    return { sessionId: own.sessionId, ownerStageId: stage.id };
  }
  if (!enabled || stage.depends_on.length !== 1) return undefined;
  const predecessor = allStages.find((candidate) => candidate.id === stage.depends_on[0]);
  if (!predecessor) return undefined;
  const session = readCodexSession(runDirPath, predecessor.id);
  if (!canReuseCodexSession({
    stage,
    predecessor,
    allStages,
    predecessorStatus: state.stages[predecessor.id],
    destinationStatus: state.stages[stage.id],
    session,
  })) return undefined;
  return { sessionId: session!.sessionId, ownerStageId: session!.ownerStageId };
}

export const GATE_VERDICT_CORRECTION_VERSION = 1;

export interface GateVerdictCorrection {
  version: typeof GATE_VERDICT_CORRECTION_VERSION;
  gateId: string;
  previousVerdictWrong: true;
  reason: string;
  evidence: string;
}

export function gateVerdictCorrectionPath(runDirPath: string, gateId: string): string {
  return join(runDirPath, 'gate_reevaluation', `verdict_correction_${gateId}.json`);
}

function readAndConsumeGateVerdictCorrection(runDirPath: string, gateId: string): GateVerdictCorrection | undefined {
  const path = gateVerdictCorrectionPath(runDirPath, gateId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateVerdictCorrection>;
    if (
      parsed.version !== GATE_VERDICT_CORRECTION_VERSION
      || parsed.gateId !== gateId
      || parsed.previousVerdictWrong !== true
      || typeof parsed.reason !== 'string'
      || !parsed.reason.trim()
      || typeof parsed.evidence !== 'string'
      || !parsed.evidence.trim()
    ) return undefined;
    return parsed as GateVerdictCorrection;
  } catch {
    return undefined;
  } finally {
    // A correction applies to exactly one re-evaluation. Invalid files are also
    // consumed so stale/malformed run-local state cannot poison later rounds.
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

export function canResumeOwnGateSession(
  stage: StageConfig,
  session: CodexSessionMetadata | undefined,
  previousVerdictWrong: boolean,
): boolean {
  return stage.is_gate === true
    && previousVerdictWrong === false
    && session !== undefined
    && session.ownerStageId === stage.id;
}

function clearGateContinuationArtifacts(runDirPath: string, gateId: string): void {
  try { rmSync(join(runDirPath, 'stages', gateId, 'codex_home'), { recursive: true, force: true }); } catch { /* best effort */ }
  try { unlinkSync(join(runDirPath, 'stages', gateId, 'session.json')); } catch { /* best effort */ }
  try { unlinkSync(gateVerdictCorrectionPath(runDirPath, gateId)); } catch { /* best effort */ }
}

export function clearGateContinuationsForStages(runDirPath: string, stages: StageConfig[]): void {
  for (const gate of stages) {
    if (gate.is_gate && stages.some((candidate) => candidate.retry_to?.includes(gate.id))) {
      clearGateContinuationArtifacts(runDirPath, gate.id);
    }
  }
}

export function gateContinuationSessionForStage(
  stage: StageConfig,
  runDirPath: string,
  isReevaluation: boolean,
): { sessionId: string; ownerStageId: string } | undefined {
  if (!isReevaluation || stage.is_gate !== true) return undefined;
  const correction = readAndConsumeGateVerdictCorrection(runDirPath, stage.id);
  if (correction) {
    // Persisting a disproved line of reasoning is worse than rebuilding it.
    clearGateContinuationArtifacts(runDirPath, stage.id);
    return undefined;
  }
  const session = readCodexSession(runDirPath, stage.id);
  if (!canResumeOwnGateSession(stage, session, false)) return undefined;
  return { sessionId: session!.sessionId, ownerStageId: stage.id };
}

export function shouldPreserveSession(stage: StageConfig, allStages: StageConfig[], enabled: boolean): boolean {
  // Gate continuation is deliberately independent of ordinary predecessor
  // reuse. It retains only this gate's own isolated home when a fix loop can
  // bring the same gate back; validation still never inherits a builder home.
  if (stage.is_gate === true) {
    return allStages.some((candidate) => candidate.retry_to?.includes(stage.id));
  }
  if (!enabled || isValidationStage(stage)) return false;
  // Dynamic children do not exist until this stage returns; retain its home
  // provisionally, then the eligibility check still requires exactly one child.
  return stage.dynamic_dispatch || reusableDirectSuccessors(stage, allStages).length === 1;
}
