// Boundary: Enumerate project leaves and intersect declared write capabilities with lexical/canonical read-only input identities; reuse admission scope parsing and matching.
import { ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES } from "../../generated-path-policy.js";
import { join, isAbsolute, relative, resolve, posix } from "node:path";
import { lstatSync, readdirSync, statSync, realpathSync } from "node:fs";
import { normalizedProjectPath, literalTreeCapabilityRoot, scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { type ParsedScope, parseDeclaredScope } from "../sched_admission/frontier.js";
import { verifyDeclaredBriefInputs } from "../../ship-inputs.js";

export const REPAIR_DIFF_SKIP_DIRS = ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES;

export function listProjectFiles(
  projectDir: string,
  options: { skipDirectory?: (relativePath: string) => boolean } = {},
): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (REPAIR_DIFF_SKIP_DIRS.has(name)) continue;
      const absolute = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) files.push(relative);
        else if (stat.isDirectory()) {
          if (!options.skipDirectory?.(relative)) walk(absolute, relative);
        }
        else if (stat.isFile()) files.push(relative);
      } catch { /* file changed while being enumerated */ }
    }
  };
  walk(projectDir, '');
  return files.sort();
}

export function listProjectFilesAt(projectDir: string, rawRoot: string): string[] {
  const root = normalizedProjectPath(rawRoot);
  if (!root) return [];
  const absoluteRoot = join(projectDir, root);
  try {
    const stat = lstatSync(absoluteRoot);
    if (stat.isSymbolicLink() || stat.isFile()) return [root];
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  return listProjectFiles(absoluteRoot).map((path) => `${root}/${path}`);
}

/** A request already contained by a stable declared tree is a no-op, not a
 * new capability whose generated literal must retain an unchanged preimage. */
export function scopeRequestAlreadyAuthorized(
  requested: ParsedScope,
  priorScopes: readonly ParsedScope[],
): boolean {
  if (requested.kind === 'unknown') return false;
  const requestedAnchor = requested.kind === 'glob'
    ? requested.directoryPrefix
    : requested.value;
  if (!requestedAnchor) return false;
  return priorScopes.some((prior) => {
    if (prior.kind === 'unknown') return false;
    const requestedPattern = requested.kind === 'glob'
      ? normalizedProjectPath(requested.raw)
      : undefined;
    const priorPattern = prior.kind === 'glob'
      ? normalizedProjectPath(prior.raw)
      : undefined;
    if (requestedPattern && requestedPattern === priorPattern) return true;
    const priorRoot = literalTreeCapabilityRoot(prior);
    return Boolean(priorRoot
      && (requestedAnchor === priorRoot || requestedAnchor.startsWith(`${priorRoot}/`)));
  });
}

export interface DeclaredInputWriteBinding {
  /** Project-relative spelling from the admitted brief. */
  path: string;
  /** Canonical filesystem identity when the input exists. */
  resolvedPath: string;
  kind: 'file' | 'tree';
}

/** Resolve the exact launch-blocking input declaration. Missing inputs remain
 * protected lexically; setup owns the separate existence/readability refusal. */
export function resolveDeclaredInputWriteBindings(
  projectDir: string,
  brief: string,
): DeclaredInputWriteBinding[] {
  return verifyDeclaredBriefInputs(brief, projectDir).inputs.flatMap((input) => {
    const path = normalizedProjectPath(input.path);
    if (!path) return [];
    let kind: DeclaredInputWriteBinding['kind'] = 'file';
    try {
      if (statSync(input.resolvedPath).isDirectory()) kind = 'tree';
    } catch { /* setup reports a missing input; retain the lexical file reservation */ }
    return [{ path, resolvedPath: input.resolvedPath, kind }];
  });
}

function absolutePathContains(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Follow the longest existing prefix so aliases through a symlinked input tree
 * compare by identity even when the requested leaf does not exist yet. */
function canonicalPotentialProjectPath(projectDir: string, rawPath: string): string {
  const normalized = normalizedProjectPath(rawPath) ?? '';
  const segments = normalized ? normalized.split('/') : [];
  for (let length = segments.length; length >= 0; length--) {
    const prefix = segments.slice(0, length).join('/');
    try {
      const realPrefix = realpathSync(prefix ? join(projectDir, prefix) : projectDir);
      return resolve(realPrefix, ...segments.slice(length));
    } catch { /* try the next existing ancestor */ }
  }
  return resolve(projectDir, normalized);
}

function globMayMatchInputTree(scope: Extract<ParsedScope, { kind: 'glob' }>, inputTree: string): boolean {
  const inputSegments = inputTree.split('/').filter(Boolean);
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, inputIndex: number): boolean => {
    const key = `${patternIndex}:${inputIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    // The fixed input-tree prefix has been consumed. Every remaining supported
    // segment can describe some suffix below it (and no remainder describes the
    // tree node itself), so the two languages intersect.
    if (inputIndex === inputSegments.length) return true;
    if (patternIndex === scope.segments.length) return false;
    const segment = scope.segments[patternIndex];
    let result: boolean;
    if (segment.kind === 'globstar') {
      result = visit(patternIndex + 1, inputIndex) || visit(patternIndex, inputIndex + 1);
    } else if (segment.kind === 'literal') {
      result = segment.value === inputSegments[inputIndex]
        && visit(patternIndex + 1, inputIndex + 1);
    } else {
      try {
        result = posix.matchesGlob(inputSegments[inputIndex], segment.value)
          && visit(patternIndex + 1, inputIndex + 1);
      } catch {
        result = false;
      }
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function parsedScopeIntersectsInputPath(
  scope: ParsedScope,
  inputPath: string,
  inputKind: DeclaredInputWriteBinding['kind'],
): boolean {
  if (scope.kind === 'unknown') return true;
  if (inputKind === 'file') return scopeMatchesProjectPath(scope, inputPath);
  if (scope.kind === 'glob') return globMayMatchInputTree(scope, inputPath);
  return scope.value === inputPath
    || scope.value.startsWith(`${inputPath}/`)
    || inputPath.startsWith(`${scope.value}/`);
}

export interface DeclaredInputScopeConflict {
  scope: string;
  inputPath: string;
  inputKind: DeclaredInputWriteBinding['kind'];
  comparison: 'declared_path' | 'resolved_identity';
}

/** Intersect one write capability with one frozen input in both the authored
 * path namespace and the resolved filesystem namespace. */
export function declaredInputScopeConflict(
  rawScope: string,
  input: DeclaredInputWriteBinding,
  projectDir?: string,
): DeclaredInputScopeConflict | undefined {
  const scope = parseDeclaredScope(rawScope);
  if (parsedScopeIntersectsInputPath(scope, input.path, input.kind)) {
    return { scope: rawScope, inputPath: input.path, inputKind: input.kind, comparison: 'declared_path' };
  }
  if (!projectDir || scope.kind === 'unknown') return undefined;

  const anchor = scope.kind === 'glob' ? scope.directoryPrefix : scope.value;
  // A root-level glob has no alternative symlink identity to resolve; its
  // authored language was evaluated exactly above.
  if (scope.kind === 'glob' && !anchor) return undefined;
  const canonicalAnchor = canonicalPotentialProjectPath(projectDir, anchor);
  const canonicalInput = resolve(input.resolvedPath);

  if (scope.kind !== 'glob') {
    const overlaps = input.kind === 'tree'
      ? absolutePathContains(canonicalInput, canonicalAnchor)
        || absolutePathContains(canonicalAnchor, canonicalInput)
      : absolutePathContains(canonicalAnchor, canonicalInput);
    return overlaps
      ? { scope: rawScope, inputPath: input.path, inputKind: input.kind, comparison: 'resolved_identity' }
      : undefined;
  }

  if (input.kind === 'tree' && absolutePathContains(canonicalInput, canonicalAnchor)) {
    return { scope: rawScope, inputPath: input.path, inputKind: input.kind, comparison: 'resolved_identity' };
  }
  if (!absolutePathContains(canonicalAnchor, canonicalInput)) return undefined;
  const suffix = relative(canonicalAnchor, canonicalInput).replace(/\\/g, '/');
  const syntheticInput = [anchor, suffix].filter(Boolean).join('/');
  if (!parsedScopeIntersectsInputPath(scope, syntheticInput, input.kind)) return undefined;
  return { scope: rawScope, inputPath: input.path, inputKind: input.kind, comparison: 'resolved_identity' };
}

export function firstDeclaredInputScopeConflict(
  scopes: readonly string[],
  inputs: readonly DeclaredInputWriteBinding[],
  projectDir?: string,
): DeclaredInputScopeConflict | undefined {
  for (const scope of scopes) {
    for (const input of inputs) {
      const conflict = declaredInputScopeConflict(scope, input, projectDir);
      if (conflict) return conflict;
    }
  }
  return undefined;
}

export function scopeContainsPath(scope: string[], rawPath: string): boolean {
  const normalized = normalizedProjectPath(rawPath);
  if (!normalized) return false;
  return scope.some((entry) => scopeMatchesProjectPath(parseDeclaredScope(entry), normalized));
}

export function canonicalProjectWriteUnion(...collections: string[][]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const collection of collections) {
    for (const rawPath of collection) {
      const path = normalizedProjectPath(rawPath) ?? rawPath.trim().replace(/\\/g, '/');
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}
