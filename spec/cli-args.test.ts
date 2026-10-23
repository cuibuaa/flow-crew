import './test-support/policy-runtime.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_COMMANDS, commandName, commandUsage, parseCommandArgs } from '../src/cli-args.js';

const repository = join(import.meta.dirname, '..');
const routes = Object.keys(CLI_COMMANDS);
const groups = [...new Set(routes.filter(name => name.includes(' ')).map(name => name.split(' ')[0]))];
const root = mkdtempSync(join(tmpdir(), 'argv-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let fixtureIndex = 0;

function fixture() {
  const directory = join(root, String(fixtureIndex++));
  const home = join(directory, 'h');
  const fcHome = join(directory, 'f');
  mkdirSync(home, { recursive: true });
  return { home, fcHome };
}

type Fixture = ReturnType<typeof fixture>;
function runCli(args: string[], isolated: Fixture): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repository, 'src/cli.ts'), ...args], {
      cwd: repository,
      env: { ...process.env, HOME: isolated.home, USERPROFILE: isolated.home, FC_HOME: isolated.fcHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function inBatches<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  // Keep child startup within the six CPUs assigned to package validation.
  for (let offset = 0; offset < items.length; offset += 6) {
    const results = await Promise.allSettled(items.slice(offset, offset + 6).map(action));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

function requiredArgs(name: string, except?: string): string[] {
  return Object.entries(CLI_COMMANDS[name].options)
    .filter(([key, option]) => option.required && key !== except).flatMap(([key]) => [`--${key}`, 'fixture']);
}

function sampleValue(option: (typeof CLI_COMMANDS)[string]['options'][string]): string {
  if (option.choices) return option.choices[0];
  if (option.integer !== undefined) return String(Math.max(option.integer, 1));
  return 'fixture';
}

describe('declarative command grammar', () => {
  it.each(routes)('%s rejects unknown long and short flags before execution', name => {
    expect(() => parseCommandArgs(name, ['--not-a-flowcrew-option'])).toThrow(/unknown.*option/i);
    expect(() => parseCommandArgs(name, ['-Z'])).toThrow(/unknown.*option/i);
  });

  it.each(routes)('%s shares the command prefix and help grammar', name => {
    const args = requiredArgs(name);
    expect(parseCommandArgs(name, [...name.split(' '), ...args])).toEqual(parseCommandArgs(name, args));
    expect(commandName(name.split(' '))).toBe(name);
    expect(commandUsage(name)).toContain(`Usage: flowcrew ${name}`);
    for (const help of ['--help', '-h']) {
      expect(parseCommandArgs(name, [help, '--not-a-flowcrew-option']).help).toBe(true);
    }
  });

  it.each(routes)('%s retains declared defaults and accepts declared flag spellings', name => {
    const args = requiredArgs(name);
    const baseline = parseCommandArgs(name, args);
    for (const [key, option] of Object.entries(CLI_COMMANDS[name].options)) {
      const flag = `--${key}`;
      if (option.default !== undefined) expect(baseline.values.get(flag), `${name} ${flag}`).toBe(option.default);
      if (option.refusal) continue;
      const rest = requiredArgs(name, key);
      if (option.flag) {
        expect(parseCommandArgs(name, [...rest, flag]).flags.has(flag)).toBe(true);
        expect(() => parseCommandArgs(name, [...rest, `${flag}=true`])).toThrow(/does not take a value/);
        if (option.alias) expect(parseCommandArgs(name, [...rest, option.alias]).flags.has(flag)).toBe(true);
      } else {
        const value = key === 'poll' ? '1' : sampleValue(option);
        expect(parseCommandArgs(name, [...rest, `${flag}=${value}`]).values.get(flag)).toBe(value);
        if (!option.equalsOnly && !option.optional) {
          expect(parseCommandArgs(name, [...rest, flag, value]).values.get(flag)).toBe(value);
        }
        if (option.optional) expect(parseCommandArgs(name, [...rest, flag]).flags.has(flag)).toBe(true);
        expect(() => parseCommandArgs(name, [...rest, `${flag}=`])).toThrow(/requires a value/);
        expect(() => parseCommandArgs(name, [...rest, `${flag}=${value}`, `${flag}=${value}`])).toThrow(/only once/);
        if (option.required) expect(() => parseCommandArgs(name, rest)).toThrow(/required/);
        if (option.integer !== undefined) {
          for (const invalid of ['abc', '-1', '1.5', '9007199254740992', String(option.integer - 1)]) {
            expect(() => parseCommandArgs(name, [...rest, `${flag}=${invalid}`]), `${name} ${flag}=${invalid}`).toThrow(/integer/);
          }
          if (option.max !== undefined) {
            expect(() => parseCommandArgs(name, [...rest, `${flag}=${option.max! + 1}`])).toThrow(/integer/);
          }
        }
      }
    }
  });

  it('keeps the numeric defaults used by scripts and refuses unsafe retention counts', () => {
    for (const [name, flag, value] of [
      ['clean', '--keep', '5'], ['list', '--limit', '10'], ['events', '--limit', '100'],
      ['watch', '--poll', '45'], ['daemon logs', '--tail', '100'],
      ['task tail', '--tail', '100'], ['daemon deploy', '--timeout-ms', '60000'],
    ]) expect(parseCommandArgs(name, []).values.get(flag)).toBe(value);
    expect(parseCommandArgs('task list', []).values.get('--limit')).toBeUndefined();
    for (const value of ['abc', '-1', '1.5', '1e2', '9007199254740992']) {
      expect(() => parseCommandArgs('clean', [`--keep=${value}`])).toThrow(/integer/);
    }
    expect(parseCommandArgs('clean', ['--keep=0']).values.get('--keep')).toBe('0');
    expect(() => parseCommandArgs('quick', ['--timeout=100'])).toThrow(/removed.*default_timeout_ms/);
    expect(() => parseCommandArgs('quick', ['--campaign-context', 'skip'])).toThrow(/syntax/);
    expect(parseCommandArgs('quick', ['--campaign-context=skip']).values.get('--campaign-context')).toBe('skip');
  });

  it('preserves option values beginning with hyphens, including YAML briefs', () => {
    const brief = '---\nvalidation: [\n---\n## Requirements\n1. Deliver a result.\n';
    expect(parseCommandArgs('quick', ['--task', brief]).values.get('--task')).toBe(brief);
    expect(() => parseCommandArgs('prune', ['--run', '--apply'])).toThrow(/requires a value/);
    expect(parseCommandArgs('fc_tasks update', ['fc_tasks', 'update', 'fc_tasks', '--entry', '{}']).positionals).toEqual(['fc_tasks']);
  });

  it('matches every documented route and flag in guide/cli.md', () => {
    const guide = readFileSync(join(repository, 'guide/cli.md'), 'utf8');
    const section = guide.split('<!-- cli-options:start -->')[1]?.split('<!-- cli-options:end -->')[0];
    expect(section, 'guide must expose the complete CLI options table').toBeDefined();
    const documented = new Map<string, string[]>();
    for (const line of section!.split('\n')) {
      const match = line.match(/^\|\s*`([^`]+)`\s*\|([^|]*)\|/);
      if (match) {
        expect(documented.has(match[1]), `duplicate guide route ${match[1]}`).toBe(false);
        documented.set(match[1], [...match[2].matchAll(/`(-{1,2}[^`]+)`/g)].map(entry => entry[1]).sort());
      }
    }
    expect([...documented.keys()].sort()).toEqual([...routes].sort());
    for (const [name, spec] of Object.entries(CLI_COMMANDS)) {
      const accepted = Object.entries(spec.options).filter(([, option]) => !option.refusal).flatMap(([flag, option]) => [`--${flag}`, ...(option.alias ? [option.alias] : [])]).sort();
      expect(documented.get(name), `guide flags for ${name}`).toEqual(accepted);
    }
  });
});

