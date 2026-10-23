import { z } from 'zod';

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
  }).strict()),
}).strict();

