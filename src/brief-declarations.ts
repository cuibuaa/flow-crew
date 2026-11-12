import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { ArtifactPathSchema } from './artifact-location.js';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import { normalizedProjectPath } from './scheduler/sched_admission/scope-services.js';

// Replaces recursive path/key guessing and Markdown criterion extraction.
const path = z.string().min(1).transform(value => value === '/' ? value : value.replace(/^\.\//, '').replace(/\/$/, ''));
// Replace silent runtime rebinding with agreement at the shared lexical boundary.
const projectPath = (value: string) => ArtifactPathSchema.safeParse(value).success && normalizedProjectPath(value) === value;
const inputPath = path.refine(projectPath, 'inputs.path must be a literal confined project-relative path');
const outputPath = path.refine(value => isAbsolute(value) ? value === value.trim() : projectPath(value), 'outputs.path must be a literal confined path');
export const BriefDeclarationsSchema = z.object({
  inputs: z.array(z.union([inputPath, z.object({ path: inputPath, frozen: z.boolean().optional(),
    type: z.enum(['file', 'directory']).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict()])).superRefine((inputs, context) => {
    const seen = new Map<string, { sha256?: string; type?: string }>();
    inputs.forEach((input, index) => {
      if (typeof input === 'string') return;
      const prior = seen.get(input.path);
      for (const field of ['sha256', 'type'] as const) {
        if (prior?.[field] !== undefined && input[field] !== undefined && prior[field] !== input[field]) {
          context.addIssue({ code: 'custom', path: [index, field], message: `Conflicting inputs.${field} declarations for ${input.path}` });
        }
      }
      seen.set(input.path, { ...prior, ...input });
    });
  }).optional(),
  outputs: z.array(z.union([outputPath, z.object({
    path: outputPath, type: z.enum(['file', 'directory']).optional(),
    on_existing: z.enum(['create', 'update', 'append', 'replace']).optional(),
  }).strict()])).optional(),
  criteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()).min(1)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'criteria IDs must be unique').optional(),
});
export type BriefDeclarations = z.infer<typeof BriefDeclarationsSchema>;

/** Other frontmatter contracts retain their own readers; these three fields
 * have exactly one schema. Unknown entry fields are errors, never aliases. */
export function parseBriefDeclarations(brief: string): BriefDeclarations {
  const document = parseBriefFrontmatterDocument(brief);
  if (!document) return {};
  if (document.error) throw new Error(document.error);
  if (document.value === null) return {};
  if (!document.value || typeof document.value !== 'object' || Array.isArray(document.value)) {
    throw new Error('frontmatter must be a YAML mapping/object');
  }
  const root = document.value as Record<string, unknown>;
  return BriefDeclarationsSchema.parse(Object.fromEntries(
    ['inputs', 'outputs', 'criteria'].filter(key => Object.hasOwn(root, key)).map(key => [key, root[key]]),
  ));
}
