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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runShipSetup,
  type GitCommandRunner,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanupPaths.push(root);
  return root;
}

function writeNodeProject(root: string): { projectDir: string; briefPath: string } {
  const projectDir = join(root, 'source');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    scripts: { build: 'fixture-build', test: 'vitest run', lint: 'fixture-lint' },
  }));
  writeFileSync(join(projectDir, 'package-lock.json'), '{}');
  const briefPath = join(projectDir, 'brief.md');
  writeFileSync(briefPath, '# Goal\nValidate the locked JavaScript worktree.\n');
  return { projectDir, briefPath };
}

function writeParentVitest(root: string): string {
  const packageDir = join(root, 'node_modules', 'vitest');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'vitest',
    version: '0.0.0-fixture',
    type: 'module',
    exports: { './package.json': './package.json' },
  }));
  const executable = join(packageDir, 'vitest.mjs');
  writeFileSync(executable, 'export {};\n');
  return executable;
}

function setupArgs(projectDir: string, briefPath: string, targetDir: string): string[] {
  return [
    'ship-setup', '--brief', briefPath, '--project', projectDir,
    '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
  ];
}

function createFixtureWorktree(projectDir: string, events: string[]): ReturnType<typeof vi.fn<GitWorktreeCreator>> {
  return vi.fn<GitWorktreeCreator>((request) => {
    events.push('worktree');
    mkdirSync(request.targetDir, { recursive: true });
    copyFileSync(join(projectDir, 'package.json'), join(request.targetDir, 'package.json'));
    copyFileSync(join(projectDir, 'package-lock.json'), join(request.targetDir, 'package-lock.json'));
    return { exitCode: 0 };
  });
}

function successfulValidation(events: string[]): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => {
    events.push(`baseline:${request.role}`);
    return { exitCode: 0, stdout: `${request.role} passed`, durationMs: 5 };
  });
}

function collectionRunner(expectedExecutable: string, events: string[]): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => {
    events.push(`collect:${request.cwd}`);
    expect(request.command).toBe(process.execPath);
    expect(request.args[0]).toBe(expectedExecutable);
    return { exitCode: 0, stdout: '[]', durationMs: 3 };
  });
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

