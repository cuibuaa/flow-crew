/** Shared checkpoint fate probes; reading these never loads recovery/admission policy. */
import { readFileSync } from 'node:fs';
import { processGroupIsAlive, processStartToken, processStartTokensMatch } from './process-liveness.js';
import type { EngineCheckpoint } from './restart-recovery.js';

export function readHostBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}

/** Query the existing ownership ledger. A proven current boot also retires
 * identity-bound command groups; callers wait for a later empty observation. */
export function checkpointConsumers(checkpoint?: EngineCheckpoint, options: { currentBootId?: string; retire?: boolean } = {}): number[] {
  const boot = Object.hasOwn(options, 'currentBootId') ? options.currentBootId : readHostBootId();
  if (checkpoint?.bootId && boot && checkpoint.bootId !== boot) return [];
  const active: number[] = [];
  for (const group of checkpoint?.processes ?? []) {
    if (!Number.isSafeInteger(group.pid) || group.pid <= 0) throw new Error('RECOVERY_FATE_UNKNOWN: invalid owned command group');
    if (!processGroupIsAlive(group.pid)) continue;
    const currentStart = processStartToken(group.pid);
    if (group.processStart && currentStart && !processStartTokensMatch(group.processStart, currentStart)) continue;
    active.push(group.pid);
    // A missing/reused leader cannot authorize signalling surviving writers.
    if (options.retire && boot && checkpoint!.bootId === boot && group.processStart
        && processStartTokensMatch(group.processStart, currentStart)) {
      try { process.kill(-group.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  return active;
}
