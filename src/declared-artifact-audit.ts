import { statSync } from 'node:fs';
import { RecordedArtifactContractSchema, artifactActivation, artifactProducerReadError, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { STAGE_STATUS, type StageStatus, type StoreState } from './store.js';

/** Exact reads for explicitly configured reality checks, not stage proof duties. */
export function inspectDeclaredStageReads(input: { artifactContract: ArtifactContract; projectDir: string; runDir: string; statuses?: Record<string, StageStatus>; state?: StoreState }): string[] {
  const contract = RecordedArtifactContractSchema.parse(input.artifactContract);
  return contract.reads.flatMap((read) => {
    const activation = artifactActivation(read.when, input.statuses ?? {});
    if (activation === 'inactive') return [];
    if (activation === 'unknown') return [`ARTIFACT_FACT_UNKNOWN: ${read.id} cannot be read until ${read.when?.stage}.${read.when?.field} is settled`];
    const path = resolveArtifactLocation(read, input.projectDir, input.runDir);
    try {
      if (read.source.kind === 'stage' && input.statuses?.[read.source.stage]?.status !== STAGE_STATUS.COMPLETE) {
        const original = read.source.stage, stages = input.state?.planControl?.stages ?? [];
        const alternativeProduced = input.statuses?.[original]?.status === STAGE_STATUS.SKIPPED && stages.some(owner => {
          if (!owner.decision?.successors.includes(original)) return false;
          const choice = input.state?.decisionGraph?.records.filter(record => record.stageId === owner.id).at(-1);
          const selected = stages.find(stage => stage.id === choice?.successor);
          return choice?.outcome !== 'questions' && selected && owner.decision.successors.includes(selected.id)
            && input.statuses?.[selected.id]?.status === STAGE_STATUS.COMPLETE
            && !artifactProducerReadError({ ...read, source: { kind: 'stage', stage: selected.id, artifact: read.source.kind === 'stage' ? read.source.artifact : '' } }, selected);
        });
        if (!alternativeProduced) return [`ARTIFACT_READ_NOT_PRODUCED: ${read.id} producer ${original} is not complete`];
      }
      const stat = statSync(path);
      if (read.kind === 'file' ? stat.isFile() : stat.isDirectory()) return [];
    } catch { /* absent/wrong type */ }
    return [`ARTIFACT_READ_ABSENT: ${read.id} requires ${read.kind} at ${read.root}:${read.path}`];
  });
}

