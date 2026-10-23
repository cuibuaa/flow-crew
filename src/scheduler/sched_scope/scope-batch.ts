// One admitted wave carries its lifecycle and the run's bound immutable evidence.
import type { StageConfig } from '../sched_admission/configuration.js';
import { runDir } from '../../store.js';
import { type RepairRoundSnapshot, captureRepairRoundSnapshot } from './snapshots.js';

export class ScopeBatchContext {
  constructor(readonly snapshot: RepairRoundSnapshot) {}
  declaredScope(stageId: string): string[] | null { return this.snapshot.declaredScopes[stageId] ?? null; }
}
export function createScopeBatchContext(projectDir: string, stages: StageConfig[], snapshot?: RepairRoundSnapshot, runId?: string): ScopeBatchContext {
  return new ScopeBatchContext(snapshot ?? captureRepairRoundSnapshot(projectDir, stages,
    runId ? { runDirPath: runDir(projectDir, runId) } : undefined));
}
