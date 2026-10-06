/** Shared lexical path/scope predicates and typed boundary to the declared-input write policy; no parallel policy implementation. */
import { posix, isAbsolute } from 'node:path';
import { type ParsedScope } from './frontier.js';
import type { DeclaredInputWriteBinding } from '../../scheduler.js';

export interface DeclaredInputScopeServices {
  resolveDeclaredInputWriteBindings(projectDir: string, brief: string): DeclaredInputWriteBinding[];
  firstDeclaredInputScopeConflict(scopes: readonly string[], inputs: readonly DeclaredInputWriteBinding[], projectDir?: string): { scope: string; inputPath: string; inputKind: 'file' | 'tree'; comparison: 'declared_path' | 'resolved_identity' } | undefined;
}

export function normalizedProjectPath(value: string): string | undefined {
  const normalized = posix.normalize(value.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return undefined;
  return normalized;
}

export function scopeMatchesProjectPath(scope: ParsedScope, path: string): boolean {
  if (scope.kind === 'unknown') return true;
  if (scope.kind === 'glob') {
    const pattern = normalizedProjectPath(scope.raw);
    if (!pattern) return false;
    // A terminal directory glob is the capability language for "everything
    // below this literal tree". Node's matchesGlob excludes dotfile path
    // segments by default, which made `dist/**` reject build manifests and
    // atomic temporary files below dist. Keep other glob semantics exact and
    // expand only this unambiguous literal-tree form.
    if (pattern.endsWith('/**')) {
      const literalTree = pattern.slice(0, -3);
      if (literalTree && !/[*!?[{]/.test(literalTree)
        && (path === literalTree || path.startsWith(`${literalTree}/`))) {
        return true;
      }
    }
    try {
      // Concurrency admission is deliberately conservative, but authorization
      // must describe the declared language exactly. A literal-prefix tree
      // would grant one disjoint stage access to every peer below that prefix.
      return posix.matchesGlob(path, pattern);
    } catch {
      // An invalid glob is never an implicit broad capability.
      return false;
    }
  }
  return path === scope.value || path.startsWith(`${scope.value}/`);
}

export function literalTreeCapabilityRoot(scope: ParsedScope): string | undefined {
  if (scope.kind === 'exact' || scope.kind === 'tree') return scope.value;
  if (scope.kind !== 'glob') return undefined;
  const pattern = normalizedProjectPath(scope.raw);
  if (!pattern?.endsWith('/**')) return undefined;
  const root = pattern.slice(0, -3);
  return root && !/[*!?[{]/.test(root) ? root : undefined;
}