describe('ship-setup locked JavaScript dependency preparation', () => {
  it('G1 installs locked JS dependencies before baseline, safely reruns, and uses Node lookup paths', async () => {
    const root = temporaryRoot('flowcrew-ship-setup-node-deps-');
    const upwardBuild = createUpwardResolutionBuildFixture(root);
    const build = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
      cwd: upwardBuild.projectDir,
      encoding: 'utf-8',
      env: { ...process.env, FC_HOME: join(root, 'build-state') },
      timeout: 120_000,
    });

    const expectedVitest = writeParentVitest(root);
    const { projectDir, briefPath } = writeNodeProject(root);
    const targetDir = join(root, 'target');
    const events: string[] = [];
    const createWorktree = createFixtureWorktree(projectDir, events);
    const install = vi.fn((request: { command: string; args: string[]; cwd: string }) => {
      events.push('install');
      expect(request).toEqual({ command: 'npm', args: ['ci'], cwd: targetDir, display: 'npm ci' });
      return { exitCode: 0, stdout: 'installed', durationMs: 37 };
    });
    const collect = collectionRunner(expectedVitest, events);
    const baseline = successfulValidation(events);
    const report = await runShipSetup(setupArgs(projectDir, briefPath, targetDir), {
      createWorktree,
      runDependencyInstallCommand: install,
      runTestCollectionCommand: collect,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    const retryTarget = join(root, 'retry-target');
    const retryEvents: string[] = [];
    const retryWorktree = createFixtureWorktree(projectDir, retryEvents);
    const failedInstall = vi.fn(() => ({ exitCode: 1, stderr: 'registry unavailable', durationMs: 11 }));
    const firstRetry = await runShipSetup(setupArgs(projectDir, briefPath, retryTarget), {
      createWorktree: retryWorktree,
      runDependencyInstallCommand: failedInstall,
      runTestCollectionCommand: collectionRunner(expectedVitest, retryEvents),
      runValidationCommand: successfulValidation(retryEvents),
      globalDir: () => join(root, 'retry-state'),
    });
    const head = '1234567890abcdef1234567890abcdef12345678';
    const git = vi.fn<GitCommandRunner>((request) => {
      if (request.args[0] === 'worktree') {
        return {
          exitCode: 0,
          stdout: `worktree ${retryTarget}\0HEAD ${head}\0branch refs/heads/fixture-branch\0\0`,
        };
      }
      expect(request.args).toEqual(['rev-parse', '--verify', '--end-of-options', 'fixture-base^{commit}']);
      return { exitCode: 0, stdout: `${head}\n` };
    });
    const successfulRetryInstall = vi.fn(() => ({ exitCode: 0, durationMs: 19 }));
    const secondRetry = await runShipSetup(setupArgs(projectDir, briefPath, retryTarget), {
      createWorktree: retryWorktree,
      runGitCommand: git,
      runDependencyInstallCommand: successfulRetryInstall,
      runTestCollectionCommand: collectionRunner(expectedVitest, retryEvents),
      runValidationCommand: successfulValidation(retryEvents),
      globalDir: () => join(root, 'retry-state'),
    });

    const missingRoot = temporaryRoot('flowcrew-ship-setup-node-resolver-missing-');
    const missingProject = writeNodeProject(missingRoot);
    const missingTarget = join(missingRoot, 'target');
    const missingReport = await runShipSetup(
      setupArgs(missingProject.projectDir, missingProject.briefPath, missingTarget),
      {
        createWorktree: createFixtureWorktree(missingProject.projectDir, []),
        runDependencyInstallCommand: vi.fn(() => ({ exitCode: 0, durationMs: 1 })),
        runValidationCommand: successfulValidation([]),
        globalDir: () => join(missingRoot, 'state'),
      },
    );

    expect(build.status, `${build.stdout ?? ''}\n${build.stderr ?? ''}`).toBe(0);
    expect(report).toMatchObject({
      state: 'ready',
      dependencyInstall: {
        state: 'installed', command: 'npm', args: ['ci'], exitCode: 0, durationMs: 37,
      },
    });
    expect(events.indexOf('install')).toBeGreaterThan(events.indexOf('worktree'));
    expect(events.indexOf('install')).toBeLessThan(events.findIndex((entry) => entry.startsWith('collect:')));
    expect(events.indexOf('install')).toBeLessThan(events.findIndex((entry) => entry.startsWith('baseline:')));
    expect(firstRetry).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      dependencyInstall: { state: 'failed', exitCode: 1, durationMs: 11 },
      blockers: [{ phase: 'dependency', reason: expect.stringContaining('npm ci') }],
    });
    expect(firstRetry.blockers[0].repair).toMatch(/node_modules.*npm ci.*rerun/i);
    expect(secondRetry).toMatchObject({ state: 'ready', worktreeCreated: false, worktreeReused: true });
    expect(retryWorktree).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledTimes(2);
    expect(missingReport.testPopulation?.reason).toMatch(/Cannot resolve vitest.*lookup paths:/i);
  }, 180_000);

  it('G1 refuses a missing node_modules without an npm lockfile with an actionable retry', async () => {
    const root = temporaryRoot('flowcrew-ship-setup-node-no-lock-');
    writeParentVitest(root);
    const { projectDir, briefPath } = writeNodeProject(root);
    rmSync(join(projectDir, 'package-lock.json'));
    const targetDir = join(root, 'target');
    const install = vi.fn();
    const report = await runShipSetup(setupArgs(projectDir, briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        mkdirSync(request.targetDir, { recursive: true });
        copyFileSync(join(projectDir, 'package.json'), join(request.targetDir, 'package.json'));
        return { exitCode: 0 };
      }),
      runDependencyInstallCommand: install,
      runValidationCommand: successfulValidation([]),
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      dependencyInstall: { state: 'manual_required', display: 'npm ci', exitCode: null },
      blockers: [{
        phase: 'dependency',
        reason: expect.stringMatching(/no node_modules or npm lockfile/i),
        repair: expect.stringMatching(/restore.*lockfile.*or install dependencies.*rerun/i),
      }],
    });
    expect(install).not.toHaveBeenCalled();
  });
});
