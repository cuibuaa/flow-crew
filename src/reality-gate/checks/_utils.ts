import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CheckContext, CheckResult } from '../types.js';

export function trimDetails(details: string): string {
  if (details.length <= 500) return details;
  const omission = ' ... [details omitted] ... ';
  const retained = 500 - omission.length;
  const head = Math.ceil(retained / 2);
  const tail = retained - head;
  return `${details.slice(0, head)}${omission}${details.slice(-tail)}`;
}

export function result(pass: boolean, details: string, evidence?: object): CheckResult {
  return evidence ? { pass, details: trimDetails(details), evidence } : { pass, details: trimDetails(details) };
}

export function resolvePath(value: string, context: CheckContext): string {
  if (isAbsolute(value)) return value;
  const projectPath = join(context.projectDir, value);
  if (existsSync(projectPath)) return projectPath;
  return join(context.taskDir, value);
}

export function readJsonFile(value: string, context: CheckContext): unknown {
  return JSON.parse(readFileSync(resolvePath(value, context), 'utf-8'));
}

export function valuesAtPath(root: unknown, path: string): unknown[] {
  const parts = path.split('.').filter(Boolean);
  let current: unknown[] = [root];
  for (const part of parts) {
    const arrayMatch = part.match(/^(.+)\[\*\]$/);
    const key = arrayMatch ? arrayMatch[1] : part;
    const next: unknown[] = [];
    for (const item of current) {
      if (!item || typeof item !== 'object') continue;
      const value = (item as Record<string, unknown>)[key];
      if (arrayMatch) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

export function stringValuesAtPath(root: unknown, path: string): string[] {
  return valuesAtPath(root, path).filter((value): value is string => typeof value === 'string' && value.length > 0);
}
