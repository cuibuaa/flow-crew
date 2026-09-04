import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  STALE_DAEMON_MESSAGE,
  computeBuildFingerprint,
  createDaemonIdentity,
  findUnixSocketOwnerPid,
  readDaemonIdentity,
  writeDaemonIdentity,
  type DaemonIdentity,
} from './daemon-identity.js';
import { TaskRegistry, TASK_STATUS, type TaskEntry } from './task-registry.js';
import { Orchestrator } from './orchestrator.js';
import {
  DaemonUnavailableError,
  defaultSocketPath,
  rpcErrorExitCode,
  sendRpc as sendRpcRequest,
  startRpcServer,
  type DaemonStatusRpcResponse,
  type RpcHandlerError,
  type RpcRequest,
  type RpcResponse,
  type TaskShowEntry,
} from './orchestrator-rpc.js';
import type { CancellationResult } from './run-control.js';
import { runsRoot } from './store.js';
import { terminalArtifactStatusMismatch } from './terminal-artifact-status.js';
import { readOperationalProjection, type OperationalRunState } from './cli-events.js';

type RpcSender = (socketPath: string, request: RpcRequest, timeoutMs?: number) => Promise<RpcResponse>;

export interface DaemonProcessControls {
  sendRpc: RpcSender;
  findSocketOwnerPid: (socketPath: string) => number | undefined;
  spawnDaemon: (socketPath: string, logPath: string) => void;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  delay: (ms: number) => Promise<void>;
}

export interface DaemonCommandOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Runtime module directory; injectable so tests never inspect or rebuild the real dist/. */
  distDir?: string;
  controls?: Partial<DaemonProcessControls>;
}

export async function cmdDaemon(args: string[], opts: DaemonCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const sub = args[1];
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write(`${daemonUsage()}\n`);
    return 0;
  }
  const socketPath = resolve(
    valueAfter(args, '--port')
      ?? valueAfter(args, '--socket')
      ?? process.env.FLOWCREW_DAEMON_SOCKET
      ?? defaultSocketPath(),
  );
  const baseDir = dirname(socketPath);
  const logPath = join(baseDir, 'daemon.log');
  const distDir = resolve(opts.distDir ?? (import.meta.dirname ?? '.'));
  const controls: DaemonProcessControls = {
    sendRpc: (path, request, timeoutMs) => sendRpcRequest(path, request, timeoutMs),
    findSocketOwnerPid: findUnixSocketOwnerPid,
    spawnDaemon: spawnDetachedDaemon,
    killProcess: (pid, signal) => process.kill(pid, signal),
    delay,
    ...opts.controls,
  };

  try {
    if (sub === 'start') {
      if (await isRunning(socketPath, controls.sendRpc)) {
        stdout.write(`daemon already running at ${socketPath}; use "flowcrew daemon restart" to load a new build\n`);
        return 0;
      }
      const guardCode = checkRestartSafety(baseDir, args.includes('--force'), stderr, 'start');
      if (guardCode !== 0) return guardCode;
      mkdirSync(baseDir, { recursive: true });
      const status = await startDetachedAndWait(socketPath, logPath, controls);
      stdout.write(`daemon started at ${socketPath} (pid=${status.pid}, build=${status.build})\n`);
      return 0;
    }

    if (sub === 'serve') {
      await serve(socketPath, logPath, distDir);
      return 0;
    }

    if (sub === 'stop') {
      await controls.sendRpc(socketPath, { cmd: 'stop' });
      stdout.write('daemon stopped\n');
      return 0;
    }

    if (sub === 'restart') {
      const guardCode = checkRestartSafety(baseDir, args.includes('--force'), stderr, 'restart');
      if (guardCode !== 0) return guardCode;
      const previousPid = controls.findSocketOwnerPid(socketPath);
      if (previousPid === undefined) {
        throw new Error(`Cannot restart daemon: no process owns the listening Unix socket ${socketPath}`);
      }
      const status = await stopOwnedDaemonAndStart(socketPath, logPath, previousPid, controls);
      stdout.write(`daemon restarted (old pid=${previousPid}, new pid=${status.pid}, build=${status.build})\n`);
      return 0;
    }

    if (sub === 'status') {
      return await reportDaemonStatus(socketPath, distDir, stdout, controls);
    }

    if (sub === 'logs') {
      const tail = Number.parseInt(valueAfter(args, '--tail') ?? '100', 10);
      if (!existsSync(logPath)) return 0;
      const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);
      stdout.write(lines.slice(Math.max(0, lines.length - tail - 1)).join('\n'));
      if (args.includes('--follow')) {
        const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
        await new Promise((resolve) => child.on('exit', resolve));
        return child.exitCode ?? 0;
      }
      return 0;
    }

    stderr.write(`${daemonUsage()}\n`);
    return 1;
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return rpcErrorExitCode(err);
  }
}

