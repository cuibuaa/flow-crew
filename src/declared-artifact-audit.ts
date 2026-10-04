import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { ArtifactContractSchema, artifactActivation, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { compareLiveConstraintContentIdentities, readLiveConstraintContentIdentity } from './live-constraint-guard.js';
import type { StageArtifactContractAudit, StageArtifactContractInput, StageArtifactContractPreimage, StageArtifactObligation } from './stage-artifact-contract.js';
import { STAGE_STATUS, type StageStatus } from './store.js';

export function declaredArtifactPreimages(input: Pick<StageArtifactContractInput, 'projectDir' | 'runDir'> & { artifactContract: ArtifactContract }): StageArtifactContractPreimage[] {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  return contract.produces.map((artifact) => {
    const path = resolveArtifactLocation(artifact, input.projectDir, input.runDir);
    return { path, identity: readLiveConstraintContentIdentity(path) };
  });
}

export function inspectDeclaredStageReads(input: { artifactContract: ArtifactContract; projectDir: string; runDir: string; statuses?: Record<string, StageStatus> }): string[] {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
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

export function inspectDeclaredStageArtifactContract(input: StageArtifactContractInput & { artifactContract: ArtifactContract }, deferred = false): StageArtifactContractAudit {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  const preimages = new Map((input.preimages ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const writes = (input.writes ?? []).map((write) => write.startsWith('run:')
    ? resolve(input.runDir, write.slice(4)) : isAbsolute(write) ? resolve(write) : resolve(input.projectDir, write));
  const prior = new Set(input.priorProducedPromptArtifacts ?? []);
  const produced = new Set<string>();
  const obligations: StageArtifactObligation[] = [];
  const violations: StageArtifactContractAudit['violations'] = [];
  const observations = new Map<string, { exists: boolean; fresh: boolean; obligation: StageArtifactObligation }>();
  for (const artifact of contract.produces) {
    const path = resolveArtifactLocation(artifact, input.projectDir, input.runDir);
    const obligation: StageArtifactObligation = { kind: 'declared_artifact', source: 'declaration', mention: `${artifact.root}:${artifact.path}`, path };
    let valid = false;
    try {
      const stat = statSync(path);
      valid = artifact.kind === 'file' ? stat.isFile() && (!artifact.nonempty || stat.size > 0)
        : stat.isDirectory() && (!artifact.nonempty || readdirSync(path).length > 0);
    } catch { /* absent */ }
    const before = preimages.get(path);
    const fresh = valid && (prior.has(path) || writes.some((write) => {
      const rel = relative(path, write);
      return write === path || (artifact.kind === 'directory' && rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
    }) || (before !== undefined && compareLiveConstraintContentIdentities(before, readLiveConstraintContentIdentity(path)) === 'different'));
    if (fresh) produced.add(path);
    observations.set(artifact.id, { exists: existsSync(path), fresh, obligation });
    const activation = artifactActivation(artifact.when, input.statuses ?? {});
    if (activation === 'inactive') continue;
    obligations.push(obligation);
    if (deferred) continue;
    if (activation === 'unknown') violations.push({ ...obligation, reason: `ARTIFACT_FACT_UNKNOWN: ${artifact.id} activation requires settled ${artifact.when?.stage}.${artifact.when?.field}; unknown facts never waive an output` });
    else if (!contract.groups.some((group) => group.members.includes(artifact.id)) && !fresh) violations.push({ ...obligation, reason: `ARTIFACT_OUTPUT_ABSENT_OR_STALE: ${artifact.id} requires a fresh attributable ${artifact.kind} at ${obligation.mention}${artifact.nonempty ? ' with content' : ''}` });
  }
  if (!deferred) for (const group of contract.groups) {
    const existing = group.members.filter((id) => observations.get(id)?.exists);
    if (existing.length !== 1 || !observations.get(existing[0])?.fresh) {
      const obligation = observations.get(group.members[0])!.obligation;
      violations.push({ ...obligation, reason: `ARTIFACT_EXACTLY_ONE: ${group.id} requires exactly one fresh output among ${group.members.join(', ')}; existing=${existing.join(', ') || 'none'}` });
    }
  }
  return { version: 1, stageId: input.stageId, checkedAt: new Date().toISOString(), ...(deferred ? { completionDeferred: true } : {}), obligations, producedPromptArtifacts: [...produced].sort(), replayExecutions: [], violations };
}
