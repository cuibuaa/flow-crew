import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { CheckContext, RealityCheck } from '../types.js';
import { result } from './_utils.js';

interface Params {
  glob?: string;
  language?: string;
  forbid_pattern?: string;
}

interface GlobExpansion {
  files: string[];
  error?: string;
}

const MAX_STATIC_SCAN_FILES = 4_096;
const MAX_STATIC_SCAN_DIRECTORY_ENTRIES = 20_000;
const MAX_STATIC_SCAN_FILE_BYTES = 1024 * 1024;
const MAX_STORED_FINDINGS = 100;
const MAX_BRACE_VARIANTS = 256;
const GLOB_MAGIC = /[*?[\]{}()!+@|]/u;

export default class StaticAstScanCheck implements RealityCheck {
  static meta = { description: 'Scan files matching a glob for a forbidden pattern; fail if any match is found.', params: 'glob: string, language: string, forbid_pattern: string' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.glob !== 'string') return result(false, '`params.glob` must be provided; declare the files to scan and rerun the check.');
    if (typeof params.forbid_pattern !== 'string') return result(false, '`params.forbid_pattern` must be provided; declare the forbidden pattern and rerun the check.');
    if (typeof params.language !== 'string') return result(false, '`params.language` must be provided; declare the source language and rerun the check.');
    const expansion = expandGlob(params.glob, context);
    if (expansion.error) {
      return result(false, expansion.error, { filesScanned: 0, findings: [] });
    }
    const files = expansion.files;
    if (files.length === 0) {
      return result(
        false,
        `glob ${params.glob} matched no files. Fix the glob so the declared subject is actually scanned, then rerun the check.`,
        { filesScanned: 0, findings: [] },
      );
    }
    const pattern = new RegExp(params.forbid_pattern, 'gm');
    const findings: Array<{ file: string; line: number; match: string }> = [];
    let findingCount = 0;
    let filesScanned = 0;
    for (const file of files) {
      const opened = readBoundedRegularFile(file, context);
      if (!opened.ok) {
        return result(
          false,
          `${displayPath(context, file)} cannot be scanned safely: ${opened.error}. Repair or narrow the declared scan, then rerun the check.`,
          { filesScanned, findings: [] },
        );
      }
      filesScanned += 1;
      const text = opened.text;
      let line = 1;
      let lineCursor = 0;
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        findingCount += 1;
        if (findings.length >= MAX_STORED_FINDINGS) continue;
        for (;;) {
          const newline = text.indexOf('\n', lineCursor);
          if (newline < 0 || newline >= index) break;
          line += 1;
          lineCursor = newline + 1;
        }
        findings.push({ file, line, match: match[0].slice(0, 160) });
      }
    }
    const summary = findings.slice(0, 10).map((item) =>
      `${displayPath(context, item.file).slice(0, 200)}:${item.line}`).join(', ');
    const omitted = findingCount - Math.min(findingCount, 10);
    return result(
      findingCount === 0,
      findingCount === 0
        ? `${files.length} file(s) clean`
        : `${findingCount} forbidden pattern match(es): ${summary}${omitted > 0 ? ` (+${omitted} more)` : ''}. Remove or change each named match, or narrow the glob/pattern only when the contract permits it.`,
      {
        filesScanned: files.length,
        findings,
        ...(findingCount > findings.length ? { findingsOmitted: findingCount - findings.length } : {}),
      },
    );
  }
}

function expandGlob(glob: string, context: CheckContext): GlobExpansion {
  const normalized = glob.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized.length === 0
      || isAbsolute(normalized)
      || /^[A-Za-z]:\//u.test(normalized)
      || normalized.split('/').some((part) => part === '..' || part === '')) {
    return {
      files: [],
      error: `glob ${glob} is outside the configured project/task anchors; use a normalized relative glob and rerun the check.`,
    };
  }

  const parts = normalized.split('/');
  const firstMagic = parts.findIndex((part) => GLOB_MAGIC.test(part));
  if (firstMagic < 0) return resolveExactFile(parts, normalized, context);

  const prefix = parts.slice(0, firstMagic);
  const braceVariants = expandBraceVariants(normalized);
  const patternVariants = braceVariants?.map((variant) => variant.split('/'));
  const anchors = distinctAnchors(context);
  for (const anchor of anchors) {
    const root = resolve(anchor, ...prefix);
    if (!pathWithin(anchor, root)) continue;
    const inspected = inspectExistingPath(anchor, root, true);
    if (inspected.state === 'absent') continue;
    if (inspected.state === 'unsafe') return { files: [], error: inspected.error };
    return walk(root, anchor, parts, patternVariants, normalized, context);
  }
  return { files: [] };
}

