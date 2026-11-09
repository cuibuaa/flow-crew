import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runShipSetup } from '../src/cli-ship-setup.js';
import { validationEnvironment } from '../src/validation-environment.js';
import { readShipSetupReadyValidationBaseline } from '../src/ship-setup-record.js';

let root: string, project: string, target: string, state: string, brief: string;
const git = (...args: string[]) => isolatedProjectCommand('git', args, project, root).trim();
const write = (path: string, bytes: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const args = () => ['--project', project, '--target', target, '--brief', brief, '--base', 'base', '--branch', 'trial'];
const writeBrief = (extraArgs: string[] = []) => write(brief, ['---', 'inputs: [data]', 'validation:', '  commands:',
  '    test:', '      command: fixture-check', `      args: ${JSON.stringify(extraArgs)}`, '---', '# Goal',
  'Preserve declared input and defer configured validation.', '## Requirements', '1. Preserve the declared input.'].join('\n'));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'setup-discovery-')); project = join(root, 'project'); target = join(root, 'target');
  state = join(root, 'state'); brief = join(root, 'brief.md'); mkdirSync(project);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write(join(project, 'seed.txt'), 'base tree\n'); write(join(project, '.gitignore'), 'data/\nnode_modules/\ndist/\n');
  git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base'); write(join(project, 'data/input.txt'), 'declared input\n');
  writeBrief();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

// Outcome A supersedes the former eager setup cache and its invalidation table.
// The end-of-attempt lifecycle, not a cached setup measurement, owns freshness.
describe('setup records declarations without executing or caching validation', () => {
  it('keeps repeated setup ready without running even a failing or missing command', async () => {
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: 'FAIL existing.test' }));
    for (let retry = 0; retry < 2; retry++) {
      const report = await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runCommand });
      expect(report.state, JSON.stringify(report)).toBe('ready'); expect(report.baselineReuse).toBeUndefined();
      expect(report.validationBaseline).toMatchObject({ execution: 'skipped', results: expect.arrayContaining([
        expect.objectContaining({ role: 'test', state: 'unverified', failureIdentity: 'unknown', reason: expect.stringContaining('deferred') }),
      ]) });
    }
    expect(runCommand).not.toHaveBeenCalled(); expect(existsSync(join(state, 'ship-setups/baselines'))).toBe(false);
    expect(readShipSetupReadyValidationBaseline(target, readFileSync(brief, 'utf8'), state)?.execution).toBe('skipped');
  });

  it.each(['base commit', 'base tree', 'commands', 'lockfile', 'working source', 'environment', 'declared inputs'])(
    'discovers current declarations without an eager measurement after %s changes', async dimension => {
      const runner = vi.fn(() => ({ exitCode: 0 }));
      const setup = () => runShipSetup(args(), { globalDir: () => state, runValidationCommand: runner });
      expect((await setup()).state).toBe('ready');
      if (dimension === 'base commit' || dimension === 'base tree') {
        if (dimension === 'base tree') { write(join(project, 'seed.txt'), 'new tree\n'); git('add', '.'); }
        git('commit', '--allow-empty', '-qm', 'advance'); git('branch', '-f', 'base', 'HEAD');
        isolatedProjectCommand('git', ['reset', '--hard', git('rev-parse', 'HEAD')], target, root);
      } else if (dimension === 'commands') writeBrief(['--changed']);
      else if (dimension === 'lockfile') write(join(target, 'package-lock.json'), '{}\n');
      else if (dimension === 'working source') write(join(target, 'seed.txt'), 'dirty\n');
      else if (dimension === 'environment') vi.stubEnv('SETUP_ORDINARY_INPUT', 'changed');
      else for (const directory of [project, target]) write(join(directory, 'data/input.txt'), 'changed declared input\n');
      const report = await setup(); expect(report.state, JSON.stringify(report)).toBe('ready');
      expect(report.validationBaseline?.execution).toBe('skipped'); expect(runner).not.toHaveBeenCalled();
      expect(report.validationBaseline?.discovery.commands[0].args).toEqual(dimension === 'commands' ? ['--changed'] : []);
    },
  );

  it.each(['invalid JSON', 'empty results', 'missing criteria', 'old measured failures'])(
    'never adopts a legacy cache containing %s', async corruption => {
      write(join(state, 'ship-setups/baselines/stale.json'), corruption === 'invalid JSON' ? '{' : JSON.stringify({ version: 1, results: [], cached: corruption }));
      const runner = vi.fn(() => ({ exitCode: 0 }));
      const report = await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runner });
      expect(report.state).toBe('ready'); expect(report.validationBaseline?.execution).toBe('skipped');
      expect(report.baselineReuse).toBeUndefined(); expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each(['PWD', 'OLDPWD', 'SHLVL', 'TMUX', 'TMUX_PANE', '_', 'WSL_INTEROP', 'WT_SESSION', 'WINDOWID'])(
    'retains ordinary %s command inputs without running a setup command', async name => {
      vi.stubEnv(name, 'first');
      const runner = vi.fn(() => ({ exitCode: 0 }));
      expect((await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runner })).state).toBe('ready');
      vi.stubEnv(name, 'second');
      expect((await runShipSetup(args(), { globalDir: () => state, runValidationCommand: runner })).state).toBe('ready');
      expect(validationEnvironment(join(state, 'validation-env'), process.env).env[name]).toBe('second');
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it('keeps separate worktrees and brief identities separate without sharing validation results', async () => {
    const first = await runShipSetup(args(), { globalDir: () => state });
    target = join(root, 'another-target'); write(brief, readFileSync(brief, 'utf8') + '\nAnother task.\n');
    const second = await runShipSetup(args().map(value => value === 'trial' ? 'another-trial' : value), { globalDir: () => state });
    expect(first.state).toBe('ready'); expect(second.state).toBe('ready');
    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('setup did not become ready');
    expect(first.readyRecordPath).not.toBe(second.readyRecordPath);
    expect(second.validationBaseline.projectDir).toBe(target);
  });
});
