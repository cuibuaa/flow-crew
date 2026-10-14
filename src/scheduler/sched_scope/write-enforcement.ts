// Boundary: Restore out-of-scope writes at live and settlement boundaries; respect project ignore policy and retain generated-write telemetry.
import { isLiveConstraintExemptPath, LiveConstraintGuard, type LiveConstraintGuardFactory, type LiveConstraintGuardOptions, isLiveConstraintExemptDirectory, scopeRevisionInstruction, type LiveConstraintContentIdentity } from "../../live-constraint-guard.js";
import { normalizedProjectPath, normalizedProjectContentPath } from "../sched_admission/scope-services.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { ignoredGeneratedPaths } from "../../generated-path-policy.js";
import { loadEngineDefaults } from "../../config.js";
import { recordRunEvent } from "../../run-events.js";
import { runDir } from "../../store.js";
import { isAbsolute, relative, resolve } from "node:path";
import { restoreProjectPath } from './restore.js';
import { type RepairFileImage, compareRepairFileContents } from './file-images.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshotCooperatively } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage, settleRollbackBaselinePath, readRollbackCurrentImageCooperatively, trackedGitlinkAncestor } from './rollback-baseline.js';
import { scopeContainsPath, firstDeclaredInputScopeConflict, listProjectFiles, listProjectFilesAt, type DeclaredInputWriteBinding } from './path-capabilities.js';
import { type ScopeBatchContext } from './scope-batch.js';

