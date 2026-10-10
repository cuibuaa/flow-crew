import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdShipSetupWithDeps,
  runShipSetup,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string;
let projectDir: string;
let previousGlobalDir: string;

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

function writeNodeProject(): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    scripts: { build: 'fixture-build', test: 'vitest run', lint: 'fixture-lint' },
  }));
  writeFileSync(join(projectDir, 'package-lock.json'), '{}');
}

function writeRunnerProject(testScript: string): string {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    scripts: { test: testScript },
  }));
  writeFileSync(join(projectDir, 'package-lock.json'), '{}');
  const briefPath = join(projectDir, 'brief.md');
  writeFileSync(briefPath, '# Goal\nRun the configured test population.\n');
  return briefPath;
}

function tap(names: readonly string[], failing = new Set<number>()): string {
  return [
    'TAP version 13',
    ...names.flatMap((name, index) => [
      `# Subtest: ${name}`,
      '    1..1',
      `    ${failing.has(index + 1) ? 'not ok' : 'ok'} 1 - nested assertion`,
      `${failing.has(index + 1) ? 'not ok' : 'ok'} ${index + 1} - ${name}`,
    ]),
    `1..${names.length}`,
    `# tests ${names.length}`,
    `# pass ${names.length - failing.size}`,
    `# fail ${failing.size}`,
  ].join('\n');
}

function setupArgs(briefPath: string, targetDir: string): string[] {
  return [
    'ship-setup', '--brief', briefPath, '--project', projectDir,
    '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
  ];
}

function copyManifest(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'node_modules'), { recursive: true });
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
  // Canonicalize the fixture root: on macOS the temp directory is reached through a
    // symlink (/var -> /private/var), so an uncanonicalized root makes every derived
    // path differ from what the code under test computes. Reproducible on Linux by
    // pointing TMPDIR at a symlink.
    root = join(realpathSync.native(tmpdir()), `flowcrew-ship-setup-population-${randomBytes(6).toString('hex')}`);
  projectDir = join(root, 'source');
  const fixtureVitest = join(root, 'node_modules', 'vitest');
  mkdirSync(fixtureVitest, { recursive: true });
  writeFileSync(join(fixtureVitest, 'package.json'), JSON.stringify({
    name: 'vitest', version: '0.0.0-fixture', exports: { './package.json': './package.json' },
  }));
  writeFileSync(join(fixtureVitest, 'vitest.mjs'), 'export {};\n');
  setFcGlobalDir(join(root, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousGlobalDir);
  rmSync(root, { recursive: true, force: true });
});

describe('ship-setup test population integrity', () => {
  it('keeps mixed Python/JS population unverified while executing and recording both configured commands', async () => {
    const briefPath = writeRunnerProject('vitest run');
    const python = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
    writeFileSync(join(projectDir, 'pyproject.toml'), python);
    const targetDir = join(root, 'target-mixed');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: '1 passed' }));
    const collector = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: '[]' }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); writeFileSync(join(request.targetDir, 'pyproject.toml'), python); return { exitCode: 0 }; }),
      runValidationCommand: runner, runTestCollectionCommand: collector,
      globalDir: () => join(root, 'state'),
    });
    expect(report).toMatchObject({ state: 'ready', testPopulation: { state: 'unverified', reason: expect.stringContaining('one collector cannot attest another') } });
    expect(collector).not.toHaveBeenCalled();
    expect(runner.mock.calls.map(([request]) => [request.display, request.cwd])).toEqual([['npm run test', targetDir], ['python -m pytest', targetDir]]);
    expect(report.validationBaseline?.gateCriteria.filter(criterion => criterion.role === 'test')).toHaveLength(2);
  });

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

  it('refuses when the target drops the configured test command', async () => {
    const briefPath = writeRunnerProject('mystery-test');
    const targetDir = join(root, 'target-without-tests');
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        mkdirSync(request.targetDir, { recursive: true });
        writeFileSync(join(request.targetDir, 'package.json'), JSON.stringify({
          scripts: { build: 'fixture-build' },
        }));
        copyFileSync(join(projectDir, 'package-lock.json'), join(request.targetDir, 'package-lock.json'));
        return { exitCode: 0 };
      }),
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        reason: 'The source has a configured test command, but the target does not',
      },
      blockers: [expect.objectContaining({
        phase: 'validation',
        reason: expect.stringContaining('target does not'),
      })],
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

  it.each([
    ['node --test', tap(['alpha', 'beta'])],
    ['deno test', tap(['different identity'])],
    ['mystery-check', 'opaque validation result'],
    ['node --test', 'TAP version 13\nok 1 - alpha\n1..2'],
  ])('keeps unsupported %s population unverified and executes only the target', async (testScript, output) => {
    const briefPath = writeRunnerProject(testScript);
    const targetDir = join(root, 'target-unverified');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: output }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });
    expect(report).toMatchObject({ state: 'ready', testPopulation: {
      state: 'unverified', reason: expect.stringContaining('flowcrew.testPopulation.files'),
    } });
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'test', cwd: targetDir }));
    expect(report.validationBaseline?.results).toContainEqual(expect.objectContaining({ role: 'test', state: 'passed' }));
  });

  it('keeps a failed collector unverified without executing source tests', async () => {
    writeNodeProject();
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '# Goal\nRun the configured test population.\n');
    const targetDir = join(root, 'target-collector-failure');
    const collector = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 1, stderr: 'collector unavailable' }));
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: tap(['opaque identity']) }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runTestCollectionCommand: collector, runValidationCommand: baseline, globalDir: () => join(root, 'state'),
    });
    expect(report.testPopulation).toMatchObject({ state: 'unverified', reason: expect.stringContaining('collector unavailable') });
    expect(collector).toHaveBeenCalledTimes(1);
    expect(baseline.mock.calls.map(([request]) => [request.cwd, request.role])).toEqual([
      [targetDir, 'build'], [targetDir, 'test'], [targetDir, 'lint'],
    ]);
  });

  it('still refuses target launch errors with an unverified population', async () => {
    const briefPath = writeRunnerProject('mystery-check');
    const targetDir = join(root, 'target-launch-error');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 127, stderr: 'executable not found' }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runValidationCommand: runner, globalDir: () => join(root, 'state'),
    });
    expect(report).toMatchObject({ state: 'refused', testPopulation: { state: 'unverified' } });
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: targetDir }));
  });

  it.each([
    [tap(['passes', 'fails'], new Set([2])), 'known', ['fails']],
    ['custom runner stopped', 'unknown', []],
  ])('retains the target red baseline and delta rule independently of population evidence', async (output, identity, failures) => {
    const briefPath = writeRunnerProject('custom-test-runner');
    const targetDir = join(root, 'target-red');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 1, stdout: output as string }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runValidationCommand: runner, globalDir: () => join(root, 'state'),
    });
    expect(report).toMatchObject({ state: 'ready', testPopulation: { state: 'unverified' }, validationBaseline: {
      results: expect.arrayContaining([expect.objectContaining({ role: 'test', state: 'failed', exitCode: 1,
        failureIdentity: identity, failureIdentifiers: failures })]),
      gateCriteria: expect.arrayContaining([expect.objectContaining({ role: 'test', rule: 'no_regression_from_baseline' })]),
    } });
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: targetDir }));
  });
});
