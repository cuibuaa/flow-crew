import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

type Writer = { write(chunk: string): unknown };

export type AuditClassification = 'confirmed' | 'contradicted' | 'not_checkable';
export type AuditClaimKind =
  | 'line_count'
  | 'file_count'
  | 'section_count'
  | 'validation_command'
  | 'json_field'
  | 'unsupported';

export interface AuditCommandRequest {
  command: string;
  args: string[];
  cwd: string;
}

export interface AuditCommandResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type AuditCommandRunner = (
  request: AuditCommandRequest,
) => Promise<AuditCommandResponse> | AuditCommandResponse;

export interface AuditFileSystem {
  exists(path: string): boolean;
  readText(path: string): string;
  readDirectory(path: string): string[];
  realpath(path: string): string;
  stat(path: string): { isDirectory(): boolean; isFile(): boolean };
}

export interface AuditReportDependencies {
  cwd?: string;
  fs?: AuditFileSystem;
  runCommand?: AuditCommandRunner;
  stdout?: Writer;
  stderr?: Writer;
}

interface ResolvedAuditDependencies {
  cwd: string;
  fs: AuditFileSystem;
  runCommand: AuditCommandRunner;
  stdout: Writer;
  stderr: Writer;
}

export interface ParsedAuditReportArgs {
  help: boolean;
  json: boolean;
  report?: string;
  runDir?: string;
}

interface ExtractedCountClaim {
  kind: 'line_count' | 'file_count' | 'section_count';
  line: number;
  source: string;
  path: string;
  expected: number;
}

interface ExtractedCommandClaim {
  kind: 'validation_command';
  line: number;
  source: string;
  command: string;
  expected: {
    exitCode: number;
    tallies: Record<string, number>;
  };
}

interface ExtractedJsonClaim {
  kind: 'json_field';
  line: number;
  source: string;
  path: string;
  field: string;
  expected: string | number | boolean | null;
}

interface ExtractedUnsupportedClaim {
  kind: 'unsupported';
  line: number;
  source: string;
  reason: string;
}

export type ExtractedAuditClaim =
  | ExtractedCountClaim
  | ExtractedCommandClaim
  | ExtractedJsonClaim
  | ExtractedUnsupportedClaim;

export interface AuditedClaim {
  id: string;
  kind: AuditClaimKind;
  line: number;
  source: string;
  classification: AuditClassification;
  expected?: unknown;
  observed?: unknown;
  path?: string;
  resolvedPath?: string;
  field?: string;
  command?: string;
  reason: string;
}

export interface AuditReportResult {
  version: 1;
  reportPath: string;
  runDir: string;
  projectDir: string;
  claims: AuditedClaim[];
  totals: Record<AuditClassification, number>;
}

const nodeAuditFileSystem: AuditFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf-8'),
  readDirectory: (path) => readdirSync(path),
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path),
};

function bounded(value: string, maximum = 8 * 1024 * 1024): string {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length <= maximum) return value;
  return bytes.subarray(bytes.length - maximum).toString('utf-8');
}

const runAuditCommand: AuditCommandRunner = (request) => new Promise((settle) => {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1_000,
  });
  let stdout = '';
  let stderr = '';
  let launchError: string | undefined;
  let settled = false;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = bounded(stdout + chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = bounded(stderr + chunk.toString());
  });
  child.once('error', (error) => {
    launchError = error.message;
  });
  child.once('close', (code, signal) => {
    if (settled) return;
    settled = true;
    settle({
      exitCode: code,
      stdout,
      stderr,
      ...(launchError ? { error: launchError } : {}),
      ...(!launchError && signal ? { error: `command ended by signal ${signal}` } : {}),
    });
  });
});

