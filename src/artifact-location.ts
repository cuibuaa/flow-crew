import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';

export type ArtifactLocation = { root: 'project' | 'run'; path: string };

export const ArtifactPathSchema = z.string().min(1).refine((path) => (
  !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
  && !path.split('/').some((part) => !part || part === '.' || part === '..')
  && !/[!*?{}[\]()]/.test(path)
), 'declare an exact, confined relative path without glob characters');

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

