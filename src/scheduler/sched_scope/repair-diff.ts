// Boundary: Attribute and serialize scoped repair evidence without changing content truth; gate archive naming comes from a typed service.
import { type StageConfig } from "../sched_admission/configuration.js";
import { type StageStatus } from "../../store.js";
import { join } from "node:path";
import { latestAttemptWrites } from "../sched_admission/frontier.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { type RepairFileImage, repairFileMaterializedBytes, compareRepairFileContents } from './file-images.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshot } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage } from './rollback-baseline.js';
import { readScopeRevisionDecisions } from './scope-revisions.js';
import { type GateArchiveServices } from './gate-attempt.js';

function serializableRepairFileMode(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

function serializableRepairFileImage(image: RepairFileImage): Record<string, unknown> {
  if (!image.exists) return {
    exists: false,
    ...(image.inspectionFailure ? { contentAvailable: false, inspectionFailure: image.inspectionFailure } : {}),
  };
  return {
    exists: true,
    sha256: image.sha256,
    byteLength: image.byteLength,
    binary: image.binary === true,
    type: image.type,
    mode: image.mode === undefined ? undefined : serializableRepairFileMode(image.mode),
    ...(image.gitObjectId ? { gitObjectId: image.gitObjectId } : {}),
    ...(image.materializationFailure ? {
      contentAvailable: false,
      materializationFailure: image.materializationFailure,
    } : { contentAvailable: true }),
    ...(image.symlink ? { symlink: true } : {}),
    ...(image.text === undefined ? {} : { text: image.text }),
  };
}

function repairFilePreimageAvailable(image: RepairFileImage): boolean {
  if (image.inspectionFailure) return false;
  if (!image.exists) return true;
  return image.backingPath !== undefined || repairFileMaterializedBytes(image) !== undefined
    || (image.type === 'file' && image.gitObjectId !== undefined && !image.materializationFailure);
}



export function createRepairDiffWriter(services: Pick<GateArchiveServices, 'gateArchiveCoordinate' | 'canonicalGateRoundArtifactDir'>) {
  const { gateArchiveCoordinate, canonicalGateRoundArtifactDir } = services;

  function writeRepairRoundDiffArtifact(input: {
    snapshot: RepairRoundSnapshot;
    projectDir: string;
    runDirPath: string;
    iteration: number;
    round: number;
    repairStages: StageConfig[];
    statuses: Record<string, StageStatus>;
  }): string {
    const { snapshot, projectDir, runDirPath, iteration, round, repairStages, statuses } = input;
    const writeOwners = new Map<string, Set<string>>();
    for (const stage of repairStages) {
      const { files } = latestAttemptWrites(statuses[stage.id]);
      for (const raw of files) {
        const path = normalizedProjectPath(raw);
        if (!path) continue;
        const owners = writeOwners.get(path) ?? new Set<string>();
        owners.add(stage.id);
        writeOwners.set(path, owners);
      }
    }
  
    const allPaths = new Set<string>([
      ...snapshot.files.keys(),
      ...changedProjectPathsSinceSnapshot(snapshot, projectDir),
      ...writeOwners.keys(),
    ]);
    const files: Record<string, unknown>[] = [];
    for (const path of [...allPaths].sort()) {
      const before = snapshot.files.get(path);
      const baselineBefore = before ?? baselineImage(snapshot.rollbackBaseline, path);
      const after = readRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, path, baselineBefore);
      const authoritativeOwners = [...(writeOwners.get(path) ?? [])].sort();
      const comparison = compareRepairFileContents(baselineBefore, after);
      const beforeExisted = baselineBefore.exists;
      // Mode remains useful descriptive audit evidence, but it is not content
      // identity and never nominates a live violation by itself.
      const modeChanged = beforeExisted && after.exists
        && baselineBefore.mode !== undefined
        && after.mode !== undefined
        && baselineBefore.mode !== after.mode;
      const same = comparison === 'equal' && !modeChanged;
      if (same && authoritativeOwners.length === 0) continue;
  
      let status: string;
      if (!beforeExisted && after.exists) status = 'added';
      else if (beforeExisted && !after.exists) status = 'deleted';
      else if (same) status = 'reported-touched';
      else if (comparison === 'unavailable') status = 'content-unavailable';
      else status = 'modified';
      const declaredScopeMatch = before !== undefined;
      // This public field means the declared-scope capture owns full preimage
      // bytes. A run baseline may privately retain more for safe rollback, but
      // the repair-diff artifact must not claim that as stage-captured content.
      const preimageAvailable = before !== undefined && repairFilePreimageAvailable(before);
      files.push({
        path,
        status,
        preimageAvailable,
        declaredScopeMatch,
        authoritativeWriteStageIds: authoritativeOwners,
        before: before
          ? serializableRepairFileImage(before)
          : beforeExisted
            ? {
                exists: true,
                sha256: baselineBefore.sha256,
                byteLength: baselineBefore.byteLength,
                type: baselineBefore.type,
                mode: baselineBefore.mode === undefined ? undefined : serializableRepairFileMode(baselineBefore.mode),
                ...(baselineBefore.gitObjectId ? { gitObjectId: baselineBefore.gitObjectId } : {}),
                contentCaptured: false,
              }
            : { exists: false, contentCaptured: false },
        after: serializableRepairFileImage(after),
        ...(!preimageAvailable ? { note: 'Preimage identity is retained separately from restoration bytes. No unavailable preimage is treated as a known-absent path.' } : {}),
      });
    }
  
    const coordinate = gateArchiveCoordinate(iteration, round);
    const artifactDir = canonicalGateRoundArtifactDir(runDirPath, coordinate);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, 'repair_diff.json');
    const scopeRevisions = readScopeRevisionDecisions(
      runDirPath,
      repairStages.map((stage) => stage.id),
    );
    const effectiveRepairScopes = Object.fromEntries(repairStages.map((stage) => {
      const accepted = scopeRevisions
        .filter((decision) => decision.stageId === stage.id && decision.accepted === true && Array.isArray(decision.effectiveScope))
        .sort((left, right) => left.attemptIndex - right.attemptIndex)
        .at(-1);
      return [stage.id, accepted?.effectiveScope ?? stage.scope ?? []];
    }));
    writeFileSync(artifactPath, JSON.stringify({
      version: 1,
      iteration,
      round,
      truncated: false,
      capturedAt: snapshot.startedAt,
      completedAt: new Date().toISOString(),
      repairStageIds: repairStages.map((stage) => stage.id),
      declaredScopes: snapshot.declaredScopes,
      effectiveScopes: effectiveRepairScopes,
      scopeRevisions,
      authoritativeWrites: [...writeOwners.entries()].map(([path, owners]) => ({ path, stageIds: [...owners].sort() })),
      files,
    }, null, 2) + '\n', 'utf-8');
    return artifactPath;
  }

  return { writeRepairRoundDiffArtifact };
}
