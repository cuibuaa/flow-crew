/** Shared closed read declaration, independent of the execution/store graph. */
import { z } from 'zod';
import { ArtifactPathSchema } from './artifact-location.js';
export const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const location = z.object({ root: z.enum(['project', 'run']), path: ArtifactPathSchema });
export const when = z.object({
  stage: id,
  field: z.enum(['status', 'exitCode']),
  equals: z.union([z.string(), z.number().int()]),
}).strict();
export const ArtifactReadSchema = location.extend({
  id,
  kind: z.enum(['file', 'directory']).default('file'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('stage'), stage: id, artifact: id }).strict(),
    z.object({ kind: z.literal('input') }).strict(),
    z.object({ kind: z.literal('framework'), artifact: z.enum(['task_brief', 'run_state']) }).strict(),
  ]),
  when: when.optional(),
}).strict();