function resolveDependencies(overrides: AuditReportDependencies): ResolvedAuditDependencies {
  return {
    cwd: resolve(overrides.cwd ?? process.cwd()),
    fs: overrides.fs ?? nodeAuditFileSystem,
    runCommand: overrides.runCommand ?? runAuditCommand,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function optionValue(args: string[], index: number, option: string): { value: string; consumed: number } {
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

export function parseAuditReportArgs(args: string[]): ParsedAuditReportArgs {
  const parsed: ParsedAuditReportArgs = { help: false, json: false };
  const seen = new Set<'report' | 'run-dir'>();
  const start = args[0] === 'audit-report' ? 1 : 0;
  for (let index = start; index < args.length;) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      parsed.json = true;
      index += 1;
      continue;
    }
    const name = (['report', 'run-dir'] as const)
      .find((candidate) => argument === `--${candidate}` || argument.startsWith(`--${candidate}=`));
    if (!name) throw new Error(`unknown audit-report option: ${argument}`);
    if (seen.has(name)) throw new Error(`--${name} may be specified only once`);
    const value = optionValue(args, index, `--${name}`);
    if (name === 'report') parsed.report = value.value;
    else parsed.runDir = value.value;
    seen.add(name);
    index += value.consumed;
  }
  if (!parsed.help) {
    if (!parsed.report) throw new Error('--report is required');
    if (!parsed.runDir) throw new Error('--run-dir is required');
  }
  return parsed;
}

export function auditReportUsage(): string {
  return [
    'Usage: flowcrew audit-report --report <path> --run-dir <path> [--json]',
    'Re-derives supported numeric/path claims and reports confirmed, contradicted, or not_checkable.',
  ].join('\n');
}

function pathLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('project:')
    || trimmed.startsWith('run:')
    || trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || trimmed.includes('/')
    || /(?:^|\.)[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_-]*\/?$/.test(trimmed);
}

function trimValueToken(value: string): string {
  return value.trim().replace(/[.;,]$/, '').trim();
}

function scalarValue(raw: string): string | number | boolean | null | undefined {
  let value = trimValueToken(raw);
  if (value.startsWith('`') && value.endsWith('`') && value.length >= 2) value = value.slice(1, -1).trim();
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return undefined;
}

function normalizeTally(label: string): string | undefined {
  const normalized = label.toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'passing') return 'passed';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'failing') return 'failed';
  if (normalized === 'skip' || normalized === 'skipped') return 'skipped';
  if (normalized === 'error' || normalized === 'errors') return 'errors';
  return undefined;
}

export function extractTallies(text: string): Record<string, number> {
  const tallies: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const found: Array<{ label: string; value: number; index: number }> = [];
    const numberFirst = /\b(\d+)\s+(pass(?:ed|ing)?|fail(?:ed|ing)?|skipped?|errors?)\b/gi;
    for (const match of line.matchAll(numberFirst)) {
      found.push({ label: match[2], value: Number(match[1]), index: match.index ?? 0 });
    }
    const labelFirst = /\b(pass(?:ed|ing)?|fail(?:ed|ing)?|skipped?|errors?)(?:\s*[:=]\s*|\s+)(\d+)\b/gi;
    for (const match of line.matchAll(labelFirst)) {
      found.push({ label: match[1], value: Number(match[2]), index: match.index ?? 0 });
    }
    found.sort((left, right) => left.index - right.index);
    for (const item of found) {
      const label = normalizeTally(item.label);
      if (label) tallies[label] = item.value;
    }
  }
  return tallies;
}

