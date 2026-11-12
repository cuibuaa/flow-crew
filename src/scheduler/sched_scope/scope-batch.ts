// One admitted wave carries its lifecycle and the run's bound immutable evidence.
import type { StageConfig } from '../sched_admission/configuration.js';
import { runDir } from '../../store.js';
import { readRepairFileImage } from './file-images.js';
import { type RepairRoundSnapshot, captureRepairRoundSnapshot } from './snapshots.js';
import { listProjectFiles } from './path-capabilities.js';
import { trackedGitlinkAncestor } from './rollback-baseline.js';

export class ScopeBatchContext {
  constructor(readonly snapshot: RepairRoundSnapshot) {}
  declaredScope(stageId: string): string[] | null { return this.snapshot.declaredScopes[stageId] ?? null; }
}
export function createScopeBatchContext(projectDir: string, stages: StageConfig[], snapshot?: RepairRoundSnapshot, runId?: string): ScopeBatchContext {
  const before = snapshot ?? captureRepairRoundSnapshot(projectDir, stages, runId ? { runDirPath: runDir(projectDir, runId) } : undefined);
  const readOnly = stages.some(stage => ['shape', 'review'].includes(stage.decision?.kind ?? '')
    || stage.is_gate);
  if (readOnly) for (const path of new Set([...before.files.keys(), ...listProjectFiles(projectDir, {
    complete: true, skipDirectory: directory => trackedGitlinkAncestor(before.rollbackBaseline, directory) !== undefined,
  })])) {
    // Replace the Git-filtered estimate with observed preimages, including ignored
    // content and topology. Special entries retain unknown preimages so an
    // inventory miss cannot authorize deleting an existing entry.
    const image = readRepairFileImage(projectDir, path, before.rollbackBaseline.gitIndexEntries.get(path), { contentStore: before.rollbackBaseline.contentStore });
    if (image.inspectionFailure || image.materializationFailure) {
      throw new Error(image.inspectionFailure ?? image.materializationFailure);
    }
    before.files.set(path, image);
  }
  return new ScopeBatchContext(before);
}
