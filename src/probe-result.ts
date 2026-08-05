import { z } from 'zod';

export interface ProbeResultEnvelope {
  raw: { stdout: string; stderr: string };
  exit: { code: number | null; signal: string | null; timedOut: boolean };
}

export type SingleProbeValueResult<T> =
  | { ok: true; envelope: ProbeResultEnvelope; value: T }
  | {
      ok: false;
      envelope: ProbeResultEnvelope;
      kind: 'process' | 'shape' | 'type';
      errors: string[];
    };

export function parseSingleProbeValue<T>(
  envelope: ProbeResultEnvelope,
  schema: z.ZodType<T>,
): SingleProbeValueResult<T> {
  const processErrors: string[] = [];
  if (envelope.exit.code !== 0) {
    processErrors.push(`exit.code must be 0; received ${envelope.exit.code ?? 'null'}`);
  }
  if (envelope.exit.signal !== null) {
    processErrors.push(`exit.signal must be null; received ${JSON.stringify(envelope.exit.signal)}`);
  }
  if (envelope.exit.timedOut) processErrors.push('exit.timedOut must be false; received true');
  if (processErrors.length > 0) {
    return { ok: false, envelope, kind: 'process', errors: processErrors };
  }

  let value: unknown;
  try {
    value = JSON.parse(envelope.raw.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      envelope,
      kind: 'shape',
      errors: [`raw.stdout must contain exactly one JSON value: ${detail}`],
    };
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      envelope,
      kind: 'type',
      errors: parsed.error.issues.map((issue) => (
        `raw.stdout${formatIssuePath(issue.path)}: ${issue.message}`
      )),
    };
  }

  return { ok: true, envelope, value: parsed.data };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.map((part) => (
    typeof part === 'number' ? `[${part}]` : `.${String(part)}`
  )).join('');
}
