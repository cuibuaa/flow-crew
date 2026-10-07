/** One owned wave: keep monitors alive until every child settles, then close both. */
import type { StageConfig } from './sched_admission/configuration.js';
import type { StoreState } from '../store.js';

export async function runStageWave<T>(selected: StageConfig[], input: {
  activeStageIds: Set<string>;
  execute: (stage: StageConfig) => Promise<T>;
  monitorScope: (isComplete: () => boolean) => Promise<void>;
  monitorApproval: (isComplete: () => boolean) => Promise<StoreState | null>;
}): Promise<{ results: PromiseSettledResult<T>[]; parked: StoreState | null }> {
  let complete = false;
  // Attach rejection handlers immediately; a monitor may fail while a peer is still running.
  const monitors = Promise.allSettled([
    input.monitorScope(() => complete), input.monitorApproval(() => complete),
  ]);
  const results = await Promise.allSettled(selected.map(async (stage) => {
    try { return await input.execute(stage); }
    finally { input.activeStageIds.delete(stage.id); }
  }));
  complete = true;
  const [scope, approval] = await monitors;
  if (scope.status === 'rejected') throw scope.reason;
  if (approval.status === 'rejected') throw approval.reason;
  return { results, parked: approval.value };
}