interface ScopeWriteEnforcement {
  rawWrites: string[];
  unauthorizedWrites: string[];
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
  declaredInputs?: readonly DeclaredInputWriteBinding[];
  exemptPatterns?: readonly string[];
  rawWrites: string[];
  externalDirectories?: readonly string[];
  definiteWrites: ReadonlySet<string>;
  preserveUnverifiedPath: (path: string) => boolean;
}): ScopeWriteEnforcement {
  const ungoverned = input.effectiveScope === null;
  const rawWrites = [...new Set(input.rawWrites)].filter(path =>
    normalizedProjectPath(path) === undefined || normalizedProjectContentPath(path) !== undefined);
  const unauthorizedWrites: string[] = [];
  const appliedWrites: string[] = [];
  const exemptedWrites: string[] = [];
  const rolledBackWrites: string[] = [];
  const rollbackFailures: string[] = [];
  const rollbackFailureReasons: Record<string, string> = {};
  const durableWrites: string[] = [];
  const ignored = ignoredGeneratedPaths(input.projectDir, rawWrites);
  for (const rawPath of rawWrites) {
    const normalized = normalizedProjectPath(rawPath);
    const definitelyAttributed = input.definiteWrites.has(normalized ?? rawPath);
    if (!normalized) {
      if (isAbsolute(rawPath) && input.externalDirectories?.some(root => {
        const path = relative(root, resolve(rawPath));
        return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
      })) continue;
      if (definitelyAttributed) {
        unauthorizedWrites.push(rawPath);
        rollbackFailures.push(rawPath);
        rollbackFailureReasons[rawPath] = 'write attribution named a non-project path';
      }
      continue;
    }
    const before = input.preimages?.get(normalized)
      ?? input.snapshot.files.get(normalized)
      ?? baselineImage(input.snapshot.rollbackBaseline, normalized);
    const current = readRollbackCurrentImage(input.snapshot.rollbackBaseline, input.projectDir, normalized);
    const readOnly = Boolean(firstDeclaredInputScopeConflict([normalized], input.declaredInputs ?? [], input.projectDir));
    const comparison = compareRepairFileContents(before, current);
    const contentChanged = comparison === 'different';
    // Structured attribution proves a write even when an omitted preimage
    // prevents content comparison. Keep the refusal without inventing absence.
    const attributedUncomparableWrite = definitelyAttributed && comparison === 'unavailable';
    // Preserve the established rollback of an explicitly attributed
    // executable-bit mutation, but do not promote metadata into content truth.
    // In particular, this path is absent from unauthorizedWrites and cannot
    // by itself create a post-attempt constraint violation.
    const attributedModeChange = definitelyAttributed
      && before.exists
      && current.exists
      && before.mode !== undefined
      && current.mode !== undefined
      && before.mode !== current.mode;
    const changed = contentChanged || attributedModeChange || attributedUncomparableWrite;
    const generated = !readOnly && (ignored.has(normalized) || isLiveConstraintExemptPath(
      normalized, input.exemptPatterns ?? [], input.snapshot.rollbackBaseline.trackedPaths,
    ));
    if (generated) {
      exemptedWrites.push(normalized);
      continue;
    }
    if (ungoverned && !readOnly) {
      if (changed) {
        durableWrites.push(normalized);
        settleRollbackBaselinePath(input.snapshot.rollbackBaseline, input.projectDir, normalized);
      }
      continue;
    }
    if (scopeContainsPath(input.effectiveScope ?? [], normalized, input.projectDir, input.declaredInputs)) {
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
    if (contentChanged || attributedUncomparableWrite) unauthorizedWrites.push(normalized);
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
    unauthorizedWrites,
    appliedWrites,
    exemptedWrites,
    rolledBackWrites,
    rollbackFailures,
    rollbackFailureReasons,
    durableWrites,
  };
}

export { readLiveConstraintIncidents } from '../../live-constraint-guard.js';

export function createLiveGuardFactory() {
  function createSchedulerLiveConstraintGuardFactory(input: {
    stage: StageConfig;
    projectDir: string;
    runId: string;
    context: ScopeBatchContext;
  }): LiveConstraintGuardFactory | undefined {
    // Every declared scope is enforceable, including an explicitly empty one.
    // The scheduler selects disjoint writers; the shared batch violation ledger
    // lets every concurrent guard retain the same rollback fact.
    if (!input.stage.scope) return undefined;
    const runDirPath = runDir(input.projectDir, input.runId);
    const projectDefaults = loadEngineDefaults();
    const defaultExemptPatterns = projectDefaults.live_constraint_exempt_patterns;
    const factory: LiveConstraintGuardFactory = ({ attemptIndex }) => {
      const attemptContext = input.context.attempt(input.stage.id, attemptIndex);
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
          scopePresence: input.context.declaredScope(input.stage.id) === null ? 'missing' : 'present',
          gate: input.stage.is_gate === true,
          violatingPaths: paths,
        }),
        scanAndRestore: async (candidatePaths, trigger, attributedWrites) => {
          const baseline = input.context.snapshot.rollbackBaseline;
          const exemptPatterns = defaultExemptPatterns;
          const candidates = new Set<string>();
          const exemptedPaths = new Set<string>();
          const validationGeneratedPaths = new Set<string>();
          const definiteWrites = new Set([...attributedWrites].map(path => trackedGitlinkAncestor(baseline, path) ?? path));
          const addCandidate = (rawPath: string): void => {
            const observedPath = normalizedProjectContentPath(rawPath);
            if (!observedPath) return;
            const path = trackedGitlinkAncestor(baseline, observedPath) ?? observedPath;
            candidates.add(path);
          };
          for (const path of definiteWrites) addCandidate(path);
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
              const path = normalizedProjectContentPath(rawPath);
              if (!path) continue;
              const gitlink = trackedGitlinkAncestor(baseline, path);
              addCandidate(gitlink ?? path);
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
          const ignored = ignoredGeneratedPaths(input.projectDir, [...candidates]);
          const nominated = new Set([...candidatePaths, ...definiteWrites]);
          for (const path of [...candidates].sort()) {
            if (!firstDeclaredInputScopeConflict([path], input.context.declaredInputs, input.projectDir)
                && (ignored.has(path) || isLiveConstraintExemptPath(path, exemptPatterns, baseline.trackedPaths))) {
              exemptedPaths.add(path);
              if (nominated.has(path)) validationGeneratedPaths.add(path);
              continue;
            }
            // Batch snapshots freeze scoped content and declared inputs, even
            // when the run inventory deliberately omits their namespace.
            const before = input.context.snapshot.files.get(path) ?? baselineImage(baseline, path);
            const current = await readRollbackCurrentImageCooperatively(
              baseline,
              input.projectDir,
              path,
              before,
            );
            const comparison = compareRepairFileContents(before, current);
            const definitelyAttributed = definiteWrites.has(path);
            if (comparison === 'equal') continue;
            if (comparison === 'unavailable' && !definitelyAttributed) {
              const entryKind = before.indexEntryKind ?? current.indexEntryKind;
              if (entryKind === 'gitlink' || entryKind === 'sparse_tree' || entryKind === 'unmerged' || entryKind === 'unknown') {
                input.context.recordViolation({ path,
                  reason: `the ${entryKind} index entry cannot be compared to its current worktree representation; no content write was claimed and rollback was not attempted`,
                  restored: false, entryKind, comparisonOutcome: 'unavailable', changeObserved: false, rollbackAttempted: false,
                });
              }
              continue;
            }
            if (scopeContainsPath(attemptContext.effectiveScope, path, input.projectDir, input.context.declaredInputs)) {
              // Commit an authorized write into the shared run baseline. The
              // round snapshot still preserves its preimage for post-attempt
              // per-stage audit and write-conflict checks.
              input.context.preservePreimage(path, before);
              settleRollbackBaselinePath(baseline, input.projectDir, path);
              continue;
            }
            // A disjoint peer owns this path. Its guard is solely responsible for
            // settling the shared live baseline; an observer must never roll the
            // peer's authorized write back.
            if (!definitelyAttributed && input.context.peerOwnsPath(input.stage.id, path)) continue;
            // A failed restoration remains dirty. Reuse its batch fact instead of
            // generating an unbounded incident on every watcher/fallback scan.
            if (input.context.hasUnrestoredViolation(path)) continue;
            const restoration = restoreProjectPath(input.projectDir, path, before);
            if (restoration.restored) {
              settleRollbackBaselinePath(baseline, input.projectDir, path);
            }
            input.context.recordViolation({
              path,
              reason: `${definitelyAttributed
                ? 'the adapter attributed a write outside its admitted scope'
                : 'the concurrent batch observed a write outside every admitted scope partition'}; live enforcement ${restoration.restored
                ? 'restored its preimage before the invocation ended'
                : 'could not restore its preimage'}`,
              restored: restoration.restored,
              entryKind: before.indexEntryKind ?? current.indexEntryKind ?? (before.exists ? 'filesystem' : 'untracked'),
              comparisonOutcome: comparison,
              changeObserved: true,
              rollbackAttempted: true,
              ...(restoration.restored ? {} : {
                rollbackFailure: restoration.failure ?? `could not restore ${path}`,
                unrestoredContent: current.exists && current.sha256 !== undefined && current.byteLength !== undefined
                  && (current.type === 'file' || current.type === 'symlink')
                  ? { state: 'present', type: current.type, sha256: current.sha256, byteLength: current.byteLength } as LiveConstraintContentIdentity
                  : undefined,
              }),

            }, definitelyAttributed ? [input.stage.id] : undefined);
          }
          const violations = input.context.takeViolations(input.stage.id, attemptIndex);
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
    return factory;
  }

  return { createSchedulerLiveConstraintGuardFactory };
}
