/** Compact settled workspaces without changing the durable run record or its citations. */
import { lstatSync, readdirSync, readFileSync, readlinkSync, readSync, constants } from 'node:fs';
import { rmSync, openSync, closeSync } from './engine-fs.js';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { isTerminalRunStatus, RUN_STATUS } from './lifecycle-status.js';
import { readArchivedRunStateFromDirectory, STAGE_STATUS, withRunStateLock, runsRoot, requireKnownRunStatus, type StoreState } from './store.js';
import { inspectRunScheduler, processIsAlive, processStartToken, processStartTokensMatch, type ProcessStartToken } from './run-lock.js';
import { checkpointCommandFateKnown, checkpointConsumers, readHostBootId } from './checkpoint-liveness.js';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';
import { retireRunScratch } from './invocation-scratch.js';
import { RecordedArtifactContractSchema, type ArtifactPlanStage } from './artifact-declarations.js';

/** Discretionary workspace evidence and its citation sources are bounded separately
 * from required declared artifacts. */
export const RETENTION_SMALL_FILE_BYTES = 1024 * 1024;
export const RETENTION_FILE_BYTES = 8 * 1024 * 1024;
export const RETENTION_STAGE_BYTES = 32 * 1024 * 1024;
const secret = /^(?:auth\.json|credentials\.json|installation_id|tokens?(?:\..*)?)$/i;
const textFile = /\.(?:md|txt|json|ya?ml|csv|tsv|py|sh|[cm]?js|ts)$/i;
const durable = /(?:^|\/)(?:evidence|handoff|patches|outputs|logs)(?:\/|$)|\.(?:patch|diff|bundle|tar(?:\.[a-z0-9]+)?|tgz|zip|log|stdout|stderr|md)$/i;
interface Member { path: string; bytes: number; directory: boolean; link: boolean }
export interface RetentionPlan {
  runId: string;
  status: string;
  removeBytes: number;
  remove: { path: string; bytes: number }[];
  kept: { path: string; reason: string }[];
}
export interface RetentionOptions { dryRun?: boolean; ownerSettled?: boolean }

