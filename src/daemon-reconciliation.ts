import { isAbsolute, join } from 'node:path';
import { TaskRegistry, TASK_LIST_STATUS } from './task-registry.js';
import { listRunningRunIdsFromIndex } from './run-index.js';
import { inspectRunScheduler } from './run-lock.js';
import { readRunState, runsRoot, RUN_STATUS } from './store.js';
import { resolveRunIdentity } from './cancellation-policy.js';
import { engineGeneration, readHostBootId, reconcileHostInterruptedRun } from './restart-recovery.js';

/** Explicit daemon capability: constructing a registry/orchestrator is read-only
 * with respect to orphan recovery. No positive liveness decision is cached. */
export function createDaemonReconciler(
  registry: TaskRegistry,
  warn: (message: string) => void,
): () => void {
  let cursor = 0;
  const resolveBinding = (binding: string): string => resolveRunIdentity(
    isAbsolute(binding) ? binding : join(runsRoot(), binding),
  ).runId;
  return () => {
    // A damaged registry may hide a binding, so it cannot authorize an orphan.
    if (registry.health().unreadableRecords || registry.hasUnknownTaskStatuses()) return;
    let uncertainBinding = false;
    const bound = new Set(registry.list({ status: TASK_LIST_STATUS.ACTIVE }).flatMap((task) => {
      if (!task.run_id) return [];
      try { return [resolveBinding(task.run_id)]; }
      catch { uncertainBinding = true; return []; }
    }));
    if (uncertainBinding) return;
    // The existing index discovers/rebuilds new directories. Limit hydration per
    // tick rather than scanning every historical carrier. A missing index is
    // not evidence of absence and does not authorize a fallback writer.
    const ids = listRunningRunIdsFromIndex('') ?? [];
    if (!ids.length) { cursor = 0; return; }
    const boot = readHostBootId();
    const generation = engineGeneration();
    for (let i = 0, count = Math.min(ids.length, 32); i < count; i++) {
      const id = ids[cursor++ % ids.length];
      if (bound.has(id)) continue;
      try {
        const state = readRunState('', id);
        const checkpoint = state.engineCheckpoint;
        if (state.status !== RUN_STATUS.RUNNING) continue;
        const scheduler = inspectRunScheduler(id, join(runsRoot(), id));
        if (scheduler.kind === 'live' || scheduler.kind === 'corrupt' || scheduler.kind === 'unverifiable') continue;
        // Existing recovery owns generation/plan/attempt/intent refusals and
        // run-local publication locks. Fence a controller's new checkpoint.
        registry.withUnboundRun(id, resolveBinding, (assertUnbound) => reconcileHostInterruptedRun(state.projectDir, id, {
          currentBootId: boot, currentGeneration: generation, expectedCheckpoint: checkpoint,
          // Native launch claims scheduler.pid under this same run-local lock.
          // Reobserve at each publication; the initial snapshot is not authority.
          assertSchedulerAbsent: () => {
            const current = inspectRunScheduler(id, join(runsRoot(), id));
            if (current.kind === 'live' || current.kind === 'corrupt' || current.kind === 'unverifiable') {
              throw new Error('RECOVERY_FATE_CHANGED: scheduler acquired ownership during daemon recovery');
            }
            assertUnbound();
          },
        }));
      } catch (error) {
        warn(`orphan recovery ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    cursor %= ids.length;
  };
}
