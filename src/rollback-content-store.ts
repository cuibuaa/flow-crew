import { closeSync, openSync } from './engine-fs.js';
import { fstatSync, readSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';

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
