// Boundary: Capture declared-scope preimages and find changes from the baseline journal; synchronous and cooperative readers share candidate selection.
import { type ParsedScope, parseDeclaredScope } from "../sched_admission/frontier.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { type RunRollbackBaseline, baselineImage, readRollbackCurrentImage, trackedGitlinkAncestor, readRollbackCurrentImageCooperatively, rollbackBaselines, captureRollbackCurrentImage, ensureRollbackBaseline } from './rollback-baseline.js';
import { type RepairFileFingerprint, type RepairFileImage, compareRepairFileContents, repairFileImageBytes, stageZeroIndexEntry } from './file-images.js';
import { listProjectFiles, listProjectFilesAt } from './path-capabilities.js';

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
  captureAll: boolean;
  /** Full-tree fingerprints detect content-object changes, including scope escapes. */
  allFileFingerprints: Map<string, RepairFileFingerprint>;
  /** Full preimages make definite unauthorized writes atomically reversible. */
  allFileImages: Map<string, RepairFileImage>;
  files: Map<string, RepairFileImage>;
  /** Run-scoped baseline + change-journal cursor avoid repeated project walks. */
  rollbackBaseline: RunRollbackBaseline;
  journalCursor: number;
  measurement: RepairSnapshotMeasurement;
}

export function changedProjectPathsSinceSnapshot(
  snapshot: RepairRoundSnapshot,
  projectDir: string,
): string[] {
  const baseline = snapshot.rollbackBaseline;
  return snapshotCandidatePaths(snapshot, projectDir).filter((path) => {
    const before = snapshot.files.get(path) ?? baselineImage(baseline, path);
    const after = readRollbackCurrentImage(baseline, projectDir, path, before);
    return compareRepairFileContents(before, after) === 'different';
  });
}

export async function changedProjectPathsSinceSnapshotCooperatively(
  snapshot: RepairRoundSnapshot,
  projectDir: string,
): Promise<string[]> {
  const baseline = snapshot.rollbackBaseline;
  const changed: string[] = [];
  for (const path of snapshotCandidatePaths(snapshot, projectDir)) {
    const before = snapshot.files.get(path) ?? baselineImage(baseline, path);
    const after = await readRollbackCurrentImageCooperatively(baseline, projectDir, path, before);
    if (compareRepairFileContents(before, after) === 'different') changed.push(path);
  }
  return changed;
}

/** Explicit lifecycle hook for standalone repair-snapshot consumers and tests. */
export function closeRepairRoundSnapshot(snapshot: RepairRoundSnapshot): void {
  snapshot.rollbackBaseline.watcher?.close();
  snapshot.rollbackBaseline.contentStore.cleanup();
  rollbackBaselines.delete(snapshot.rollbackBaseline.key);
}

export function captureRepairRoundSnapshot(
  projectDir: string,
  repairStages: StageConfig[],
  options?: { runDirPath?: string },
): RepairRoundSnapshot {
  const ensured = ensureRollbackBaseline(projectDir, options?.runDirPath);
  const baseline = ensured.baseline;
  const declaredScopes: Record<string, string[] | null> = {};
  const parsedScopes: ParsedScope[] = [];
  let captureAll = false;
  for (const stage of repairStages) {
    declaredScopes[stage.id] = stage.scope ?? null;
    if (stage.scope === undefined) {
      captureAll = true;
      continue;
    }
    for (const raw of stage.scope) {
      const parsed = parseDeclaredScope(raw);
      parsedScopes.push(parsed);
      if (parsed.kind === 'unknown') captureAll = true;
    }
  }

  const scopedPaths = new Set<string>();
  const addScopedTree = (root: string): void => {
    const gitlink = trackedGitlinkAncestor(baseline, root);
    if (gitlink) {
      scopedPaths.add(gitlink);
      return;
    }
    for (const path of listProjectFilesAt(projectDir, root)) scopedPaths.add(path);
  };
  if (captureAll) {
    for (const path of listProjectFiles(projectDir, {
      skipDirectory: (directory) => trackedGitlinkAncestor(baseline, directory) !== undefined,
    })) scopedPaths.add(path);
    for (const [path, entries] of baseline.gitIndexEntries) {
      if (stageZeroIndexEntry(entries)?.kind === 'gitlink') scopedPaths.add(path);
    }
  } else {
    for (const scope of parsedScopes) {
      if (scope.kind === 'exact' || scope.kind === 'tree') {
        addScopedTree(scope.value);
        if (scope.kind === 'exact') scopedPaths.add(scope.value);
      } else if (scope.kind === 'glob') {
        if (!scope.directoryPrefix) {
          for (const path of listProjectFiles(projectDir, {
            skipDirectory: (directory) => trackedGitlinkAncestor(baseline, directory) !== undefined,
          })) scopedPaths.add(path);
        } else {
          addScopedTree(scope.directoryPrefix);
        }
      }
    }
    for (const [path, entries] of baseline.gitIndexEntries) {
      if (stageZeroIndexEntry(entries)?.kind === 'gitlink'
          && parsedScopes.some((scope) => scopeMatchesProjectPath(scope, path))) {
        scopedPaths.add(path);
      }
    }
  }
  const files = new Map<string, RepairFileImage>();
  let scopedFilesRead = 0;
  let scopedFilesHashed = 0;
  let scopedBytesRead = 0;
  let scopedBytesHashed = 0;
  for (const path of scopedPaths) {
    const before = baselineImage(baseline, path);
    const image = captureRollbackCurrentImage(baseline, projectDir, path, before);
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
  // Exact paths need an explicit absent preimage so a newly-created file is
  // distinguishable from an out-of-scope write whose preimage was unavailable.
  for (const scope of parsedScopes) {
    if (scope.kind === 'exact' && !files.has(scope.value)) {
      files.set(scope.value, captureRollbackCurrentImage(baseline, projectDir, scope.value));
    }
  }
  const scopedBytes = [...files.values()].reduce((total, image) => total + repairFileImageBytes(image), 0);
  return {
    startedAt: new Date().toISOString(),
    declaredScopes,
    captureAll,
    allFileFingerprints: baseline.fingerprints,
    allFileImages: baseline.images,
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
