// Boundary: Own batch partitions and per-attempt effective scopes/preimages/violation ledger; disjoint-peer ownership uses the shared scope predicate.
import { type LiveConstraintGitIndexEntryKind } from "../../live-constraint-guard.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { createHash } from "node:crypto";
import { runDir } from "../../store.js";
import { type RepairFileImage } from './file-images.js';
import { type RepairRoundSnapshot, captureRepairRoundSnapshot } from './snapshots.js';
import { acceptedInheritedScope } from './scope-revisions.js';
import { scopeContainsPath } from './path-capabilities.js';

export interface ScopeBatchContext {
  snapshot: RepairRoundSnapshot;
  leaseBatchId: string;
  leasePartitions: Map<string, string>;
  declaredScopes: Map<string, string[] | null>;
  inheritedScopes: Map<string, string[]>;
  inheritedDecisionPaths: Map<string, Set<string>>;
  /** First preimage seen before any partition advances the shared baseline. */
  liveWritePreimages: Map<string, RepairFileImage>;
  liveViolationSequence: number;
  liveViolations: Array<{
    sequence: number;
    path: string;
    reason: string;
    restored: boolean;
    rollbackFailure?: string;
    entryKind: LiveConstraintGitIndexEntryKind | 'filesystem' | 'untracked';
    comparisonOutcome: 'different' | 'unavailable';
    changeObserved: boolean;
    rollbackAttempted: boolean;
    targetStageIds: Set<string>;
    deliveredAttemptKeys: Set<string>;
  }>;
  attempts: Map<string, {
    effectiveScope: string[];
    decisionPaths: Set<string>;
    mismatchPaths: Set<string>;
    acceptedDuringAttempt: boolean;
  }>;
}

let scopeBatchSequence = 0;

export function createScopeBatchContext(
  projectDir: string,
  stages: StageConfig[],
  snapshot?: RepairRoundSnapshot,
  runId?: string,
): ScopeBatchContext {
  const resolvedSnapshot = snapshot ?? captureRepairRoundSnapshot(
    projectDir,
    stages,
    runId ? { runDirPath: runDir(projectDir, runId) } : undefined,
  );
  const declaredScopes = new Map<string, string[] | null>();
  const inheritedScopes = new Map<string, string[]>();
  const inheritedDecisionPaths = new Map<string, Set<string>>();
  for (const stage of stages) {
    const declared = resolvedSnapshot.declaredScopes[stage.id] ?? stage.scope ?? null;
    const copy = declared === null ? null : [...declared];
    declaredScopes.set(stage.id, copy);
    const inherited = runId ? acceptedInheritedScope(runDir(projectDir, runId), stage) : undefined;
    inheritedScopes.set(stage.id, inherited?.scope ?? (copy ?? []));
    inheritedDecisionPaths.set(stage.id, new Set(inherited?.decisionPaths ?? []));
  }
  scopeBatchSequence++;
  const leaseBatchId = `${runId ?? 'standalone'}:${scopeBatchSequence}`;
  const leasePartitions = new Map(stages.map((stage) => {
    const scope = [...(inheritedScopes.get(stage.id) ?? [])].sort();
    const digest = createHash('sha256')
      .update(`${stage.id}\0${scope.join('\0')}`)
      .digest('hex')
      .slice(0, 16);
    return [stage.id, `scope:${stage.id}:${digest}`];
  }));
  return {
    snapshot: resolvedSnapshot,
    leaseBatchId,
    leasePartitions,
    declaredScopes,
    inheritedScopes,
    inheritedDecisionPaths,
    liveWritePreimages: new Map(),
    liveViolationSequence: 0,
    liveViolations: [],
    attempts: new Map(),
  };
}

export function scopeAttemptKey(stageId: string, attemptIndex: number): string {
  return `${stageId}\u0000${attemptIndex}`;
}

export function getScopeAttemptContext(
  context: ScopeBatchContext,
  stageId: string,
  attemptIndex: number,
): {
  effectiveScope: string[];
  decisionPaths: Set<string>;
  mismatchPaths: Set<string>;
  acceptedDuringAttempt: boolean;
} {
  const key = scopeAttemptKey(stageId, attemptIndex);
  const existing = context.attempts.get(key);
  if (existing) return existing;
  const declared = context.declaredScopes.get(stageId) ?? null;
  const created = {
    // Missing scope is a closed capability, never an implicit allow-all.
    effectiveScope: [...(context.inheritedScopes.get(stageId) ?? (declared ?? []))],
    decisionPaths: new Set(context.inheritedDecisionPaths.get(stageId) ?? []),
    mismatchPaths: new Set<string>(),
    acceptedDuringAttempt: false,
  };
  context.attempts.set(key, created);
  return created;
}

export function addScopeArtifactPath(collection: Set<string>, path: string, runDirPath: string): void {
  collection.add(path.startsWith(runDirPath) ? path.slice(runDirPath.length + 1).replace(/\\/g, '/') : path);
}

export function peerScopeContainsPath(
  context: ScopeBatchContext,
  currentStageId: string,
  rawPath: string,
): boolean {
  for (const [stageId, declaredScope] of context.declaredScopes) {
    if (stageId === currentStageId) continue;
    if (scopeContainsPath(declaredScope ?? [], rawPath)) return true;
    const attemptPrefix = `${stageId}\u0000`;
    for (const [key, attempt] of context.attempts) {
      if (key.startsWith(attemptPrefix) && scopeContainsPath(attempt.effectiveScope, rawPath)) return true;
    }
  }
  return false;
}
