import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import type { Readable } from 'node:stream';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactContractSchema, producesEngineOwnedArtifact, resolveArtifactLocation, type ArtifactContract } from './artifact-declarations.js';
import { containsEngineOwnedRunPath, engineOwnedGlobalCarriers, isEngineOwnedRunPath } from './engine-owned-carriers.js';
import { LINUX_ENGINE_WRITE_BOUNDARY } from './write-boundary-linux.js';
import type { RunEvent } from './run-events.js';
import { appendTextRecord } from './append-boundary.js';
import { fcGlobalDir } from './store.js';

export interface EngineWriteBoundaryInput {
  projectDir: string;
  runDir: string;
  stageId: string;
  isGate?: boolean;
  /** Structured scheduler flag authorizes the planner transport channels. */
  dynamicDispatch?: boolean;
  /** A typed final answer replaces the child's plan/verdict publication slot. */
  structuredResult?: boolean;
  artifactContract: ArtifactContract;
  /** The already-admitted project capability; absent/empty is read-only. */
  projectWriteScope?: readonly string[];
  attemptIndex?: number;
  /** Trusted observer calls may read project/run state, never publish it. */
  authority?: 'stage' | 'observer' | 'project-command';
}
export type EngineChildBoundaryReceipt =
  | { kind: 'installed'; abi: number; pid: number; fileCapabilities: number; directoryCapabilities: number;
      /** Absent in historical receipts: no retrospective scope claim. */
      scopes?: { signal: 'enforced' | 'unavailable'; abstractUnixSocket: 'enforced' | 'unavailable' } }
  | { kind: 'waiting'; phase: 'pre_execution'; pid: number; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'spawn_error'; message: string; code?: string; syscall: string; path: string; cwd: string };
export interface EngineCommandBoundaryInput {
  projectDir: string;
  runDir?: string;
  stageId: string;
  authority?: 'observer' | 'project-command';
  attemptIndex?: number;
}
interface BoundaryPolicy {
  input: EngineWriteBoundaryInput;
  scratch: string;
  scratchDirectories: string[];
  directories: string[];
  files: string[];
}
const pythonBridge = ['/usr/bin/python3', '/bin/python3'].find((path) => existsSync(path));
const activeBoundary = new AsyncLocalStorage<BoundaryPolicy>();
const commandDirectories = new WeakMap<object, string>();
const commandDirectoryKey = Symbol('engine command directory');

/** Only a trusted parent-created request can carry a private scratch grant.
 * Trusted request spreads preserve it; serialized argv and stage-supplied
 * fields cannot forge the parent-owned token. */
export function bindEngineCommandDirectory<T extends object>(request: T, directory: string): T {
  const token = {};
  commandDirectories.set(token, realpathSync(directory));
  return { ...request, [commandDirectoryKey]: token };
}
export function engineCommandDirectory(request: object): string | undefined {
  const token: unknown = Reflect.get(request, commandDirectoryKey);
  return token && typeof token === 'object' ? commandDirectories.get(token) : undefined;
}

/** Auxiliary callers bind authority from their runtime context, never command
 * text. Pre-admission commands have a private anchor; nested calls inherit the
 * admitted policy rather than replacing it with broader permissions. */
export async function withEngineCommandBoundary<T>(input: EngineCommandBoundaryInput, action: () => Promise<T>): Promise<T> {
  const parent = activeBoundary.getStore();
  if (parent) {
    // Observation is a restriction of the current authority. Keep its run,
    // receipt identity and scratch, but discard every publication capability.
    // Nested project commands cannot widen an observer back to a publisher.
    if (input.authority !== 'observer' || parent.input.authority === 'observer') return action();
    return activeBoundary.run({ ...parent, input: { ...parent.input, authority: 'observer' },
      directories: [parent.scratch], files: [] }, action);
  }
  const anchor = input.runDir ? undefined : mkdtempSync(join(tmpdir(), 'flowcrew-command-authority-'));
  try {
    return await withEngineWriteBoundary({ ...input, runDir: input.runDir ?? anchor!,
      authority: input.authority ?? 'project-command',
      artifactContract: { version: 1, produces: [], reads: [], groups: [], replays: [] } }, action);
  } finally { if (anchor) rmSync(anchor, { recursive: true, force: true }); }
}

