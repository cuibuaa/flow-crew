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

function tap(names: string[], failing = new Set<number>()): string {
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
    ['Node built-in runner', 'node --test'],
    ['a differently named runner', 'deno test'],
  ])('derives matched population from generic TAP for %s', async (_label, testScript) => {
    const briefPath = writeRunnerProject(testScript);
    const targetDir = join(root, `target-${testScript.split(' ')[0]}`);
    const runner = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: tap(['alpha', 'beta']),
      durationMs: 7,
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        runner: {
          source: { display: testScript, command: 'npm run test' },
          target: { display: testScript, command: 'npm run test' },
        },
        method: { source: 'baseline_output', format: 'tap' },
        source: { count: 2, identities: ['1:alpha', '2:beta'] },
        target: { count: 2, identities: ['1:alpha', '2:beta'] },
        missingFromTarget: [],
        extraInTarget: [],
        reason: expect.stringContaining('Exact collection was unavailable'),
      },
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map(([request]) => request.cwd)).toEqual([projectDir, targetDir]);
  });

  it.each([
    ['omits its name', 'ok 1'],
    ['contains only a directive', 'ok 1 - # SKIP unavailable'],
  ])('records complete TAP whose top-level record %s as unverified instead of count-matched', async (_label, record) => {
    const briefPath = writeRunnerProject('anonymous-tap');
    const targetDir = join(root, 'target-anonymous-tap');
    const runner = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: `TAP version 13\n${record}\n1..1`,
      durationMs: 7,
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        runner: { source: { display: 'anonymous-tap' } },
        reason: expect.stringContaining('has no test name'),
      },
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('falls back to generic TAP when an available exact collector cannot run', async () => {
    writeNodeProject();
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '# Goal\nRun the configured test population.\n');
    const targetDir = join(root, 'target-collector-fallback');
    const collector = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 1,
      stderr: 'collector executable unavailable',
      durationMs: 2,
    }));
    const baseline = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: tap(['fallback identity']),
      durationMs: 7,
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runTestCollectionCommand: collector,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        method: { source: 'baseline_output', format: 'tap' },
        reason: expect.stringContaining('Cannot collect exact source/target test populations'),
      },
    });
    expect(collector).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledTimes(4);
  });

  it('records opaque output as ready but unverified, naming the runner and reason in JSON and human output', async () => {
    const testScript = 'mystery-check --all';
    const briefPath = writeRunnerProject(testScript);
    const targetDir = join(root, 'target-unverified');
    const stdout = new Capture();
    const stderr = new Capture();
    const runner = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: 'validation completed; population format unavailable',
      durationMs: 11,
    }));

    const code = await cmdShipSetupWithDeps(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(stdout.value).toContain('Ship setup: READY');
    expect(stdout.value).toContain('Test population: UNVERIFIED');
    expect(stdout.value).toContain(`runner: ${testScript} (invoked as npm run test)`);
    expect(stdout.value).toContain('version line missing');
    const records = readdirSync(join(root, 'state', 'ship-setups'));
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(root, 'state', 'ship-setups', records[0]), 'utf-8'));
    expect(record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        runner: {
          source: { display: testScript, command: 'npm run test' },
          target: { display: testScript, command: 'npm run test' },
        },
        reason: expect.stringContaining(`runner "${testScript}" is unverified`),
      },
    });
  });

  it('still refuses when every target validation role exits 127 during output fallback', async () => {
    const briefPath = writeRunnerProject('mystery-test');
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      scripts: { build: 'mystery-build', test: 'mystery-test', lint: 'mystery-lint' },
    }));
    const targetDir = join(root, 'target-launch-error');
    const stdout = new Capture();
    const stderr = new Capture();
    const runner = vi.fn<ValidationCommandRunner>((request) => request.cwd === projectDir
      ? { exitCode: 0, stdout: 'source runner output is opaque', durationMs: 3 }
      : { exitCode: 127, stderr: `${request.role} executable not found`, durationMs: 3 });

    const code = await cmdShipSetupWithDeps(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    expect(stderr.value.split('\n')[0]).toBe('Ship setup: REFUSED');
    expect(stderr.value).toContain('Test population: UNVERIFIED');
    expect(stderr.value).toContain('runner: mystery-test (invoked as npm run test)');
    expect(stderr.value.match(/exit 127/g)).toHaveLength(3);
    expect(runner.mock.calls.map(([request]) => [request.cwd, request.role])).toEqual([
      [projectDir, 'test'],
      [targetDir, 'build'],
      [targetDir, 'test'],
      [targetDir, 'lint'],
    ]);
    expect(existsSync(join(root, 'state', 'ship-setups'))).toBe(false);
  });

  it('keeps a failed TAP target as the governing red baseline with its no-regression gate', async () => {
    const briefPath = writeRunnerProject('node --test');
    const targetDir = join(root, 'target-red');
    const output = tap(['passes', 'fails'], new Set([2]));
    const runner = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 1,
      stdout: output,
      durationMs: 13,
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: { state: 'matched', source: { count: 2 }, target: { count: 2 } },
      validationBaseline: {
        results: expect.arrayContaining([
          expect.objectContaining({ role: 'test', state: 'failed', exitCode: 1 }),
        ]),
        gateCriteria: expect.arrayContaining([
          expect.objectContaining({ role: 'test', rule: 'no_regression_from_baseline' }),
        ]),
      },
    });
  });

  it.each([
    ['truncated', '[... 512 earlier bytes omitted ...]\nTAP version 13\nok 2 - beta\n1..2'],
    ['incomplete', 'TAP version 13\nok 1 - alpha\n1..2'],
    ['ambiguous', 'TAP version 13\nok 1 - alpha\n1..1\n1..1'],
  ])('degrades %s TAP output to a recorded unverified state', async (_label, output) => {
    const briefPath = writeRunnerProject('node --test');
    const targetDir = join(root, `target-${_label}`);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: output, durationMs: 5 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        runner: { source: { display: 'node --test' } },
        reason: expect.stringMatching(/truncated|records do not match|multiple top-level plans/),
      },
    });
  });

  it('refuses a TAP identity mismatch after capturing the unchanged target baseline', async () => {
    const briefPath = writeRunnerProject('node --test');
    const targetDir = join(root, 'target-mismatch');
    const runner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0,
      stdout: request.cwd === projectDir ? tap(['source identity']) : tap(['target identity']),
      durationMs: 17,
    }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree: vi.fn<GitWorktreeCreator>((request) => {
        copyManifest(request.targetDir);
        return { exitCode: 0 };
      }),
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        missingFromTarget: ['1:source identity'],
        extraInTarget: ['1:target identity'],
      },
      validationBaseline: {
        results: expect.arrayContaining([expect.objectContaining({ role: 'test', state: 'passed' })]),
      },
      blockers: [expect.objectContaining({
        phase: 'validation',
        reason: expect.stringContaining('mismatch from baseline output'),
      })],
    });
    expect(existsSync(join(root, 'state', 'ship-setups'))).toBe(false);
  });

  it('records identical target baseline results and gate criteria for TAP-matched and unverified populations', async () => {
    const briefPath = writeRunnerProject('node --test');
    const targetOutput = tap(['stable target']);
    let sourceOutput = targetOutput;
    const runner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 1,
      stdout: request.cwd === projectDir ? sourceOutput : targetOutput,
      durationMs: 19,
    }));
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      copyManifest(request.targetDir);
      return { exitCode: 0 };
    });

    const matched = await runShipSetup(setupArgs(briefPath, join(root, 'target-matched-baseline')), {
      createWorktree,
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });
    sourceOutput = 'opaque source result';
    const unverified = await runShipSetup(setupArgs(briefPath, join(root, 'target-unverified-baseline')), {
      createWorktree,
      runValidationCommand: runner,
      globalDir: () => join(root, 'state'),
    });

    expect(matched.state).toBe('ready');
    expect(unverified.state).toBe('ready');
    if (matched.state !== 'ready' || unverified.state !== 'ready') throw new Error('fixture setup refused');
    expect(matched.testPopulation?.state).toBe('matched');
    expect(unverified.testPopulation?.state).toBe('unverified');
    expect(unverified.validationBaseline.results).toEqual(matched.validationBaseline.results);
    expect(unverified.validationBaseline.gateCriteria).toEqual(matched.validationBaseline.gateCriteria);
  });
});
