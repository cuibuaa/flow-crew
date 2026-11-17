import { withCurrentBoot } from '../contract/status.mjs';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { idSchema, type Result } from '../contract/brief.js';
import { withState, statusView } from '../records/state.js';
import { parseRunStatusFile, RUN_STATUS_LAYOUT, type RunLocation, type RunStatusFile } from '../contract/runtime.js';

/** One non-yielding SQLite owner reads committed current rows and atomically publishes ordered bytes.
 * Called after domain commit. No cached projection, separate claim, Promise queue, or borrowed connection.
 * Write/rename hold the writer lock; file/directory durability follows release (A11).
 * A crash before sync leaves a regenerable view; publication failure never vetoes a domain commit.
 */
export function publishRunStatus(location: RunLocation, publishedAt: string, activeElapsedMs: number | null, boot?: string): Result<RunStatusFile> {
  if (!idSchema.safeParse(location.run).success || activeElapsedMs !== null && (!Number.isSafeInteger(activeElapsedMs) || activeElapsedMs < 0))
    return {ok:false,kind:'invalid',detail:'Invalid status address or elapsed time'};
  const directory = join(resolve(location.storeRoot), RUN_STATUS_LAYOUT.runsDirectory, location.run);
  let file: number | undefined;
  let result = withState<RunStatusFile>(location.database, true, db => {
    const temporary = join(directory, `.status-${randomUUID()}.tmp`);
    try {
      if (fs.realpathSync(directory) !== directory) return {ok:false,kind:'invalid',detail:'Aliased status directory'};
      const old = readRunStatus(location);
      if (!old.ok && old.kind !== 'unavailable' && old.kind !== 'invalid') return old;
      const candidate = statusView(db, {root:directory,database:location.database}, publishedAt, activeElapsedMs);
      if (!candidate.ok) return candidate;
      if (old.ok && old.value.journalCursor > candidate.value.journalCursor)
        return {ok:false,kind:'conflict',detail:'Status cursor ahead of committed state'};
      const observed = withCurrentBoot(candidate.value, boot);
      const value = old.ok && Date.parse(old.value.publishedAt) > Date.parse(publishedAt)
        ? {...observed,publishedAt:old.value.publishedAt} : observed;
      file = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(file, JSON.stringify(value) + '\n');
      fs.renameSync(temporary, join(directory, RUN_STATUS_LAYOUT.fileName));
      return {ok:true,value};
    } catch (error) { return failure(error); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  });
  try {
    if (result.ok && file !== undefined) {
      fs.fsyncSync(file);
      const parent = fs.openSync(directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } catch (error) { result = failure(error); }
  finally { if (file !== undefined) try { fs.closeSync(file); } catch (error) { result = failure(error); } }
  if (!result.ok) process.stderr.write(`Status publication ${result.kind}: ${result.detail}\n`);
  return result;
}

/** Strict atomic-file reader; never infers liveness from age and does not open the database. */
export function readRunStatus(location: RunLocation): Result<RunStatusFile> {
  if (!idSchema.safeParse(location.run).success) return {ok:false,kind:'invalid',detail:'Invalid run id'};
  const directory = join(resolve(location.storeRoot), RUN_STATUS_LAYOUT.runsDirectory, location.run);
  try {
    if (fs.realpathSync(directory) !== directory) return {ok:false,kind:'invalid',detail:'Aliased status directory'};
    const file = fs.openSync(join(directory, RUN_STATUS_LAYOUT.fileName), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) return {ok:false,kind:'invalid',detail:'Invalid status carrier'};
      let decoded: unknown;
      try { decoded = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) return {ok:false,kind:'invalid',detail:'Malformed status JSON'}; throw error; }
      const result = parseRunStatusFile(decoded);
      return result.ok && result.value.run !== location.run ? {ok:false,kind:'invalid',detail:'Status run mismatch'} : result;
    } finally { fs.closeSync(file); }
  } catch (error) { return failure(error); }
}
function failure(error: unknown): Result<never> {
  const code = (error as NodeJS.ErrnoException).code;
  return {ok:false,kind:code === 'ENOENT' ? 'unavailable' : code === 'EEXIST' ? 'conflict' : code === 'ELOOP' ? 'invalid' : 'unknown',
    detail:error instanceof Error ? error.message : String(error)};
}
