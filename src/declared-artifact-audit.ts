import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, statSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ArtifactContractSchema, RecordedArtifactContractSchema, artifactActivation, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { compareLiveConstraintContentIdentities, readLiveConstraintContentIdentity, type LiveConstraintContentIdentity } from './live-constraint-guard.js';
import type { StageArtifactContractAudit, StageArtifactContractInput, StageArtifactContractPreimage, StageArtifactObligation } from './stage-artifact-contract.js';
import { STAGE_STATUS, type StageStatus } from './store.js';

/** Only declared output boundaries need a tree identity; live scans stay shallow.
 * Deleting the stale-output check would admit old trees. Hashing only the root
 * would miss member edits, so settlement needs names, types and every file byte.
 * Links have no closed content identity: declare their referents as files instead.
 */
export function readDeclaredArtifactIdentity(path: string, kind: 'file' | 'directory'): LiveConstraintContentIdentity & { members?: number } {
  if (kind === 'file') return readLiveConstraintContentIdentity(path);
  try {
    const hash = createHash('sha256');
    const observations: Array<{ path: string; stamp: string }> = [];
    const stamp = (value: BigIntStats): string =>
      [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':');
    let byteLength = 0;
    const pending = [{ path, name: '' }];
    while (pending.length) {
      const member = pending.pop()!;
      const stat = lstatSync(member.path, { bigint: true });
      observations.push({ path: member.path, stamp: stamp(stat) });
      if (observations.length > 100_000) throw new Error('directory exceeds the 100000-member settlement limit; declare smaller outputs');
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([member.name, 'directory']) + '\n');
        const names = readdirSync(member.path).sort();
        for (const name of names.reverse()) pending.push({ path: join(member.path, name), name: member.name ? `${member.name}/${name}` : name });
      } else if (stat.isFile() && member.name) {
        const identity = readLiveConstraintContentIdentity(member.path);
        if (identity.state !== 'present' || identity.type !== 'file') throw new Error('member content is unavailable or changed type');
        hash.update(JSON.stringify([member.name, identity.type, identity.byteLength, identity.sha256]) + '\n');
        byteLength += identity.byteLength;
      } else throw new Error('directory outputs require regular files and directories; declare link referents as file outputs');
    }
    // A settled writer provides the boundary; mutations during inspection still
    // cannot establish freshness, even if directory mtimes were restored.
    for (const observation of observations) if (stamp(lstatSync(observation.path, { bigint: true })) !== observation.stamp) {
      throw new Error('directory changed during content inspection');
    }
    return { state: 'present', type: 'directory', byteLength, members: observations.length - 1, sha256: hash.digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path)) return { state: 'absent' };
    return { state: 'unavailable', reason: `could not establish directory content: ${String(error)}` };
  }
}

export function declaredArtifactPreimages(input: Pick<StageArtifactContractInput, 'projectDir' | 'runDir'> & { artifactContract: ArtifactContract }): StageArtifactContractPreimage[] {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  return contract.produces.map((artifact) => {
    const path = resolveArtifactLocation(artifact, input.projectDir, input.runDir);
    return { path, identity: readDeclaredArtifactIdentity(path, artifact.kind) };
  });
}

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

export function inspectDeclaredStageArtifactContract(input: StageArtifactContractInput & { artifactContract: ArtifactContract }, deferred = false): StageArtifactContractAudit {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  const preimages = new Map((input.preimages ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const writes = (input.writes ?? []).map((write) => write.startsWith('run:')
    ? resolve(input.runDir, write.slice(4)) : isAbsolute(write) ? resolve(write) : resolve(input.projectDir, write));
  const prior = new Map((input.priorProducedArtifacts ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const produced = new Set<string>();
  const obligations: StageArtifactObligation[] = [];
  const violations: StageArtifactContractAudit['violations'] = [];
  const quantities: NonNullable<StageArtifactContractAudit['observations']> = [];
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
    const after = readDeclaredArtifactIdentity(path, artifact.kind);
    if (artifact.kind === 'directory') valid = valid && after.state === 'present' && after.type === 'directory';
    // Adjudication is execution evidence, not a reusable stage product.
    const reusable = !(input.isGate && artifact.root === 'run' && artifact.path === `verdict_${input.stageId}.json`)
      && prior.has(path) && compareLiveConstraintContentIdentities(prior.get(path)!, after) === 'equal';
    const fresh = valid && (reusable || writes.some((write) => {
      const rel = relative(path, write);
      return write === path || (artifact.kind === 'directory' && rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
    }) || (before !== undefined && compareLiveConstraintContentIdentities(before, after) === 'different'));
    if (after.state === 'present' && (after.type === 'file' || after.type === 'directory')) quantities.push({ id: artifact.id, path, kind: artifact.kind, bytes: after.byteLength, ...(artifact.kind === 'directory' ? { members: after.members } : {}), sha256: after.sha256, fresh });
    if (fresh) produced.add(path);
    observations.set(artifact.id, { exists: existsSync(path), fresh, obligation });
    const activation = artifactActivation(artifact.when, input.statuses ?? {});
    if (activation === 'inactive') continue;
    obligations.push(obligation);
    if (deferred) continue;
    if (activation === 'unknown') violations.push({ ...obligation, reason: `ARTIFACT_FACT_UNKNOWN: ${artifact.id} activation requires settled ${artifact.when?.stage}.${artifact.when?.field}; unknown facts never waive an output` });
    else if (!contract.groups.some((group) => group.members.includes(artifact.id)) && !fresh) violations.push({ ...obligation, reason: `ARTIFACT_OUTPUT_ABSENT_OR_STALE: ${artifact.id} requires a fresh attributable ${artifact.kind} at ${obligation.mention}${artifact.nonempty ? ' with content' : ''}${after.state === 'unavailable' ? `; ${after.reason}` : ''}` });
  }
  if (!deferred) for (const group of contract.groups) {
    const existing = group.members.filter((id) => observations.get(id)?.exists);
    if (existing.length !== 1 || !observations.get(existing[0])?.fresh) {
      const obligation = observations.get(group.members[0])!.obligation;
      violations.push({ ...obligation, reason: `ARTIFACT_EXACTLY_ONE: ${group.id} requires exactly one fresh output among ${group.members.join(', ')}; existing=${existing.join(', ') || 'none'}` });
    }
  }
  return { version: 1, stageId: input.stageId, checkedAt: new Date().toISOString(), ...(deferred ? { completionDeferred: true } : {}), obligations, observations: quantities, producedPromptArtifacts: [...produced].sort(), replayExecutions: [], violations };
}
