import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from './engine-fs.js';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const aliasName = (root: string): string => `fc-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
function checkAlias(alias: string, root: string): void {
  if (!isAbsolute(alias) || basename(alias) !== aliasName(root)) throw new Error('SCRATCH_ALIAS_CHANGED');
}

function scratchParent(): string {
  const inherited = tmpdir();
  // A nested engine must not put its aliases beneath its caller's disposable
  // invocation directory. Reuse that owner's stable alias parent instead.
  for (let cursor = resolve(inherited); ; cursor = dirname(cursor)) {
    try {
      const alias = readFileSync(join(cursor, '.tmpdir'), 'utf8');
      const root = realpathSync(cursor);
      checkAlias(alias, root);
      if (realpathSync(alias) === root) return dirname(alias);
    } catch { /* ordinary temporary directories have no scratch owner */ }
    if (dirname(cursor) === cursor) return inherited;
  }
}

/** Scratch has its owner's lifetime: run history when present, otherwise the
 * command. Only the short alias lives outside run storage. Publish its address
 * before creating it so even a controller crash leaves cleanup discoverable. */
export function createInvocationScratch(runDir?: string): { path: string; cleanup: () => void } {
  if (!runDir) {
    const path = mkdtempSync(join(scratchParent(), 'fc-'));
    return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  }
  const root = resolve(runDir, 'scratch');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const record = join(root, '.tmpdir');
  let alias = join(scratchParent(), aliasName(root));
  try { writeFileSync(record, alias, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    alias = readFileSync(record, 'utf8');
  }
  checkAlias(alias, root);
  try { symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || resolve(readlinkSync(alias)) !== root) throw error;
  }
  // The existing integrity boundary excludes private .tmp-* trees, including
  // their sockets and build products, from engine-carrier inspection.
  const path = mkdtempSync(join(alias, '.tmp-'));
  return { path, cleanup: () => {} };
}

/** Called only once the run is safe to delete. Never follow an external alias
 * during retirement; a replaced or unrelated path is preserved. The run tree
 * itself contains all payloads and is removed by ordinary history cleanup. */
export function retireRunScratch(runDir: string): void {
  const root = resolve(runDir, 'scratch');
  let alias: string;
  try { alias = readFileSync(join(root, '.tmpdir'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  checkAlias(alias, root);
  try {
    if (resolve(readlinkSync(alias)) !== root) throw new Error('SCRATCH_ALIAS_CHANGED');
    rmSync(alias);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