function resolveExactFile(
  parts: string[],
  normalized: string,
  context: CheckContext,
): GlobExpansion {
  for (const anchor of distinctAnchors(context)) {
    const candidate = resolve(anchor, ...parts);
    if (!pathWithin(anchor, candidate)) continue;
    const inspected = inspectExistingPath(anchor, candidate, false);
    if (inspected.state === 'absent') continue;
    if (inspected.state === 'unsafe') return { files: [], error: inspected.error };
    if (!inspected.stat.isFile()) continue;
    const relativeCandidate = relative(anchor, candidate).replaceAll('\\', '/');
    return matchesGlob(relativeCandidate, normalized)
      ? { files: [candidate] }
      : { files: [] };
  }
  return { files: [] };
}

function distinctAnchors(context: CheckContext): string[] {
  return [...new Set([resolve(context.projectDir), resolve(context.taskDir)])];
}

function inspectExistingPath(
  anchor: string,
  candidate: string,
  requireDirectory: boolean,
):
  | { state: 'absent' }
  | { state: 'safe'; stat: Stats }
  | { state: 'unsafe'; error: string } {
  const relativePath = relative(anchor, candidate);
  const components = relativePath === '' ? [] : relativePath.split(sep);
  let current = anchor;
  try {
    for (const component of components) {
      current = join(current, component);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return { state: 'unsafe', error: `${relativePath.replaceAll('\\', '/')} traverses a symbolic link` };
      }
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || (requireDirectory && !stat.isDirectory())) {
      return { state: 'unsafe', error: `${relativePath.replaceAll('\\', '/')} is not a real directory` };
    }
    return { state: 'safe', stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return {
      state: 'unsafe',
      error: `${relativePath.replaceAll('\\', '/')} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function walk(
  root: string,
  anchor: string,
  patternParts: string[],
  patternVariants: string[][] | undefined,
  normalized: string,
  context: CheckContext,
): GlobExpansion {
  const out: string[] = [];
  let visitedEntries = 0;

  const visit = (directory: string): string | undefined => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return `${displayPath(context, directory)} is not a real directory`;
    }
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        visitedEntries += 1;
        if (visitedEntries > MAX_STATIC_SCAN_DIRECTORY_ENTRIES) {
          return `glob ${normalized} exceeded the ${MAX_STATIC_SCAN_DIRECTORY_ENTRIES}-entry traversal limit; narrow the glob and rerun the check.`;
        }
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const candidate = relative(anchor, path).replaceAll('\\', '/');
        if (entry.isDirectory()) {
          if (canMatchDescendant(
            candidate.split('/'),
            patternParts,
            patternVariants,
            normalized,
          )) {
            const error = visit(path);
            if (error) return error;
          }
          continue;
        }
        if (!entry.isFile() || !matchesGlob(candidate, normalized)) continue;
        out.push(path);
        if (out.length > MAX_STATIC_SCAN_FILES) {
          return `glob ${normalized} exceeded the ${MAX_STATIC_SCAN_FILES}-file scan limit; narrow the glob and rerun the check.`;
        }
      }
    } catch (error) {
      return `${displayPath(context, directory)} cannot be traversed safely: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      handle.closeSync();
    }
    const after = lstatSync(directory);
    if (after.isSymbolicLink() || !after.isDirectory()
        || before.dev !== after.dev || before.ino !== after.ino) {
      return `${displayPath(context, directory)} changed while it was being scanned`;
    }
    return undefined;
  };

  const error = visit(root);
  return error ? { files: [], error } : { files: out.sort() };
}

