import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { runShipSetup } from '../src/cli-ship-setup.js';
import { evaluateValidationDelta, type ValidationRunResponse } from '../src/project-validation.js';
import { validationEnvironment } from '../src/validation-environment.js';
import { readShipSetupReadyValidationBaseline } from '../src/ship-setup-record.js';

let root: string, project: string, target: string, state: string, brief: string, bin: string, counter: string;
const git = (...args: string[]): string => isolatedProjectCommand('git', args, project, root).trim();
const write = (path: string, bytes: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const executable = (path: string, bytes: string): void => { write(path, bytes); chmodSync(path, 0o755); };
function writeBrief(extraArgs: string[] = []): void {
  write(brief, ['---', 'inputs: [data]', 'validation:', '  commands:', '    test:', '      command: l3-check',
    `      args: ${JSON.stringify(extraArgs)}`, '---', '# Goal', 'Measure the existing failures.',
    '## Requirements', '1. Preserve the existing result.'].join('\n'));
}
const args = () => ['--project', project, '--target', target, '--brief', brief, '--base', 'base', '--branch', 'trial'];
const setup = () => runShipSetup(args(), { globalDir: () => state });
const runs = () => readFileSync(counter, 'utf8').trim().split('\n').length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'l3-reuse-'));
  project = join(root, 'project'); target = join(root, 'target'); state = join(root, 'state');
  brief = join(root, 'brief.md'); bin = join(root, 'bin'); counter = join(root, 'calls');
  mkdirSync(project);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write(join(project, 'seed.txt'), 'base tree\n');
  write(join(project, '.gitignore'), 'data/\nnode_modules/\ndist/\n');
  write(join(project, 'package-lock.json'), '{}\n');
  write(join(project, 'packages/a/pnpm-lock.yaml'), '# nested lock\n');
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base');
  write(join(project, 'data/input.txt'), 'declared input\n');
  executable(join(bin, 'l3-runtime'), '#!/bin/sh\nexec /bin/sh "$@"\n');
  executable(join(bin, 'l3-check'), [
    '#!/usr/bin/env l3-runtime', 'sleep 0.05', 'echo run >> "$L3_COUNTER"',
    'printf "FAIL spec/existing.test.ts\\nTests 1 failed\\n"', 'exit 1', '',
  ].join('\n'));
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('L3_COUNTER', counter);
  writeBrief();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('content-keyed setup baseline reuse', () => {
  it('recipe8: repeated setup reuses the failed baseline and gate still detects new failures', async () => {
    const first = await setup();
    expect(first.state, JSON.stringify(first)).toBe('ready');
    expect(first.baselineReuse).toMatchObject({ state: 'executed', id: expect.any(String) });
    const second = await setup();
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(runs()).toBe(1);
    expect(second.baselineReuse).toEqual({ state: 'reused', id: first.baselineReuse!.id });
    const recorded = JSON.parse(readFileSync(second.state === 'ready' ? second.readyRecordPath : '', 'utf8'));
    expect(recorded.baselineReuse).toEqual(second.baselineReuse);
    const baseline = readShipSetupReadyValidationBaseline(target, readFileSync(brief, 'utf8'), state)!;
    expect(baseline.gateCriteria.find(item => item.role === 'test')?.rule).toBe('no_regression_from_baseline');
    expect(evaluateValidationDelta(baseline, baseline.results).every(item => item.state === 'pass')).toBe(true);
    const next = baseline.results.map(item => item.role === 'test'
      ? { ...item, failureIdentifiers: [...item.failureIdentifiers, 'spec/new.test.ts'], failureCount: 2 } : item);
    expect(evaluateValidationDelta(baseline, next).find(item => item.role === 'test')?.state).toBe('regression');
  });

  it.each([
    'base commit', 'base tree', 'commands', 'lockfile byte', 'nested lockfile byte', 'binary bytes',
    'binary resolution', 'binary permission', 'interpreter bytes', 'interpreter resolution',
    'declared inputs', 'working source', 'environment', 'timeout',
  ])(
    'recomputes when %s changes', async dimension => {
      const first = await setup();
      expect(first.state, JSON.stringify(first)).toBe('ready');
      if (dimension === 'base commit' || dimension === 'base tree') {
        if (dimension === 'base tree') { write(join(project, 'seed.txt'), 'new tree\n'); git('add', '.'); }
        git('commit', '--allow-empty', '-qm', 'advance'); git('branch', '-f', 'base', 'HEAD');
        isolatedProjectCommand('git', ['reset', '--hard', git('rev-parse', 'HEAD')], target, root);
      } else if (dimension === 'commands') writeBrief(['--another-command']);
      else if (dimension.includes('lockfile')) {
        const path = dimension.startsWith('nested') ? 'packages/a/pnpm-lock.yaml' : 'package-lock.json';
        write(join(target, path), readFileSync(join(target, path), 'utf8') + ' ');
      } else if (dimension === 'binary bytes' || dimension === 'interpreter bytes') {
        const path = join(bin, dimension === 'binary bytes' ? 'l3-check' : 'l3-runtime');
        write(path, readFileSync(path, 'utf8') + '# changed\n');
      }
      else if (dimension.endsWith('resolution')) {
        const name = dimension.startsWith('binary') ? 'l3-check' : 'l3-runtime';
        const alternate = join(root, 'alternate');
        executable(join(alternate, name), readFileSync(join(bin, name), 'utf8'));
        vi.stubEnv('PATH', `${alternate}:${process.env.PATH}`);
      } else if (dimension === 'binary permission') chmodSync(join(bin, 'l3-check'), 0o700);
      else if (dimension === 'declared inputs') {
        for (const directory of [project, target]) write(join(directory, 'data/input.txt'), 'changed declared input\n');
      } else if (dimension === 'working source') write(join(target, 'seed.txt'), 'dirty at same HEAD\n');
      else if (dimension === 'timeout') setEngineDefaults({ validation_timeout_ms: 90_000 });
      else vi.stubEnv('L3_ORDINARY_INPUT', 'changed');
      const second = await setup();
      expect(second.state, JSON.stringify(second)).toBe('ready');
      expect(second.baselineReuse?.state).toBe('executed');
      expect(second.baselineReuse?.id).not.toBe(first.baselineReuse?.id);
      expect(runs()).toBe(2);
    },
  );

  it('reuses across separate worktrees and different brief prose with identical content inputs', async () => {
    const first = await setup();
    target = join(root, 'another-target');
    write(brief, readFileSync(brief, 'utf8') + '\nA different task using the same inputs.\n');
    const second = await runShipSetup(args().map(value => value === 'trial' ? 'another-trial' : value),
      { globalDir: () => state });
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(second.baselineReuse).toEqual({ state: 'reused', id: first.baselineReuse!.id });
    expect(second.validationBaseline?.projectDir).toBe(target);
    expect(runs()).toBe(1);
  });

  it('keeps unidentified failures unknown and re-measures on retry', async () => {
    executable(join(bin, 'l3-check'), '#!/bin/sh\necho run >> "$L3_COUNTER"\necho unidentified\nexit 1\n');
    write(join(project, 'Makefile'), 'test:\n\tl3-check\n');
    git('add', 'Makefile'); git('commit', '-qm', 'make'); git('branch', '-f', 'base', 'HEAD');
    write(brief, '---\ninputs: [data]\n---\n# Goal\nKeep unknown results unknown.\n'
      + '## Requirements\n1. Preserve unknown evidence.\n');
    for (let retry = 0; retry < 2; retry++) {
      const report = await setup();
      expect(report.state, JSON.stringify(report)).toBe('ready');
      expect(report.baselineReuse?.state).toBe('executed');
      expect(report.validationBaseline?.results.find(item => item.role === 'test'))
        .toMatchObject({ state: 'failed', failureIdentity: 'unknown' });
      expect(report.validationBaseline?.gateCriteria.find(item => item.role === 'test')?.rule)
        .not.toBe('must_remain_green');
      expect(existsSync(join(state, 'ship-setups/baselines'))).toBe(false);
    }
    expect(runs()).toBe(2);
  });

  it.each(['timeout', 'preparation', 'spawn', 'abort'])('unknown retry re-measures after %s', async cause => {
    let calls = 0;
    const runCommand = async (): Promise<ValidationRunResponse> => {
      calls++;
      if (cause === 'spawn') throw new Error('spawn failed');
      return cause === 'preparation'
        ? { exitCode: 1, dependencyPreparationFailed: true, stderr: 'network unavailable' }
        : { exitCode: null, error: cause };
    };
    const first = await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runCommand });
    const second = await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runCommand });
    for (const report of [first, second]) {
      expect(report.state, JSON.stringify(report)).toBe('refused');
      expect(report.validationBaseline?.results.find(item => item.role === 'test'))
        .toMatchObject({ state: 'launch_error', failureIdentity: 'unknown' });
      expect(report.validationBaseline?.gateCriteria.find(item => item.role === 'test')?.rule)
        .toBe('baseline_unresolved');
      expect(report.baselineReuse?.state).toBe('executed');
      if (cause === 'preparation') {
        expect(report.validationBaseline?.results.find(item => item.role === 'test'))
          .toMatchObject({ exitCode: 1, reason: 'Dependency preparation exited with code 1' });
      }
    }
    expect(calls).toBe(2);
    expect(existsSync(join(state, 'ship-setups/baselines'))).toBe(false);
    const recovered = await setup();
    expect(recovered.state, JSON.stringify(recovered)).toBe('ready');
    expect(recovered.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(1);
  });

  it.each(['PWD', 'OLDPWD', 'SHLVL', 'TMUX', 'TMUX_PANE', '_', 'WSL_INTEROP', 'WT_SESSION', 'WINDOWID'])(
    'retains %s as a command input and re-measures when it changes', async name => {
      vi.stubEnv(name, 'first caller');
      const first = await setup();
      expect((await setup()).baselineReuse).toEqual({ state: 'reused', id: first.baselineReuse!.id });
      vi.stubEnv(name, 'second caller');
      const second = await setup();
      expect(second.state, JSON.stringify(second)).toBe('ready');
      expect(second.baselineReuse?.state).toBe('executed');
      expect(runs()).toBe(2);
      const { env, removed } = validationEnvironment(join(state, 'derived'), process.env);
      expect(env[name]).toBe('second caller');
      expect(removed).not.toContain(name);
    },
  );

  it('reuses the same environment and measures changed inputs actually read by the command', async () => {
    executable(join(bin, 'l3-check'), [
      '#!/bin/sh', 'echo run >> "$L3_COUNTER"',
      'printf "%s" "$L3_ORDINARY_INPUT" > "$L3_OBSERVED"', 'exit 0', '',
    ].join('\n'));
    vi.stubEnv('L3_OBSERVED', join(root, 'observed'));
    vi.stubEnv('L3_ORDINARY_INPUT', 'first input');
    const first = await setup();
    const second = await setup();
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(second.baselineReuse).toEqual({ state: 'reused', id: first.baselineReuse!.id });
    expect(runs()).toBe(1);
    vi.stubEnv('L3_ORDINARY_INPUT', 'changed input');
    const third = await setup();
    expect(third.baselineReuse?.state).toBe('executed');
    expect(readFileSync(join(root, 'observed'), 'utf8')).toBe('changed input');
    expect(runs()).toBe(2);
    expect(readdirSync(join(state, 'ship-setups/baselines'))).toHaveLength(1);
  });

  it('derives the baseline-environment key without creating a validation home', async () => {
    await setup();
    expect(existsSync(join(state, 'baseline-environment'))).toBe(false);
    await setup();
    expect(existsSync(join(state, 'baseline-environment'))).toBe(false);
  });

  it('hashes the worktree once per setup, including cache hits', async () => {
    const hashing = await import('../src/rollback-content-store.js');
    const hash = vi.spyOn(hashing, 'hashRollbackFileSync');
    await setup();
    const seed = join(target, 'seed.txt');
    expect(hash.mock.calls.filter(([path]) => path === seed)).toHaveLength(1);
    hash.mockClear();
    await setup();
    expect(hash.mock.calls.filter(([path]) => path === seed)).toHaveLength(1);
  });

  it.each(['invalid JSON', 'empty results', 'missing criteria', 'unmeasurable result'])(
    'measures again after cache corruption: %s', async corruption => {
      await setup();
      const directory = join(state, 'ship-setups/baselines');
      const path = join(directory, readdirSync(directory)[0]);
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      if (corruption === 'empty results') cached.validationBaseline.results = [];
      if (corruption === 'missing criteria') cached.validationBaseline.gateCriteria = [];
      if (corruption === 'unmeasurable result') {
        const result = cached.validationBaseline.results.find((item: { role: string }) => item.role === 'test');
        Object.assign(result, { state: 'launch_error', failureIdentity: 'unknown', failureIdentifiers: [] });
        delete result.exitCode; delete result.failureCount; delete result.failureEvidence;
        const criterion = cached.validationBaseline.gateCriteria.find((item: { role: string }) => item.role === 'test');
        Object.assign(criterion, { rule: 'baseline_unresolved', baselineFailureIdentifiers: [] });
        delete criterion.baselineFailureCount; delete criterion.baselineFailureEvidence;
      }
      write(path, corruption === 'invalid JSON' ? '{' : JSON.stringify(cached));
      const second = await setup();
      expect(second.state).toBe('ready');
      expect(second.baselineReuse?.state).toBe('executed');
      expect(runs()).toBe(2);
    },
  );

  it('reuses after preparation and ignored build output, and fingerprints the manager', async () => {
    write(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'l3-check' } }));
    git('add', 'package.json'); git('commit', '-qm', 'node recipe'); git('branch', '-f', 'base', 'HEAD');
    const toolkit = join(root, 'toolkit');
    write(join(toolkit, 'package.json'), '{"name":"fixture-manager"}');
    write(join(toolkit, 'lib/implementation'), 'original implementation');
    executable(join(toolkit, 'bin/npm'), [
      '#!/bin/sh',
      'if [ "$1" = ci ]; then mkdir -p node_modules; echo locked > node_modules/dependency; exit 0; fi',
      'mkdir -p dist; echo built > dist/output', 'exec l3-check', '',
    ].join('\n'));
    vi.stubEnv('PATH', `${join(toolkit, 'bin')}:${process.env.PATH}`);
    write(brief, '---\ninputs: [data]\n---\n# Goal\n## Requirements\n1. Preserve the recipe result.\n');
    const first = await setup(), second = await setup();
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(second.baselineReuse).toEqual({ state: 'reused', id: first.baselineReuse!.id });
    expect(runs()).toBe(1);
    write(join(toolkit, 'lib/implementation'), 'changed implementation');
    const third = await setup();
    expect(third.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(2);
  });

  it('recomputes when a source symlink changes even if the dereferenced bytes match', async () => {
    write(join(project, 'one'), 'same bytes'); write(join(project, 'two'), 'same bytes');
    symlinkSync('one', join(project, 'alias'));
    git('add', '.'); git('commit', '-qm', 'linked source'); git('branch', '-f', 'base', 'HEAD');
    await setup();
    rmSync(join(target, 'alias')); symlinkSync('two', join(target, 'alias'));
    const second = await setup();
    expect(second.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(2);
  });

  it('hashes discovered validation configuration even when Git ignores it', async () => {
    await setup();
    write(join(target, '.gitignore'), readFileSync(join(target, '.gitignore'), 'utf8') + 'package.json\n');
    executable(join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = ci ]; then exit 0; fi\nexec l3-check\n');
    write(brief, '---\ninputs: [data]\n---\n# Goal\n## Requirements\n1. Preserve the recipe result.\n');
    const manifest = join(target, 'package.json');
    write(manifest, JSON.stringify({ scripts: { test: 'l3-check' } }));
    const first = await setup();
    expect(first.state, JSON.stringify(first)).toBe('ready');
    write(manifest, JSON.stringify({ scripts: { test: 'l3-check changed' } }));
    const second = await setup();
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(second.baselineReuse?.state).toBe('executed');
    expect(second.baselineReuse?.id).not.toBe(first.baselineReuse?.id);
    expect(runs()).toBe(3);
  });

  it('treats an unresolvable source link as an unknown identity and measures each time', async () => {
    symlinkSync('absent', join(project, 'broken-link'));
    git('add', '.'); git('commit', '-qm', 'broken link'); git('branch', '-f', 'base', 'HEAD');
    const first = await setup(), second = await setup();
    expect(first.state, JSON.stringify(first)).toBe('ready');
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(first.baselineReuse).toEqual({ state: 'executed' });
    expect(second.baselineReuse).toEqual({ state: 'executed' });
    expect(runs()).toBe(2);
  });

  it('keeps setup usable if the optional cache cannot be published', async () => {
    write(join(state, 'ship-setups/baselines'), 'not a directory');
    const first = await setup(), second = await setup();
    expect(first.state, JSON.stringify(first)).toBe('ready');
    expect(second.state, JSON.stringify(second)).toBe('ready');
    expect(second.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(2);
  });

  it('cannot reuse a prior baseline when its interpreter becomes unavailable', async () => {
    await setup();
    rmSync(join(bin, 'l3-runtime'));
    const second = await setup();
    expect(second.state).toBe('refused');
    expect(second.validationBaseline?.results.find(item => item.role === 'test')?.state).toBe('launch_error');
    expect(second.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(1);
  });

  it('does not publish a baseline whose inputs changed while measuring', async () => {
    executable(join(bin, 'l3-check'), [
      '#!/bin/sh', 'echo run >> "$L3_COUNTER"', 'echo changed >> seed.txt',
      'printf "FAIL spec/existing.test.ts\\nTests 1 failed\\n"', 'exit 1', '',
    ].join('\n'));
    await setup();
    // Restore the original input population; a stale pre-execution key must not hit.
    write(join(target, 'seed.txt'), 'base tree\n');
    const second = await setup();
    expect(second.baselineReuse?.state).toBe('executed');
    expect(runs()).toBe(2);
  });
});
