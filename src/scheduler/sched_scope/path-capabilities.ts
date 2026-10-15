// Boundary: Intersect write capabilities with preserved input identities, excluding declared outputs; reuse admission scope parsing and matching.
import { ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES } from "../../generated-path-policy.js";
import { basename, dirname, join, isAbsolute, relative, resolve } from "node:path";
import { lstatSync, readdirSync, statSync, realpathSync } from "node:fs";
import { normalizedProjectPath, normalizedProjectContentPath, literalTreeCapabilityRoot, scopeMatchesProjectPath, scopeLanguagesMayOverlap } from "../sched_admission/scope-services.js";
import { type ParsedScope, parseDeclaredScope } from "../sched_admission/frontier.js";
import { extractBriefOutputDeclarations, verifyDeclaredBriefInputs } from "../../ship-inputs.js";

export const REPAIR_DIFF_SKIP_DIRS = ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES;

export function listProjectFiles(
  projectDir: string,
  options: { skipDirectory?: (relativePath: string) => boolean; complete?: boolean } = {},
): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) { if (options.complete) throw error; return; }
    for (const name of names) {
      if (!options.complete && REPAIR_DIFF_SKIP_DIRS.has(name)) continue;
      const absolute = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) files.push(relative);
        else if (stat.isDirectory()) {
          if (!options.skipDirectory?.(relative)) walk(absolute, relative);
        }
        else if (stat.isFile()) files.push(relative);
      } catch (error) { if (options.complete) throw error; /* file changed while being enumerated */ }
    }
  };
  walk(projectDir, '');
  return files.sort();
}

export function listProjectFilesAt(projectDir: string, rawRoot: string, followRootAlias = false,
  options: Parameters<typeof listProjectFiles>[1] = {}): string[] {
  const root = normalizedProjectContentPath(rawRoot);
  if (!root) return [];
  const absoluteRoot = join(projectDir, root);
  try {
    const stat = lstatSync(absoluteRoot);
    if (stat.isSymbolicLink()) {
      try {
        if (followRootAlias && statSync(absoluteRoot).isDirectory()) return [root, ...listProjectFiles(absoluteRoot, options).map(path => `${root}/${path}`)];
      } catch (error) { if (options.complete) throw error; /* retain a dangling alias as a leaf */ }
      return [root];
    }
    if (stat.isFile()) return [root];
    if (!stat.isDirectory()) return [];
  } catch (error) {
    if (options.complete && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  return listProjectFiles(absoluteRoot, options).map((path) => `${root}/${path}`);
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
  /** Explicit output capabilities take precedence over input preservation. */
  outputs?: readonly {
    path: string;
    resolvedPaths: readonly string[];
    kind: 'file' | 'tree';
  }[];
}

/** Resolve the exact launch-blocking input declaration. Missing inputs remain
 * protected lexically; setup owns the separate existence/readability refusal. */
export function resolveDeclaredInputWriteBindings(
  projectDir: string,
  brief: string,
): DeclaredInputWriteBinding[] {
  const outputs = extractBriefOutputDeclarations(brief).flatMap((output) => {
    const path = normalizedProjectPath(output.path);
    return path ? [{ path, resolvedPaths: [canonicalPotentialProjectPath(projectDir, path),
      // Replacing an output symlink authorizes its entry as well as its target.
      join(canonicalPotentialProjectPath(projectDir, dirname(path)), basename(path))],
      kind: output.expectedType === 'directory' ? 'tree' as const : 'file' as const }] : [];
  });
  return verifyDeclaredBriefInputs(brief, projectDir).inputs.flatMap((input) => {
    const path = normalizedProjectPath(input.path);
    if (!path) return [];
    let kind: DeclaredInputWriteBinding['kind'] = 'file';
    try {
      if (statSync(input.resolvedPath).isDirectory()) kind = 'tree';
    } catch { /* setup reports a missing input; retain the lexical file reservation */ }
    return [{ path, resolvedPath: input.resolvedPath, kind, outputs }];
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

function parsedScopeIntersectsInputPath(
  scope: ParsedScope,
  inputPath: string,
  inputKind: DeclaredInputWriteBinding['kind'],
): boolean {
  return inputKind === 'file'
    ? scopeMatchesProjectPath(scope, inputPath)
    : scopeLanguagesMayOverlap(scope, { kind: 'tree', raw: inputPath, value: inputPath });
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
  const anchor = scope.kind === 'glob' ? scope.directoryPrefix : scope.kind === 'unknown' ? undefined : scope.value;
  // A declaration authorizes its file, or its directory tree, rather than the
  // enclosing input. Check the whole requested capability so broad revisions
  // cannot use one output to release protected siblings.
  if (anchor && input.outputs?.some(output => {
    const contains = (root: string, candidate: string): boolean => output.kind === 'tree'
      ? absolutePathContains(root, candidate)
      : scope.kind === 'exact' && root === candidate;
    return projectDir === undefined ? contains(output.path, anchor)
      : output.resolvedPaths.some(root => contains(root, canonicalPotentialProjectPath(projectDir, anchor)));
  })) return undefined;
  if (parsedScopeIntersectsInputPath(scope, input.path, input.kind)) {
    return { scope: rawScope, inputPath: input.path, inputKind: input.kind, comparison: 'declared_path' };
  }
  if (!projectDir || scope.kind === 'unknown') return undefined;

  // A root-level glob has no alternative symlink identity to resolve; its
  // authored language was evaluated exactly above.
  if (scope.kind === 'glob' && !anchor) return undefined;
  const canonicalAnchor = canonicalPotentialProjectPath(projectDir, anchor ?? '');
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

/** Admission, live enforcement, settlement and revisions share the same input
 * preservation rule, including the brief's explicit output authorizations. */
export function scopeContainsPath(scope: string[], rawPath: string, projectDir?: string, inputs: readonly DeclaredInputWriteBinding[] = []): boolean {
  const normalized = normalizedProjectPath(rawPath);
  if (!normalized) return false;
  return !firstDeclaredInputScopeConflict([normalized], inputs, projectDir)
    && scope.some((entry) => scopeMatchesProjectPath(parseDeclaredScope(entry), normalized));
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
