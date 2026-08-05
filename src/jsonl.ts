import { readFileSync } from 'node:fs';

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
export function readJsonlFileWithDiagnostics<T>(path: string): JsonlReadDiagnostics<T> {
  const raw = readFileSync(path, 'utf-8');
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

export function readJsonlFile<T>(path: string): T[] {
  return readJsonlFileWithDiagnostics<T>(path).rows;
}