export function daemonUsage(): string {
  return [
      'Usage: flowcrew daemon <command> [options]',
      '  restart [--force]  Reload the background orchestrator (operator entry point)',
      '  status             Prove listener pid, loaded build, and registry health',
      '  start [--force]    Compatibility: start only when no daemon is listening',
      '  stop               Stop the background orchestrator',
      '  serve              Run the orchestrator in the foreground (internal/service entry)',
      '  logs [--tail N]    Read daemon.log',
    ].join('\n');
}

export function createDaemonRpcErrorLogger(
  logPath: string,
  now: () => Date = () => new Date(),
): (failure: RpcHandlerError) => void {
  return ({ request, error }) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const stack = error.stack ?? `${error.name}: ${error.message}`;
    appendFileSync(logPath, `${now().toISOString()} ERROR cmd=${request.cmd}\n${stack}\n`, 'utf-8');
  };
}

export async function handleDaemonCancellationRequest(
  orchestrator: Pick<Orchestrator, 'cancel' | 'cancelRun'>,
  request: RpcRequest,
): Promise<CancellationResult | undefined> {
  if (request.cmd === 'cancel') {
    const result = await orchestrator.cancel(request.id);
    if (!result.ok) {
      if (result.status === 'outcome-unknown') {
        throw new Error(`Cancellation outcome unknown; processes may still be running: ${result.message}`);
      }
      throw new Error(`Cancellation still in progress: ${result.message}. Check progress with: flowcrew task show ${request.id}`);
    }
    return result;
  }
  if (request.cmd === 'cancel-run') return orchestrator.cancelRun(request.runId, request.unit);
  return undefined;
}

/**
 * Build a read-only task view. A bound run is the authority for lifecycle
 * outcome fields, while the registry continues to own launch metadata.
 */
export function mergeTaskWithRunState(
  task: TaskEntry,
  runRoot = runsRoot(),
): TaskShowEntry {
  if (!task.run_id) return { ...task };
  const runPath = isAbsolute(task.run_id) ? task.run_id : join(runRoot, task.run_id);
  try {
    const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as OperationalRunState & {
      status?: unknown;
      completedAt?: unknown;
      failureReason?: unknown;
      verdict?: unknown;
      realityGate?: unknown;
      terminalArtifact?: unknown;
      terminalStates?: unknown;
    };
    if (typeof state.status !== 'string' || !state.status) return { ...task };
    const verdict = runVerdict(state.verdict, state.realityGate);
    const mismatch = terminalArtifactStatusMismatch(state, { runDir: runPath });
    return {
      ...task,
      status: state.status,
      operational: readOperationalProjection(runPath, { state }),
      // A terminal registry timestamp may record a later control-plane action
      // (for example an already-terminal cancellation). Preserve it when
      // present; otherwise project the run's authoritative completion time.
      completed_at: task.completed_at
        ?? (typeof state.completedAt === 'string' ? state.completedAt : undefined),
      ...(verdict ? { run_verdict: verdict } : {}),
      ...(typeof state.failureReason === 'string' && state.failureReason
        ? { failure_reason: state.failureReason }
        : {}),
      ...(mismatch ? {
        terminal_status_mismatch: {
          lifecycle_status: mismatch.lifecycleStatus,
          terminal_status: mismatch.terminalStatus,
          terminal_artifact: mismatch.terminalArtifact,
        },
      } : {}),
    };
  } catch {
    return { ...task };
  }
}

