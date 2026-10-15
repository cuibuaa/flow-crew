// Boundary: One batch owns scope partitions, attempt inheritance, preimages and violation delivery.
import type { LiveConstraintContentIdentity, LiveConstraintGitIndexEntryKind } from '../../live-constraint-guard.js';
import type { StageConfig } from '../sched_admission/configuration.js';
import { runDir } from '../../store.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { publishConstraintDecision } from '../../runtime-negotiation.js';
import type { RepairFileImage } from './file-images.js';
import { type RepairRoundSnapshot, captureRepairRoundSnapshot } from './snapshots.js';
import { acceptedInheritedScope } from './scope-revisions.js';
import { scopeContainsPath, resolveDeclaredInputWriteBindings, listProjectFilesAt, type DeclaredInputWriteBinding } from './path-capabilities.js';
import { captureRollbackCurrentImage } from './rollback-baseline.js';
import { isLiveConstraintExemptDirectory, isLiveConstraintExemptPath } from '../../live-constraint-guard.js';
import { loadEngineDefaults } from '../../config.js';
import { normalizedProjectContentPath } from '../sched_admission/scope-services.js';

interface ScopeAttempt {
  readonly effectiveScope: string[];
  readonly decisionPaths: Set<string>;
  readonly mismatchPaths: Set<string>;
  readonly acceptedDuringAttempt: boolean;
}
interface ScopePartition {
  declared: string[] | null;
  inherited: ReturnType<typeof acceptedInheritedScope>;
  attempts: Map<number, ScopeAttempt>;
}
interface BatchViolation {
    path: string;
    reason: string;
    restored: boolean;
    rollbackFailure?: string;
    /** Engine-observed content left by a failed rollback; recovery grants are prospective. */
    unrestoredContent?: LiveConstraintContentIdentity;
    entryKind: LiveConstraintGitIndexEntryKind | 'filesystem' | 'untracked';
    comparisonOutcome: 'different' | 'unavailable';
    changeObserved: boolean;
    rollbackAttempted: boolean;
    targetStageIds: Set<string>;
    deliveredAttemptKeys: Set<string>;
}
type ViolationFact = Omit<BatchViolation, 'targetStageIds' | 'deliveredAttemptKeys'>;

/** Inheritance is changed only after durable publication or re-admission;
 * attempt capabilities and the original attribution cohort remain distinct. */
export class ScopeBatchContext {
  readonly activeStageIds: Set<string>;
  readonly declaredInputs: DeclaredInputWriteBinding[];
  readonly liveWritePreimages = new Map<string, RepairFileImage>();
  private readonly partitions = new Map<string, ScopePartition>();
  private readonly violations: BatchViolation[] = [];
  private readonly initialInputPaths?: ReadonlySet<string>;

