// Boundary: Restore out-of-scope writes at live and settlement boundaries, retain comparison-unavailable facts and generated-output provenance; receive only configured transient-output discovery.
import { isLiveConstraintExemptPath, LiveConstraintGuard, type LiveConstraintGuardFactory, type LiveConstraintGuardOptions, isLiveConstraintExemptDirectory, scopeRevisionInstruction, type LiveConstraintIncident, resolvePersistedLiveConstraintIncident } from "../../live-constraint-guard.js";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { configuredValidationCommandRole, discoverConfiguredCommandScopes, type createTransientVitestScopeReader } from "../sched_admission/project-capabilities.js";
import { discoverProjectValidation } from "../../project-validation.js";
import { loadProjectDefaults } from "../../config.js";
import { recordRunEvent } from "../../run-events.js";
import { runDir } from "../../store.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { restoreProjectPath } from './restore.js';
import { type RepairFileImage, compareRepairFileContents } from './file-images.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshotCooperatively } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage, settleRollbackBaselinePath, readRollbackCurrentImageCooperatively, trackedGitlinkAncestor } from './rollback-baseline.js';
import { scopeContainsPath, listProjectFiles, listProjectFilesAt } from './path-capabilities.js';
import { type ScopeBatchContext, getScopeAttemptContext, peerScopeContainsPath, scopeAttemptKey } from './scope-batch.js';

interface ScopeWriteEnforcement {
  rawWrites: string[];
  contentChangedWrites: string[];
  appliedWrites: string[];
  exemptedWrites: string[];
  rolledBackWrites: string[];
  rollbackFailures: string[];
  rollbackFailureReasons: Record<string, string>;
  durableWrites: string[];
}

/**
 * `effectiveScope: null` means the stage declared no scope AND never negotiated, so
 * there is no policy to enforce. Auditing those writes is right; restoring their
 * preimage is not — see the three-state note at the call site.
 */
