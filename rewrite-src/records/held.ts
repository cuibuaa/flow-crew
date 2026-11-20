import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Launch } from '../contract/runtime.js';

/** The one owner of what reclaiming a run frees: the project copy, the runtime pin and the work root.
 * Raw evidence is everything under the run's record directory except its status snapshot. */
export function reclaimTargets(storeRoot: string, run: string, launch: Pick<Launch, 'project' | 'runtime'>) {
  return { project: resolve(launch.project), pin: dirname(join(resolve(storeRoot), launch.runtime.path)),
    work: join(resolve(storeRoot), 'work', run) };
}

/** Raw evidence: every entry of the run's record directory except its status snapshot. */
export function rawEvidence(record: string): string[] {
  return readdirSync(record).filter(name => name !== 'status.json').map(name => join(record, name));
}

function sizeOf(path: string, seen: Set<string>): number {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch { return 0; }
  if (!info.isDirectory()) {
    if (info.nlink > 1) { const id = `${info.dev}:${info.ino}`; if (seen.has(id)) return 0; seen.add(id); }
    return info.size;
  }
  let names: string[];
  try { names = readdirSync(path); } catch { return 0; }
  return names.reduce((sum, name) => sum + sizeOf(join(path, name), seen), 0);
}

/** Bytes a reclaim would free right now. Walks only this run's own directories, never the store. */
export function heldBytes(storeRoot: string, run: string, launch: Pick<Launch, 'project' | 'runtime'>): number {
  const { project, pin, work } = reclaimTargets(storeRoot, run, launch);
  const record = join(resolve(storeRoot), 'runs', run);
  const whole = [project, pin, work].filter((target, index, all) =>
    !all.some((other, at) => at !== index && (target + sep).startsWith(other + sep) && (target !== other || at < index)));
  const seen = new Set<string>();
  let total = whole.reduce((sum, target) => sum + sizeOf(target, seen), 0);
  try { for (const path of rawEvidence(record)) total += sizeOf(path, seen); } catch {}
  return total;
}
