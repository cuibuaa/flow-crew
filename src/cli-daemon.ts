import { parseCommandArgs, commandUsage } from './cli-args.js';
import { sweepRunScratch } from './invocation-scratch.js';
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  STALE_DAEMON_MESSAGE,
  computeBuildFingerprint,
  createDaemonIdentity,
  findUnixSocketOwnerPid,
  readDaemonIdentity,
  writeDaemonIdentity,
  type DaemonIdentity,
} from './daemon-identity.js';
import { TaskRegistry, TASK_LIST_STATUS, TASK_STATUS, isActiveTaskStatus, type TaskEntry } from './task-registry.js';
import { Orchestrator, type DeploymentStatus } from './orchestrator.js';
import { createDaemonReconciler } from './daemon-reconciliation.js';
import {
  DaemonUnavailableError,
  RpcOutcomeUnknownError,
  commandSocketPath,
  rpcErrorExitCode,
  sendRpc as sendRpcRequest,
  startRpcServer,
  type DaemonStatusRpcResponse,
  type RpcHandlerError,
  type RegisterRpcResponse,
  type RpcRequest,
  type RpcResponse,
  type TaskShowEntry,
  type TaskListRpcResponse,
} from './orchestrator-rpc.js';
import type { CancellationResult } from './run-control.js';
import { runsRoot } from './store.js';
import { terminalArtifactStatusMismatch } from './terminal-artifact-status.js';
import { readOperationalProjection, type OperationalRunState } from './cli-events.js';
import { inspectRunScheduler } from './run-lock.js';
import { fcGlobalDir } from './store.js';
import { readDeploymentHold } from './deployment-hold.js';
import { readRunIndexRecords } from './run-index.js';
import { assertDistFresh, buildProjectRoot, pinBuildRuntime } from './build-manifest.js';
import { processIsAlive } from './process-liveness.js';
import { resolveRunStatus, taskDisplayStatus } from './lifecycle-status.js';

type RpcSender = (socketPath: string, request: RpcRequest, timeoutMs?: number) => Promise<RpcResponse>;

