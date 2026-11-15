import { z } from 'zod';
import type { EvidenceEntry } from './evidence-ledger.js';
import { isAbsolute } from 'node:path';

/** Single owner of finding classes and their verdict effect. Schema, prompts,
 * settlement and archive repair projections use this policy, never prose. */
export const FINDING_CLASSES = {
  criterion_unmet: { rejects: true, criterionRequired: true,
    description: 'The change does not meet a brief criterion; name its canonical id in criterion_ids, mark each named criterion fail in this verdict, and cite a failed engine-recorded reproduction.' },
  regression: { rejects: true, criterionRequired: false,
    description: 'The change or its repairs break behavior the unchanged base had; reproduce the base/changed difference and cite its failed engine-recorded command.' },
  advisory: { rejects: false, criterionRequired: false,
    description: 'Any other true, useful observation: pre-existing defects, unrequested hardening or style.' },
} as const;
export type FindingClass = keyof typeof FINDING_CLASSES;
const findingFields = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  paths: z.array(z.string().trim().min(1).regex(/\S/)).min(1),
  reason: z.string().trim().min(1).regex(/\S/),
  criterion_ids: z.array(z.string().min(1)),
  invalidates_plan: z.boolean(),
  repair_role: z.string().min(1).regex(/\S/),
  reproduction: z.number().int().positive().nullable().optional(),
}).strict();
export type AuditFinding = z.infer<typeof findingFields> & { class: FindingClass };
/** Historical classless findings retain their original rejecting semantics,
 * without being relabeled as a reproduced regression. Only archive readers use this type. */
export type RecordedAuditFinding = z.infer<typeof findingFields> & { class?: FindingClass };

function findingsSchema(refs?: string[], pass = false) {
  const variants = (Object.entries(FINDING_CLASSES) as Array<[FindingClass, typeof FINDING_CLASSES[FindingClass]]>)
    .filter(([, policy]) => !pass || !policy.rejects)
    .map(([name, policy]) => findingFields.extend({
      class: z.enum([name]),
      criterion_ids: z.array(refs ? z.enum(refs) : z.string().min(1)).min(policy.criterionRequired ? 1 : 0),
    }));
  return z.object({ version: z.literal(1), findings: z.array(z.union(variants)) }).strict();
}
export const AuditFindingsSchema = findingsSchema();
const ArchivedAuditFindingsSchema = z.object({ version: z.literal(1),
  findings: z.array(z.union([AuditFindingsSchema.shape.findings.element, findingFields])),
}).strict();
export function readArchivedAuditFindings(raw: unknown): RecordedAuditFinding[] | undefined {
  const parsed = ArchivedAuditFindingsSchema.safeParse(raw);
  return parsed.success ? parsed.data.findings : undefined;
}
export function findingRejects(finding: Pick<RecordedAuditFinding, 'class'>): boolean {
  return finding.class === undefined || FINDING_CLASSES[finding.class].rejects;
}
export function auditFindingsJsonSchema(refs: string[], pass = false): import('./reality-gate/checks/json-schema-match.js').Schema {
  const { $schema: _schema, ...schema } = z.toJSONSchema(findingsSchema(refs, pass), {
    override: ({ jsonSchema }) => {
      // The engine's existing JSON validator consumes enum rather than const.
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    },
  });
  return schema as import('./reality-gate/checks/json-schema-match.js').Schema;
}
export const FINDING_POLICY_TEXT = 'Choose each finding class:\n'
  + Object.entries(FINDING_CLASSES).map(([name, policy]) => `- ${name} (${policy.rejects ? 'rejecting' : 'advisory'}): ${policy.description}`).join('\n')
  + '\nDo not invent task requirements. Only rejecting findings make pass=false; pass=true may include advisory findings. A rejection must contain a rejecting finding. Advisory findings are retained for the operator and never become repair obligations. Every rejecting finding rests on a named brief criterion or a reproduced base/changed difference. Independent evidence is required; the author’s word alone is not proof. Read configured validation from the engine record: do not rerun it or request a base suite, and unfinished validation is not a rejection. A reproduction command exits 0 when the defect is absent and nonzero when present.';

