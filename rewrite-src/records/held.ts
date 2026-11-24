import { readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Launch } from '../contract/runtime.js';
import type { Result } from '../contract/brief.js';
type RetainedPaths = { project: string; runtime: Pick<Launch['runtime'], 'path'> };

/** The one owner of what reclaiming a run frees: the project copy, the runtime pin and the work root.
 * Raw evidence excludes the retained status snapshot and controller lock identity. */
export function reclaimTargets(storeRoot: string, run: string, launch?: RetainedPaths) {
  const work = join(resolve(storeRoot), 'work', run);
  return { project: launch ? resolve(launch.project) : join(work, 'project'),
    pin: launch ? dirname(join(resolve(storeRoot), launch.runtime.path)) : join(resolve(storeRoot), 'pins', run), work };
}

/** One logical-byte observation over reclaim's extents; errors remain pending, never a complete zero. */
export async function heldBytes(storeRoot: string, run: string, launch?: RetainedPaths): Promise<number> {
  const raw = rawEvidence(join(resolve(storeRoot), 'runs', run));
  const targets = [...Object.values(reclaimTargets(storeRoot, run, launch)), ...raw];
  const roots = targets.filter((target, index) => !targets.some((other, at) => at !== index
    && (target + sep).startsWith(other + sep) && (target !== other || at < index)));
  const seen = new Set<string>();
  let total = 0;
  const visit = async (path: string, root = false): Promise<void> => {
    let info;
    try { info = await lstat(path, { bigint: true }); }
    catch (error) { if (root && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) { for (const name of await readdir(path)) await visit(join(path, name)); return; }
    const inode = `${info.dev}:${info.ino}`;
    if (seen.has(inode)) return;
    seen.add(inode);
    total += Number(info.size);
    if (!Number.isSafeInteger(total)) throw Error('Retained byte sum exceeds safe integer range');
  };
  for (const path of roots) await visit(path, !raw.includes(path));
  return total;
}

export async function measureHeldBytes(storeRoot: string, run: string, launch?: RetainedPaths): Promise<Result<number>> {
  try { return { ok: true, value: await heldBytes(storeRoot, run, launch) }; }
  catch (error) { return { ok: false, kind: 'unavailable', detail: String(error) }; }
}

/** Controller exclusion must survive reclaim: unlinking its identity can bypass a held inode lock. */
export function rawEvidence(record: string): string[] {
  return readdirSync(record).filter(name => !['status.json', 'controller.sqlite', 'controller.sqlite-journal',
    'controller.sqlite-wal', 'controller.sqlite-shm'].includes(name)).map(name => join(record, name));
}