describe('CLI argument dispatch before side effects', () => {
  it('rejects malformed clean counts without touching a scrubbed readable run', async () => {
    const isolated = fixture();
    const run = join(isolated.fcHome, 'runs', 'scrubbed-run');
    mkdirSync(run, { recursive: true });
    const state = JSON.stringify({ runId: 'scrubbed-run', projectDir: '/scrubbed/project', workflowName: 'fixture', status: 'complete', stages: {}, startedAt: '2026-01-01T00:00:00.000Z', engineCheckpoint: { version: 2, runId: 'scrubbed-run', projectDir: '/scrubbed/project', pid: 2147483647, bootId: '00000000-0000-0000-0000-000000000000', processStart: { kind: 'linux', value: '1' }, processes: [], at: '2026-01-01T00:00:00.000Z' } });
    writeFileSync(join(run, 'run.json'), state);
    writeFileSync(join(run, 'evidence.txt'), 'preserve this evidence\n');
    for (const args of [['clean', '--keep', 'abc'], ['clean', '--keep=abc']]) {
      const result = await runCli(args, isolated);
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/keep|usage|integer/i);
      expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(state);
      expect(readFileSync(join(run, 'evidence.txt'), 'utf8')).toBe('preserve this evidence\n');
    }
    // Confirm this settled fixture really is deletable once a valid count permits it.
    const valid = await runCli(['clean', '--keep=0'], isolated);
    expect(valid.code, JSON.stringify(valid)).toBe(0);
    expect(existsSync(run), JSON.stringify(valid)).toBe(false);
  }, 60_000);

  it('returns usage exit 1 for unknown flags on every route before creating a store', async () => {
    await inBatches(routes, async name => {
      const isolated = fixture();
      const result = await runCli([...name.split(' '), '--not-a-flowcrew-option'], isolated);
      expect(result.code, `${name}: ${JSON.stringify(result)}`).toBe(1);
      expect(result.stdout + result.stderr, name).toMatch(/unknown.*option/i);
      expect(result.stdout + result.stderr, name).toContain(`Usage: flowcrew ${name}`);
      expect(existsSync(isolated.fcHome), `${name} created FC_HOME on usage error`).toBe(false);
    });
  }, 60_000);

  it.each([
    ['task'], ['task', 'invalid'], ['daemon'], ['daemon', 'invalid'],
    ['dashboard'], ['dashboard', 'invalid'], ['inbox', 'invalid'],
    ['fc_tasks', 'invalid'], ['session-push'], ['session-push', 'invalid'],
    ['status', '--project'], ['guide', '--run'], ['interrupt', '--stage'],
    ['doctor', '--repair-registry', '--invalid'],
  ])('keeps usage on rejected invocation %j without creating a store', async (...args) => {
    const isolated = fixture();
    const result = await runCli(args, isolated);
    expect(result.code, JSON.stringify(result)).toBe(1);
    expect(result.stdout + result.stderr).toContain(`Usage: flowcrew ${args[0]} `);
    expect(existsSync(isolated.fcHome)).toBe(false);
    expect(readdirSync(isolated.home)).toEqual([]);
  });

  it.each(['quick', 'status'])('preserves the %s CLI diagnostic casing and complete unknown token', async name => {
    const result = await runCli([name, '--invalid=value'], fixture());
    expect(result.code).toBe(1);
    expect(result.stderr.split('\n')[0]).toBe(`Unknown ${name} option: --invalid=value`);
  });

  it.each(['--help', '-h'])('%s prints usage for every route and command group without creating FC_HOME', async help => {
    await inBatches([...routes, ...groups, ''], async name => {
      const isolated = fixture();
      const result = await runCli([...name.split(' ').filter(Boolean), help], isolated);
      expect(result.code, `${name} ${help}: ${JSON.stringify(result)}`).toBe(0);
      expect(result.stdout, `${name} ${help}`).toMatch(/Usage:/i);
      expect(existsSync(isolated.fcHome), `${name} ${help} created FC_HOME`).toBe(false);
      expect(readdirSync(isolated.home), `${name} ${help} wrote HOME`).toEqual([]);
    });
  }, 60_000);

  it.each(['--help', '-h'])('%s never contacts an available private daemon for any route or group', async help => {
    const isolated = fixture();
    mkdirSync(isolated.fcHome);
    let contacts = 0;
    const server = createServer(socket => { contacts++; socket.destroy(); });
    const socketPath = join(isolated.fcHome, 'daemon.sock');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      await inBatches([...routes, ...groups, ''], async name => {
        const result = await runCli([...name.split(' ').filter(Boolean), help], isolated);
        expect(result.code, `${name} ${help}: ${JSON.stringify(result)}`).toBe(0);
        expect(result.stdout).toMatch(/Usage:/i);
        expect(readdirSync(isolated.fcHome), `${name} ${help} wrote FC_HOME`).toEqual(['daemon.sock']);
        expect(readdirSync(isolated.home), `${name} ${help} wrote HOME`).toEqual([]);
      });
      expect(contacts).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);
});
