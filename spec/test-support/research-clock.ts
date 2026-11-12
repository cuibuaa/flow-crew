import { vi } from 'vitest';
import * as deadlines from '../../src/attempt-deadline.js';
import type { AttemptDeadlineClock } from '../../src/attempt-deadline.js';

/** Logical deadline time advances only after the test observes real work ready. */
export function manualResearchClock() {
  let elapsed = 0; const started = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const clock: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
    setTimer(callback, delay) { const timer = {} as ReturnType<typeof setTimeout>; timers.set(timer, { at: elapsed + delay, callback }); return timer; },
    clearTimer(timer) { timers.delete(timer); } };
  return { clock, timers, advanceTo(value: number) {
    elapsed = value; for (const [timer, entry] of [...timers]) if (entry.at <= elapsed) { timers.delete(timer); entry.callback(); }
  } };
}

/** Inject the existing deadline primitive; OS processes and close events stay real.
 * Date.now is also controlled because research owns absolute persisted deadlines.
 * Explicit attempt clocks still belong to their caller. Fixture teardown restores
 * mocks and real Date; process timers and the runner hang guard stay real.
 */
export function controlResearchTime() {
  const time = manualResearchClock(), schedule = deadlines.scheduleDeadline;
  const started = time.clock.wallNow();
  // Persisted run starts use new Date(), so both Date APIs must share time.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(started);
  vi.spyOn(deadlines, 'scheduleDeadline').mockImplementation((callback, remaining, clock) =>
    schedule(callback, remaining, clock ?? time.clock));
  return { ...time, advanceTo(value: number) {
    vi.setSystemTime(started + value);
    time.advanceTo(value);
  } };
}
