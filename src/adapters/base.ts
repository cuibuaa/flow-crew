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
  tokens_in?: number;
  tokens_out?: number;
}

export interface RunOpts {
  timeout_ms: number;
  workDir: string;
  runDir: string;
  stageId: string;
  /** When triggered, the spawned child process group is SIGKILLed and the adapter returns
   *  exitCode=137 ("Aborted by supervisor"). Used by worker.ts to honor supervisor ABORT
   *  verdicts that previously only wrote a signal file with no consumer. */
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
};

function killChild(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
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
    const chunks: Buffer[] = [];
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, Math.max(1, opts.timeout_ms));

    // Honor cancellation via AbortSignal (worker.ts polls signals/abort_<stageId>.json
    // and aborts the controller it owns; we then SIGKILL the child process group).
    const onAbort = () => {
      aborted = true;
      killChild(child);
    };
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
      resolve({
        output: aborted
          ? ((output ?? Buffer.concat(chunks).toString('utf-8')) + '\n[stage aborted by supervisor]\n')
          : (output ?? Buffer.concat(chunks).toString('utf-8')),
        exitCode: aborted ? 137 : timedOut ? 124 : code ?? 1,
        duration_ms: Date.now() - start,
        timedOut,
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
  opts: { cwd: string; timeout_ms: number; liveLogPath?: string; env?: NodeJS.ProcessEnv; abortSignal?: AbortSignal },
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
    if (opts.onChild) opts.onChild({ kill: () => killChild(child) });
    const timer = setTimeout(() => { timedOut = true; killChild(child); }, Math.max(1, opts.timeout_ms));
    const onAbort = () => { aborted = true; killChild(child); };
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
      if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);
      resolve({
        output: Buffer.concat(chunks).toString('utf-8') + (aborted ? '\n[stage aborted by supervisor]\n' : ''),
        exitCode: aborted ? 137 : timedOut ? 124 : code ?? 1,
        duration_ms: Date.now() - start,
        timedOut,
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
