import { statSync } from 'node:fs';
import { RecordedArtifactContractSchema, artifactActivation, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { STAGE_STATUS, type StageStatus } from './store.js';

/** Exact reads for explicitly configured reality checks, not stage proof duties. */
export function inspectDeclaredStageReads(input: { artifactContract: ArtifactContract; projectDir: string; runDir: string; statuses?: Record<string, StageStatus> }): string[] {
  const contract = RecordedArtifactContractSchema.parse(input.artifactContract);
  return contract.reads.flatMap((read) => {
    const activation = artifactActivation(read.when, input.statuses ?? {});
    if (activation === 'inactive') return [];
    if (activation === 'unknown') return [`ARTIFACT_FACT_UNKNOWN: ${read.id} cannot be read until ${read.when?.stage}.${read.when?.field} is settled`];
    const path = resolveArtifactLocation(read, input.projectDir, input.runDir);
    try {
      if (read.source.kind === 'stage' && input.statuses?.[read.source.stage]?.status !== STAGE_STATUS.COMPLETE) return [`ARTIFACT_READ_NOT_PRODUCED: ${read.id} producer ${read.source.stage} is not complete`];
      const stat = statSync(path);
      if (read.kind === 'file' ? stat.isFile() : stat.isDirectory()) return [];
    } catch { /* absent/wrong type */ }
    return [`ARTIFACT_READ_ABSENT: ${read.id} requires ${read.kind} at ${read.root}:${read.path}`];
  });
}

