import { readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RealityGateExit } from './types.js';

interface FailedExecution {
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exit: RealityGateExit;
}

export interface VersionedJsonShapeInspectionEvidence {
  classification: 'unbound-versioned-json-multi-shape-mismatch';
  artifactPath: string;
  discriminator: {
    field: 'artifact';
    value: string;
  };
  incompatiblePaths: Array<{
    path: string;
    kind: 'missing' | 'parent-type' | 'type';
    actualType: string;
    expectedType: string;
    diagnostic: string;
  }>;
  independentFailureGuards: number;
}

export interface VersionedJsonAdmissionEvidence extends VersionedJsonShapeInspectionEvidence {
  matchedDiagnostic: string;
}

export interface VersionedJsonAdmission {
  detail: string;
  evidence: VersionedJsonAdmissionEvidence;
}

export interface VersionedJsonShapeInspection {
  evidence: VersionedJsonShapeInspectionEvidence;
  failureDiagnostics: string[];
}

interface JsonLoad {
  body: string;
  rootIdentifier: string;
  pathIdentifier: string;
  artifactPath: string;
  pathLiteral: string;
}

interface FailureGuard {
  condition: string;
  diagnostic: string;
}

interface PathMismatch {
  path: string;
  kind: 'missing' | 'parent-type' | 'type';
  actualType: string;
  expectedType: string;
}