function runVerdict(verdict: unknown, realityGate: unknown): string | undefined {
  if (typeof verdict === 'string' && verdict.trim()) return verdict.trim();
  if (typeof verdict === 'object' && verdict !== null) {
    const nested = (verdict as { verdict?: unknown }).verdict;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  if (typeof realityGate === 'object' && realityGate !== null) {
    const pass = (realityGate as { pass?: unknown }).pass;
    if (pass === true) return 'PASS';
    if (pass === false) return 'FAIL';
  }
  return undefined;
}

async function serve(socketPath: string, logPath: string, distDir: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const identity = createDaemonIdentity({ socketPath, distDir });
  const warn = (message: string) => {
    appendFileSync(logPath, `${new Date().toISOString()} WARN ${message}\n`, 'utf-8');
  };
  const registry = new TaskRegistry({ baseDir: dirname(socketPath), warn });
  const orchestrator = new Orchestrator({ registry });
  const handler = async (req: RpcRequest): Promise<RpcResponse> => {
    appendFileSync(logPath, `${new Date().toISOString()} ${req.cmd}\n`, 'utf-8');
    if (req.cmd === 'register') {
      const task = await orchestrator.register(req.task);
      return { id: task.id, unit: task.systemd_unit, pid: identity.pid, build: identity.build.hash };
    }
    if (req.cmd === 'list') {
      return {
        tasks: registry.list(req.filter).map((task) => mergeTaskWithRunState(task)),
        registry_unreadable_records: registry.health().unreadableRecords,
      };
    }
    if (req.cmd === 'show') {
      const task = registry.get(req.id);
      if (!task) throw new Error(`Task not found: ${req.id}`);
      const unitStatus = await orchestrator.unitStatus(req.id);
      return {
        task: mergeTaskWithRunState(task),
        // New clients state whether raw evidence was requested. Keep absent
        // compatible with older clients, but avoid reading/transferring it for
        // the concise default path.
        recent_ticks: req.raw === false ? [] : registry.readRecentTicks(req.id),
        unit_status: unitStatus,
        ...(unitStatus.kind === 'terminal' ? { exit_code: unitStatus.exitCode } : {}),
      };
    }
    const cancellation = await handleDaemonCancellationRequest(orchestrator, req);
    if (cancellation) return cancellation;
    if (req.cmd === 'retry') {
      const task = await orchestrator.retry(req.id);
      return { new_attempt: task.attempt, unit: task.systemd_unit };
    }
    if (req.cmd === 'tail') {
      if (req.follow) return orchestrator.tailSnapshot(req.id, req.lines);
      return { output: await orchestrator.tail(req.id, req.lines) };
    }
    if (req.cmd === 'status') return { ...orchestrator.status(), ...rpcIdentity(identity) };
    if (req.cmd === 'stop') {
      orchestrator.stop();
      setTimeout(() => {
        server.close(() => {
          rmSync(socketPath, { force: true });
          process.exit(0);
        });
      }, 10);
      return { ok: true };
    }
    return { error: 'unknown command' };
  };

  const server = await startRpcServer(socketPath, handler, {
    onHandlerError: createDaemonRpcErrorLogger(logPath),
  });
  writeDaemonIdentity(socketPath, identity);
  orchestrator.start();
  appendFileSync(
    logPath,
    `${new Date().toISOString()} daemon started ${socketPath} pid=${identity.pid} build=${identity.build.hash}\n`,
    'utf-8',
  );
}

function rpcIdentity(identity: DaemonIdentity): Pick<
  DaemonStatusRpcResponse,
  'pid' | 'startedAt' | 'socketPath' | 'build' | 'buildFiles' | 'buildNewestMtimeMs'
> {
  return {
    pid: identity.pid,
    startedAt: identity.startedAt,
    socketPath: identity.socketPath,
    build: identity.build.hash,
    buildFiles: identity.build.files,
    buildNewestMtimeMs: identity.build.newestMtimeMs,
  };
}

function checkRestartSafety(
  baseDir: string,
  force: boolean,
  stderr: NodeJS.WriteStream,
  action: 'start' | 'restart',
): number {
  const snapshot = new TaskRegistry({ baseDir }).snapshot();
  if (snapshot.unreadableRecords > 0) {
    stderr.write(
      `REFUSED: task registry has ${snapshot.unreadableRecords} unreadable records; cannot prove daemon ${action} is safe. `
      + '--force does not bypass registry corruption.\n',
    );
    stderr.write('Inspect the proposed recovery first: flowcrew doctor --repair-registry\n');
    stderr.write('After reviewing it, apply with: flowcrew doctor --repair-registry --apply\n');
    return 3;
  }
  const unsafe = snapshot.tasks.filter((task) => task.status === TASK_STATUS.RUNNING && !task.run_id);
  if (unsafe.length === 0 || force) return 0;

  stderr.write(
    `REFUSED: daemon ${action} would risk replaying ${unsafe.length} running task(s) with no bound run_id: `
    + `${unsafe.map((task) => `#${task.id}`).join(', ')}.\n`,
  );
  stderr.write('After a new daemon takes over, an exiting unit without a run binding can be mistaken for an early crash and replay its brief.\n');
  for (const task of unsafe) stderr.write(`  resolve first: flowcrew task cancel ${task.id}\n`);
  stderr.write(`If you explicitly accept that replay risk, rerun: flowcrew daemon ${action} --force\n`);
  return 3;
}

async function reportDaemonStatus(
  socketPath: string,
  distDir: string,
  stdout: NodeJS.WriteStream,
  controls: DaemonProcessControls,
): Promise<number> {
  let response: RpcResponse;
  try {
    response = await controls.sendRpc(socketPath, { cmd: 'status' });
  } catch (error) {
    return reportStatusRpcFailure(socketPath, distDir, stdout, controls, error);
  }

  const status = asDaemonStatus(response);
  stdout.write(status
    ? 'RESPONSIVE: daemon returned a complete status identity.\n'
    : 'RESPONSIVE BUT UNVERIFIED: listener returned an incomplete status identity.\n');
  stdout.write(`pid: ${status?.pid ?? 'UNVERIFIED'}\n`);
  stdout.write(`startedAt: ${status?.startedAt ?? 'UNVERIFIED'}\n`);
  stdout.write(`socketPath: ${status?.socketPath ?? socketPath}\n`);
  stdout.write(`build: ${status?.build ?? 'UNVERIFIED'}\n`);
  if (status) {
    stdout.write(`build_files: ${status.buildFiles}\n`);
    stdout.write(`build_newest_mtime_ms: ${status.buildNewestMtimeMs}\n`);
  }
  const uptime = readNumber(response, 'uptime');
  const watched = readNumber(response, 'watched_tasks');
  const unreadable = readNumber(response, 'registry_unreadable_records');
  stdout.write(`uptime: ${uptime ?? 'UNVERIFIED'}s\n`);
  stdout.write(`watched_tasks: ${watched ?? 'UNVERIFIED'}\n`);
  stdout.write(`registry_unreadable_records: ${unreadable ?? 'UNVERIFIED'}\n`);
  const cachedScale = registryScaleFromRpc(response);
  if (cachedScale) reportRegistryScaleValues(cachedScale, stdout);
  else reportRegistryScale(dirname(socketPath), stdout); // legacy daemon compatibility
  if ((unreadable ?? 0) > 0) {
    stdout.write(`WARNING: registry has ${unreadable} unreadable records; task state may be incomplete.\n`);
  }

  if (!status) {
    stdout.write('UNVERIFIED: the listener did not return its startup pid/build identity; fixes cannot be proven loaded.\n');
    return 2;
  }

  let ownerPid: number | undefined;
  try {
    ownerPid = controls.findSocketOwnerPid(socketPath);
  } catch (error) {
    stdout.write(`UNVERIFIED: cannot determine Unix socket owner (${error instanceof Error ? error.message : String(error)}).\n`);
    return 2;
  }
  if (ownerPid !== status.pid) {
    stdout.write(`UNVERIFIED: socket owner pid=${ownerPid ?? 'none'} does not match RPC pid=${status.pid}.\n`);
    return 2;
  }

  let persisted: DaemonIdentity | undefined;
  try {
    persisted = readDaemonIdentity(socketPath);
  } catch (error) {
    stdout.write(`UNVERIFIED: ${error instanceof Error ? error.message : String(error)}.\n`);
    return 2;
  }
  if (!persisted || !identityMatchesStatus(persisted, status, socketPath)) {
    stdout.write('UNVERIFIED: daemon.json is missing or does not match the process listening on this socket.\n');
    return 2;
  }

  let diskBuild;
  try {
    diskBuild = computeBuildFingerprint(distDir);
  } catch (error) {
    stdout.write(`UNVERIFIED: cannot fingerprint disk dist (${error instanceof Error ? error.message : String(error)}).\n`);
    return 2;
  }
  if (diskBuild.hash !== status.build) {
    stdout.write(`${STALE_DAEMON_MESSAGE}\n`);
    return 2;
  }
  stdout.write('FRESH: disk dist matches the build loaded by the running daemon.\n');
  return 0;
}

function reportStatusRpcFailure(
  socketPath: string,
  distDir: string,
  stdout: NodeJS.WriteStream,
  controls: DaemonProcessControls,
  error: unknown,
): number {
  let ownerPid: number | undefined;
  try {
    ownerPid = controls.findSocketOwnerPid(socketPath);
  } catch (ownerError) {
    stdout.write(`UNVERIFIED: status RPC failed (${statusRpcFailureSummary(error)}).\n`);
    stdout.write(`UNVERIFIED: cannot determine Unix socket owner (${errorMessage(ownerError)}).\n`);
    reportRegistryScale(dirname(socketPath), stdout);
    return 2;
  }

  if (ownerPid === undefined) {
    stdout.write(`NO LISTENER: no process owns the Unix socket ${socketPath}.\n`);
    reportRegistryScale(dirname(socketPath), stdout);
    return 1;
  }

  stdout.write('NONRESPONSIVE: a process owns the Unix socket but did not answer the status RPC.\n');
  stdout.write(`owner_pid: ${ownerPid}\n`);
  stdout.write(`socketPath: ${socketPath}\n`);
  stdout.write(`rpc_error: ${statusRpcFailureSummary(error)}\n`);

  let persisted: DaemonIdentity | undefined;
  let persistedError: unknown;
  try {
    persisted = readDaemonIdentity(socketPath);
  } catch (identityError) {
    persistedError = identityError;
  }

  stdout.write(`recorded_pid: ${persisted?.pid ?? 'UNVERIFIED'}\n`);
  stdout.write(`recorded_startedAt: ${persisted?.startedAt ?? 'UNVERIFIED'}\n`);
  stdout.write(`recorded_build: ${persisted?.build.hash ?? 'UNVERIFIED'}\n`);
  if (persistedError) {
    stdout.write(`UNVERIFIED: cannot read daemon.json (${errorMessage(persistedError)}).\n`);
  } else if (!persisted) {
    stdout.write('UNVERIFIED: daemon.json is missing.\n');
  } else if (persisted.pid !== ownerPid || persisted.socketPath !== resolve(socketPath)) {
    stdout.write('UNVERIFIED: daemon.json does not identify the process listening on this socket.\n');
  }

  let diskBuild: ReturnType<typeof computeBuildFingerprint> | undefined;
  try {
    diskBuild = computeBuildFingerprint(distDir);
    stdout.write(`disk_build: ${diskBuild.hash}\n`);
  } catch (fingerprintError) {
    stdout.write('disk_build: UNVERIFIED\n');
    stdout.write(`UNVERIFIED: cannot fingerprint disk dist (${errorMessage(fingerprintError)}).\n`);
  }

  reportRegistryScale(dirname(socketPath), stdout);
  if (persisted && diskBuild && persisted.build.hash !== diskBuild.hash) {
    stdout.write(`${STALE_DAEMON_MESSAGE}\n`);
  } else if (persisted && diskBuild) {
    stdout.write('UNVERIFIED: recorded and disk builds match, but the listener did not prove which build it loaded.\n');
  }
  return 2;
}

interface RegistryScale {
  bytes: number;
  records: number;
  tasks: number;
}

function registryScaleFromRpc(response: RpcResponse): RegistryScale | undefined {
  const bytes = readNumber(response, 'registry_bytes');
  const records = readNumber(response, 'registry_records');
  const tasks = readNumber(response, 'registry_tasks');
  return bytes !== undefined && bytes >= 0
    && records !== undefined && Number.isInteger(records) && records >= 0
    && tasks !== undefined && Number.isInteger(tasks) && tasks >= 0
    ? { bytes, records, tasks }
    : undefined;
}

function reportRegistryScaleValues(scale: RegistryScale, stdout: NodeJS.WriteStream): void {
  stdout.write(`registry_bytes: ${scale.bytes}\n`);
  stdout.write(`registry_records: ${scale.records}\n`);
  stdout.write(`registry_tasks: ${scale.tasks}\n`);
}

function reportRegistryScale(baseDir: string, stdout: NodeJS.WriteStream): void {
  try {
    reportRegistryScaleValues(readRegistryScale(baseDir), stdout);
  } catch (error) {
    stdout.write('registry_bytes: UNVERIFIED\n');
    stdout.write('registry_records: UNVERIFIED\n');
    stdout.write('registry_tasks: UNVERIFIED\n');
    stdout.write(`UNVERIFIED: cannot inspect local task registry (${errorMessage(error)}).\n`);
  }
}

function readRegistryScale(baseDir: string): RegistryScale {
  const path = join(baseDir, 'tasks.jsonl');
  if (!existsSync(path)) return { bytes: 0, records: 0, tasks: 0 };

  const raw = readFileSync(path);
  const taskIds = new Set<number>();
  let records = 0;
  for (const line of raw.toString('utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records += 1;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'number') {
        taskIds.add((parsed as { id: number }).id);
      }
    } catch {
      // Physical records include corrupt lines; task count mirrors readLatest()
      // by folding only readable rows with numeric ids.
    }
  }
  return { bytes: raw.byteLength, records, tasks: taskIds.size };
}

