/** Live declaration shapes shared by admission and the injected plan schema. No execution/store dependencies. */
import { z } from 'zod';
import { ArtifactPathSchema } from './artifact-location.js';
const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const location = z.object({ root: z.enum(['project', 'run']), path: ArtifactPathSchema });
const when = z.object({
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

const produced = location.extend({
  id,
  kind: z.enum(['file', 'directory']).default('file'),
  nonempty: z.boolean().default(false),
  when: when.optional(),
}).strict();
export const ArtifactContractSchema = z.object({
  version: z.literal(1),
  produces: z.array(produced),
  reads: z.array(ArtifactReadSchema),
  groups: z.array(z.object({ id, mode: z.literal('exactly_one'), members: z.array(id).min(2) }).strict()).default([]),
}).strict().superRefine((contract, context) => {
  const ids = new Set<string>();
  for (const artifact of [...contract.produces, ...contract.reads]) {
    if (ids.has(artifact.id)) context.addIssue({ code: 'custom', path: ['artifacts', `${artifact.root}:${artifact.path}`, 'id'], message: 'artifact IDs must be unique within this stage' });
    ids.add(artifact.id);
  }
  const paths = new Set<string>();
  for (const artifact of contract.produces) {
    const path = `${artifact.root}:${artifact.path}`;
    if (paths.has(path)) context.addIssue({ code: 'custom', path: ['produces', path, 'path'], message: 'produced locations must be unique within this stage' });
    paths.add(path);
  }
  const grouped = new Set<string>();
  const groupIds = new Set<string>();
  for (const group of contract.groups) {
    if (groupIds.has(group.id)) context.addIssue({ code: 'custom', path: ['groups', group.id, 'id'], message: 'group IDs must be unique' });
    groupIds.add(group.id);
    for (const member of group.members) {
      const artifact = contract.produces.find((entry) => entry.id === member);
      if (!artifact || artifact.when || grouped.has(member)) context.addIssue({ code: 'custom', path: ['groups', group.id, 'members', member], message: `group member ${member} must name one unconditional produced artifact and occur in only one group` });
      grouped.add(member);
    }
  }
});

export const StageFields = z.object({
  id,
  role: z.string().min(1),
  depends_on: z.array(z.string()).optional().default([]),
  /** Optional work-division note, passed to the stage unchanged. */
  scope: z.array(z.string()).optional(),
  /** Optional historical dependency prose; graph edges carry execution order. */
  dependency_reasons: z.record(z.string(), z.string()).optional(),
  condition: z.string().optional(),
  prompt_template: z.string().optional().default(''),
  max_retries: z.number().optional(),
  skills: z.array(z.string()).optional().default([]),
  dynamic_dispatch: z.boolean().optional().default(false),
  is_gate: z.boolean().optional().default(false),
  retry_to: z.array(z.string()).optional(),
  /** Declared run-time edges. continue releases ordinary dependencies; replan retains this iteration. */
  decision: z.object({
    successors: z.array(z.string().min(1)).min(1), default: z.string().min(1),
    kind: z.literal('successor').optional(),
  }).strict().refine(value => value.successors.includes(value.default), 'default must be a declared successor').optional(),
  /** Canonical IDs from the run-local brief_criteria.json artifact. */
  criterion_refs: z.array(z.string()).optional().default([]),
  /** Versioned exact outputs and reads; an explicit empty contract is meaningful. */
  artifact_contract: ArtifactContractSchema.optional(),
});

const seconds = z.number().finite().min(0.001).max((2 ** 31 - 1) / 1000);
// JSON schema is a closed recursive language; only properties/enum carry user keys/data.
const jsonType = z.enum(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const inlineSchema: z.ZodType<import('./reality-gate/checks/json-schema-match.js').Schema> = z.lazy(() => z.object({
  anyOf: z.array(inlineSchema).min(1).optional(), type: z.union([jsonType, z.array(jsonType).min(1)]).optional(),
  required: z.array(z.string()).optional(), additionalProperties: z.union([z.boolean(), inlineSchema]).optional(),
  pattern: z.string().refine(v => { try { new RegExp(v); return true; } catch { return false; } }, 'invalid regular expression').meta({ format: 'regex' }).optional(),
  minLength: z.number().int().nonnegative().optional(), minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(), uniqueItems: z.boolean().optional(),
  properties: z.record(z.string(), inlineSchema).optional(), items: inlineSchema.optional(), enum: z.array(z.json()).optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
}).strict());
const checkFields = { name: z.string().min(1), reads: z.array(z.lazy(() => ArtifactReadSchema)), advisory: z.boolean().optional() };
export const BriefRealityCheckSchema = z.discriminatedUnion('type', [
  z.object({ ...checkFields, type: z.literal('exec-script-exit-zero'), params: z.object({
    script: z.string().min(1), args: z.array(z.string()).optional(), timeout_seconds: seconds.min(1).optional(),
  }).strict() }).strict(),
  z.object({ ...checkFields, type: z.literal('file-exists-nonempty'), params: z.object({
    paths: z.union([z.array(z.string().min(1)).min(1), z.object({ from_manifest: z.string().min(1), field: z.string().min(1) }).strict()]),
  }).strict() }).strict(),
  z.object({ ...checkFields, type: z.literal('json-schema-match'), params: z.object({ file: z.string().min(1),
    schema: z.union([z.object({ file: z.string().min(1) }).strict(), inlineSchema]),
  }).strict() }).strict(),
]);