const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const SIMPLE_STRING = '(?:"[^"\\\\\r\n]*"|\'[^\'\\\\\r\n]*\')';
const VERSION_SUFFIX = /(?:^|[._-])v[1-9][0-9]*(?:\.[0-9]+)*$/i;
const MUTATING_FILE_CALL = /\b(?:appendFile|appendFileSync|cp|cpSync|rename|renameSync|rm|rmSync|truncate|truncateSync|unlink|unlinkSync|writeFile|writeFileSync)\s*\(/;

/**
 * Classify one deliberately narrow late-admission case. A failed command stays
 * failed; this function only decides whether that evidence is advisory for the
 * terminal verdict. Ambiguous syntax and incomplete evidence fail closed.
 */
export function classifyVersionedJsonShapeFailure(input: {
  script: string;
  args: readonly string[];
  projectDir: string;
  execution: FailedExecution;
}): VersionedJsonAdmission | undefined {
  const { execution } = input;
  if (execution.code !== 1
      || execution.exit.code !== 1
      || execution.signal !== null
      || execution.exit.signal !== null
      || execution.timedOut
      || execution.exit.timedOut
      || execution.stdout.trim().length !== 0) return undefined;

  const inspection = inspectVersionedJsonShapeCheck(input);
  if (!inspection) return undefined;
  const matchedDiagnostic = inspection.failureDiagnostics.find((diagnostic) => (
    execution.stderr === `${diagnostic}\n` || execution.stderr === `${diagnostic}\r\n`
  ));
  if (!matchedDiagnostic) return undefined;

  const evidence: VersionedJsonAdmissionEvidence = {
    ...inspection.evidence,
    matchedDiagnostic,
  };
  return {
    detail: `script exited 1, but terminal admission found ${evidence.independentFailureGuards} independent shape guards incompatible with versioned JSON ${JSON.stringify(evidence.discriminator.value)} while the script never bound its artifact discriminator; the failed execution remains recorded as advisory. Bind the expected discriminator explicitly to make a schema-specific defect hard.`,
    evidence,
  };
}

/**
 * Inspect the same deliberately narrow shape relation used by terminal
 * admission without executing the check. Existing project bytes can support
 * an advisory planning finding; they are not authority to reject a future
 * producer that may replace the artifact before the terminal boundary.
 */
export function inspectVersionedJsonShapeCheck(input: {
  script: string;
  args: readonly string[];
  projectDir: string;
}): VersionedJsonShapeInspection | undefined {
  if (input.args.length !== 0) return undefined;

  const body = inlineNodeBody(input.script);
  if (!body || MUTATING_FILE_CALL.test(body)) return undefined;
  const load = parseJsonLoad(body);
  if (!load) return undefined;

  const root = escapeRegExp(load.rootIdentifier);
  const withoutPathLiteral = body.replace(load.pathLiteral, '""');
  if (/\bartifact\b/.test(withoutPathLiteral)
      || new RegExp(`\\b${root}\\s*\\[`).test(body)
      || new RegExp(`\\b(?:const|let|var)\\s+${IDENTIFIER}\\s*=\\s*${root}\\s*;`).test(body)
      || matchCount(body, new RegExp(`\\b${root}\\s*=(?!=)`, 'g')) !== 1
      || new RegExp(`\\b${root}(?:\\s*\\.\\s*${IDENTIFIER})+\\s*=(?!=)`).test(body)) return undefined;

  const resolved = resolveContainedJson(input.projectDir, load.artifactPath);
  if (!resolved) return undefined;
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(artifact)
      || !Object.prototype.hasOwnProperty.call(artifact, 'artifact')
      || typeof artifact.artifact !== 'string'
      || !VERSION_SUFFIX.test(artifact.artifact)) return undefined;

  const failName = recognizedFailFunction(body);
  if (!failName) return undefined;
  const guards = failureGuards(body, failName);
  if (guards.length === 0) return undefined;

  const incompatible: VersionedJsonShapeInspectionEvidence['incompatiblePaths'] = [];
  const guardsWithMismatch = new Set<number>();
  const seen = new Set<string>();
  guards.forEach((guard, guardIndex) => {
    for (const mismatch of mismatchesInGuard(guard.condition, load.rootIdentifier, artifact)) {
      guardsWithMismatch.add(guardIndex);
      const key = `${mismatch.kind}\0${mismatch.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incompatible.push({ ...mismatch, diagnostic: guard.diagnostic });
    }
  });
  if (guardsWithMismatch.size < 2) return undefined;

  const evidence: VersionedJsonShapeInspectionEvidence = {
    classification: 'unbound-versioned-json-multi-shape-mismatch',
    artifactPath: load.artifactPath,
    discriminator: { field: 'artifact', value: artifact.artifact },
    incompatiblePaths: incompatible.slice(0, 32),
    independentFailureGuards: guardsWithMismatch.size,
  };
  return {
    evidence,
    failureDiagnostics: guards.map(({ diagnostic }) => diagnostic),
  };
}

function inlineNodeBody(script: string): string | undefined {
  const lines = script.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3) return undefined;
  const opening = lines[0]?.match(/^\s*node\s+<<(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))\s*$/);
  const delimiter = opening?.[2] ?? opening?.[3];
  if (!delimiter || lines.at(-1) !== delimiter) return undefined;
  return lines.slice(1, -1).join('\n');
}

function parseJsonLoad(body: string): JsonLoad | undefined {
  if (matchCount(body, /\bJSON\s*\.\s*parse\s*\(/g) !== 1) return undefined;
  const parsePattern = new RegExp(
    `\\b(?:const|let)\\s+(${IDENTIFIER})\\s*=\\s*JSON\\s*\\.\\s*parse\\s*\\(\\s*(?:${IDENTIFIER}\\s*\\.\\s*)?readFileSync\\s*\\(\\s*(${IDENTIFIER})\\s*,\\s*(['"])utf-?8\\3\\s*\\)\\s*\\)\\s*;`,
    'g',
  );
  const parses = [...body.matchAll(parsePattern)];
  if (parses.length !== 1) return undefined;
  const rootIdentifier = parses[0]?.[1];
  const pathIdentifier = parses[0]?.[2];
  if (!rootIdentifier || !pathIdentifier || rootIdentifier === pathIdentifier) return undefined;

  const pathPattern = new RegExp(
    `\\b(?:const|let)\\s+${escapeRegExp(pathIdentifier)}\\s*=\\s*(${SIMPLE_STRING})\\s*;`,
    'g',
  );
  const paths = [...body.matchAll(pathPattern)];
  if (paths.length !== 1 || !paths[0]?.[1]) return undefined;
  const pathLiteral = paths[0][1];
  const artifactPath = parseSimpleString(pathLiteral);
  if (!artifactPath || extname(artifactPath).toLowerCase() !== '.json') return undefined;

  const jsonLiterals = staticStrings(body)
    .filter((value) => extname(value).toLowerCase() === '.json');
  if (jsonLiterals.length !== 1 || jsonLiterals[0] !== artifactPath) return undefined;
  return { body, rootIdentifier, pathIdentifier, artifactPath, pathLiteral };
}

function resolveContainedJson(projectDir: string, artifactPath: string): string | undefined {
  if (isAbsolute(artifactPath)) return undefined;
  try {
    const project = realpathSync.native(resolve(projectDir));
    const artifact = realpathSync.native(resolve(project, artifactPath));
    const rel = relative(project, artifact);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return artifact;
  } catch {
    return undefined;
  }
}

function recognizedFailFunction(body: string): string | undefined {
  const pattern = new RegExp(
    `\\bfunction\\s+(${IDENTIFIER})\\s*\\(\\s*(${IDENTIFIER})\\s*\\)\\s*\\{\\s*console\\s*\\.\\s*error\\s*\\(\\s*\\2\\s*\\)\\s*;\\s*process\\s*\\.\\s*exit\\s*\\(\\s*1\\s*\\)\\s*;\\s*\\}`,
    'g',
  );
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1
      || matchCount(body, /\bprocess\s*\.\s*exit\s*\(/g) !== 1
      || matchCount(body, /\bconsole\s*\.\s*error\s*\(/g) !== 1) return undefined;
  return matches[0]?.[1];
}

function failureGuards(body: string, failName: string): FailureGuard[] {
  const pattern = new RegExp(
    `\\bif\\s*\\((.*)\\)\\s*${escapeRegExp(failName)}\\s*\\(\\s*((?:"(?:[^"\\\\]|\\\\.)*")|(?:'(?:[^'\\\\]|\\\\.)*'))\\s*\\)\\s*;?\\s*$`,
  );
  const guards: FailureGuard[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match?.[1] || !match[2]) continue;
    const diagnostic = parseStaticString(match[2]);
    if (diagnostic === undefined) continue;
    guards.push({ condition: match[1], diagnostic });
  }
  return guards;
}

function mismatchesInGuard(
  condition: string,
  rootIdentifier: string,
  artifact: Record<string, unknown>,
): PathMismatch[] {
  const root = escapeRegExp(rootIdentifier);
  const chainPattern = new RegExp(`\\b${root}((?:\\s*\\.\\s*${IDENTIFIER})+)`, 'g');
  const mismatches: PathMismatch[] = [];
  const seen = new Set<string>();
  for (const match of condition.matchAll(chainPattern)) {
    const segments = [...(match[1] ?? '').matchAll(new RegExp(`\\.\\s*(${IDENTIFIER})`, 'g'))]
      .map((segment) => segment[1])
      .filter((segment): segment is string => Boolean(segment));
    if (segments.length === 0) continue;
    const resolved = resolvePropertyChain(artifact, segments);
    let mismatch = resolved.mismatch;
    if (!mismatch && resolved.found) {
      const exact = `${root}${segments.map((segment) => `\\s*\\.\\s*${escapeRegExp(segment)}`).join('')}`;
      if (new RegExp(`Array\\s*\\.\\s*isArray\\s*\\(\\s*${exact}\\s*\\)`).test(condition)
          && !Array.isArray(resolved.value)) {
        mismatch = {
          path: segments.join('.'),
          kind: 'type',
          actualType: valueType(resolved.value),
          expectedType: 'array',
        };
      }
    }
    if (!mismatch) continue;
    const key = `${mismatch.kind}\0${mismatch.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mismatches.push(mismatch);
  }
  return mismatches;
}

function resolvePropertyChain(
  artifact: Record<string, unknown>,
  segments: string[],
): { found: boolean; value?: unknown; mismatch?: PathMismatch } {
  let current: unknown = artifact;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    if (!isObjectLike(current)) {
      return {
        found: false,
        mismatch: {
          path: segments.slice(0, index + 1).join('.'),
          kind: 'parent-type',
          actualType: valueType(current),
          expectedType: 'object',
        },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return {
        found: false,
        mismatch: {
          path: segments.slice(0, index + 1).join('.'),
          kind: 'missing',
          actualType: 'missing',
          expectedType: 'present',
        },
      };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function staticStrings(source: string): string[] {
  const values: string[] = [];
  const pattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[0]) continue;
    const value = parseStaticString(match[0]);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function parseSimpleString(literal: string): string | undefined {
  if (literal.length < 2) return undefined;
  const quote = literal[0];
  if ((quote !== '"' && quote !== '\'') || literal.at(-1) !== quote) return undefined;
  const value = literal.slice(1, -1);
  return value.includes('\\') ? undefined : value;
}

function parseStaticString(literal: string): string | undefined {
  if (literal.length < 2) return undefined;
  const quote = literal[0];
  if ((quote !== '"' && quote !== '\'') || literal.at(-1) !== quote) return undefined;
  let value = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const char = literal[index];
    if (char !== '\\') {
      value += char;
      continue;
    }
    const escaped = literal[index + 1];
    if (escaped === undefined) return undefined;
    const decoded: Record<string, string> = {
      '\\': '\\',
      '"': '"',
      '\'': '\'',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (!Object.prototype.hasOwnProperty.call(decoded, escaped)) return undefined;
    value += decoded[escaped];
    index += 1;
  }
  return value;
}

function matchCount(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
