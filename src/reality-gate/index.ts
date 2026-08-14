import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type {
  CheckContext,
  CheckDecl,
  RealityCheck,
  RealityGateCheckReport,
  RealityGateExit,
  RealityGateReport,
} from './types.js';

export type {
  CheckContext,
  CheckDecl,
  CheckResult,
  RealityCheck,
  RealityGateExit,
  RealityGateReport,
} from './types.js';

export function parseChecksFromBrief(briefPath: string): CheckDecl[] {
  return parseChecksFromMarkdown(readFileSync(briefPath, 'utf-8'));
}

export function hasRealityChecksHeading(markdown: string): boolean {
  return /^## Reality checks[^\n]*(?:\n|$)/m.test(markdown);
}

export function parseChecksFromMarkdown(markdown: string): CheckDecl[] {
  const headings = [...markdown.matchAll(/^## Reality checks[^\n]*(?:\n|$)/gm)];
  for (const heading of headings.reverse()) {
    if (heading.index === undefined) continue;
    const start = heading.index + heading[0].length;
    const rest = markdown.slice(start);
    const next = rest.search(/^##\s/m);
    let body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    const fence = body.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fence) body = fence[1];
    let parsed: { checks?: unknown } | null = null;
    try {
      parsed = parseYaml(body) as { checks?: unknown } | null;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, ' ')
        .trim();
      return [invalidBlockDeclaration(`YAML parsing failed${message ? `: ${message}` : ''}`)];
    }
    if (parsed && Array.isArray(parsed.checks)) return normalizeChecks(parsed.checks);
  }
  return [];
}

function invalidBlockDeclaration(diagnostic: string): CheckDecl {
  return {
    kind: 'invalid',
    name: 'Reality checks declaration',
    type: '__invalid-reality-check-declaration__',
    diagnostic,
  };
}

function normalizeChecks(checks: unknown[]): CheckDecl[] {
  return checks.map((item, index): CheckDecl => {
    const position = index + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return invalidDeclaration(position, 'must be an object');
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string') {
      return invalidDeclaration(position, 'must have a string name');
    }
    if (typeof rec.type !== 'string') {
      return invalidDeclaration(position, 'must have a string type', rec.name);
    }
    const params = rec.params && typeof rec.params === 'object' ? rec.params as object : {};
    return {
      name: rec.name,
      type: rec.type,
      params,
      ...(rec.advisory === true ? { advisory: true } : {}),
    };
  });
}

function invalidDeclaration(position: number, diagnostic: string, suppliedName?: string): CheckDecl {
  const name = suppliedName?.trim() ? suppliedName : `Reality check item #${position}`;
  return {
    kind: 'invalid',
    name,
    type: '__invalid-reality-check-declaration__',
    diagnostic: `Reality check item #${position} ${diagnostic}`,
  };
}