function parseCountClaim(line: string, lineNumber: number): ExtractedCountClaim | undefined {
  const patterns = [
    /`(?<path>[^`]+)`\s*(?:has|contains|:|=|—|-)\s*(?<count>\d+)\s+(?<unit>lines?|files?|sections?)\b/i,
    /`(?<path>[^`]+)`\s+(?<count>\d+)\s+(?<unit>lines?|files?|sections?)\b/i,
    /(?<count>\d+)\s+(?<unit>lines?|files?|sections?)\s+(?:in|under|within|at)\s+`(?<path>[^`]+)`/i,
    /(?<unit>line|file|section)\s+count\s+(?:for|in|of)\s+`(?<path>[^`]+)`\s*(?:is|=|:)?\s*(?<count>\d+)/i,
    /`(?<path>[^`]+)`\s+(?<unit>line|file|section)\s+count\s*(?:is|=|:)?\s*(?<count>\d+)/i,
    /`(?<path>[^`]+)`[^`\r\n]*?\b(?<count>\d+)\s*(?:\|\s*)?(?<unit>lines?|files?|sections?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (!match?.groups) continue;
    const unit = match.groups.unit.toLowerCase();
    const kind: ExtractedCountClaim['kind'] = unit.startsWith('line')
      ? 'line_count'
      : unit.startsWith('file') ? 'file_count' : 'section_count';
    return {
      kind,
      line: lineNumber,
      source: line,
      path: match.groups.path.trim(),
      expected: Number(match.groups.count),
    };
  }
  return undefined;
}

function parseJsonClaim(line: string, lineNumber: number): ExtractedJsonClaim | undefined {
  const patterns = [
    /`(?<path>[^`]+)`\s+(?:JSON\s+)?field\s+`(?<field>[^`]+)`\s*(?:is|=|:)\s*(?<value>`[^`]*`|"[^"]*"|'[^']*'|[^\s,;]+)/i,
    /(?:JSON\s+)?field\s+`(?<field>[^`]+)`\s+(?:of|in|from)\s+`(?<path>[^`]+)`\s*(?:is|=|:)\s*(?<value>`[^`]*`|"[^"]*"|'[^']*'|[^\s,;]+)/i,
    /`(?<path>[^`]+)`\s+attributes?\s+(?<value>`[^`]*`|"[^"]*"|'[^']*'|[^\s,;]+)\s+to\s+(?:JSON\s+)?field\s+`(?<field>[^`]+)`/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (!match?.groups || !pathLike(match.groups.path)) continue;
    const expected = scalarValue(match.groups.value);
    if (expected === undefined) continue;
    return {
      kind: 'json_field',
      line: lineNumber,
      source: line,
      path: match.groups.path.trim(),
      field: match.groups.field.trim(),
      expected,
    };
  }
  return undefined;
}

function exitCodeFrom(text: string): number | undefined {
  const match = /\bexit(?:\s+code)?\s*(?:was|is|=|:)?\s*`?(-?\d+)`?/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function commandFromLine(line: string): string | undefined {
  const explicit = /\b(?:validation\s+)?command\s*(?:is|=|:)?\s*`([^`]+)`/i.exec(line);
  if (explicit) return explicit[1].trim();
  const heading = /^\s{0,3}#{1,6}\s+`([^`]+)`/.exec(line);
  if (heading) return heading[1].trim();
  const bullet = /^\s*[-*+]\s+`([^`]+)`\s*:?\s*$/.exec(line);
  if (bullet) return bullet[1].trim();
  const beforeExit = /`([^`]+)`[^`]*\bexit(?:\s+code)?\b/i.exec(line);
  return beforeExit?.[1].trim();
}

function commandBlock(lines: string[], index: number): {
  command: string;
  expectedExit: number;
  tallies: Record<string, number>;
  source: string;
  usedThrough: number;
} | undefined {
  const own = lines[index];
  const command = commandFromLine(own);
  if (!command) return undefined;
  const inlineExit = exitCodeFrom(own);
  if (inlineExit !== undefined) {
    return {
      command,
      expectedExit: inlineExit,
      tallies: extractTallies(own),
      source: own,
      usedThrough: index,
    };
  }
  const gathered = [own];
  let expectedExit: number | undefined;
  let usedThrough = index;
  for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 12); lookahead += 1) {
    const next = lines[lookahead];
    if (/^\s{0,3}#{1,6}\s+/.test(next)) break;
    gathered.push(next);
    usedThrough = lookahead;
    expectedExit ??= exitCodeFrom(next);
    if (expectedExit !== undefined && next.trim() === '' && lookahead > index + 2) break;
  }
  if (expectedExit === undefined) return undefined;
  const source = gathered.join('\n');
  return { command, expectedExit, tallies: extractTallies(source), source, usedThrough };
}

function unsupportedCandidate(line: string): boolean {
  if (!/[-+]?\d/.test(line)) return false;
  const ticks = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const outsideTicks = line.replace(/`[^`]*`/g, ' ');
  const unquotedPaths = [...outsideTicks.matchAll(
    /(?:^|[\s([{"'=])((?:(?:project|run):)?(?:\/|\.\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|(?:(?:project|run):)?[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_-]*)(?=$|[\s)\]}"',;:])/g,
  )].map((match) => match[1]);
  const numericEvidence = /\b(lines?|files?|sections?|count|field|value|percentile|median|mean|exit)\b/i.test(line);
  const commandEvidence = /\b(exit|pass(?:ed|ing)?|fail(?:ed|ing)?|skipped?|errors?)\b/i.test(line);
  return ((ticks.some(pathLike) || unquotedPaths.some(pathLike)) && numericEvidence)
    || (ticks.length > 0 && commandEvidence);
}

/**
 * Extract supported claim forms while retaining path-bearing numeric sentences that need a
 * clearer attribution. Unsupported candidates are evidence, not silently discarded text.
 */
export function extractAuditClaims(report: string): ExtractedAuditClaim[] {
  const lines = report.split(/\r?\n/);
  const claims: ExtractedAuditClaim[] = [];
  const used = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const count = parseCountClaim(line, index + 1);
    if (count) {
      claims.push(count);
      used.add(index);
      continue;
    }
    const json = parseJsonClaim(line, index + 1);
    if (json) {
      claims.push(json);
      used.add(index);
      continue;
    }
    const command = commandBlock(lines, index);
    if (command) {
      claims.push({
        kind: 'validation_command',
        line: index + 1,
        source: command.source,
        command: command.command,
        expected: { exitCode: command.expectedExit, tallies: command.tallies },
      });
      for (let covered = index; covered <= command.usedThrough; covered += 1) used.add(covered);
      index = command.usedThrough;
    }
  }
  lines.forEach((line, index) => {
    if (!used.has(index) && unsupportedCandidate(line)) {
      claims.push({
        kind: 'unsupported',
        line: index + 1,
        source: line,
        reason: 'numeric/path-bearing sentence does not use a supported unambiguous claim form',
      });
    }
  });
  return claims.sort((left, right) => left.line - right.line);
}

interface AuditRoots {
  run: string;
  project: string;
}

interface ResolvedClaimPath {
  path?: string;
  root?: string;
  reason?: string;
}

function canonicalDirectory(path: string, label: string, fs: AuditFileSystem): string {
  const requested = resolve(path);
  if (!fs.exists(requested)) throw new Error(`${label} does not exist: ${requested}`);
  if (!fs.stat(requested).isDirectory()) throw new Error(`${label} is not a directory: ${requested}`);
  return fs.realpath(requested);
}

function canonicalFileInsideRoots(
  path: string,
  roots: AuditRoots,
  fs: AuditFileSystem,
  label: string,
): string {
  const requested = resolve(path);
  if (!fs.exists(requested)) throw new Error(`${label} does not exist: ${requested}`);
  if (!fs.stat(requested).isFile()) throw new Error(`${label} is not a file: ${requested}`);
  const canonical = fs.realpath(requested);
  if (!within(roots.project, canonical) && !within(roots.run, canonical)) {
    throw new Error(`${label} resolves outside the project and run roots: ${canonical}`);
  }
  return canonical;
}

function stripRootPrefix(raw: string): { selector?: keyof AuditRoots; path: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('project:')) return { selector: 'project', path: trimmed.slice('project:'.length) };
  if (trimmed.startsWith('run:')) return { selector: 'run', path: trimmed.slice('run:'.length) };
  return { path: trimmed };
}

function resolveClaimPath(raw: string, roots: AuditRoots, fs: AuditFileSystem): ResolvedClaimPath {
  if (!raw || raw.includes('\0')) return { reason: 'path is empty or contains NUL' };
  const prefixed = stripRootPrefix(raw);
  const candidates: Array<{ lexical: string; root: string }> = [];
  if (isAbsolute(prefixed.path)) {
    const lexical = resolve(prefixed.path);
    for (const root of Object.values(roots)) {
      if (within(root, lexical)) candidates.push({ lexical, root });
    }
    if (candidates.length === 0) return { reason: 'absolute path is outside the project and run roots' };
  } else {
    const selectedRoots = prefixed.selector ? [roots[prefixed.selector]] : [roots.project, roots.run];
    for (const root of selectedRoots) {
      const lexical = resolve(root, prefixed.path);
      if (!within(root, lexical)) return { reason: 'relative path escapes an allowed root' };
      candidates.push({ lexical, root });
    }
  }
  const existing = candidates.flatMap((candidate) => {
    if (!fs.exists(candidate.lexical)) return [];
    try {
      const canonical = fs.realpath(candidate.lexical);
      if (!within(candidate.root, canonical)) return [];
      return [{ path: canonical, root: candidate.root }];
    } catch {
      return [];
    }
  });
  const unique = [...new Map(existing.map((item) => [item.path, item])).values()];
  if (unique.length === 0) return { reason: 'path is absent or resolves outside its allowed root' };
  if (unique.length > 1) return { reason: 'relative path exists in both project and run roots; use project: or run:' };
  return unique[0];
}

function logicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  const separators = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return separators + (/\r$|\n$/.test(text) ? 0 : 1);
}

function markdownSectionCount(text: string): number {
  let fenced: '`' | '~' | undefined;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0] as '`' | '~' | undefined;
    if (fence) {
      if (!fenced) fenced = fence;
      else if (fenced === fence) fenced = undefined;
      continue;
    }
    if (!fenced && /^\s{0,3}#{1,6}(?:\s+|$)/.test(line)) count += 1;
  }
  return count;
}

function recursiveFileCount(
  path: string,
  root: string,
  fs: AuditFileSystem,
  seen = new Set<string>(),
): number {
  const canonical = fs.realpath(path);
  if (!within(root, canonical)) throw new Error('directory entry resolves outside its allowed root');
  if (seen.has(canonical)) return 0;
  seen.add(canonical);
  const stat = fs.stat(canonical);
  if (stat.isFile()) return 1;
  if (!stat.isDirectory()) return 0;
  let count = 0;
  for (const name of fs.readDirectory(canonical)) {
    count += recursiveFileCount(join(canonical, name), root, fs, seen);
  }
  return count;
}

interface ParsedArgv {
  argv?: string[];
  reason?: string;
}

/** A deliberately small POSIX-like tokenizer; shell operators are rejected, never emulated. */
export function parseDirectArgv(command: string): ParsedArgv {
  const argv: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (/[|&;<>()>`]/.test(character)) return { reason: `shell operator ${JSON.stringify(character)} is not argv-safe` };
    token += character;
    tokenStarted = true;
  }
  if (escaping) return { reason: 'command ends with an incomplete escape' };
  if (quote) return { reason: 'command has an unterminated quote' };
  if (tokenStarted) argv.push(token);
  if (argv.length === 0 || !argv[0]) return { reason: 'command is empty' };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) return { reason: 'environment assignments require a shell and are not checkable' };
  return { argv };
}

function fieldSegments(field: string): string[] | undefined {
  if (!field) return undefined;
  if (field.startsWith('/')) {
    return field.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  const normalized = field.replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  if (!normalized || normalized.split('.').some((segment) => !segment)) return undefined;
  return normalized.split('.');
}

function jsonFieldValue(document: unknown, field: string): { found: boolean; value?: unknown; reason?: string } {
  const segments = fieldSegments(field);
  if (!segments) return { found: false, reason: 'field is neither a dotted path nor a JSON Pointer' };
  let value = document;
  for (const segment of segments) {
    if (Array.isArray(value) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (index >= value.length) return { found: false, reason: `array index ${segment} is absent` };
      value = value[index];
      continue;
    }
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return { found: false, reason: `field segment ${JSON.stringify(segment)} is absent` };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return { found: true, value };
}

function sameScalar(left: unknown, right: unknown): boolean {
  return (left === null || ['string', 'number', 'boolean'].includes(typeof left))
    && (right === null || ['string', 'number', 'boolean'].includes(typeof right))
    && Object.is(left, right);
}

function audited(
  extracted: ExtractedAuditClaim,
  classification: AuditClassification,
  reason: string,
  extra: Partial<AuditedClaim> = {},
): AuditedClaim {
  return {
    id: '',
    kind: extracted.kind,
    line: extracted.line,
    source: extracted.source,
    classification,
    reason,
    ...extra,
  };
}

async function auditOne(
  claim: ExtractedAuditClaim,
  roots: AuditRoots,
  deps: ResolvedAuditDependencies,
): Promise<AuditedClaim> {
  if (claim.kind === 'unsupported') {
    return audited(claim, 'not_checkable', claim.reason);
  }
  if (claim.kind === 'validation_command') {
    const parsed = parseDirectArgv(claim.command);
    if (!parsed.argv) {
      return audited(claim, 'not_checkable', parsed.reason ?? 'command cannot be tokenized', {
        command: claim.command,
        expected: claim.expected,
      });
    }
    let response: AuditCommandResponse;
    try {
      response = await deps.runCommand({ command: parsed.argv[0], args: parsed.argv.slice(1), cwd: roots.project });
    } catch (error) {
      return audited(claim, 'not_checkable', `command runner threw: ${errorMessage(error)}`, {
        command: claim.command,
        expected: claim.expected,
      });
    }
    if (response.exitCode === null || response.error) {
      return audited(claim, 'not_checkable', response.error ?? 'command ended without an exit code', {
        command: claim.command,
        expected: claim.expected,
      });
    }
    const tallies = extractTallies(`${response.stdout ?? ''}\n${response.stderr ?? ''}`);
    const observed = { exitCode: response.exitCode, tallies };
    const contradictions: string[] = [];
    if (response.exitCode !== claim.expected.exitCode) {
      contradictions.push(`exit code expected ${claim.expected.exitCode}, observed ${response.exitCode}`);
    }
    const missing: string[] = [];
    for (const [label, expected] of Object.entries(claim.expected.tallies)) {
      const actual = tallies[label];
      if (actual === undefined) missing.push(label);
      else if (actual !== expected) contradictions.push(`${label} expected ${expected}, observed ${actual}`);
    }
    if (contradictions.length > 0) {
      return audited(claim, 'contradicted', contradictions.join('; '), {
        command: claim.command, expected: claim.expected, observed,
      });
    }
    if (missing.length > 0) {
      return audited(claim, 'not_checkable', `command output did not expose claimed tallies: ${missing.join(', ')}`, {
        command: claim.command, expected: claim.expected, observed,
      });
    }
    return audited(claim, 'confirmed', 'exit code and every claimed tally match', {
      command: claim.command, expected: claim.expected, observed,
    });
  }

  const resolution = resolveClaimPath(claim.path, roots, deps.fs);
  if (!resolution.path || !resolution.root) {
    return audited(claim, 'not_checkable', resolution.reason ?? 'path cannot be resolved', {
      path: claim.path,
      expected: claim.expected,
      ...(claim.kind === 'json_field' ? { field: claim.field } : {}),
    });
  }
  if (claim.kind === 'json_field') {
    let document: unknown;
    try {
      if (!deps.fs.stat(resolution.path).isFile()) throw new Error('JSON artifact path is not a file');
      document = JSON.parse(deps.fs.readText(resolution.path));
    } catch (error) {
      return audited(claim, 'not_checkable', `cannot read JSON artifact: ${errorMessage(error)}`, {
        path: claim.path, resolvedPath: resolution.path, field: claim.field, expected: claim.expected,
      });
    }
    const field = jsonFieldValue(document, claim.field);
    if (!field.found) {
      return audited(claim, 'not_checkable', field.reason ?? 'JSON field is absent', {
        path: claim.path, resolvedPath: resolution.path, field: claim.field, expected: claim.expected,
      });
    }
    if (!sameScalar(field.value, claim.expected)) {
      return audited(claim, 'contradicted', 'JSON scalar differs from the attributed value', {
        path: claim.path,
        resolvedPath: resolution.path,
        field: claim.field,
        expected: claim.expected,
        observed: field.value,
      });
    }
    return audited(claim, 'confirmed', 'JSON field matches the attributed scalar', {
      path: claim.path,
      resolvedPath: resolution.path,
      field: claim.field,
      expected: claim.expected,
      observed: field.value,
    });
  }

  let observed: number;
  try {
    if (claim.kind === 'file_count') {
      observed = recursiveFileCount(resolution.path, resolution.root, deps.fs);
    } else {
      if (!deps.fs.stat(resolution.path).isFile()) throw new Error('count target is not a file');
      const text = deps.fs.readText(resolution.path);
      observed = claim.kind === 'line_count' ? logicalLineCount(text) : markdownSectionCount(text);
    }
  } catch (error) {
    return audited(claim, 'not_checkable', `cannot derive count: ${errorMessage(error)}`, {
      path: claim.path, resolvedPath: resolution.path, expected: claim.expected,
    });
  }
  const classification: AuditClassification = observed === claim.expected ? 'confirmed' : 'contradicted';
  return audited(claim, classification, observed === claim.expected
    ? 'derived count matches'
    : `expected ${claim.expected}, observed ${observed}`, {
    path: claim.path,
    resolvedPath: resolution.path,
    expected: claim.expected,
    observed,
  });
}

function readProjectDir(runDir: string, fs: AuditFileSystem): string {
  const statePath = join(runDir, 'run.json');
  if (!fs.exists(statePath)) throw new Error(`run state does not exist: ${statePath}`);
  let state: unknown;
  try {
    state = JSON.parse(fs.readText(statePath));
  } catch (error) {
    throw new Error(`cannot read run state ${statePath}: ${errorMessage(error)}`, { cause: error });
  }
  const projectDir = state && typeof state === 'object'
    ? (state as Record<string, unknown>).projectDir
    : undefined;
  if (typeof projectDir !== 'string' || !projectDir) throw new Error('run.json lacks a string projectDir');
  return canonicalDirectory(projectDir, 'run project directory', fs);
}

/** Execute the report audit without rendering. Only contradictions affect the command exit. */
export async function runAuditReport(
  args: string[],
  overrides: AuditReportDependencies = {},
): Promise<AuditReportResult> {
  const parsed = parseAuditReportArgs(args);
  if (parsed.help) throw new Error('help does not execute audit-report');
  const deps = resolveDependencies(overrides);
  const runDir = canonicalDirectory(resolve(deps.cwd, parsed.runDir as string), 'run directory', deps.fs);
  const projectDir = readProjectDir(runDir, deps.fs);
  const roots = { run: runDir, project: projectDir };
  const reportPath = canonicalFileInsideRoots(resolve(deps.cwd, parsed.report as string), roots, deps.fs, 'report');
  const extracted = extractAuditClaims(deps.fs.readText(reportPath));
  const claims: AuditedClaim[] = [];
  for (const claim of extracted) claims.push(await auditOne(claim, roots, deps));
  claims.forEach((claim, index) => { claim.id = `claim-${index + 1}`; });
  const totals: Record<AuditClassification, number> = {
    confirmed: claims.filter((claim) => claim.classification === 'confirmed').length,
    contradicted: claims.filter((claim) => claim.classification === 'contradicted').length,
    not_checkable: claims.filter((claim) => claim.classification === 'not_checkable').length,
  };
  return { version: 1, reportPath, runDir, projectDir, claims, totals };
}

function displayExpected(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
}

function renderAuditHuman(report: AuditReportResult, writer: Writer): void {
  writer.write(`Audit report: ${report.reportPath}\n`);
  for (const claim of report.claims) {
    const subject = claim.path ?? claim.command ?? claim.kind;
    writer.write(`  ${claim.classification.toUpperCase()} ${claim.id} line ${claim.line} ${JSON.stringify(subject)}: ${claim.reason}`);
    if (claim.expected !== undefined) writer.write(`; expected=${displayExpected(claim.expected)}`);
    if (claim.observed !== undefined) writer.write(`; observed=${displayExpected(claim.observed)}`);
    writer.write('\n');
  }
  writer.write(`Totals: confirmed=${report.totals.confirmed} contradicted=${report.totals.contradicted} not_checkable=${report.totals.not_checkable}\n`);
  writer.write('This command checks claim arithmetic and attribution; it does not judge whether the measured quantity was the right one.\n');
}

export async function cmdAuditReportWithDeps(
  args: string[],
  overrides: AuditReportDependencies,
): Promise<number> {
  const deps = resolveDependencies(overrides);
  let parsed: ParsedAuditReportArgs;
  try {
    parsed = parseAuditReportArgs(args);
    if (parsed.help) {
      deps.stdout.write(`${auditReportUsage()}\n`);
      return 0;
    }
    const report = await runAuditReport(args, overrides);
    if (parsed.json) deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else renderAuditHuman(report, deps.stdout);
    return report.totals.contradicted > 0 ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`audit-report: ${errorMessage(error)}\n`);
    deps.stderr.write(`${auditReportUsage()}\n`);
    return 1;
  }
}

export async function cmdAuditReport(args: string[]): Promise<number> {
  return cmdAuditReportWithDeps(args, {});
}
