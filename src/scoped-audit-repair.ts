import { z } from 'zod';
import type { EvidenceEntry } from './evidence-ledger.js';
import { isAbsolute } from 'node:path';

export const AuditFindingsSchema = z.object({
  version: z.literal(1),
  findings: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    // Evidence references describe findings; artifact declarations own authority.
    paths: z.array(z.string().trim().min(1)).min(1),
    reason: z.string().trim().min(1),
    criterion_ids: z.array(z.string().min(1)),
    invalidates_plan: z.boolean(),
    repair_role: z.string().min(1),
    reproduction: z.number().int().positive().nullable().optional(),
  }).strict()),
}).strict();


export type AuditFinding = z.infer<typeof AuditFindingsSchema>['findings'][number];
export type ReproductionRecord = EvidenceEntry & { kind: 'command' };
export interface FindingAssessment {
  confirmed: Array<AuditFinding & { record: ReproductionRecord }>;
  unconfirmed: AuditFinding[];
}

/** Historical settled judgments stay intact. Without a recorded assessment,
 * their authored observations cannot acquire repair authority on read. */
export function projectLegacyFindings<T extends { reason?: string; findings?: FindingAssessment }>(verdict: T, rawFindings: unknown): T {
  if (verdict.findings) return verdict;
  const parsed = AuditFindingsSchema.safeParse(rawFindings);
  if (!parsed.success) return verdict;
  const findings = { confirmed: [], unconfirmed: parsed.data.findings };
  return { ...verdict, findings, reason: `${verdict.reason ?? ''}${findings.unconfirmed.length
    ? ` Unconfirmed observations: ${findings.unconfirmed.map(finding => finding.id).join(', ')}; no repair requested for these.` : ''}` };
}
/** Confirmation is an engine fact, not a reading of finding prose. Only a
 * reviewer command on this unchanged tree can authorize product repair. */
export function assessFindings(findings: AuditFinding[], ledger: EvidenceEntry[],
  gate: { stageId: string; attemptIndex: number; treeHash: string | null }): FindingAssessment {
  const confirmed: FindingAssessment['confirmed'] = [], unconfirmed: AuditFinding[] = [];
  for (const finding of findings) {
    const record = ledger.find(entry => entry.sequence === finding.reproduction);
    if (record?.kind === 'command' && (record.owner === 'adapter-event' || record.owner === 'code') && record.reproductionOf === undefined && record.stageId === gate.stageId
        && record.attemptIndex === gate.attemptIndex && record.command && !record.unfinished && Number.isInteger(record.exitCode) && record.exitCode! > 0
        && record.context && typeof record.context.cwd === 'string' && isAbsolute(record.context.cwd)
        && typeof record.context.shell === 'string' && isAbsolute(record.context.shell)
        && record.outputDigest && record.treeHash && record.treeHash === gate.treeHash && record.treeAfterHash === record.treeHash) {
      confirmed.push({ ...finding, record });
    } else unconfirmed.push(finding);
  }
  return { confirmed, unconfirmed };
}