export function enforceStageScopeWrites(input: {
  projectDir: string;
  snapshot: RepairRoundSnapshot;
  preimages?: ReadonlyMap<string, RepairFileImage>;
  effectiveScope: string[] | null;
  exemptPatterns?: readonly string[];
  configuredGeneratedPatterns?: readonly string[];
  validationGeneratedWrites?: readonly string[];
  rawWrites: string[];
  definiteWrites: ReadonlySet<string>;
  preserveUnverifiedPath: (path: string) => boolean;
}): ScopeWriteEnforcement {
  const ungoverned = input.effectiveScope === null;
  const rawWrites = [...new Set(input.rawWrites)];
  const contentChangedWrites: string[] = [];
  const appliedWrites: string[] = [];
  const exemptedWrites: string[] = [];
  const rolledBackWrites: string[] = [];
  const rollbackFailures: string[] = [];
  const rollbackFailureReasons: Record<string, string> = {};
  const durableWrites: string[] = [];
  const validationGeneratedWrites = new Set(input.validationGeneratedWrites ?? []);
  for (const rawPath of rawWrites) {
    const normalized = normalizedProjectPath(rawPath);
    const definitelyAttributed = input.definiteWrites.has(normalized ?? rawPath);
    if (!normalized) {
      if (definitelyAttributed) {
        rollbackFailures.push(rawPath);
        rollbackFailureReasons[rawPath] = 'write attribution named a non-project path';
      }
      continue;
    }
    const before = input.preimages?.get(normalized)
      ?? input.snapshot.files.get(normalized)
      ?? baselineImage(input.snapshot.rollbackBaseline, normalized);
    const current = readRollbackCurrentImage(input.snapshot.rollbackBaseline, input.projectDir, normalized);
    const contentChanged = compareRepairFileContents(before, current) === 'different';
    // Apply the same configured-command provenance rule at the post-attempt
    // boundary as at the live boundary. Without this, a generated file that
    // existed before the stage was exempted live and then rolled back here,
    // while a newly created sibling survived.
    const defaultExemption = isLiveConstraintExemptPath(
      normalized,
      input.exemptPatterns ?? [],
      input.snapshot.rollbackBaseline.trackedPaths,
    );
    const provenValidationOutput = validationGeneratedWrites.has(normalized)
      && isLiveConstraintExemptPath(
        normalized,
        input.configuredGeneratedPatterns ?? [],
        input.snapshot.rollbackBaseline.trackedPaths,
      );
    if (contentChanged && (defaultExemption || provenValidationOutput)) {
      exemptedWrites.push(normalized);
      durableWrites.push(normalized);
      settleRollbackBaselinePath(input.snapshot.rollbackBaseline, input.projectDir, normalized);
      continue;
    }
    if (contentChanged) contentChangedWrites.push(normalized);
    // Preserve the established rollback of an explicitly attributed
    // executable-bit mutation, but do not promote metadata into content truth.
    // In particular, this path is absent from contentChangedWrites and cannot
    // by itself create a post-attempt constraint violation.
    const attributedModeChange = definitelyAttributed
      && before.exists
      && current.exists
      && before.mode !== undefined
      && current.mode !== undefined
      && before.mode !== current.mode;
    const changed = contentChanged || attributedModeChange;
    if (ungoverned) {
      if (changed) {
        durableWrites.push(normalized);
        settleRollbackBaselinePath(input.snapshot.rollbackBaseline, input.projectDir, normalized);
      }
      continue;
    }
    if (scopeContainsPath(input.effectiveScope ?? [], normalized)) {
      if (changed) {
        appliedWrites.push(normalized);
        durableWrites.push(normalized);
        settleRollbackBaselinePath(input.snapshot.rollbackBaseline, input.projectDir, normalized);
      }
      continue;
    }
    if (!changed) continue;
    // Snapshot-only attribution can include another concurrently running stage.
    // Preserve only paths covered by a peer's capability; every path outside
    // the complete batch capability is safe to restore even when ownership is unknown.
    if (!definitelyAttributed && input.preserveUnverifiedPath(normalized)) continue;
    const restoration = restoreProjectPath(input.projectDir, normalized, before);
    if (restoration.restored) {
      rolledBackWrites.push(normalized);
      settleRollbackBaselinePath(input.snapshot.rollbackBaseline, input.projectDir, normalized);
    } else {
      rollbackFailures.push(normalized);
      rollbackFailureReasons[normalized] = restoration.failure ?? `could not restore ${normalized}`;
      durableWrites.push(normalized);
    }
  }
  return {
    rawWrites,
    contentChangedWrites,
    appliedWrites,
    exemptedWrites,
    rolledBackWrites,
    rollbackFailures,
    rollbackFailureReasons,
    durableWrites,
  };
}

