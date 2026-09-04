import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { ChildProcess } from 'node:child_process';

export interface RunResult {
  output: string;
  exitCode: number;
  duration_ms: number;
  timedOut?: boolean;
  adapterError?: boolean;
  /** One actionable sentence explaining a diagnosed failure (see adapters/diagnose.ts). */
  friendlyError?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Structured adapter attribution for files written during this invocation. */
  writes?: string[];
  writeAttribution?: 'structured' | 'snapshot' | 'unknown';
  /** Exact conversation UUID captured from adapter event output. */
  sessionId?: string;
  /** Immutable budget assigned to this scheduler attempt. */
  effectiveTimeoutMs?: number;
  /** Worker-owned authoritative termination attribution. */
  timeoutTerminationCause?: string;
}

export interface RunOpts {
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
  /** Keep the owning adapter home for one eligible direct successor. */
  preserveSession?: boolean;
  /** When triggered, the spawned POSIX process group receives a bounded graceful
   *  termination attempt and the adapter returns exitCode=137 ("Aborted by
   *  supervisor"). Used by worker.ts to honor supervisor ABORT verdicts that
   *  previously only wrote a signal file with no consumer. */
  abortSignal?: AbortSignal;
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

type ExecOpts = {
  cwd: string;
  timeout_ms: number;
  liveLogPath?: string;
  onStdout?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  terminationTiming?: ChildTerminationTiming;
};

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

function execChild(cmd: string, args: string[], opts: ExecOpts): Promise<RunResult> {
  const start = Date.now();
  if (opts.liveLogPath) {
    mkdirSync(dirname(opts.liveLogPath), { recursive: true });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
    });
    const terminator = createChildTerminator(child, opts.terminationTiming);
    const chunks: Buffer[] = [];
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminator.terminateGracefully();
    }, Math.max(1, opts.timeout_ms));

    // Honor cancellation via AbortSignal (worker.ts polls signals/abort_<stageId>.json
    // and aborts the controller it owns; we then begin bounded group termination).
    const onAbort = () => {
      aborted = true;
      clearTimeout(timer);
      terminator.terminateGracefully();
    };
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminator.settleAfterChildClose().then(() => {
        if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
        resolve({
          output: aborted
            ? ((output ?? Buffer.concat(chunks).toString('utf-8')) + '\n[stage cancelled by control plane]\n')
            : (output ?? Buffer.concat(chunks).toString('utf-8')),
          exitCode: aborted ? 137 : timedOut ? 124 : code ?? 1,
          duration_ms: Date.now() - start,
          timedOut,
        });
      });
    };

    child.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      opts.onStdout?.(d.toString('utf-8'));
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* ignore */ }
    });
    child.stderr.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* ignore */ }
    });
    child.on('close', (code) => finish(code));
    child.on('error', (error) => {
      const msg = error.message.includes('ENOENT')
        ? `Command not found: ${cmd}. Install the adapter CLI and try again.`
        : error.message;
      finish(1, msg);
    });
  });
}

export function execWithTimeout(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number; liveLogPath?: string; env?: NodeJS.ProcessEnv; onStdout?: (text: string) => void; abortSignal?: AbortSignal; terminationTiming?: ChildTerminationTiming },
): Promise<RunResult> {
  return execChild(cmd, args, opts);
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
    /** Invoked once the child is spawned, gives caller a kill handle (e.g. to
     *  force-exit a hung subprocess after detecting a success event in stdout). */
    onChild?: (handles: { kill: () => void }) => void;
    abortSignal?: AbortSignal;
    terminationTiming?: ChildTerminationTiming;
  },
): Promise<RunResult> {
  const start = Date.now();
  if (opts.liveLogPath) {
    mkdirSync(dirname(opts.liveLogPath), { recursive: true });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
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
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminator.settleAfterChildClose().then(() => {
        if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
        resolve({
          output: Buffer.concat(chunks).toString('utf-8') + (aborted ? '\n[stage cancelled by control plane]\n' : ''),
          exitCode: aborted ? 137 : timedOut ? 124 : code ?? 1,
          duration_ms: Date.now() - start,
          timedOut,
        });
      });
    };
    child.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* non-critical */ }
      opts.onStdout?.(d.toString('utf-8'));
    });
    child.stderr.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* non-critical */ }
    });
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(1));
  });
}
