import { scheduleDeadline } from '../attempt-deadline.js';
import { GitNotAnswered } from '../git-facts.js';
import type { EndingCause } from '../attempt-ending.js';
import { appendFileSync, mkdirSync } from '../engine-fs.js';

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runDir, updateRunState, type StageContinuation, type AttemptTerminationCause } from '../store.js';
import { createInvocationScratch } from '../invocation-scratch.js';
import { processGroupIsAlive, processStartToken } from '../process-liveness.js';
import type { ProviderFailure } from '../provider-result.js';
import { CommandActivityTracker } from '../command-activity.js';
import type { InvocationUsage, NativeInvocationUsage } from '../invocation-usage.js';
import { currentStageWriteGrant, prepareWriteGrant, writeGrantExecPython, WriteGrantError, type PreparedWriteGrant, type WriteGrantFailure } from '../write-grant.js';

export type { ChildProcess } from 'node:child_process';

interface RunProcessOwner {
  projectDir: string; runId: string; abortSignal?: AbortSignal; onProgress?: () => void;
  owners: Array<{ projectDir: string; runId: string }>;
  publications: Promise<void>[];
}
const runOwner = new AsyncLocalStorage<RunProcessOwner>();
const commandPublications = new WeakMap<ChildProcess, Promise<void>>();
export function withRunProcessOwnership<T>(projectDir: string, runId: string, action: () => Promise<T>, abortSignal = runOwner.getStore()?.abortSignal,
  onProgress = runOwner.getStore()?.onProgress): Promise<T> {
  const owners = [...(runOwner.getStore()?.owners ?? [])];
  if (!owners.some(owner => owner.projectDir === projectDir && owner.runId === runId)) owners.push({ projectDir, runId });
  const publications: Promise<void>[] = [];
  return runOwner.run({ projectDir, runId, abortSignal, onProgress, owners, publications }, async () => {
    let outcome: PromiseSettledResult<T>;
    try { outcome = { status: 'fulfilled', value: await action() }; }
    catch (reason) { outcome = { status: 'rejected', reason }; }
    // A command may return its handle before its identity arrives. Join that
    // publication here, after failed commands have closed their gate/child.
    const results = await Promise.allSettled(publications);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

// Nested workflows inherit cancellation at the worker boundary, including role-selected adapters.
// An adapter wrapper alone is bypassed by those overrides; reuse the run ownership context.
export function runProcessAbortSignal(): AbortSignal | undefined { return runOwner.getStore()?.abortSignal; }

/** Nested executions share their verified work with the enclosing stage's live
 * carrier, just as they inherit cancellation. Unrelated observations cannot report it. */
export function reportRunProcessProgress(projectDir: string, runId: string): void {
  const owner = runOwner.getStore();
  if (owner?.projectDir === projectDir && owner.runId === runId) owner.onProgress?.();
}

/** Keep the existing detached command groups, but bind them before execution.
 * Deleting the boot restriction alone cannot exclude orphan writers. The pipe
 * gate closes the spawn/publication crash window, including raw-command
 * supervision: ownership lives in the existing engine checkpoint. */
const grantFailures = new WeakMap<ChildProcess, WriteGrantFailure>();
const appliedGrants = new WeakMap<ChildProcess, { abi: number; linkedFileCount: 0 }>();
function spawnRunCommand(command: string, args: string[], options: SpawnOptions, supervise = false, priority?: number, grant?: PreparedWriteGrant): ChildProcess {
  const owner = runOwner.getStore();
  if ((!owner && !supervise && !grant) || process.platform === 'win32') return spawn(command, args, options);
  if (!Array.isArray(options.stdio)) throw new Error('RUN_PROCESS_STDIO: owned commands require explicit descriptors');
  if (grant) {
    args = ['-I', '-S', '-B', '-c', writeGrantExecPython, JSON.stringify({ abi: grant.abi, writable: grant.writable, noRefer: grant.noRefer }), command, ...args];
    command = '/usr/bin/python3';
  }
  const child = spawn(supervise ? '/usr/bin/python3' : '/bin/sh', supervise
    ? ['-I', '-S', '-B', '-c', commandSupervisor, command, ...args]
    : ['-c', 'read -r ready <&3 || exit 125; exec 3<&-; exec "$@"', 'flowcrew-command', command, ...args], {
    ...options, stdio: [...options.stdio, 'pipe', ...(grant ? ['pipe' as const] : [])],
  });
  if (grant) {
    let receipt = '';
    child.stdio[4]!.on('data', bytes => { receipt += bytes.toString(); });
    child.stdio[4]!.on('end', () => {
      try {
        for (const line of receipt.trim().split('\n')) {
          const applied = JSON.parse(line) as { kind: string; abi?: number; linkedFileCount?: number };
          if (applied.kind === 'applied' && applied.abi === grant.abi && applied.linkedFileCount === 0) {
            appliedGrants.set(child, { abi: grant.abi, linkedFileCount: 0 });
            continue;
          }
          const outcome = applied as WriteGrantFailure;
          grantFailures.set(child, outcome.kind === 'linked_files' && Number.isSafeInteger(outcome.count) && outcome.count > 0
            || outcome.kind === 'exec_failed' && Number.isSafeInteger(outcome.errno) && typeof outcome.path === 'string'
            || outcome.kind === 'unsafe_path' && typeof outcome.path === 'string'
            ? outcome : { kind: 'application_failed', errno: outcome.kind === 'application_failed' ? outcome.errno : null });
        }
      } catch { grantFailures.set(child, { kind: 'application_failed', errno: null }); }
    });
  }
  const gate = child.stdio[3] as import('node:stream').Duplex;
  gate.on('error', () => {});
  try {
    // Enclosing runs must retire every nested consumer before recovering their
    // interrupted stage. Publish all ownership before opening the existing gate.
    if (child.pid) for (const enclosing of owner?.owners ?? []) updateRunState(enclosing.projectDir, enclosing.runId, state => {
      if (!state.engineCheckpoint?.processes || state.engineCheckpoint.pid !== process.pid) throw new Error('RUN_PROCESS_OWNER_CHANGED: command requires the current checkpoint');
      state.engineCheckpoint.processes.push({ pid: child.pid!, processStart: processStartToken(child.pid!), ...(supervise ? { supervised: true } : {}) });
    });
    if (supervise) {
      // The supervisor retains all adopted descendants. Publish the command
      // identity too, before its execution gate opens, for existing observers.
      let identity = '';
      let publicationFailure: GitNotAnswered | undefined;
      let published!: () => void;
      const publication = new Promise<void>((resolve, reject) => {
        published = resolve;
        child.once('close', () => publicationFailure ? reject(publicationFailure) : resolve());
      });
      // The run boundary joins it even if the action is still awaiting close.
      void publication.catch(() => {});
      commandPublications.set(child, publication);
      owner?.publications.push(publication);
      gate.on('data', bytes => {
        identity += bytes.toString();
        if (!identity.endsWith('\n')) return;
        const pid = Number(identity.trim());
        try {
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('RUN_PROCESS_IDENTITY_INVALID');
          for (const enclosing of owner?.owners ?? []) updateRunState(enclosing.projectDir, enclosing.runId, state => {
            if (state.engineCheckpoint?.pid !== process.pid) throw new Error('RUN_PROCESS_OWNER_CHANGED');
            state.engineCheckpoint.processes!.unshift({ pid, processStart: processStartToken(pid) });
          });
          gate.end('exec\n');
          published();
        } catch (error) {
          if (error instanceof GitNotAnswered) publicationFailure = error;
          gate.end();
          child.kill('SIGTERM');
        }
      });
      gate.write(priority === undefined ? 'start\n' : `start ${priority}\n`);
    } else gate.end('start\n');
  } catch (error) {
    gate.end();
    child.kill('SIGKILL');
    throw error;
  }
  return child;
}

export type AdapterFailureKind =
  | 'authentication'
  | 'forbidden'
  | 'connection_refused'
  | 'connection_reset'
  | 'rate_limited'
  | 'transport_timeout'
  | 'bad_gateway'
  | 'service_unavailable'
  | 'overloaded'
  | 'capacity';

export interface RunResult extends InvocationUsage {
  writeGrantFailure?: WriteGrantFailure;
  writeGrantApplied?: { abi: number; linkedFileCount: 0 };
  continuation?: StageContinuation;
  output: string;
  exitCode: number;
  /** Direct child close facts, before timeout/control/adapter outcome overrides. */
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  /** Adapter-owned terminal failure, independent of assistant and tool messages. */
  providerFailure?: ProviderFailure;
  duration_ms: number;
  timedOut?: boolean;
  /** One actionable sentence explaining a diagnosed failure (see adapters/diagnose.ts). */
  friendlyError?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Small native-call ledger, including calls superseded by parameter repairs. */
  invocations?: NativeInvocationUsage[];
  /** Structured adapter attribution for files written during this invocation. */
  writes?: string[];
  writeAttribution?: 'structured' | 'snapshot' | 'unknown';
  /** Writes to ignored outputs proven by the admitted validation baseline. */
  validationGeneratedWrites?: string[];
  /** Exact conversation UUID captured from adapter event output. */
  sessionId?: string;
  /** Immutable budget assigned to this scheduler attempt. */
  effectiveTimeoutMs?: number;
  /** Worker-owned authoritative termination attribution. */
  terminationCause?: AttemptTerminationCause;
  endingCause?: EndingCause;
  engineVoid?: boolean;
  /** Original launch failure; ENOENT can name a missing cwd or interpreter too. */
  spawnError?: {
    message: string;
    code?: string;
    syscall?: string;
    path?: string;
    cwd: string;
  };
}

/** Raw streams are for adapter parsing, not downstream handoff context. */
export interface ExecResult extends RunResult {
  stdout?: string;
  stderr?: string;
}

export type CommandLifecyclePhase = 'started' | 'completed';

/** Explicit native shell context. Missing context is unknown, never the
 * provider's initial working directory or an assumed shell. */
export interface CommandContext {
  cwd: string;
  shell: string;
}

/** Adapter-owned proof that an executable tool command crossed a lifecycle
 * boundary. The worker treats this as control-plane evidence, never as agent
 * prose. */
export interface CommandLifecycleEvent {
  phase: CommandLifecyclePhase;
  /** Only a native structured exit field, never inferred from tool text. */
  exitCode?: number;
  output?: string;
  id: string;
  command?: string;
  context?: CommandContext;
  timestamp: string;
}

export interface RunOpts {
  /** One JSON Schema shared by generation-capable adapters and return validation. */
  outputSchema?: import('../reality-gate/checks/json-schema-match.js').Schema;
  /** Final credential-free transport boundary, called before every internal retry. */
  onInvocationInput?: (input: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    resumeSessionId?: string;
    transport?: { kind: 'stdin' | 'argv' | 'request'; payload: string };
  }) => void;
  /** Opt-in credential-free native request ledger, before adapter cleanup. */
  onRequestEvidence?: (record: unknown) => void;
  /** Complete duties and delivered guidance if an explicit resume is unavailable. */
  freshSessionPrompt?: string;
  /** Attempt-local budget. The worker's abort signal enforces the same deadline across all phases. */
  timeout_ms?: number;
  workDir: string;
  runDir: string;
  stageId: string;
  /** Current scheduler attempt identity for durable adapter activity facts. */
  attemptIndex?: number;
  attemptStartedAt?: string;
  invocationIndex?: number;
  /** Resume only this explicit UUID; global-most-recent selection is forbidden. */
  resumeSessionId?: string;
  /** Closed stage whose conversation is copied into this stage's private home. */
  sessionOwnerStageId?: string;
  /** Retain the isolated home across this stage lifecycle or an eligible successor. */
  preserveSession?: boolean;
  /** When triggered, the spawned POSIX process group receives a bounded graceful
   *  termination attempt and the adapter returns exitCode=137 ("Aborted by
   *  engine"). Used by worker.ts to honor stage abort verdicts that
   *  previously only wrote a signal file with no consumer. */
  abortSignal?: AbortSignal;
  /** Trustworthy command boundaries emitted by the selected adapter. */
  onCommandLifecycle?: (event: CommandLifecycleEvent) => void;
}

export interface AgentConfig {
  name: string;
  description: string;
  model: string;
  reasoning_effort: string;
  tools: string[];
  prompt: string;
  /** Optional per-role adapter override (e.g. "claude", "codex"). When set, this role runs on its own adapter instead of the run-level adapter. */
  adapter?: string;
  /** Self-declared handoff context verbosity (atom: replaces the engine's hardcoded role→visibility map). Default 'full'. */
  handoff_visibility?: 'full' | 'minimal' | 'none';
}

export interface Adapter {
  /** Native session namespace used by shared admission and home cleanup. */
  readonly sessionKind?: string;
  /** Calls onInvocationInput before every native call, including internal retries.
   * Other adapters are recorded at their public run boundary. */
  readonly capturesInvocationInput?: boolean;
  run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult>;
}

/** Bounded cleanup opportunity after an attempt deadline or engine abort. */
export const ATTEMPT_TERMINATION_GRACE_MS = 5_000;
export const ATTEMPT_TERMINATION_POLL_MS = 25;

export interface ChildTerminationTiming {
  graceMs?: number;
  pollMs?: number;
}

export function resolveChildTerminationTiming(
  timing: ChildTerminationTiming = {},
): Required<ChildTerminationTiming> {
  const graceMs = Number.isFinite(timing.graceMs)
    ? Math.max(0, Math.floor(timing.graceMs!))
    : ATTEMPT_TERMINATION_GRACE_MS;
  const pollMs = Number.isFinite(timing.pollMs)
    ? Math.max(1, Math.floor(timing.pollMs!))
    : ATTEMPT_TERMINATION_POLL_MS;
  return { graceMs, pollMs };
}

function hardKillChild(child: ChildProcess): void {
  // A failed spawn has no owned process to signal, even before its error event.
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

interface ChildTerminator {
  terminateGracefully(): void;
  hardKill(): void;
  settleAfterChildClose(): Promise<void>;
}

function createChildTerminator(
  child: ChildProcess,
  timingOverrides: ChildTerminationTiming = {},
): ChildTerminator {
  const timing = resolveChildTerminationTiming(timingOverrides);
  let terminationStarted = false;
  let terminationCompleted = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let groupPollTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveSettlement: (() => void) | undefined;

  const hardKill = (): void => hardKillChild(child);
  const groupIsAlive = (): boolean => {
    if (process.platform === 'win32' || !child.pid) return false;
    // Keep waiting when group fate is unobservable.
    try { return processGroupIsAlive(child.pid); } catch { return true; }
  };
  const completeTermination = (): void => {
    if (terminationCompleted) return;
    terminationCompleted = true;
    clearTimeout(escalationTimer);
    clearTimeout(groupPollTimer);
    escalationTimer = undefined;
    groupPollTimer = undefined;
    resolveSettlement?.();
    resolveSettlement = undefined;
  };
  const terminateGracefully = (): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    if (!child.pid) {
      completeTermination();
      return;
    }

    // Node maps signal names to forceful process termination on Windows and
    // cannot signal a Windows process group. Waiting after "SIGTERM" there
    // would add delay without providing a POSIX-style cleanup opportunity.
    if (process.platform === 'win32') {
      hardKill();
      completeTermination();
      return;
    }

    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
    escalationTimer = setTimeout(() => {
      hardKill();
      completeTermination();
    }, timing.graceMs);
  };

  const settleAfterChildClose = (): Promise<void> => {
    // A normal leader exit can leave children with closed/ignored stdio alive.
    // Retire that owned group before the adapter can remove its credentials.
    if (!terminationStarted && groupIsAlive()) terminateGracefully();
    if (terminationCompleted || !groupIsAlive()) {
      completeTermination();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      resolveSettlement = resolve;
      const pollGroup = (): void => {
        if (!groupIsAlive()) {
          completeTermination();
          return;
        }
        groupPollTimer = setTimeout(pollGroup, timing.pollMs);
      };
      groupPollTimer = setTimeout(pollGroup, timing.pollMs);
    });
  };

  return {
    terminateGracefully,
    hardKill,
    settleAfterChildClose,
  };
}

/** Every command gets invocation-private scratch, retained until its run becomes terminal.
 * Callers retain their own credential/configuration policy. */
function commandEnvironment(inherited: NodeJS.ProcessEnv = process.env, unsetEnv: readonly string[] = [], runDirectory?: string) {
  const owner = runOwner.getStore();
  const scratch = createInvocationScratch(runDirectory ?? (owner && runDir(owner.projectDir, owner.runId)));
  const env: NodeJS.ProcessEnv = { ...inherited, TMPDIR: scratch.path, TMP: scratch.path, TEMP: scratch.path };
  for (const name of unsetEnv) delete env[name];
  try {
    const declaration = currentStageWriteGrant();
    const grant = declaration && prepareWriteGrant(declaration, scratch.path, env);
    if (grant) Object.assign(env, grant.env);
    return { env, grant, cleanup: scratch.cleanup };
  } catch (error) { scratch.cleanup(); throw error; }
}

export function execWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  opts: {
    cwd: string;
    timeout_ms?: number;
    liveLogPath?: string;
    env?: NodeJS.ProcessEnv;
    /** Remove native nesting markers without suppressing provider authentication. */
    unsetEnv?: readonly string[];
    onStdout?: (text: string, activity?: CommandActivityTracker) => void;
    /** The executable owner binds and closes command evidence with its child;
     * adapters only translate their native events into lifecycle records. */
    execution?: Pick<RunOpts, 'runDir' | 'stageId' | 'attemptIndex' | 'attemptStartedAt' | 'invocationIndex' | 'onCommandLifecycle'>;
    /** Opt in when the adapter parses stdout separately from diagnostics. */
    captureStreams?: boolean;
    /** Invoked once the child is spawned, gives caller a kill handle (e.g. to
     *  force-exit a hung subprocess after detecting a success event in stdout). */
    onChild?: (handles: { kill: () => void; pid?: number }) => void;
    abortSignal?: AbortSignal;
    terminationTiming?: ChildTerminationTiming;
  },
): Promise<ExecResult> {
  const start = Date.now();
  if (opts.liveLogPath) {
    mkdirSync(dirname(opts.liveLogPath), { recursive: true });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const execution = opts.execution;
    const activity = execution?.attemptIndex !== undefined && execution.attemptStartedAt
      ? new CommandActivityTracker({ ...execution, attemptIndex: execution.attemptIndex,
          attemptStartedAt: execution.attemptStartedAt, onLifecycle: execution.onCommandLifecycle }) : undefined;
    let environment: ReturnType<typeof commandEnvironment> | undefined;
    let child: ChildProcess;
    try {
      environment = commandEnvironment({ ...process.env, ...opts.env }, opts.unsetEnv, opts.execution?.runDir);
      child = spawnRunCommand(cmd, args, {
        cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        detached: process.platform !== 'win32', env: environment.env,
      }, false, undefined, environment.grant);
    } catch (error) {
      try { activity?.close(); } finally { environment?.cleanup(); }
      if (error instanceof WriteGrantError) {
        resolve({ output: error.message, friendlyError: error.message, exitCode: 125,
          duration_ms: Date.now() - start, writeGrantFailure: error.outcome,
          ...(opts.captureStreams ? { stdout: '', stderr: '' } : {}) });
        return;
      }
      throw error;
    }
    const terminator = createChildTerminator(child, opts.terminationTiming);
    const cancelDeadline = opts.timeout_ms === undefined ? undefined : scheduleDeadline(() => {
      timedOut = true;
      terminator.terminateGracefully();
    }, () => opts.timeout_ms! - (Date.now() - start));
    const onAbort = () => {
      aborted = true;
      cancelDeadline?.();
      terminator.terminateGracefully();
    };
    let abortedBeforeWrite = false;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) { abortedBeforeWrite = true; onAbort(); }
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    // Guard the stdin write: if spawn failed (ENOENT, emitted async) or the child
    // was already killed (aborted), writing to stdin emits/raises EPIPE. Without an
    // 'error' handler that surfaces as an unhandled exception that crashes the
    // process. Attach a handler and skip the write when already aborted.
    if (child.stdin) child.stdin.on('error', () => { /* EPIPE on dead child — non-fatal */ });
    if (!abortedBeforeWrite) {
      try {
        child.stdin!.write(stdin);
        child.stdin!.end();
      } catch { /* child already gone; close/error event will settle the promise */ }
    }
    const chunks: Buffer[] = [];
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: RunResult['spawnError'];
    let executionError: unknown;
    const finish = (code: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      void terminator.settleAfterChildClose().then(() => {
        // The deadline and command evidence cover group retirement after close.
        cancelDeadline?.();
        if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
        try { activity?.close(); } finally { environment?.cleanup(); }
        if (executionError !== undefined) throw executionError;
        const writeGrantFailure = grantFailures.get(child);
        resolve({
          output: Buffer.concat(chunks).toString('utf-8') + (aborted ? '\n[stage cancelled by control plane]\n' : ''),
          exitCode: aborted ? 137 : timedOut ? 124 : code ?? 1,
          ...(!spawnError ? { processExitCode: code, processSignal: signal ?? null } : {}),
          duration_ms: Date.now() - start,
          timedOut,
          ...(opts.captureStreams ? {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
          } : {}),
          ...(spawnError ? { spawnError } : {}),
          ...(writeGrantFailure ? { writeGrantFailure, exitCode: 125, friendlyError: new WriteGrantError(writeGrantFailure).message } : {}),
          ...(appliedGrants.has(child) ? { writeGrantApplied: appliedGrants.get(child) } : {}),
        });
      }).catch(reject);
    };
    child.stdout!.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.captureStreams) stdout.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* non-critical */ }
      opts.onStdout?.(d.toString('utf-8'), activity);
    });
    child.stderr!.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.captureStreams) stderr.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* non-critical */ }
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', (error: NodeJS.ErrnoException & { path?: string }) => {
      spawnError = {
        message: error.message,
        code: error.code,
        syscall: error.syscall,
        path: error.path,
        cwd: opts.cwd,
      };
      const diagnostic = `\n[process launch failed: ${error.message}; cwd=${JSON.stringify(opts.cwd)}]\n`;
      chunks.push(Buffer.from(diagnostic));
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, diagnostic); } catch { /* non-critical */ }
      finish(1);
    });
    try {
      activity?.bindProcess(child.pid, 'provider');
      opts.onChild?.({ kill: terminator.hardKill, pid: child.pid });
    } catch (error) { executionError = error; terminator.hardKill(); }
  });
}

