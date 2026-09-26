import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { discoverProjectValidation } from './project-validation.js';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.py', '.ts', '.tsx']);
const DEFAULT_TEST_ROOTS = ['test', 'tests', 'spec', '__tests__'] as const;
const SKIP_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'dist', 'build', 'node_modules', '.venv', 'venv']);
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface ValidationPlanStage {
  id: string;
  depends_on: readonly string[];
  scope?: readonly string[];
}

export interface LiteralNegativePathAssertion {
  sourcePath: string;
  line: number;
  assertionPath: string;
  syntax: 'python_exists' | 'node_exists_sync';
  evidence: string;
}

export interface ValidationPlanConflict {
  kind: 'negative_path_assertion_future_scope';
  advisoryId: string;
  assertionPath: string;
  assertionSource: string;
  assertionLine: number;
  stageId: string;
  scope: string;
  credibleAssertionOwner: null;
  message: string;
}

export interface ValidationPlanConflictInspection {
  sourceFiles: string[];
  sourceBytes: number;
  truncated: boolean;
  assertions: LiteralNegativePathAssertion[];
  conflicts: ValidationPlanConflict[];
}

function normalizedProjectPath(value: string): string | undefined {
  const normalized = posix.normalize(value.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return undefined;
  return normalized;
}

function extension(path: string): string {
  const basename = posix.basename(path);
  const dot = basename.lastIndexOf('.');
  return dot < 0 ? '' : basename.slice(dot).toLowerCase();
}

function quotedMembers(value: string): string[] {
  return [...value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter(Boolean);
}

function configuredTestRoots(projectDir: string): string[] {
  const roots = new Set<string>();
  for (const candidate of DEFAULT_TEST_ROOTS) {
    try {
      if (lstatSync(join(projectDir, candidate)).isDirectory()) roots.add(candidate);
    } catch { /* absent conventional root */ }
  }
  try {
    const pyproject = readFileSync(join(projectDir, 'pyproject.toml'), 'utf-8');
    for (const match of pyproject.matchAll(/\btestpaths\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const member of quotedMembers(match[1])) {
        const normalized = normalizedProjectPath(member);
        if (normalized) roots.add(normalized);
      }
    }
  } catch { /* no Python configuration */ }
  for (const name of [
    'vitest.config.ts', 'vitest.config.tsx', 'vitest.config.mts', 'vitest.config.cts',
    'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  ]) {
    try {
      const config = readFileSync(join(projectDir, name), 'utf-8');
      for (const match of config.matchAll(/\binclude\s*:\s*\[([\s\S]*?)\]/g)) {
        for (const member of quotedMembers(match[1])) {
          const prefix = member.replace(/\\/g, '/').split(/[*?[{]/, 1)[0].replace(/\/$/, '');
          const normalized = normalizedProjectPath(prefix || '.');
          if (normalized) roots.add(normalized);
        }
      }
    } catch { /* no config under this spelling */ }
  }
  return [...roots].sort();
}

function validationSourceFiles(projectDir: string): string[] {
  if (!discoverProjectValidation(projectDir).commands.some((command) => command.role === 'test')) return [];
  const files = new Set<string>();
  const walk = (absolute: string, prefix: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child, path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(path))) files.add(path);
    }
  };
  for (const root of configuredTestRoots(projectDir)) {
    const absolute = join(projectDir, root);
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, root);
      else if (stat.isFile() && SOURCE_EXTENSIONS.has(extension(root))) files.add(root);
    } catch { /* configured root is currently absent */ }
  }
  return [...files].sort();
}

function projectRelativeAbsolute(projectDir: string, absolute: string): string | undefined {
  const value = relative(resolve(projectDir), resolve(absolute));
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return normalizedProjectPath(value.split(sep).join('/'));
}