function statusRpcFailureSummary(error: unknown): string {
  const message = errorMessage(error);
  const deliverySuffix = ' The command may already have been delivered and taken effect.';
  const concise = message.includes(deliverySuffix) ? message.slice(0, message.indexOf(deliverySuffix)) : message;
  return concise
    .replace(/flowcrew daemon status/gi, 'this status probe')
    .replace(/\s+/g, ' ')
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stopOwnedDaemonAndStart(
  socketPath: string,
  logPath: string,
  previousPid: number,
  controls: DaemonProcessControls,
): Promise<DaemonStatusRpcResponse> {
  try {
    await controls.sendRpc(socketPath, { cmd: 'stop' });
  } catch {
    // A response can be lost after delivery. Socket ownership below is the
    // authoritative stop result; no cmdline inference is involved.
  }

  let released = await waitForOwnerRelease(socketPath, previousPid, controls, 40);
  if (!released) {
    const currentOwner = controls.findSocketOwnerPid(socketPath);
    if (currentOwner !== previousPid) {
      throw new Error(
        `Refusing to signal daemon: socket ownership changed from pid=${previousPid} to pid=${currentOwner ?? 'none'}`,
      );
    }
    controls.killProcess(previousPid, 'SIGTERM');
    released = await waitForOwnerRelease(socketPath, previousPid, controls, 20);
  }
  if (!released) {
    throw new Error(`Daemon pid=${previousPid}, identified from ${socketPath}, did not release its socket after stop and SIGTERM`);
  }
  return startDetachedAndWait(socketPath, logPath, controls);
}

async function waitForOwnerRelease(
  socketPath: string,
  expectedPid: number,
  controls: DaemonProcessControls,
  attempts: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const owner = controls.findSocketOwnerPid(socketPath);
    if (owner === undefined) return true;
    if (owner !== expectedPid) {
      throw new Error(`Socket ${socketPath} changed ownership from pid=${expectedPid} to pid=${owner}; refusing restart`);
    }
    await controls.delay(100);
  }
  return false;
}

