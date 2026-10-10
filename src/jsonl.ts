import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';

/** Owned append position. Replacement and truncation restart the reader. */
export interface JsonlReadCursor {
  offset: number;
  identity?: string;
}

export interface JsonlReadDiagnostics<T> {
  rows: T[];
  unreadableRecords: number;
}

/**
 * Read an append-only JSONL file without discarding valid history when one row
 * is malformed or a crash truncates the final append. File-system errors are
 * deliberately left to the caller because each owning subsystem has its own
 * missing/unreadable-file policy.
 */
export function readJsonlFileWithDiagnostics<T>(path: string, cursor?: JsonlReadCursor): JsonlReadDiagnostics<T> {
  let raw: string;
  if (!cursor) raw = readFileSync(path, 'utf-8');
  else {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}`;
      const size = Number(stat.size);
      if (cursor.identity !== identity || cursor.offset > size) cursor.offset = 0;
      cursor.identity = identity;
      const bytes = Buffer.alloc(size - cursor.offset);
      let count = 0;
      while (count < bytes.length) {
        const received = readSync(fd, bytes, count, bytes.length - count, cursor.offset + count);
        if (!received) break;
        count += received;
      }
      // An incomplete append (including a partial UTF-8 character) stays unread.
      const end = bytes.subarray(0, count).lastIndexOf(10) + 1;
      raw = bytes.subarray(0, end).toString('utf-8');
      cursor.offset += end;
    } finally { closeSync(fd); }
  }
  const rows: T[] = [];
  let unreadableRecords = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // Append-only logs may contain a torn row; later valid rows still count.
      unreadableRecords += 1;
    }
  }
  return { rows, unreadableRecords };
}

export function readJsonlFile<T>(path: string, cursor?: JsonlReadCursor): T[] {
  return readJsonlFileWithDiagnostics<T>(path, cursor).rows;
}

/** Optional carriers use the same parser while preserving read errors. */
export function readOptionalJsonlFile<T>(path: string): T[] {
  return existsSync(path) ? readJsonlFile<T>(path) : [];
}
