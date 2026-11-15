import { z } from 'zod';
import type { EvidenceEntry } from './evidence-ledger.js';

/** Single owner of finding classes and their verdict effect. Schema, prompts,
 * settlement and archive repair projections use this policy, never prose. */
export const FINDING_CLASSES = {
  criterion_unmet: { rejects: true, criterionRequired: true,
    description: 'The change does not meet a brief criterion; name its canonical id in criterion_ids, mark each named criterion fail in this verdict, and supply evidence.' },
  regression: { rejects: true, criterionRequired: false,
    description: 'The change or its repairs break behavior the unchanged base had; supply evidence of the base/changed difference.' },
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
export const GATE_OUTCOMES = ['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable'] as const;
export type GateOutcome = typeof GATE_OUTCOMES[number];
export function gateAccepted(outcome: GateOutcome): boolean { return outcome === 'accepted' || outcome === 'accepted_blocked'; }
export const FINDING_POLICY_TEXT = 'Choose each finding class:\n'
  + Object.entries(FINDING_CLASSES).map(([name, policy]) => `- ${name} (${policy.rejects ? 'rejecting' : 'advisory'}): ${policy.description}`).join('\n')
  + '\nOwn one outcome: accepted, accepted_blocked, rejected_repairable, or rejected_irreparable. accepted_blocked requires the brief declaration allow_blocked_acceptance: true; it permits evidenced not_assessed criteria, never fail. accepted requires all criteria met or carried. A rejection requires a rejecting finding; acceptance permits only advisories. criterion_unmet must name canonical criteria marked fail in this verdict. Advisory findings never authorize repair. Do not invent task requirements. Independent evidence is required; the author’s word alone is not proof. Commands are optional evidence and are never automatically replayed. Consume configured validation from the engine record without rerunning it. Use rejected_irreparable when no available repair can meet the brief.';

/** Same-answer consistency, never an executable proof requirement. */
export function validateFindingVerdict(record: Record<string, unknown>, refs: string[],
  allowBlockedAcceptance = false): string | undefined {
  const outcome = typeof record.pass !== 'boolean' && GATE_OUTCOMES.includes(record.outcome as GateOutcome) ? record.outcome as GateOutcome : undefined;
  if (outcome === 'accepted_blocked' && !allowBlockedAcceptance)
    return 'GATE_OUTCOME_NOT_ALLOWED: accepted_blocked requires brief frontmatter allow_blocked_acceptance: true';
  const accepted = outcome ? gateAccepted(outcome) : record.pass === true;
  const criteria = record.criteria as Record<string, { status?: string }> | undefined;
  const unmet = refs.filter(ref => criteria?.[ref]?.status === 'fail' || outcome !== 'accepted_blocked' && criteria?.[ref]?.status === 'not_assessed');
  if (accepted && unmet.length) return `AUDIT_FINDINGS_INVALID: CRITERION_NOT_ACCEPTED: ${outcome ?? 'pass=true'} cannot accompany unaccepted assigned criteria: ${unmet.join(', ')}`;
  if (!outcome && record.audit_findings === undefined) return undefined; // Historical display only.
  const parsed = findingsSchema(refs).safeParse(record.audit_findings);
  if (!parsed.success) return `AUDIT_FINDINGS_INVALID: FINDING_SHAPE_INVALID: ${parsed.error.message}`;
  const rejecting = parsed.data.findings.some(findingRejects);
  if (accepted === rejecting) return 'AUDIT_FINDINGS_INVALID: PASS_CLASS_MISMATCH: outcome must agree with the declared finding classes';
  for (const finding of parsed.data.findings.filter(findingRejects)) {
    if (FINDING_CLASSES[finding.class].criterionRequired && finding.criterion_ids.some(id => criteria?.[id]?.status !== 'fail'))
      return `AUDIT_FINDINGS_INVALID: CRITERION_NOT_FAILED: ${finding.id} must name criteria marked fail in this verdict`;
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

/** Historical settled judgments stay intact; reading never invents command confirmation. */
export function projectLegacyFindings<T extends { reason?: string; findings?: FindingAssessment }>(verdict: T, rawFindings: unknown): T {
  if (verdict.findings) return verdict;
  const parsed = readArchivedAuditFindings(rawFindings);
  if (!parsed) return verdict;
  const findings: FindingAssessment = { confirmed: [], unconfirmed: parsed.filter(findingRejects),
    advisory: parsed.filter(finding => !findingRejects(finding)) as AuditFinding[] };
  return { ...verdict, findings, reason: `${verdict.reason ?? ''}${findings.unconfirmed.length
    ? ` Unconfirmed observations: ${findings.unconfirmed.map(finding => finding.id).join(', ')}; retained as historical observations.` : ''}` };
}
