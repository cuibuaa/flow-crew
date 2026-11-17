import { z } from 'zod';
import { parseDocument } from 'yaml';

// These schemas own lexical identity, not physical filesystem safety.
/** Validate canonical identifier spelling; finite membership belongs to the containing schema, with lexical refusal from Zod. */
export const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
/** Validate lowercase SHA-256 spelling; byte authentication belongs to records, with lexical refusal from Zod. */
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Decide components and code points; line separators never terminate inspection.
function literalPath(path: string, absolute: boolean): boolean {
  const relative = absolute && path.startsWith('/') ? path.slice(1) : path;
  return relative.split('/').every(component => component.length > 0 && component !== '.' && component !== '..'
    && [...component].every(character => {
      const point = character.codePointAt(0)!;
      return point > 0x1f && point !== 0x7f && !'\\:*?[]{}'.includes(character);
    }));
}
/** Validate relative literal components across every code point; no physical alias claim, with malformed paths refused by Zod. */
export const pathSchema = z.string().refine(path => literalPath(path, false),
  'Expected a canonical relative literal path').describe('Relative literal path: nonempty slash-separated components; no dot/dot-dot, backslash, colon, glob or control code points.');
/** Validate operator paths including absolute roots; grants remain host authority, with malformed components refused by Zod. */
export const declaredPathSchema = z.string().refine(path => literalPath(path, true),
  'Expected a canonical literal path');
/** Validate a strict relative locator/hash pair; records must authenticate bytes, and malformed references are schema refusals. */
export const refSchema = z.strictObject({ path: pathSchema, sha256: hashSchema });
/** Carry a canonical identifier string; spelling and finite membership require schemas, not semantic interpretation. */
export type Id = z.infer<typeof idSchema>;
/** Carry a claimed SHA-256 identity; records authenticate bytes rather than trusting this string. */
export type Hash = z.infer<typeof hashSchema>;
/** Make nested DTO properties and arrays readonly; provides no runtime validation or access authority. */
export type Immutable<T> = T extends readonly (infer U)[] ? readonly Immutable<U>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
/** Locate immutable evidence relative to its owning store; neither authenticates bytes nor grants filesystem access. */
export type Ref = Immutable<z.infer<typeof refSchema>>;
/** Distinguish a known value from invalid/conflict/unavailable/unknown; human detail never selects behavior. */
export type Result<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown'; readonly detail: string };
/** Apply one receiving Zod schema without I/O; returns invalid for structural refusal and never interprets human detail. */
export function parseValue<T>(schema: z.ZodType<T>, value: unknown): Result<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data }
    : { ok: false, kind: 'invalid', detail: parsed.error.message };
}
// Operator declarations may name external roots. Ref paths remain relative to
// their evidence store; host/content owns physical grants and alias checks.
const inputSchema = z.strictObject({
  id: idSchema, path: declaredPathSchema, kind: z.enum(['file', 'directory']),
  frozen: z.boolean(), sha256: hashSchema.optional(),
});
const outputSchema = z.strictObject({
  path: declaredPathSchema, kind: z.enum(['file', 'directory']),
  existing: z.enum(['create', 'update', 'append', 'replace']),
});
const commandSchema = z.strictObject({
  id: idSchema, argv: z.array(z.string().refine((v) => !v.includes('\0'))).min(1),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine((v) => !v.includes('\0'))),
  inputs: z.array(idSchema), required: z.boolean(),
  durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).refine((v) => v.argv[0].length > 0, 'Command executable must not be empty');
const resultSchema = z.strictObject({ id: idSchema, text: z.string().min(1) });
/** Declare input path, kind and optional frozen identity; content measures bytes and host grants access. */
export type Input = Immutable<z.infer<typeof inputSchema>>;
/** Declare final output kind and original create/update/append/replace disposition; preservation is content authority. */
export type Output = Immutable<z.infer<typeof outputSchema>>;
/** Carry exact operator argv/env, input IDs and required flag; planners cannot redefine commands or their exit meaning. */
export type DeclaredCommand = Immutable<z.infer<typeof commandSchema>>;
/** Declare one opaque finite result label; membership is checked without interpreting its text or ID. */
export type DeclaredResult = Immutable<z.infer<typeof resultSchema>>;
const metadataSchema = z.strictObject({
  criteria: z.array(z.strictObject({ id: idSchema, text: z.string().min(1) })).min(1),
  inputs: z.array(inputSchema), outputs: z.array(outputSchema),
  commands: z.array(commandSchema), results: z.array(resultSchema),
  allowBlocked: z.boolean(),
}).superRefine((brief, ctx) => {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate ${label}` });
  };
  for (const key of ['criteria', 'inputs', 'commands', 'results'] as const)
    unique(brief[key].map((v) => v.id), `${key} id`);
  unique(brief.inputs.map((v) => v.path), 'input path');
  unique(brief.outputs.map((v) => v.path), 'output path');
  const inputs = new Set(brief.inputs.map((v) => v.id));
  for (const command of brief.commands) {
    unique(command.inputs, 'command input');
    for (const input of command.inputs) if (!inputs.has(input))
      ctx.addIssue({ code: 'custom', message: `Undeclared command input: ${input}` });
  }
});
/** Validate strict operator metadata plus opaque body; refuses malformed declarations without extracting policy from prose. */
export const briefSchema = z.preprocess(value => ignoreRetired(value, 'brief'),
  metadataSchema.safeExtend({ body: z.string() }));
/** Carry operator criteria, resources and opaque brief text; no model-authored hard predicates are implied. */
export type Brief = Immutable<z.infer<typeof briefSchema>>;
/** Validate the exact-byte admission envelope; matching real hashes remains core/content authority. */
export const admittedBriefSchema = z.preprocess(value => ignoreRetired(value, 'brief'), z.strictObject({
  bytes: refSchema, declaration: briefSchema, digest: hashSchema,
}));
/** Bind approved brief bytes to their declaration; this DTO alone proves no physical authentication. */
export type AdmittedBrief = Immutable<z.infer<typeof admittedBriefSchema>>;

/** Decode exact UTF-8 frontmatter and retain opaque body; returns invalid for encoding/metadata errors without deriving criteria. */
export function parseBrief(bytes: Uint8Array, advisory?: (line: string) => void): Result<Brief> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const lines = text.split('\n');
    if (lines[0] !== '---' && lines[0] !== '---\r') throw new Error('Missing opening frontmatter delimiter');
    const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '---\r'));
    if (end < 0) throw new Error('Missing closing frontmatter delimiter');
    const document = parseDocument(lines.slice(1, end).join('\n'), {
      uniqueKeys: true, schema: 'core', strict: true, stringKeys: true,
    });
    if (document.errors.length || document.warnings.length)
      throw new Error([...document.errors, ...document.warnings].map((v) => v.message).join('; '));
    const parsed = parseValue(metadataSchema, ignoreRetired(document.toJS({ maxAliasCount: 0 }), 'brief', advisory));
    if (!parsed.ok) return parsed;
    return { ok: true, value: { ...parsed.value, body: lines.slice(end + 1).join('\n') } };
  } catch (error) {
    return { ok: false, kind: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Discard retired declaration keys at the contract boundary; never inspect or retain their values. */
export function ignoreRetired(value: unknown, scope: 'brief' | 'config', advisory?: (line: string) => void): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const fields = scope === 'brief' ? ['bounds'] : ['bounds', 'adapterInputLimitChars'];
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    if (!fields.includes(key)) return true;
    advisory?.(`${key}: retired and ignored`);
    return false;
  }));
}
