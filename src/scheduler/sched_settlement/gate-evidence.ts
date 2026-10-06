// Boundary: Contradictory verdict fields and per-criterion evidence validation using admitted assignments; no execution or publication.
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRADICTORY_REJECT_OUTCOMES = new Set([
  'fail', 'failed', 'reject', 'rejected', 'repair_required', 'requires_repair',
  'reject_repair_required', 'rejected_repair_required',
]);

export function structuredGateRejection(record: Record<string, unknown>): string | undefined {
  if (record.repair_required === true || record.requires_repair === true) {
    return 'repair_required=true';
  }
  const rawOutcome = typeof record.outcome === 'string'
    ? record.outcome
    : typeof record.status === 'string'
      ? record.status
      : undefined;
  if (rawOutcome) {
    const normalized = rawOutcome.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (CONTRADICTORY_REJECT_OUTCOMES.has(normalized)) return `outcome=${rawOutcome}`;
  }
  const nextPhase = typeof record.nextPhase === 'string'
    ? record.nextPhase
    : typeof record.next_phase === 'string'
      ? record.next_phase
      : undefined;
  if (nextPhase && /^(?:repair|fix|rework)(?:_|\b)/i.test(nextPhase.trim())) {
    return `nextPhase=${nextPhase}`;
  }
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const explicitlyNegated = /\b(?:no|not|without)\s+(?:further\s+)?(?:repair|repairs)\s+(?:is\s+|are\s+)?required\b/i.test(reason)
    || /\brepair\s+(?:is\s+)?not\s+required\b/i.test(reason);
  if (!explicitlyNegated && /\b(?:repair\s+(?:is\s+)?required|requires?\s+(?:a\s+)?repair|needs?\s+(?:a\s+)?repair|must\s+be\s+repaired)\b/i.test(reason)) {
    return `reason=${reason}`;
  }
  return undefined;
}

export function explicitPassContradiction(
  record: Record<string, unknown>,
  source: 'verdict' | 'metric.json',
  effectivePass = record.pass === true,
): string | undefined {
  if (!effectivePass) return undefined;
  const rejection = structuredGateRejection(record);
  return rejection
    ? `Gate verdict contradiction: pass=true cannot accompany ${source} ${rejection}`
    : undefined;
}

export function assignedGateCriterionRefs(base: string, stageId: string): string[] {
  try {
    const admission = JSON.parse(readFileSync(join(base, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
    return admission.criterionGateRefs?.[stageId] ?? [];
  } catch {
    return [];
  }
}

export function validateGateCriterionEvidence(
  base: string,
  stageId: string,
  verdict: Record<string, unknown>,
): string | undefined {
  const refs = assignedGateCriterionRefs(base, stageId);
  if (refs.length === 0) return undefined;
  const criteria = verdict.criteria;
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return `Gate criterion contract violation: missing criteria evidence map for ${refs.join(', ')}`;
  }
  const evidenceMap = criteria as Record<string, unknown>;
  for (const ref of refs) {
    const entry = evidenceMap[ref];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `Gate criterion contract violation: missing evidence for ${ref}`;
    }
    const record = entry as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
    const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : '';
    if (!['pass', 'fail', 'judgement'].includes(status) || !evidence) {
      return `Gate criterion contract violation: ${ref} needs status pass|fail|judgement and non-empty evidence`;
    }
    if (verdict.pass === true && status === 'fail') {
      return `Gate criterion contract violation: pass=true conflicts with failed criterion ${ref}`;
    }
  }
  return undefined;
}

/** Select an authored boolean-pass verdict; recorded shared carriers remain readable. */
export function readWrittenGateVerdict(base: string, stageId: string, allowSharedFallback = true): Record<string, unknown> | null {
  const files = [`verdict_${stageId}.json`, ...(allowSharedFallback ? ['verdict.json'] : [])];
  for (const file of files) {
    try {
      const candidate = JSON.parse(readFileSync(join(base, file), 'utf-8')) as Record<string, unknown>;
      if (typeof candidate.pass === 'boolean') return candidate;
    } catch { /* optional, malformed and legacy carriers fall through in order */ }
  }
  return null;
}
