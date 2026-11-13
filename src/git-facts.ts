/** Git alone supplies the exit status of a Git fact. There is no read deadline. */
import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns, type SpawnOptions } from 'node:child_process';

/** A child that was stopped without answering is neither a Git error nor an empty fact. */
export class GitNotAnswered extends Error {
  readonly kind = 'git-not-answered';
  readonly code = 'GIT_NOT_ANSWERED';
  constructor(readonly signal: NodeJS.Signals | null) {
    super('Git ended without an exit status');
    this.name = 'GitNotAnswered';
  }
}

export function rethrowGitNotAnswered(error: unknown): void {
  if (error instanceof GitNotAnswered) throw error;
}

/** Explicit executable seam for held-child tests; production always uses Git. */
export interface GitProgram { file: string; prefixArgs: readonly string[] }
const git: GitProgram = { file: 'git', prefixArgs: [] };
type SyncOptions = Omit<SpawnSyncOptions, 'timeout' | 'killSignal'>;
type TextOptions = SyncOptions & { encoding: BufferEncoding };

function answered(status: number | null, signal: NodeJS.Signals | null, error?: Error): void {
  // Launch failures retain the existing caller policy. A running child killed
  // from outside has no exit status and must never enter that policy.
  if (status === null && (signal !== null || !error)) throw new GitNotAnswered(signal);
}

export function gitResultSync(args: readonly string[], options: TextOptions, program?: GitProgram): SpawnSyncReturns<string>;
export function gitResultSync(args: readonly string[], options?: SyncOptions, program?: GitProgram): SpawnSyncReturns<Buffer>;
export function gitResultSync(args: readonly string[], options: SyncOptions = {}, program = git): SpawnSyncReturns<string | Buffer> {
  const result = spawnSync(program.file, [...program.prefixArgs, ...args], options);
  answered(result.status, result.signal, result.error);
  return result;
}

export function gitSync(args: readonly string[], options: TextOptions, program?: GitProgram): string;
export function gitSync(args: readonly string[], options?: SyncOptions, program?: GitProgram): Buffer;
export function gitSync(args: readonly string[], options: SyncOptions = {}, program = git): string | Buffer {
  const result = gitResultSync(args, options, program);
  if (result.error) throw Object.assign(result.error, result);
  if (result.status !== 0) throw Object.assign(new Error(`Command failed: git ${args.join(' ')}${result.stderr?.length ? `\n${result.stderr}` : ''}`), result);
  return result.stdout;
}

export interface GitExit { status: number | null; error?: Error }
interface AsyncOptions extends Pick<SpawnOptions, 'cwd' | 'env'> {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

/** Async callers retain their shape and their own output-capture contracts. */
export function runGit(args: readonly string[], options: AsyncOptions, program = git): Promise<GitExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(program.file, [...program.prefixArgs, ...args], {
      cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => options.onStdout?.(chunk));
    child.stderr.on('data', (chunk: Buffer) => options.onStderr?.(chunk));
    child.once('error', value => { error = value; });
    child.once('close', (status, signal) => {
      try { answered(status, signal, error); resolve({ status, ...(error ? { error } : {}) }); }
      catch (failure) { reject(failure); }
    });
  });
}

/** execFile-style text reads, with the same nonzero-exit contract as gitSync. */
export async function gitAsync(args: readonly string[], options: Pick<AsyncOptions, 'cwd' | 'env'>, program = git): Promise<string> {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  let overflow = false;
  const append = (stream: keyof typeof chunks, chunk: Buffer): void => {
    sizes[stream] += chunk.byteLength;
    if (sizes[stream] > 1024 * 1024) overflow = true;
    else chunks[stream].push(chunk);
  };
  const result = await runGit(args, { ...options,
    onStdout: chunk => append('stdout', chunk), onStderr: chunk => append('stderr', chunk),
  }, program);
  const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
  if (result.error) throw result.error;
  if (result.status !== 0 || overflow) throw Object.assign(new Error('Git exited unsuccessfully'), { ...result, stdout, stderr });
  return stdout;
}
