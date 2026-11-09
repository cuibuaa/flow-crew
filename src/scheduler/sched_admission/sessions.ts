import { runRecordPath, requestPath } from '../../run-layout.js';
/** Stage/session reuse and gate continuation lifecycle; reads/writes only the supplied run directory. */
import { type StageStatus, type StoreState } from '../../store.js';
import { type SessionMetadata, finalizeStageSessions } from '../../adapter-session.js';
import { unlinkSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { type StageConfig } from './configuration.js';

export function isValidationStage(stage: StageConfig): boolean {
  const tagged = `${stage.id} ${stage.role}`;
  return stage.role.toLowerCase() === 'qa'
    || stage.is_gate === true
    || /(^|[\s_-])(gate|verify|verification)(?=$|[\s_-])/i.test(tagged);
}

/** Compatibility entry points: opt-in reuse no longer carries conversations.
 * Every stage starts with current duties, the evidence ledger and the diff. */
export function canReuseSession(_input: {
  stage: StageConfig; predecessor: StageConfig; allStages: StageConfig[];
  predecessorStatus: StageStatus | undefined; destinationStatus: StageStatus | undefined;
  session: SessionMetadata | undefined;
}): boolean { return false; }
export function sessionResumeForStage(_stage: StageConfig, _allStages: StageConfig[], _state: StoreState,
  _runDirPath: string, _enabled: boolean, _adapter?: string): { sessionId: string; ownerStageId: string } | undefined {
  return undefined;
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
  return requestPath(runDirPath, 'gate_reevaluation', `verdict_correction_${gateId}.json`);
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

export function canResumeOwnGateSession(_stage: StageConfig, _session: SessionMetadata | undefined,
  _previousVerdictWrong: boolean): boolean { return false; }

function clearContinuationArtifacts(runDirPath: string, gateId: string): void {
  finalizeStageSessions(runDirPath, gateId);
  try { const path = runRecordPath(runDirPath, 'stages', gateId, 'session.json'); unlinkSync(path); } catch { /* best effort */ }
  try { unlinkSync(gateVerdictCorrectionPath(runDirPath, gateId)); } catch { /* best effort */ }
}

export function clearGateContinuationsForStages(runDirPath: string, stages: StageConfig[]): void {
  // Historical native homes are never selected again; retire this run's homes
  // when the enclosing stage lifecycle ends.
  for (const stage of stages) clearContinuationArtifacts(runDirPath, stage.id);
}

export function gateContinuationSessionForStage(stage: StageConfig, runDirPath: string,
  _isReevaluation: boolean, _adapter?: string): { sessionId: string; ownerStageId: string } | undefined {
  if (stage.is_gate && readAndConsumeGateVerdictCorrection(runDirPath, stage.id)) clearContinuationArtifacts(runDirPath, stage.id);
  return undefined;
}
export function shouldPreserveSession(_stage: StageConfig, _allStages: StageConfig[], _enabled: boolean): boolean { return false; }
