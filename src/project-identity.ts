import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function gitCommonDirectory(projectDir: string): string | undefined {
  const dotGit = join(resolve(projectDir), '.git');
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) return canonicalPath(dotGit);
    if (!stat.isFile()) return undefined;

    const declaration = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!declaration) return undefined;
    const gitDir = canonicalPath(isAbsolute(declaration)
      ? declaration
      : resolve(projectDir, declaration));
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim();
      if (common) return canonicalPath(isAbsolute(common) ? common : resolve(gitDir, common));
    } catch { /* an ordinary gitdir is already the common directory */ }
    return gitDir;
  } catch {
    return undefined;
  }
}

/**
 * Stable, opaque persistence identity for one repository. Linked Git
 * worktrees share their common directory; non-Git projects retain a
 * canonical-directory identity and therefore stay isolated.
 */
export function projectPersistenceIdentity(projectDir: string): string {
  const gitCommon = gitCommonDirectory(projectDir);
  const kind = gitCommon ? 'git' : 'path';
  const anchor = gitCommon ?? canonicalPath(projectDir);
  const digest = createHash('sha256').update(`${kind}\0${anchor}`, 'utf8').digest('hex');
  return `${kind}-sha256:${digest}`;
}
