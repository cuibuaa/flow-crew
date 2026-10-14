import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from './engine-fs.js';
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
      const alias = readFileSync(join(cursor, '.tmpdir'), 'utf8');
      const root = realpathSync(cursor);
      checkAlias(alias, root);
      if (realpathSync(alias) === root) return dirname(alias);
    } catch { /* ordinary temporary directories have no scratch owner */ }
    if (dirname(cursor) === cursor) return inherited;
  }
}

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
  });
}

/** Retire at terminal publication, startup reconciliation, or history deletion.
 * Validate the alias before removing it, then remove the physical scratch tree.
 * Run records and final artifacts have their own, longer history lifetime. */
export function retireRunScratch(runDir: string): void {
  const root = resolve(runDir, 'scratch');
  let alias: string;
  try { alias = readFileSync(join(root, '.tmpdir'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Also discover aliases whose owner directory was removed externally.
    alias = join(scratchParent(), aliasName(root));
  }
  checkAlias(alias, root);
  try {
    if (resolve(readlinkSync(alias)) !== root) throw new Error('SCRATCH_ALIAS_CHANGED');
    rmSync(alias);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  rmSync(root, { recursive: true, force: true });
}

/** Startup repairs interrupted retirement, including dangling aliases. Only
 * this store's owners are eligible; malformed/unknown records stay untouched. */
export function sweepRunScratch(runRoot: string, warn: (message: string) => void): void {
  const owners = new Set<string>();
  const collect = (directory: string): string[] => {
    try { return readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  runRoot = resolve(runRoot);
  for (const name of collect(runRoot)) owners.add(join(runRoot, name));
  const parent = scratchParent();
  for (const name of collect(parent)) {
    if (!/^fc-[a-f0-9]{16}$/.test(name)) continue;
    try {
      const root = readlinkSync(join(parent, name));
      if (!isAbsolute(root) || basename(root) !== 'scratch' || dirname(dirname(root)) !== runRoot) continue;
      checkAlias(join(parent, name), root);
      owners.add(dirname(root));
    } catch { /* unrelated temporary entries are not owned scratch */ }
  }
  for (const owner of owners) {
    try {
      const sweep = (): void => {
        let status: unknown;
        let missing = false;
        try { status = (JSON.parse(readFileSync(join(owner, 'run.json'), 'utf8')) as { status?: unknown }).status; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missing = true;
        }
        if (missing || isTerminalRunStatus(status)) retireRunScratch(owner);
      };
      try {
        // Fence an explicit resume while rechecking the terminal record. Never
        // traverse a substituted run-directory symlink during a store sweep.
        if (!lstatSync(owner).isDirectory()) continue;
        withRunStateLock(owner, sweep);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        sweep();
      }
    } catch (error) {
      warn(`scratch retirement ${owner}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