function expandBraceVariants(pattern: string): string[] | undefined {
  const expand = (value: string): string[] | undefined => {
    const stack: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '{') {
        stack.push(index);
        continue;
      }
      if (character !== '}' || stack.length === 0) continue;
      const open = stack.pop() as number;
      const body = value.slice(open + 1, index);
      const alternatives: string[] = [];
      let nested = 0;
      let start = 0;
      for (let bodyIndex = 0; bodyIndex < body.length; bodyIndex += 1) {
        if (body[bodyIndex] === '{') nested += 1;
        else if (body[bodyIndex] === '}') nested = Math.max(0, nested - 1);
        else if (body[bodyIndex] === ',' && nested === 0) {
          alternatives.push(body.slice(start, bodyIndex));
          start = bodyIndex + 1;
        }
      }
      if (alternatives.length === 0) continue;
      alternatives.push(body.slice(start));

      const expanded: string[] = [];
      for (const alternative of alternatives) {
        const variants = expand(
          `${value.slice(0, open)}${alternative}${value.slice(index + 1)}`,
        );
        if (!variants || expanded.length + variants.length > MAX_BRACE_VARIANTS) {
          return undefined;
        }
        expanded.push(...variants);
      }
      return [...new Set(expanded)];
    }
    return [value];
  };
  return expand(pattern);
}

function canMatchDescendant(
  candidateParts: string[],
  patternParts: string[],
  patternVariants: string[][] | undefined,
  normalized: string,
): boolean {
  if (!patternVariants) {
    // Excessive brace expansion falls back to a bounded depth test. It may
    // inspect extra real directories, but never prunes a path that the final
    // matcher could accept.
    return normalized.includes('**') || candidateParts.length < patternParts.length;
  }
  return patternVariants.some((variant) => canMatchVariant(candidateParts, variant));
}

function canMatchVariant(candidateParts: string[], patternParts: string[]): boolean {
  const memo = new Map<string, boolean>();
  const visit = (candidateIndex: number, patternIndex: number): boolean => {
    const key = `${candidateIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let answer: boolean;
    if (candidateIndex === candidateParts.length) {
      answer = patternIndex < patternParts.length;
    } else if (patternIndex >= patternParts.length) {
      answer = false;
    } else if (patternParts[patternIndex] === '**') {
      answer = visit(candidateIndex, patternIndex + 1)
        || visit(candidateIndex + 1, patternIndex);
    } else {
      answer = matchesGlob(candidateParts[candidateIndex], patternParts[patternIndex])
        && visit(candidateIndex + 1, patternIndex + 1);
    }
    memo.set(key, answer);
    return answer;
  };
  return visit(0, 0);
}

function readBoundedRegularFile(
  file: string,
  context: CheckContext,
): { ok: true; text: string } | { ok: false; error: string } {
  const anchor = distinctAnchors(context).find((candidate) => pathWithin(candidate, file));
  if (!anchor) return { ok: false, error: 'candidate escaped both configured anchors' };
  const inspected = inspectExistingPath(anchor, file, false);
  if (inspected.state !== 'safe') {
    return { ok: false, error: inspected.state === 'unsafe' ? inspected.error : 'candidate is no longer a regular file' };
  }
  if (!inspected.stat.isFile()) return { ok: false, error: 'candidate is no longer a regular file' };

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()
        || opened.dev !== inspected.stat.dev
        || opened.ino !== inspected.stat.ino) {
      return { ok: false, error: 'candidate changed between enumeration and open' };
    }
    if (opened.size > MAX_STATIC_SCAN_FILE_BYTES) {
      return { ok: false, error: `file is oversized (byte limit ${MAX_STATIC_SCAN_FILE_BYTES})` };
    }
    const bytes = Buffer.allocUnsafe(MAX_STATIC_SCAN_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_STATIC_SCAN_FILE_BYTES) {
      return { ok: false, error: `file grew beyond the byte limit ${MAX_STATIC_SCAN_FILE_BYTES}` };
    }
    const rechecked = inspectExistingPath(anchor, file, false);
    if (rechecked.state !== 'safe') {
      return { ok: false, error: 'candidate changed while it was being read' };
    }
    if (rechecked.stat.dev !== opened.dev || rechecked.stat.ino !== opened.ino) {
      return { ok: false, error: 'candidate changed while it was being read' };
    }
    return { ok: true, text: bytes.subarray(0, offset).toString('utf-8') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function displayPath(context: CheckContext, path: string): string {
  const projectRelative = relative(context.projectDir, path).replaceAll('\\', '/');
  if (projectRelative !== '..' && !projectRelative.startsWith('../')) return projectRelative || '.';
  const taskRelative = relative(context.taskDir, path).replaceAll('\\', '/');
  return taskRelative !== '..' && !taskRelative.startsWith('../') ? taskRelative || '.' : '(outside anchors)';
}