/** Shared raw-command launch boundary. The parent authenticates the private
 * receipt and stops only its owned process group, including leftover children.
 * Callers must inspect boundaryError at close before accepting an exit code. */
export function spawnEngineChild(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): { child: ChildProcess; stop: () => void; boundaryError: () => string | undefined } {
  if (!activeBoundary.getStore()) throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: command launch requires runtime authority');
  const launch = confineEngineChild(command, args);
  const child = spawn(launch.command, launch.args, {
    ...options, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let installed = false, failure: string | undefined, waiting: string | undefined;
  observeEngineChildBoundary(child, launch.receiptPath, (receipt) => {
    if (receipt.kind === 'installed') { installed = true; waiting = undefined; }
    else if (receipt.kind === 'waiting') waiting = receipt.message;
    else failure = receipt.message;
  });
  const stop = (): void => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* owned group already closed */ }
  };
  child.once('close', stop);
  return { child, stop, boundaryError: () => failure ?? waiting ?? (installed ? undefined
    : 'ENGINE_WRITE_BOUNDARY_UNVERIFIED: launcher closed without enforcement receipt; child fate is unknown') };
}
export function engineChildAdapterHome(): string | undefined {
  const input = activeBoundary.getStore()?.input;
  return input && join(input.runDir, 'stages', input.stageId, 'codex_home');
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

/** Disposable IPC must not survive a killed parent inside a durable tree.
 * Resolve both roots physically; a lexical alias cannot change the purpose. */
function requireSeparateScratch(input: Pick<EngineWriteBoundaryInput, 'projectDir' | 'runDir'>, scratch: string): void {
  const temporary = realpathSync(scratch);
  if ([input.projectDir, input.runDir].map(root => realpathSync(root)).some(root => inside(root, temporary) || inside(temporary, root))) {
    throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: TMPDIR/temporary capability must be separate from durable project/run trees');
  }
}

/** Namespace ownership is evaluated anew before each actual subprocess launch.
 * Parents are entries, not recursive grants; only wholly owned trees recurse. */
function protectedCarriers(input: EngineWriteBoundaryInput): Array<{ path: string; tree: boolean }> {
  const stage = { id: input.stageId, is_gate: input.isGate };
  const run = realpathSync(input.runDir);
  const paths = [{ path: run, tree: false }, ...engineOwnedGlobalCarriers(fcGlobalDir()).map((path) => ({ path, tree: false }))];
  const pending = [run];
  while (pending.length) {
    const folder = pending.pop()!;
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), local = relative(run, path).split('\\').join('/');
      const info = lstatSync(path);
      const ownStageParent = local === 'stages' || local === `stages/${input.stageId}`;
      if (isEngineOwnedRunPath(local, stage) || (input.structuredResult && (local === 'dispatch.yaml' || local === `verdict_${input.stageId}.json` || local === `handoff_${input.stageId}.md`))) paths.push({ path, tree: info.isDirectory() && !ownStageParent });
      // Ownership is rooted in the run namespace. Only these namespace
      // parents can contain mixed engine/stage entries; arbitrary authored
      // output trees cannot contain a reserved descendant. Python still
      // checks every protected and writable inode at the kernel boundary.
      if (info.isDirectory() && ownStageParent) pending.push(path);
    }
  }
  const engineRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const path of [join(engineRoot, 'dist'), join(engineRoot, '.cache', 'build-generations')]) {
    if (existsSync(path)) paths.push({ path, tree: true });
  }
  return paths;
}

/** Wrap the launch at the last common adapter/replay boundary, including every
 * internal retry. No optional capability flag can disable an active policy. */
