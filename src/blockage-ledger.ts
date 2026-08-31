import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BlockageOccurrence {
  fingerprint: string;
  kind: string;
  detail: string;
  stageId?: string;
  evidenceDigest?: string;
  repairDigest?: string;
  consecutive: number;
  total: number;
  firstSeenAt: string;
  lastSeenAt: string;
  escalatedAt?: string;
}

interface BlockageLedger {
  version: 1;
  currentFingerprint?: string;
  occurrences: Record<string, BlockageOccurrence>;
}

function canonicalDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ').toLowerCase();
}

function fingerprint(
  kind: string,
  detail: string,
  stageId?: string,
  evidenceDigest?: string,
  repairDigest?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: canonicalDetail(kind),
      stageId: stageId ?? '',
      cause: canonicalDetail(detail),
      evidenceDigest: evidenceDigest ?? '',
      repairDigest: repairDigest ?? '',
    }), 'utf8')
    .digest('hex');
}

function readLedger(path: string): BlockageLedger {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BlockageLedger;
    if (parsed.version === 1 && parsed.occurrences && typeof parsed.occurrences === 'object') return parsed;
  } catch { /* initialize below */ }
  return { version: 1, occurrences: {} };
}

function writeAtomic(path: string, value: BlockageLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

/** Count a stable, identical blockage across attempts/iterations. The third
 * consecutive observation is a mechanical escalation fact; callers decide
 * which terminal/finalizer route is in scope. */
export function recordBlockageOccurrence(input: {
  runDir: string;
  kind: string;
  detail: string;
  stageId?: string;
  /** Digest of the rejected artifact/evidence. A changed artifact starts a new streak. */
  evidenceDigest?: string;
  /** Digest of the relevant repair diff. A meaningful repair starts a new streak. */
  repairDigest?: string;
  now?: string;
  threshold?: number;
}): { occurrence: BlockageOccurrence; escalatedNow: boolean } {
  const path = join(input.runDir, 'blockage_ledger.json');
  const ledger = existsSync(path) ? readLedger(path) : { version: 1 as const, occurrences: {} };
  const id = fingerprint(
    input.kind,
    input.detail,
    input.stageId,
    input.evidenceDigest,
    input.repairDigest,
  );
  const now = input.now ?? new Date().toISOString();
  const previous = ledger.occurrences[id];
  const consecutive = ledger.currentFingerprint === id ? (previous?.consecutive ?? 0) + 1 : 1;
  const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
  const escalatedNow = consecutive >= threshold && !previous?.escalatedAt;
  const occurrence: BlockageOccurrence = {
    fingerprint: id,
    kind: input.kind,
    detail: input.detail,
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}),
    ...(input.repairDigest ? { repairDigest: input.repairDigest } : {}),
    consecutive,
    total: (previous?.total ?? 0) + 1,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    ...(previous?.escalatedAt ? { escalatedAt: previous.escalatedAt } : escalatedNow ? { escalatedAt: now } : {}),
  };
  ledger.currentFingerprint = id;
  ledger.occurrences[id] = occurrence;
  writeAtomic(path, ledger);
  return { occurrence, escalatedNow };
}
