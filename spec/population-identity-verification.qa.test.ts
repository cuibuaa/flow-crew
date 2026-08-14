import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  rmSync,
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

function tap(names: readonly string[]): string {
  return [
    'TAP version 13',
    ...names.map((name, index) => `ok ${index + 1} - ${name}`),
    `1..${names.length}`,
  ].join('\n');
}

function genericWorktree(): ReturnType<typeof vi.fn<GitWorktreeCreator>> {
  return vi.fn<GitWorktreeCreator>((request) => {
    copyManifest(request.targetDir);
    return { exitCode: 0 };
  });
}

function genericRunner(
  sourceNames: readonly string[],
  targetNames: readonly string[],
): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => ({
    exitCode: 0,
    stdout: tap(request.cwd === sourceDir ? sourceNames : targetNames),
    durationMs: 1,
  }));
}

async function genericReport(
  sourceNames: readonly string[],
  targetNames: readonly string[],
  targetName: string,
) {
  const briefPath = writeManifest('node --test');
  return runShipSetup(setupArgs(briefPath, join(root, targetName)), {
    createWorktree: genericWorktree(),
    runValidationCommand: genericRunner(sourceNames, targetNames),
    globalDir: () => join(root, 'state'),
  });
}

beforeEach(() => {
  root = join(tmpdir(), `flowcrew-population-identity-qa-${randomBytes(6).toString('hex')}`);
  sourceDir = join(root, 'source');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('population identity verification', () => {
  it('keeps all source identities stable in the historical-shaped 66-to-84 insertion', async () => {
    const named = 'live microphone acceptance evidence is a real PASS for all required prompts';
    const sourceNames = Array.from({ length: 66 }, (_, index) => `source test ${index + 1}`);
    sourceNames[25] = named;
    const additionsBefore = Array.from({ length: 17 }, (_, index) => `inserted test ${index + 1}`);
    const additions = [...additionsBefore, 'inserted test 18'];
    const targetNames = [
      ...additionsBefore,
      ...sourceNames,
      additions.at(-1)!,
    ];

    const report = await genericReport(sourceNames, targetNames, 'target-insertion');

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        source: { count: 66 },
        target: { count: 84 },
        missingFromTarget: [],
        extraInTarget: additions.map((name) => `1:${name}`),
        reason: expect.stringContaining('SOURCE-PLUS-ADDITIONS'),
      },
    });
    expect(report.testPopulation?.source?.identities).toContain(`1:${named}`);
    expect(report.testPopulation?.target?.identities).toContain(`1:${named}`);
    expect(report.testPopulation?.source?.identities.every(
      (identity) => report.testPopulation?.target?.identities.includes(identity),
    )).toBe(true);
  });

  it('refuses a target missing one source test and names only that missing identity', async () => {
    const report = await genericReport(['kept', 'dropped'], ['kept'], 'target-missing');

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        missingFromTarget: ['1:dropped'],
        extraInTarget: [],
      },
      blockers: [expect.objectContaining({ reason: expect.stringContaining('missing from target: 1:dropped') })],
    });
  });

  it('refuses a rename and names both the old missing and new extra identities', async () => {
    const report = await genericReport(['kept', 'old name'], ['kept', 'new name'], 'target-rename');

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        missingFromTarget: ['1:old name'],
        extraInTarget: ['1:new name'],
      },
      blockers: [expect.objectContaining({
        reason: expect.stringMatching(/missing from target: 1:old name.*extra in target: 1:new name/),
      })],
    });
  });

  it('preserves duplicate identities when a differently named test is inserted', async () => {
    const report = await genericReport(
      ['same name', 'same name'],
      ['unrelated', 'same name', 'same name'],
      'target-duplicate-insertion',
    );

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        source: { identities: ['1:same name', '2:same name'] },
        target: { identities: ['1:unrelated', '1:same name', '2:same name'] },
        missingFromTarget: [],
        extraInTarget: ['1:unrelated'],
      },
    });
  });

  it('refuses a dropped duplicate instead of collapsing equal names', async () => {
    const report = await genericReport(
      ['same name', 'same name'],
      ['same name'],
      'target-dropped-duplicate',
    );

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        source: { identities: ['1:same name', '2:same name'] },
        target: { identities: ['1:same name'] },
        missingFromTarget: ['2:same name'],
        extraInTarget: [],
      },
    });
  });

  it('keeps the exact Vitest collector strict when the target adds a test file', async () => {
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
      createWorktree: genericWorktree(),
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