  constructor(readonly projectDir: string, stages: StageConfig[], readonly snapshot: RepairRoundSnapshot, runId?: string) {
    this.activeStageIds = new Set(stages.map(stage => stage.id));
    const briefPath = runId && join(runDir(projectDir, runId), 'task_brief.md');
    this.declaredInputs = briefPath && existsSync(briefPath)
      ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(briefPath, 'utf8')) : [];
    // Input membership follows the same tracked-first cache rule as setup and
    // enforcement, including declared data omitted by the project inventory.
    this.initialInputPaths = new Set(this.inputContentPaths());
    for (const path of this.initialInputPaths) {
      if (!snapshot.files.has(path)) snapshot.files.set(path,
        captureRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, path));
    }
    for (const stage of stages) {
      const declared = snapshot.declaredScopes[stage.id] ?? stage.scope ?? null;
      const inherited = runId ? acceptedInheritedScope(runDir(projectDir, runId), stage)
        : { scope: [...(declared ?? [])], decisionPaths: [] };
      this.partitions.set(stage.id, { declared: declared === null ? null : [...declared], inherited, attempts: new Map() });
    }
  }

  /** Enumerate the same input members before execution and at each comparison
   * boundary, so newly created data is visible even outside the project journal. */
  inputContentPaths(): string[] {
    const patterns = loadEngineDefaults().live_constraint_exempt_patterns;
    const tracked = this.snapshot.rollbackBaseline.trackedPaths;
    const members = [...new Set(this.declaredInputs.flatMap(input => {
      // Classify in-project aliases by Git's spelling, while preserving the
      // alias entry itself. External roots retain their project-relative alias.
      const root = normalizedProjectContentPath(relative(this.projectDir, input.resolvedPath)) ?? input.path;
      const paths = input.kind === 'tree' ? listProjectFilesAt(this.projectDir, root, true, {
        complete: true,
        skipDirectory: path => isLiveConstraintExemptDirectory(`${root}/${path}`, patterns, tracked),
      }) : [root];
      if (root !== input.path) paths.push(input.path);
      return paths.filter(path => !isLiveConstraintExemptPath(path, patterns, tracked));
    }))];
    for (const path of members) {
      if (this.initialInputPaths && !this.initialInputPaths.has(path) && !this.snapshot.files.has(path)) {
        // The complete admitted input inventory proves this member was absent,
        // even when the generic project baseline omitted its directory.
        this.snapshot.files.set(path, { exists: false, provenance: 'observed' });
      }
    }
    return members;
  }

  declaredScope(stageId: string): string[] | null { return this.partitions.get(stageId)?.declared ?? null; }

  attempt(stageId: string, index: number): ScopeAttempt {
    const partition = this.partitions.get(stageId)!;
    let attempt = partition.attempts.get(index);
    if (!attempt) {
      attempt = { effectiveScope: [...partition.inherited.scope], decisionPaths: new Set(partition.inherited.decisionPaths),
        mismatchPaths: new Set(), acceptedDuringAttempt: false };
      partition.attempts.set(index, attempt);
    }
    return attempt;
  }

  inherit(stageId: string, inherited: ReturnType<typeof acceptedInheritedScope>): void {
    this.partitions.get(stageId)!.inherited = { scope: [...inherited.scope], decisionPaths: [...inherited.decisionPaths] };
  }

  recordDecision(stageId: string, index: number, publication: ReturnType<typeof publishConstraintDecision>, runDirPath: string): void {
    const attempt = this.attempt(stageId, index);
    const path = relative(runDirPath, publication.path).replace(/\\/g, '/');
    if (publication.kind === 'mismatch') { attempt.mismatchPaths.add(path); return; }
    attempt.decisionPaths.add(path);
    if (publication.decision.accepted !== true || !Array.isArray(publication.decision.effectiveScope)) return;
    const revised = { ...attempt, effectiveScope: [...publication.decision.effectiveScope] as string[], acceptedDuringAttempt: true };
    Object.assign(attempt, revised);
    const inherited = this.partitions.get(stageId)!.inherited;
    this.inherit(stageId, { scope: revised.effectiveScope, decisionPaths: [...new Set([...inherited.decisionPaths, path])] });
  }

  peerOwnsPath(currentStageId: string, path: string): boolean {
    for (const [stageId, partition] of this.partitions) {
      if (stageId === currentStageId) continue;
      if (scopeContainsPath(partition.declared ?? [], path, this.projectDir, this.declaredInputs)) return true;
      for (const attempt of partition.attempts.values()) {
        if (scopeContainsPath(attempt.effectiveScope, path, this.projectDir, this.declaredInputs)) return true;
      }
    }
    return false;
  }

  preservePreimage(path: string, before: RepairFileImage): void {
    if (!this.liveWritePreimages.has(path)) this.liveWritePreimages.set(path, before);
  }

  get violationHistory(): readonly Readonly<BatchViolation>[] { return this.violations; }

  hasUnrestoredViolation(path: string): boolean { return this.violations.some(entry => entry.path === path && !entry.restored); }

  recordViolation(fact: ViolationFact, targetStageIds: Iterable<string> = this.partitions.keys()): void {
    if (this.violations.some(entry => entry.path === fact.path
        && (fact.changeObserved ? !entry.restored : !entry.changeObserved))) return;
    this.violations.push({ ...fact,
      targetStageIds: new Set(targetStageIds), deliveredAttemptKeys: new Set() });
  }

  takeViolations(stageId: string, index: number): ViolationFact[] {
    const attempt = this.attempt(stageId, index);
    const key = `${stageId}\0${index}`;
    return this.violations.flatMap(violation => {
      if (!violation.targetStageIds.has(stageId) || violation.deliveredAttemptKeys.has(key)) return [];
      // Prospective readmission can recover a dirty path without erasing its old evidence.
      if (!attempt.acceptedDuringAttempt && scopeContainsPath(attempt.effectiveScope, violation.path, this.projectDir, this.declaredInputs)) return [];
      violation.deliveredAttemptKeys.add(key);
      if (violation.restored) violation.targetStageIds.delete(stageId);
      const { targetStageIds: _targets, deliveredAttemptKeys: _delivered, ...fact } = violation;
      return [fact];
    });
  }
}

export function createScopeBatchContext(projectDir: string, stages: StageConfig[], snapshot?: RepairRoundSnapshot, runId?: string): ScopeBatchContext {
  return new ScopeBatchContext(projectDir, stages, snapshot ?? captureRepairRoundSnapshot(projectDir, stages,
    runId ? { runDirPath: runDir(projectDir, runId) } : undefined), runId);
}