function children(path: string): string[] {
  try { return readdirSync(path).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function plainDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error('RETENTION_PATH: directory is a link or unsupported entry');
}
function walk(root: string, visit: (member: Member) => void, local = ''): void {
  const path = join(root, local), stat = lstatSync(path);
  const member = { path: local, bytes: stat.size, directory: stat.isDirectory(), link: stat.isSymbolicLink() };
  visit(member);
  if (member.directory) for (const name of children(path)) walk(root, visit, local ? `${local}/${name}` : name);
}

/** Only observed death permits an offline mutation. Automatic calls additionally
 * attest that this controller joined its stage group; no signal is sent here. */
function validStartToken(token: ProcessStartToken): boolean {
  return typeof token?.value === 'string' && (token.kind === 'linux' ? /^\d+$/.test(token.value)
    : token.kind === 'posix-lstart' && token.value.trim().length > 0);
}

function assertQuiescent(runPath: string, state: StoreState, ownerSettled = false): void {
  const checkpoint = state.engineCheckpoint;
  if (checkpoint?.bootId !== undefined && (typeof checkpoint.bootId !== 'string'
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(checkpoint.bootId))) throw new Error('RETENTION_PROCESS: boot identity is malformed');
  const own = ownerSettled && state.engineCheckpoint?.pid === process.pid;
  if (!isTerminalRunStatus(state.status) && !(own && state.status === RUN_STATUS.RUNNING)) throw new Error('RETENTION_NOT_TERMINAL: run is not terminal');
  const scheduler = inspectRunScheduler(state.runId, runPath);
  if (!['missing', 'dead', 'reused'].includes(scheduler.kind)
    && !(own && scheduler.kind === 'live' && scheduler.pid === process.pid)) throw new Error(`RETENTION_PROCESS: scheduler is ${scheduler.kind}`);
  if (!checkpointCommandFateKnown(state)) throw new Error('RETENTION_PROCESS: historical command fate is unknown');
  if (checkpoint) {
    if (![1, 2].includes(checkpoint.version) || checkpoint.runId !== state.runId || checkpoint.projectDir !== state.projectDir) throw new Error('RETENTION_PROCESS: checkpoint binding is unknown');
    const boot = readHostBootId();
    if (!(checkpoint.bootId && boot && checkpoint.bootId !== boot)) {
      if (!Array.isArray(checkpoint.processes)) throw new Error('RETENTION_PROCESS: command ownership is unknown');
      if (!Number.isSafeInteger(checkpoint.pid) || checkpoint.pid <= 0) throw new Error('RETENTION_PROCESS: controller identity is unknown');
      if (!own && processIsAlive(checkpoint.pid)) {
        const current = processStartToken(checkpoint.pid);
        if (!current || !checkpoint.processStart || !validStartToken(checkpoint.processStart) || checkpoint.processStart.kind !== current.kind
          || processStartTokensMatch(checkpoint.processStart, current)) throw new Error('RETENTION_PROCESS: controller may still be alive');
      }
    }
    for (const group of checkpoint.processes ?? []) {
      if (!group.processStart) continue;
      const current = processStartToken(group.pid);
      if (!validStartToken(group.processStart) || current && current.kind !== group.processStart.kind) throw new Error('RETENTION_PROCESS: command identity is unknown');
    }
    if (checkpointConsumers(checkpoint).length) throw new Error('RETENTION_PROCESS: commands may still be alive');
  } else {
    throw new Error('RETENTION_PROCESS: executed run has no ownership checkpoint');
  }
  if (own && Object.values(state.stages).some(stage => stage.status === STAGE_STATUS.RUNNING
    || stage.attempts?.some(attempt => attempt.status === STAGE_STATUS.RUNNING || attempt.status === 'closed'))) throw new Error('RETENTION_UNSETTLED: attempt is not settled');
}

function declarations(runPath: string, state: StoreState): ArtifactPlanStage[] {
  // Both base workflow and admitted dynamic plans can have future readers.
  if (!lstatSync(join(runPath, 'workflow.yaml')).isFile()) throw new Error('RETENTION_CONTRACT: workflow is not a regular file');
  const workflow = parse(readFileSync(join(runPath, 'workflow.yaml'), 'utf8')) as { stages?: ArtifactPlanStage[] };
  if (!Array.isArray(workflow?.stages)) throw new Error('RETENTION_CONTRACT: workflow stages are unavailable');
  const stages = [...workflow.stages, ...(state.planControl?.stages ?? [])];
  for (const stage of stages) {
    if (!stage || typeof stage.id !== 'string' || !RecordedArtifactContractSchema.safeParse(stage.artifact_contract).success) throw new Error('RETENTION_CONTRACT: artifact declarations are unavailable');
  }
  return stages;
}

/** Read bounded recorded reports; logs/native prompts and private files are never
 * citation sources. Workspace reports require an incoming recorded citation. */
function referenceNames(runPath: string, reports: string[]): { names: Set<string>; sources: Set<string> } {
  const names = new Set<string>();
  const linkedNames = new Set<string>();
  const sources = new Set<string>();
  const aliases = reports.map(source => ({ source, physical: prospectivePhysicalPath(source) }));
  const contexts = new Map<string, string[]>();
  const deferred: (() => boolean)[] = [];
  const scannedBytes = new Map<string, number>();
  const scannedFiles = new Set<string>();
  const record = (value: string, source: string, explicit = false): void => {
    const pathLike = value.includes('/');
    let origins = contexts.get(source);
    if (!origins) {
      origins = [...new Set([source, ...aliases.flatMap(alias => source === alias.physical ? [alias.source]
        : source.startsWith(`${alias.physical}/`) ? [join(alias.source, relative(alias.physical, source))] : [])])];
      contexts.set(source, origins);
    }
    if (explicit && value.length <= 4096) for (const origin of origins) {
      names.add(value); names.add(relative(runPath, resolve(dirname(origin), value)).split('\\').join('/'));
    }
    if (explicit) value = value.replace(/\s+["'][^"']*["']\s*$/, '');
    value = value.replace(/^[\s'"`([{<]+|[\s'"`),;.!}\]>]+$/g, '').replace(/(?::\d+(?::\d+)?|#.*)$/, '').replace(/\/\*.*$/, '').replace(/\/$/, '');
    if (!value || value.length > 4096 || !explicit && !pathLike && !/\.[a-z][a-z0-9_.-]*$/i.test(value)) return;
    names.add(value);
    try { value = decodeURIComponent(value); names.add(value); } catch { /* ordinary percent text */ }
    for (const origin of origins) {
      const contextual = relative(runPath, resolve(dirname(origin), value)).split('\\').join('/');
      if ((pathLike || explicit) && contextual && !contextual.startsWith('../')) names.add(contextual);
    }
  };
  const scan = (directory: string, readText = true, onlyFile?: string): void => {
    for (const name of children(directory)) {
      const path = join(directory, name);
      if (onlyFile && path !== onlyFile) continue;
      const local = relative(runPath, path).split('\\').join('/');
      if (secret.test(name) || local === 'scratch') continue;
      const workspace = local.match(/^stages\/[^/]+\/(?:build|scratch)(?=\/|$)/)?.[0];
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = resolve(directory, readlinkSync(path));
        const physical = prospectivePhysicalPath(target);
        if (!workspace) {
          linkedNames.add(target); linkedNames.add(physical);
          linkedNames.add(relative(runPath, physical).split('\\').join('/'));
        }
        continue;
      }
      if (stat.isDirectory()) { scan(path, readText && !/^(?:invocations?|native|node_modules|\.git|\.venv|__pycache__)$/.test(name)); continue; }
      const declaredReport = reports.some(report => path === report || path.startsWith(`${report}/`));
      if ((!readText && !declaredReport) || !stat.isFile() || !textFile.test(name)) continue;
      if (workspace && !declaredReport && !/\.md$/i.test(name)) continue;
      const reportDirectory = /(?:^|\/)(?:evidence|handoff|outputs|declared_outputs|terminal_snapshots)(?:\/|$)/.test(local);
      if (!reportDirectory && (/^(?:summary|progress)\.md$/.test(local) || /(?:^|\/)input(?:_attempt_\d+)?\.md$/.test(local))) continue;
      if (!declaredReport && !reportDirectory && !/\.md$/i.test(name) && !/^(?:stage_record|verdict).*\.json$/.test(name)) continue;
      const readReport = (): boolean => {
        // Workspace Markdown is untrusted corpus content until a recorded report cites it.
        if (workspace && !declaredReport && !names.has(local) && !names.has(path)) return false;
        const physical = prospectivePhysicalPath(path);
        if (scannedFiles.has(physical)) return true;
        const stage = workspace?.split('/').slice(0, 2).join('/') ?? local.split('/').slice(0, 2).join('/');
        const used = scannedBytes.get(stage) ?? 0;
        if (stat.size > RETENTION_SMALL_FILE_BYTES || used + stat.size > RETENTION_STAGE_BYTES) return true;
        if (workspace) sources.add(local);
        scannedFiles.add(physical);
        scannedBytes.set(stage, used + stat.size);
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const buffer = Buffer.alloc(64 * 1024);
          let tail = '', count: number;
          while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            const text = tail + buffer.toString('utf8', 0, count);
            for (const match of text.matchAll(/`([^`]+)`|\]\(([^)]+)\)/g)) record(match[1] ?? match[2], path, true);
            for (const token of text.split(/[\s"'`<>|=(){}[\],;]+/)) record(token, path);
            tail = text.slice(-4096);
          }
        } finally { closeSync(fd); }
        return true;
      };
      if (workspace) deferred.push(readReport); else readReport();
    }
  };
  scan(runPath);
  for (const report of reports) {
    if (report === runPath || report.startsWith(`${runPath}/`)) continue;
    try {
      const stat = lstatSync(report);
      if (stat.isDirectory()) scan(report);
      else if (stat.isFile() && textFile.test(report) && !secret.test(basename(report))) {
        // Reuse the bounded scanner for this one declared file.
        scan(dirname(report), true, report);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Follow only recorded citations, including citations from an admitted workspace report.
  let remaining = deferred;
  while (remaining.length) {
    const next = remaining.filter(read => !read());
    if (next.length === remaining.length) break;
    remaining = next;
  }
  for (const name of linkedNames) names.add(name);
  return { names, sources };
}

function planRetention(runPath: string, options: RetentionOptions): RetentionPlan {
  plainDirectory(runPath);
  if (!lstatSync(join(runPath, 'run.json')).isFile()) throw new Error('RETENTION_PATH: run record is not a regular file');
  const { state: archived } = readArchivedRunStateFromDirectory(runPath);
  const state: StoreState = { ...archived, status: requireKnownRunStatus(archived.status, 'prune run workspaces') };
  if (state.runId !== basename(runPath)) throw new Error('RETENTION_PATH: run identity does not match directory');
  assertQuiescent(runPath, state, options.ownerSettled);
  const result: RetentionPlan = { runId: state.runId, status: state.status, removeBytes: 0, remove: [], kept: [] };
  const keep = (path: string, reason: string): void => { result.kept.push({ path, reason }); };
  keep('all paths outside stage build/scratch and invocation scratch', 'durable run history, patches, outputs, reports, logs, evidence and handoffs');
  if (state.deploymentHold || state.parked) { keep('stages/, scratch/', 'park or deployment continuation'); return result; }
  const workspaces: string[] = [];
  const stageRoot = join(runPath, 'stages');
  if (children(runPath).includes('stages')) plainDirectory(stageRoot);
  const settledLedgers = new Set<string>();
  for (const [id, status] of Object.entries(state.stages)) {
    try {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) continue;
      plainDirectory(join(stageRoot, id));
      const path = join(stageRoot, id, 'status.json');
      if (!lstatSync(path).isFile()) continue;
      if (isDeepStrictEqual(status, JSON.parse(readFileSync(path, 'utf8')))) settledLedgers.add(id);
    } catch { /* Missing, malformed or divergent ledgers cannot authorize disposal. */ }
  }
  for (const id of children(stageRoot)) {
    const path = join(stageRoot, id);
    if (!lstatSync(path).isDirectory()) { keep(`stages/${id}`, 'linked or unknown stage'); continue; }
    const status = state.stages[id];
    for (const name of ['build', 'scratch']) {
      if (!children(path).includes(name)) continue;
      const local = `stages/${id}/${name}`;
      if (!lstatSync(join(path, name)).isDirectory()) { keep(local, 'non-directory workspace or symlink (never followed)'); continue; }
      if (!status || status.status !== STAGE_STATUS.COMPLETE || status.continuation
        || status.attempts?.some(attempt => attempt.status === STAGE_STATUS.RUNNING || attempt.status === 'closed') || !settledLedgers.has(id)) { keep(local, 'unfinished or unknown stage; continuation work'); continue; }
      workspaces.push(local);
    }
  }
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
  if (!workspaces.length) return result;
  const stages = declarations(runPath, state);
  const reports: string[] = [];
  const protectedPaths = new Map<string, string>();
  for (const stage of stages) {
    for (const [artifacts, output] of [[stage.artifact_contract!.reads, false], [stage.artifact_contract!.produces, true]] as const) for (const artifact of artifacts) {
      if (output && artifact.root === 'run' && artifact.kind === 'directory'
        && /^stages\/[^/]+\/(?:build|scratch)$/.test(artifact.path)) continue;
      const source = resolve(artifact.root === 'run' ? runPath : state.projectDir, artifact.path);
      const physical = prospectivePhysicalPath(source);
      const local = relative(prospectivePhysicalPath(runPath), physical).split('\\').join('/');
      if (local && !local.startsWith('../')) protectedPaths.set(local, output ? 'declared product' : 'declared reader (including future retries)');
      if (artifact.root === 'run') protectedPaths.set(artifact.path, output ? 'declared product' : 'declared reader (including future retries)');
      if (output) {
        if (textFile.test(source) && (secret.test(basename(physical)) || !textFile.test(physical))) throw new Error('RETENTION_REPORT: declared report has an unreadable private or unknown target');
        reports.push(source, physical);
      }
    }
  }
  const { names, sources } = referenceNames(runPath, reports);
  // Preserve symlink targets as well as the links, without traversing either.
  const members = new Map<string, Member>();
  const symlinkTargets = new Map<string, string>();
  const workspaceLinks = new Map<string, string>();
  for (const root of workspaces) walk(join(runPath, root), member => {
    const local = member.path ? `${root}/${member.path}` : root;
    members.set(local, member);
    if (member.link) {
      const target = relative(runPath, resolve(dirname(join(runPath, local)), readlinkSync(join(runPath, local)))).split('\\').join('/');
      if (target && !target.startsWith('../')) workspaceLinks.set(local, target);
    }
  });
  const retainedBytes = new Map<string, number>();
  const citedDirectories = new Map<string, string>();
  const ancestorReason = (paths: ReadonlyMap<string, string>, local: string): string | undefined => {
    for (let path = local; path !== '.'; path = dirname(path)) {
      const reason = paths.get(path);
      if (reason) return reason;
    }
    return undefined;
  };
  // Citation sources must survive before their payloads: otherwise a second
  // compaction could erase evidence whose only retained reference just disappeared.
  const priority = ([local, member]: [string, Member]): number => sources.has(local) ? 2 : member.link ? 1 : 0;
  const ordered = [...members].sort((a, b) => priority(b) - priority(a));
  for (const [local, member] of ordered) {
    const root = workspaces.find(root => local === root || local.startsWith(`${root}/`))!;
    const stageRelative = local.startsWith('stages/') ? local.split('/').slice(2).join('/') : local;
    const workspaceRelative = local.slice(root.length + 1);
    const exact = [local, ...(local === root ? [] : [stageRelative]), ...(workspaceRelative.includes('/') ? [workspaceRelative] : []), join(runPath, local)].some(path => names.has(path));
    const stage = local.split('/').slice(0, 2).join('/');
    let reason = ancestorReason(protectedPaths, local);
    if (exact && member.directory && local !== root) citedDirectories.set(local, 'exact report/evidence citation');
    const optional = sources.has(local) ? 'recorded citation source' : member.link ? 'symlink (never followed)' : secret.test(basename(local)) ? 'private file (never opened)'
      : ancestorReason(symlinkTargets, local) ?? (/(?:^|\/)(?:evidence|handoff|patches)(?:\/|$)|\.(?:patch|diff)$/i.test(local) ? 'bounded evidence, handoff or patch' : exact || ancestorReason(citedDirectories, local) ? 'exact report/evidence citation' : undefined);
    if (!reason && !member.directory && optional && member.bytes <= RETENTION_FILE_BYTES
      && (retainedBytes.get(stage) ?? 0) + member.bytes <= RETENTION_STAGE_BYTES) {
      reason = optional;
      retainedBytes.set(stage, (retainedBytes.get(stage) ?? 0) + member.bytes);
    }
    if (reason) {
      keep(local, reason);
      const target = workspaceLinks.get(local);
      if (target) symlinkTargets.set(target, 'bounded symlink target');
    }
    else if (!member.directory) {
      result.remove.push({ path: local, bytes: member.bytes });
      result.removeBytes += member.bytes;
    }
  }
  return result;
}

/** Dry-run does not acquire a lock or write any byte in the store. Apply plans
 * afresh under the same run lock used by scheduler launch/resume/cancellation. */
function compactWorkAreas(runPath: string, options: RetentionOptions): RetentionPlan {
    const plan = planRetention(runPath, options);
    if (options.dryRun) return plan;
    for (const member of plan.remove) {
      // Refuse substituted parents, including a linked workspace or run root.
      for (let path = dirname(join(runPath, member.path)); ; path = dirname(path)) {
        plainDirectory(path);
        if (path === runPath) break;
      }
      rmSync(join(runPath, member.path), { force: true });
    }
    // Keep workspace directory roots for artifact existence/query projections.
    // Remove empty descendants, but never cross a link or durable directory.
    const pruneEmpty = (path: string): void => {
      for (const name of children(path)) {
        const child = join(path, name);
        if (!lstatSync(child).isDirectory()) continue;
        const local = relative(runPath, child).split('\\').join('/');
        if (plan.kept.some(entry => local === entry.path || local.startsWith(`${entry.path}/`))) continue;
        pruneEmpty(child);
        if (!children(child).length && !durable.test(relative(runPath, child))) rmSync(child, { recursive: true });
      }
    };
    for (const stage of children(join(runPath, 'stages'))) for (const name of ['build', 'scratch']) {
      const path = join(runPath, 'stages', stage, name);
      // Only touch ancestors of files admitted to this plan.
      if (plan.remove.some(member => member.path.startsWith(`stages/${stage}/${name}/`))) pruneEmpty(path);
    }
    if (isTerminalRunStatus(plan.status) && !plan.kept.some(entry => entry.path === 'stages/, scratch/')) retireRunScratch(runPath);
    return plan;
}

export function pruneRunWorkAreas(runPath: string, options: RetentionOptions = {}): RetentionPlan {
  runPath = resolve(runPath);
  if (options.dryRun) return compactWorkAreas(runPath, options);
  plainDirectory(runPath);
  return withRunStateLock(runPath, () => compactWorkAreas(runPath, options));
}

/** Terminal publication already owns the run lock. Live controllers defer to
 * their joined-group/finally boundary instead of retiring active scratch. */
export function pruneTerminalWorkAreasUnderLock(runPath: string): void {
  try { compactWorkAreas(resolve(runPath), {}); }
  catch { /* Unknown ownership or evidence keeps the work intact. */ }
}

/** Called after a joined scheduler group, never while a worker/monitor owns it.
 * Retention failure preserves work and cannot turn authored success into failure. */
export function pruneSettledWorkAreas(runPath: string): void {
  try { pruneRunWorkAreas(runPath, { ownerSettled: true }); }
  catch (error) {
    process.stderr.write(`Run retention kept work: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Explicit operator compaction; history deletion remains the separate clean command. */
export function cmdPrune(args: string[]): number {
  const flags = args.slice(1);
  if (flags.some((arg, index) => !['--run', '--dry-run', '--apply', '--json'].includes(arg) && flags[index - 1] !== '--run')
    || (flags.includes('--dry-run') && flags.includes('--apply'))
    || (flags.includes('--run') && (!flags[flags.indexOf('--run') + 1] || flags[flags.indexOf('--run') + 1].startsWith('--')))) {
    process.stderr.write('Usage: flowcrew prune [--run <run-id>] [--dry-run | --apply] [--json]\n');
    return 1;
  }
  const selected = flags.includes('--run') ? flags[flags.indexOf('--run') + 1] : undefined;
  if (selected && (basename(selected) !== selected || selected === '.' || selected === '..')) {
    process.stderr.write('Unsafe run selection.\n'); return 1;
  }
  const dryRun = !flags.includes('--apply');
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
  if (flags.includes('--json')) process.stdout.write(JSON.stringify({ dryRun, totalBytes, runs, refused, unclassified }) + '\n');
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
