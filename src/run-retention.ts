import { commandUsage, parseCommandArgs } from './cli-args.js';
/** Report and retire invocation scratch without scanning durable stage products. */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { rmSync } from './engine-fs.js';
import { basename, join, resolve } from 'node:path';
import { isTerminalRunStatus } from './lifecycle-status.js';
import { readArchivedRunStateFromDirectory, withRunStateLock, runsRoot, requireKnownRunStatus, RUN_RESERVATION_FILE, RUN_RESERVATION_TTL_MS, type StoreState } from './store.js';
import { inspectRunScheduler } from './run-lock.js';
import { processLiveness, processStartToken, validProcessStartToken } from './process-liveness.js';
import { checkpointConsumers, readHostBootId } from './checkpoint-liveness.js';
import { retireRunScratch } from './invocation-scratch.js';

interface Member { path: string; bytes: number; directory: boolean }
export interface RetentionPlan {
  runId: string;
  status: string;
  removeBytes: number;
  remove: { path: string; bytes: number }[];
  kept: { path: string; reason: string }[];
}
export interface RetentionOptions { dryRun?: boolean }

function children(path: string): string[] {
  try { return readdirSync(path).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function plainDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error('RETENTION_PATH: directory is a link or unsupported entry');
}
function walk(root: string, visit: (member: Member) => void, local = ''): void {
  const path = join(root, local), stat = lstatSync(path);
  const member = { path: local, bytes: stat.size, directory: stat.isDirectory() };
  visit(member);
  if (member.directory) for (const name of children(path)) walk(root, visit, local ? `${local}/${name}` : name);
}

/** Only observed death permits offline scratch retirement; no signal is sent here. */
function assertQuiescent(runPath: string, state: StoreState): void {
  const checkpoint = state.engineCheckpoint;
  if (checkpoint?.bootId !== undefined && (typeof checkpoint.bootId !== 'string'
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(checkpoint.bootId))) throw new Error('RETENTION_PROCESS: boot identity is malformed');
  if (!isTerminalRunStatus(state.status)) throw new Error('RETENTION_NOT_TERMINAL: run is not terminal');
  const scheduler = inspectRunScheduler(state.runId, runPath);
  if (!['missing', 'dead', 'reused'].includes(scheduler.kind)) throw new Error(`RETENTION_PROCESS: scheduler is ${scheduler.kind}`);
  if (checkpoint) {
    if (checkpoint.version !== 2 || checkpoint.runId !== state.runId || checkpoint.projectDir !== state.projectDir) throw new Error('RETENTION_PROCESS: checkpoint binding is unknown');
    const boot = readHostBootId();
    if (!(checkpoint.bootId && boot && checkpoint.bootId !== boot)) {
      if (!Array.isArray(checkpoint.processes)) throw new Error('RETENTION_PROCESS: command ownership is unknown');
      if (!Number.isSafeInteger(checkpoint.pid) || checkpoint.pid <= 0) throw new Error('RETENTION_PROCESS: controller identity is unknown');
      if (processLiveness(checkpoint.pid, checkpoint.processStart) !== 'dead') throw new Error('RETENTION_PROCESS: controller may still be alive');
    }
    for (const group of checkpoint.processes ?? []) {
      if (!group.processStart) continue;
      const current = processStartToken(group.pid);
      if (!validProcessStartToken(group.processStart) || current && current.kind !== group.processStart.kind) throw new Error('RETENTION_PROCESS: command identity is unknown');
    }
    if (checkpointConsumers(checkpoint).length) throw new Error('RETENTION_PROCESS: commands may still be alive');
  } else {
    throw new Error('RETENTION_PROCESS: executed run has no ownership checkpoint');
  }
}

function retainedState(runPath: string): StoreState {
  plainDirectory(runPath);
  if (!lstatSync(join(runPath, 'run.json')).isFile()) throw new Error('RETENTION_PATH: run record is not a regular file');
  const { state: archived } = readArchivedRunStateFromDirectory(runPath);
  const state: StoreState = { ...archived, status: requireKnownRunStatus(archived.status, 'prune run scratch') };
  if (state.runId !== basename(runPath)) throw new Error('RETENTION_PATH: run identity does not match directory');
  return state;
}

function runIsDeletable(runPath: string, state: StoreState): boolean {
  assertQuiescent(runPath, state);
  return (!state.deploymentHold || Boolean(state.deploymentHold.releasedAt)) && !state.parked;
}

function planRetention(runPath: string): RetentionPlan {
  const state = retainedState(runPath);
  const deletable = runIsDeletable(runPath, state);
  const result: RetentionPlan = { runId: state.runId, status: state.status, removeBytes: 0, remove: [], kept: [] };
  const keep = (path: string, reason: string): void => { result.kept.push({ path, reason }); };
  keep('all paths outside invocation scratch', 'durable run history and stage products are not scanned or compacted');
  if (!deletable) { keep('stages/, scratch/', 'park or deployment continuation'); return result; }
  // Invocation scratch has always been disposable at terminal publication, even on failure.
  // Do not let report citations or unfinished stages extend that lifetime.
  if (isTerminalRunStatus(state.status) && children(runPath).includes('scratch')) {
    if (!lstatSync(join(runPath, 'scratch')).isDirectory()) keep('scratch', 'non-directory invocation scratch');
    else walk(join(runPath, 'scratch'), member => {
      if (!member.directory && member.path !== '.tmpdir') {
        result.remove.push({ path: `scratch/${member.path}`, bytes: member.bytes });
        result.removeBytes += member.bytes;
      }
    });
  }
  return result;
}

/** Dry-run does not acquire a lock or write any byte in the store. Apply plans
 * afresh under the same run lock used by scheduler launch/resume/cancellation. */
function retireWorkAreas(runPath: string, options: RetentionOptions): RetentionPlan {
  const plan = planRetention(runPath);
  if (!options.dryRun && !plan.kept.some(entry => entry.path === 'stages/, scratch/')) retireRunScratch(runPath);
  return plan;
}

export function pruneRunWorkAreas(runPath: string, options: RetentionOptions = {}): RetentionPlan {
  runPath = resolve(runPath);
  if (options.dryRun) return retireWorkAreas(runPath, options);
  plainDirectory(runPath);
  return withRunStateLock(runPath, () => retireWorkAreas(runPath, options));
}

/** Legacy clean uses the same ownership and continuation authority as prune. */
function cleanHistory(keep: number): number {
  const root = runsRoot(), entries = children(root).reverse();
  const readable: string[] = [], expired: string[] = [];
  for (const id of entries) {
    const path = join(root, id);
    try {
      if (JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')).runId === id) readable.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      try {
        plainDirectory(path);
        withRunStateLock(path, () => {
          try { readFileSync(join(path, 'run.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') retireRunScratch(path); else throw error; }
        });
        const marker = JSON.parse(readFileSync(join(path, RUN_RESERVATION_FILE), 'utf8'));
        if (marker.version === 1 && marker.runId === id && typeof marker.reservedAt === 'string'
          && Date.now() - Date.parse(marker.reservedAt) > RUN_RESERVATION_TTL_MS) expired.push(id);
      } catch { /* Unknown records and reservations remain intact. */ }
    }
  }
  let cleaned = 0, skipped = 0;
  for (const id of [...readable.slice(keep), ...expired]) {
    const path = join(root, id);
    try {
      plainDirectory(path);
      withRunStateLock(path, () => {
        if (expired.includes(id)) {
          if (!['missing', 'dead', 'reused'].includes(inspectRunScheduler(id, path).kind)) throw new Error('Reservation owner is not settled');
          try { readFileSync(join(path, 'run.json')); throw new Error('Reservation has been published'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const marker = JSON.parse(readFileSync(join(path, RUN_RESERVATION_FILE), 'utf8'));
          if (marker.version !== 1 || marker.runId !== id || typeof marker.reservedAt !== 'string'
            || !(Date.now() - Date.parse(marker.reservedAt) > RUN_RESERVATION_TTL_MS)) throw new Error('Reservation is no longer expired');
        } else {
          if (!runIsDeletable(path, retainedState(path))) throw new Error('Run retains a continuation');
        }
        retireRunScratch(path);
        rmSync(path, { recursive: true, force: true });
        cleaned++;
      });
    } catch { skipped++; }
  }
  process.stdout.write(`Cleaned ${cleaned} old readable/expired-reservation entries (kept ${Math.min(keep, readable.length)} most recent readable runs).\n`);
  if (skipped) process.stdout.write(`Skipped ${skipped} live run(s) or retained/uncertain owners.\n`);
  return 0;
}

/** Explicit scratch retirement and history cleanup share deletion authority. */
export function cmdPrune(args: string[]): number {
  let parsed;
  try { parsed = parseCommandArgs(args[0], args); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  if (parsed.help) { process.stdout.write(`${commandUsage(args[0])}\n`); return 0; }
  if (args[0] === 'clean') return cleanHistory(Number(parsed.values.get('--keep')));
  const flags = parsed.flags;
  if (flags.has('--dry-run') && flags.has('--apply')) {
    process.stderr.write(`${commandUsage('prune')}\n`); return 1;
  }
  const selected = parsed.values.get('--run');
  if (selected && (basename(selected) !== selected || selected === '.' || selected === '..')) {
    process.stderr.write('Unsafe run selection.\n'); return 1;
  }
  const dryRun = !flags.has('--apply');
  const runs: RetentionPlan[] = [];
  const refused: { runId: string; reason: string }[] = [];
  let unclassified = 0;
  const candidates = selected ? [selected] : children(runsRoot()).filter(runId => {
    try {
      if (lstatSync(join(runsRoot(), runId)).isDirectory() && lstatSync(join(runsRoot(), runId, 'run.json')).isFile()) return true;
    } catch { /* An uninitialized reservation is not a terminal run. */ }
    unclassified++; return false;
  });
  for (const runId of candidates) {
    try { runs.push(pruneRunWorkAreas(join(runsRoot(), runId), { dryRun })); }
    catch (error) { refused.push({ runId, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const totalBytes = runs.reduce((sum, run) => sum + run.removeBytes, 0);
  if (flags.has('--json')) process.stdout.write(JSON.stringify({ dryRun, totalBytes, runs, refused, unclassified }) + '\n');
  else {
    for (const run of runs) {
      process.stdout.write(`${run.runId}: ${run.removeBytes} bytes ${dryRun ? 'would be removed' : 'removed'} (${run.status})\n`);
      for (const entry of run.kept) process.stdout.write(`  keep ${entry.path}: ${entry.reason}\n`);
    }
    for (const entry of refused) process.stdout.write(`${entry.runId}: refused: ${entry.reason}\n`);
    if (unclassified) process.stdout.write(`Preserved ${unclassified} unclassified store entries.\n`);
    process.stdout.write(`Total: ${totalBytes} bytes ${dryRun ? 'would be removed (dry-run; no store writes)' : 'removed'}\n`);
  }
  return selected && refused.length ? 1 : 0;
}
