import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface RecordedEvidenceRow {
  byteLength: number;
  sha256: string;
  text: string;
}

interface RecordedEvidenceCatalog {
  version: number;
  encoding: string;
  records: Record<string, RecordedEvidenceRow>;
}

const catalog = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'ux-perf-recorded-evidence.json'),
  'utf-8',
)) as RecordedEvidenceCatalog;

/** Return hash-checked evidence kept as plain text so the tracked-text privacy guard can inspect it. */
export function recordedEvidence(id: string): Buffer {
  const row = catalog.records[id];
  if (!row || catalog.version !== 1 || catalog.encoding !== 'utf8') {
    throw new Error(`Unknown recorded evidence fixture: ${id}`);
  }
  const bytes = Buffer.from(row.text, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== row.byteLength || digest !== row.sha256) {
    throw new Error(`Recorded evidence fixture failed integrity check: ${id}`);
  }
  return bytes;
}