function stripOuterParentheses(value: string): string {
  let result = value.trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < result.length; index++) {
      if (result[index] === '(') depth++;
      else if (result[index] === ')') depth--;
      if (depth === 0) {
        closesAtEnd = index === result.length - 1;
        break;
      }
    }
    if (!closesAtEnd) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function pythonBasePath(
  expression: string,
  projectDir: string,
  sourcePath: string,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  const value = stripOuterParentheses(expression);
  const variable = /^([A-Za-z_]\w*)$/.exec(value)?.[1];
  if (variable) return variables.get(variable);
  const literalPath = /^Path\(\s*(["'])([^"']+)\1\s*\)$/.exec(value)?.[2];
  if (literalPath) {
    const absolute = isAbsolute(literalPath) ? literalPath : resolve(projectDir, literalPath);
    return projectRelativeAbsolute(projectDir, absolute);
  }
  const fileParent = /^Path\(__file__\)\.resolve\(\)\.parents\[(\d+)\]$/.exec(value);
  if (fileParent) {
    let current = resolve(projectDir, sourcePath);
    for (let index = 0; index <= Number(fileParent[1]); index++) current = resolve(current, '..');
    return projectRelativeAbsolute(projectDir, current) ?? (resolve(current) === resolve(projectDir) ? '' : undefined);
  }
  return undefined;
}

function evaluatePythonPath(
  expression: string,
  projectDir: string,
  sourcePath: string,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  const parts: string[] = [];
  let part = '';
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (const character of stripOuterParentheses(expression)) {
    if (quote) {
      part += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      part += character;
    } else if (character === '(' || character === '[') {
      depth++;
      part += character;
    } else if (character === ')' || character === ']') {
      depth--;
      part += character;
    } else if (character === '/' && depth === 0) {
      parts.push(part.trim());
      part = '';
    } else {
      part += character;
    }
  }
  parts.push(part.trim());
  if (parts.length === 0) return undefined;
  const base = pythonBasePath(parts[0], projectDir, sourcePath, variables);
  if (base === undefined) return undefined;
  const segments: string[] = base ? [base] : [];
  for (const part of parts.slice(1)) {
    const literal = /^(["'])([^"']+)\1$/.exec(stripOuterParentheses(part))?.[2];
    if (!literal || literal.includes('/') || literal.includes('\\')) return undefined;
    segments.push(literal);
  }
  // Keep the project root as an internal empty base so a later literal join
  // (for example ROOT / "artifacts") remains decidable. It is never emitted
  // as an assertion path because callers require a non-empty final value.
  return segments.length === 0 ? '' : normalizedProjectPath(segments.join('/'));
}

function pythonNegativeAssertions(projectDir: string, sourcePath: string, source: string): LiteralNegativePathAssertion[] {
  const variables = new Map<string, string>();
  const assertions: LiteralNegativePathAssertion[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(line);
    if (assignment) {
      const path = evaluatePythonPath(assignment[2], projectDir, sourcePath, variables);
      if (path === undefined) variables.delete(assignment[1]);
      else variables.set(assignment[1], path);
    }
    const assertion = /^\s*assert\s+not\s+(.+?)\.exists\(\)\s*(?:,.*)?$/.exec(line);
    if (!assertion) continue;
    const assertionPath = evaluatePythonPath(assertion[1], projectDir, sourcePath, variables);
    if (!assertionPath) continue;
    assertions.push({
      sourcePath,
      line: index + 1,
      assertionPath,
      syntax: 'python_exists',
      evidence: line.trim(),
    });
  }
  return assertions;
}

/** Mark offsets that are not JavaScript/TypeScript comments. The bounded scan
 * intentionally retains assertion literals used to generate configured test
 * fixtures (part of the established repository population), but a leading
 * assertion call inside comment trivia is never executable validation. */
function nodeCodeOffsets(source: string): Uint8Array {
  const code = new Uint8Array(source.length);
  let state: 'code' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment' = 'code';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line_comment') {
      if (character === '\n' || character === '\r') {
        state = 'code';
        code[index] = 1;
      }
      continue;
    }
    if (state === 'block_comment') {
      if (character === '*' && next === '/') {
        index++;
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      // Keep literal contents eligible for the established generated-test
      // fixture scan while still preventing comment markers inside a literal
      // from changing lexical state.
      code[index] = 1;
      if (character === '\\') {
        if (index + 1 < source.length) code[index + 1] = 1;
        index++;
        continue;
      }
      if ((state === 'single' && character === "'")
          || (state === 'double' && character === '"')
          || (state === 'template' && character === '`')) state = 'code';
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line_comment';
      index++;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block_comment';
      index++;
      continue;
    }
    if (character === "'") {
      state = 'single';
      continue;
    }
    if (character === '"') {
      state = 'double';
      continue;
    }
    if (character === '`') {
      state = 'template';
      continue;
    }
    code[index] = 1;
  }
  return code;
}

function nodeNegativeAssertions(sourcePath: string, source: string): LiteralNegativePathAssertion[] {
  const assertions: LiteralNegativePathAssertion[] = [];
  const codeOffsets = nodeCodeOffsets(source);
  const patterns = [
    /expect\(\s*(?:fs\.)?existsSync\(\s*(["'])([^"']+)\1\s*\)\s*\)\.toBe\(false\)/g,
    /(?:assert|ok)\(\s*!\s*(?:fs\.)?existsSync\(\s*(["'])([^"']+)\1\s*\)\s*\)/g,
  ];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineStarts.push(index + 1);
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const assertionPath = normalizedProjectPath(match[2]);
      if (!assertionPath) continue;
      const offset = match.index ?? 0;
      if (codeOffsets[offset] !== 1) continue;
      let low = 0;
      let high = lineStarts.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle + 1;
        else high = middle;
      }
      assertions.push({
        sourcePath,
        line: low,
        assertionPath,
        syntax: 'node_exists_sync',
        evidence: match[0],
      });
    }
  }
  return assertions;
}

function scopeMatchesPath(rawScope: string, path: string): boolean {
  const scope = rawScope.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!scope || scope.includes('..') || isAbsolute(scope)) return false;
  if (!/[?*[{]/.test(scope)) {
    const value = scope.replace(/\/$/, '');
    return path === value || path.startsWith(`${value}/`);
  }
  if (scope.endsWith('/**')) {
    const tree = scope.slice(0, -3);
    if (tree && !/[?*[{]/.test(tree) && (path === tree || path.startsWith(`${tree}/`))) return true;
  }
  try { return posix.matchesGlob(path, scope); } catch { return false; }
}

function transitivelyDependsOn(stageId: string, ancestorId: string, stages: ReadonlyMap<string, ValidationPlanStage>): boolean {
  const seen = new Set<string>();
  const queue = [...(stages.get(stageId)?.depends_on ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next === ancestorId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(stages.get(next)?.depends_on ?? []));
  }
  return false;
}

export function inspectValidationPlanConflicts(
  projectDir: string,
  stages: readonly ValidationPlanStage[],
): ValidationPlanConflictInspection {
  const sourceFiles = validationSourceFiles(projectDir);
  const assertions: LiteralNegativePathAssertion[] = [];
  const scannedFiles: string[] = [];
  let sourceBytes = 0;
  let truncated = false;
  for (const sourcePath of sourceFiles) {
    let source: string;
    try { source = readFileSync(join(projectDir, sourcePath), 'utf-8'); } catch { continue; }
    const bytes = Buffer.byteLength(source, 'utf-8');
    if (bytes > MAX_FILE_BYTES || sourceBytes + bytes > MAX_SOURCE_BYTES) {
      truncated = true;
      continue;
    }
    sourceBytes += bytes;
    scannedFiles.push(sourcePath);
    assertions.push(...(extension(sourcePath) === '.py'
      ? pythonNegativeAssertions(projectDir, sourcePath, source)
      : nodeNegativeAssertions(sourcePath, source)));
  }

  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const conflicts: ValidationPlanConflict[] = [];
  for (const assertion of assertions) {
    for (const stage of stages) {
      const scope = stage.scope?.find((candidate) => scopeMatchesPath(candidate, assertion.assertionPath));
      if (!scope) continue;
      const credibleOwner = stages.find((candidate) => (
        candidate.scope?.some((candidateScope) => scopeMatchesPath(candidateScope, assertion.sourcePath))
        && (candidate.id === stage.id || transitivelyDependsOn(stage.id, candidate.id, byId))
      ));
      if (credibleOwner) continue;
      const advisoryId = createHash('sha256')
        .update(`${assertion.sourcePath}\0${assertion.line}\0${assertion.assertionPath}\0${stage.id}\0${scope}`)
        .digest('hex')
        .slice(0, 20);
      conflicts.push({
        kind: 'negative_path_assertion_future_scope',
        advisoryId,
        assertionPath: assertion.assertionPath,
        assertionSource: assertion.sourcePath,
        assertionLine: assertion.line,
        stageId: stage.id,
        scope,
        credibleAssertionOwner: null,
        message: `Validation assertion ${assertion.sourcePath}:${assertion.line} requires ${assertion.assertionPath} to remain absent, but stage ${stage.id} may write it through scope ${JSON.stringify(scope)}; admission remains advisory because scope is capability, not proof of a write`,
      });
    }
  }
  return {
    sourceFiles: scannedFiles,
    sourceBytes,
    truncated,
    assertions,
    conflicts,
  };
}
