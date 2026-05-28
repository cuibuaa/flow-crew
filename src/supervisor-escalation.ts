import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BriefPatch } from './campaign.js';
import { runsRoot } from './store.js';

const BriefPatchSchema = z.object({
  type: z.literal('brief_patch'),
  section: z.string().min(1),
  op: z.enum(['append', 'replace_value', 'edit']),
  value: z.string(),
});

const CampaignRevisionRequestSchema = z.object({
  ts: z.string().optional(),
  timestamp: z.string().optional(),
  runId: z.string().optional(),
  run_id: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  reason: z.string().min(1),
  proposedPatch: BriefPatchSchema.optional(),
  proposed_patch: BriefPatchSchema.optional(),
});

export interface CampaignRevisionRequest {
  ts: string;
  runId: string;
  severity: 'low' | 'medium' | 'high';
  reason: string;
  proposedPatch?: BriefPatch;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as unknown); } catch { /* skip malformed escalation lines */ }
  }
  return out;
}

export function readEscalations(runDir: string): CampaignRevisionRequest[] {
  const file = join(runDir, 'campaign_revision_request.jsonl');
  const out: CampaignRevisionRequest[] = [];
  for (const raw of readJsonl(file)) {
    const parsed = CampaignRevisionRequestSchema.safeParse(raw);
    if (!parsed.success) continue;
    out.push({
        ts: parsed.data.ts ?? parsed.data.timestamp ?? new Date().toISOString(),
        runId: parsed.data.runId ?? parsed.data.run_id ?? '',
        severity: parsed.data.severity,
        reason: parsed.data.reason,
        proposedPatch: parsed.data.proposedPatch ?? parsed.data.proposed_patch,
    });
  }
  return out;
}

function runIdFromIteration(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const data = entry as Record<string, unknown>;
  const direct = data.runId ?? data.run_id;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const outcome = data.outcome;
  if (outcome && typeof outcome === 'object') {
    const nested = (outcome as Record<string, unknown>).runId ?? (outcome as Record<string, unknown>).run_id;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return undefined;
}

function runDirFromIteration(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const data = entry as Record<string, unknown>;
  const direct = data.runDir ?? data.run_dir;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const outcome = data.outcome;
  if (outcome && typeof outcome === 'object') {
    const nested = (outcome as Record<string, unknown>).runDir ?? (outcome as Record<string, unknown>).run_dir;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return undefined;
}

export function aggregateAcrossRuns(campaignDir: string): CampaignRevisionRequest[] {
  const logPath = join(campaignDir, 'iteration_log.jsonl');
  const out: CampaignRevisionRequest[] = [];
  const seen = new Set<string>();
  for (const entry of readJsonl(logPath)) {
    const id = runIdFromIteration(entry);
    const dir = runDirFromIteration(entry) ?? (id ? join(runsRoot(), id) : undefined);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const request of readEscalations(dir)) {
      out.push({ ...request, runId: request.runId || id || '' });
    }
  }
  return out;
}
