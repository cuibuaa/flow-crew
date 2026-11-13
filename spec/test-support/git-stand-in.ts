import { EventEmitter } from 'node:events';
import { type SpawnSyncOptions } from 'node:child_process';

export interface GitAnswer { status: number | null; stdout?: string | Buffer; stderr?: string; signal?: NodeJS.Signals }
export const success = (stdout: string | Buffer = ''): GitAnswer => ({ status: 0, stdout });

/** An explicit release, never a sleep, is the only way this child can answer. */
export class GitStandIn {
  answer: (args: string[], options: SpawnSyncOptions) => GitAnswer = () => success();
  held = false;
  calls: string[][] = [];
  pending: Array<() => void> = [];
  onHold: (release: () => void) => void = release => release();

  sync(args: string[], options: SpawnSyncOptions = {}) {
    this.calls.push(args);
    let released = !this.held;
    if (this.held) this.onHold(() => { released = true; });
    if (!released) throw new Error('The synchronous stand-in was not released');
    // Model the native child's old deadline with the controlled clock. This
    // also catches a bypass through execFileSync/spawnSync at a consumer.
    const answer = this.held && options.timeout
      ? { status: null, signal: 'SIGTERM' as const }
      : this.answer(args, options);
    const encode = (value: string | Buffer = '') => options.encoding && options.encoding !== 'buffer'
      ? value.toString() : Buffer.from(value);
    const stdout = encode(answer.stdout), stderr = encode(answer.stderr);
    if (typeof options.stdio?.[1] === 'number' && answer.status === 0) {
      // Restoration streams the blob directly into its already-opened file.
      this.writeDescriptor?.(options.stdio[1], Buffer.from(answer.stdout ?? ''));
    }
    return { pid: 1, output: [null, stdout, stderr], status: answer.status,
      signal: answer.signal ?? null, stdout, stderr };
  }
  writeDescriptor?: (fd: number, bytes: Buffer) => void;

  exec(args: string[], options: SpawnSyncOptions = {}) {
    const result = this.sync(args, options);
    if (result.status !== 0) throw Object.assign(new Error('Git child failed'), result);
    return result.stdout;
  }

  spawn(args: string[], options: SpawnSyncOptions = {}) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    this.calls.push(args);
    const release = () => {
      const answer = this.answer(args, options);
      if (answer.stdout) child.stdout.emit('data', Buffer.from(answer.stdout));
      if (answer.stderr) child.stderr.emit('data', Buffer.from(answer.stderr));
      child.emit('close', answer.status, answer.signal ?? null);
    };
    queueMicrotask(() => {
      if (!this.held) release();
      else {
        this.pending.push(release);
        if (options.timeout) setTimeout(() => child.emit('close', null, 'SIGTERM'), options.timeout);
      }
    });
    return child;
  }
}
