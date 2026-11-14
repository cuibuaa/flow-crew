import { validationReport } from './test-support/structured-validation.js';
import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  discoverProjectValidation,
  reconcileProjectValidation,
  parseValidationCommands,
  evaluateValidationDelta,
  runProjectValidationBaseline,
  runValidationCommand,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
  type ValidationFileSystem,
} from '../src/project-validation.js';
import { validationEnvironment } from '../src/validation-environment.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { createRun } from './test-support/create-run.js';
import { writeStageStatus } from '../src/store.js';
import { recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';

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
  it('ends configured validation inside the enclosing attempt budget', async () => {
    const project = mkdtempSync(join(tmpdir(), 'validation-deadline-'));
    // Keep the requested budget deterministic while the real timeout runs.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const result = await runValidationCommand({ role: 'test', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], display: 'deadline probe', cwd: project, timeoutMs: 30 });
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toMatch(/Validation command timed out after [\d.]+ms/);
      const budget = Number(result.error!.match(/after ([\d.]+)ms/)![1]);
      expect(budget).toBeGreaterThan(0); expect(budget).toBeLessThanOrEqual(30);
    } finally { clock.mockRestore(); rmSync(project, { recursive: true, force: true }); }
  });
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
      expect(ambient.env.FLOWCREW_DAEMON_SOCKET).toBeUndefined();
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
        const longRoot = join(scratch, 'x'.repeat(108));
        expect(validationEnvironment(longRoot, {}).env.FLOWCREW_DAEMON_SOCKET)
          .toBeUndefined();
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('keeps validation storage private beneath a long scratch alias', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'validation-path-'));
    try {
      const limit = process.platform === 'linux' ? 107 : 103;
      const target = join(scratch, 'x'.repeat(limit - Buffer.byteLength(realpathSync(scratch)) - 5));
      mkdirSync(target);
      const alias = join(scratch, 'alias');
      symlinkSync(target, alias, 'dir');
      const environment = validationEnvironment(alias, {
        FC_HOME: '/ambient-store', FLOWCREW_DAEMON_SOCKET: '/ambient.sock',
        CODEX_HOME: '/ambient-agent', OPENAI_API_KEY: 'fake',
        TMPDIR: alias, TMP: alias, TEMP: alias,
      });
      expect(environment.env.FC_HOME).toBe(join(alias, 'home', '.fc'));
      expect(existsSync(environment.env.FC_HOME!)).toBe(false);
      expect(environment.env.FLOWCREW_DAEMON_SOCKET).toBeUndefined();
      expect(environment.env.OPENAI_API_KEY).toBeUndefined();
      for (const name of ['TMPDIR', 'TMP', 'TEMP']) expect(environment.env[name]).toBe(realpathSync(target));
      expect(environment.removed).toEqual(['CODEX_HOME', 'FC_HOME', 'FLOWCREW_DAEMON_SOCKET', 'OPENAI_API_KEY']);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('uses ordinary filesystem access for nested observer and project commands', async () => {
    const project = mkdtempSync(join(tmpdir(), 'validation-observer-'));
    const output = join(project, 'output');
    const request = { role: 'test' as const, command: process.execPath,
      args: ['-e', "try{require('fs').writeFileSync('output','ok');console.log('ALLOWED')}catch(e){console.log(e.code)}"],
      display: 'observer write control', cwd: project };
    try {
      await withEngineIntegrity({ projectDir: project, stageId: '_project' }, async () => {
        const observed = await withEngineIntegrity({ projectDir: project, stageId: '_observer' },
          () => Promise.resolve(runValidationCommand(request)));
        expect(observed.exitCode, observed.error).toBe(0);
        expect(observed.stdout?.trim()).toBe('ALLOWED');
        expect(existsSync(output)).toBe(true);
        const ordinary = await runValidationCommand(request);
        expect(ordinary.exitCode, ordinary.error).toBe(0);
        expect(ordinary.stdout?.trim()).toBe('ALLOWED');
        expect(existsSync(output)).toBe(true);
      });
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});

describe('configuration-driven project validation baseline', () => {
  it('runs only literal declared argv; script names, locks, Make and Python files never select commands', async () => {
    const files = memoryFs({ [`${root}/package.json`]: JSON.stringify({ packageManager: 'npm@10', scripts: { test: 'all' } }),
      [`${root}/package-lock.json`]: '{}', [`${root}/Makefile`]: 'test:\n\tfalse',
      [`${root}/pyproject.toml`]: '[build-system]\n[tool.pytest.ini_options]', [`${root}/tox.ini`]: '[testenv]\ncommands=pytest' });
    expect(discoverProjectValidation(root, files)).toMatchObject({ state: 'unknown', commands: [] });
    const runner = vi.fn(() => ({ exitCode: 0 }));
    expect((await runProjectValidationBaseline(root, { fs: files, runCommand: runner })).results).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    const declaredCommands = [{ role: 'test' as const, command: 'project-check', args: ['literal; no shell', '--focused'], evidencePath: 'brief#test' }];
    const selected = await runProjectValidationBaseline(root, { fs: files, declaredCommands, runCommand: runner });
    expect(selected.results).toEqual([expect.objectContaining({ role: 'test', state: 'passed', exitCode: 0 })]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toMatchObject({ command: 'project-check', args: declaredCommands[0].args, cwd: root });
  });

  it('uses project declarations, merges brief gaps, corroborates exact overlap and refuses conflicting declarations', async () => {
    const declaration = { commands: { test: { command: 'check', args: ['unit'], report: { format: 'vitest-json' } } } };
    const fs = memoryFs({ [`${root}/config/validation.json`]: JSON.stringify(declaration) });
    const declared = parseValidationCommands(declaration, 'brief').commands;
    expect(reconcileProjectValidation(root, declared, fs).commands).toEqual([expect.objectContaining({
      command: 'check', args: ['unit'], provenance: { source: 'project', evidencePath: `${root}/config/validation.json#validation.commands.test`, corroboratedBy: ['brief#validation.commands.test'] },
    })]);
    const merged = reconcileProjectValidation(root, [{ role: 'lint', command: 'focused-lint', args: [], evidencePath: 'brief#lint' }], fs);
    expect(merged.commands.map(command => command.command)).toEqual(['check', 'focused-lint']);
    for (const conflict of [{ ...declared[0], args: ['different'] }, { ...declared[0], report: { format: 'vitest-json' as const, path: 'other.json' } }]) {
      expect(reconcileProjectValidation(root, [conflict], fs)).toMatchObject({ state: 'unknown', commands: [], reason: expect.stringContaining('conflict') });
    }
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const skipped = await runProjectValidationBaseline(root, { fs, skipExecution: true, runCommand: runner });
    expect(skipped.execution).toBe('skipped'); expect(skipped.results[0].state).toBe('unverified'); expect(runner).not.toHaveBeenCalled();
  });

  it('refuses conflicting declared environments instead of executing a bare command', () => {
    const fs = memoryFs({ [join(root, 'config/validation.json')]: JSON.stringify({ commands: { test: { command: 'check', args: [], env: { PROJECT_STATE: '/workspace/private' } } } }) });
    const result = reconcileProjectValidation(root, [{ role: 'test', command: 'check', args: [], evidencePath: 'brief#test' }], fs);
    expect(result).toMatchObject({ state: 'unknown', commands: [], reason: expect.stringContaining('environment conflict') });
  });

  it.each([null, {}, { commands: { deploy: { command: 'deploy', args: [] } } }, { commands: { test: { command: 'check', args: 'not argv' } } }])('refuses invalid project declarations without a discovery fallback (%j)', async declaration => {
    const fs = memoryFs({ [`${root}/config/validation.json`]: JSON.stringify(declaration) });
    await expect(runProjectValidationBaseline(root, { fs })).rejects.toThrow('Invalid');
  });

  it('records exit 127 and absent exits without an environment diagnosis', async () => {
    for (const response of [{ exitCode: 127 }, { exitCode: null, error: 'not available' }]) {
      const measured = await runProjectValidationBaseline(root, { fs: memoryFs({}),
        declaredCommands: [{ role: 'test', command: 'missing', args: [], evidencePath: 'brief#test' }], runCommand: () => response });
      expect(measured.results[0]).toMatchObject({ state: response.exitCode === null ? 'unverified' : 'failed', failureIdentity: 'unknown' });
      expect(measured.discovery.commands[0].provenance).toEqual({ source: 'brief', evidencePath: 'brief#test' });
      expect(evaluateValidationDelta(measured, measured.results)[0].state).toBe('unverified');
    }
  });

  it('states unconfigured roles as unmeasured, never a passing command', () => {
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
    } satisfies ProjectValidationBaseline;

    const unchanged = evaluateValidationDelta(baseline, [unconfigured('build'), red, unconfigured('lint')]);
    expect(unchanged.map((entry) => entry.state)).toEqual(['unverified', 'unverified', 'unverified']);

    const launchError = evaluateValidationDelta(baseline, [{ ...unconfigured('build'), state: 'launch_error' }, red, unconfigured('lint')]);
    expect(launchError.find((entry) => entry.role === 'build')?.state).toBe('unverified');
  });

  it('states absent roles and launch gaps as unverified and refuses stale receipt bindings', async () => {
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
    } satisfies ProjectValidationBaseline;
    expect(evaluateValidationDelta(baseline, roles.map(absent)).map((entry) => entry.state))
      .toEqual(['unverified', 'unverified', 'unverified']);
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-validation-control-'));
    try {
      writeFileSync(join(projectDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
      for (const role of roles) {
        mkdirSync(join(projectDir, 'config'), { recursive: true });
        const configure = (script: string) => writeFileSync(join(projectDir, 'config/validation.json'),
          JSON.stringify({ commands: { [role]: { command: '/bin/sh', args: ['-c', script] } } }));
        configure(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`);
        const configuredBaseline = await runProjectValidationBaseline(projectDir);
        const { runId, runDirPath } = createRun(projectDir, 'peer-validation', 'name: peer-validation\nstages: []\n', ['review', 'peer']);
        writeFileSync(runRecordPath(runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline: configuredBaseline }));
        const attempt = { index: 1, startedAt: 'fixture', writes: [], writeAttribution: 'structured' as const };
        writeStageStatus(projectDir, runId, 'review', { status: 'running', retries: 0, attempts: [{ ...attempt, status: 'running' }] });
        await recordGateValidationDelta(projectDir, runId, 'review', { runCommand: () => ({ exitCode: 0 }) });
        writeStageStatus(projectDir, runId, 'review', { status: 'complete', retries: 0, attempts: [{ ...attempt, status: 'complete', completedAt: 'fixture-end' }] });
        for (const writes of [['input.txt'], []]) {
          if (writes.length) writeFileSync(join(projectDir, 'input.txt'), `peer write ${role}`);
          writeStageStatus(projectDir, runId, 'peer', { status: 'complete', retries: 0, attempts: [{ ...attempt, status: 'complete', writes }] });
          expect((await recordGateValidationDelta(projectDir, runId, 'review'))?.pass).toBe(false);
        }
        configure(JSON.stringify(join(projectDir, `missing-${role}`)));
        const current = await runProjectValidationBaseline(projectDir);
        for (const discovery of [configuredBaseline.discovery, current.discovery]) {
          expect(discovery.commands).toEqual([
            expect.objectContaining({ role, command: '/bin/sh' }),
          ]);
        }
        expect(configuredBaseline.results.find((result) => result.role === role))
          .toMatchObject({ state: 'passed', exitCode: 0 });
        expect(current.results.find((result) => result.role === role))
          .toMatchObject({ state: 'failed', exitCode: 127 });
        expect(evaluateValidationDelta(configuredBaseline, current.results, undefined, current.discovery.commands).map((entry) => entry.state))
          .toEqual(['unverified']);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('projects raw exits without deciding causation from green or known-red bases', () => {
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
    } satisfies ProjectValidationBaseline;

    const improved = evaluateValidationDelta(baseline, [
      result('build', 'passed'), result('test', 'passed'), result('lint', 'passed'),
    ]);
    expect(improved.every((entry) => entry.state === 'verified')).toBe(true);

    const unchangedRed = evaluateValidationDelta(baseline, [
      result('build', 'passed'),
      result('test', 'failed', ['spec/existing.test.ts'], 1),
      result('lint', 'passed'),
    ]);
    expect(unchangedRed.find((entry) => entry.role === 'test')).toMatchObject({
      state: 'unverified', newFailureIdentifiers: [],
    });

    const regressed = evaluateValidationDelta(baseline, [
      result('build', 'failed', ['src/new.ts'], 1),
      result('test', 'failed', ['spec/existing.test.ts', 'spec/new.test.ts'], 2),
      result('lint', 'passed'),
    ]);
    expect(regressed).toContainEqual(expect.objectContaining({
      role: 'build', state: 'unverified', reason: expect.stringContaining('did not complete with exit 0'),
    }));
    expect(regressed).toContainEqual(expect.objectContaining({
      role: 'test', state: 'unverified', newFailureIdentifiers: [],
    }));
  });

  it('keeps red-to-red failures unverified even with different declared IDs', async () => {
    const measure = (id: string) => runProjectValidationBaseline(root, {
      commands: [{ role: 'test', command: 'check', args: [], display: 'check', report: { format: 'vitest-json' } }],
      runCommand: () => ({ exitCode: 1, stdout: validationReport([id]) }) });
    const baseline = await measure('old');
    expect(evaluateValidationDelta(baseline, (await measure('new')).results)[0].state).toBe('unverified');
  });

  it('keeps an unparseable red baseline unresolved rather than treating it as zero failures', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({ scripts: { test: 'opaque-check' } }),
      [`${root}/package-lock.json`]: '{}',
    });
    const baseline = await runProjectValidationBaseline(root, {
      commands: [{ role: 'test', command: 'check', args: [], display: 'check' }], fs,
      runCommand: () => ({ exitCode: 9, stderr: 'opaque failure; 0 errors were classified' }),
    });
    const test = baseline.results.find((entry) => entry.role === 'test');
    expect(test).toMatchObject({
      state: 'failed',
      failureIdentity: 'unknown',
      reason: expect.stringContaining('No declared structured reporter'),
    });
    if (!test?.reason) throw new Error('unknown failure cause was not recorded');
    expect(test?.failureCount).toBeUndefined();
  });

  it('keeps incidental output opaque while declared structured totals own identity', async () => {
    const baseline = await runProjectValidationBaseline(root, {
      commands: [{ role: 'test', command: 'check', args: [], display: 'check', report: { format: 'vitest-json', path: 'report.json' } }],
      runCommand: () => ({ exitCode: 1, stdout: 'FAIL unrelated error TS2322', report: validationReport(['actual'], { passed: 4 }) }) });
    expect(baseline.results[0]).toMatchObject({ testsRun: 5, failureCount: 1, failureIdentifiers: [JSON.stringify(['actual', 'case.test', 'test-failure'])] });
  });

  it('treats exit 127 as a command that could not run, not as a usable red baseline', async () => {
    const fs = memoryFs({
      [`${root}/package.json`]: JSON.stringify({
        scripts: { build: 'compile', test: 'check', lint: 'style' },
      }),
      [`${root}/package-lock.json`]: '{}',
    });

    const baseline = await runProjectValidationBaseline(root, {
      commands: (['build', 'test', 'lint'] as const).map(role => ({ role, command: 'check', args: [], display: 'check' })), fs,
      runCommand: ({ role }) => ({
        exitCode: 127,
        stderr: `sh: ${role}-tool: command not found`,
      }),
    });

    expect(baseline.results).toEqual([
      expect.objectContaining({ role: 'build', state: 'failed', exitCode: 127 }),
      expect.objectContaining({ role: 'test', state: 'failed', exitCode: 127 }),
      expect.objectContaining({ role: 'lint', state: 'failed', exitCode: 127 }),
    ]);
    expect(baseline.results.every((result) => result.reason?.includes('No declared structured reporter'))).toBe(true);
  });
});
