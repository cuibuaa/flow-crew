// Boundary: Pure CLI value parsing, error text and lexical path containment; no IO or engine dependencies.
import { isAbsolute, relative, sep } from 'node:path';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
