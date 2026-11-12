import { vi } from 'vitest';

/** Keep native child I/O real, but let the test choose when a command deadline
 * expires. Interval-based request reconciliation remains real as well. */
export function controlProcessClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const schedule = globalThis.setTimeout;
  const installed = new Set<number>();
  const waiters = new Map<number, Array<() => void>>();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const timer = schedule(callback, delay, ...args);
    installed.add(delay);
    for (const resolve of waiters.get(delay) ?? []) resolve();
    waiters.delete(delay);
    return timer;
  }) as typeof setTimeout);
  return {
    waitForTimer(delay: number): Promise<void> {
      if (installed.has(delay)) return Promise.resolve();
      return new Promise(resolve => waiters.set(delay, [...(waiters.get(delay) ?? []), resolve]));
    },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}
