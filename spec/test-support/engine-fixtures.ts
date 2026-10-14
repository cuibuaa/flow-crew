import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { CampaignInboxOverviewLike } from '../../src/campaign-page.js';

export function emptyInbox(): CampaignInboxOverviewLike {
  return {
    approvals: { status: 'complete', items: [] },
    deferred: { status: 'complete', items: [] },
    stale: { status: 'complete', items: [] },
    patches: { status: 'complete', items: [], coverage: { succeeded: 1, failed: 0 } },
  };
}
export function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}
export function drainDueTimers(timers: Map<number, { deadlineMs: number; callback: () => void }>, monotonicMs: number): void {
  const due = [...timers.entries()]
    .filter(([, timer]) => timer.deadlineMs <= monotonicMs)
    .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs);
  for (const [timerId, timer] of due) {
    timers.delete(timerId);
    timer.callback();
  }
}
