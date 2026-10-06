import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveConstraintContentIdentity } from './live-constraint-guard.js';
import { ArtifactContractSchema, artifactDeclarationErrors, type ArtifactContract } from './artifact-declarations.js';
import type { StageStatus } from './store.js';
import { declaredArtifactPreimages, inspectDeclaredStageArtifactContract } from './declared-artifact-audit.js';
import { executeDeclaredReplays, type ReplayBudget } from './declared-replay-execution.js';

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
  /** Legacy advisories stay readable, but no new prose inference produces them. */
  advisories?: Array<{ mention: string; reason: string }>;
  replayVerification?: 'pending' | 'verified' | 'refused' | 'not_requested';
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  replayExecutions: StageArtifactReplayExecution[];
  violations: StageArtifactContractViolation[];
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
  targets?: Array<{ artifact: string; path: string; collected: number; executed: number; passed: number; failed: number; skipped: number; failures: string[]; error?: string }>;
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
  priorProducedPromptArtifacts?: readonly string[];
  artifactContract?: ArtifactContract;
  statuses?: Record<string, StageStatus>;
}


/** Capture exact declarations only. Legacy records are data, never fresh duties. */
export function captureStageArtifactContractPreimages(input: Pick<StageArtifactContractInput, 'template' | 'projectDir' | 'runDir' | 'artifactContract'>): StageArtifactContractPreimage[] {
  return ArtifactContractSchema.safeParse(input.artifactContract).success
    ? declaredArtifactPreimages({ ...input, artifactContract: input.artifactContract! }) : [];
}

function refusedDeclaration(input: StageArtifactContractInput): StageArtifactContractAudit | undefined {
  const errors = artifactDeclarationErrors(input.artifactContract, input.stageId);
  if (!errors.length) return undefined;
  const obligation: StageArtifactObligation = { kind: 'declared_artifact', source: 'declaration', mention: `${input.stageId}.artifact_contract`, path: join(input.runDir, 'stages', input.stageId, 'artifact_contract.json') };
  return { version: 1, stageId: input.stageId, checkedAt: new Date().toISOString(), obligations: [], producedPromptArtifacts: [], replayExecutions: [], replayVerification: 'refused', violations: errors.map((reason) => ({ ...obligation, reason })) };
}

/** Scope suspension records output identity; successful settlement verifies replay. */
export function captureDeferredStageArtifactContract(input: StageArtifactContractInput): StageArtifactContractAudit {
  return refusedDeclaration(input) ?? inspectDeclaredStageArtifactContract({ ...input, artifactContract: input.artifactContract! }, true);
}

/** Recognition-only inspection. A pending replay cannot authorize completion. */
export function inspectStageArtifactContract(input: StageArtifactContractInput): StageArtifactContractAudit {
  const refusal = refusedDeclaration(input);
  if (refusal) return refusal;
  const audit = inspectDeclaredStageArtifactContract({ ...input, artifactContract: input.artifactContract! });
  audit.replayVerification = input.artifactContract!.replays!.length ? 'pending' : 'not_requested';
  return audit;
}

/** Worker settlement always runs every declared replay, independent of report prose. */
export async function verifyStageArtifactContract(input: StageArtifactContractInput, budget: ReplayBudget): Promise<StageArtifactContractAudit> {
  const audit = inspectStageArtifactContract(input);
  if (audit.replayVerification === 'refused') return audit;
  audit.replayExecutions = await executeDeclaredReplays(input, budget);
  for (const execution of audit.replayExecutions) {
    if (execution.status === 'passed') continue;
    audit.violations.push({ kind: 'declared_replay', source: 'declaration', mention: `artifact_contract.replays.${execution.declarationId}`, path: execution.targetPaths[0] ?? '', reason: `DECLARED_REPLAY_REFUSED: ${execution.declarationId}: ${execution.reason}` });
  }
  audit.replayVerification = audit.replayExecutions.some((entry) => entry.status !== 'passed') ? 'refused' : audit.replayExecutions.length ? 'verified' : 'not_requested';
  audit.checkedAt = new Date().toISOString();
  return audit;
}

export function writeStageArtifactContractAudit(runDir: string, audit: StageArtifactContractAudit): string {
  const path = join(runDir, 'stages', audit.stageId, 'artifact_contract.json');
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8');
  return path;
}
