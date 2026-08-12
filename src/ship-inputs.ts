import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  isNegatedPathMention,
} from './brief-negation.js';

export type BriefInputAssertionKind = 'row_count' | 'time_span' | 'file_count' | 'sha256';
export type BriefInputAssertionState = 'confirmed' | 'refuted' | 'not_checkable';

export interface BriefInputAssertionDeclaration {
  kind: BriefInputAssertionKind;
  expected: number | string | { start: string; end: string };
  line: number;
  excerpt: string;
}

export interface BriefInputAssertionResult extends BriefInputAssertionDeclaration {
  state: BriefInputAssertionState;
  observed?: number | string | { start: string; end: string };
  reason: string;
}

export interface BriefInputReference {
  path: string;
  line: number;
  assertions: BriefInputAssertionDeclaration[];
}

export interface UnresolvedBriefInputDeclaration {
  value: string;
  line: number;
  reason: string;
}

export interface ParsedBriefInputs {
  references: BriefInputReference[];
  unresolvedInputs: UnresolvedBriefInputDeclaration[];
  unboundAssertions: BriefInputAssertionResult[];
}

export interface BriefPathMention {
  path: string;
  line: number;
  excerpt: string;
}

export interface VerifiedBriefInput {
  path: string;
  line: number;
  resolvedPath: string;
  exists: boolean;
  readable: boolean;
  assertions: BriefInputAssertionResult[];
}

export interface BriefInputVerification {
  inputs: VerifiedBriefInput[];
  unresolvedInputs: UnresolvedBriefInputDeclaration[];
  unboundAssertions: BriefInputAssertionResult[];
}

export interface ShipInputStat {
  isDirectory(): boolean;
  isFile?(): boolean;
}

export interface ShipInputFileSystem {
  exists(path: string): boolean;
  readable(path: string): boolean;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  readDirectory(path: string): string[];
  stat(path: string): ShipInputStat;
  realpath?(path: string): string;
}

export const nodeShipInputFileSystem: ShipInputFileSystem = {
  exists: existsSync,
  readable: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFileSync(path, 'utf-8'),
  readBytes: (path) => readFileSync(path),
  readDirectory: (path) => readdirSync(path),
  stat: (path) => statSync(path),
  realpath: (path) => realpathSync.native(path),
};

const PATH_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|sh|bash|ya?ml|json|jsonl|toml|md|txt|csv|tsv|parquet|db|sqlite|html|css|svg|png|jpe?g|webp|pdf|arrow)$/i;
const INPUT_DIRECTIVE = /\b(?:input|inputs|read|reads|consume|consumes|load|loads|source|sources|dataset|datasets|fixture|fixtures|requires|required)\b/i;
const OUTPUT_DIRECTIVE = /\b(?:write|writes|written|create|creates|produce|produces|generate|generates|emit|emits|save|saves|deliverable|deliverables|output|outputs|modify|modifies|edit|edits)\b/i;
const INPUT_KEY = /(?:^|_)(?:input|inputs|required_input|required_inputs|input_manifest|source|sources|dataset|datasets|fixture|fixtures|consume|consumes|read|reads)(?:_|$)/i;
const OUTPUT_KEY = /(?:^|_)(?:output|outputs|deliverable|deliverables|artifact|artifacts|result_file|report|reports|write|writes|writable_paths|terminal_states)(?:_|$)/i;
const ASSERTION_KEY = /^(?:rows?|row_count|files?|file_count|sha_?256|digest|span|time_span|start|end|description|note|type|format|role|name|label|encoding|delimiter)$/i;

function leadingFrontmatter(brief: string): { yaml: string; body: string; bodyLineOffset: number } | undefined {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(brief);
  if (!match) return undefined;
  const body = brief.slice(match[0].length);
  return {
    yaml: match[1],
    body,
    bodyLineOffset: match[0].split(/\r?\n/).length - 1,
  };
}

interface NormalizedBriefInputPath {
  path?: string;
  reason?: string;
}

