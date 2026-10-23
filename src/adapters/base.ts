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

export type { ChildProcess } from 'node:child_process';

interface RunProcessOwner {
  projectDir: string; runId: string; abortSignal?: AbortSignal; onProgress?: () => void;
  owners: Array<{ projectDir: string; runId: string }>;
}
const runOwner = new AsyncLocalStorage<RunProcessOwner>();
export function withRunProcessOwnership<T>(projectDir: string, runId: string, action: () => Promise<T>, abortSignal = runOwner.getStore()?.abortSignal,
  onProgress = runOwner.getStore()?.onProgress): Promise<T> {
  const owners = [...(runOwner.getStore()?.owners ?? [])];
  if (!owners.some(owner => owner.projectDir === projectDir && owner.runId === runId)) owners.push({ projectDir, runId });
  return runOwner.run({ projectDir, runId, abortSignal, onProgress, owners }, action);
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
 * gate closes the spawn/publication crash window without another supervisor or
 * a process registry: ownership lives in the existing engine checkpoint. */
function spawnRunCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const owner = runOwner.getStore();
  if (!owner || process.platform === 'win32') return spawn(command, args, options);
  if (!Array.isArray(options.stdio)) throw new Error('RUN_PROCESS_STDIO: owned commands require explicit descriptors');
  const child = spawn('/bin/sh', ['-c', 'read -r ready <&3 || exit 125; exec 3<&-; exec "$@"', 'flowcrew-command', command, ...args], {
    ...options, stdio: [...options.stdio, 'pipe'],
  });
  const gate = child.stdio[3] as import('node:stream').Writable;
  gate.on('error', () => {});
  try {
    // Enclosing runs must retire every nested consumer before recovering their
    // interrupted stage. Publish all ownership before opening the existing gate.
    if (child.pid) for (const enclosing of owner.owners) updateRunState(enclosing.projectDir, enclosing.runId, state => {
      if (!state.engineCheckpoint?.processes || state.engineCheckpoint.pid !== process.pid) throw new Error('RUN_PROCESS_OWNER_CHANGED: command requires the current checkpoint');
      state.engineCheckpoint.processes.push({ pid: child.pid!, processStart: processStartToken(child.pid!) });
    });
    gate.end('start\n');
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
  engineVoid?: boolean;
  /** Scheduler/worker control boundary: the stage must be re-dispatched, not completed. */
  suspended?: boolean;
  suspensionReason?: 'approval';
  suspensionRequestId?: string;
  suspensionRequestingStageId?: string;
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

/** Adapter-owned proof that an executable tool command crossed a lifecycle
 * boundary. The worker treats this as control-plane evidence, never as agent
 * prose. */
export interface CommandLifecycleEvent {
  phase: CommandLifecyclePhase;
  id: string;
  command?: string;
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
  /** Complete duties and delivered guidance if an explicit resume is unavailable. */
  freshSessionPrompt?: string;
  /** Attempt-local budget. The worker's abort signal enforces the same deadline across all phases. */
  timeout_ms: number;
  workDir: string;
  runDir: string;
  stageId: string;
  /** Current scheduler attempt identity for durable adapter activity facts. */
  attemptIndex?: number;
  attemptStartedAt?: string;
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
  return { env, cleanup: scratch.cleanup };
}

export function execWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  opts: {
    cwd: string;
    timeout_ms: number;
    liveLogPath?: string;
    env?: NodeJS.ProcessEnv;
    /** Remove native nesting markers without suppressing provider authentication. */
    unsetEnv?: readonly string[];
    onStdout?: (text: string, activity?: CommandActivityTracker) => void;
    /** The executable owner binds and closes command evidence with its child;
     * adapters only translate their native events into lifecycle records. */
    execution?: Pick<RunOpts, 'runDir' | 'stageId' | 'attemptIndex' | 'attemptStartedAt' | 'onCommandLifecycle'>;
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
      });
    } catch (error) {
      try { activity?.close(); } finally { environment?.cleanup(); }
      throw error;
    }
    const terminator = createChildTerminator(child, opts.terminationTiming);
    // This handle is used after Claude's separate post-result grace, so it
    // intentionally remains an immediate hard stop rather than adding another.
    const timer = setTimeout(() => {
      timedOut = true;
      terminator.terminateGracefully();
    }, Math.max(1, opts.timeout_ms - (Date.now() - start)));
    const onAbort = () => {
      aborted = true;
      clearTimeout(timer);
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
        clearTimeout(timer);
        if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
        try { activity?.close(); } finally { environment?.cleanup(); }
        if (executionError !== undefined) throw executionError;
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

/** Raw command owner; close retires only descendants of the process we started. */
export function spawnOwnedCommand(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const environment = commandEnvironment(options.env);
  let child: ChildProcess;
  try {
    child = spawnRunCommand(command, args, { ...options, env: environment.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { environment.cleanup(); throw error; }
  const stop = (): void => {
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already closed */ }
  };
  child.once('close', stop);
  child.once('close', environment.cleanup);
  return { child, stop };
}
