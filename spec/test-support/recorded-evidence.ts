import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

interface RecordedEvidenceRow {
  byteLength: number;
  sha256: string;
  gzipBase64: string;
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

/** Return byte-identical, hash-checked review evidence embedded in the test corpus. */
export function recordedEvidence(id: string): Buffer {
  const row = catalog.records[id];
  if (!row || catalog.version !== 1 || catalog.encoding !== 'gzip+base64') {
    throw new Error(`Unknown recorded evidence fixture: ${id}`);
  }
  const bytes = gunzipSync(Buffer.from(row.gzipBase64, 'base64'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== row.byteLength || digest !== row.sha256) {
    throw new Error(`Recorded evidence fixture failed integrity check: ${id}`);
  }
  return bytes;
}
