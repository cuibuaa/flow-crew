import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withEngineCommandBoundary } from '../../src/write-boundary.js';
import { runValidationCommand } from '../../src/project-validation.js';

/** Keep the original distribution bytes/aliases, but give them the canonical
 * consumed-stage ownership topology. No alternate enforcement implementation. */
export async function withCanonicalValidationBoundary<T>(projectDir: string, engineDir: string, action: () => Promise<T>): Promise<T> {
  const consumed = join(engineDir, 'stages', 'consumed');
  mkdirSync(consumed, { recursive: true });
  for (const [source, target] of [
    [join(engineDir, 'dist'), join(consumed, 'dist')],
    [join(engineDir, '.cache', 'build-generations'), join(consumed, 'build-generations')],
  ]) {
    if (!existsSync(source) || lstatSync(source).isSymbolicLink()) continue;
    renameSync(source, target);
    symlinkSync(target, source, 'dir');
  }
  return withEngineCommandBoundary({ projectDir, runDir: engineDir, stageId: '_validation' }, action);
}

export function canonicalValidationProbe(projectDir: string, engineDir: string) {
  return withCanonicalValidationBoundary(projectDir, engineDir, () => runValidationCommand({
    role: 'test', command: process.execPath, args: ['-e', ''], cwd: projectDir,
    display: 'canonical validation boundary probe', timeoutMs: 5_000,
  }));
}
