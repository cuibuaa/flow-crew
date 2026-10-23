// Bind task-frozen identities once; inventory ordinary output through Git and retain planner matching for reporting.
import { spawnSync } from "node:child_process";
import { basename, dirname, join, isAbsolute, relative, resolve } from "node:path";
import { lstatSync, readdirSync, statSync, realpathSync } from "node:fs";
import { normalizedProjectPath, normalizedProjectContentPath, scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { parseDeclaredScope } from "../sched_admission/frontier.js";
import { extractBriefOutputDeclarations, parseBriefInputs } from "../../ship-inputs.js";


export function listProjectFiles(
  projectDir: string,
  options: { skipDirectory?: (relativePath: string) => boolean; complete?: boolean } = {},
): string[] {
  if (!options.complete) {
    const inventory = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (inventory.status === 0) return [...new Set(inventory.stdout.split('\0'))]
      .filter(path => normalizedProjectContentPath(path) !== undefined
        && !path.split('/').slice(0, -1).some((_, i, parts) => options.skipDirectory?.(parts.slice(0, i + 1).join('/'))))
      .sort();
  }
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) { if (options.complete) throw error; return; }
    for (const name of names) {
      const absolute = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!normalizedProjectContentPath(relative)) continue;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) files.push(relative);
        else if (stat.isDirectory()) {
          if (options.complete) files.push(relative);
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
    const code = (error as NodeJS.ErrnoException).code;
    if (options.complete && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return [];
  }
  return listProjectFiles(absoluteRoot, options).map((path) => `${root}/${path}`);
}

export interface ImmutableEvidenceBinding {
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

/** Freeze structured input identities before authors start. Explicit output
 * declarations retain precedence; planner estimates cannot amend evidence. */
export function resolveImmutableEvidenceBindings(projectDir: string, brief: string): ImmutableEvidenceBinding[] {
  const frozen = parseBriefInputs(brief).references.filter(input => input.frozen === true).map(input => input.path);
  const outputs = extractBriefOutputDeclarations(brief).flatMap(output => {
    const path = normalizedProjectPath(output.path);
    return path ? [{ path, resolvedPaths: [canonicalPotentialProjectPath(projectDir, path),
      join(canonicalPotentialProjectPath(projectDir, dirname(path)), basename(path))],
      kind: output.expectedType === 'directory' ? 'tree' as const : 'file' as const }] : [];
  });
  return frozen.map(path => {
    const resolvedPath = canonicalPotentialProjectPath(projectDir, path);
    let kind: ImmutableEvidenceBinding['kind'] = 'file';
    try { if (statSync(join(projectDir, path)).isDirectory()) kind = 'tree'; } catch { /* preserve observed absence */ }
    return { path, resolvedPath, kind, outputs };
  });
}

function absolutePathContains(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Follow the longest existing prefix so aliases through a symlinked input tree
 * compare by identity even when the requested leaf does not exist yet. */
export function canonicalPotentialProjectPath(projectDir: string, rawPath: string): string {
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

export interface ImmutableEvidenceConflict {
  scope: string;
  inputPath: string;
  inputKind: ImmutableEvidenceBinding['kind'];
  comparison: 'declared_path' | 'resolved_identity';
}

/** Compare a concrete member with the already-bound task identities. Exact
 * task outputs override preservation only inside their canonical location. */
export function immutableEvidenceConflict(path: string, input: ImmutableEvidenceBinding, projectDir?: string): ImmutableEvidenceConflict | undefined {
  const normalized = normalizedProjectContentPath(path);
  if (!normalized) return undefined;
  const canonical = projectDir ? canonicalPotentialProjectPath(projectDir, normalized) : normalized;
  if (input.outputs?.some(output => (projectDir ? output.resolvedPaths : [output.path]).some(root =>
    output.kind === 'tree' ? absolutePathContains(root, canonical) : root === canonical))) return undefined;
  if (normalized === input.path || input.kind === 'tree' && normalized.startsWith(`${input.path}/`)) {
    return { scope: path, inputPath: input.path, inputKind: input.kind, comparison: 'declared_path' };
  }
  if (projectDir && (input.kind === 'tree' ? absolutePathContains(input.resolvedPath, canonical) : input.resolvedPath === canonical)) {
    return { scope: path, inputPath: input.path, inputKind: input.kind, comparison: 'resolved_identity' };
  }
  return undefined;
}

export function firstImmutableEvidenceConflict(
  scopes: readonly string[],
  inputs: readonly ImmutableEvidenceBinding[],
  projectDir?: string,
): ImmutableEvidenceConflict | undefined {
  for (const scope of scopes) {
    for (const input of inputs) {
      const conflict = immutableEvidenceConflict(scope, input, projectDir);
      if (conflict) return conflict;
    }
  }
  return undefined;
}

/** Planner membership is reporting metadata, never write authority. */
export function scopeContainsPath(scope: string[], rawPath: string): boolean {
  const normalized = normalizedProjectPath(rawPath);
  return Boolean(normalized && scope.some(entry => scopeMatchesProjectPath(parseDeclaredScope(entry), normalized)));
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
