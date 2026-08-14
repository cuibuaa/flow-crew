import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdShipSetupWithDeps,
  createGitWorktree,
  nodeShipSetupFileSystem,
  runShipSetup,
  type GitCommandRunner,
  type GitWorktreeCreator,
  type GitWorktreeRequest,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

interface Fixture {
  root: string;
  project: string;
  target: string;
  state: string;
  brief: string;
}

const IGNORED_MODULE_PATH = ['node_modules', 'revision-generator'].join('/');

let previousGlobalDir: string;
let fixture: Fixture;

beforeAll(() => {
  previousGlobalDir = fcGlobalDir();
});

beforeEach(() => {
  // Canonicalize the fixture root: on macOS the temp directory is reached through a
  // symlink (/var -> /private/var), so an uncanonicalized root makes every derived
  // path differ from what the code under test computes. Reproducible on Linux by
  // pointing TMPDIR at a symlink.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-ship-setup-')));
  fixture = {
    root,
    project: join(root, 'source-project'),
    target: join(root, 'target-worktree'),
    state: join(root, 'fc-state'),
    brief: join(root, 'source-project', 'brief.md'),
  };
  mkdirSync(fixture.project, { recursive: true });
  writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
    scripts: { build: 'compile', test: 'check', lint: 'style' },
    flowcrew: { testPopulation: { files: [] } },
  }), 'utf-8');
  writeFileSync(join(fixture.project, 'package-lock.json'), '{}', 'utf-8');
  writeFileSync(join(fixture.project, '.gitignore'), 'data/\nnode_modules/\n', 'utf-8');
  setFcGlobalDir(fixture.state);
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(previousGlobalDir);
});

function writeBrief(lines: string[]): void {
  writeFileSync(fixture.brief, lines.join('\n'), 'utf-8');
}

function setupArgs(extra: string[] = []): string[] {
  return [
    'ship-setup',
    '--brief', 'brief.md',
    '--project', fixture.project,
    '--target', fixture.target,
    '--base', 'release-base',
    '--branch', 'autonomous-result',
    ...extra,
  ];
}

function copyTracked(request: GitWorktreeRequest): void {
  mkdirSync(request.targetDir, { recursive: true });
  copyFileSync(join(request.projectDir, 'package.json'), join(request.targetDir, 'package.json'));
  copyFileSync(join(request.projectDir, 'package-lock.json'), join(request.targetDir, 'package-lock.json'));
}

function successfulGit(
  afterCreate?: (request: GitWorktreeRequest) => void,
): ReturnType<typeof vi.fn<GitWorktreeCreator>> {
  return vi.fn<GitWorktreeCreator>((request) => {
    copyTracked(request);
    afterCreate?.(request);
    return { exitCode: 0 };
  });
}

function validationRunner(testExit = 0): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => ({
    exitCode: request.role === 'test' ? testExit : 0,
    stdout: request.role === 'test' && testExit !== 0
      ? 'FAIL spec/existing.test.ts\nTests 1 failed'
      : `${request.role} passed`,
    durationMs: 4,
  }));
}

function testPopulationRunner(): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(request.cwd);
    return {
      exitCode: 0,
      stdout: JSON.stringify(files.sort().map((file) => ({ file }))),
      durationMs: 2,
    };
  });
}

function writePopulationFixture(): void {
  writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
    scripts: { build: 'compile', test: 'vitest run', lint: 'style' },
    devDependencies: { vitest: 'fixture' },
  }), 'utf-8');
  mkdirSync(join(fixture.project, 'spec'), { recursive: true });
  mkdirSync(join(fixture.project, 'checks', 'fixtures'), { recursive: true });
  writeFileSync(join(fixture.project, 'spec', 'public.test.ts'), 'export const publicTest = true;\n');
  writeFileSync(join(fixture.project, 'checks', 'fixtures', 'published.test.ts'), 'export const published = true;\n');
  writeFileSync(join(fixture.project, 'checks', 'private.test.ts'), 'export const privateTest = true;\n');
}

function copyPopulationTrackedFiles(request: GitWorktreeRequest): void {
  mkdirSync(join(request.targetDir, 'spec'), { recursive: true });
  mkdirSync(join(request.targetDir, 'checks', 'fixtures'), { recursive: true });
  copyFileSync(join(request.projectDir, 'spec', 'public.test.ts'), join(request.targetDir, 'spec', 'public.test.ts'));
  copyFileSync(
    join(request.projectDir, 'checks', 'fixtures', 'published.test.ts'),
    join(request.targetDir, 'checks', 'fixtures', 'published.test.ts'),
  );
}

function noReadyRecord(): boolean {
  const directory = join(fixture.state, 'ship-setups');
  return !existsSync(directory) || readdirSync(directory).length === 0;
}

