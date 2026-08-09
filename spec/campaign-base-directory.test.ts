import { describe, expect, it } from 'vitest';
import { join, relative } from 'node:path';
import { campaignBaseDirectory } from '../src/config.js';

/**
 * The default campaign name is the basename of this directory. Deriving it from
 * projectDir gave every linked worktree its own campaign, splitting one line of
 * work across as many campaigns as there were worktrees.
 *
 * Both directions matter: worktrees must collapse onto the main repository, and
 * every non-repository case must keep resolving to projectDir unchanged — a
 * helper that always returned some git root would silently retarget projects
 * that are not repositories at all.
 *
 * `readCommonDir` is injected because tracked tests may not shell out to the
 * host. The stubbed outputs below are the two shapes real git produces, each
 * verified against a real repository and a real linked worktree before this
 * test was written:
 *
 *   ordinary checkout   `git rev-parse --git-common-dir` -> ".git"
 *   linked worktree     -> "/abs/path/to/main-repo/.git"
 *   not a repository    -> throws
 */

const ROOT = join('/tmp', 'campaign-base-fixture');

describe('campaignBaseDirectory', () => {
  it('returns the repository itself for an ordinary (non-worktree) checkout', () => {
    const repo = join(ROOT, 'my-project');

    expect(campaignBaseDirectory(repo, { readCommonDir: () => '.git\n' })).toBe(repo);
  });

  it('returns the main worktree for a linked worktree, so both share one campaign', () => {
    const mainRepo = join(ROOT, 'main-repo');
    const linked = join(ROOT, 'feature-worktree');

    const resolved = campaignBaseDirectory(linked, {
      readCommonDir: () => `${join(mainRepo, '.git')}\n`,
    });

    // The directory basenames differ; the campaign must follow the repository.
    expect(resolved).toBe(mainRepo);
    expect(resolved).not.toBe(linked);
  });

  it('resolves a subdirectory of a repository to that repository', () => {
    const repo = join(ROOT, 'nested-project');
    const inner = join(repo, 'src', 'deep');

    // git reports the common dir relative to cwd from inside a subdirectory.
    const resolved = campaignBaseDirectory(inner, {
      readCommonDir: () => `${relative(inner, join(repo, '.git'))}\n`,
    });

    expect(resolved).toBe(repo);
  });

  it('falls back to projectDir when the directory is not a git repository', () => {
    const plain = join(ROOT, 'not-a-repo');

    const resolved = campaignBaseDirectory(plain, {
      readCommonDir: () => { throw new Error('not a git repository'); },
    });

    expect(resolved).toBe(plain);
  });

  it('falls back to projectDir when git reports nothing', () => {
    const plain = join(ROOT, 'silent-git');

    expect(campaignBaseDirectory(plain, { readCommonDir: () => '  \n' })).toBe(plain);
  });
});
