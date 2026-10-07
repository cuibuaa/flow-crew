import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  discoverProjectValidation,
  evaluateValidationDelta,
  runProjectValidationBaseline,
  runValidationCommand,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
  type ValidationFileSystem,
} from '../src/project-validation.js';
import { validationEnvironment } from '../src/validation-environment.js';
import { withEngineCommandBoundary } from '../src/write-boundary.js';

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

describe('project command environment and observer authority', () => {
  it('keeps project inputs and explicit home reads while isolating control and credential settings', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'validation-env-'));
    try {
      const inherited = { PATH: '/project/bin', PROJECT_INPUT: 'ordinary', HOME: '/ambient',
        CODEX_HOME: '/ambient/codex', FLOWCREW_LAUNCH_RESULT_PATH: '/ambient/result',
        FC_SESSION_REUSE: '1', OPENAI_API_KEY: 'fake', NODE_OPTIONS: '--no-warnings',
        DBUS_SESSION_BUS_ADDRESS: 'fake-bus', XDG_RUNTIME_DIR: '/ambient/runtime' };
      const ambient = validationEnvironment(scratch, inherited);
      expect(ambient.env.PROJECT_INPUT).toBe('ordinary');
      expect(ambient.env.PATH).toBe('/project/bin');
      expect(ambient.env.HOME).toBe(join(scratch, 'home'));
      expect(ambient.env.CODEX_HOME).toBe(join(scratch, 'codex'));
      expect(ambient.env.FC_HOME).toBe(join(scratch, 'home', '.fc'));
      expect(ambient.env.FLOWCREW_DAEMON_SOCKET).toBe(join(scratch, 'unavailable.sock'));
      expect(ambient.removed).toEqual(['CODEX_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'FC_SESSION_REUSE',
        'FLOWCREW_LAUNCH_RESULT_PATH', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'XDG_RUNTIME_DIR']);
      for (const name of ['FLOWCREW_LAUNCH_RESULT_PATH', 'FC_SESSION_REUSE', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'DBUS_SESSION_BUS_ADDRESS']) {
        expect(ambient.env[name]).toBeUndefined();
      }
      const explicit = validationEnvironment(scratch, inherited, { HOME: '/read-home',
        XDG_CONFIG_HOME: '/read-config', PROJECT_INPUT: 'explicit', PROJECT_API_KEY: 'fake' });
      expect(explicit.env.HOME).toBe('/read-home');
      expect(explicit.env.XDG_CONFIG_HOME).toBe('/read-config');
      expect(explicit.env.PROJECT_INPUT).toBe('explicit');
      expect(explicit.removed).toEqual(['PROJECT_API_KEY']);
      if (process.platform !== 'win32') {
        expect(() => validationEnvironment(join(scratch, 'x'.repeat(108)), {}))
          .toThrow('use a shorter temporary directory (TMPDIR)');
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('narrows nested observers and restores project authority after observation', async () => {
    const project = mkdtempSync(join(tmpdir(), 'validation-observer-'));
    const output = join(project, 'output');
    const request = { role: 'test' as const, command: process.execPath,
      args: ['-e', "try{require('fs').writeFileSync('output','ok');console.log('ALLOWED')}catch(e){console.log(e.code)}"],
      display: 'observer write control', cwd: project };
    try {
      await withEngineCommandBoundary({ projectDir: project, stageId: '_project', authority: 'project-command' }, async () => {
        const observed = await withEngineCommandBoundary({ projectDir: project, stageId: '_observer', authority: 'observer' },
          () => Promise.resolve(runValidationCommand(request)));
        expect(observed.exitCode, observed.error).toBe(0);
        expect(observed.stdout?.trim()).toBe('EACCES');
        expect(existsSync(output)).toBe(false);
        const ordinary = await runValidationCommand(request);
        expect(ordinary.exitCode, ordinary.error).toBe(0);
        expect(ordinary.stdout?.trim()).toBe('ALLOWED');
        expect(existsSync(output)).toBe(true);
      });
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});

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
    expect(baseline.discovery.commands.every((command) => command.provenance === undefined)).toBe(true);
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
        'testpaths = ["checks"]',
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

  it('uses a brief declaration as an argv-literal fallback when project discovery is unknown', async () => {
    const evidencePath = `${root}/task.md#validation.commands.test`;
    const runner = vi.fn(() => ({ exitCode: 0, stdout: '151 passed', durationMs: 5 }));

    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({}),
      runCommand: runner,
      declaredCommands: [{
        role: 'test',
        command: '/opt/project-venv/bin/python',
        args: ['-m', 'pytest', '--label', 'literal; $(must-not-run)'],
        evidencePath,
      }],
    });

    expect(baseline.discovery).toMatchObject({
      state: 'partial',
      missingRoles: ['build', 'lint'],
      commands: [{
        role: 'test',
        command: '/opt/project-venv/bin/python',
        args: ['-m', 'pytest', '--label', 'literal; $(must-not-run)'],
        evidencePath,
        provenance: { source: 'brief', evidencePath },
      }],
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      role: 'test',
      command: '/opt/project-venv/bin/python',
      args: ['-m', 'pytest', '--label', 'literal; $(must-not-run)'],
      cwd: root,
    }));
    expect(baseline.results).toEqual([
      expect.objectContaining({ role: 'build', state: 'not_configured' }),
      expect.objectContaining({ role: 'test', state: 'passed' }),
      expect.objectContaining({ role: 'lint', state: 'not_configured' }),
    ]);
    expect(baseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'test', rule: 'must_remain_green', baselineFailureIdentifiers: [],
    }));
  });

  it('merges missing roles from the brief while project configuration governs declared roles', async () => {
    const packagePath = `${root}/package.json`;
    const briefPath = `${root}/task.md`;
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({
        [packagePath]: JSON.stringify({ scripts: { test: 'vitest run' } }),
        [`${root}/package-lock.json`]: '{}',
      }),
      runCommand: runner,
      declaredCommands: [
        { role: 'build', command: 'custom-build', args: ['--frozen'], evidencePath: `${briefPath}#validation.commands.build` },
        { role: 'lint', command: 'custom-lint', args: ['--strict'], evidencePath: `${briefPath}#validation.commands.lint` },
      ],
    });

    expect(baseline.discovery).toMatchObject({ state: 'configured', missingRoles: [] });
    expect(baseline.discovery.commands.map((command) => [
      command.role,
      command.command,
      command.args,
      command.provenance?.source,
    ])).toEqual([
      ['build', 'custom-build', ['--frozen'], 'brief'],
      ['test', 'npm', ['run', 'test'], undefined],
      ['lint', 'custom-lint', ['--strict'], 'brief'],
    ]);
  });

  it('accepts exact overlap as corroboration and executes the project command once', async () => {
    const packagePath = `${root}/package.json`;
    const evidencePath = `${root}/task.md#validation.commands.test`;
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({
        [packagePath]: JSON.stringify({ scripts: { test: 'vitest run' } }),
        [`${root}/package-lock.json`]: '{}',
      }),
      runCommand: runner,
      declaredCommands: [{ role: 'test', command: 'npm', args: ['run', 'test'], evidencePath }],
    });

    expect(runner).toHaveBeenCalledOnce();
    expect(baseline.discovery.commands).toEqual([
      expect.objectContaining({
        role: 'test',
        command: 'npm',
        args: ['run', 'test'],
        evidencePath: packagePath,
        provenance: {
          source: 'project',
          evidencePath: packagePath,
          corroboratedBy: [evidencePath],
        },
      }),
    ]);
  });

  it('refuses conflicting project and brief declarations without executing either command', async () => {
    const packagePath = `${root}/package.json`;
    const evidencePath = `${root}/task.md#validation.commands.test`;
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({
        [packagePath]: JSON.stringify({ scripts: { test: 'vitest run' } }),
        [`${root}/package-lock.json`]: '{}',
      }),
      runCommand: runner,
      declaredCommands: [{
        role: 'test', command: '/opt/project-venv/bin/python', args: ['-m', 'pytest'], evidencePath,
      }],
    });

    expect(runner).not.toHaveBeenCalled();
    expect(baseline.discovery).toMatchObject({
      state: 'unknown',
      commands: [],
      missingRoles: ['build', 'test', 'lint'],
      reason: expect.stringContaining(packagePath),
    });
    expect(baseline.discovery.reason).toContain(evidencePath);
    expect(baseline.discovery.reason).toContain('["npm","run","test"]');
    expect(baseline.discovery.reason).toContain('["/opt/project-venv/bin/python","-m","pytest"]');
    expect(baseline.results.every((result) => result.state === 'unresolved')).toBe(true);
  });

  it('does not let a brief replace a package script whose package runner is ambiguous', async () => {
    const packagePath = `${root}/package.json`;
    const evidencePath = `${root}/task.md#validation.commands.build`;
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({
        [packagePath]: JSON.stringify({ scripts: { build: 'compile' } }),
        [`${root}/package-lock.json`]: '{}',
        [`${root}/yarn.lock`]: '',
      }),
      runCommand: runner,
      declaredCommands: [{ role: 'build', command: 'operator-build', args: [], evidencePath }],
    });

    expect(runner).not.toHaveBeenCalled();
    expect(baseline.discovery).toMatchObject({
      state: 'unknown',
      commands: [],
      missingRoles: ['build', 'test', 'lint'],
    });
    expect(baseline.discovery.reason).toContain('Package-manager lockfiles disagree');
    expect(baseline.discovery.reason).toContain(packagePath);
    expect(baseline.discovery.reason).toContain(evidencePath);
    expect(baseline.discovery.reason).toContain('cannot replace');
    expect(baseline.results.every((result) => result.state === 'unresolved')).toBe(true);
  });

  it('keeps launch errors and exit 127 from brief commands unresolved with their provenance', async () => {
    const briefPath = `${root}/task.md`;
    const baseline = await runProjectValidationBaseline(root, {
      fs: memoryFs({}),
      runCommand: ({ role }) => role === 'build'
        ? { exitCode: null, error: 'spawn ENOENT' }
        : { exitCode: 127, stderr: 'dependency not found' },
      declaredCommands: [
        { role: 'build', command: 'missing-build', args: [], evidencePath: `${briefPath}#validation.commands.build` },
        { role: 'test', command: 'missing-test', args: [], evidencePath: `${briefPath}#validation.commands.test` },
      ],
    });

    expect(baseline.results).toEqual([
      expect.objectContaining({ role: 'build', state: 'launch_error', reason: 'spawn ENOENT' }),
      expect.objectContaining({ role: 'test', state: 'launch_error', exitCode: 127, reason: expect.stringContaining('could not run') }),
      expect.objectContaining({ role: 'lint', state: 'not_configured' }),
    ]);
    expect(baseline.discovery.commands.map((command) => command.provenance?.source)).toEqual(['brief', 'brief']);
    expect(baseline.gateCriteria.filter((criterion) => criterion.role !== 'lint')
      .every((criterion) => criterion.rule === 'baseline_unresolved')).toBe(true);
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

  it('treats a role unconfigured in both baseline and current as a pass, not unresolved', () => {
    const unconfigured = (role: 'build' | 'lint'): ValidationCommandResult => ({
      role, state: 'not_configured', durationMs: 0, output: '',
      failureIdentifiers: [], failureIdentity: 'none',
    });
    const red: ValidationCommandResult = {
      role: 'test', state: 'failed', exitCode: 2, durationMs: 1, output: '',
      failureIdentifiers: ['tests/old.py::t'], failureIdentity: 'known', failureCount: 1,
    };
    const baseline = {
      version: 1,
      projectDir: root,
      discovery: { state: 'configured', configPath: `${root}/Makefile`, commands: [], missingRoles: ['build', 'lint'] },
      results: [unconfigured('build'), red, unconfigured('lint')],
      gateCriteria: [],
    } satisfies ProjectValidationBaseline;

    const unchanged = evaluateValidationDelta(baseline, [unconfigured('build'), red, unconfigured('lint')]);
    expect(unchanged.map((entry) => entry.state)).toEqual(['pass', 'pass', 'pass']);

    const launchError = evaluateValidationDelta(baseline, [{ ...unconfigured('build'), state: 'launch_error' }, red, unconfigured('lint')]);
    expect(launchError.find((entry) => entry.role === 'build')?.state).toBe('unresolved');
  });

  it('passes each validation role absent on both sides and keeps a configured command launch error unresolved', async () => {
    const roles = ['build', 'test', 'lint'] as const;
    const absent = (role: typeof roles[number]): ValidationCommandResult => ({
      role, state: 'not_configured', durationMs: 0, output: '',
      failureIdentifiers: [], failureIdentity: 'none',
    });
    const baseline = {
      version: 1,
      projectDir: root,
      discovery: { state: 'partial', configPath: 'fixture', commands: [], missingRoles: [...roles] },
      results: roles.map(absent),
      gateCriteria: [],
    } satisfies ProjectValidationBaseline;
    expect(evaluateValidationDelta(baseline, roles.map(absent)).map((entry) => entry.state))
      .toEqual(['pass', 'pass', 'pass']);
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-validation-control-'));
    try {
      writeFileSync(join(projectDir, 'package-lock.json'), '{}');
      for (const role of roles) {
        const configure = (script: string) => writeFileSync(
          join(projectDir, 'package.json'),
          JSON.stringify({ scripts: { [role]: script } }),
        );
        configure(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`);
        const configuredBaseline = await runProjectValidationBaseline(projectDir);
        configure(JSON.stringify(join(projectDir, `missing-${role}`)));
        const current = await runProjectValidationBaseline(projectDir);
        expect(configuredBaseline.discovery.commands).toEqual([
          expect.objectContaining({ role, command: 'npm', args: ['run', role] }),
        ]);
        expect(current.discovery.commands).toEqual([
          expect.objectContaining({ role, command: 'npm', args: ['run', role] }),
        ]);
        expect(configuredBaseline.results.find((result) => result.role === role))
          .toMatchObject({ state: 'passed', exitCode: 0 });
        expect(current.results.find((result) => result.role === role))
          .toMatchObject({ state: 'launch_error', exitCode: 127 });
        expect(evaluateValidationDelta(configuredBaseline, current.results).map((entry) => entry.state))
          .toEqual(roles.map((candidate) => candidate === role ? 'unresolved' : 'pass'));
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
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
    expect(test).toMatchObject({
      state: 'failed',
      failureIdentity: 'unknown',
      reason: expect.stringContaining('non-TAP output format is not recognized'),
    });
    if (!test?.reason) throw new Error('unknown failure cause was not recorded');
    expect(test?.failureCount).toBeUndefined();
    expect(baseline.gateCriteria.find((entry) => entry.role === 'test')).toMatchObject({
      rule: 'no_regression_from_baseline',
      description: expect.stringContaining(test.reason),
    });
  });

  it('uses the terminal pytest summary instead of an incidental earlier failure-like count', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({ scripts: { test: 'pytest' } }),
      [`${root}/package-lock.json`]: '{}',
    });
    const baseline = await runProjectValidationBaseline(root, {
      fs,
      runCommand: () => ({
        exitCode: 1,
        stdout: [
          '1 Failed download while arranging a fixture',
          'FAILED checks/test_alpha.py::test_alpha - AssertionError',
          'FAILED checks/test_beta.py::test_beta - AssertionError',
          '================ 2 failed, 3 passed in 1.25s ================',
        ].join('\n'),
      }),
    });

    expect(baseline.results.find((result) => result.role === 'test')).toMatchObject({
      state: 'failed',
      failureCount: 2,
      failureIdentity: 'known',
    });
    expect(baseline.gateCriteria.find((criterion) => criterion.role === 'test')).toMatchObject({
      rule: 'no_regression_from_baseline',
      baselineFailureCount: 2,
    });
  });

  it('treats exit 127 as a command that could not run, not as a usable red baseline', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({
        scripts: { build: 'compile', test: 'check', lint: 'style' },
      }),
      [`${root}/package-lock.json`]: '{}',
    });

    const baseline = await runProjectValidationBaseline(root, {
      fs,
      runCommand: ({ role }) => ({
        exitCode: 127,
        stderr: `sh: ${role}-tool: command not found`,
      }),
    });

    expect(baseline.results).toEqual([
      expect.objectContaining({ role: 'build', state: 'launch_error', exitCode: 127 }),
      expect.objectContaining({ role: 'test', state: 'launch_error', exitCode: 127 }),
      expect.objectContaining({ role: 'lint', state: 'launch_error', exitCode: 127 }),
    ]);
    expect(baseline.results.every((result) => result.reason?.includes('could not run'))).toBe(true);
    expect(baseline.gateCriteria.every((criterion) => criterion.rule === 'baseline_unresolved')).toBe(true);
  });
});
