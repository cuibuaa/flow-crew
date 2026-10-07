import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { result as checkResult } from './checks/_utils.js';
import { REALITY_CHECK_REGISTRY } from './registry.js';
import { inspectRealityHandlerReads } from './declared-reads.js';
import { ArtifactReadSchema } from '../artifact-declarations.js';
import { inspectDeclaredStageReads } from '../declared-artifact-audit.js';
import type { StageStatus } from '../store.js';
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
  if (headings.length > 1) return [invalidBlockDeclaration('Multiple Reality checks sections are ambiguous')];
  for (const heading of headings) {
    if (heading.index === undefined) continue;
    const start = heading.index + heading[0].length;
    const rest = markdown.slice(start);
    const next = rest.search(/^##\s/m);
    let body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    // Explanations may surround one complete declaration. Inspect every fence
    // before selecting it, so a good block cannot conceal a broken second one.
    const declarations: string[] = [];
    const outside: string[] = [];
    let fence: { marker: string; length: number; language: string; lines: string[] } | undefined;
    let sawFence = false;
    for (const line of body.split(/\r?\n/)) {
      if (fence) {
        const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
        if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
          if (/^(?:ya?ml)?$/i.test(fence.language)) declarations.push(fence.lines.join('\n'));
          fence = undefined;
        } else fence.lines.push(line);
      } else {
        const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/.exec(line);
        if (opening) {
          sawFence = true;
          fence = { marker: opening[1][0], length: opening[1].length, language: opening[2], lines: [] };
        } else outside.push(line);
      }
    }
    if (fence) return [invalidBlockDeclaration('YAML parsing failed: unclosed fenced block in Reality checks')];
    if (declarations.length > 1 || (declarations.length === 1 && /^\s*checks\s*:/m.test(outside.join('\n')))) {
      return [invalidBlockDeclaration('Multiple Reality checks declarations are ambiguous')];
    }
    if (sawFence && declarations.length === 0) return [invalidBlockDeclaration('YAML parsing failed: no YAML declaration fence in Reality checks')];
    if (declarations.length === 1) body = declarations[0];
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
    if (rec.reads === undefined) return invalidDeclaration(position, `REALITY_READ_DECLARATION_REQUIRED: reality check ${JSON.stringify(rec.name)}.reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration`, rec.name);
    const reads = ArtifactReadSchema.array().safeParse(rec.reads);
    if (reads && !reads.success) return invalidDeclaration(position, `reads must declare exact rooted inputs: ${reads.error.message}`, rec.name);
    if (!REALITY_CHECK_REGISTRY.some(check => check.type === rec.type)) {
      return invalidDeclaration(position, `has unsupported type ${JSON.stringify(rec.type)}; replace it with a type from the Reality-Gate check catalog`, rec.name);
    }
    return {
      name: rec.name,
      type: rec.type,
      params,
      ...(reads?.success ? { reads: reads.data } : {}),
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
    diagnostic: diagnostic.startsWith('REALITY_READ_DECLARATION_REQUIRED:') ? diagnostic : `Reality check item #${position} ${diagnostic}`,
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
      if (decl.reads === undefined) throw new Error(`REALITY_READ_DECLARATION_REQUIRED: reality check ${JSON.stringify(decl.name)}.reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration`);
      if (decl.reads !== undefined) {
        let statuses: Record<string, StageStatus> | undefined;
        if (decl.reads.some((read) => read.source.kind === 'stage' || read.when)) {
          const run = JSON.parse(readFileSync(join(context.taskDir, 'run.json'), 'utf8')) as { runId?: string; projectDir?: string; stages?: Record<string, StageStatus> };
          if (run.runId !== basename(context.taskDir) || !run.projectDir || resolve(run.projectDir) !== resolve(context.projectDir) || !run.stages) throw new Error('ARTIFACT_READ_FACTS_UNBOUND: reality reads require this run\'s settled producer facts');
          statuses = run.stages;
        }
        const errors = [...inspectRealityHandlerReads(decl, context.projectDir, context.taskDir), ...inspectDeclaredStageReads({ artifactContract: { version: 1, produces: [], reads: decl.reads, groups: [], replays: [] }, projectDir: context.projectDir, runDir: context.taskDir, statuses })];
        if (errors.length) {
          results.push({ name: decl.name, type: decl.type, ...checkResult(false, `${errors.join('; ')}. Create each missing file or fix the named declared inputs, then rerun Reality-Gate.`), ...(decl.advisory === true ? { advisory: true } : {}) });
          continue;
        }
      }
      const { advisory: handlerAdvisory, ...result } = await handler.run(decl.params, {
        ...context, declaredReads: decl.reads,
        commandBoundary: { projectDir: context.projectDir,
          runDir: resolve(context.taskDir) === resolve(context.projectDir) ? undefined : context.taskDir,
          stageId: '_reality', authority: 'project-command' },
      });
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
  return new Map(REALITY_CHECK_REGISTRY.map(({ type, check }) => [type, check]));
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
  _checkTypesCache = REALITY_CHECK_REGISTRY.map(({ type, description, params }) => ({
    type,
    description,
    params,
  }));
  return _checkTypesCache;
}
