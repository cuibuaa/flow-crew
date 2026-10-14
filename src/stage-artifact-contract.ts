import { writeFileSync } from './engine-fs.js';

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { LiveConstraintContentIdentity } from './live-constraint-guard.js';
import { ArtifactContractSchema, artifactActivation, artifactDeclarationErrors, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import type { StageStatus } from './store.js';
import { readLiveConstraintContentIdentity } from './live-constraint-guard.js';
import { existsSync, readdirSync, statSync } from 'node:fs';

export type StageArtifactObligationKind = 'prompt_artifact' | 'replay_command_target' | 'declared_artifact' | 'declared_replay';

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
  /** Legacy advisories stay readable, but no new prose inference produces them. */
  advisories?: Array<{ mention: string; reason: string }>;
  replayVerification?: 'pending' | 'verified' | 'refused' | 'not_requested';
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  /** Current verdict receipt, or quantities retained in historical records. */
  observations?: Array<{ id: string; path: string; kind: 'file' | 'directory'; bytes: number; members?: number; sha256: string; fresh: boolean }>;
  replayExecutions: StageArtifactReplayExecution[];
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

export interface StageArtifactReplayExecution {
  command: string;
  sourcePath: string;
  runner: 'node_test' | 'vitest' | 'pytest' | 'unsupported';
  targetPaths: string[];
  status: 'passed' | 'failed' | 'not_run';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  collectedTests: number;
  executedTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  stdout: string;
  stderr: string;
  reason: string;
  declarationId?: string;
  effectiveTimeoutMs?: number;
  elapsedMs?: number;
  targets?: Array<{ artifact: string; path: string; executed: number; [key: string]: unknown }>;
  /** Every direct process outcome, including earlier targets and abnormal exits.
   * These observations explain a refusal; they cannot overrule it. */
  processes?: StageArtifactReplayProcess[];
  observation?: {
    policy: 'single_execution_no_confirmation';
    startedAt: string;
    completedAt?: string;
    loadStart: number[];
    loadEnd?: number[];
    inputsBefore: StageArtifactContractPreimage[];
    inputsAfter?: StageArtifactContractPreimage[];
    runtime: { modulePath: string; moduleIdentity: LiveConstraintContentIdentity; manifestIdentity: LiveConstraintContentIdentity };
  };
}

export interface StageArtifactReplayProcess {
  command: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  loadStart: number[];
  loadEnd: number[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  processError?: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface StageArtifactContractPreimage {
  path: string;
  identity: LiveConstraintContentIdentity;
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
  preimages?: readonly StageArtifactContractPreimage[];
  /** Legacy caller surface; intermediate preimages are ignored. */
  priorProducedArtifacts?: readonly StageArtifactContractPreimage[];
  /** Legacy caller surface, retained but never an authorization. */
  priorProducedPromptArtifacts?: readonly string[];
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
    obligations: [], producedPromptArtifacts: [], replayExecutions: [], violations: errors.map(reason => ({
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
    const identity = readLiveConstraintContentIdentity(path);
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
    replayExecutions: [], replayVerification: 'not_requested', violations,
  };
}

export function writeStageArtifactContractAudit(runDir: string, audit: StageArtifactContractAudit): string {
  const path = join(runDir, 'stages', audit.stageId, 'artifact_contract.json');
  writeFileSync(path, `${JSON.stringify(audit)}\n`, 'utf-8');
  return path;
}