async function startDetachedAndWait(
  socketPath: string,
  logPath: string,
  controls: DaemonProcessControls,
): Promise<DaemonStatusRpcResponse> {
  controls.spawnDaemon(socketPath, logPath);
  for (let i = 0; i < 40; i++) {
    try {
      const response = await controls.sendRpc(socketPath, { cmd: 'status' }, 300);
      const status = asDaemonStatus(response);
      const owner = controls.findSocketOwnerPid(socketPath);
      if (status && owner === status.pid && resolve(status.socketPath) === socketPath) return status;
    } catch {
      // The child may not have bound its socket yet.
    }
    await controls.delay(100);
  }
  throw new Error(`daemon did not become ready with a verifiable identity; see ${logPath}`);
}

async function isRunning(socketPath: string, rpc: RpcSender): Promise<boolean> {
  try {
    await rpc(socketPath, { cmd: 'status' }, 300);
    return true;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return false;
    throw error;
  }
}

function spawnDetachedDaemon(socketPath: string, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const cliPath = resolve(import.meta.dirname ?? '.', 'cli.js');
  const out = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [cliPath, 'daemon', 'serve', '--socket', socketPath], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, FLOWCREW_DAEMON_SOCKET: socketPath },
    });
    child.once('error', (error) => {
      appendFileSync(logPath, `${new Date().toISOString()} daemon spawn failed: ${error.stack ?? error.message}\n`, 'utf-8');
    });
    child.unref();
  } finally {
    closeSync(out);
  }
}