describe('ship-setup fail-closed worktree transaction', () => {
  it('maps the exact declared base, branch, project, and target to one argv-safe Git command', async () => {
    const runner = vi.fn<GitCommandRunner>(() => ({ exitCode: 0 }));

    const response = await createGitWorktree({
      projectDir: fixture.project,
      targetDir: fixture.target,
      base: 'refs/tags/release-base',
      branch: 'autonomous-result',
    }, runner);

    expect(response).toEqual({ exitCode: 0 });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith({
      command: 'git',
      args: [
        'worktree', 'add', '-b', 'autonomous-result', '--', fixture.target, 'refs/tags/release-base',
      ],
      cwd: fixture.project,
    });
  });

  it('creates the exact base and branch, links only absent declared ignored inputs, rechecks them, and atomically records a delta baseline', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const prices = 'timestamp,price\n2022-01-01,10\n2022-01-03,12\n';
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), prices, 'utf-8');
    mkdirSync(join(fixture.project, 'node_modules', 'revision-generator'), { recursive: true });
    writeFileSync(join(fixture.project, 'node_modules', 'revision-generator', 'alpha.js'), 'export {};\n', 'utf-8');
    writeFileSync(join(fixture.project, 'node_modules', 'revision-generator', 'beta.js'), 'export {};\n', 'utf-8');
    const digest = createHash('sha256').update(prices).digest('hex');
    writeBrief([
      '# Inputs',
      '- Read `package.json`.',
      `- Read \`data/frozen.csv\`; it has 2 rows, spans 2022-01-01 .. 2022-01-03, sha256: ${digest}.`,
      `- Consume \`${IGNORED_MODULE_PATH}/\`; it contains 2 files.`,
      '# Deliverables',
      '- Write `docs/result.md`.',
    ]);
    const git = successfulGit();
    const runner = validationRunner(1);
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdShipSetupWithDeps(setupArgs(['--json']), {
      createWorktree: git,
      runValidationCommand: runner,
      timestamp: () => '2030-01-02T03:04:05.000Z',
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(git).toHaveBeenCalledWith({
      projectDir: fixture.project,
      targetDir: fixture.target,
      base: 'release-base',
      branch: 'autonomous-result',
    });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ role: 'build', command: 'npm', args: ['run', 'build'], cwd: fixture.target }),
      expect.objectContaining({ role: 'test', command: 'npm', args: ['run', 'test'], cwd: fixture.target }),
      expect.objectContaining({ role: 'lint', command: 'npm', args: ['run', 'lint'], cwd: fixture.target }),
    ]);

    const linkedFile = join(fixture.target, 'data', 'frozen.csv');
    const linkedDirectory = join(fixture.target, 'node_modules', 'revision-generator');
    expect(lstatSync(linkedFile).isSymbolicLink()).toBe(true);
    expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkedFile)).toBe(join(fixture.project, 'data', 'frozen.csv'));
    expect(readlinkSync(linkedDirectory)).toBe(join(fixture.project, 'node_modules', 'revision-generator'));
    expect(lstatSync(join(fixture.target, 'package.json')).isSymbolicLink()).toBe(false);

    const rendered = JSON.parse(stdout.value) as Record<string, any>;
    const recordPath = rendered.readyRecordPath as string;
    const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, any>;
    expect(record).toEqual(rendered);
    expect(record).toMatchObject({
      version: 1,
      ready: true,
      createdAt: '2030-01-02T03:04:05.000Z',
      projectDir: fixture.project,
      targetDir: fixture.target,
      base: 'release-base',
      branch: 'autonomous-result',
      links: [
        expect.objectContaining({ path: 'data/frozen.csv', type: 'file' }),
        expect.objectContaining({ path: IGNORED_MODULE_PATH, type: 'directory' }),
      ],
    });
    expect(record.sourceVerification.inputs).toHaveLength(3);
    expect(record.targetVerification.inputs).toHaveLength(3);
    expect(record.targetVerification.inputs.flatMap((input: any) => input.assertions)
      .every((assertion: any) => assertion.state === 'confirmed')).toBe(true);
    expect(record.validationBaseline.results).toContainEqual(expect.objectContaining({
      role: 'test', state: 'failed', exitCode: 1, failureCount: 1,
    }));
    expect(record.validationBaseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'test', rule: 'no_regression_from_baseline', baselineFailureCount: 1,
    }));
  });

  it('reaches READY for a Python worktree using pyproject-inferred validation argv', async () => {
    rmSync(join(fixture.project, 'package.json'));
    rmSync(join(fixture.project, 'package-lock.json'));
    const pyproject = [
      '[build-system]',
      'requires = ["setuptools"]',
      'build-backend = "setuptools.build_meta"',
      '[project]',
      'dependencies = ["pytest", "ruff"]',
      '[tool.pytest.ini_options]',
      'testpaths = ["checks"]',
      '[tool.ruff]',
      'line-length = 100',
    ].join('\n');
    writeFileSync(join(fixture.project, 'pyproject.toml'), pyproject, 'utf-8');
    writeBrief(['# Goal', 'Validate the Python project.']);
    const git = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      copyFileSync(join(request.projectDir, 'pyproject.toml'), join(request.targetDir, 'pyproject.toml'));
      return { exitCode: 0 };
    });
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: runner,
    });

    expect(report).toMatchObject({
      state: 'ready',
      validationBaseline: { discovery: { state: 'configured', missingRoles: [] } },
    });
    expect(runner.mock.calls.map(([request]) => [request.command, request.args])).toEqual([
      ['python', ['-m', 'pytest', '--collect-only', '-q']],
      ['python', ['-m', 'pytest', '--collect-only', '-q']],
      ['python', ['-m', 'build']],
      ['python', ['-m', 'pytest']],
      ['python', ['-m', 'ruff', 'check', '.']],
    ]);
    if (report.state !== 'ready') throw new Error('Python setup unexpectedly refused');
    expect(existsSync(report.readyRecordPath)).toBe(true);
  });

  it('measures a brief-declared pytest command, records provenance, and persists regression gates', async () => {
    rmSync(join(fixture.project, 'package.json'));
    rmSync(join(fixture.project, 'package-lock.json'));
    const declaredPython = '/opt/research-environment/bin/python';
    writeBrief([
      '---',
      'validation:',
      '  commands:',
      '    test:',
      `      command: ${declaredPython}`,
      '      args: [-m, pytest, --label, "literal; $(must-not-run)"]',
      '---',
      '# Goal',
      'Validate the research project without changing its configuration.',
    ]);
    const git = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      return { exitCode: 0 };
    });
    const baseline = validationRunner();
    const population = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: 'checks/test_research.py::test_population\n',
      durationMs: 3,
    }));

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: baseline,
      runTestCollectionCommand: population,
    });

    expect(report).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        method: {
          tool: 'pytest',
          evidencePath: `${fixture.brief}#validation.commands.test`,
        },
        source: { count: 1 },
        target: { count: 1 },
      },
      validationBaseline: {
        discovery: {
          state: 'partial',
          missingRoles: ['build', 'lint'],
          commands: [expect.objectContaining({
            role: 'test',
            command: declaredPython,
            args: ['-m', 'pytest', '--label', 'literal; $(must-not-run)'],
            evidencePath: `${fixture.brief}#validation.commands.test`,
            provenance: {
              source: 'brief',
              evidencePath: `${fixture.brief}#validation.commands.test`,
            },
          })],
        },
        results: [
          expect.objectContaining({ role: 'build', state: 'not_configured' }),
          expect.objectContaining({ role: 'test', state: 'passed' }),
          expect.objectContaining({ role: 'lint', state: 'not_configured' }),
        ],
        gateCriteria: expect.arrayContaining([
          expect.objectContaining({ role: 'test', rule: 'must_remain_green' }),
        ]),
      },
    });
    expect(population.mock.calls.map(([request]) => [request.command, request.args, request.cwd])).toEqual([
      [declaredPython, ['-m', 'pytest', '--label', 'literal; $(must-not-run)', '--collect-only', '-q'], fixture.project],
      [declaredPython, ['-m', 'pytest', '--label', 'literal; $(must-not-run)', '--collect-only', '-q'], fixture.target],
    ]);
    expect(baseline).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      command: declaredPython,
      args: ['-m', 'pytest', '--label', 'literal; $(must-not-run)'],
      cwd: fixture.target,
    }));
    if (report.state !== 'ready') throw new Error('declared-validation setup unexpectedly refused');
    const record = JSON.parse(readFileSync(report.readyRecordPath, 'utf-8')) as Record<string, any>;
    expect(record.validationBaseline.discovery.commands[0].provenance).toEqual({
      source: 'brief',
      evidencePath: `${fixture.brief}#validation.commands.test`,
    });
  });

  it('treats valid empty frontmatter as no validation declaration for a configured project', async () => {
    writeBrief(['---', '---', '# Goal', 'Validate the configured project.']);
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
    });

    expect(report).toMatchObject({
      state: 'ready',
      validationBaseline: {
        discovery: { state: 'configured', missingRoles: [] },
      },
    });
    expect(runner.mock.calls.map(([request]) => [request.command, request.args])).toEqual([
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test']],
      ['npm', ['run', 'lint']],
    ]);
  });

  it('refuses malformed and structurally invalid validation declarations before creating a worktree', async () => {
    const cases = [
      {
        name: 'malformed YAML',
        lines: ['---', 'validation: [', '---', '# Goal'],
        diagnostic: 'YAML',
      },
      {
        name: 'empty command map',
        lines: ['---', 'validation:', '  commands: {}', '---', '# Goal'],
        diagnostic: 'must declare at least one',
      },
      {
        name: 'unknown role',
        lines: ['---', 'validation:', '  commands:', '    deploy:', '      command: release', '      args: []', '---', '# Goal'],
        diagnostic: 'unknown role',
      },
      {
        name: 'unknown command field',
        lines: ['---', 'validation:', '  commands:', '    test:', '      command: check', '      args: []', '      shell: true', '---', '# Goal'],
        diagnostic: 'unknown field',
      },
      {
        name: 'missing argv array',
        lines: ['---', 'validation:', '  commands:', '    test:', '      command: check', '---', '# Goal'],
        diagnostic: 'args',
      },
      {
        name: 'control character',
        lines: ['---', 'validation:', '  commands:', '    test:', '      command: "check\\nother"', '      args: []', '---', '# Goal'],
        diagnostic: 'control character',
      },
      {
        name: 'C1 next-line control character',
        lines: ['---', 'validation:', '  commands:', '    test:', '      command: "check\\u0085other"', '      args: []', '---', '# Goal'],
        diagnostic: 'control character',
      },
    ];

    for (const scenario of cases) {
      writeBrief(scenario.lines);
      const git = successfulGit();
      const runner = validationRunner();
      const report = await runShipSetup(setupArgs(), {
        createWorktree: git,
        runValidationCommand: runner,
      });

      expect(report, scenario.name).toMatchObject({
        state: 'refused',
        worktreeCreated: false,
        blockers: [expect.objectContaining({
          phase: 'validation',
          reason: expect.stringContaining(scenario.diagnostic),
          repair: expect.stringMatching(/fix|correct|remove|declare/i),
        })],
      });
      expect(git, scenario.name).not.toHaveBeenCalled();
      expect(runner, scenario.name).not.toHaveBeenCalled();
      expect(noReadyRecord(), scenario.name).toBe(true);
    }
  });

  it('names a missing brief-declared command in its launch refusal and writes no ready record', async () => {
    rmSync(join(fixture.project, 'package.json'));
    rmSync(join(fixture.project, 'package-lock.json'));
    writeBrief([
      '---',
      'validation:',
      '  commands:',
      '    build:',
      '      command: executable-that-does-not-exist',
      '      args: [--verify]',
      '---',
      '# Goal',
      'Measure the declared build.',
    ]);
    const git = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      return { exitCode: 0 };
    });
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: null, error: 'spawn ENOENT' }));

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: runner,
    });

    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      role: 'build', command: 'executable-that-does-not-exist', args: ['--verify'], cwd: fixture.target,
    }));
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: {
        discovery: {
          state: 'partial',
          commands: [expect.objectContaining({
            provenance: {
              source: 'brief',
              evidencePath: `${fixture.brief}#validation.commands.build`,
            },
          })],
        },
      },
      blockers: [expect.objectContaining({
        phase: 'validation',
        reason: expect.stringContaining(`${fixture.brief}#validation.commands.build`),
        repair: expect.stringMatching(/install|correct|declare|run/i),
      })],
    });
    expect(report.blockers[0].reason).toContain('executable-that-does-not-exist --verify');
    expect(report.blockers[0].reason).toContain('spawn ENOENT');
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses disagreement between project and brief commands without measuring either baseline', async () => {
    writeBrief([
      '---',
      'validation:',
      '  commands:',
      '    test:',
      '      command: /opt/project-environment/bin/python',
      '      args: [-m, pytest]',
      '---',
      '# Goal',
      'Validate the project.',
    ]);
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: { discovery: { state: 'unknown', commands: [] } },
      blockers: [expect.objectContaining({
        phase: 'validation',
        reason: expect.stringContaining('conflict'),
      })],
    });
    expect(report.blockers[0].reason).toContain(join(fixture.target, 'package.json'));
    expect(report.blockers[0].reason).toContain(`${fixture.brief}#validation.commands.test`);
    expect(noReadyRecord()).toBe(true);
  });

  it('records exact project/brief agreement as corroboration without changing the project-governed baseline', async () => {
    writeBrief([
      '---',
      'validation:',
      '  commands:',
      '    test:',
      '      command: npm',
      '      args: [run, test]',
      '---',
      '# Goal',
      'Validate the project.',
    ]);
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
    });

    expect(report).toMatchObject({
      state: 'ready',
      validationBaseline: {
        discovery: {
          state: 'configured',
          commands: expect.arrayContaining([expect.objectContaining({
            role: 'test',
            command: 'npm',
            args: ['run', 'test'],
            evidencePath: join(fixture.target, 'package.json'),
            provenance: {
              source: 'project',
              evidencePath: join(fixture.target, 'package.json'),
              corroboratedBy: [`${fixture.brief}#validation.commands.test`],
            },
          })]),
        },
      },
    });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.map(([request]) => [request.command, request.args])).toEqual([
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test']],
      ['npm', ['run', 'lint']],
    ]);
  });

  it('refuses UNKNOWN validation before READY when no command can be inferred', async () => {
    writeBrief(['# Goal', 'Validate the repository.']);
    const git = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      return { exitCode: 0 };
    });
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: {
        discovery: { state: 'unknown', commands: [] },
        results: [
          expect.objectContaining({ role: 'build', state: 'unresolved' }),
          expect.objectContaining({ role: 'test', state: 'unresolved' }),
          expect.objectContaining({ role: 'lint', state: 'unresolved' }),
        ],
      },
      blockers: [expect.objectContaining({
        phase: 'validation', reason: expect.stringContaining('Validation baseline is unknown'),
      })],
    });
    expect(noReadyRecord()).toBe(true);
  });

  it('defaults the source project to the injected current directory and reports human-readable delta criteria', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    const git = successfulGit();
    const stdout = new Capture();

    const code = await cmdShipSetupWithDeps([
      'ship-setup',
      '--brief', 'brief.md',
      '--target', '../target-worktree',
      '--base', 'HEAD',
      '--branch', 'default-project-result',
    ], {
      cwd: fixture.project,
      createWorktree: git,
      runValidationCommand: validationRunner(),
      stdout: stdout.writer,
      stderr: new Capture().writer,
    });

    expect(code).toBe(0);
    expect(git).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: fixture.project,
      targetDir: fixture.target,
      base: 'HEAD',
      branch: 'default-project-result',
    }));
    expect(stdout.value).toContain('Ship setup: READY');
    expect(stdout.value).toContain('gate build: must_remain_green');
    expect(stdout.value).toContain('gate test: must_remain_green');
    expect(noReadyRecord()).toBe(false);
  });

  it('refuses a missing declared source input before creating a worktree or running validation', async () => {
    writeBrief(['# Inputs', '- Read `data/missing.csv`; it has 2 rows.']);
    const git = vi.fn<GitWorktreeCreator>();
    const runner = validationRunner();
    const stderr = new Capture();

    const code = await cmdShipSetupWithDeps(setupArgs(['--json']), {
      createWorktree: git,
      runValidationCommand: runner,
      stdout: new Capture().writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(1);
    expect(git).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
    const report = JSON.parse(stderr.value) as Record<string, any>;
    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ phase: 'source', input: 'data/missing.csv' }),
      ]),
    });
  });

  it('refuses a refuted source property before Git and accepts the same input when its property is true', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'rows.csv'), 'id\n1\n2\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/rows.csv`; it has 3 rows.']);
    const git = successfulGit();

    const refuted = await runShipSetup(setupArgs(), { createWorktree: git, runValidationCommand: validationRunner() });

    expect(refuted).toMatchObject({
      state: 'refused',
      worktreeCreated: false,
      blockers: [expect.objectContaining({
        phase: 'source', input: 'data/rows.csv', assertion: 'row_count', reason: expect.stringContaining('refuted'),
      })],
    });
    expect(git).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);

    writeBrief(['# Inputs', '- Read `data/rows.csv`; it has 2 rows.']);
    const acceptedGit = successfulGit();
    const accepted = await runShipSetup(setupArgs(), {
      createWorktree: acceptedGit,
      runValidationCommand: validationRunner(),
    });
    expect(accepted.state).toBe('ready');
    expect(acceptedGit).toHaveBeenCalledTimes(1);
  });

  it('refuses an asserted property that is not mechanically checkable and does not reinterpret it as success', async () => {
    writeFileSync(
      join(fixture.project, 'ambiguous.csv'),
      'start_date,end_date\n2022-01-01,2022-01-03\n',
      'utf-8',
    );
    writeBrief(['# Inputs', '- Read `ambiguous.csv`; it spans 2022-01-01 .. 2022-01-03.']);
    const git = successfulGit();

    const report = await runShipSetup(setupArgs(), { createWorktree: git });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'source',
        input: 'ambiguous.csv',
        assertion: 'time_span',
        reason: expect.stringContaining('not_checkable'),
      })],
    });
    expect(git).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses unreadable source evidence through the injected filesystem seam', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const input = join(fixture.project, 'data', 'locked.csv');
    writeFileSync(input, 'id\n1\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/locked.csv`.']);
    const git = successfulGit();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      fs: {
        ...nodeShipSetupFileSystem,
        readable: (path) => path !== input && nodeShipSetupFileSystem.readable(path),
      },
    });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({ phase: 'source', input: 'data/locked.csv', reason: expect.stringContaining('not readable') })],
    });
    expect(git).not.toHaveBeenCalled();
  });

  it('refuses when an ignored input cannot be linked, and never runs or records the baseline', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/frozen.csv`; it has 1 row.']);
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
      fs: {
        ...nodeShipSetupFileSystem,
        createLink: () => { throw new Error('link denied by fixture'); },
      },
    });

    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      blockers: [expect.objectContaining({
        phase: 'target', input: 'data/frozen.csv', reason: expect.stringContaining('link denied by fixture'),
      })],
    });
    expect(runner).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('re-verifies properties through the target and refuses a changed linked input', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n2\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/frozen.csv`; it has 2 rows.']);
    const createLink = vi.fn((_: string, target: string) => {
      writeFileSync(target, 'id\n1\n', 'utf-8');
    });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
      fs: { ...nodeShipSetupFileSystem, createLink },
    });

    expect(createLink).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      blockers: [expect.objectContaining({
        phase: 'target', input: 'data/frozen.csv', assertion: 'row_count', reason: expect.stringContaining('refuted'),
      })],
    });
    expect(noReadyRecord()).toBe(true);
  });

  it('does not overwrite an existing target or an existing tracked input', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    mkdirSync(fixture.target, { recursive: true });
    const sentinel = join(fixture.target, 'keep.txt');
    writeFileSync(sentinel, 'preserve me', 'utf-8');
    const git = successfulGit();

    const collision = await runShipSetup(setupArgs(), { createWorktree: git });

    expect(collision).toMatchObject({
      state: 'refused',
      worktreeCreated: false,
      blockers: [expect.objectContaining({ phase: 'worktree', reason: expect.stringContaining('already exists') })],
    });
    expect(git).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, 'utf-8')).toBe('preserve me');
    rmSync(fixture.target, { recursive: true, force: true });

    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'tracked.csv'), 'id\n1\n2\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/tracked.csv`; it has 2 rows.']);
    const createLink = vi.fn(nodeShipSetupFileSystem.createLink);
    const trackedGit = successfulGit((request) => {
      mkdirSync(join(request.targetDir, 'data'), { recursive: true });
      writeFileSync(join(request.targetDir, 'data', 'tracked.csv'), 'id\n1\n', 'utf-8');
    });
    const tracked = await runShipSetup(setupArgs(), {
      createWorktree: trackedGit,
      fs: { ...nodeShipSetupFileSystem, createLink },
    });

    expect(tracked.state).toBe('refused');
    expect(createLink).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.target, 'data', 'tracked.csv'), 'utf-8')).toBe('id\n1\n');
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses Git failure and a false Git success without leaving a ready record', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    const failedGit = vi.fn<GitWorktreeCreator>(() => ({ exitCode: 128, stderr: 'unknown base' }));

    const failed = await runShipSetup(setupArgs(), { createWorktree: failedGit });

    expect(failed).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({ phase: 'worktree', reason: expect.stringContaining('unknown base') })],
    });
    expect(noReadyRecord()).toBe(true);

    const falseSuccess = vi.fn<GitWorktreeCreator>(() => ({ exitCode: 0 }));
    const absent = await runShipSetup(setupArgs(), { createWorktree: falseSuccess });
    expect(absent).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      blockers: [expect.objectContaining({ phase: 'worktree', reason: expect.stringContaining('not reachable') })],
    });
    expect(noReadyRecord()).toBe(true);
  });

  it('blocks a target parent that canonicalizes outside the worktree', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n', 'utf-8');
    writeBrief(['# Inputs', '- Read `data/frozen.csv`; it has 1 row.']);
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside, { recursive: true });
    const git = successfulGit((request) => {
      symlinkSync(outside, join(request.targetDir, 'data'), 'dir');
    });

    const report = await runShipSetup(setupArgs(), { createWorktree: git });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'target', input: 'data/frozen.csv', reason: expect.stringContaining('outside the worktree'),
      })],
    });
    expect(existsSync(join(outside, 'frozen.csv'))).toBe(false);
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses an atomic ready-record failure after baseline capture', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    const runner = validationRunner();
    const writeAtomic = vi.fn(() => { throw new Error('state volume unavailable'); });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
      fs: { ...nodeShipSetupFileSystem, writeAtomic },
    });

    expect(runner).toHaveBeenCalledTimes(3);
    expect(writeAtomic).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: { version: 1 },
      blockers: [expect.objectContaining({ phase: 'record', reason: expect.stringContaining('state volume unavailable') })],
    });
    expect(noReadyRecord()).toBe(true);
    expect(report.blockers[0].repair).toMatch(/restore|choose|retry|writable/i);
  });

  it('refuses validation launch errors after capture without writing a ready record', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    const runner = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: null,
      error: 'validation runner unavailable',
    }));

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
    });

    expect(runner).toHaveBeenCalledTimes(3);
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: {
        results: expect.arrayContaining([
          expect.objectContaining({ role: 'build', state: 'launch_error' }),
          expect.objectContaining({ role: 'test', state: 'launch_error' }),
          expect.objectContaining({ role: 'lint', state: 'launch_error' }),
        ]),
      },
      blockers: [
        expect.objectContaining({ phase: 'validation', reason: expect.stringContaining('build baseline') }),
        expect.objectContaining({ phase: 'validation', reason: expect.stringContaining('test baseline') }),
        expect.objectContaining({ phase: 'validation', reason: expect.stringContaining('lint baseline') }),
      ],
    });
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses an all-role exit-127 baseline in the verdict line and writes no ready record', async () => {
    writeBrief(['# Inputs', '- Read `package.json`.']);
    const runner = vi.fn<ValidationCommandRunner>(({ role }) => ({
      exitCode: 127,
      stderr: `sh: ${role}-tool: command not found`,
    }));
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdShipSetupWithDeps(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    expect(stderr.value.split('\n')[0]).toBe('Ship setup: REFUSED');
    expect(stderr.value).toContain('REFUSED [validation]');
    expect(stderr.value).toContain('exit 127');
    expect(noReadyRecord()).toBe(true);
  });

  it('links a bare directory named in the explicit inputs list', async () => {
    mkdirSync(join(fixture.project, 'dependency_cache'), { recursive: true });
    writeFileSync(join(fixture.project, 'dependency_cache', 'tool.js'), 'export {};\n', 'utf-8');
    writeBrief([
      '---',
      'inputs:',
      '  - package.json',
      '  - dependency_cache',
      '---',
      '# Goal',
      'Use the declared inputs.',
    ]);

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
    });

    expect(report.state).toBe('ready');
    expect(report.links).toContainEqual(expect.objectContaining({
      path: 'dependency_cache', type: 'directory',
    }));
    expect(lstatSync(join(fixture.target, 'dependency_cache')).isSymbolicLink()).toBe(true);
  });

  it('reconciles missing descendants when a declared directory already has tracked target content', async () => {
    writePopulationFixture();
    writeBrief([
      '---',
      'inputs:',
      '  - checks',
      '---',
      '# Goal',
      'Run the complete configured test population.',
    ]);
    const baseline = validationRunner();
    const population = testPopulationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(copyPopulationTrackedFiles),
      runValidationCommand: baseline,
      runTestCollectionCommand: population,
    });

    expect(report.state).toBe('ready');
    expect(report.copies).toContainEqual(expect.objectContaining({
      path: 'checks/private.test.ts',
    }));
    expect(lstatSync(join(fixture.target, 'checks', 'private.test.ts')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(fixture.target, 'checks', 'private.test.ts'), 'utf-8'))
      .toBe(readFileSync(join(fixture.project, 'checks', 'private.test.ts'), 'utf-8'));
    writeFileSync(join(fixture.target, 'checks', 'private.test.ts'), 'target-only edit\n');
    expect(readFileSync(join(fixture.project, 'checks', 'private.test.ts'), 'utf-8'))
      .toContain('privateTest = true');
    expect(report.testPopulation).toMatchObject({
      state: 'matched',
      source: { count: 3 },
      target: { count: 3 },
      missingFromTarget: [],
      extraInTarget: [],
    });
    expect(population).toHaveBeenCalledTimes(2);
    expect(baseline).toHaveBeenCalledTimes(3);
  });

  it('refuses a smaller target test population before baseline when the ignored input was omitted', async () => {
    writePopulationFixture();
    writeBrief(['# Goal', 'Run the complete configured test population.']);
    const baseline = validationRunner();
    const population = testPopulationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(copyPopulationTrackedFiles),
      runValidationCommand: baseline,
      runTestCollectionCommand: population,
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        source: { count: 3 },
        target: { count: 2 },
        missingFromTarget: ['checks/private.test.ts'],
        extraInTarget: [],
      },
      blockers: [expect.objectContaining({
        phase: 'validation',
        reason: expect.stringContaining('checks/private.test.ts'),
      })],
    });
    expect(population).toHaveBeenCalledTimes(2);
    expect(baseline).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('refuses a content collision inside a declared directory without overwriting the target', async () => {
    writePopulationFixture();
    writeBrief([
      '---',
      'inputs:',
      '  - checks',
      '---',
      '# Goal',
      'Run the complete configured test population.',
    ]);
    const baseline = validationRunner();
    const git = successfulGit((request) => {
      copyPopulationTrackedFiles(request);
      writeFileSync(
        join(request.targetDir, 'checks', 'fixtures', 'published.test.ts'),
        'export const published = false;\n',
      );
    });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: baseline,
      runTestCollectionCommand: testPopulationRunner(),
    });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'target',
        input: 'checks/fixtures/published.test.ts',
        reason: expect.stringContaining('content collision'),
      })],
    });
    expect(readFileSync(join(fixture.target, 'checks', 'fixtures', 'published.test.ts'), 'utf-8'))
      .toContain('false');
    expect(baseline).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('reports and refuses an invalid explicit input instead of dropping it', async () => {
    writeBrief([
      '---',
      'inputs:',
      '  - ../outside-cache',
      '---',
      '# Goal',
      'Use the declared input.',
    ]);
    const git = successfulGit();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: validationRunner(),
    });

    expect(report).toMatchObject({
      state: 'refused',
      sourceVerification: {
        unresolvedInputs: [expect.objectContaining({ value: '../outside-cache', line: 3 })],
      },
      blockers: [expect.objectContaining({
        phase: 'source', input: '../outside-cache', reason: expect.stringContaining('Unresolved explicit input'),
        repair: expect.stringMatching(/declare|remove|correct/i),
      })],
    });
    expect(git).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);

    const stdout = new Capture();
    const stderr = new Capture();
    const code = await cmdShipSetupWithDeps(setupArgs(), {
      createWorktree: git,
      runValidationCommand: validationRunner(),
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    expect(stderr.value).toContain('UNRESOLVED DECLARED "../outside-cache" at line 3');
    expect(stderr.value).toContain('REFUSED [source] ../outside-cache');
  });

  it('binds ready records to the exact brief bytes as well as the target identity', async () => {
    const firstBrief = '# Goal\nMeasure the first brief.\n';
    writeFileSync(fixture.brief, firstBrief, 'utf-8');
    const first = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
    });
    expect(first.state).toBe('ready');
    if (first.state !== 'ready') throw new Error('first setup unexpectedly refused');

    rmSync(fixture.target, { recursive: true, force: true });
    const secondBrief = '# Goal\nMeasure a substantively different second brief.\n';
    writeFileSync(fixture.brief, secondBrief, 'utf-8');
    const second = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
    });
    expect(second.state).toBe('ready');
    if (second.state !== 'ready') throw new Error('second setup unexpectedly refused');

    expect(first.briefDigest).toBe(createHash('sha256').update(firstBrief).digest('hex'));
    expect(second.briefDigest).toBe(createHash('sha256').update(secondBrief).digest('hex'));
    expect(second.briefDigest).not.toBe(first.briefDigest);
    expect(second.readyRecordPath).not.toBe(first.readyRecordPath);
    expect(existsSync(first.readyRecordPath)).toBe(true);
    expect(existsSync(second.readyRecordPath)).toBe(true);
    expect(JSON.parse(readFileSync(first.readyRecordPath, 'utf-8')).briefDigest).toBe(first.briefDigest);
    expect(JSON.parse(readFileSync(second.readyRecordPath, 'utf-8')).briefDigest).toBe(second.briefDigest);
  });

  it('validates required and duplicate CLI options while help remains non-mutating', async () => {
    const git = vi.fn<GitWorktreeCreator>();
    const helpOut = new Capture();
    const helpErr = new Capture();
    const help = await cmdShipSetupWithDeps(['ship-setup', '--help'], {
      createWorktree: git,
      stdout: helpOut.writer,
      stderr: helpErr.writer,
    });
    expect(help).toBe(0);
    expect(helpOut.value).toContain('Usage: flowcrew ship-setup');
    expect(helpErr.value).toBe('');

    const missingErr = new Capture();
    const missing = await cmdShipSetupWithDeps(['ship-setup', '--brief', 'brief.md'], {
      createWorktree: git,
      stderr: missingErr.writer,
    });
    expect(missing).toBe(1);
    expect(missingErr.value).toContain('--target is required');

    const duplicateErr = new Capture();
    const duplicate = await cmdShipSetupWithDeps([...setupArgs(), '--base', 'other'], {
      createWorktree: git,
      stderr: duplicateErr.writer,
    });
    expect(duplicate).toBe(1);
    expect(duplicateErr.value).toContain('--base may be specified only once');
    expect(git).not.toHaveBeenCalled();
  });
});
