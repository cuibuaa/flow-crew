import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckContext, RealityCheck } from '../types.js';
import { resolvePath, result } from './_utils.js';

interface Params {
  glob?: string;
  language?: string;
  forbid_pattern?: string;
}

export default class StaticAstScanCheck implements RealityCheck {
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.glob !== 'string') return result(false, 'glob must be provided');
    if (typeof params.forbid_pattern !== 'string') return result(false, 'forbid_pattern must be provided');
    if (typeof params.language !== 'string') return result(false, 'language must be provided');
    const files = expandGlob(params.glob, context);
    const pattern = new RegExp(params.forbid_pattern, 'gm');
    const findings: Array<{ file: string; line: number; match: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        findings.push({ file, line: text.slice(0, index).split(/\r?\n/).length, match: match[0].slice(0, 160) });
      }
    }
    return result(findings.length === 0, findings.length === 0 ? `${files.length} file(s) clean` : `${findings.length} forbidden pattern match(es)`, { filesScanned: files.length, findings });
  }
}

function expandGlob(glob: string, context: CheckContext): string[] {
  const normalized = glob.replace(/\\/g, '/');
  const star = normalized.search(/[*{[]/);
  const basePart = star >= 0 ? normalized.slice(0, star) : normalized;
  const baseDir = basePart.includes('/') ? basePart.slice(0, basePart.lastIndexOf('/')) : '.';
  const suffix = normalized.match(/\.([A-Za-z0-9]+)$/)?.[1];
  const root = resolvePath(baseDir || '.', context);
  const all = walk(root);
  if (!suffix) return all;
  return all.filter((file) => file.endsWith(`.${suffix}`));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}
