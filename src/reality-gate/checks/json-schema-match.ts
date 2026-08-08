import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, result } from './_utils.js';

interface Schema {
  /** A single JSON Schema type name, or a union of them. JSON Schema allows both, and a
   *  union is the standard way to say "nullable" — `type: [string, "null"]`. Declaring this
   *  as `string` alone silently rejected every union: the array is truthy, so validation
   *  ran, then every comparison in matchesType compared a string against an array and the
   *  `typeof value === type` fallback could not match, so nullable fields ALWAYS failed
   *  regardless of their value. Reality gates and research-loop `result_schema` both go
   *  through validate(), so both were affected. */
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

interface Params {
  file?: string;
  schema?: Schema | { file?: string };
}

export default class JsonSchemaMatchCheck implements RealityCheck {
  static meta = { description: 'Validate a JSON file against a declared schema (type/required/properties/items/enum/minimum/maximum).', params: 'file: string, schema: {...} | { file: string }' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.file !== 'string') return result(false, 'file must be provided');
    const schema = this.schema(params, context);
    if (!schema) return result(false, 'schema must be provided');
    const data = readJsonFile(params.file, context);
    const errors = validate(data, schema, '$');
    return result(errors.length === 0, errors.length === 0 ? 'JSON matches schema' : errors.slice(0, 5).join('; '), { errors });
  }

  private schema(params: Params, context: CheckContext): Schema | undefined {
    if (!params.schema) return undefined;
    if ('file' in params.schema && typeof params.schema.file === 'string') return readJsonFile(params.schema.file, context) as Schema;
    return params.schema as Schema;
  }
}

/** Pure, reusable validator (also used per-round by the research loop to enforce the
 *  brief-declared round_result schema). Returns a list of human-readable path errors. */
export function validate(value: unknown, schema: Schema, path: string): string[] {
  const errors: string[] = [];
  if (hasTypeConstraint(schema.type) && !matchesType(value, schema.type)) {
    errors.push(`${path} expected ${describeType(schema.type)}`);
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) errors.push(`${path} not in enum`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} above maximum`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key} required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validate(obj[key], child, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validate(item, schema.items as Schema, `${path}[${index}]`)));
  }
  return errors;
}

/** An empty union constrains nothing; treat it as absent rather than as "matches nothing". */
function hasTypeConstraint(type: string | string[] | undefined): type is string | string[] {
  if (Array.isArray(type)) return type.length > 0;
  return typeof type === 'string' && type.length > 0;
}

function describeType(type: string | string[]): string {
  return Array.isArray(type) ? type.join('|') : type;
}

function matchesType(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) return type.some((one) => matchesOneType(value, one));
  return matchesOneType(value, type);
}

function matchesOneType(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}
