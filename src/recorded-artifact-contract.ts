import { readFileSync } from 'node:fs';
import type { StageArtifactContractAudit, StageArtifactContractPreimage, StageArtifactProduction } from './stage-artifact-contract.js';
import { STAGE_STATUS, type StageStatus } from './store.js';
import { compareLiveConstraintContentIdentities } from './live-constraint-guard.js';

export type RecordedStageArtifactContractAudit = Omit<StageArtifactContractAudit, 'replayExecutions'> & {
  // Early audits did not record replay results. Absence is preserved, not filled in.
  replayExecutions?: StageArtifactContractAudit['replayExecutions'];
};

/** Old records remain readable, but missing provenance is never invented.
 * The audit and ledger are engine-owned carriers, not stage-authored receipts. */
export function reusableStageArtifactProduction(
  current: StageArtifactProduction,
  stageId: string,
  record: RecordedStageArtifactContractAudit,
  attempts: NonNullable<StageStatus['attempts']>,
  preimages: readonly StageArtifactContractPreimage[],
): StageArtifactContractPreimage[] {
  const prior = record.production;
  if (!prior || record.stageId !== stageId || prior.runId !== current.runId
    || prior.projectDir !== current.projectDir || prior.runDir !== current.runDir
    || prior.declarationDigest !== current.declarationDigest
    || !Number.isSafeInteger(prior.attemptIndex) || prior.attemptIndex < 1
    || prior.attemptIndex >= current.attemptIndex || !Array.isArray(record.observations)) return [];
  const attempt = attempts.find((entry) => entry.index === prior.attemptIndex);
  const checked = Date.parse(record.checkedAt);
  const started = Date.parse(attempt?.startedAt ?? '');
  const completed = Date.parse(attempt?.completedAt ?? '');
  const closed = Date.parse(attempt?.timeout?.childClosedAt ?? '');
  if (!attempt || ![STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, 'suspended'].includes(attempt.status)
    || attempt.startedAt !== prior.attemptStartedAt || !attempt.timeout?.childClosedAt
    || ![checked, started, completed, closed].every(Number.isFinite)
    || checked < started || checked > completed || closed < started || closed > completed) return [];
  return preimages.filter((entry) => record.producedPromptArtifacts.includes(entry.path)
    && record.observations?.some((observation) => observation && observation.path === entry.path && observation.fresh === true
      && compareLiveConstraintContentIdentities(entry.identity, {
        state: 'present', type: observation.kind, byteLength: observation.bytes, sha256: observation.sha256,
      }) === 'equal'));
}

/** Read archived observations without deriving obligations or executing commands.
 * Unknown extensions are retained; malformed records are labelled, not repaired. */
export function readRecordedArtifactContract(path: string): { status: 'readable'; legacy: boolean; record: RecordedStageArtifactContractAudit } | { status: 'unreadable'; reason: string } {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an artifact audit object');
    const record = value as RecordedStageArtifactContractAudit;
    if (record.version !== 1 || typeof record.stageId !== 'string' || typeof record.checkedAt !== 'string'
      || !Array.isArray(record.obligations) || (record.replayExecutions !== undefined && !Array.isArray(record.replayExecutions)) || !Array.isArray(record.violations)
      || !Array.isArray(record.producedPromptArtifacts)) throw new Error('expected a version-1 recorded artifact audit with obligation/replay/verdict arrays');
    return { status: 'readable', legacy: record.replayVerification === undefined, record };
  } catch (error) { return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) }; }
}