export interface DaemonProcessControls {
  sendRpc: RpcSender;
  findSocketOwnerPid: (socketPath: string) => number | undefined;
  spawnDaemon: (socketPath: string, logPath: string) => { pid?: number; exited: Promise<string> };
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  delay: (ms: number) => Promise<void>;
  processAlive: (pid: number) => boolean;
  build: (projectRoot: string) => Promise<void>;
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
  const sub = args[1]?.startsWith('-') ? undefined : args[1];
  try {
    const parsed = parseCommandArgs(`daemon${sub ? ` ${sub}` : ''}`, args);
    if (parsed.help) {
      stdout.write(`${commandUsage(`daemon${sub ? ` ${sub}` : ''}`)}\n`);
      return 0;
    }
    const socketPath = resolve(commandSocketPath(parsed.values.get('--socket')));
    const baseDir = dirname(socketPath);
    const logPath = join(baseDir, 'daemon.log');
    const distDir = resolve(opts.distDir ?? (sub === 'serve'
      ? import.meta.dirname ?? '.'
      : join(buildProjectRoot(import.meta.dirname ?? '.'), 'dist')));
    if (sub === 'serve' && !opts.distDir && buildProjectRoot(distDir) === dirname(distDir)) {
      const runtime = pinBuildRuntime(distDir, join(baseDir, 'runtime'));
      const pinned = await import(pathToFileURL(join(runtime, 'cli-daemon.js')).href);
      return pinned.cmdDaemon(args, { ...opts, distDir: runtime });
    }
    const controls: DaemonProcessControls = {
      sendRpc: (path, request, timeoutMs) => sendRpcRequest(path, request, timeoutMs),
      findSocketOwnerPid: findUnixSocketOwnerPid,
      spawnDaemon: (path, log) => spawnDetachedDaemon(path, log, distDir),
      killProcess: (pid, signal) => process.kill(pid, signal),
      delay,
      processAlive: processIsAlive,
      build: (root) => buildDeployment(root, stdout, stderr),
      ...opts.controls,
    };

    if (sub === 'deploy') {
      return await deployDaemon(parsed, socketPath, logPath, distDir, stdout, stderr, controls);
    }

    if (sub === 'hold' || sub === 'hold-status' || sub === 'continue') {
      const timeoutMs = Number(parsed.values.get('--timeout-ms') ?? '60000');
      const result = sub === 'hold' ? await holdAndWait(socketPath, timeoutMs, controls)
        : deploymentStatus(await controls.sendRpc(socketPath, { cmd: sub }));
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (sub === 'hold' && !result.ready) stderr.write('HOLD NOT SETTLED: timeout/refusal; hold remains active. Do not deploy. No running attempt was killed.\n');
      return sub === 'continue' ? (result.released && !result.errors.length ? 0 : 1) : result.ready ? 0 : 1;
    }

    if (sub === 'start') {
      if (await isRunning(socketPath, controls)) {
        stdout.write(`daemon already running at ${socketPath}; use "flowcrew daemon restart" to load a new build\n`);
        return 0;
      }
      const guardCode = checkRestartSafety(baseDir, parsed.flags.has('--force'), stderr, 'start');
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
      const guardCode = checkRestartSafety(baseDir, parsed.flags.has('--force'), stderr, 'restart');
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
      const tail = Number.parseInt(parsed.values.get('--tail') ?? '100', 10);
      if (!existsSync(logPath)) return 0;
      const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);
      stdout.write(lines.slice(Math.max(0, lines.length - tail - 1)).join('\n'));
      if (parsed.flags.has('--follow')) {
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
  return commandUsage('daemon');
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
  if (request.cmd === 'cancel') return 'id' in request
    ? orchestrator.cancel(request.id)
    : orchestrator.cancelRun(request.runId, request.unit);
  return undefined;
}

/**
 * Build a read-only task view. A bound run is the authority for lifecycle
 * outcome fields, while the registry continues to own launch metadata.
 */
export function mergeTaskWithRunState(
  task: TaskEntry,
  runRoot = runsRoot(),
  options: { includeDrift?: boolean } = {},
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
      engineHistory?: import('./store.js').StoreState['engineHistory'];
      continuationFailure?: import('./store.js').StoreState['continuationFailure'];
    };
    if (typeof state.status !== 'string' || !state.status) return { ...task };
    const verdict = runVerdict(state.verdict, state.realityGate);
    const mismatch = terminalArtifactStatusMismatch(state, { runDir: runPath });
    const scheduler = inspectRunScheduler(String(state.runId ?? task.run_id), runPath);
    return {
      ...task,
      run: {
        status: canonicalRunStatus(state.status),
        ...(typeof state.failureReason === 'string' ? { failureReason: state.failureReason } : {}),
        ...(typeof state.completedAt === 'string' ? { completedAt: state.completedAt } : {}),
      },
      engine_history: state.engineHistory,
      continuation_failure: state.continuationFailure,
      ...(scheduler.kind === 'live' ? { scheduler_live: { pid: scheduler.pid } } : {}),
      operational: readOperationalProjection(runPath, { state, includeDrift: options.includeDrift }),
      ...(verdict ? { run_verdict: verdict } : {}),
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

function canonicalRunStatus(status: string): string {
  const resolution = resolveRunStatus(status);
  return resolution.kind === 'known' ? resolution.status : status;
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

/** Explicit persisted requests acknowledge durable admission before launch work. */
export async function handleDaemonRegistrationRequest(
  orchestrator: Orchestrator,
  request: Extract<RpcRequest, { cmd: 'register' }>,
  identity: Pick<DaemonIdentity, 'pid' | 'build'>,
): Promise<RegisterRpcResponse> {
  const persisted = request.acknowledgement === 'persisted';
  const task = persisted ? orchestrator.enqueue(request.task) : await orchestrator.register(request.task);
  return { id: task.id, unit: task.systemd_unit, new_attempt: task.attempt, pid: identity.pid, build: identity.build.hash,
    ...(persisted ? { acknowledgement: 'persisted' as const } : {}) };
}

/** List keeps launch metadata in the registry and reads lifecycle status from the index. */
export function handleDaemonListRequest(
  registry: TaskRegistry,
  request: Extract<RpcRequest, { cmd: 'list' }>,
): TaskListRpcResponse {
  const runs = new Map((readRunIndexRecords(fcGlobalDir()) ?? []).map(run => [run.runId, run]));
  const filter = request.filter;
  let tasks: TaskShowEntry[] = registry.list({ status: TASK_LIST_STATUS.ALL }).map(task => {
    const run = task.run_id ? runs.get(basename(task.run_id)) : undefined;
    return run?.status ? { ...task, run: { status: canonicalRunStatus(run.status), completedAt: run.completedAt } } : { ...task };
  });
  if (filter?.status && filter.status !== TASK_LIST_STATUS.ALL) {
    tasks = tasks.filter(task => filter.status === TASK_LIST_STATUS.ACTIVE
      ? isActiveTaskStatus(taskDisplayStatus(task.status, task.run?.status))
      : taskDisplayStatus(task.status, task.run?.status) === filter.status);
  }
  if (filter?.limit && filter.limit > 0) tasks = tasks.slice(-filter.limit);
  return { tasks, registry_unreadable_records: registry.health().unreadableRecords };
}

async function serve(socketPath: string, logPath: string, distDir: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  let identity: DaemonIdentity;
  let registry: TaskRegistry;
  let orchestrator: Orchestrator;
  const handler = async (req: RpcRequest): Promise<RpcResponse> => {
    appendFileSync(logPath, `${new Date().toISOString()} ${req.cmd}\n`, 'utf-8');
    if (req.cmd === 'register') {
      return handleDaemonRegistrationRequest(orchestrator, req, identity);
    }
    if (req.cmd === 'hold') return orchestrator.holdDeployment();
    if (req.cmd === 'hold-status') return orchestrator.deploymentStatus();
    if (req.cmd === 'continue') return orchestrator.continueDeployment();
    if (req.cmd === 'list') return handleDaemonListRequest(registry, req);
    if (req.cmd === 'show') {
      const task = registry.get(req.id);
      if (!task) throw Object.assign(new Error(`Task not found: ${req.id}`), { code: 'TASK_NOT_FOUND' });
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
    if (req.cmd === 'retry' || req.cmd === 'resume') {
      const task = await orchestrator[req.cmd](req.id);
      return { new_attempt: task.attempt, unit: task.systemd_unit };
    }
    if (req.cmd === 'tail') {
      if (req.follow) return orchestrator.tailSnapshot(req.id, req.lines);
      return { output: await orchestrator.tail(req.id, req.lines) };
    }
    if (req.cmd === 'status') return { ...orchestrator.status(), ...rpcIdentity(identity) };
    if (req.cmd === 'stop') {
      await orchestrator.stop();
      setTimeout(() => {
        server.close(() => {
          rmSync(socketPath, { force: true });
          process.exit(0);
        });
      }, 10);
      return { ok: true };
    }
    throw Object.assign(new Error('unknown command'), { code: 'RPC_UNKNOWN_COMMAND' });
  };

  const server = await startRpcServer(socketPath, handler, {
    onHandlerError: createDaemonRpcErrorLogger(logPath),
    onResponse: (req, response) => {
      if ((req.cmd === 'register' && 'acknowledgement' in response) || req.cmd === 'hold' || req.cmd === 'continue') {
        setImmediate(() => orchestrator.requestTick());
      }
    },
  });
  try {
    identity = createDaemonIdentity({ socketPath, distDir });
    const warn = (message: string) => {
      appendFileSync(logPath, `${new Date().toISOString()} WARN ${message}\n`, 'utf-8');
    };
    registry = new TaskRegistry({ baseDir: dirname(socketPath), warn });
    orchestrator = new Orchestrator({
      registry,
      reconcileOrphanRuns: createDaemonReconciler(registry, warn),
    });
    writeDaemonIdentity(socketPath, identity);
    // Only unlink aliases of deleted owners here. Recursive scratch retirement
    // and retention planning belong to explicit cleanup and run lifecycle boundaries.
    sweepRunScratch(runsRoot(), warn);
    orchestrator.start();
    appendFileSync(
      logPath,
      `${new Date().toISOString()} daemon started ${socketPath} pid=${identity.pid} build=${identity.build.hash}\n`,
      'utf-8',
    );
  } catch (error) {
    server.close();
    rmSync(socketPath, { force: true });
    throw error;
  }
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

function deploymentStatus(response: RpcResponse): DeploymentStatus {
  const result = response as DeploymentStatus;
  if (!Array.isArray(result.tasks) || !Array.isArray(result.errors)) throw new Error('Daemon does not support deployment hold');
  return result;
}

async function holdAndWait(socketPath: string, timeoutMs: number, controls: DaemonProcessControls): Promise<DeploymentStatus> {
  const deadline = Date.now() + timeoutMs;
  let result = deploymentStatus(await controls.sendRpc(socketPath, { cmd: 'hold' }));
  while (!result.ready && Date.now() < deadline) {
    await controls.delay(Math.min(200, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    result = deploymentStatus(await controls.sendRpc(socketPath, { cmd: 'hold-status' }, Math.max(1, Math.min(2000, deadline - Date.now()))));
  }
  return result;
}

async function deployDaemon(
  parsed: ReturnType<typeof parseCommandArgs>, socketPath: string, logPath: string, distDir: string,
  stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, controls: DaemonProcessControls,
): Promise<number> {
  let step = 'hold';
  const projectRoot = buildProjectRoot(distDir);
  try {
    const timeoutMs = Number(parsed.values.get('--timeout-ms') ?? '60000');
    if (parsed.flags.has('--force')) throw new Error('Deployment cannot bypass safety checks with --force');
    if (checkRestartSafety(dirname(socketPath), false, stderr, 'start') !== 0) throw new Error('Daemon start safety check refused');
    // The durable hold is the only recovery record. After an interrupted build,
    // start the last published generation and ask it to settle that same hold.
    if (controls.findSocketOwnerPid(socketPath) === undefined) await startDetachedAndWait(socketPath, logPath, controls);
    const held = await holdAndWait(socketPath, timeoutMs, controls);
    stdout.write(`${JSON.stringify(held, null, 2)}\n`);
    if (!held.ready) throw new Error('Hold is not settled; inspect flowcrew daemon hold-status');
    const hold = readDeploymentHold();
    if (!hold || hold.releasedAt || hold.id !== held.hold?.id) throw new Error('Daemon hold does not match this FC_HOME');
    const previous = await verifiedDaemonStatus(socketPath, controls);
    const identity = readDaemonIdentity(socketPath)!;
    if (identity.distDir ? buildProjectRoot(identity.distDir) !== projectRoot : identity.build.hash !== computeBuildFingerprint(distDir).hash) {
      throw new Error('Cannot bind the held daemon to this deployment checkout');
    }
    step = 'stop';
    await controls.sendRpc(socketPath, { cmd: 'stop' });
    if (!await waitForOwnerRelease(socketPath, previous.pid, controls, 40)) throw new Error('Held daemon did not release its socket');
    step = 'build';
    stdout.write(`Building deployment checkout ${projectRoot}\n`);
    await controls.build(projectRoot);
    const manifest = assertDistFresh(projectRoot, distDir);
    const expectedBuild = computeBuildFingerprint(distDir).hash;
    step = 'start';
    const started = await startDetachedAndWait(socketPath, logPath, controls);
    step = 'verify';
    if ((started.pid === previous.pid && started.startedAt === previous.startedAt)
        || started.build !== expectedBuild
        || assertDistFresh(projectRoot, distDir).generation !== manifest.generation
        || await reportDaemonStatus(socketPath, distDir, stdout, controls) !== 0) {
      throw new Error('New daemon identity/build generation could not be verified');
    }
    stdout.write(`generation: ${manifest.generation}\n`);
    step = 'continue';
    const continued = deploymentStatus(await controls.sendRpc(socketPath, { cmd: 'continue' }));
    stdout.write(`${JSON.stringify(continued, null, 2)}\n`);
    if (!continued.released || continued.errors.length) throw new Error('Continuation refused; inspect hold-status and the reported task/run before retrying');
    stdout.write('Deployment complete; hold released.\n');
    return 0;
  } catch (error) {
    let holdState = 'hold state unverified; inspect daemon hold-status';
    try {
      const hold = readDeploymentHold();
      holdState = hold && !hold.releasedAt ? 'hold remains active' : hold?.releasedAt ? 'hold already released; verify tasks before retrying' : 'no hold recorded';
    } catch { /* corrupt control state remains a refusal */ }
    stderr.write(`DEPLOY STOPPED at ${step}: ${errorMessage(error)}. ${holdState}. Retry flowcrew daemon deploy --socket ${JSON.stringify(socketPath)} from ${projectRoot} (same FC_HOME).\n`);
    return rpcErrorExitCode(error);
  }
}

async function buildDeployment(projectRoot: string, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: projectRoot, stdio: ['ignore', stdout, stderr], env: { ...process.env, FC_HOME: fcGlobalDir() },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Build exited ${code ?? signal}`)));
  });
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
    return 1;
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
  return 1;
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
    reportRegistryScaleValues(new TaskRegistry({ baseDir }).metrics(), stdout);
  } catch (error) {
    stdout.write('registry_bytes: UNVERIFIED\n');
    stdout.write('registry_records: UNVERIFIED\n');
    stdout.write('registry_tasks: UNVERIFIED\n');
    stdout.write(`UNVERIFIED: cannot inspect local task registry (${errorMessage(error)}).\n`);
  }
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
  const child = controls.spawnDaemon(socketPath, logPath);
  let ready = false;
  let waiting = true;
  let childExited = false;
  try {
    const exited = child.exited.then(reason => { childExited = true; throw new Error(`daemon child exited before readiness (${reason}); see ${logPath}`); });
    const status = await Promise.race([exited, (async () => {
      while (waiting) {
        try {
          const response = await controls.sendRpc(socketPath, { cmd: 'status' }, 300);
          // A competing listener is never evidence that our child started.
          const verified = await verifiedDaemonStatus(socketPath, controls, response);
          if (verified.pid !== child.pid) throw new Error('Daemon socket belongs to a different child');
          return verified;
        } catch (error) {
          if (!(error instanceof DaemonUnavailableError) && !(error instanceof RpcOutcomeUnknownError)) throw error;
        }
        await controls.delay(100);
      }
      throw new Error('Daemon startup ended');
    })()]);
    ready = true;
    return status;
  } finally {
    waiting = false;
    if (!ready && !childExited && child.pid !== undefined && controls.processAlive(child.pid)) {
      controls.killProcess(child.pid, 'SIGKILL');
      await child.exited;
    }
  }
}

async function verifiedDaemonStatus(socketPath: string, controls: DaemonProcessControls, response?: RpcResponse): Promise<DaemonStatusRpcResponse> {
  const status = asDaemonStatus(response ?? await controls.sendRpc(socketPath, { cmd: 'status' }));
  const identity = readDaemonIdentity(socketPath);
  if (!status || controls.findSocketOwnerPid(socketPath) !== status.pid
      || !identity || !identityMatchesStatus(identity, status, socketPath)) {
    throw new Error('Daemon RPC identity, socket owner and daemon.json do not agree');
  }
  return status;
}

async function isRunning(socketPath: string, controls: DaemonProcessControls): Promise<boolean> {
  try {
    await verifiedDaemonStatus(socketPath, controls);
    return true;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return false;
    throw error;
  }
}

function spawnDetachedDaemon(socketPath: string, logPath: string, distDir: string): ReturnType<DaemonProcessControls['spawnDaemon']> {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  try {
    const runtimeDist = pinBuildRuntime(distDir, join(dirname(socketPath), 'runtime'));
    const child = spawn(process.execPath, [join(runtimeDist, 'cli.js'), 'daemon', 'serve', '--socket', socketPath], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    const exited = new Promise<string>(done => {
      child.once('error', error => done(error.message));
      child.once('exit', (code, signal) => done(String(code ?? signal)));
    });
    child.unref();
    return { pid: child.pid, exited };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