export function confineEngineChild(command: string, args: string[], newSession = false): { command: string; args: string[]; receiptPath?: string } {
  const policy = activeBoundary.getStore();
  if (!policy) return { command, args }; // trusted non-stage CLI helper
  if (process.platform !== 'linux') throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: Linux Landlock ABI >= 3 is required before stage execution');
  if (!pythonBridge) throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: a system Python 3 interpreter is required before execution');
  const protectedPaths = protectedCarriers(policy.input);
  for (const directory of policy.directories) {
    if (protectedPaths.some((entry) => entry.tree && inside(realpathSync(entry.path), realpathSync(directory)))) {
      throw new Error(`ENGINE_WRITE_BOUNDARY_REFUSED: directory capability contains protected carriers: ${directory}`);
    }
    if (protectedPaths.some((entry) => inside(realpathSync(directory), realpathSync(entry.path)))) {
      throw new Error(`ENGINE_WRITE_BOUNDARY_REFUSED: writable directory contains an engine carrier: ${directory}`);
    }
  }
  const config = { ...policy, input: undefined, protected: protectedPaths, newSession };
  return { command: pythonBridge, args: ['-I', '-S', '-B', '-c', LINUX_ENGINE_WRITE_BOUNDARY, JSON.stringify(config), command, ...args],
    receiptPath: join(policy.input.runDir, 'stages', policy.input.stageId, `write_boundary_attempt_${policy.input.attemptIndex ?? 0}.jsonl`) };
}

/** FD 3 is closed on successful exec. Receipt bytes come from the bridge before
 * stage code runs, not from adapter prose or a stage-controlled file. */
export function observeEngineChildBoundary(child: ChildProcess, receiptPath: string | undefined, observe: (receipt: EngineChildBoundaryReceipt) => void): void {
  if (!receiptPath) return;
  const pipe = child.stdio[3] as Readable | null;
  let pending = '', failed = false, installed = false;
  let waiting: string | undefined;
  const policy = activeBoundary.getStore();
  const environmentEvent = (type: 'stage_environment_wait_started' | 'stage_environment_wait_finished', detail: string): void => {
    if (!policy) return;
    const event: RunEvent = { type, runId: basename(policy.input.runDir), stageId: policy.input.stageId,
      attemptIndex: policy.input.attemptIndex, timestamp: new Date().toISOString(), detail, status: 'running' };
    appendTextRecord(join(policy.input.runDir, 'events.jsonl'), JSON.stringify(event));
  };
  const refuse = (error: unknown): void => {
    if (failed) return;
    failed = true;
    observe({ kind: 'refused', message: `ENGINE_WRITE_BOUNDARY_UNVERIFIED: ${String(error)}; child fate is unknown` });
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  pipe?.on('data', (bytes: Buffer) => {
    if (failed) return;
    pending += bytes.toString('utf8');
    if (pending.length > 65_536) { refuse('oversized launcher receipt'); return; }
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) {
      try {
        const receipt = parseEngineChildBoundaryReceipt(line, child.pid);
        if (receipt.kind === 'waiting') {
          if (installed) throw new Error('prerequisite wait after enforcement');
          if (waiting !== receipt.message) environmentEvent('stage_environment_wait_started', receipt.message);
          waiting = receipt.message;
        } else if (receipt.kind === 'installed') {
          installed = true;
          if (waiting) environmentEvent('stage_environment_wait_finished', 'Prerequisite cleared; renewed enforcement installed before execution');
          waiting = undefined;
        }
        mkdirSync(dirname(receiptPath), { recursive: true });
        appendTextRecord(receiptPath, JSON.stringify({ at: new Date().toISOString(), childPid: child.pid, ...receipt }));
        observe(receipt);
      } catch (error) { refuse(error); return; }
    }
  });
  pipe?.on('error', refuse);
  pipe?.on('end', () => { if (pending) refuse('incomplete launcher receipt'); });
}

