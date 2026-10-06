import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runShipSetup,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';

let root: string;
let sourceDir: string;

function writeManifest(testScript: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
    scripts: { test: testScript },
    ...extra,
  }));
  writeFileSync(join(sourceDir, 'package-lock.json'), '{}');
  const briefPath = join(sourceDir, 'brief.md');
  writeFileSync(briefPath, '# Goal\nVerify the complete configured test population.\n');
  return briefPath;
}

function setupArgs(briefPath: string, targetDir: string): string[] {
  return [
    'ship-setup', '--brief', briefPath, '--project', sourceDir,
    '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
  ];
}

function copyManifest(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(sourceDir, 'package.json'), join(targetDir, 'package.json'));
  copyFileSync(join(sourceDir, 'package-lock.json'), join(targetDir, 'package-lock.json'));
}

beforeEach(() => {
  // Canonicalize the fixture root: on macOS the temp directory is reached through a
    // symlink (/var -> /private/var), so an uncanonicalized root makes every derived
    // path differ from what the code under test computes. Reproducible on Linux by
    // pointing TMPDIR at a symlink.
    root = join(realpathSync.native(tmpdir()), `flowcrew-population-identity-qa-${randomBytes(6).toString('hex')}`);
  sourceDir = join(root, 'source');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('population identity verification', () => {
  it('does not claim population identity from a target-only TAP baseline', async () => {
    const briefPath = writeManifest('node --test');
    const targetDir = join(root, 'target');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'TAP version 13\nok 1 - stable\n1..1\n' }));
    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runValidationCommand: runner, globalDir: () => join(root, 'state'),
    });
    expect(report).toMatchObject({ state: 'ready', testPopulation: { state: 'unverified' } });
    expect(report.testPopulation?.source).toBeUndefined();
    expect(report.testPopulation?.target).toBeUndefined();
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: targetDir }));
  });

  it('keeps the exact Vitest collector strict when the target adds a test file', async () => {
    const isolatedVitest = join(root, 'node_modules', 'vitest');
    mkdirSync(isolatedVitest, { recursive: true });
    writeFileSync(join(isolatedVitest, 'package.json'), JSON.stringify({ name: 'vitest', version: '0.0.0' }));
    writeFileSync(join(isolatedVitest, 'vitest.mjs'), 'export {};\n');
    const briefPath = writeManifest('vitest run');
    const targetDir = join(root, 'target-vitest');
    const collector = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0,
      stdout: JSON.stringify((request.cwd === sourceDir
        ? ['spec/stable.test.ts']
        : ['spec/stable.test.ts', 'spec/added.test.ts']).map((file) => ({ file: join(request.cwd, file) }))),
    }));
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>(request => { copyManifest(request.targetDir); return { exitCode: 0 }; }),
      runTestCollectionCommand: collector,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        method: { tool: 'vitest' },
        source: { identities: ['spec/stable.test.ts'] },
        target: { identities: ['spec/added.test.ts', 'spec/stable.test.ts'] },
        missingFromTarget: [],
        extraInTarget: ['spec/added.test.ts'],
      },
    });
    expect(collector).toHaveBeenCalledTimes(2);
    expect(baseline).not.toHaveBeenCalled();
  });

  it('retains pytest collection identities and matched parity', async () => {
    mkdirSync(sourceDir, { recursive: true });
    const briefPath = join(sourceDir, 'brief.md');
    writeFileSync(briefPath, [
      '---',
      'validation:',
      '  commands:',
      '    test:',
      '      command: python',
      '      args: [-m, pytest]',
      '---',
      '# Goal',
      'Verify the configured population.',
    ].join('\n'));
    const targetDir = join(root, 'target-pytest');
    const collector = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: 'checks/test_population.py::test_stable\n',
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        mkdirSync(request.targetDir, { recursive: true });
        return { exitCode: 0 };
      }),
      runTestCollectionCommand: collector,
      runValidationCommand: vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 })),
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        method: { tool: 'pytest' },
        source: { identities: ['checks/test_population.py'] },
        target: { identities: ['checks/test_population.py'] },
        missingFromTarget: [],
        extraInTarget: [],
      },
    });
    expect(collector.mock.calls.map(([request]) => request.args)).toEqual([
      ['-m', 'pytest', '--collect-only', '-q'],
      ['-m', 'pytest', '--collect-only', '-q'],
    ]);
  });

  it('retains declared-file identities and matched parity without invoking a collector', async () => {
    const briefPath = writeManifest('custom-test', {
      flowcrew: { testPopulation: { files: ['checks/stable.test.ts'] } },
    });
    mkdirSync(join(sourceDir, 'checks'), { recursive: true });
    writeFileSync(join(sourceDir, 'checks', 'stable.test.ts'), 'export {};\n');
    const targetDir = join(root, 'target-declared');
    const collector = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        mkdirSync(join(request.targetDir, 'checks'), { recursive: true });
        copyFileSync(
          join(sourceDir, 'checks', 'stable.test.ts'),
          join(request.targetDir, 'checks', 'stable.test.ts'),
        );
        return { exitCode: 0 };
      }),
      runTestCollectionCommand: collector,
      runValidationCommand: vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 })),
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        method: { tool: 'declared-files' },
        source: { identities: ['checks/stable.test.ts'] },
        target: { identities: ['checks/stable.test.ts'] },
        missingFromTarget: [],
        extraInTarget: [],
      },
    });
    expect(collector).not.toHaveBeenCalled();
  });
});
