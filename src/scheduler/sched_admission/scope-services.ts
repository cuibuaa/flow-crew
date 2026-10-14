/** Shared lexical path/scope predicates and typed boundary to the declared-input write policy; no parallel policy implementation. */
import { posix, isAbsolute } from 'node:path';
import type { DeclaredInputWriteBinding } from '../../scheduler.js';

export type ParsedScope =
  | { kind: 'exact'; raw: string; value: string }
  | { kind: 'tree'; raw: string; value: string }
  | { kind: 'glob'; raw: string; directoryPrefix: string; segments: ScopeSegment[] }
  | { kind: 'unknown'; raw: string; reason: string };

type ScopeSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; value: string }
  | { kind: 'globstar'; value: '**'; dots?: boolean };

const globSyntax = /[*!?[{]|[+@]\(/;
const complexGlobSyntax = /[![{]|[+@?*]\(/;

function scopeSegments(path: string): ScopeSegment[] {
  return path.split('/').map((segment): ScopeSegment => {
    if (segment === '**') return { kind: 'globstar', value: '**' };
    return { kind: globSyntax.test(segment) ? 'wildcard' : 'literal', value: segment };
  });
}

export function parseDeclaredScope(rawValue: string): ParsedScope {
  const raw = rawValue.trim();
  const slashNormalized = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!slashNormalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  if (isAbsolute(slashNormalized) || /^[A-Za-z]:\//.test(slashNormalized)) {
    return { kind: 'unknown', raw, reason: 'scope must be project-relative' };
  }
  const segments = slashNormalized.split('/');
  if (segments.includes('..')) return { kind: 'unknown', raw, reason: 'scope may not traverse outside the project' };
  const explicitDirectory = slashNormalized.endsWith('/') || slashNormalized.endsWith('/.');
  const normalized = segments.filter(segment => segment && segment !== '.').join('/');
  if (!normalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  const globAt = normalized.search(globSyntax);
  if (globAt >= 0) {
    const slash = normalized.slice(0, globAt).lastIndexOf('/');
    return { kind: 'glob', raw, directoryPrefix: slash >= 0 ? normalized.slice(0, slash) : '', segments: scopeSegments(normalized) };
  }
  return { kind: explicitDirectory ? 'tree' : 'exact', raw, value: normalized };
}

function languageSegments(scope: Exclude<ParsedScope, { kind: 'unknown' }>): ScopeSegment[] {
  if (scope.kind !== 'glob') return [
    ...scope.value.split('/').map((value): ScopeSegment => ({ kind: 'literal', value })),
    { kind: 'globstar', value: '**', dots: true },
  ];
  // A literal terminal tree includes its node and every descendant, including
  // dotfiles. Other globstars keep Node's normal dot-segment boundary.
  const root = literalTreeCapabilityRoot(scope);
  return root ? [...scopeSegments(root), { kind: 'globstar', value: '**', dots: true }] : scope.segments;
}

function nodeGlobMatches(path: string, pattern: string): boolean {
  try { return posix.matchesGlob(path, pattern); } catch { return false; }
}

/** Product traversal of ordinary wildcard segments. Star has an empty edge
 * and a consuming loop; question mark consumes one character. */
function wildcardSegmentsIntersect(left: string, right: string): boolean {
  const visited = new Set<string>();
  const visit = (i: number, j: number, consumed: boolean): boolean => {
    const key = `${i}:${j}:${consumed}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (i === left.length && j === right.length) return consumed;
    if (left[i] === '*' && visit(i + 1, j, consumed)) return true;
    if (right[j] === '*' && visit(i, j + 1, consumed)) return true;
    if (i === left.length || j === right.length) return false;
    const a = left[i], b = right[j];
    const aWildcard = a === '*' || a === '?', bWildcard = b === '*' || b === '?';
    if (!aWildcard && !bWildcard && a !== b) return false;
    // Node wildcard tokens do not introduce a leading dot segment.
    if (!consumed && ((a === '.' && bWildcard) || (b === '.' && aWildcard))) return false;
    return visit(a === '*' ? i : i + 1, b === '*' ? j : j + 1, true);
  };
  return visit(0, 0, false);
}

function segmentsMayIntersect(left: ScopeSegment, right: ScopeSegment): boolean {
  if (left.kind === 'globstar') {
    if (right.kind === 'globstar') return true;
    return left.dots === true || !right.value.startsWith('.');
  }
  if (right.kind === 'globstar') return segmentsMayIntersect(right, left);
  if (left.kind === 'literal') return right.kind === 'literal'
    ? left.value === right.value : nodeGlobMatches(left.value, right.value);
  if (right.kind === 'literal') return nodeGlobMatches(right.value, left.value);
  if (complexGlobSyntax.test(left.value) || complexGlobSyntax.test(right.value)) return true;
  return wildcardSegmentsIntersect(left.value, right.value);
}

function languagesIntersect(left: ScopeSegment[], right: ScopeSegment[]): boolean {
  const visited = new Set<string>();
  const visit = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (i === left.length && j === right.length) return true;
    const a = left[i], b = right[j];
    if (a?.kind === 'globstar' && visit(i + 1, j)) return true;
    if (b?.kind === 'globstar' && visit(i, j + 1)) return true;
    return !!a && !!b && segmentsMayIntersect(a, b)
      && visit(a.kind === 'globstar' ? i : i + 1, b.kind === 'globstar' ? j : j + 1);
  };
  return visit(0, 0);
}

/** Admission and input-tree protection ask the same scope-language owner.
 * Complex Node glob constructs can span path separators; retain a conflict
 * when their intersection cannot be proved rather than grant concurrency. */
export function scopeLanguagesMayOverlap(left: ParsedScope, right: ParsedScope): boolean {
  if (left.kind === 'unknown' || right.kind === 'unknown') return true;
  const crossesSegments = (scope: ParsedScope): boolean => scope.kind === 'glob'
    && scope.segments.some(segment => {
      let depth = 0;
      for (const character of segment.value) {
        if ('{[('.includes(character)) depth++;
        if ('}])'.includes(character)) depth--;
      }
      return depth !== 0;
    });
  if (crossesSegments(left) || crossesSegments(right)) return true;
  return languagesIntersect(languageSegments(left), languageSegments(right));
}

export interface DeclaredInputScopeServices {
  resolveDeclaredInputWriteBindings(projectDir: string, brief: string): DeclaredInputWriteBinding[];
  firstDeclaredInputScopeConflict(scopes: readonly string[], inputs: readonly DeclaredInputWriteBinding[], projectDir?: string): { scope: string; inputPath: string; inputKind: 'file' | 'tree'; comparison: 'declared_path' | 'resolved_identity' } | undefined;
}

export function normalizedProjectPath(value: string): string | undefined {
  const normalized = posix.normalize(value.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return undefined;
  return normalized;
}

/** Git owns this namespace, including nested repositories and worktree pointers.
 * Inventory, notifications and write attribution must agree on project content. */
export function normalizedProjectContentPath(value: string): string | undefined {
  const path = normalizedProjectPath(value);
  return path?.split('/').includes('.git') ? undefined : path;
}

export function scopeMatchesProjectPath(scope: ParsedScope, path: string): boolean {
  if (scope.kind === 'unknown') return true;
  // Keep Node's exact membership semantics, including terminal globstar slash
  // requirements. Literal trees use the same descendant language as admission.
  if (scope.kind === 'glob' && !literalTreeCapabilityRoot(scope)) {
    const pattern = normalizedProjectPath(scope.raw);
    return !!pattern && nodeGlobMatches(path, pattern);
  }
  return languagesIntersect(languageSegments(scope), path.split('/').map(value => ({ kind: 'literal', value })));
}

export function literalTreeCapabilityRoot(scope: ParsedScope): string | undefined {
  if (scope.kind === 'exact' || scope.kind === 'tree') return scope.value;
  if (scope.kind !== 'glob') return undefined;
  const pattern = normalizedProjectPath(scope.raw);
  if (!pattern?.endsWith('/**')) return undefined;
  const root = pattern.slice(0, -3);
  return root && !globSyntax.test(root) ? root : undefined;
}
