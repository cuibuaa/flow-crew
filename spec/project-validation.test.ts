import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  discoverProjectValidation,
  evaluateValidationDelta,
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
  type ValidationFileSystem,
} from '../src/project-validation.js';

function memoryFs(files: Record<string, string>): ValidationFileSystem {
  return {
    exists: (path) => Object.hasOwn(files, path.replaceAll('\\', '/')),
    readText: (path) => {
      const value = files[path.replaceAll('\\', '/')];
      if (value === undefined) throw new Error(`missing fixture ${path}`);
      return value;
    },
  };
}

const root = resolve('portable-project');

describe('configuration-driven project validation baseline', () => {
  it('discovers and runs exactly the declared build, test, and lint scripts with lockfile-selected argv', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint src', deploy: 'must not run' },
      }),
      [`${root}/package-lock.json`]: '{}',
    });
    const runner = vi.fn(({ role }: { role: string }) => ({
      exitCode: role === 'test' ? 1 : 0,
      stdout: role === 'test' ? 'FAIL spec/existing.test.ts\nTests 1 failed' : `${role} ok`,
      durationMs: 7,
    }));

    const baseline = await runProjectValidationBaseline(root, { fs, runCommand: runner });

    expect(baseline.discovery).toMatchObject({
      state: 'configured',
      runner: 'npm',
      runnerEvidence: 'package-lock.json',
      missingRoles: [],
    });
    expect(runner.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ role: 'build', command: 'npm', args: ['run', 'build'], cwd: root }),
      expect.objectContaining({ role: 'test', command: 'npm', args: ['run', 'test'], cwd: root }),
      expect.objectContaining({ role: 'lint', command: 'npm', args: ['run', 'lint'], cwd: root }),
    ]);
    expect(baseline.results).toContainEqual(expect.objectContaining({
      role: 'test',
      state: 'failed',
      exitCode: 1,
      failureCount: 1,
      failureIdentifiers: ['spec/existing.test.ts'],
    }));
    expect(baseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'test',
      rule: 'no_regression_from_baseline',
      baselineFailureCount: 1,
      description: expect.stringContaining('may not add'),
    }));
    expect(baseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'build', rule: 'must_remain_green',
    }));
  });

  it('infers and runs Python build, test, and lint commands from pyproject.toml', async () => {
    const pyprojectPath = `${root}/pyproject.toml`;
    const fs = memoryFs({
      [pyprojectPath]: [
        '[build-system]',
        'requires = ["hatchling"]',
        'build-backend = "hatchling.build"',
        '',
        '[project]',
        'dependencies = ["pytest>=8", "ruff>=0.6"]',
        '',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]',
        '',
        '[tool.ruff]',
        'line-length = 100',
      ].join('\n'),
    });
    const runner = vi.fn(() => ({ exitCode: 0, durationMs: 3 }));

    const baseline = await runProjectValidationBaseline(root, { fs, runCommand: runner });

    expect(baseline.discovery).toMatchObject({
      state: 'configured',
      configPath: pyprojectPath,
      configPaths: [pyprojectPath],
      missingRoles: [],
    });
    expect(runner.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ role: 'build', command: 'python', args: ['-m', 'build'], evidencePath: pyprojectPath }),
      expect.objectContaining({ role: 'test', command: 'python', args: ['-m', 'pytest'], evidencePath: pyprojectPath }),
      expect.objectContaining({ role: 'lint', command: 'python', args: ['-m', 'ruff', 'check', '.'], evidencePath: pyprojectPath }),
    ]);
    expect(baseline.gateCriteria.every((criterion) => criterion.rule === 'must_remain_green')).toBe(true);
  });

  it('does not infer Python tools from comments or descriptive metadata', () => {
    const pyprojectPath = `${root}/pyproject.toml`;
    const discovery = discoverProjectValidation(root, memoryFs({
      [pyprojectPath]: [
        '[project]',
        'name = "sample"',
        'description = "pytest and ruff may be adopted later"',
        '# [tool.pytest.ini_options]',
        '# [tool.ruff]',
      ].join('\n'),
    }));

    expect(discovery).toMatchObject({ state: 'unknown', commands: [] });
  });

  it('infers named Makefile targets without executing unrelated targets', async () => {
    const makefilePath = `${root}/Makefile`;
    const fs = memoryFs({
      [makefilePath]: [
        'build: compile',
        'test:',
        'lint:',
        'deploy:',
      ].join('\n'),
    });
    const runner = vi.fn(() => ({ exitCode: 0 }));

    const baseline = await runProjectValidationBaseline(root, { fs, runCommand: runner });

    expect(baseline.discovery.state).toBe('configured');
    expect(runner.mock.calls.map(([request]) => [request.command, request.args])).toEqual([
      ['make', ['build']],
      ['make', ['test']],
      ['make', ['lint']],
    ]);
  });

  it('marks a zero-command baseline unknown and every role unresolved', async () => {
    const runner = vi.fn(() => ({ exitCode: 0 }));

    const baseline = await runProjectValidationBaseline(root, { fs: memoryFs({}), runCommand: runner });

    expect(baseline.discovery).toMatchObject({
      state: 'unknown',
      commands: [],
      missingRoles: ['build', 'test', 'lint'],
      reason: expect.stringContaining('No recognized'),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(baseline.results.every((result) => result.state === 'unresolved')).toBe(true);
    expect(baseline.gateCriteria.every((criterion) => criterion.rule === 'baseline_unresolved')).toBe(true);
  });

  it('reports missing scripts and uncertain package runners instead of inventing commands', async () => {
    const partialFs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({ scripts: { test: 'vitest run' } }),
      [`${root}/package-lock.json`]: '{}',
    });
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const partial = await runProjectValidationBaseline(root, { fs: partialFs, runCommand: runner });

    expect(partial.discovery).toMatchObject({ state: 'partial', missingRoles: ['build', 'lint'] });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(partial.results).toContainEqual(expect.objectContaining({
      role: 'build', state: 'not_configured', reason: expect.stringContaining('No build command was inferred'),
    }));

    const ambiguousFs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({ scripts: { build: 'build' } }),
      [`${root}/package-lock.json`]: '{}',
      [`${root}/yarn.lock`]: '',
    });
    expect(discoverProjectValidation(root, ambiguousFs)).toMatchObject({
      state: 'unknown',
      commands: [],
      reason: expect.stringContaining('disagree'),
    });
  });

  it('evaluates green and known-red baselines as deltas in both directions', () => {
    const result = (
      role: 'build' | 'test' | 'lint',
      state: ValidationCommandResult['state'],
      identifiers: string[] = [],
      count?: number,
    ): ValidationCommandResult => ({
      role,
      state,
      exitCode: state === 'passed' ? 0 : state === 'failed' ? 1 : undefined,
      durationMs: 1,
      output: '',
      failureIdentifiers: identifiers,
      failureIdentity: state === 'failed' ? 'known' : 'none',
      ...(count === undefined ? {} : { failureCount: count }),
    });
    const baseline = {
      version: 1,
      projectDir: root,
      discovery: { state: 'configured', configPath: `${root}/package.json`, commands: [], missingRoles: [] },
      results: [
        result('build', 'passed'),
        result('test', 'failed', ['spec/existing.test.ts'], 1),
        result('lint', 'passed'),
      ],
      gateCriteria: [],
    } satisfies ProjectValidationBaseline;

    const improved = evaluateValidationDelta(baseline, [
      result('build', 'passed'), result('test', 'passed'), result('lint', 'passed'),
    ]);
    expect(improved.every((entry) => entry.state === 'pass')).toBe(true);

    const unchangedRed = evaluateValidationDelta(baseline, [
      result('build', 'passed'),
      result('test', 'failed', ['spec/existing.test.ts'], 1),
      result('lint', 'passed'),
    ]);
    expect(unchangedRed.find((entry) => entry.role === 'test')).toMatchObject({
      state: 'pass', newFailureIdentifiers: [],
    });

    const regressed = evaluateValidationDelta(baseline, [
      result('build', 'failed', ['src/new.ts'], 1),
      result('test', 'failed', ['spec/existing.test.ts', 'spec/new.test.ts'], 2),
      result('lint', 'passed'),
    ]);
    expect(regressed).toContainEqual(expect.objectContaining({
      role: 'build', state: 'regression', reason: expect.stringContaining('green'),
    }));
    expect(regressed).toContainEqual(expect.objectContaining({
      role: 'test', state: 'regression', newFailureIdentifiers: ['spec/new.test.ts'],
    }));
  });

  it('keeps an unparseable red baseline unresolved rather than treating it as zero failures', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({ scripts: { test: 'opaque-check' } }),
      [`${root}/package-lock.json`]: '{}',
    });
    const baseline = await runProjectValidationBaseline(root, {
      fs,
      runCommand: () => ({ exitCode: 9, stderr: 'opaque failure; 0 errors were classified' }),
    });
    const test = baseline.results.find((entry) => entry.role === 'test');
    expect(test).toMatchObject({ state: 'failed', failureIdentity: 'unknown' });
    expect(test?.failureCount).toBeUndefined();
    expect(baseline.gateCriteria.find((entry) => entry.role === 'test')).toMatchObject({
      rule: 'no_regression_from_baseline',
      description: expect.stringContaining('unresolved'),
    });
  });
});
