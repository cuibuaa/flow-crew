import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { CheckContext, CheckDecl, RealityCheck, RealityGateReport } from './types.js';

export type { CheckContext, CheckDecl, CheckResult, RealityCheck, RealityGateReport } from './types.js';

export function parseChecksFromBrief(briefPath: string): CheckDecl[] {
  return parseChecksFromMarkdown(readFileSync(briefPath, 'utf-8'));
}

export function parseChecksFromMarkdown(markdown: string): CheckDecl[] {
  const headings = [...markdown.matchAll(/^## Reality checks[^\n]*\n/gm)];
  for (const heading of headings.reverse()) {
    if (heading.index === undefined) continue;
    const start = heading.index + heading[0].length;
    const rest = markdown.slice(start);
    const next = rest.search(/^##\s/m);
    let body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    const fence = body.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fence) body = fence[1];
    let parsed: { checks?: unknown } | null = null;
    try { parsed = parseYaml(body) as { checks?: unknown } | null; } catch { continue; }
    if (parsed && Array.isArray(parsed.checks)) return normalizeChecks(parsed.checks);
  }
  return [];
}

function normalizeChecks(checks: unknown[]): CheckDecl[] {
  return checks.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || typeof rec.type !== 'string') return [];
    const params = rec.params && typeof rec.params === 'object' ? rec.params as object : {};
    return [{ name: rec.name, type: rec.type, params }];
  });
}

export async function runAllChecks(decls: CheckDecl[], context: CheckContext): Promise<RealityGateReport> {
  const handlers = await loadHandlers();
  const results = [];
  for (const decl of decls) {
    const handler = handlers.get(decl.type);
    if (!handler) {
      results.push({ name: decl.name, type: decl.type, pass: false, details: `unknown check type: ${decl.type}` });
      continue;
    }
    try {
      const result = await handler.run(decl.params, context);
      results.push({ name: decl.name, type: decl.type, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: decl.name, type: decl.type, pass: false, details: message.length <= 500 ? message : `${message.slice(0, 497)}...` });
    }
  }
  return {
    pass: results.every((item) => item.pass),
    checkedAt: new Date().toISOString(),
    checksRun: results.length,
    results,
  };
}

async function loadHandlers(): Promise<Map<string, RealityCheck>> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'checks');
  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.js') || (file.endsWith('.ts') && !file.endsWith('.d.ts')))
    .filter((file) => !file.startsWith('_'));
  const handlers = new Map<string, RealityCheck>();
  for (const file of entries) {
    const type = file.replace(/\.(js|ts)$/, '');
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const Klass = mod.default;
    if (typeof Klass === 'function') handlers.set(type, new Klass() as RealityCheck);
  }
  return handlers;
}