export async function runAllChecks(decls: CheckDecl[], context: CheckContext): Promise<RealityGateReport> {
  const handlers = await loadHandlers();
  const results: RealityGateCheckReport[] = [];
  for (const decl of decls) {
    if (decl.kind === 'invalid') {
      const diagnostic = boundedInline(decl.diagnostic, 320);
      results.push({
        name: decl.name,
        type: decl.type,
        pass: false,
        details: `${diagnostic}. Fix the named declaration and its YAML fields, then rerun Reality-Gate.`,
      });
      continue;
    }
    const handler = handlers.get(decl.type);
    if (!handler) {
      const unknownType = boundedInline(decl.type, 120);
      results.push({
        name: decl.name,
        type: decl.type,
        pass: false,
        details: `Unknown check type: ${unknownType}. Replace it with a type from the Reality-Gate check catalog, then rerun the gate.`,
        ...(decl.advisory === true ? { advisory: true } : {}),
      });
      continue;
    }
    try {
      const { advisory: handlerAdvisory, ...result } = await handler.run(decl.params, context);
      results.push({
        name: decl.name,
        type: decl.type,
        ...result,
        ...(decl.advisory === true || handlerAdvisory === true ? { advisory: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: decl.name,
        type: decl.type,
        pass: false,
        details: actionableHandlerError(decl.type, decl.params, message),
        ...(decl.advisory === true ? { advisory: true } : {}),
      });
    }
  }
  return {
    pass: results.every((item) => item.pass || item.advisory === true),
    checkedAt: new Date().toISOString(),
    checksRun: results.length,
    results,
  };
}

function actionableHandlerError(type: string, params: object, message: string): string {
  const item = params as Record<string, unknown>;
  const subject = typeof item.file === 'string'
    ? ` for file ${JSON.stringify(boundedInline(item.file, 180))}`
    : typeof item.glob === 'string'
      ? ` for glob ${JSON.stringify(boundedInline(item.glob, 180))}`
      : typeof item.url === 'string'
        ? ` for URL ${JSON.stringify(boundedInline(item.url, 180))}`
        : '';
  const bounded = boundedInline(message, 220);
  return `Check handler ${JSON.stringify(boundedInline(type, 120))} failed${subject}: ${bounded}. Check the named input and declaration, fix the handler error, then rerun Reality-Gate.`;
}

function boundedInline(value: string, maximum: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 3)}...`;
}

/**
 * Read the canonical reality-gate artifact back from disk before adjudication.
 * This deliberately accepts an artifact path, never a run.json/UI projection.
 */
export function readRealityGateReport(artifactPath: string): RealityGateReport {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(artifactPath, 'utf-8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read durable reality-gate evidence at ${artifactPath}: ${detail}`, {
      cause: error,
    });
  }
  return validateRealityGateReport(value, artifactPath);
}

function validateRealityGateReport(value: unknown, artifactPath: string): RealityGateReport {
  const report = requireRecord(value, 'report', artifactPath);
  if (typeof report.pass !== 'boolean') invalidArtifact(artifactPath, 'report.pass must be boolean');
  if (typeof report.checkedAt !== 'string' || report.checkedAt.length === 0) {
    invalidArtifact(artifactPath, 'report.checkedAt must be a nonempty string');
  }
  if (!Number.isInteger(report.checksRun) || (report.checksRun as number) < 0) {
    invalidArtifact(artifactPath, 'report.checksRun must be a nonnegative integer');
  }
  if (!Array.isArray(report.results)) invalidArtifact(artifactPath, 'report.results must be an array');

  const results = (report.results as unknown[]).map((entry, index) => {
    const check = requireRecord(entry, `report.results[${index}]`, artifactPath);
    if (typeof check.name !== 'string') invalidArtifact(artifactPath, `report.results[${index}].name must be a string`);
    if (typeof check.type !== 'string') invalidArtifact(artifactPath, `report.results[${index}].type must be a string`);
    if (typeof check.pass !== 'boolean') invalidArtifact(artifactPath, `report.results[${index}].pass must be boolean`);
    if (typeof check.details !== 'string') invalidArtifact(artifactPath, `report.results[${index}].details must be a string`);
    if (check.advisory !== undefined && typeof check.advisory !== 'boolean') {
      invalidArtifact(artifactPath, `report.results[${index}].advisory must be boolean when present`);
    }
    let executionExitCode: number | null | undefined;
    if (check.evidence !== undefined) {
      const evidence = requireRecord(check.evidence, `report.results[${index}].evidence`, artifactPath);
      executionExitCode = validateExecutionEvidence(evidence, index, artifactPath);
    }
    if (check.type === 'exec-script-exit-zero') {
      if (check.pass && executionExitCode === undefined) {
        invalidArtifact(artifactPath, `report.results[${index}] cannot pass without complete execution evidence`);
      }
      if (executionExitCode !== undefined && check.pass !== (executionExitCode === 0)) {
        invalidArtifact(artifactPath, `report.results[${index}].pass disagrees with evidence.exit.code`);
      }
    }
    return check as unknown as RealityGateCheckReport;
  });

  if ((report.checksRun as number) !== results.length) {
    invalidArtifact(artifactPath, 'report.checksRun does not match report.results.length');
  }
  const derivedPass = results.every((item) => item.pass || item.advisory === true);
  if (report.pass !== derivedPass) {
    invalidArtifact(artifactPath, 'report.pass disagrees with the complete check results');
  }
  return { ...report, results } as unknown as RealityGateReport;
}