/** A subreaper replaces sampled ancestry: even a fast setsid/double-fork worker
 * stays owned after its command leader or controller exits. The checkpointed
 * supervisor lives until every child is reaped, and TERM retires adopted children. */
const commandSupervisor = String.raw`
import ctypes, os, signal, sys, time
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'subreaper unavailable')
stopping = False
def stop(signum, frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
gate = os.fdopen(3, 'r+b', buffering=0)
start = gate.readline().split()
if start[:1] != [b'start']: sys.exit(125)
# A niceness increment, as nice(1) applies it, without needing that binary on PATH.
if len(start) > 1: os.nice(int(start[1]))
reader, writer = os.pipe()
primary = os.fork()
if primary == 0:
    os.close(writer)
    gate.close()
    os.setsid()
    if os.read(reader, 1) != b'x': os._exit(125)
    os.close(reader)
    # CPython starts with SIGPIPE/SIGXFZ/SIGXFSZ ignored; ignored dispositions
    # survive exec, so restore every one this interpreter may have changed.
    for restored in ('SIGTERM', 'SIGINT', 'SIGPIPE', 'SIGXFZ', 'SIGXFSZ'):
        if hasattr(signal, restored): signal.signal(getattr(signal, restored), signal.SIG_DFL)
    try: os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    except OSError as error:
        print(str(error), file=sys.stderr, flush=True)
        os._exit(127)
os.close(reader)
gate.write((str(primary) + '\n').encode())
if gate.readline() == b'exec\n': os.write(writer, b'x')
else: stopping = True
os.close(writer)
gate.close()
result = 125
while True:
    if stopping:
        # Only our unreaped children are signalled. Killing a parent adopts its
        # children here; repeat until waitpid proves there are no consumers.
        with open('/proc/self/task/%d/children' % os.getpid()) as children:
            for child in children.read().split():
                try: os.kill(int(child), signal.SIGKILL)
                except ProcessLookupError: pass
    try: pid, status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError: break
    if pid == primary: result = os.waitstatus_to_exitcode(status)
    if pid == 0: time.sleep(0.01)
if stopping: result = -signal.SIGTERM
if result < 0:
    # End by the command's own signal. KILL and STOP accept no disposition.
    try: signal.signal(-result, signal.SIG_DFL)
    except (OSError, ValueError): pass
    os.kill(os.getpid(), -result)
sys.exit(result)
`;

export function spawnOwnedCommand(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; priority?: number }) {
  const environment = commandEnvironment(options.env);
  let child: ChildProcess;
  try {
    const { priority, ...spawnOptions } = options;
    child = spawnRunCommand(command, args, { ...spawnOptions, env: environment.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }, process.platform === 'linux', priority, environment.grant);
  } catch (error) { environment.cleanup(); throw error; }
  const retired = new Promise<void>(resolve => child.once('close', () => resolve()));
  const stop = (): Promise<void> => {
    if (process.platform === 'linux' && (child.exitCode !== null || child.signalCode !== null)) return retired;
    try { if (process.platform === 'linux') child.kill('SIGTERM');
      else if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL'); } catch { /* already closed */ }
    return retired;
  };
  child.once('close', stop);
  child.once('close', environment.cleanup);
  return { child, stop, publication: commandPublications.get(child) ?? retired,
    writeGrantFailure: () => grantFailures.get(child), writeGrantApplied: () => appliedGrants.get(child) };
}