/** Used by both asynchronous launchers and synchronous CLI capability probes. */
export function parseEngineChildBoundaryReceipt(line: string, childPid?: number): EngineChildBoundaryReceipt {
  const receipt: unknown = JSON.parse(line);
  if (!receipt || typeof receipt !== 'object' || !('kind' in receipt)) throw new Error('invalid launcher receipt');
  if (receipt.kind === 'installed' && 'abi' in receipt && typeof receipt.abi === 'number' && receipt.abi >= 3 &&
    'pid' in receipt && typeof receipt.pid === 'number' && receipt.pid === childPid &&
    'fileCapabilities' in receipt && Number.isInteger(receipt.fileCapabilities) &&
    'directoryCapabilities' in receipt && Number.isInteger(receipt.directoryCapabilities)) {
    if ('scopes' in receipt) {
      const expected = receipt.abi >= 6 ? 'enforced' : 'unavailable';
      const scopes = receipt.scopes;
      if (!scopes || typeof scopes !== 'object' ||
        !('signal' in scopes) || scopes.signal !== expected ||
        !('abstractUnixSocket' in scopes) || scopes.abstractUnixSocket !== expected) {
        throw new Error('invalid launcher scope receipt');
      }
    }
    return receipt as EngineChildBoundaryReceipt;
  }
  if (receipt.kind === 'waiting' && 'phase' in receipt && receipt.phase === 'pre_execution' &&
    'pid' in receipt && typeof receipt.pid === 'number' && receipt.pid === childPid &&
    'message' in receipt && typeof receipt.message === 'string') return receipt as EngineChildBoundaryReceipt;
  if (receipt.kind === 'refused' && 'message' in receipt && typeof receipt.message === 'string') return receipt as EngineChildBoundaryReceipt;
  if (receipt.kind === 'spawn_error' && 'message' in receipt && typeof receipt.message === 'string' &&
    'syscall' in receipt && typeof receipt.syscall === 'string' && 'path' in receipt && typeof receipt.path === 'string' &&
    'cwd' in receipt && typeof receipt.cwd === 'string') return receipt as EngineChildBoundaryReceipt;
  throw new Error('invalid launcher receipt identity or ABI');
}

/** A synchronous probe uses the same bridge and private FD as async execution.
 * Failure to establish/persist enforcement is fatal, even for a version probe. */
