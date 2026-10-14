import { z } from 'zod';
import { ArtifactPathSchema } from './artifact-location.js';

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
}).strict();
export type AuditFinding = z.infer<typeof AuditFindingsSchema>['findings'][number];

