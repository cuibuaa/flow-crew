import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_INSTALL_HINT,
  findExecutableOnPath,
  resolveAdapterChoice,
  type AdapterName,
} from '../src/adapters/availability.js';
import { normalizeAdapterName } from '../src/adapters/loader.js';

const repositoryRoot = join(import.meta.dirname, '..');
const fixtureRoots: string[] = [];

interface CliFixture {
  root: string;
  home: string;
  fcHome: string;
  project: string;
  bin: string;
}

function cliFixture(): CliFixture {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-adapter-${randomBytes(4).toString('hex')}-`));
  fixtureRoots.push(root);
  const home = join(root, 'home');
  const fcHome = join(root, 'state');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const path of [home, fcHome, project, bin]) mkdirSync(path, { recursive: true });
  // Deliberately do not install `which`: production command discovery must
  // scan PATH directly on minimal images and macOS fixtures alike.
  return { root, home, fcHome, project, bin };
}

function installCommand(fixture: CliFixture, name: 'codex' | 'claude' | 'flowcrew'): string {
  const path = join(fixture.bin, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

function writeAdapterConfig(fixture: CliFixture, adapter: string): string {
  const configDir = join(fixture.project, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'defaults.yaml');
  writeFileSync(path, `adapter: ${adapter}\n`, 'utf-8');
  return path;
}

function runCli(
  fixture: CliFixture,
  cliArgs: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'), ...cliArgs],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: fixture.home,
        FC_HOME: fixture.fcHome,
        PROJECT_DIR: fixture.project,
        PATH: fixture.bin,
        NO_COLOR: '1',
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function structuredBrief(): string {
  return [
    '---',
    'terminal_states:',
    '  complete:',
    '    paths: [docs/result.md]',
    '---',
    '# Goal',
    'Exercise adapter resolution.',
    '',
  ].join('\n');
}

function quickUntilWorkflowLookup(fixture: CliFixture) {
  return runCli(fixture, [
    'quick',
    '--project', fixture.project,
    '--workflow', 'intentionally-missing',
    '--task', structuredBrief(),
  ]);
}

function projectSnapshot(root: string): Array<{ path: string; kind: 'dir' | 'file'; content?: string; mtimeMs: number }> {
  if (!existsSync(root)) return [];
  const entries: Array<{ path: string; kind: 'dir' | 'file'; content?: string; mtimeMs: number }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        entries.push({ path: rel, kind: 'dir', mtimeMs: statSync(path).mtimeMs });
        walk(path);
      } else if (entry.isFile()) {
        entries.push({ path: rel, kind: 'file', content: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs });
      }
    }
  };
  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('adapter resolution matrix', () => {
  it('finds executable PATH entries without an external which command', () => {
    const fixture = cliFixture();
    const codex = installCommand(fixture, 'codex');

    expect(existsSync(join(fixture.bin, 'which'))).toBe(false);
    expect(findExecutableOnPath('codex', fixture.bin)).toBe(codex);
    expect(findExecutableOnPath('claude', fixture.bin)).toBeUndefined();
  });

  const installations: Array<{ label: string; installed: AdapterName[] }> = [
    { label: 'none', installed: [] },
    { label: 'codex only', installed: ['codex'] },
    { label: 'claude only', installed: ['claude'] },
    { label: 'both', installed: ['codex', 'claude'] },
  ];
  const configured = ['auto', 'codex', 'claude'] as const;
  const explicit = [undefined, 'codex', 'claude'] as const;

  for (const installation of installations) {
    for (const projectChoice of configured) {
      for (const cliChoice of explicit) {
        it(`${installation.label}; configured=${projectChoice}; explicit=${cliChoice ?? 'absent'}`, () => {
          const result = resolveAdapterChoice(
            { configured: projectChoice, explicit: cliChoice },
            installation.installed,
          );
          if (installation.installed.length === 0) {
            expect(result).toMatchObject({ ok: false, error: 'none-installed' });
            return;
          }

          const requested = cliChoice ?? projectChoice;
          const expected = requested !== 'auto' && installation.installed.includes(requested)
            ? requested
            : installation.installed.includes('codex')
              ? 'codex'
              : 'claude';
          expect(result).toMatchObject({ ok: true, adapter: expected });
          if (!result.ok) return;
          expect(result.reason).toContain(cliChoice ? 'explicit --adapter' : projectChoice === 'auto' ? 'auto' : 'project configuration');
          if (requested !== 'auto' && !installation.installed.includes(requested)) {
            expect(result.reason).toContain('not installed');
            expect(result.reason).toContain('fallback');
          }
        });
      }
    }
  }

  it('returns truthful installation commands for an empty machine', () => {
    const result = resolveAdapterChoice({ configured: 'auto' }, []);
    expect(result).toMatchObject({ ok: false, error: 'none-installed' });
    if (result.ok) return;
    expect(result.hint).toContain('@openai/codex');
    expect(result.hint).toContain('@anthropic-ai/claude-code');
    expect(result.hint).not.toContain('@anthropic/claude-code');
  });

  it('rejects an unknown explicit value before reporting machine availability', () => {
    expect(() => resolveAdapterChoice({ explicit: 'invented', configured: 'auto' }, []))
      .toThrow(/Unknown explicit adapter/);
  });

  it('lets an explicit choice win without validating the setting it overrides', () => {
    // `mock` is a legal adapter for the loader but not a resolvable installed CLI,
    // so validating the overridden setting used to fail a run that --adapter alone
    // fully determines.
    for (const configured of ['mock', 'invented', 'CODEX ']) {
      const resolution = resolveAdapterChoice({ explicit: 'codex', configured }, ['codex']);
      expect(resolution, configured).toMatchObject({ ok: true, adapter: 'codex' });
      expect((resolution as { reason: string }).reason, configured)
        .toContain('explicit --adapter choice');
    }
  });

  it('keeps shared installation hints pinned to the real package names', () => {
    expect(ADAPTER_INSTALL_HINT).toEqual({
      codex: 'npm i -g @openai/codex',
      claude: 'npm i -g @anthropic-ai/claude-code',
    });
  });

  it('consumes auto before the loader normalizer sees it', () => {
    const result = resolveAdapterChoice({ configured: 'auto' }, ['claude']);
    expect(result).toMatchObject({ ok: true, adapter: 'claude' });
    if (!result.ok) return;
    expect(() => normalizeAdapterName(result.adapter)).not.toThrow();
  });
});

describe('CLI adapter behavior', () => {
  it.each(['codex', 'claude'] as const)('selects the only installed %s CLI at runtime', (adapter) => {
    const fixture = cliFixture();
    writeAdapterConfig(fixture, 'auto');
    installCommand(fixture, adapter);

    const result = quickUntilWorkflowLookup(fixture);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`Adapter resolution: ${adapter}`);
    expect(`${result.stdout}${result.stderr}`).toContain(`only installed CLI, ${adapter}`);
  });

  it('fails nonzero with both correct install commands when no CLI is installed', () => {
    const fixture = cliFixture();
    writeAdapterConfig(fixture, 'auto');

    const result = quickUntilWorkflowLookup(fixture);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('@openai/codex');
    expect(output).toContain('@anthropic-ai/claude-code');
    expect(output).not.toContain('@anthropic/claude-code');
  });

  it('does not rewrite defaults while start resolves an unavailable legacy choice', () => {
    const fixture = cliFixture();
    const defaultsPath = writeAdapterConfig(fixture, 'codex');
    const before = { content: readFileSync(defaultsPath, 'utf-8'), mtimeMs: statSync(defaultsPath).mtimeMs };

    const result = runCli(fixture, ['start']);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('@anthropic-ai/claude-code');
    expect(readFileSync(defaultsPath, 'utf-8')).toBe(before.content);
    expect(statSync(defaultsPath).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps a legacy codex setting effective and byte-identical when codex is installed', () => {
    const fixture = cliFixture();
    const defaultsPath = writeAdapterConfig(fixture, 'codex');
    installCommand(fixture, 'codex');
    const before = readFileSync(defaultsPath, 'utf-8');

    const result = quickUntilWorkflowLookup(fixture);

    expect(`${result.stdout}${result.stderr}`).toContain('Adapter resolution: codex');
    expect(`${result.stdout}${result.stderr}`).toContain('project configuration');
    expect(readFileSync(defaultsPath, 'utf-8')).toBe(before);
  });

  it('keeps ordinary doctor completely read-only and rejects a PATH entry from another checkout', () => {
    const fixture = cliFixture();
    writeAdapterConfig(fixture, 'auto');
    mkdirSync(join(fixture.project, 'config', 'agents'), { recursive: true });
    installCommand(fixture, 'flowcrew');
    const before = projectSnapshot(fixture.project);

    const result = runCli(fixture, ['doctor']);
    const output = `${result.stdout}${result.stderr}`;

    expect(existsSync(join(fixture.bin, 'which'))).toBe(false);
    expect(projectSnapshot(fixture.project)).toEqual(before);
    expect(output).toContain('flowcrew CLI: PATH points to a different install');
    expect(output).not.toContain('flowcrew CLI: not found on PATH');
    expect(output).toContain('Process supervision: portable Node shim');
    expect(output).not.toMatch(/✅\s+flowcrew CLI:/);
  });

  it('recognizes this linked CLI without an external which command', () => {
    const fixture = cliFixture();
    writeAdapterConfig(fixture, 'auto');
    mkdirSync(join(fixture.project, 'config', 'agents'), { recursive: true });
    symlinkSync(join(repositoryRoot, 'dist', 'cli.js'), join(fixture.bin, 'flowcrew'));

    const result = runCli(fixture, ['doctor']);
    const output = `${result.stdout}${result.stderr}`;

    expect(existsSync(join(fixture.bin, 'which'))).toBe(false);
    expect(output).toContain('flowcrew CLI: This install is available on PATH');
    expect(output).not.toContain('flowcrew CLI: not found on PATH');
    expect(output).toContain('Process supervision: portable Node shim');
  });

  it('reports adapter state read-only, then writes only on an explicit valid set command', () => {
    const fixture = cliFixture();
    const defaultsPath = writeAdapterConfig(fixture, 'auto');
    installCommand(fixture, 'claude');

    const before = readFileSync(defaultsPath, 'utf-8');
    const readOnly = runCli(fixture, ['adapter']);
    expect(readOnly.status).toBe(0);
    expect(readOnly.stdout).toContain('Current adapter: auto');
    expect(readOnly.stdout).toContain('Installed adapters: claude');
    expect(readOnly.stdout).toContain('Recommended adapter: codex');
    expect(readFileSync(defaultsPath, 'utf-8')).toBe(before);

    const write = runCli(fixture, ['adapter', 'claude']);
    expect(write.status).toBe(0);
    expect(write.stdout).toContain('Adapter set to claude');
    expect((parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>).adapter).toBe('claude');

    const readBack = runCli(fixture, ['adapter']);
    expect(readBack.stdout).toContain('Current adapter: claude');
  });

  it('initializes to auto without an installed CLI and to recommended codex non-interactively when both exist', () => {
    const empty = cliFixture();
    const emptyResult = runCli(empty, ['init']);
    expect(emptyResult.status).toBe(0);
    expect(emptyResult.stdout).toContain('keeping adapter: auto');
    expect((parseYaml(readFileSync(join(empty.project, 'config', 'defaults.yaml'), 'utf-8')) as Record<string, unknown>).adapter).toBe('auto');

    const both = cliFixture();
    installCommand(both, 'codex');
    installCommand(both, 'claude');
    const bothResult = runCli(both, ['init']);
    expect(bothResult.status).toBe(0);
    expect(bothResult.stdout).toContain('non-interactive init selected recommended execution backend codex');
    expect((parseYaml(readFileSync(join(both.project, 'config', 'defaults.yaml'), 'utf-8')) as Record<string, unknown>).adapter).toBe('codex');
  });

  it('prints the run failure reason and failed-stage error after the stage list', () => {
    const fixture = cliFixture();
    writeAdapterConfig(fixture, 'mock');
    const workflowDir = join(fixture.project, 'config', 'workflows');
    const agentsDir = join(fixture.project, 'config', 'agents');
    const mockDir = join(fixture.root, 'mock');
    for (const path of [workflowDir, agentsDir, mockDir]) mkdirSync(path, { recursive: true });
    writeFileSync(join(workflowDir, 'failure.yaml'), [
      'name: failure',
      'stages:',
      '  - id: work',
      '    role: worker',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(join(agentsDir, 'worker.yaml'), [
      'name: worker',
      'description: deterministic failure worker',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: run the fixture',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(join(mockDir, 'work.json'), JSON.stringify({
      output_text: 'fixture stage failure detail',
      exit_code: 1,
    }), 'utf-8');

    const result = runCli(fixture, [
      'quick', '--project', fixture.project, '--adapter', 'mock', '--workflow', 'failure',
      '--no-supervise', '--no-campaign', '--task', structuredBrief(),
    ], { MOCK_FIXTURE_DIR: mockDir });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('work: failed');
    expect(output).toContain('Failure reason:');
    expect(output).toContain('Failed stage work:');
  });

  it('makes malformed Reality-check YAML fail rehearsal while no heading remains admissible', () => {
    const fixture = cliFixture();
    const malformedPath = join(fixture.root, 'malformed.md');
    const absentPath = join(fixture.root, 'absent.md');
    writeFileSync(malformedPath, `${structuredBrief()}\n## Reality checks\nchecks:\n  - name: broken\n    type: file-exists-nonempty\n     params: { paths: [x] }\n`, 'utf-8');
    writeFileSync(absentPath, structuredBrief(), 'utf-8');

    const malformed = runCli(fixture, ['rehearse', malformedPath, '--static-only']);
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toContain('YAML parsing failed');
    expect(malformed.stdout).not.toContain('✅ Contract ready');

    const absent = runCli(fixture, ['rehearse', absentPath, '--static-only']);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toContain('✅ Contract ready');
  });
});