export function readLiveConstraintIncidents(
  runDirPath: string,
  stageId: string,
  attemptIndex: number,
): LiveConstraintIncident[] {
  const path = join(
    runDirPath,
    'stages',
    stageId,
    `live_constraint_incidents_attempt_${attemptIndex}.jsonl`,
  );
  try {
    return readFileSync(path, 'utf-8').split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const incident = JSON.parse(line) as LiveConstraintIncident;
        return incident.kind === 'live_constraint_incident'
          && incident.stageId === stageId
          && incident.attemptIndex === attemptIndex
          && typeof incident.path === 'string'
          ? [resolvePersistedLiveConstraintIncident(join(runDirPath, 'stages', stageId), incident)]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export interface ScopeValidationOutputs {
  transientVitestOutputScopes: ReturnType<typeof createTransientVitestScopeReader>;
}

export function createLiveGuardFactory(services: ScopeValidationOutputs) {
  const { transientVitestOutputScopes } = services;

  function createSchedulerLiveConstraintGuardFactory(input: {
    stage: StageConfig;
    projectDir: string;
    runId: string;
    context: ScopeBatchContext;
  }): LiveConstraintGuardFactory | undefined {
    // Every declared scope is enforceable, including an explicitly empty one.
    // Non-empty, scheduler-proven disjoint scopes receive separate writer
    // partitions. Empty scopes take no writer lease, while the shared batch
    // violation ledger lets every concurrent guard retain the same rollback fact.
    if (!input.stage.scope) return undefined;
    const runDirPath = runDir(input.projectDir, input.runId);
    const projectDefaults = loadProjectDefaults(input.projectDir);
    const defaultExemptPatterns = projectDefaults.live_constraint_exempt_patterns;
    const configuredGeneratedPatterns = discoverConfiguredCommandScopes(input.projectDir);
    const transientVitestPatterns = transientVitestOutputScopes(
      input.projectDir, input.runId, configuredGeneratedPatterns,
    );
    const configuredCommands = discoverProjectValidation(input.projectDir).commands;
    const factory: LiveConstraintGuardFactory = ({ attemptIndex }) => {
      const attemptContext = getScopeAttemptContext(input.context, input.stage.id, attemptIndex);
      const currentAttemptKey = scopeAttemptKey(input.stage.id, attemptIndex);
      const options: LiveConstraintGuardOptions = {
        projectDir: input.projectDir,
        runDir: runDirPath,
        stageId: input.stage.id,
        attemptIndex,
        fallbackScanMs: projectDefaults.live_constraint_fallback_scan_ms,
        monitorDeadlineMs: projectDefaults.live_constraint_monitor_deadline_ms,
        effectiveScope: () => attemptContext.effectiveScope,
        watchProject: (listener, onError) => {
          // The run baseline owns the recursive observer and its journal.
          // Invocation closure removes only this subscriber; the run closes
          // the native watcher after every writer and reconciliation settles.
          const watcher = input.context.snapshot.rollbackBaseline.watcher;
          if (!watcher) return undefined;
          const onChange = (_event: string, name: string | Buffer | null) => listener(name?.toString());
          watcher.on('change', onChange);
          watcher.on('error', onError);
          return { close: () => { watcher.off('change', onChange); watcher.off('error', onError); } };
        },
        isValidationCommand: (command) => configuredValidationCommandRole(
          command,
          configuredCommands,
          input.projectDir,
        ) !== undefined,
        onExemptions: (summary) => {
          recordRunEvent(input.projectDir, input.runId, {
            type: 'live_constraint_exemptions',
            runId: input.runId,
            timestamp: new Date().toISOString(),
            stageId: input.stage.id,
            attemptIndex,
            invocationIndex: summary.invocationIndex,
            exemptedCount: summary.exemptedCount,
            detail: `${summary.exemptedCount} untracked generated path${summary.exemptedCount === 1 ? '' : 's'} exempted`,
            source: 'scheduler',
            level: 'info',
          });
        },
        onMonitorFailure: (failure) => {
          recordRunEvent(input.projectDir, input.runId, {
            type: 'live_constraint_monitor_failure',
            runId: input.runId,
            timestamp: failure.detectedAt,
            stageId: input.stage.id,
            attemptIndex,
            invocationIndex: failure.invocationIndex,
            lastScanDurationMs: failure.lastScanDurationMs,
            lastScanFileCount: failure.lastScanFileCount,
            detail: failure.reason,
            source: 'scheduler',
            level: 'warning',
          });
        },
        scopeRevisionInstruction: (paths) => scopeRevisionInstruction({
          runDir: runDirPath,
          runId: input.runId,
          stageId: input.stage.id,
          attemptIndex,
          scope: attemptContext.effectiveScope,
          scopePresence: input.context.declaredScopes.get(input.stage.id) === null ? 'missing' : 'present',
          gate: input.stage.is_gate === true,
          violatingPaths: paths,
        }),
        scanAndRestore: async (candidatePaths, trigger, validationCommandActive) => {
          const baseline = input.context.snapshot.rollbackBaseline;
          const exemptPatterns = validationCommandActive
            ? [...defaultExemptPatterns, ...configuredGeneratedPatterns]
            : [...defaultExemptPatterns, ...transientVitestPatterns];
          const candidates = new Set<string>();
          const exemptCandidates = new Set<string>();
          const exemptedPaths = new Set<string>();
          const validationGeneratedPaths = new Set<string>();
          const validationGeneratedCandidates = new Set<string>();
          const addCandidate = (rawPath: string, directlyObserved = false): void => {
            const observedPath = normalizedProjectPath(rawPath);
            if (!observedPath) return;
            const path = trackedGitlinkAncestor(baseline, observedPath) ?? observedPath;
            const defaultExemption = isLiveConstraintExemptPath(
              path,
              [...defaultExemptPatterns, ...transientVitestPatterns],
              baseline.trackedPaths,
            );
            const configuredValidationExemption = validationCommandActive && isLiveConstraintExemptPath(
              path,
              configuredGeneratedPatterns,
              baseline.trackedPaths,
            );
            if (defaultExemption || configuredValidationExemption) {
              if (directlyObserved) exemptedPaths.add(path);
              exemptCandidates.add(path);
              if (configuredValidationExemption) validationGeneratedCandidates.add(path);
              return;
            }
            candidates.add(path);
          };
          const fullReconciliation = trigger === 'fallback' || trigger === 'phase_boundary';
          if (fullReconciliation) {
            for (const path of listProjectFiles(input.projectDir, {
              skipDirectory: (directory) => (
                trackedGitlinkAncestor(baseline, directory) !== undefined
                || isLiveConstraintExemptDirectory(directory, exemptPatterns, baseline.trackedPaths)
              ),
            })) addCandidate(path);
            for (const path of baseline.images.keys()) addCandidate(path);
            for (const path of baseline.cleanTracked) addCandidate(path);
            for (const path of baseline.trackedPaths) addCandidate(path);
            for (const path of input.context.snapshot.files.keys()) addCandidate(path);
          } else {
            for (const rawPath of candidatePaths) {
              const path = normalizedProjectPath(rawPath);
              if (!path) continue;
              const gitlink = trackedGitlinkAncestor(baseline, path);
              addCandidate(gitlink ?? path, true);
              if (gitlink) continue;
              if (!isLiveConstraintExemptDirectory(path, exemptPatterns, baseline.trackedPaths)) {
                for (const nested of listProjectFilesAt(input.projectDir, path)) addCandidate(nested);
              }
              const prefix = `${path.replace(/\/$/, '')}/`;
              for (const known of new Set([
                ...baseline.cleanTracked,
                ...baseline.trackedPaths,
                ...baseline.images.keys(),
              ])) {
                if (known.startsWith(prefix)) addCandidate(known);
              }
            }
            for (const path of await changedProjectPathsSinceSnapshotCooperatively(input.context.snapshot, input.projectDir)) {
              addCandidate(path);
            }
          }
          for (const path of [...exemptCandidates].sort()) {
            const before = baselineImage(baseline, path);
            const current = await readRollbackCurrentImageCooperatively(
              baseline,
              input.projectDir,
              path,
              before,
            );
            if (compareRepairFileContents(before, current) !== 'different') continue;
            exemptedPaths.add(path);
            if (validationGeneratedCandidates.has(path)) validationGeneratedPaths.add(path);
            settleRollbackBaselinePath(baseline, input.projectDir, path);
          }
          for (const path of [...candidates].sort()) {
            const runBefore = baselineImage(baseline, path);
            // Dependency/cache trees are intentionally omitted from the run
            // baseline. A scoped snapshot still proves their state when this
            // stage batch began. Compare against that image before attributing
            // any later content delta to the stage.
            const before = !runBefore.exists && runBefore.provenance === 'unknown'
              ? input.context.snapshot.files.get(path) ?? runBefore
              : runBefore;
            const current = await readRollbackCurrentImageCooperatively(
              baseline,
              input.projectDir,
              path,
              before,
            );
            const comparison = compareRepairFileContents(before, current);
            if (comparison === 'equal') continue;
            if (comparison === 'unavailable') {
              const entryKind = before.indexEntryKind ?? current.indexEntryKind;
              if (entryKind === 'gitlink' || entryKind === 'sparse_tree' || entryKind === 'unmerged' || entryKind === 'unknown') {
                if (!input.context.liveViolations.some((entry) => (
                  entry.path === path && entry.changeObserved === false
                ))) {
                  input.context.liveViolationSequence++;
                  input.context.liveViolations.push({
                    sequence: input.context.liveViolationSequence,
                    path,
                    reason: `the ${entryKind} index entry cannot be compared to its current worktree representation; no content write was claimed and rollback was not attempted`,
                    restored: false,
                    entryKind,
                    comparisonOutcome: 'unavailable',
                    changeObserved: false,
                    rollbackAttempted: false,
                    targetStageIds: new Set(input.context.declaredScopes.keys()),
                    deliveredAttemptKeys: new Set(),
                  });
                }
              }
              continue;
            }
            if (scopeContainsPath(attemptContext.effectiveScope, path)) {
              // Commit an authorized write into the shared run baseline. The
              // round snapshot still preserves its preimage for post-attempt
              // per-stage audit and write-conflict checks.
              if (!input.context.liveWritePreimages.has(path)) {
                input.context.liveWritePreimages.set(path, before);
              }
              settleRollbackBaselinePath(baseline, input.projectDir, path);
              continue;
            }
            // A disjoint peer owns this path. Its guard is solely responsible for
            // settling the shared live baseline; an observer must never roll the
            // peer's authorized write back.
            if (peerScopeContainsPath(input.context, input.stage.id, path)) continue;
            // A failed restoration remains dirty. Reuse its batch fact instead of
            // generating an unbounded incident on every watcher/fallback scan.
            if (input.context.liveViolations.some((entry) => entry.path === path && !entry.restored)) continue;
            const restoration = restoreProjectPath(input.projectDir, path, before);
            if (restoration.restored) {
              settleRollbackBaselinePath(baseline, input.projectDir, path);
            }
            input.context.liveViolationSequence++;
            input.context.liveViolations.push({
              sequence: input.context.liveViolationSequence,
              path,
              reason: restoration.restored
                ? 'the concurrent batch observed a write outside every admitted scope partition; live enforcement restored its preimage before the invocation ended'
                : 'the concurrent batch observed a write outside every admitted scope partition; live enforcement could not restore its preimage',
              restored: restoration.restored,
              entryKind: before.indexEntryKind ?? current.indexEntryKind ?? (before.exists ? 'filesystem' : 'untracked'),
              comparisonOutcome: 'different',
              changeObserved: true,
              rollbackAttempted: true,
              ...(restoration.restored ? {} : { rollbackFailure: restoration.failure ?? `could not restore ${path}` }),
              // The complete scheduler-selected batch is the attribution cohort.
              // A peer can reach its first guard scan just after this restoration,
              // so keying only the attempts registered at observation time would
              // make attribution depend on microtask order. The path is outside
              // every admitted partition; coarse attribution is therefore safe,
              // and is required for concurrent read-only peers because filesystem
              // notifications cannot identify their writer.
              targetStageIds: new Set(input.context.declaredScopes.keys()),
              deliveredAttemptKeys: new Set(),
            });
          }
          const violations = input.context.liveViolations.flatMap((violation) => {
            if (!violation.targetStageIds.has(input.stage.id)
                || violation.deliveredAttemptKeys.has(currentAttemptKey)) return [];
            violation.deliveredAttemptKeys.add(currentAttemptKey);
            // A restored fact is consumed once by each stage in its cohort,
            // even across readmission. Unrestored facts still reach each new
            // attempt; another write creates a new fact and a fresh cohort.
            if (violation.restored) violation.targetStageIds.delete(input.stage.id);
            return [{
              path: violation.path,
              reason: violation.reason,
              restored: violation.restored,
              entryKind: violation.entryKind,
              comparisonOutcome: violation.comparisonOutcome,
              changeObserved: violation.changeObserved,
              rollbackAttempted: violation.rollbackAttempted,
              ...(violation.rollbackFailure ? { rollbackFailure: violation.rollbackFailure } : {}),
            }];
          });
          for (const violation of violations) {
            recordRunEvent(input.projectDir, input.runId, {
              type: violation.changeObserved === false
                ? 'live_constraint_comparison_unavailable'
                : 'live_constraint_violation',
              runId: input.runId,
              timestamp: new Date().toISOString(),
              stageId: input.stage.id,
              attemptIndex,
              files: [violation.path],
              detail: violation.reason,
              source: 'scheduler',
              level: violation.changeObserved === false ? 'info' : 'warning',
            });
          }
          return {
            scannedPaths: candidates.size,
            violations,
            exemptedPaths: [...exemptedPaths].sort(),
            validationGeneratedPaths: [...validationGeneratedPaths].sort(),
          };
        },
      };
      return new LiveConstraintGuard(options);
    };
    factory.parallelExecution = () => input.context.activeStageIds.size > 1;
    factory.writerLease = {
      batchId: input.context.leaseBatchId,
      partitionId: input.context.leasePartitions.get(input.stage.id) ?? `scope:${input.stage.id}`,
      ownerStageId: input.stage.id,
    };
    return factory;
  }

  return { createSchedulerLiveConstraintGuardFactory };
}
