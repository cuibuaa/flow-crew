import { z } from 'zod';

/** Shared campaign patch data; no campaign runtime or publication effects. */
export interface BriefPatch {
  type: 'brief_patch';
  section: string;
  op: 'append' | 'replace_value' | 'edit';
  value: string;
}

export const BriefPatchSchema = z.object({
  type: z.literal('brief_patch'),
  section: z.string().min(1),
  op: z.enum(['append', 'replace_value', 'edit']),
  value: z.string(),
});
