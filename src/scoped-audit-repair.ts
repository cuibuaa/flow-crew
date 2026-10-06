import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArtifactContractSchema, ArtifactPathSchema } from './artifact-declarations.js';
import type { StageConfig } from './scheduler.js';

export const AuditFindingsSchema = z.object({
  version: z.literal(1),
  findings: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    paths: z.array(ArtifactPathSchema).min(1),
    reason: z.string().trim().min(1),
    criterion_ids: z.array(z.string().min(1)),
    invalidates_plan: z.boolean(),
    repair_role: z.string().min(1),
  }).strict()),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    if (ids.has(finding.id) || new Set(finding.paths).size !== finding.paths.length) context.addIssue({ code: 'custom', path: ['findings', index], message: 'finding IDs and paths must be unique' });
    ids.add(finding.id);
  }
});
export type AuditFinding = z.infer<typeof AuditFindingsSchema>['findings'][number];

/** Only exact project files; generated repairs receive no broader scope than the named finding. */
export function buildScopedRepair(gate: StageConfig, finding: AuditFinding): StageConfig {
  if (finding.invalidates_plan) throw new Error('SCOPED_REPAIR_PLAN_LEVEL: finding requires planning, not a local repair');
  if (finding.criterion_ids.some((id) => !gate.criterion_refs.includes(id))) throw new Error('SCOPED_REPAIR_CRITERION_UNBOUND: finding criteria must belong to the authoring gate');
  const digest = createHash('sha256').update(JSON.stringify({ gate: gate.id, finding })).digest('hex');
  return {
    id: `repair_${digest.slice(0, 13)}`, role: finding.repair_role,
    scope: [...finding.paths], depends_on: [gate.id], dependency_reasons: { [gate.id]: `Repair scoped finding ${finding.id} from this gate` },
    prompt_template: `Repair audit finding ${finding.id} only within these project files: ${JSON.stringify(finding.paths)}.\nReason: ${finding.reason}\nRead the retained rejected verdict and audit evidence for ${gate.id}. Produce fresh corrected files, verify the repair, and return to that gate. Do not broaden the task or write outside the declared scope.`,
    skills: [], criterion_refs: [...finding.criterion_ids], is_gate: false, dynamic_dispatch: false, retry_to: [gate.id],
    artifact_contract: ArtifactContractSchema.parse({ version: 1, reads: [], replays: [], produces: finding.paths.map((path, index) => ({ id: `repaired_${index}`, root: 'project', path })) }),
  };
}
