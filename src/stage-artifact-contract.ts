import { writeFileSync } from './engine-fs.js';

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ArtifactContractSchema, artifactActivation, artifactDeclarationErrors, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import type { StageStatus } from './store.js';
import { readContentIdentity } from './content-identity.js';
import { existsSync, readdirSync, statSync } from 'node:fs';

export type StageArtifactObligationKind = 'prompt_artifact' | 'declared_artifact';

export interface StageArtifactObligation {
  kind: StageArtifactObligationKind;
  mention: string;
  path: string;
  source: 'prompt' | 'published_report' | 'declaration';
  sourcePath?: string;
}

export interface StageArtifactContractViolation extends StageArtifactObligation {
  reason: string;
}

export interface StageArtifactContractAudit {
  version: 1;
  stageId: string;
  checkedAt: string;
  completionDeferred?: boolean;
  /** Engine-owned production identity; archived observations alone grant nothing. */
  production?: StageArtifactProduction;
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  /** Current verdict receipt, or quantities retained in historical records. */
  observations?: Array<{ id: string; path: string; kind: 'file' | 'directory'; bytes: number; members?: number; sha256: string; fresh: boolean }>;
  violations: StageArtifactContractViolation[];
}

export interface StageArtifactProduction {
  runId: string;
  projectDir: string;
  runDir: string;
  declarationDigest: string;
  attemptIndex: number;
  attemptStartedAt: string;
}

/** Bind the protected gate result observation to the current execution. */
export function stageArtifactProduction(input: StageArtifactContractInput & {
  runId: string; attemptIndex: number; attemptStartedAt: string;
  planRevision?: { revision: number; digest: string };
}): StageArtifactProduction {
  return {
    runId: input.runId, projectDir: resolve(input.projectDir), runDir: resolve(input.runDir),
    declarationDigest: createHash('sha256').update(JSON.stringify({
      stageId: input.stageId, template: input.template, isGate: input.isGate === true,
      planRevision: input.planRevision ? { revision: input.planRevision.revision, digest: input.planRevision.digest } : null,
      contract: ArtifactContractSchema.parse(input.artifactContract),
    })).digest('hex'),
    attemptIndex: input.attemptIndex, attemptStartedAt: input.attemptStartedAt,
  };
}

export interface StageArtifactContractInput {
  /** Worker-owned gate authority; a verdict filename alone never grants it. */
  isGate?: boolean;
  attemptIndex?: number;
  stageId: string;
  template: string;
  projectDir: string;
  runDir: string;
  writes?: readonly string[];
  artifactContract?: ArtifactContract;
  statuses?: Record<string, StageStatus>;
}


/** Explicit declarations are deterministic settlement facts. Removing the model
 * cannot enforce them by itself: refuse a successful settlement with absent,
 * mistyped or empty required outputs here; gates still judge their substance.
 * Suspended and failed attempts have no completion obligation.
 */
export function inspectStageArtifactContract(input: StageArtifactContractInput, deferred = false): StageArtifactContractAudit {
  const errors = artifactDeclarationErrors(input.artifactContract, input.stageId);
  if (errors.length) return {
    version: 1, stageId: input.stageId, checkedAt: new Date().toISOString(),
    obligations: [], producedPromptArtifacts: [], violations: errors.map(reason => ({
      kind: 'declared_artifact', source: 'declaration', mention: `${input.stageId}.artifact_contract`,
      path: join(input.runDir, 'stages', input.stageId, 'artifact_contract.json'), reason,
    })),
  };
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  const observations: NonNullable<StageArtifactContractAudit['observations']> = [];
  const produced: string[] = [];
  const obligations: StageArtifactObligation[] = [];
  const violations: StageArtifactContractViolation[] = [];
  const grouped = new Set(contract.groups.flatMap(group => group.members));
  const present = new Set<string>();
  for (const artifact of contract.produces) {
    const path = resolveArtifactLocation(artifact, input.projectDir, input.runDir);
    if (existsSync(path)) produced.push(path);
    const obligation: StageArtifactObligation = {
      kind: 'declared_artifact', source: 'declaration', mention: artifact.id, path,
    };
    const activation = artifactActivation(artifact.when, input.statuses ?? {});
    if (!deferred && activation !== 'inactive') {
      obligations.push(obligation);
      let reason: string | undefined;
      try {
        const stat = statSync(path);
        if (artifact.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) reason = `ARTIFACT_OUTPUT_KIND: ${artifact.id} requires ${artifact.kind}`;
        else {
          present.add(artifact.id);
          if (artifact.nonempty && (artifact.kind === 'file' ? stat.size === 0 : readdirSync(path).length === 0)) reason = `ARTIFACT_OUTPUT_EMPTY: ${artifact.id} must be nonempty`;
        }
      } catch { reason = `ARTIFACT_OUTPUT_ABSENT: ${artifact.id} requires ${artifact.root}:${artifact.path}`; }
      if (activation === 'unknown') reason = `ARTIFACT_FACT_UNKNOWN: ${artifact.id} requires settled ${artifact.when?.stage}.${artifact.when?.field}`;
      if (reason && (!grouped.has(artifact.id) || existsSync(path))) violations.push({ ...obligation, reason });
    }
    if (artifact.kind !== 'file' || input.isGate !== true || artifact.root !== 'run'
        || artifact.path !== `verdict_${input.stageId}.json`) continue;
    const identity = readContentIdentity(path);
    if (identity.state === 'present' && identity.type === 'file') observations.push({
      id: artifact.id, path, kind: artifact.kind, bytes: identity.byteLength, sha256: identity.sha256,
      // Retained record field: only a published current gate verdict is an
      // adjudication, rather than a reusable intermediate output.
      fresh: input.isGate === true && artifact.root === 'run'
        && artifact.path === `verdict_${input.stageId}.json`
        && ((input.writes ?? []).includes(path) || (input.writes ?? []).includes(`run:${artifact.path}`)),
    });
  }
  if (!deferred) for (const group of contract.groups) {
    const count = group.members.filter(id => present.has(id)).length;
    if (count !== 1) violations.push({
      kind: 'declared_artifact', source: 'declaration', mention: group.id,
      path: join(input.runDir, 'stages', input.stageId, 'artifact_contract.json'),
      reason: `ARTIFACT_OUTPUT_GROUP: ${group.id} requires exactly one of ${group.members.join(', ')}; observed ${count}`,
    });
  }
  return {
    version: 1, stageId: input.stageId, checkedAt: new Date().toISOString(),
    ...(deferred ? { completionDeferred: true } : {}),
    obligations, producedPromptArtifacts: produced.sort(), observations,
    violations,
  };
}

export function writeStageArtifactContractAudit(runDir: string, audit: StageArtifactContractAudit): string {
  const path = join(runDir, 'stages', audit.stageId, 'artifact_contract.json');
  writeFileSync(path, `${JSON.stringify(audit)}\n`, 'utf-8');
  return path;
}
