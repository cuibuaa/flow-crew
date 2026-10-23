/** One owned wave: keep the approval monitor alive until every child settles. */
import type { StageConfig } from './sched_admission/configuration.js';
import type { StoreState } from '../store.js';

export async function runStageWave<T>(selected: StageConfig[], input: {
  execute: (stage: StageConfig) => Promise<T>;
  monitorApproval: (completion: AbortSignal) => Promise<StoreState | null>;
}): Promise<{ results: PromiseSettledResult<T>[]; parked: StoreState | null }> {
  const completion = new AbortController();
  // Attach rejection handlers immediately; a monitor may fail while a peer is still running.
  const monitors = Promise.allSettled([
    input.monitorApproval(completion.signal),
  ]);
  const results = await Promise.allSettled(selected.map(async stage => input.execute(stage)));
  completion.abort();
  const [approval] = await monitors;
  if (approval.status === 'rejected') throw approval.reason;
  return { results, parked: approval.value };
}
