import { z } from 'zod';
import { ResearchInstrumentSchema } from './research-instrument.js';
import { TERMINAL_STATUSES } from './lifecycle-status.js';
import { ArtifactReadSchema } from './artifact-read-schema.js';
import { isAbsolute } from 'node:path';
import { ArtifactPathSchema } from './artifact-location.js';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import { normalizedProjectPath } from './scheduler/sched_admission/scope-services.js';

// Replaces recursive path/key guessing and Markdown criterion extraction.
const path = z.string().min(1).transform(value => value === '/' ? value : value.replace(/^\.\//, '').replace(/\/$/, ''));
// Replace silent runtime rebinding with agreement at the shared lexical boundary.
const projectPath = (value: string) => ArtifactPathSchema.safeParse(value).success && normalizedProjectPath(value) === value;
const inputPath = path.refine(projectPath, 'inputs.path must be a literal confined project-relative path');
const hasControlCharacters = (value: string) => [...value].some(character => {
  const code = character.codePointAt(0)!;
  return code <= 0x1f || code >= 0x7f && code <= 0x9f;
});
const outputPath = path.refine(value => isAbsolute(value)
  ? value === value.trim() && !/[\\$*?{}[\]<>]/.test(value) && !hasControlCharacters(value)
    && !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..')
  : projectPath(value), 'outputs.path must be a literal confined path');
export const argument = z.string().refine(value => !hasControlCharacters(value), 'must not contain a control character');
export const commandDeclaration = z.object({
  command: argument.refine(value => value.trim().length > 0, 'must be a non-empty string'),
  args: z.array(argument),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), argument).optional(),
  report: z.object({ format: z.literal('vitest-json'), path: argument.refine(value => value.length > 0
    && !isAbsolute(value) && !value.split('/').includes('..'), 'must be a project-relative file').optional() }).strict().optional(),
}).strict();
export const commandsDeclaration = z.object({ commands: z.object({
  build: commandDeclaration.optional(), test: commandDeclaration.optional(), lint: commandDeclaration.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'must declare at least one role') }).strict();
// A brief and the project's declaration file state limits alike; a brief's replace the project's field by field.
// The timeout bound is the largest delay a timer can carry. A brief may state limits alone.
export const limitFields = {
  timeoutMs: z.number().int().positive().max(2 ** 31 - 1).optional(),
  attempts: z.number().int().positive().optional(),
};
export const validationDeclaration = commandsDeclaration.extend({ commands: commandsDeclaration.shape.commands.optional(), ...limitFields });

/** The wire schema version is recorded at admission, never guessed from files. */
export const BRIEF_DECLARATION_VERSION = 1 as const;
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().finite().min(0.001).max((2 ** 31 - 1) / 1000);
const terminalObject = z.object({
  paths: z.array(inputPath).min(1),
  floor: z.object({ min_attempted_stages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    min_wall_minutes: z.number().finite().nonnegative().optional() }).strict().optional(),
  stage_glob: z.string().min(1).refine(v => !isAbsolute(v) && !v.split('/').includes('..')).optional(),
  post_terminate_hook: z.object({ command: z.string().min(1).refine(v => v.trim().length > 0), args: z.array(z.string()).optional(),
    timeout_seconds: seconds.optional(), env: z.record(z.string(), z.string()).optional() }).strict().optional(),
}).strict();
const terminalEntry = z.union([inputPath, z.array(inputPath).min(1), terminalObject]);
// JSON schema is a closed recursive language; only properties/enum carry user keys/data.
const jsonType = z.enum(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const inlineSchema: z.ZodType<import('./reality-gate/checks/json-schema-match.js').Schema> = z.lazy(() => z.object({
  anyOf: z.array(inlineSchema).min(1).optional(), type: z.union([jsonType, z.array(jsonType).min(1)]).optional(),
  required: z.array(z.string()).optional(), additionalProperties: z.union([z.boolean(), inlineSchema]).optional(),
  pattern: z.string().refine(v => { try { new RegExp(v); return true; } catch { return false; } }, 'invalid regular expression').optional(),
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
export const BriefDeclarationsSchema = z.object({
  max_continuations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  stage_duration_ms: positiveInteger.optional(), input_limit_chars: positiveInteger.optional(),
  validation: validationDeclaration.optional(), research: ResearchInstrumentSchema.optional(),
  terminal_states: z.partialRecord(z.enum(TERMINAL_STATUSES), terminalEntry).optional(),
  reality_checks: z.array(BriefRealityCheckSchema).optional(),
  inputs: z.array(z.union([inputPath, z.object({ path: inputPath, frozen: z.boolean().optional(),
    type: z.enum(['file', 'directory']).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().refine(input => input.type !== 'directory' || input.sha256 === undefined, { path: ['sha256'], message: 'sha256 describes file bytes, not a directory' })])).superRefine((inputs, context) => {
    const seen = new Set<string>();
    inputs.forEach((input, index) => {
      const path = typeof input === 'string' ? input : input.path;
      if (seen.has(path)) context.addIssue({ code: 'custom', path: [index, 'path'], message: 'duplicate input path' });
      seen.add(path);
    });
  }).optional(),
  outputs: z.array(z.union([outputPath, z.object({
    path: outputPath, type: z.enum(['file', 'directory']).optional(),
    on_existing: z.enum(['create', 'update', 'append', 'replace']).optional(),
  }).strict()])).refine(items => new Set(items.map(item => typeof item === 'string' ? item : item.path)).size === items.length, 'duplicate output path').optional(),
  criteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()).min(1)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'criteria IDs must be unique').optional(),
}).strict().superRefine((declaration, context) => {
  declaration.outputs?.forEach((output, index) => {
    const path = typeof output === 'string' ? output : output.path;
    if (isAbsolute(path) && (typeof output === 'string' || output.type !== 'directory')) context.addIssue({
      code: 'custom', path: ['outputs', index, 'type'], message: 'absolute outputs require an explicit directory declaration',
    });
  });
  if (!declaration.research) return;
  const roots = [...declaration.research.frozen, ...declaration.research.candidate];
  for (const [status, value] of Object.entries(declaration.terminal_states ?? {})) {
    const paths = typeof value === 'string' ? [value] : Array.isArray(value) ? value : value?.paths ?? [];
    paths.forEach((path, index) => {
      if (roots.some(root => path === root || path.startsWith(root + '/') || root.startsWith(path + '/'))) context.addIssue({
        code: 'custom', path: ['terminal_states', status, 'paths', index], message: 'Research terminal report must be outside frozen and candidate roots',
      });
    });
  }
}).meta({ replacements: {
  research: { key: 'research', protocol: ResearchInstrumentSchema.shape.protocol.value },
  objective: { key: 'research', protocol: ResearchInstrumentSchema.shape.protocol.value },
} });
export type BriefDeclarations = z.infer<typeof BriefDeclarationsSchema>;

/** All semantic readers validate the entire declaration before selecting a field. */
export function parseBriefDeclarations(brief: string): BriefDeclarations {
  const document = parseBriefFrontmatterDocument(brief);
  if (!document) return {};
  if (document.error) throw new DeclarationRefusal(document.errorPath ?? '$', document.error);
  const result = BriefDeclarationsSchema.safeParse(document.value);
  if (!result.success) {
    // Unions retain nested field paths instead of reporting just the union root.
    const leaves = (issue: z.core.$ZodIssue, prefix: PropertyKey[] = []): z.core.$ZodIssue[] => {
      const path = [...prefix, ...issue.path];
      return issue.code === 'invalid_union' ? issue.errors.flatMap(branch => branch.flatMap(child => leaves(child, path)))
        : [{ ...issue, path }];
    };
    const issues = result.error.issues.flatMap(issue => leaves(issue));
    const issue = issues.map(issue => ({ ...issue, path: issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]] : issue.path }))
      .sort((a, b) => b.path.length - a.path.length || Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys'))[0];
    const path = issue.path.join('.') || '$';
    const replacements = BriefDeclarationsSchema.meta()?.replacements as Record<string, { key: string; protocol: string }>;
    const rootKey = String(issue.path[0]);
    throw new DeclarationRefusal(path, issue.message, Object.hasOwn(replacements, rootKey) ? replacements[rootKey] : undefined);
  }
  return result.data;
}

export class DeclarationRefusal extends Error {
  readonly code = 'declaration_invalid';
  constructor(readonly keyPath: string, detail: string, readonly replacement?: { key: string; protocol: string }) {
    super(`DECLARATION_INVALID: ${keyPath}: ${detail}${replacement ? `; use ${replacement.key} with protocol ${replacement.protocol}` : ''}`);
    this.name = 'DeclarationRefusal';
  }
}