export function execEngineChildSync(command: string, args: string[], timeout: number): SpawnSyncReturns<string> {
  const launch = confineEngineChild(command, args, true);
  const policy = activeBoundary.getStore();
  const result = spawnSync(launch.command, launch.args, {
    cwd: policy?.input.projectDir, encoding: 'utf8', timeout,
    killSignal: 'SIGKILL',
    stdio: launch.receiptPath ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(engineChildAdapterHome() ? { CODEX_HOME: engineChildAdapterHome() } : {}) },
  });
  if (launch.receiptPath) {
    const bytes = result.output[3];
    const lines = typeof bytes === 'string' ? bytes.trim().split('\n') : [];
    let installed = false;
    try {
      if (!lines.length || lines.join('\n').length > 65_536) throw new Error('missing/oversized synchronous launcher receipt');
      for (const line of lines) {
        const receipt = parseEngineChildBoundaryReceipt(line, result.pid);
        mkdirSync(dirname(launch.receiptPath), { recursive: true });
        appendTextRecord(launch.receiptPath, JSON.stringify({ at: new Date().toISOString(), childPid: result.pid, ...receipt }));
        if (receipt.kind === 'refused') throw new Error(receipt.message);
        if (receipt.kind === 'installed') installed = true;
      }
      if (!installed) throw new Error('synchronous launcher closed without enforcement receipt');
      if (result.signal || (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT')) throw new Error('synchronous probe timed out or was signalled; child fate is unknown');
    } catch (error) {
      try { if (result.pid) process.kill(-result.pid, 'SIGKILL'); } catch { /* the owned group has already closed */ }
      throw new Error(`ENGINE_WRITE_BOUNDARY_UNVERIFIED: ${String(error)}; synchronous probe cannot establish child fate`, { cause: error });
    }
  }
  return result;
}

/** Machine reports live in a newly engine-created temporary directory. This is
 * a trusted parent capability, never supplied by a replay argv or stage prose. */
export function withEngineWriteBoundaryDirectory<T>(directory: string, action: () => T): T {
  const policy = activeBoundary.getStore();
  if (!policy) throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: replay launch has no stage authority');
  const scratch = realpathSync(directory);
  requireSeparateScratch(policy.input, scratch);
  return activeBoundary.run({ ...policy, directories: [...policy.directories, scratch],
    scratchDirectories: [...policy.scratchDirectories, scratch] }, action);
}

/** Positive native capabilities for the child's entire lifetime. Shared history
 * parents have no remove/create rights. Their declared regular files get pinned
 * write/truncate rights; atomic publication remains the engine's responsibility.
 * Empty untouched slots are removed before output freshness/group inspection. */
export async function withEngineWriteBoundary<T>(input: EngineWriteBoundaryInput, action: () => Promise<T>): Promise<T> {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  const observer = input.authority === 'observer';
  const publisher = input.authority === undefined || input.authority === 'stage';
  if (!publisher && (!/^_[a-z][a-z0-9_]*$/.test(input.stageId) || contract.produces.length || input.dynamicDispatch)) {
    throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: auxiliary authority cannot declare run outputs or dispatch');
  }
  let run: string, project: string;
  try { run = realpathSync(input.runDir); project = realpathSync(input.projectDir); }
  catch (error) { throw new Error(`ENGINE_WRITE_BOUNDARY_REFUSED: cannot establish physical project/run identity: ${String(error)}`, { cause: error }); }
  if (inside(project, run) || inside(run, project)) throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: project and engine run storage must be separate physical trees');
  const stage = { id: input.stageId, is_gate: input.isGate };
  const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-stage-write-'));
  const directories = !observer && (input.authority === 'project-command' || input.projectWriteScope?.length)
    ? [project, scratch] : [scratch], files: string[] = [];
  const createdDirectories: string[] = [];
  const makeDirectory = (path: string): void => {
    if (existsSync(path)) return;
    makeDirectory(dirname(path));
    mkdirSync(path);
    createdDirectories.push(path);
  };
  const created: Array<{ path: string; dev: number; ino: number; ctimeMs: number }> = [];
  const fileSlot = (path: string): void => {
    makeDirectory(dirname(path));
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      const info = lstatSync(path);
      created.push({ path, dev: info.dev, ino: info.ino, ctimeMs: info.ctimeMs });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`ENGINE_WRITE_BOUNDARY_REFUSED: output slot must be one regular, unaliased file: ${path}`);
    files.push(path);
  };
  try {
    requireSeparateScratch({ projectDir: project, runDir: run }, scratch);
    for (const name of ['tmp', 'cache', 'state', 'npm']) mkdirSync(join(scratch, name));
    for (const artifact of contract.produces) {
      if (artifact.root !== 'run') continue; // project scopes retain their live monitor
      if (input.structuredResult && (artifact.path === `verdict_${input.stageId}.json` || artifact.path === `handoff_${input.stageId}.md` || (input.dynamicDispatch && artifact.path === 'dispatch.yaml'))) continue;
      if (producesEngineOwnedArtifact(artifact, { id: input.stageId, depends_on: [], is_gate: input.isGate }, run, project) || (artifact.kind === 'directory' ? containsEngineOwnedRunPath : isEngineOwnedRunPath)(artifact.path, stage)) {
        throw new Error(`ENGINE_WRITE_BOUNDARY_REFUSED: ${artifact.id} declares an engine-owned carrier; declare a separate stage output`);
      }
      const path = resolveArtifactLocation(artifact, project, run);
      if (artifact.kind === 'directory') { makeDirectory(path); directories.push(path); }
      else fileSlot(path);
    }
    if (input.dynamicDispatch) {
      for (const name of ['dispatch.yaml', 'reality_checks.md', 'tech_solution.md']) if (name !== 'dispatch.yaml' || !input.structuredResult) fileSlot(join(run, name));
    }
    // Engine-owned transport slots, deliberately without parent rename rights.
    if (publisher) {
      for (const name of ['approval_request.json', 'scope_revision_request.json', 'plan_revision_request.json', 'timeout_extension_request.json']) {
        fileSlot(join(run, 'stages', input.stageId, name));
      }
      if (!input.structuredResult) fileSlot(join(run, `handoff_${input.stageId}.md`));
    }
    if (!/^_?[a-z][a-z0-9_]*$/.test(input.stageId)) throw new Error('ENGINE_WRITE_BOUNDARY_REFUSED: invalid adapter-home stage identity');
    const adapterHome = join(run, 'stages', input.stageId, 'codex_home');
    makeDirectory(adapterHome); directories.push(adapterHome);
    return await activeBoundary.run({ input, scratch, scratchDirectories: [scratch], directories, files }, action);
  } finally {
    for (const previous of created) {
      try {
        const current = lstatSync(previous.path);
        if (current.isFile() && current.dev === previous.dev && current.ino === previous.ino && current.size === 0 && current.ctimeMs === previous.ctimeMs) unlinkSync(previous.path);
      } catch { /* already removed/published by the engine */ }
    }
    for (const directory of createdDirectories.reverse()) {
      try { rmdirSync(directory); } catch { /* an authored or engine-published member remains */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