function asDaemonStatus(response: RpcResponse): DaemonStatusRpcResponse | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = response as Partial<DaemonStatusRpcResponse>;
  return Number.isInteger(value.pid) && (value.pid ?? 0) > 0
    && typeof value.startedAt === 'string'
    && typeof value.socketPath === 'string'
    && typeof value.build === 'string' && /^[a-f0-9]{64}$/.test(value.build)
    && Number.isInteger(value.buildFiles) && (value.buildFiles ?? -1) >= 0
    && typeof value.buildNewestMtimeMs === 'number'
    && typeof value.uptime === 'number'
    && typeof value.watched_tasks === 'number'
    && typeof value.registry_unreadable_records === 'number'
    ? value as DaemonStatusRpcResponse
    : undefined;
}

function identityMatchesStatus(identity: DaemonIdentity, status: DaemonStatusRpcResponse, socketPath: string): boolean {
  return identity.pid === status.pid
    && identity.startedAt === status.startedAt
    && identity.socketPath === resolve(socketPath)
    && status.socketPath === resolve(socketPath)
    && identity.build.hash === status.build
    && identity.build.files === status.buildFiles
    && identity.build.newestMtimeMs === status.buildNewestMtimeMs;
}

function readNumber(value: RpcResponse, key: string): number | undefined {
  const candidate = (value as unknown as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