function normalizedBriefInputPath(raw: string, explicit: boolean): NormalizedBriefInputPath {
  const authored = explicit ? raw : raw.trim();
  if (explicit && authored !== authored.trim()) {
    return { reason: 'Explicit input must not contain leading or trailing whitespace' };
  }
  if (explicit && /[<>]/.test(authored)) {
    return { reason: 'Explicit input must be one literal project-relative path, not a template' };
  }
  if (explicit && (
    /^[`'"([]/.test(authored)
    || /[`'">)\],;:]$/.test(authored)
    || /:\d+(?::\d+)?$/.test(authored)
  )) {
    return { reason: 'Explicit input contains wrapper or trailing punctuation and cannot be rewritten as another path' };
  }
  if (explicit && authored.includes('\\')) {
    return { reason: 'Explicit input must use project-relative forward-slash separators' };
  }
  let candidate = explicit
    ? authored.replace(/^\.\//, '')
    : authored
      .replace(/^[`'"(<\u005b]+/, '')
      .replace(/[`'">)\],.;:]+$/, '')
      .replace(/:\d+(?::\d+)?$/, '')
      .replace(/^\.\//, '')
      .replaceAll('\\', '/');
  if (!candidate) return { reason: 'Explicit input is empty' };
  if (candidate.includes('::') || /\s/.test(candidate)) {
    return { reason: 'Explicit input must name one project-relative path without whitespace' };
  }
  if (candidate.startsWith('~') || isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    return { reason: 'Explicit input must be a project-relative path' };
  }
  if (/^(?:https?|file):\/\//i.test(candidate) || candidate.includes('://')) {
    return { reason: 'Explicit input must be a project-relative path, not a URL' };
  }
  if (/[?*{}[\]]/.test(candidate) || /[$<>]/.test(candidate)) {
    return { reason: 'Explicit input must be one literal project-relative path, not a glob or template' };
  }
  const pathSegments = candidate.split('/');
  if (candidate === '.'
    || pathSegments.some((segment) => segment === '..')
    || pathSegments.slice(1).some((segment) => segment === '.')) {
    return { reason: 'Explicit input must be project-relative and stay within the project root' };
  }
  if (explicit && candidate.endsWith('.')) {
    return { reason: 'Explicit input contains trailing punctuation and cannot be rewritten as another path' };
  }
  const directoryShaped = candidate.endsWith('/');
  candidate = candidate.replace(/\/$/, '');
  // Fractions and progress counters are not paths, even though they contain a slash.
  if (candidate.split('/').every((segment) => /^\d+$/.test(segment))) {
    return { reason: 'Explicit input is a numeric fraction or counter, not a path' };
  }
  if (!explicit && !directoryShaped && !candidate.includes('/') && !candidate.startsWith('.') && !PATH_EXTENSION.test(candidate)) {
    return { reason: 'Prose token is not sufficiently path-shaped' };
  }
  return { path: candidate };
}

/** Normalize prose only when a token is both safe and recognizably path-shaped. */
export function normalizeBriefInputPath(raw: string): string | undefined {
  return normalizedBriefInputPath(raw, false).path;
}

interface PathToken {
  path: string;
  index: number;
  endIndex: number;
}

function codeSpanInputDirective(text: string): PathToken | undefined {
  const match = /^\s*(?:input|inputs|read|reads|consume|consumes|load|loads|source|sources|dataset|datasets|fixture|fixtures)\s*:?\s+(\S+)\s*$/i.exec(text);
  if (!match) return undefined;
  const path = normalizeBriefInputPath(match[1]);
  if (!path) return undefined;
  const index = text.lastIndexOf(match[1]);
  return { path, index, endIndex: index + match[1].length };
}

function pathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  const pattern = /(?:^|[\s`'"(])((?:\.?[A-Za-z0-9_-]+[\\/])+(?:[A-Za-z0-9_.-]+[\\/]?)?|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|\.[A-Za-z0-9_.-]+[\\/]?)/g;
  for (const match of text.matchAll(pattern)) {
    const path = normalizeBriefInputPath(match[1]);
    if (!path) continue;
    const index = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
    tokens.push({ path, index, endIndex: index + match[1].length });
  }
  return tokens;
}

type ReferenceRole = 'input' | 'output' | 'excluded' | 'neutral';

function patternIndices(text: string, pattern: RegExp): number[] {
  const flags = `${pattern.flags.replaceAll('g', '')}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
}

function directiveIsNegated(line: string, directiveIndex: number): boolean {
  return /\b(?:do not|does not|must not|should not|never)\s*$/i.test(line.slice(0, directiveIndex));
}

function referenceRoleAt(
  line: string,
  index: number,
  endIndex: number,
  section: 'input' | 'output' | 'neutral',
): ReferenceRole {
  const precedingInput = patternIndices(line.slice(0, index), INPUT_DIRECTIVE).at(-1) ?? -1;
  const precedingOutput = patternIndices(line.slice(0, index), OUTPUT_DIRECTIVE).at(-1) ?? -1;
  if (precedingInput >= 0 || precedingOutput >= 0) {
    if (precedingInput > precedingOutput) {
      return directiveIsNegated(line, precedingInput) ? 'excluded' : 'input';
    }
    return 'output';
  }
  if (section !== 'neutral') return section;

  // A later noun elsewhere in the sentence does not assign a role to an earlier path.
  // Accept only an immediate passive assignment, such as “`fixture.csv` is required”.
  const remainder = line.slice(endIndex).replace(/^[`'"\])}>,.;:\s-]+/, '');
  if (/^(?:is|are)\s+required\b/i.test(remainder)
    || /^(?:is|are)\s+(?:an?\s+)?(?:input|source|dataset|fixture)s?\b/i.test(remainder)) {
    return 'input';
  }
  if (/^(?:is|are)\s+(?:an?\s+)?(?:output|deliverable|artifact|result)s?\b/i.test(remainder)) {
    return 'output';
  }
  return 'neutral';
}

function integer(value: string): number | undefined {
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseAssertions(text: string, line: number): BriefInputAssertionDeclaration[] {
  const assertions: BriefInputAssertionDeclaration[] = [];
  const excerpt = text.trim();
  const addCount = (kind: 'row_count' | 'file_count', match: RegExpMatchArray | null): void => {
    const expected = match ? integer(match[1]) : undefined;
    if (expected !== undefined) assertions.push({ kind, expected, line, excerpt });
  };

  const rowNamed = text.match(/\b(?:row[_ -]?count|rows?)\s*(?::|=|is)?\s*([\d,]+)\b/i);
  addCount('row_count', rowNamed ?? text.match(/\b([\d,]+)\s+(?:data\s+)?rows?\b/i));
  const filesNamed = text.match(/\b(?:file[_ -]?count|files?)\s*(?::|=|is)?\s*([\d,]+)\b/i);
  addCount('file_count', filesNamed ?? text.match(/\b([\d,]+)\s+(?:regular\s+)?files?\b/i));

  const span = text.match(/\b(?:spans?|time[_ -]?span(?:\s+(?:is|of))?)\s*(?::|=)?\s*(\d{4}-\d{2}-\d{2})(?:[T ][^\s.]*)?\s*(?:\.\.|through|to)\s*(\d{4}-\d{2}-\d{2})(?:[T ][^\s,;]*)?/i);
  if (span) {
    assertions.push({
      kind: 'time_span',
      expected: { start: span[1], end: span[2] },
      line,
      excerpt,
    });
  }
  const hash = text.match(/\bsha-?256(?:sum)?\s*(?::|=|is)?\s*([a-f0-9]{64})\b/i);
  if (hash) assertions.push({ kind: 'sha256', expected: hash[1].toLowerCase(), line, excerpt });
  return assertions;
}

function assertionKey(assertion: BriefInputAssertionDeclaration): string {
  return JSON.stringify([assertion.kind, assertion.expected, assertion.line]);
}

function unbound(assertion: BriefInputAssertionDeclaration, reason: string): BriefInputAssertionResult {
  return { ...assertion, state: 'not_checkable', reason };
}

function lineForPath(brief: string, path: string): number {
  const index = brief.split(/\r?\n/).findIndex((line) => line.includes(path));
  return index < 0 ? 1 : index + 1;
}

function yamlInputKeyLine(line: string): { indent: number; value: string } | undefined {
  const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
  if (!match || !INPUT_KEY.test(match[2])) return undefined;
  return { indent: match[1].length, value: match[3].trim() };
}

function malformedYamlInputDeclarations(
  yamlText: string,
  error: unknown,
): UnresolvedBriefInputDeclaration[] {
  const lines = yamlText.split(/\r?\n/);
  const declarations: UnresolvedBriefInputDeclaration[] = [];
  const reason = `Explicit input declaration could not be parsed because frontmatter YAML is malformed: ${error instanceof Error ? error.message : String(error)}`;

  for (let index = 0; index < lines.length; index += 1) {
    const key = yamlInputKeyLine(lines[index]);
    if (!key) continue;
    let foundValue = false;
    if (key.value) {
      declarations.push({ value: key.value, line: index + 2, reason });
      foundValue = true;
    }
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      const line = lines[nested];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= key.indent) break;
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (!item) continue;
      declarations.push({ value: item[1].trim() || '<empty>', line: nested + 2, reason });
      foundValue = true;
    }
    if (!foundValue) declarations.push({ value: '<unparsed inputs>', line: index + 2, reason });
  }
  return declarations;
}

function explicitNullInputLocations(yamlText: string): Array<{ value: string; line: number }> {
  const lines = yamlText.split(/\r?\n/);
  const locations: Array<{ value: string; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const key = yamlInputKeyLine(lines[index]);
    if (!key) continue;
    if (/^(?:null|~)$/i.test(key.value)) locations.push({ value: key.value, line: index + 2 });
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      const line = lines[nested];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= key.indent) break;
      const item = /^\s*-\s*(.*?)(?:\s+#.*)?$/.exec(line);
      if (item && (!item[1].trim() || /^(?:null|~)$/i.test(item[1].trim()))) {
        locations.push({ value: item[1].trim() || '<empty>', line: nested + 2 });
      }
    }
  }
  return locations;
}

function collectYamlInputs(
  brief: string,
  yamlText: string,
  addReference: (path: string, line: number, assertions: BriefInputAssertionDeclaration[]) => void,
  addUnresolvedInput: (input: UnresolvedBriefInputDeclaration) => void,
  addUnbound: (assertion: BriefInputAssertionResult) => void,
): void {
  let root: unknown;
  try {
    root = parseYaml(yamlText) as unknown;
  } catch (error) {
    for (const declaration of malformedYamlInputDeclarations(yamlText, error)) {
      addUnresolvedInput(declaration);
    }
    return;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  const nullLocations = explicitNullInputLocations(yamlText);
  let nullLocationIndex = 0;

  const processItem = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) processItem(entry);
      return;
    }
    if (typeof value === 'string') {
      const normalized = normalizedBriefInputPath(value, true);
      if (normalized.path) addReference(normalized.path, lineForPath(brief, value), []);
      else addUnresolvedInput({
        value,
        line: lineForPath(brief, value),
        reason: normalized.reason ?? 'Explicit input could not be normalized',
      });
      return;
    }
    if (value === null) {
      const location = nullLocations[nullLocationIndex++] ?? { value: 'null', line: 2 };
      addUnresolvedInput({
        ...location,
        reason: 'Explicit input must be a string path, not a null or empty entry',
      });
      return;
    }
    if (typeof value !== 'object') {
      const authoredValue = String(value);
      addUnresolvedInput({
        value: authoredValue,
        line: lineForPath(brief, authoredValue),
        reason: 'Explicit input must be a string path',
      });
      return;
    }
    const mapping = value as Record<string, unknown>;
    const paths: string[] = [];
    const assertionText: string[] = [];
    for (const [key, entry] of Object.entries(mapping)) {
      if (OUTPUT_KEY.test(key) && !INPUT_KEY.test(key)) continue;
      if (typeof entry === 'string') {
        if (!ASSERTION_KEY.test(key)) {
          const normalized = normalizedBriefInputPath(entry, true);
          if (normalized.path) paths.push(normalized.path);
          else addUnresolvedInput({
            value: entry,
            line: lineForPath(brief, entry),
            reason: normalized.reason ?? 'Explicit input could not be normalized',
          });
        }
        assertionText.push(`${key}: ${entry}`);
      } else if (typeof entry === 'number') {
        assertionText.push(`${key}: ${entry}`);
      } else if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
        if (!ASSERTION_KEY.test(key)) {
          for (const item of entry) {
            const normalized = normalizedBriefInputPath(item, true);
            if (normalized.path) paths.push(normalized.path);
            else addUnresolvedInput({
              value: item,
              line: lineForPath(brief, item),
              reason: normalized.reason ?? 'Explicit input could not be normalized',
            });
          }
        }
      }
    }
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) {
      for (const [key, entry] of Object.entries(mapping)) {
        if (!OUTPUT_KEY.test(key) && entry && typeof entry === 'object') processItem(entry);
      }
      return;
    }
    const line = lineForPath(brief, uniquePaths[0]);
    const assertions = parseAssertions(assertionText.join(' '), line);
    if (uniquePaths.length === 1) {
      addReference(uniquePaths[0], line, assertions);
    } else {
      for (const path of uniquePaths) addReference(path, lineForPath(brief, path), []);
      for (const assertion of assertions) {
        addUnbound(unbound(assertion, `Assertion names ${uniquePaths.length} inputs in one YAML item; its target is ambiguous`));
      }
    }
  };

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (INPUT_KEY.test(key)) processItem(entry);
      else if (!OUTPUT_KEY.test(key)) walk(entry);
    }
  };
  walk(root);
}

/**
 * Return only inputs declared by the leading, top-level `inputs:` block.
 * Prose and table references remain useful to the legacy extractor below, but
 * they are not declarations for launch-workspace reachability.
 */
export function extractDeclaredBriefInputPaths(brief: string): string[] {
  const frontmatter = leadingFrontmatter(brief);
  if (!frontmatter) return [];
  let root: unknown;
  try {
    root = parseYaml(frontmatter.yaml) as unknown;
  } catch {
    return [];
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
  const inputs = (root as Record<string, unknown>).inputs;
  if (inputs === undefined) return [];

  const declared = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = normalizedBriefInputPath(value, true).path;
      if (path) declared.add(path);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!OUTPUT_KEY.test(key) && !ASSERTION_KEY.test(key)) visit(entry);
    }
  };
  visit(inputs);
  return [...declared].sort();
}

/**
 * Find literal, non-negated source-or-neutral path mentions in the brief body.
 * Output-shaped references are excluded, while neutral table cells and
 * constraint prose are retained so callers can compare them with repository
 * facts such as ignored-directory rules.
 */
export function extractBriefPathMentions(brief: string): BriefPathMention[] {
  const frontmatter = leadingFrontmatter(brief);
  const body = frontmatter?.body ?? brief;
  const offset = frontmatter?.bodyLineOffset ?? 0;
  const mentions = new Map<string, BriefPathMention>();
  let section: 'input' | 'output' | 'neutral' = 'neutral';
  let inFence = false;

  body.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading) {
      const inputHeading = /\b(?:input|source|fixture|dataset)\b/i.test(heading);
      const outputHeading = /\b(?:output|deliverable|write|change|artifact|terminal)\b/i.test(heading);
      section = inputHeading === outputHeading ? 'neutral' : inputHeading ? 'input' : 'output';
      return;
    }
    const codeSpans: Array<{ start: number; end: number }> = [];
    const candidates: PathToken[] = [];
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const spanStart = match.index ?? 0;
      codeSpans.push({ start: spanStart, end: spanStart + match[0].length });
      const path = normalizeBriefInputPath(match[1]);
      if (path) candidates.push({ path, index: spanStart + 1, endIndex: spanStart + 1 + match[1].length });
    }
    for (const token of pathTokens(line)) {
      if (!codeSpans.some((span) => token.index < span.end && token.endIndex > span.start)) candidates.push(token);
    }

    for (const token of candidates) {
      if (isNegatedPathMention(line, token.index, token.endIndex)) continue;
      const role = referenceRoleAt(line, token.index, token.endIndex, section);
      if (role === 'output' || role === 'excluded') continue;
      if (!mentions.has(token.path)) {
        mentions.set(token.path, { path: token.path, line: offset + index + 1, excerpt: trimmed });
      }
    }
  });

  return [...mentions.values()].sort((left, right) => left.line - right.line || left.path.localeCompare(right.path));
}

/** Parse input references and factual claims from their authored syntactic roles. */
export function parseBriefInputs(brief: string): ParsedBriefInputs {
  const references = new Map<string, BriefInputReference>();
  const unresolvedInputs: UnresolvedBriefInputDeclaration[] = [];
  const unboundAssertions: BriefInputAssertionResult[] = [];
  const seenUnresolvedInputs = new Set<string>();
  const seenUnbound = new Set<string>();
  const addReference = (
    path: string,
    line: number,
    assertions: BriefInputAssertionDeclaration[],
  ): void => {
    const existing = references.get(path);
    if (!existing) {
      references.set(path, { path, line, assertions: [...assertions] });
      return;
    }
    const seen = new Set(existing.assertions.map(assertionKey));
    for (const assertion of assertions) {
      if (!seen.has(assertionKey(assertion))) existing.assertions.push(assertion);
    }
  };
  const addUnbound = (assertion: BriefInputAssertionResult): void => {
    const key = `${assertionKey(assertion)}:${assertion.reason}`;
    if (!seenUnbound.has(key)) {
      seenUnbound.add(key);
      unboundAssertions.push(assertion);
    }
  };
  const addUnresolvedInput = (input: UnresolvedBriefInputDeclaration): void => {
    const key = JSON.stringify([input.value, input.line, input.reason]);
    if (!seenUnresolvedInputs.has(key)) {
      seenUnresolvedInputs.add(key);
      unresolvedInputs.push(input);
    }
  };

  const frontmatter = leadingFrontmatter(brief);
  if (frontmatter) collectYamlInputs(
    brief,
    frontmatter.yaml,
    addReference,
    addUnresolvedInput,
    addUnbound,
  );
  const body = frontmatter?.body ?? brief;
  const offset = frontmatter?.bodyLineOffset ?? 0;
  let section: 'input' | 'output' | 'neutral' = 'neutral';
  let listItemPaths: string[] = [];
  let inListItem = false;

  body.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = offset + index + 1;
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading) {
      const inputHeading = /\b(?:input|source|fixture|dataset)\b/i.test(heading);
      const outputHeading = /\b(?:output|deliverable|write|change|artifact|terminal)\b/i.test(heading);
      section = inputHeading === outputHeading ? 'neutral' : inputHeading ? 'input' : 'output';
      inListItem = false;
      listItemPaths = [];
      return;
    }
    const beginsListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
    if (beginsListItem) {
      inListItem = true;
      listItemPaths = [];
    } else if (!line.trim()) {
      inListItem = false;
      listItemPaths = [];
      return;
    }

    const onLine = new Set<string>();
    const codeSpans: Array<{ start: number; end: number }> = [];
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const spanStart = match.index ?? 0;
      codeSpans.push({ start: spanStart, end: spanStart + match[0].length });
      const path = normalizeBriefInputPath(match[1]);
      const start = spanStart + 1;
      if (path && referenceRoleAt(line, start, start + match[1].length, section) === 'input') {
        onLine.add(path);
      } else if (!path) {
        // A whole directive may itself be formatted as code (`Read package.json`).
        // Parse that exact one-path grammar, but never mine arbitrary rejected spans.
        const directive = codeSpanInputDirective(match[1]);
        if (directive
          && referenceRoleAt(match[1], directive.index, directive.endIndex, 'neutral') === 'input') {
          onLine.add(directive.path);
        }
      }
    }
    for (const token of pathTokens(line)) {
      // A rejected code span is one authored token. Do not reinterpret a valid-looking
      // substring (for example `docs/<x>/result.md` becoming `docs/`) as another path.
      if (codeSpans.some((span) => token.index < span.end && token.endIndex > span.start)) continue;
      if (referenceRoleAt(line, token.index, token.endIndex, section) === 'input') onLine.add(token.path);
    }
    for (const path of onLine) addReference(path, lineNumber, []);
    if (inListItem && onLine.size > 0) listItemPaths.push(...onLine);

    const binding = onLine.size > 0 ? [...onLine] : inListItem ? [...new Set(listItemPaths)] : [];
    const assertionContext = binding.length > 0
      || section === 'input'
      || /\b(?:input|dataset|source|fixture|read|consume|load)\b/i.test(line);
    const assertions = assertionContext ? parseAssertions(line, lineNumber) : [];
    if (binding.length === 1) {
      addReference(binding[0], lineNumber, assertions);
    } else if (assertions.length > 0) {
      const reason = binding.length === 0
        ? 'Assertion is not attached to an input reference in the same structured item'
        : `Assertion names ${binding.length} inputs in one structured item; its target is ambiguous`;
      for (const assertion of assertions) addUnbound(unbound(assertion, reason));
    }
  });

  return {
    references: [...references.values()].sort((left, right) => left.path.localeCompare(right.path)),
    unresolvedInputs: unresolvedInputs.sort((left, right) => left.line - right.line || left.value.localeCompare(right.value)),
    unboundAssertions,
  };
}

/** Compatibility projection retained for existing callers. */
export function extractBriefInputPaths(brief: string): string[] {
  return parseBriefInputs(brief).references.map((reference) => reference.path);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

interface RecordsResult {
  records?: unknown[];
  reason?: string;
}

function delimitedRecords(text: string, delimiter: string): string[][] | undefined {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) return undefined;
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function structuredRecords(path: string, fs: ShipInputFileSystem): RecordsResult {
  const extension = path.toLowerCase().match(/\.[^.]+$/)?.[0];
  const text = fs.readText(path);
  if (extension === '.csv' || extension === '.tsv') {
    const rows = delimitedRecords(text, extension === '.csv' ? ',' : '\t');
    if (!rows) return { reason: 'Delimited input has an unterminated quoted field' };
    if (rows.length === 0) return { records: [] };
    const header = rows[0].map((cell) => cell.trim());
    if (header.some((cell) => !cell) || new Set(header).size !== header.length) {
      return { reason: 'Delimited input has empty or duplicate header fields' };
    }
    return {
      records: rows.slice(1).map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']))),
    };
  }
  if (extension === '.jsonl') {
    const records: unknown[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        return { reason: `JSONL record ${index + 1} is malformed` };
      }
    }
    return { records };
  }
  if (extension === '.json') {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { reason: 'JSON input is malformed' };
    }
    return Array.isArray(value)
      ? { records: value }
      : { reason: 'JSON row checks require a top-level array' };
  }
  return { reason: `Row and time-span checks do not support ${extension ?? 'an extensionless input'}` };
}

function countRegularFiles(path: string, fs: ShipInputFileSystem): number {
  const stat = fs.stat(path);
  if (!stat.isDirectory()) throw new Error('File-count assertions require a directory input');
  let count = 0;
  for (const name of fs.readDirectory(path)) {
    const child = join(path, name);
    const childStat = fs.stat(child);
    if (childStat.isDirectory()) count += countRegularFiles(child, fs);
    else if (!childStat.isFile || childStat.isFile()) count += 1;
  }
  return count;
}

function observedSpan(records: unknown[]): { value?: { start: string; end: string }; reason?: string } {
  if (records.length === 0) return { reason: 'Time-span assertion cannot be checked on an empty input' };
  if (!records.every((record) => record !== null && typeof record === 'object' && !Array.isArray(record))) {
    return { reason: 'Time-span assertions require object records with a named date field' };
  }
  const dateKeys = new Set<string>();
  for (const record of records as Array<Record<string, unknown>>) {
    for (const key of Object.keys(record)) {
      if (/(?:^|[_ -])(?:date|time|timestamp|datetime|day)(?:$|[_ -])/i.test(key)) dateKeys.add(key);
    }
  }
  if (dateKeys.size !== 1) {
    return { reason: `Expected one unambiguous date-bearing field, found ${dateKeys.size}` };
  }
  const key = [...dateKeys][0];
  const dates: string[] = [];
  for (const record of records as Array<Record<string, unknown>>) {
    const raw = record[key];
    const date = typeof raw === 'string' ? raw.slice(0, 10) : '';
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (typeof raw !== 'string'
      || !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(raw)
      || !Number.isFinite(Date.parse(raw))
      || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== date) {
      return { reason: `Date-bearing field ${key} contains a missing or invalid value` };
    }
    dates.push(date);
  }
  dates.sort();
  return { value: { start: dates[0], end: dates.at(-1) as string } };
}

function evaluateAssertion(
  assertion: BriefInputAssertionDeclaration,
  path: string,
  fs: ShipInputFileSystem,
): BriefInputAssertionResult {
  try {
    if (assertion.kind === 'sha256') {
      if (fs.stat(path).isDirectory()) return unbound(assertion, 'SHA-256 assertions require a file input');
      const observed = createHash('sha256').update(fs.readBytes(path)).digest('hex');
      return {
        ...assertion,
        observed,
        state: observed === assertion.expected ? 'confirmed' : 'refuted',
        reason: observed === assertion.expected ? 'SHA-256 matches the declared digest' : 'SHA-256 differs from the declared digest',
      };
    }
    if (assertion.kind === 'file_count') {
      const observed = countRegularFiles(path, fs);
      return {
        ...assertion,
        observed,
        state: observed === assertion.expected ? 'confirmed' : 'refuted',
        reason: observed === assertion.expected
          ? 'Recursive regular-file count matches the declaration'
          : 'Recursive regular-file count differs from the declaration',
      };
    }
    const parsed = structuredRecords(path, fs);
    if (!parsed.records) return unbound(assertion, parsed.reason ?? 'Input records could not be parsed');
    if (assertion.kind === 'row_count') {
      const observed = parsed.records.length;
      return {
        ...assertion,
        observed,
        state: observed === assertion.expected ? 'confirmed' : 'refuted',
        reason: observed === assertion.expected
          ? 'Data-row count matches (CSV/TSV headers are excluded)'
          : 'Data-row count differs (CSV/TSV headers are excluded)',
      };
    }
    const span = observedSpan(parsed.records);
    if (!span.value) return unbound(assertion, span.reason ?? 'Time span could not be derived');
    const expected = assertion.expected as { start: string; end: string };
    const matches = span.value.start === expected.start && span.value.end === expected.end;
    return {
      ...assertion,
      observed: span.value,
      state: matches ? 'confirmed' : 'refuted',
      reason: matches ? 'Observed time span matches the declaration' : 'Observed time span differs from the declaration',
    };
  } catch (error) {
    return unbound(assertion, error instanceof Error ? error.message : String(error));
  }
}

/** Verify reachability and every mechanically checkable assertion under one project root. */
export function verifyBriefInputs(
  brief: string,
  projectRoot: string,
  fs: ShipInputFileSystem = nodeShipInputFileSystem,
): BriefInputVerification {
  const parsed = parseBriefInputs(brief);
  const root = resolve(projectRoot);
  const inputs = parsed.references.map((reference): VerifiedBriefInput => {
    const lexical = resolve(root, reference.path);
    if (!within(root, lexical)) {
      return {
        ...reference,
        resolvedPath: lexical,
        exists: false,
        readable: false,
        assertions: reference.assertions.map((assertion) => unbound(assertion, 'Input escapes the project root')),
      };
    }
    const exists = fs.exists(lexical);
    const readable = exists && fs.readable(lexical);
    let resolvedPath = lexical;
    if (exists && fs.realpath) {
      try {
        resolvedPath = fs.realpath(lexical);
      } catch {
        // Reachability and assertion results remain explicit below.
      }
    }
    const assertions = reference.assertions.map((assertion) => {
      if (!exists) return unbound(assertion, 'Input does not exist');
      if (!readable) return unbound(assertion, 'Input is not readable');
      return evaluateAssertion(assertion, lexical, fs);
    });
    return { ...reference, resolvedPath, exists, readable, assertions };
  });
  return {
    inputs,
    unresolvedInputs: parsed.unresolvedInputs,
    unboundAssertions: parsed.unboundAssertions,
  };
}
