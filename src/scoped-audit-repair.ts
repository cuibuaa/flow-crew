import { z } from 'zod';
import { ArtifactPathSchema } from './artifact-declarations.js';

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

