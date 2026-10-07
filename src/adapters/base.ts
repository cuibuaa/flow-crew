import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { confineEngineChild, observeEngineChildBoundary, type EngineChildBoundaryReceipt } from '../write-boundary.js';
import type { ProviderFailure } from '../provider-result.js';
import type { InvocationUsage, NativeInvocationUsage } from '../invocation-usage.js';

export type { ChildProcess } from 'node:child_process';

export type AdapterFailureKind =
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
  output: string;
  writeBoundary?: EngineChildBoundaryReceipt;
  exitCode: number;
  /** Direct child close facts, before timeout/control/adapter outcome overrides. */
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  /** Provider-owned refusal attribution; does not enable transport retries. */
  providerFailure?: ProviderFailure;
  duration_ms: number;
  timedOut?: boolean;
  adapterError?: boolean;
  /** Closed adapter-level classification; absent means the stage itself failed. */
  adapterFailureKind?: AdapterFailureKind;
  /** One actionable sentence explaining a diagnosed failure (see adapters/diagnose.ts). */
  friendlyError?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Small native-call ledger, including calls superseded by parameter repairs. */
  invocations?: NativeInvocationUsage[];
  /** Structured adapter attribution for files written during this invocation. */
  writes?: string[];
  writeAttribution?: 'structured' | 'snapshot' | 'unknown';
  /** Generated writes observed only while configured validation commands ran. */
  validationGeneratedWrites?: string[];
  /** Exact conversation UUID captured from adapter event output. */
  sessionId?: string;
  /** Immutable budget assigned to this scheduler attempt. */
  effectiveTimeoutMs?: number;
  /** Worker-owned authoritative termination attribution. */
  timeoutTerminationCause?: string;
  /** Scheduler/worker control boundary: the stage must be re-dispatched, not completed. */
  suspended?: boolean;
  suspensionReason?: 'scope_revision' | 'approval';
  suspensionRequestId?: string;
  suspensionRequestingStageId?: string;
  /** Internal scheduler closure callback; adapters never own durable settlement. */
  settleAttempt?: () => void;
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
  /** Stage whose isolated adapter home owns resumeSessionId. */
  sessionOwnerStageId?: string;
  /** Retain the isolated home across this stage lifecycle or an eligible successor. */
  preserveSession?: boolean;
  /** When triggered, the spawned POSIX process group receives a bounded graceful
   *  termination attempt and the adapter returns exitCode=137 ("Aborted by
   *  supervisor"). Used by worker.ts to honor supervisor ABORT verdicts that
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
  run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult>;
}

/** Bounded cleanup opportunity after an attempt deadline or supervisor abort. */
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
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
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
    if (!terminationStarted || terminationCompleted || !groupIsAlive()) {
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

export function execWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  opts: {
    cwd: string;
    timeout_ms: number;
    liveLogPath?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (text: string) => void;
    /** Opt in when the adapter parses stdout separately from diagnostics. */
    captureStreams?: boolean;
    /** Invoked once the child is spawned, gives caller a kill handle (e.g. to
     *  force-exit a hung subprocess after detecting a success event in stdout). */
    onChild?: (handles: { kill: () => void }) => void;
    abortSignal?: AbortSignal;
    terminationTiming?: ChildTerminationTiming;
  },
): Promise<ExecResult> {
  const start = Date.now();
  if (opts.liveLogPath) {
    mkdirSync(dirname(opts.liveLogPath), { recursive: true });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const launch = confineEngineChild(cmd, args);
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      stdio: launch.receiptPath ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
    });
    let writeBoundary: EngineChildBoundaryReceipt | undefined;
    let boundarySpawnError: RunResult['spawnError'];
    observeEngineChildBoundary(child, launch.receiptPath, (receipt) => {
      writeBoundary = receipt;
      if (receipt.kind === 'spawn_error') boundarySpawnError = receipt;
    });
    const terminator = createChildTerminator(child, opts.terminationTiming);
    // This handle is used after Claude's separate post-result grace, so it
    // intentionally remains an immediate hard stop rather than adding another.
    if (opts.onChild) opts.onChild({ kill: terminator.hardKill });
    const timer = setTimeout(() => {
      timedOut = true;
      terminator.terminateGracefully();
    }, Math.max(1, opts.timeout_ms));
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
    const finish = (code: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminator.settleAfterChildClose().then(() => {
        const boundaryUnverified = launch.receiptPath && !writeBoundary;
        const boundaryRefused = writeBoundary?.kind === 'refused';
        const boundaryDiagnostic = boundaryUnverified ? '\nENGINE_WRITE_BOUNDARY_UNVERIFIED: launcher closed without enforcement receipt; child fate is unknown\n'
          : writeBoundary?.kind === 'refused' && writeBoundary.message.startsWith('ENGINE_WRITE_BOUNDARY_UNVERIFIED') ? `\n${writeBoundary.message}\n` : '';
        if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
        resolve({
          output: Buffer.concat(chunks).toString('utf-8') + (aborted ? '\n[stage cancelled by control plane]\n' : '') + boundaryDiagnostic,
          exitCode: aborted ? 137 : timedOut ? 124 : boundaryUnverified || boundaryRefused ? 125 : boundarySpawnError ? 1 : code ?? 1,
          ...(!spawnError && !boundarySpawnError ? { processExitCode: code, processSignal: signal ?? null } : {}),
          duration_ms: Date.now() - start,
          timedOut,
          ...(writeBoundary ? { writeBoundary } : {}),
          ...(boundarySpawnError ? { spawnError: boundarySpawnError } : {}),
          ...(opts.captureStreams ? {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
          } : {}),
          ...(spawnError ? { spawnError } : {}),
        });
      });
    };
    child.stdout!.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.captureStreams) stdout.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* non-critical */ }
      opts.onStdout?.(d.toString('utf-8'));
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
  });
}