function validateExecutionEvidence(
  evidence: Record<string, unknown>,
  resultIndex: number,
  artifactPath: string,
): number | null | undefined {
  const hasExecutionTransport = ['command', 'exit', 'code', 'signal', 'timedOut']
    .some((field) => Object.prototype.hasOwnProperty.call(evidence, field));
  if (!hasExecutionTransport) return undefined;
  const prefix = `report.results[${resultIndex}].evidence`;
  if (typeof evidence.command !== 'string') invalidArtifact(artifactPath, `${prefix}.command must be a string`);
  if (typeof evidence.stdout !== 'string') invalidArtifact(artifactPath, `${prefix}.stdout must be a string`);
  if (typeof evidence.stderr !== 'string') invalidArtifact(artifactPath, `${prefix}.stderr must be a string`);
  const exit = requireRecord(evidence.exit, `${prefix}.exit`, artifactPath);
  if (!isExitCode(exit.code)) invalidArtifact(artifactPath, `${prefix}.exit.code must be an integer or null`);
  if (!isExitSignal(exit.signal)) invalidArtifact(artifactPath, `${prefix}.exit.signal must be a string or null`);
  if (typeof exit.timedOut !== 'boolean') invalidArtifact(artifactPath, `${prefix}.exit.timedOut must be boolean`);
  if (!isExitCode(evidence.code) || evidence.code !== exit.code) {
    invalidArtifact(artifactPath, `${prefix}.code must match exit.code`);
  }
  if (!isExitSignal(evidence.signal) || evidence.signal !== exit.signal) {
    invalidArtifact(artifactPath, `${prefix}.signal must match exit.signal`);
  }
  if (typeof evidence.timedOut !== 'boolean' || evidence.timedOut !== exit.timedOut) {
    invalidArtifact(artifactPath, `${prefix}.timedOut must match exit.timedOut`);
  }
  return exit.code as number | null;
}

function isExitCode(value: unknown): value is number | null {
  return value === null || Number.isInteger(value);
}

function isExitSignal(value: unknown): value is RealityGateExit['signal'] {
  return value === null || typeof value === 'string';
}

function requireRecord(value: unknown, label: string, artifactPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidArtifact(artifactPath, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidArtifact(artifactPath: string, detail: string): never {
  throw new Error(`Invalid durable reality-gate evidence at ${artifactPath}: ${detail}`);
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

export interface CheckTypeInfo { type: string; description: string; params: string; }
let _checkTypesCache: CheckTypeInfo[] | null = null;

/**
 * Self-describing check catalog — each check class exposes a static `meta`
 * { description, params }. Injected into the planner as the deterministic-check
 * vocabulary so it can compose gates from real checks (not just free-text QA prose).
 * Adding/changing a check = edit its own `meta`; the planner auto-syncs.
 */
export async function listCheckTypes(): Promise<CheckTypeInfo[]> {
  if (_checkTypesCache) return _checkTypesCache;
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'checks');
  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.js') || (file.endsWith('.ts') && !file.endsWith('.d.ts')))
    .filter((file) => !file.startsWith('_'));
  const out: CheckTypeInfo[] = [];
  for (const file of entries) {
    const type = file.replace(/\.(js|ts)$/, '');
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      const meta = (mod.default && (mod.default as { meta?: { description?: string; params?: string } }).meta) || {};
      out.push({ type, description: meta.description ?? '', params: meta.params ?? '' });
    } catch { /* skip unloadable check */ }
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  _checkTypesCache = out;
  return out;
}
