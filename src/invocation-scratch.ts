import { runRecordPath, stageWorkPath, stageWritePath, hasSeparatedRunLayout } from './run-layout.js';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, symlinkSync, writeFileSync } from './engine-fs.js';
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { isTerminalRunStatus } from './lifecycle-status.js';
import { withRunStateLock } from './store.js';
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
      const root = realpathSync(cursor);
      if (lstatSync(cursor).isSymbolicLink()) {
        checkAlias(cursor, root);
        return dirname(cursor);
      }
      const owner = basename(root) === 'scratch' && basename(dirname(root)) === 'work' ? dirname(dirname(root)) : undefined;
      const record = owner && hasSeparatedRunLayout(owner) ? scratchRecord(owner) : join(cursor, '.tmpdir');
      const alias = readFileSync(record, 'utf8');
      checkAlias(alias, root);
      if (realpathSync(alias) === root) return dirname(alias);
    } catch { /* ordinary temporary ancestors have no verified owner alias */ }
    if (dirname(cursor) === cursor) return inherited;
  }
}

const scratchRecord = (run: string): string => runRecordPath(run, 'scratch', '.tmpdir');

/** Scratch has its owner's lifetime: the non-terminal run when present, otherwise the
 * command. Only the short alias lives outside run storage. Publish its address
 * before creating it so even a controller crash leaves cleanup discoverable. */
export function createInvocationScratch(runDir?: string): { path: string; cleanup: () => void } {
  if (!runDir) {
    const path = mkdtempSync(join(scratchParent(), 'fc-'));
    return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return withRunStateLock(runDir, () => {
    // Post-terminal commands (for example a completion hook) have only their
    // command lifetime. Fence allocation against cancellation/terminal commit.
    try {
      const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { status?: unknown };
      if (isTerminalRunStatus(state.status)) return createInvocationScratch();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Storage settles through physical run identity. All command paths must
    // derive the same alias even when reached through a parent's scratch link.
    const root = hasSeparatedRunLayout(runDir) ? stageWritePath(realpathSync(runDir), 'scratch') : resolve(realpathSync(runDir), 'scratch');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const record = scratchRecord(runDir);
    mkdirSync(dirname(record), { recursive: true });
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
    // Invocation children occupy the stage work tree, including sockets and builds.
    const path = mkdtempSync(join(alias, '.tmp-'));
    return { path, cleanup: () => {} };
  });
}

/** Retire at terminal publication, explicit cleanup, or history deletion.
 * Validate alias ownership, then remove the tree before its alias so interrupted
 * retirement can be retried by explicit cleanup.
 * Run records and final artifacts have their own, longer history lifetime. */
export function retireRunScratch(runDir: string): void {
  try { runDir = realpathSync(runDir); } catch { /* deleted owners retain their supplied identity */ }
  const root = hasSeparatedRunLayout(runDir) ? stageWorkPath(runDir, 'scratch') : resolve(runDir, 'scratch');
  let alias: string;
  try { alias = readFileSync(scratchRecord(runDir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Also discover aliases whose owner directory was removed externally.
    alias = join(scratchParent(), aliasName(root));
  }
  checkAlias(alias, root);
  try {
    if (resolve(readlinkSync(alias)) !== root) throw new Error('SCRATCH_ALIAS_CHANGED');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  rmSync(root, { recursive: true, force: true });
  rmSync(alias, { force: true });
  if (hasSeparatedRunLayout(runDir)) {
    const record = scratchRecord(runDir);
    rmSync(record, { force: true });
    try { rmdirSync(dirname(record)); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
}

/** Repair aliases for deleted owners without entering any retained run tree. */
export function sweepRunScratch(runRoot: string, warn: (message: string) => void): void {
  const parent = scratchParent();
  let names: string[];
  try { names = readdirSync(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const alias = join(parent, name);
    let root: string;
    try {
      root = readlinkSync(alias);
      if (!isAbsolute(root) || basename(root) !== 'scratch' || (basename(dirname(root)) === 'work' ? dirname(dirname(dirname(root))) : dirname(dirname(root))) !== resolve(runRoot)) continue;
      checkAlias(alias, root);
    } catch { continue; } // unrelated temporary entries are not owned scratch
    try {
      try { lstatSync(basename(dirname(root)) === 'work' ? dirname(dirname(root)) : dirname(root)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        unlinkSync(alias);
      }
    } catch (error) {
      warn(`scratch retirement ${dirname(root)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