/** Validate model declarations; never derive a class or override pass from text. */
export function validateFindingVerdict(record: Record<string, unknown>, refs: string[],
  evidence?: { ledger: EvidenceEntry[]; gate: { stageId: string; attemptIndex: number; treeHash: string | null } }): string | undefined {
  const criteria = record.criteria as Record<string, { status?: string }> | undefined;
  const unmet = refs.filter(ref => ['fail', 'not_assessed'].includes(criteria?.[ref]?.status ?? ''));
  if (record.pass === true && unmet.length) return `AUDIT_FINDINGS_INVALID: CRITERION_NOT_ACCEPTED: pass=true cannot accompany fail/not_assessed assigned criteria: ${unmet.join(', ')}`;
  // Historical verdicts may predate findings; current worker schemas require them.
  if (record.audit_findings === undefined) return undefined;
  const parsed = findingsSchema(refs).safeParse(record.audit_findings);
  if (!parsed.success) return `AUDIT_FINDINGS_INVALID: FINDING_SHAPE_INVALID: ${parsed.error.message}`;
  const rejecting = parsed.data.findings.some(findingRejects);
  if (record.pass === rejecting) return 'AUDIT_FINDINGS_INVALID: PASS_CLASS_MISMATCH: pass must agree with the declared finding classes';
  for (const finding of parsed.data.findings.filter(findingRejects)) {
    if (FINDING_CLASSES[finding.class].criterionRequired && finding.criterion_ids.some(id =>
      (record.criteria as Record<string, { status?: string }> | undefined)?.[id]?.status !== 'fail')) {
      return `AUDIT_FINDINGS_INVALID: CRITERION_NOT_FAILED: ${finding.id} must name criteria marked fail in this verdict`;
    }
    if (!evidence || !confirmedReproduction(finding, evidence.ledger, evidence.gate)) {
      return `AUDIT_FINDINGS_INVALID: FINDING_REPRODUCTION_REQUIRED: ${finding.id} must cite a failed engine-recorded reproduction on the reviewed tree; supply it or reclassify as advisory`;
    }
  }
  return undefined;
}
export type ReproductionRecord = EvidenceEntry & { kind: 'command' };
export interface FindingAssessment {
  confirmed: Array<RecordedAuditFinding & { record: ReproductionRecord }>;
  /** Historical records only; current rejecting findings are validated before publication. */
  unconfirmed: RecordedAuditFinding[];
  advisory?: AuditFinding[];
}

/** Historical settled judgments stay intact. Without a recorded assessment,
 * their authored observations cannot acquire repair authority on read. */
export function projectLegacyFindings<T extends { reason?: string; findings?: FindingAssessment }>(verdict: T, rawFindings: unknown): T {
  if (verdict.findings) return verdict;
  const parsed = readArchivedAuditFindings(rawFindings);
  if (!parsed) return verdict;
  const findings: FindingAssessment = { confirmed: [], unconfirmed: parsed.filter(findingRejects),
    advisory: parsed.filter(finding => !findingRejects(finding)) as AuditFinding[] };
  return { ...verdict, findings, reason: `${verdict.reason ?? ''}${findings.unconfirmed.length
    ? ` Unconfirmed observations: ${findings.unconfirmed.map(finding => finding.id).join(', ')}; no repair requested for these.` : ''}` };
}
/** Confirmation is an engine fact, not a reading of finding prose. Only a
 * rejecting class and a reviewer command on this unchanged tree authorize repair. */
export function assessFindings(findings: AuditFinding[], ledger: EvidenceEntry[],
  gate: { stageId: string; attemptIndex: number; treeHash: string | null }): FindingAssessment {
  const confirmed: FindingAssessment['confirmed'] = [], advisory: AuditFinding[] = [];
  for (const finding of findings) {
    if (!findingRejects(finding)) { advisory.push(finding); continue; }
    const record = confirmedReproduction(finding, ledger, gate);
    if (record) confirmed.push({ ...finding, record });
  }
  return { confirmed, unconfirmed: [], advisory };
}

function confirmedReproduction(finding: AuditFinding, ledger: EvidenceEntry[],
  gate: { stageId: string; attemptIndex: number; treeHash: string | null }): ReproductionRecord | undefined {
  const record = ledger.find(entry => entry.sequence === finding.reproduction);
  if (record?.kind === 'command' && (record.owner === 'adapter-event' || record.owner === 'code') && record.reproductionOf === undefined && record.stageId === gate.stageId
        && record.attemptIndex === gate.attemptIndex && record.command && !record.unfinished && Number.isInteger(record.exitCode) && record.exitCode! > 0
        && record.context && typeof record.context.cwd === 'string' && isAbsolute(record.context.cwd)
        && typeof record.context.shell === 'string' && isAbsolute(record.context.shell)
        && record.outputDigest && record.treeHash && record.treeHash === gate.treeHash && record.treeAfterHash === record.treeHash) {
    return record;
  }
  return undefined;
}

/** Replay and gate settlement share the same receipt acceptance rule. */
export function repairReproductionClosed(sequence: number, ledger: EvidenceEntry[], treeHash: string | null,
  accepted: EvidenceEntry[] = []): boolean {
  const original = ledger.find(entry => entry.sequence === sequence);
  const closure = ledger.filter(entry => entry.kind === 'command' && entry.reproductionOf === sequence).at(-1);
  return original?.kind === 'command' && !!original.context && closure?.kind === 'command' && closure.owner === 'code'
    && !closure.unfinished && closure.exitCode === 0 && !!closure.outputDigest && !!treeHash && !!closure.treeHash && closure.treeAfterHash === closure.treeHash
    && (closure.treeHash === treeHash || accepted.some(entry => entry.kind === 'attempt' && entry.sequence > closure.sequence && entry.treeHash === closure.treeHash))
    && closure.command === original.command && closure.context?.cwd === original.context.cwd && closure.context?.shell === original.context.shell;
}
