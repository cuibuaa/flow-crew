import { isAbsolute, relative, resolve } from 'node:path';
import { resolveArtifactLocation } from '../artifact-location.js';
import type { ArtifactRead } from '../artifact-declarations.js';
import type { CheckDecl, CheckContext } from './types.js';

function covers(read: ArtifactRead, path: string): boolean {
  return read.path === path || read.kind === 'directory' && path.startsWith(`${read.path}/`);
}

/** These fields are handler API inputs. Shell/script text is never inspected. */
export function realityHandlerInputs(check: Exclude<CheckDecl, { kind: 'invalid' }>): string[] {
  const params = check.params as Record<string, unknown>;
  const paths: unknown[] = [];
  if (check.type === 'file-exists-nonempty') {
    if (Array.isArray(params.paths)) paths.push(...params.paths);
    else if (params.paths && typeof params.paths === 'object') paths.push((params.paths as { from_manifest?: unknown }).from_manifest);
  } else if (['json-schema-match', 'variance-floor'].includes(check.type)) {
    paths.push(params.file);
    if (check.type === 'json-schema-match' && params.schema && typeof params.schema === 'object') paths.push((params.schema as { file?: unknown }).file);
  } else if (check.type === 'static-ast-scan') paths.push(params.glob);
  else if (check.type === 'exec-script-exit-zero' && Array.isArray(params.archive_paths)) paths.push(...params.archive_paths);
  return paths.filter((path): path is string => typeof path === 'string');
}

export function inspectRealityHandlerReads(check: Exclude<CheckDecl, { kind: 'invalid' }>, projectDir: string, runDir: string): string[] {
  const errors: string[] = [];
  for (const path of realityHandlerInputs(check)) {
    const reads = (check.reads ?? []).filter((read) => covers(read, path));
    if (!reads.length) errors.push(`ARTIFACT_HANDLER_READ_UNDECLARED: reality check ${JSON.stringify(check.name)}.reads must declare the exact rooted handler input ${path}, or its exact directory for a glob/manifest member`);
    else if (new Set(reads.map((read) => read.root)).size > 1) errors.push(`ARTIFACT_HANDLER_READ_AMBIGUOUS: reality check ${JSON.stringify(check.name)}.reads declares ${path} in both roots; choose the handler's exact root`);
    for (const read of reads) try { resolveArtifactLocation(read, projectDir, runDir); } catch (error) { errors.push(String(error)); }
  }
  return errors;
}

/** A declared root never falls back to an identically named file in another root. */
export function resolveDeclaredRealityPath(value: string, context: CheckContext): string {
  const matches = (context.declaredReads ?? []).flatMap((read) => {
    const anchor = read.root === 'run' ? context.taskDir : context.projectDir;
    const path = isAbsolute(value) ? relative(anchor, value).split('\\').join('/') : value;
    if (!covers(read, path)) return [];
    const candidate = resolveArtifactLocation({ root: read.root, path }, context.projectDir, context.taskDir);
    return [candidate];
  });
  const paths = [...new Set(matches)];
  if (paths.length !== 1) throw new Error(`ARTIFACT_HANDLER_READ_UNDECLARED: ${value} must resolve to exactly one declared rooted input; observed ${paths.length}`);
  return resolve(paths[0]);
}
