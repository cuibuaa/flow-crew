import { scopeContainsPath } from './path-capabilities.js';
import { writeFileSync, mkdirSync } from '../../engine-fs.js';

// Boundary: Attribute and serialize scoped repair evidence without changing content truth; gate archive naming comes from a typed service.
import { type StageConfig } from "../sched_admission/configuration.js";
import { type StageStatus } from "../../store.js";
import { join } from "node:path";
import { latestAttemptWrites } from "../sched_admission/frontier.js";

import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { type RepairFileImage, compareRepairFileContents } from './file-images.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshot } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage } from './rollback-baseline.js';
import { type GateArchiveServices } from '../sched_settlement/gate-archives.js';

function serializableRepairFileMode(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

function serializableRepairFileImage(image: RepairFileImage): Record<string, unknown> {
  if (!image.exists) return {
    exists: false,
    provenance: image.provenance ?? 'unknown',
    ...(image.inspectionFailure ? { inspectionFailure: image.inspectionFailure } : {}),
  };
  return {
    exists: true,
    sha256: image.sha256,
    byteLength: image.byteLength,
    binary: image.binary === true,
    type: image.type,
    mode: image.mode === undefined ? undefined : serializableRepairFileMode(image.mode),
    ...(image.gitObjectId ? { gitObjectId: image.gitObjectId } : {}),
    ...(image.materializationFailure ? { materializationFailure: image.materializationFailure } : {}),
    ...(image.symlink ? { symlink: true } : {}),
  };
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
      if (comparison === 'unavailable') status = 'content-unavailable';
      else if (!beforeExisted && after.exists) status = 'added';
      else if (beforeExisted && !after.exists) status = 'deleted';
      else if (same) status = 'reported-touched';
      else status = 'modified';
      const declaredScopeMatch = Object.values(snapshot.declaredScopes).some(scope => scopeContainsPath(scope ?? [], path));
      files.push({
        path,
        status,
        declaredScopeMatch,
        authoritativeWriteStageIds: authoritativeOwners,
        before: serializableRepairFileImage(baselineBefore),
        after: serializableRepairFileImage(after),
      });
    }
  
    const coordinate = gateArchiveCoordinate(iteration, round);
    const artifactDir = canonicalGateRoundArtifactDir(runDirPath, coordinate);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, 'repair_diff.json');
    writeFileSync(artifactPath, JSON.stringify({
      version: 1,
      iteration,
      round,
      truncated: false,
      capturedAt: snapshot.startedAt,
      completedAt: new Date().toISOString(),
      repairStageIds: repairStages.map((stage) => stage.id),
      declaredScopes: snapshot.declaredScopes,
      effectiveScopes: Object.fromEntries(repairStages.map((stage) => [stage.id, stage.scope ?? []])),
      authoritativeWrites: [...writeOwners.entries()].map(([path, owners]) => ({ path, stageIds: [...owners].sort() })),
      files,
    }, null, 2) + '\n', 'utf-8');
    return artifactPath;
  }

  return { writeRepairRoundDiffArtifact };
}
