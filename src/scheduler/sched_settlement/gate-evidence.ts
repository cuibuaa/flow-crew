// Boundary: Contradictory verdict fields and per-criterion evidence validation using admitted assignments; no execution or publication.
import { DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateVerdict, StageAttempt } from '../../store.js';
import { STAGE_STATUS } from '../../store.js';
import type { StageArtifactContractAudit } from '../../stage-artifact-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalRunDirectory } from '../../cancellation-policy.js';

const repairabilitySchema = z.object({
  version: z.literal(1),
  disposition: z.enum(['repairable', 'irreparable']),
  evidence: z.string().trim().min(1),
}).strict();
/** Terminality is an explicit verdict fact, never an inference from its prose. */
export function validateGateRepairability(record: Record<string, unknown>): string | undefined {
  if (!('repairability' in record)) return undefined;
  if (record.pass !== false || !repairabilitySchema.safeParse(record.repairability).success) {
    return 'Gate contract violation: repairability requires pass=false and exactly {version:1, disposition:"repairable"|"irreparable", evidence:"<non-empty reproducible evidence>"}; omit repairability for a legacy verdict';
  }
  return undefined;
}

export function projectGateVerdict(record: Record<string, unknown>): GateVerdict {
  return {
    pass: record.pass as boolean,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(!validateGateRepairability(record) && record.repairability
      ? { repairability: repairabilitySchema.parse(record.repairability) } : {}),
  };
}

/** Reuse the protected settlement receipt; a post-attempt edit grants no new authority. */
export function validateSettledGateVerdict(base: string, runId: string, stageId: string, attempt: StageAttempt | undefined, capturedDigest: string | undefined): string | undefined {
  try {
    const verdictPath = join(base, `verdict_${stageId}.json`);
    const audit = JSON.parse(readFileSync(join(base, 'stages', stageId, 'artifact_contract.json'), 'utf8')) as StageArtifactContractAudit;
    const production = audit.production;
    // Resume resolves the physical run directory; store readers may retain its
    // scratch alias. Authenticate the same location, execution and bytes.
    const observation = audit.observations?.find((entry) => canonicalRunDirectory(entry.path) === canonicalRunDirectory(verdictPath));
    if (attempt?.status === STAGE_STATUS.COMPLETE && attempt.completedAt && audit.stageId === stageId
        && production?.runId === runId && canonicalRunDirectory(production.runDir) === canonicalRunDirectory(base)
        && production.attemptIndex === attempt.index && production.attemptStartedAt === attempt.startedAt
        && !audit.completionDeferred && audit.violations.length === 0
        && observation?.fresh && observation.sha256 === capturedDigest
        && observation.sha256 === createHash('sha256').update(readFileSync(verdictPath)).digest('hex')) return undefined;
  } catch { /* missing or malformed receipt cannot authorize a terminal fact or revision */ }
  return 'Gate contract violation: terminal disposition or finding-derived repair requires the unchanged exact verdict and protected artifact receipt of the current settled gate execution; rerun the gate';
}

export function explicitPassContradiction(
  record: Record<string, unknown>,
  source: 'verdict',
  effectivePass = record.pass === true,
): string | undefined {
  if (!effectivePass) return undefined;
  const rejection = record.repair_required === true || record.requires_repair === true ? 'repair_required=true' : undefined;
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

/** One selected carrier owns the parsed bytes, source and identity. Projections
 * cannot manufacture receipt authority or pick another carrier mid-evaluation. */
export class GateVerdictDocument {
  readonly digest: string;
  readonly value: Record<string, unknown>;
  constructor(bytes: Buffer) {
    this.value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (typeof this.value.pass !== 'boolean') throw new Error('Gate verdict requires boolean pass');
    this.digest = createHash('sha256').update(bytes).digest('hex');
  }

  project(): GateVerdict { return projectGateVerdict(this.value); }
  refuse(reason: string): GateVerdict {
    return this.value.repairability ? { ...this.project(), pass: false, reason } : { pass: false, reason };
  }
}

/** Read the gate's authored verdict carrier. */
export function readGateVerdictDocument(base: string, stageId: string): GateVerdictDocument | null {
  const file = `verdict_${stageId}.json`;
  try { return new GateVerdictDocument(readFileSync(join(base, file))); }
  catch { return null; }
}
