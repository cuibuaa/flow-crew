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
}

export interface DiscussOpts {
  workDir: string;
  sessionDir: string;
  onChunk?: (text: string) => void;
  cols?: number;
  rows?: number;
}

export interface AgentConfig {
  name: string;
  description: string;
  model: string;
  reasoning_effort: string;
  tools: string[];
  prompt: string;
}

export interface Adapter {
  run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult>;
  discuss(message: string, role: AgentConfig, opts: DiscussOpts): Promise<RunResult>;
  spawnDiscuss(message: string, role: AgentConfig, opts: DiscussOpts): ChildProcess;
  /** Spawn an interactive session with PTY. Returns a uniform interface. */
  spawnInteractive(role: AgentConfig, opts: DiscussOpts): Promise<InteractiveSession>;
}

export interface InteractiveSession {
  onData: (cb: (data: string) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onExit: (cb: (exitCode: number) => void) => void;
}

type ExecOpts = {
  cwd: string;
  timeout_ms: number;
  liveLogPath?: string;
  onStdout?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
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
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, Math.max(1, opts.timeout_ms));

    const finish = (code: number | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: output ?? Buffer.concat(chunks).toString('utf-8'),
        exitCode: timedOut ? 124 : code ?? 1,
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
    child.on('error', (error) => finish(1, error.message));
  });
}

export function execWithTimeout(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number; liveLogPath?: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return execChild(cmd, args, opts);
}

export function execWithStreaming(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number; onChunk: (text: string) => void; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return execChild(cmd, args, { ...opts, onStdout: opts.onChunk });
}
