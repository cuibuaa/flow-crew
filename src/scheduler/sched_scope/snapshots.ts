import { listProjectFiles } from './path-capabilities.js';
import { ignoredProjectPaths } from '../../project-identity.js';
// Boundary: Capture current project preimages and find changes from the baseline journal; candidate selection stays with the production reader.
import { type StageConfig } from "../sched_admission/configuration.js";
import { type RunRollbackBaseline, baselineImage, readRollbackCurrentImage, trackedGitlinkAncestor, captureRollbackCurrentImage, ensureRollbackBaseline } from './rollback-baseline.js';
import { type RepairFileImage, compareRepairFileContents, repairFileImageBytes } from './file-images.js';

export interface RepairSnapshotMeasurement {
  baselineInitialized: boolean;
  baselineStrategy: RunRollbackBaseline['initialization']['strategy'];
  baselineFilesEnumerated: number;
  baselineFilesRead: number;
  baselineFilesHashed: number;
  baselineBytesRead: number;
  baselineBytesHashed: number;
  scopedFilesVisited: number;
  scopedFilesRead: number;
  scopedFilesHashed: number;
  scopedBytesVisited: number;
  scopedBytesRead: number;
  scopedBytesHashed: number;
  outsideScopeFilesVisited: number;
  outsideScopeFilesRead: number;
  outsideScopeFilesHashed: number;
  outsideScopeBytesVisited: number;
  outsideScopeBytesRead: number;
  outsideScopeBytesHashed: number;
  conservativeFallback: boolean;
}

export interface RepairRoundSnapshot {
  startedAt: string;
  declaredScopes: Record<string, string[] | null>;
  files: Map<string, RepairFileImage>;
  /** Run-scoped baseline + change-journal cursor avoid repeated project walks. */
  rollbackBaseline: RunRollbackBaseline;
  journalCursor: number;
  measurement: RepairSnapshotMeasurement;
}

export function changedProjectPathsSinceSnapshot(
  snapshot: RepairRoundSnapshot,
  projectDir: string,
  additionalPaths: readonly string[] = [],
): string[] {
  const baseline = snapshot.rollbackBaseline;
  return [...new Set([...snapshotCandidatePaths(snapshot, projectDir), ...additionalPaths])].filter((path) => {
    const before = baseline.frozenImages.get(path) ?? snapshot.files.get(path) ?? baselineImage(baseline, path);
    const after = readRollbackCurrentImage(baseline, projectDir, path, before);
    return !(after.exists && after.type === 'directory' && !before.exists)
      && compareRepairFileContents(before, after) === 'different';
  });
}

export function captureRepairRoundSnapshot(
  projectDir: string,
  repairStages: StageConfig[],
  options?: { runDirPath?: string },
): RepairRoundSnapshot {
  const ensured = ensureRollbackBaseline(projectDir, options?.runDirPath);
  const baseline = ensured.baseline;
  const declaredScopes = Object.fromEntries(repairStages.map(stage => [stage.id, stage.scope ?? null]));
  const scopedPaths = new Set(listProjectFiles(projectDir, {
    skipDirectory: directory => trackedGitlinkAncestor(baseline, directory) !== undefined,
  }));
  const ignored = ignoredProjectPaths(projectDir, [...scopedPaths]);
  for (const path of ignored) scopedPaths.delete(path);
  const files = new Map<string, RepairFileImage>();
  let scopedFilesRead = 0;
  let scopedFilesHashed = 0;
  let scopedBytesRead = 0;
  let scopedBytesHashed = 0;
  for (const path of scopedPaths) {
    const before = baselineImage(baseline, path);
    const image = captureRollbackCurrentImage(baseline, projectDir, path, before);
    if (image.inspectionFailure || (image.materializationFailure && !image.gitObjectId)) {
      throw new Error(image.inspectionFailure ?? image.materializationFailure);
    }
    if (image !== before) {
      scopedFilesRead++;
      scopedBytesRead += repairFileImageBytes(image);
      if (image.exists && image.sha256 !== undefined) {
        scopedFilesHashed++;
        scopedBytesHashed += repairFileImageBytes(image);
      }
    }
    files.set(path, image);
  }
  const scopedBytes = [...files.values()].reduce((total, image) => total + repairFileImageBytes(image), 0);
  return {
    startedAt: new Date().toISOString(),
    declaredScopes,
    files,
    rollbackBaseline: baseline,
    journalCursor: baseline.journalSequence,
    measurement: {
      baselineInitialized: ensured.initialized,
      baselineStrategy: baseline.initialization.strategy,
      baselineFilesEnumerated: ensured.initialized ? baseline.initialization.filesEnumerated : 0,
      baselineFilesRead: ensured.initialized ? baseline.initialization.filesRead : 0,
      baselineFilesHashed: ensured.initialized ? baseline.initialization.filesHashed : 0,
      baselineBytesRead: ensured.initialized ? baseline.initialization.bytesRead : 0,
      baselineBytesHashed: ensured.initialized ? baseline.initialization.bytesHashed : 0,
      scopedFilesVisited: scopedPaths.size,
      scopedFilesRead,
      scopedFilesHashed,
      scopedBytesVisited: scopedBytes,
      scopedBytesRead,
      scopedBytesHashed,
      outsideScopeFilesVisited: 0,
      outsideScopeFilesRead: 0,
      outsideScopeFilesHashed: 0,
      outsideScopeBytesVisited: 0,
      outsideScopeBytesRead: 0,
      outsideScopeBytesHashed: 0,
      conservativeFallback: !baseline.reliable,
    },
  };
}

function snapshotCandidatePaths(snapshot: RepairRoundSnapshot, projectDir: string): string[] {
  const baseline = snapshot.rollbackBaseline;
  const candidates = baseline.reliable
    ? new Set([
        ...snapshot.files.keys(),
        ...[...baseline.journal.entries()]
          .filter(([, sequence]) => sequence > snapshot.journalCursor)
          .map(([path]) => path),
      ])
    : new Set([
        ...listProjectFiles(projectDir, {
          skipDirectory: (directory) => trackedGitlinkAncestor(baseline, directory) !== undefined,
        }),
        ...baseline.images.keys(),
        ...snapshot.files.keys(),
      ]);
  if (!baseline.reliable) snapshot.measurement.conservativeFallback = true;
  return [...candidates].sort();
}
