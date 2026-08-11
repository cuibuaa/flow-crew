import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runShipSetup,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string;
let projectDir: string;
let previousGlobalDir: string;

function writeNodeProject(): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    scripts: { build: 'fixture-build', test: 'vitest run', lint: 'fixture-lint' },
  }));
  writeFileSync(join(projectDir, 'package-lock.json'), '{}');
}

function setupArgs(briefPath: string, targetDir: string): string[] {
  return [
    'ship-setup', '--brief', briefPath, '--project', projectDir,
    '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
  ];
}

function copyManifest(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(projectDir, 'package.json'), join(targetDir, 'package.json'));
  copyFileSync(join(projectDir, 'package-lock.json'), join(targetDir, 'package-lock.json'));
}

const collectTests: ValidationCommandRunner = (request) => {
  const identities: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.test\.tsx?$/.test(entry.name)) identities.push(path);
    }
  };
  visit(request.cwd);
  return { exitCode: 0, stdout: JSON.stringify(identities.sort().map((file) => ({ file }))) };
};

beforeEach(() => {
  previousGlobalDir = fcGlobalDir();
  root = join(tmpdir(), `flowcrew-ship-setup-population-${randomBytes(6).toString('hex')}`);
  projectDir = join(root, 'source');
  setFcGlobalDir(join(root, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousGlobalDir);
  rmSync(root, { recursive: true, force: true });
});

describe('ship-setup test population integrity', () => {
  it('refuses equal-sized source and target populations when their identities differ', async () => {
    writeNodeProject();
    mkdirSync(join(projectDir, 'spec'), { recursive: true });
    writeFileSync(join(projectDir, 'spec', 'source.test.ts'), 'export {};\n');
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '# Goal\nRun the configured test population.\n');
    const targetDir = join(root, 'target');
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      copyManifest(request.targetDir);
      mkdirSync(join(request.targetDir, 'spec'), { recursive: true });
      writeFileSync(join(request.targetDir, 'spec', 'target.test.ts'), 'export {};\n');
      return { exitCode: 0 };
    });
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree,
      runTestCollectionCommand: collectTests,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        source: { count: 1 },
        target: { count: 1 },
        missingFromTarget: ['spec/source.test.ts'],
        extraInTarget: ['spec/target.test.ts'],
      },
    });
    expect(baseline).not.toHaveBeenCalled();
  });

  it('refuses a declared target directory that resolves outside the launch workspace', async () => {
    writeNodeProject();
    mkdirSync(join(projectDir, 'checks'), { recursive: true });
    writeFileSync(join(projectDir, 'checks', 'private.test.ts'), 'export {};\n');
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '---\ninputs:\n  - checks\n---\n# Goal\nRun the configured checks.\n');
    const targetDir = join(root, 'target');
    const outside = join(root, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'unchanged\n');
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      copyManifest(request.targetDir);
      symlinkSync(outside, join(request.targetDir, 'checks'), 'dir');
      return { exitCode: 0 };
    });
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree,
      runTestCollectionCommand: collectTests,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'target',
        input: 'checks',
        reason: expect.stringContaining('resolves outside the worktree'),
      })],
    });
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf-8')).toBe('unchanged\n');
    expect(baseline).not.toHaveBeenCalled();
  });
});
