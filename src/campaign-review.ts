import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { BriefPatch } from './campaign.js';

const BriefPatchSchema = z.object({
  type: z.literal('brief_patch'),
  section: z.string().min(1),
  op: z.enum(['append', 'replace_value', 'edit']),
  value: z.string(),
});

export interface PendingReviewEntry {
  ts: string;
  campaignId: string;
  reason: string;
  severity?: 'low' | 'medium' | 'high';
  patch: BriefPatch;
  source?: string;
  briefDir?: string;
  briefVersion?: string;
  rule?: string;
  runId?: string;
}

export interface ReviewDecisionResult {
  entry: PendingReviewEntry;
  remaining: number;
  version?: string;
}

export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewConflictError';
  }
}

function campaignRoot(): string {
  return join(homedir(), '.fc', 'campaigns');
}

function safeId(id: string): boolean {
  return !!id && !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

export function campaignReviewDir(campaignId: string): string {
  if (!safeId(campaignId)) throw new Error(`Unsafe campaign id: ${campaignId}`);
  return join(campaignRoot(), campaignId);
}

export function pendingReviewPath(campaignId: string): string {
  return join(campaignReviewDir(campaignId), 'pending_review.jsonl');
}

export function rejectedReviewPath(campaignId: string): string {
  return join(campaignReviewDir(campaignId), 'rejected_review.jsonl');
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as unknown); } catch { /* skip malformed review entries */ }
  }
  return out;
}

function normalizeEntry(raw: unknown, campaignId: string): PendingReviewEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const patchRaw = data.patch ?? data.proposedPatch;
  const parsed = BriefPatchSchema.safeParse(patchRaw);
  if (!parsed.success) return null;
  const severity = data.severity === 'low' || data.severity === 'medium' || data.severity === 'high'
    ? data.severity
    : undefined;
  return {
    ts: typeof data.ts === 'string' ? data.ts : typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    campaignId: typeof data.campaignId === 'string' ? data.campaignId : campaignId,
    reason: typeof data.reason === 'string' ? data.reason : 'No reason provided',
    severity,
    patch: parsed.data,
    source: typeof data.source === 'string' ? data.source : undefined,
    briefDir: typeof data.briefDir === 'string' ? data.briefDir : undefined,
    briefVersion: typeof data.briefVersion === 'string' ? data.briefVersion : undefined,
    rule: typeof data.rule === 'string' ? data.rule : undefined,
    runId: typeof data.runId === 'string' ? data.runId : undefined,
  };
}

export function readPendingReviews(campaignId: string): PendingReviewEntry[] {
  return readJsonl(pendingReviewPath(campaignId))
    .map((entry) => normalizeEntry(entry, campaignId))
    .filter((entry): entry is PendingReviewEntry => !!entry);
}

export function appendPendingReview(campaignId: string, entry: Omit<PendingReviewEntry, 'ts' | 'campaignId'> & { ts?: string; campaignId?: string }): void {
  const dir = campaignReviewDir(campaignId);
  mkdirSync(dir, { recursive: true });
  const full: PendingReviewEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    campaignId,
    reason: entry.reason,
    severity: entry.severity,
    patch: entry.patch,
    source: entry.source,
    briefDir: entry.briefDir,
    briefVersion: entry.briefVersion,
    rule: entry.rule,
    runId: entry.runId,
  };
  writeFileSync(pendingReviewPath(campaignId), JSON.stringify(full) + '\n', { encoding: 'utf-8', flag: 'a' });
}

function writePendingReviews(campaignId: string, entries: PendingReviewEntry[]): void {
  const path = pendingReviewPath(campaignId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf-8');
  renameSync(tmp, path);
}

function readStateBriefDir(campaignId: string): string | undefined {
  for (const file of ['state.json', 'active.json', 'summary.json']) {
    try {
      const raw = JSON.parse(readFileSync(join(campaignReviewDir(campaignId), file), 'utf-8')) as Record<string, unknown>;
      const direct = raw.briefDir ?? raw.brief_dir;
      if (typeof direct === 'string' && direct.trim()) return direct;
      const config = raw.config;
      if (config && typeof config === 'object') {
        const fromConfig = (config as Record<string, unknown>).briefDir ?? (config as Record<string, unknown>).brief_dir;
        if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig;
      }
    } catch { /* try next state file */ }
  }
  return undefined;
}

export function summarizePatch(patch: BriefPatch): string {
  const value = patch.value.length > 80 ? `${patch.value.slice(0, 77)}...` : patch.value;
  return `${patch.op} ${patch.section}: ${value}`;
}

export async function consumePendingReview(
  campaignId: string,
  index: number,
  decision: 'accept' | 'reject',
): Promise<ReviewDecisionResult> {
  const entries = readPendingReviews(campaignId);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new ReviewConflictError(`Pending review index is no longer available: ${index}`);
  }
  const [entry] = entries.splice(index, 1);
  writePendingReviews(campaignId, entries);

  if (decision === 'reject') {
    writeFileSync(
      rejectedReviewPath(campaignId),
      JSON.stringify({ ...entry, rejectedAt: new Date().toISOString() }) + '\n',
      { encoding: 'utf-8', flag: 'a' },
    );
    return { entry, remaining: entries.length };
  }

  const briefDir = entry.briefDir ?? readStateBriefDir(campaignId);
  if (!briefDir) throw new Error(`No briefDir recorded for pending review ${index}`);
  const { applyVersionedPatch } = await import('./campaign.js');
  const next = applyVersionedPatch(briefDir, entry.patch, entry.reason);
  return { entry, remaining: entries.length, version: next.version };
}
