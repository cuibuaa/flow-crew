import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Admission, not a reservation. Keep capacity policy in the operator's tool. */
export function requireDiskCapacity(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Cannot estimate disk growth: ${bytes}`);
  const installed = join(homedir(), 'bin', 'disk-guard');
  const executable = existsSync(installed) ? installed : 'disk-guard';
  const result = spawnSync(executable, ['need', String(bytes)], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    const message = `Disk admission refused before copying ${bytes} bytes: ${detail}`;
    throw new Error(message);
  }
}
