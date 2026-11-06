// One admitted wave carries its lifecycle and the run's bound immutable evidence.
import type { StageConfig } from '../sched_admission/configuration.js';
import { runDir, readRunState } from '../../store.js';
import { readRepairFileImage } from './file-images.js';
import { type RepairRoundSnapshot, captureRepairRoundSnapshot } from './snapshots.js';

export class ScopeBatchContext {
  constructor(readonly snapshot: RepairRoundSnapshot) {}
  declaredScope(stageId: string): string[] | null { return this.snapshot.declaredScopes[stageId] ?? null; }
}
export function createScopeBatchContext(projectDir: string, stages: StageConfig[], snapshot?: RepairRoundSnapshot, runId?: string): ScopeBatchContext {
  const before = snapshot ?? captureRepairRoundSnapshot(projectDir, stages, runId ? { runDirPath: runDir(projectDir, runId) } : undefined);
  const readOnly = stages.some(stage => ['shape', 'review'].includes(stage.decision?.kind ?? '')
    || stage.is_gate && runId && readRunState(projectDir, runId).workflowName === 'entry');
  if (readOnly) for (const path of before.files.keys()) {
    // Reuse the existing rollback store: identity-only estimates cannot restore a reviewer mutation.
    before.files.set(path, readRepairFileImage(projectDir, path, before.rollbackBaseline.gitIndexEntries.get(path), { contentStore: before.rollbackBaseline.contentStore }));
  }
  return new ScopeBatchContext(before);
}
