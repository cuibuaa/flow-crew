import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function createBuildFixture(): { projectDir: string; stagingRoot: string } {
  const fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-build-cache-regression-')));
  cleanupPaths.push(fixtureRoot);
  const projectDir = join(fixtureRoot, 'project');
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  cpSync(join(repositoryRoot, 'src'), join(projectDir, 'src'), { recursive: true });
  copyFileSync(join(repositoryRoot, 'scripts', 'build.ts'), join(projectDir, 'scripts', 'build.ts'));
  copyFileSync(join(repositoryRoot, 'package.json'), join(projectDir, 'package.json'));
  copyFileSync(join(repositoryRoot, 'tsconfig.json'), join(projectDir, 'tsconfig.json'));
  symlinkSync(realpathSync.native(join(repositoryRoot, 'node_modules')), join(projectDir, 'node_modules'), 'dir');
  const checkoutKey = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const stagingRoot = join(realpathSync.native(tmpdir()), `flowcrew-build-${checkoutKey}`);
  cleanupPaths.push(stagingRoot);
  return { projectDir, stagingRoot };
}

function runBuild(projectDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, HOME: projectDir, FC_HOME: join(projectDir, '.fc-test-state') },
    timeout: 120_000,
  });
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

describe('transactional TypeScript build staging', () => {
  it('F1 rebuilds after staging deletion while an older incremental build record exists', () => {
    const { projectDir, stagingRoot } = createBuildFixture();
    const first = runBuild(projectDir);
    expect(first.status, `${first.stdout ?? ''}\n${first.stderr ?? ''}`).toBe(0);

    const legacyBuildInfo = join(projectDir, '.cache', 'tsc.tsbuildinfo');
    const stagingBuildInfo = join(stagingRoot, 'dist', '.tsbuildinfo');
    if (!existsSync(legacyBuildInfo) && existsSync(stagingBuildInfo)) {
      mkdirSync(dirname(legacyBuildInfo), { recursive: true });
      copyFileSync(stagingBuildInfo, legacyBuildInfo);
    }
    expect(readFileSync(legacyBuildInfo).byteLength).toBeGreaterThan(0);
    rmSync(stagingRoot, { recursive: true, force: true });

    const second = runBuild(projectDir);
    expect(second.status, `${second.stdout ?? ''}\n${second.stderr ?? ''}`).toBe(0);
    expect(existsSync(join(projectDir, 'dist', 'cli.js'))).toBe(true);
  }, 180_000);
});
