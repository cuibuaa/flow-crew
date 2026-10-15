import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync } from './engine-fs.js';
import { createReadStream, existsSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RollbackStatIdentity {
  type: 'file' | 'symlink' | 'other';
  dev: string;
  ino: string;
  size: string;
  mode: string;
  ctimeNs: string;
  mtimeNs: string;
}

export interface RollbackHashResult {
  sha256: string;
  byteLength: number;
  statIdentity: RollbackStatIdentity;
}

export interface RollbackCaptureResult extends RollbackHashResult {
  backingPath: string;
}

/** Identity fields an ordinary unprivileged content replacement cannot restore. */
export function rollbackStatIdentity(path: string): RollbackStatIdentity | undefined {
  try {
    // This identity nominates the directory entry itself. Following a link
    // here would make an unchanged symlink look like its regular-file target
    // and send the cooperative reader down the wrong content path.
    const stat = lstatSync(path, { bigint: true });
    return {
      type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };
  } catch {
    return undefined;
  }
}

export function rollbackStatIdentitiesEqual(
  left: RollbackStatIdentity | undefined,
  right: RollbackStatIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function descriptorIdentity(descriptor: number): RollbackStatIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  return {
    type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

/** Feed exact file bytes into a digest with bounded memory and stable identity. */
export function updateFileHashSync(path: string, hash: Hash): Omit<RollbackHashResult, 'sha256'> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const before = descriptorIdentity(descriptor);
    if (before.type !== 'file') throw new Error(`${path} is not a regular file`);
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let byteLength = 0;
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      byteLength += count;
    }
    const after = descriptorIdentity(descriptor);
    if (!rollbackStatIdentitiesEqual(before, after) || byteLength !== Number(after.size)) {
      throw new Error(`${path} changed while its content was hashed`);
    }
    return { byteLength, statIdentity: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Constant-memory synchronous content identity. */
export function hashRollbackFileSync(path: string): RollbackHashResult {
  const hash = createHash('sha256');
  const result = updateFileHashSync(path, hash);
  return { ...result, sha256: hash.digest('hex') };
}

/**
 * Stream a nominated changed file. Each hash update is bounded to one chunk,
 * leaving timers and filesystem callbacks runnable between reads.
 */
export async function hashRollbackFileCooperatively(path: string): Promise<RollbackHashResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = rollbackStatIdentity(path);
    if (!before || before.type !== 'file') throw new Error(`${path} is not a stable regular file`);
    const hash = createHash('sha256');
    let byteLength = 0;
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.byteLength;
    }
    const after = rollbackStatIdentity(path);
    if (rollbackStatIdentitiesEqual(before, after) && byteLength === Number(after?.size)) {
      return { sha256: hash.digest('hex'), byteLength, statIdentity: after! };
    }
  }
  throw new Error(`${path} changed repeatedly while its content was hashed`);
}

export class RollbackContentStore {
  readonly root: string;

  constructor(runDirPath?: string) {
    this.root = runDirPath
      ? join(runDirPath, '.rollback-preimages')
      : mkdtempSync(join(tmpdir(), 'flowcrew-rollback-preimages-'));
    mkdirSync(this.root, { recursive: true });
  }

  capture(sourcePath: string, _logicalPath: string): RollbackCaptureResult {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = rollbackStatIdentity(sourcePath);
      if (!before || before.type !== 'file') throw new Error(`${sourcePath} is not a regular file`);
      const hashed = hashRollbackFileSync(sourcePath);
      const target = join(this.root, hashed.sha256);
      if (existsSync(target)) return { ...hashed, backingPath: target };
      try {
        // COPYFILE_FICLONE requests copy-on-write but portably falls back to a
        // kernel copy. Neither route retains the file in a JavaScript Buffer.
        copyFileSync(sourcePath, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
        const after = rollbackStatIdentity(sourcePath);
        if (!rollbackStatIdentitiesEqual(before, after)) {
          throw new Error(`${sourcePath} changed while its rollback preimage was captured`);
        }
        const copied = hashRollbackFileSync(target);
        if (copied.sha256 !== hashed.sha256 || copied.byteLength !== hashed.byteLength) {
          throw new Error(`${sourcePath} changed while its rollback preimage was captured`);
        }
        return { ...hashed, statIdentity: after!, backingPath: target };
      } catch (error) {
        lastError = error;
        try { unlinkSync(target); } catch { /* best effort */ }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`could not capture ${sourcePath}`);
  }

  cleanup(): void {
    if (!existsSync(this.root)) return;
    rmSync(this.root, { recursive: true, force: true });
  }
}
