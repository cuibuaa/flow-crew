import { atomicWrite, mkdirSync } from './engine-fs.js';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Publish JSON with create-only semantics. Existing content is never overwritten. */
export function publishJsonCreateOnly(target: string, value: unknown): 'published' | 'exists' {
  mkdirSync(dirname(target), { recursive: true });
  return atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`, { durability: 'durable', mode: 0o600, exclusive: true }) ? 'published' : 'exists';
}
