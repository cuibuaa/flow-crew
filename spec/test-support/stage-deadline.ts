import type { AttemptDeadlineClock } from '../../src/attempt-deadline.js';
import { runStage as executeStage } from '../../src/worker.js';
import { runPreparedWorkflow as executeWorkflow } from './ready-setup.js';

/** Stub stages measure decisions and filesystem settlement, not elapsed time.
 * Each attempt gets a stationary clock; explicit deadline scenario clocks win.
 * Native command limits and Vitest hang protection keep their real clocks. */
export function stationaryStageClock(): AttemptDeadlineClock {
  const startedAt = Date.now();
  return { monotonicNow: () => 0, wallNow: () => startedAt,
    setTimer: () => ({}) as ReturnType<typeof setTimeout>, clearTimer: () => {} };
}

export function runStage(...[adapter, opts]: Parameters<typeof executeStage>) {
  return executeStage(adapter, { ...opts, deadlineClock: opts.deadlineClock ?? stationaryStageClock() });
}

export async function runWorkflow(...args: Parameters<typeof executeWorkflow>) {
  args[13] ??= stationaryStageClock;
  return executeWorkflow(...args);
}
