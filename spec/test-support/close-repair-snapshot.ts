import { closeRollbackBaseline } from '../../src/scheduler/sched_scope/rollback-baseline.js';
import type { RepairRoundSnapshot } from '../../src/scheduler/sched_scope/snapshots.js';

export function closeRepairRoundSnapshot(snapshot: RepairRoundSnapshot): void {
  closeRollbackBaseline(snapshot.rollbackBaseline.projectDir, snapshot.rollbackBaseline.runDirPath);
}
