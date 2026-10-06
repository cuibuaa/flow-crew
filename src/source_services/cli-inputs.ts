// Boundary: Pure CLI value parsing, error text and lexical path containment; no IO or engine dependencies.
import { isAbsolute, relative, sep } from 'node:path';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function optionValue(args: string[], index: number, option: string): { value: string; consumed: number } {
  const argument = args[index];
  const prefix = `${option}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return { value, consumed: 2 };
}

export function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
