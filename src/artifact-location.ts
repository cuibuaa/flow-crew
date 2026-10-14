import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';

export type ArtifactLocation = { root: 'project' | 'run'; path: string };

// Locations are literal filesystem names. Scope expressions own glob syntax;
// punctuation here never expands into other paths or grants additional writes.
const literalRelativePath = /^(?!\.{1,2}(?:\/|$))[^/\\\0]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\\0]+)*$/;
export const ARTIFACT_PATH_PATTERN = literalRelativePath.source;
export const ArtifactPathSchema = z.string().min(1).refine(
  path => !isAbsolute(path) && literalRelativePath.test(path),
  'declare a literal, confined relative path');

export function artifactRootContains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

/** Both lexical and prospective physical confinement are required. */
export function resolveArtifactLocation(location: ArtifactLocation, projectDir: string, runDir: string): string {
  ArtifactPathSchema.parse(location.path);
  const root = realpathSync(location.root === 'run' ? runDir : projectDir);
  const target = resolve(root, location.path);
  if (!artifactRootContains(root, prospectivePhysicalPath(target))) throw new Error(`ARTIFACT_PATH_ESCAPE: ${location.root}:${location.path} resolves outside its root`);
  return target;
}

