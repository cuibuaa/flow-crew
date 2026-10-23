import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanupPaths.push(root);
  return root;
}

function createUpwardResolutionBuildFixture(root: string): { projectDir: string; stagingRoot: string } {
  const parent = join(root, 'build-parent');
  const projectDir = join(parent, 'project');
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  cpSync(join(repositoryRoot, 'src'), join(projectDir, 'src'), { recursive: true });
  copyFileSync(join(repositoryRoot, 'scripts', 'build.ts'), join(projectDir, 'scripts', 'build.ts'));
  copyFileSync(join(repositoryRoot, 'package.json'), join(projectDir, 'package.json'));
  copyFileSync(join(repositoryRoot, 'tsconfig.json'), join(projectDir, 'tsconfig.json'));
  symlinkSync(realpathSync.native(join(repositoryRoot, 'node_modules')), join(parent, 'node_modules'), 'dir');
  const checkoutKey = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const stagingRoot = join(realpathSync.native(tmpdir()), `flowcrew-build-${checkoutKey}`);
  cleanupPaths.push(stagingRoot);
  return { projectDir, stagingRoot };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

describe('ship-setup JavaScript validation environment', () => {
  it('builds using dependencies resolved from the parent directory', () => {
    const root = temporaryRoot('flowcrew-ship-setup-node-deps-');
    const upwardBuild = createUpwardResolutionBuildFixture(root);
    const build = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
      cwd: upwardBuild.projectDir,
      encoding: 'utf-8',
      env: { ...process.env, HOME: root, FC_HOME: join(root, 'build-state') },
      timeout: 120_000,
    });

    expect(build.status, `${build.stdout ?? ''}\n${build.stderr ?? ''}`).toBe(0);
  }, 180_000);

});
