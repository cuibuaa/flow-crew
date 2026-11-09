import { readFileSync } from 'node:fs';
import { closeSync, openSync } from './engine-fs.js';
import { readRunRecordFields } from './run-record-fields.js';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';
import { join, relative, isAbsolute } from 'node:path';

const separated = new Set<string>();
/** Route a supplied run directory's records; this does not establish ownership. */
export function hasSeparatedRunLayout(run: string): boolean {
  if (separated.has(run)) return true;
  try {
    const descriptor = openSync(join(run, 'run.json'), 'r');
    let state: { storageLayout?: unknown };
    try { state = readRunRecordFields(descriptor, { storageLayout: 16 }).value as typeof state; }
    finally { closeSync(descriptor); }
    if (state?.storageLayout === 2) { separated.add(run); return true; }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    if (JSON.parse(readFileSync(join(run, 'engine', '.run-reservation.json'), 'utf8')).storageLayout === 2) return true;
  } catch { /* no separated reservation */ }
  return false;
}
export const engineDirectory = (run: string): string => join(run, 'engine');
export const stageWorkPath = (run: string, ...path: string[]): string => join(hasSeparatedRunLayout(run) ? join(run, 'work') : run, ...path);
/** Parent reception must not turn an authored alias into a trusted write to
 * another tree. Read paths retain legacy routing; write destinations stay in work. */
export function stageWritePath(run: string, ...path: string[]): string {
  const target = stageWorkPath(run, ...path);
  const work = stageWorkPath(prospectivePhysicalPath(run));
  if (!pathInTree(work, prospectivePhysicalPath(target))) throw new Error('ENGINE_STATE_REFUSED: stage write resolves outside its work tree');
  return target;
}
export const requestPath = (run: string, ...path: string[]): string => join(run, 'requests', ...path);
export const controlPath = (run: string, ...path: string[]): string => join(run, 'control', ...path);

/** The two public projections retain their operator-facing addresses. All other
 * records use the engine tree. Legacy reading selects the entire old topology. */
export function runRecordPath(run: string, ...path: string[]): string {
  const local = join(...path);
  const absolute = join(run, local);
  if (local === 'run.json' || local === 'events.jsonl') return absolute;
  return pathInTree(run, absolute) && hasSeparatedRunLayout(run) && !pathInTree(engineDirectory(run), absolute) && !pathInTree(stageWorkPath(run), absolute)
    ? join(engineDirectory(run), local) : absolute;
}
export function assertSeparatedRunLayout(run: string): void {
  if (!hasSeparatedRunLayout(run)) throw new Error('RUN_LAYOUT_INCOMPATIBLE: this run predates separated engine/stage storage; retained records remain readable, but continuation requires its original build');
}
export function pathInTree(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith('../'));
}
