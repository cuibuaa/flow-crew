import { readFileSync } from 'node:fs';
import type { StageArtifactContractAudit } from './stage-artifact-contract.js';

export type RecordedStageArtifactContractAudit = Omit<StageArtifactContractAudit, 'replayExecutions'> & {
  // Early audits did not record replay results. Absence is preserved, not filled in.
  replayExecutions?: StageArtifactContractAudit['replayExecutions'];
};

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
