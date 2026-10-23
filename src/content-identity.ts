import { createHash } from 'node:crypto';
import { closeSync, openSync } from './engine-fs.js';
import { constants, fstatSync, lstatSync, readlinkSync, readSync } from 'node:fs';

export type ContentIdentity =
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string }
  | {
      state: 'present';
      type: 'file' | 'symlink' | 'directory';
      byteLength: number;
      sha256: string;
    };

export type ContentComparison = 'equal' | 'different' | 'unavailable';

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : '';
  return `${code}${error.message}`;
}

function hashRegularFile(path: string): ContentIdentity {
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor: number | undefined;
    try {
      // A pathname can become a link or FIFO after lstat. Never follow the
      // replacement or block waiting for a writer before verifying its type.
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(descriptor);
      if (!before.isFile()) return { state: 'unavailable', reason: 'path changed type while its content was read' };
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let byteLength = 0;
      while (true) {
        const count = readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        hash.update(chunk.subarray(0, count));
        byteLength += count;
      }
      const after = fstatSync(descriptor);
      if (before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs
        && byteLength === after.size) {
        return { state: 'present', type: 'file', byteLength, sha256: hash.digest('hex') };
      }
    } catch (error) {
      return { state: 'unavailable', reason: `could not read regular-file content: ${errorReason(error)}` };
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* the content result already captures the useful failure */ }
      }
    }
  }
  return { state: 'unavailable', reason: 'regular-file content changed during two consecutive reads' };
}

/** Metadata can nominate a path for inspection; only this identity proves a write. */
export function readContentIdentity(path: string): ContentIdentity {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unavailable', reason: `could not inspect path: ${errorReason(error)}` };
  }
  if (stat.isSymbolicLink()) {
    try {
      const bytes = readlinkSync(path, { encoding: 'buffer' });
      return {
        state: 'present',
        type: 'symlink',
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      return { state: 'unavailable', reason: `could not read symbolic-link target: ${errorReason(error)}` };
    }
  }
  if (!stat.isFile()) return { state: 'unavailable', reason: 'path is neither a regular file nor a symbolic link' };
  return hashRegularFile(path);
}

export function compareContentIdentities(
  before: ContentIdentity,
  after: ContentIdentity,
): ContentComparison {
  if (before.state === 'unavailable' || after.state === 'unavailable') return 'unavailable';
  if (before.state === 'absent' || after.state === 'absent') {
    return before.state === after.state ? 'equal' : 'different';
  }
  return before.type === after.type
    && before.byteLength === after.byteLength
    && before.sha256 === after.sha256
    ? 'equal'
    : 'different';
}
