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

export function execWithTimeout(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number; liveLogPath?: string },
): Promise<RunResult> {
  const timeoutSec = Math.ceil(opts.timeout_ms / 1000);
  const start = Date.now();
  if (opts.liveLogPath) {
    mkdirSync(dirname(opts.liveLogPath), { recursive: true });
  }
  return new Promise((resolve) => {
    const child = spawn('timeout', ['--signal=KILL', String(timeoutSec), cmd, ...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* ignore */ }
    });
    child.stderr.on('data', (d: Buffer) => {
      chunks.push(d);
      if (opts.liveLogPath) try { appendFileSync(opts.liveLogPath, d); } catch { /* ignore */ }
    });
    child.on('close', (code) => {
      resolve({
        output: Buffer.concat(chunks).toString('utf-8'),
        exitCode: code ?? 1,
        duration_ms: Date.now() - start,
      });
    });
    child.on('error', () => {
      resolve({ output: '', exitCode: 1, duration_ms: Date.now() - start });
    });
  });
}

export function execWithStreaming(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number; onChunk: (text: string) => void },
): Promise<RunResult> {
  const timeoutSec = Math.ceil(opts.timeout_ms / 1000);
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn('timeout', ['--signal=KILL', String(timeoutSec), cmd, ...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      opts.onChunk(d.toString('utf-8'));
    });
    child.stderr.on('data', (d: Buffer) => {
      chunks.push(d);
    });
    child.on('close', (code) => {
      resolve({
        output: Buffer.concat(chunks).toString('utf-8'),
        exitCode: code ?? 1,
        duration_ms: Date.now() - start,
      });
    });
    child.on('error', () => {
      resolve({ output: '', exitCode: 1, duration_ms: Date.now() - start });
    });
  });
}
