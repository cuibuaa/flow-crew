import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdLandWithDeps,
  createLandOutputCapture,
  parseGitStatusPorcelain,
  runLand,
  type LandGitRequest,
  type LandGitResponse,
  type LandGitRunner,
} from '../src/cli-land.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

interface Fixture {
  root: string;
  state: string;
  runDir: string;
  project: string;
  primary: string;
  runId: string;
}

const BASE = 'a'.repeat(40);
const LOCAL_COMMIT = 'b'.repeat(40);
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-land-')));
  const state = join(root, 'state');
  const runId = 'fixture-run';
  fixture = {
    root,
    state,
    runId,
    runDir: join(state, 'runs', runId),
    project: join(root, 'topic-worktree'),
    primary: join(root, 'primary-worktree'),
  };
  mkdirSync(fixture.runDir, { recursive: true });
  mkdirSync(join(fixture.project, 'docs'), { recursive: true });
  mkdirSync(fixture.primary, { recursive: true });
  writeState();
  writeFileSync(join(fixture.project, 'docs', 'result.md'), '# Result\n', 'utf-8');
  setFcGlobalDir(state);
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(previousGlobalDir);
});

function writeState(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(fixture.runDir, 'run.json'), JSON.stringify({
    runId: fixture.runId,
    workflowName: 'fixture',
    projectDir: fixture.project,
    baseCommit: BASE,
    status: 'complete',
    stages: {},
    startedAt: '2030-01-01T00:00:00.000Z',
    completedAt: '2030-01-01T00:01:00.000Z',
    terminalStates: { complete: { paths: ['docs/result.md'] } },
    ...overrides,
  }, null, 2), 'utf-8');
}

function writeProjectFile(path: string, contents = 'fixture\n'): void {
  const absolute = join(fixture.project, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf-8');
}

function gitRunner(
  responses: Partial<Record<LandGitRequest['operation'], LandGitResponse>> = {},
): ReturnType<typeof vi.fn<LandGitRunner>> {
  return vi.fn<LandGitRunner>((request) => responses[request.operation]
    ?? (request.operation === 'branch'
      ? { exitCode: 0, stdout: 'topic-work\n' }
      : { exitCode: 0, stdout: '' }));
}

function cleanRemovalResponses(): Partial<Record<LandGitRequest['operation'], LandGitResponse>> {
  return {
    status: { exitCode: 0, stdout: '' },
    ignored: { exitCode: 0, stdout: '' },
    unpushed: { exitCode: 0, stdout: '' },
    root: { exitCode: 0, stdout: `${fixture.project}\n` },
    worktrees: {
      exitCode: 0,
      stdout: [
        `worktree ${fixture.primary}`,
        `HEAD ${BASE}`,
        'branch refs/heads/main',
        '',
        `worktree ${fixture.project}`,
        `HEAD ${LOCAL_COMMIT}`,
        'branch refs/heads/topic-work',
        '',
      ].join('\n'),
    },
    branch: { exitCode: 0, stdout: 'topic-work\n' },
    remove_worktree: { exitCode: 0 },
    prune_worktrees: { exitCode: 0 },
    delete_branch: { exitCode: 0 },
  };
}

function destructiveOperations(runner: ReturnType<typeof vi.fn<LandGitRunner>>): string[] {
  return runner.mock.calls
    .map(([request]) => request.operation)
    .filter((operation) => ['remove_worktree', 'prune_worktrees', 'delete_branch'].includes(operation));
}

describe('flowcrew land inventory and refusal boundary', () => {
  it('reports the terminal status and conservatively grades every raw unique-state path', async () => {
    writeProjectFile('loose.txt');
    writeProjectFile('cache/generator.ts', 'export const retained = true;\n');
    writeProjectFile('evidence/frozen.parquet');
    const runner = gitRunner({
      status: { exitCode: 0, stdout: [' M tracked.ts', '?? loose.txt', ''].join('\0') },
      ignored: { exitCode: 0, stdout: ['evidence/frozen.parquet', 'cache/generator.ts', ''].join('\0') },
      unpushed: { exitCode: 0, stdout: `${LOCAL_COMMIT}\n` },
    });

    const report = await runLand(['land', '--run', fixture.runId], { git: runner });

    expect(report).toMatchObject({
      state: 'audit',
      status: 'complete',
      terminal: true,
      readyForRemoval: false,
      artifacts: [{ path: 'docs/result.md', projectPresent: true, snapshotPresent: false, present: true }],
      inventory: {
        tracked: [{ code: ' M', path: 'tracked.ts' }],
        enumerated: [
          { origin: 'ignored', path: 'cache/generator.ts', grade: 'source', kind: 'file' },
          { origin: 'ignored', path: 'evidence/frozen.parquet', grade: 'data_or_state', kind: 'file' },
          { origin: 'untracked', path: 'loose.txt', grade: 'unknown', kind: 'file' },
        ],
        gradeCounts: {
          source: 1,
          data_or_state: 1,
          symlink: 0,
          unknown: 1,
          build_output: 0,
          installed_dependency: 0,
        },
        rawPathCounts: { untracked: 1, ignored: 2 },
        unpushedCommits: [LOCAL_COMMIT],
      },
    });
    expect(report.refusalReasons).toEqual(expect.arrayContaining([
      '1 tracked worktree change remains',
    ]));
    expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['rev-list', '--reverse', `${BASE}..HEAD`, '--not', '--remotes'],
      [
        'rev-list', '--reverse', `${BASE}..HEAD`, '--not',
        '--exclude=refs/heads/topic-work', '--all',
      ],
    ]);
  });

  it('refuses removal non-zero for ordinary and ignored unique files before any destructive call', async () => {
    writeProjectFile('unarchived-generator.ts', 'export function generate() {}\n');
    writeProjectFile('evidence/frozen.parquet');
    const runner = gitRunner({
      status: { exitCode: 0, stdout: ['?? unarchived-generator.ts', ''].join('\0') },
      ignored: { exitCode: 0, stdout: ['evidence/frozen.parquet', ''].join('\0') },
      unpushed: { exitCode: 0, stdout: '' },
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdLandWithDeps(['land', '--run', fixture.runId, '--remove'], {
      git: runner,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    expect(stderr.value).toContain('UNTRACKED SOURCE FILE "unarchived-generator.ts"');
    expect(stderr.value).toContain('IGNORED DATA_OR_STATE FILE "evidence/frozen.parquet"');
    expect(stderr.value).toContain('REFUSED 1 untracked ungraded path remains');
    expect(stderr.value).toContain('REFUSED 1 ignored ungraded path remains');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('counts proven build and dependency outputs while naming source, state, unknown, and symlink items', async () => {
    const buildOutputs: string[] = [];
    const dependencyRoot = ['node', '_modules'].join('');
    for (let index = 0; index < 12; index += 1) {
      writeProjectFile(`src/generated-${index}.ts`, `export const value${index} = ${index};\n`);
      writeProjectFile(`dist/generated-${index}.js`, `export const value${index} = ${index};\n`);
      buildOutputs.push(`dist/generated-${index}.js`);
    }
    writeProjectFile('ui/vite.config.ts', 'export default {};\n');
    writeProjectFile('ui/index.html', '<main></main>\n');
    writeProjectFile('ui/public/favicon.svg', '<svg/>\n');
    for (const output of [
      'ui/dist/assets/index-AbCd1234.js',
      'ui/dist/assets/index-EfGh5678.css',
      'ui/dist/index.html',
      'ui/dist/favicon.svg',
      'ui/tailwind.config.d.ts.map',
      'ui/vite.config.d.ts.map',
      'ui/tsconfig.tsbuildinfo',
      'ui/tsconfig.node.tsbuildinfo',
    ]) {
      const contents = output === 'ui/dist/index.html'
        ? '<main></main>\n'
        : output === 'ui/dist/favicon.svg' ? '<svg/>\n' : 'fixture\n';
      writeProjectFile(output, contents);
      buildOutputs.push(output);
    }
    writeProjectFile(`${dependencyRoot}/pkg/index.js`);
    writeProjectFile('src/new-tool.ts', 'export const unique = true;\n');
    writeProjectFile('dist/generator.ts', 'export const uniqueGenerator = true;\n');
    writeProjectFile('.fc/campaigns/events.jsonl', '{"event":"retained"}\n');
    writeProjectFile('mystery/blob.bin');
    mkdirSync(join(fixture.project, 'links'), { recursive: true });
    symlinkSync('../.fc/campaigns/events.jsonl', join(fixture.project, 'links', 'latest'));
    const runner = gitRunner({
      status: {
        exitCode: 0,
        stdout: [
          '?? src/new-tool.ts',
          '?? links/latest',
          '',
        ].join('\0'),
      },
      ignored: {
        exitCode: 0,
        stdout: [
          ...buildOutputs,
          `${dependencyRoot}/pkg/index.js`,
          'dist/generator.ts',
          '.fc/campaigns/events.jsonl',
          'mystery/blob.bin',
          '',
        ].join('\0'),
      },
    });
    const stdout = new Capture();

    const code = await cmdLandWithDeps(['land', '--run', fixture.runId], {
      git: runner,
      stdout: stdout.writer,
    });
    const report = await runLand(['land', '--run', fixture.runId], { git: runner });

    expect(code).toBe(0);
    expect(report.inventory.gradeCounts).toEqual({
      source: 2,
      data_or_state: 1,
      symlink: 1,
      unknown: 5,
      build_output: 16,
      installed_dependency: 1,
    });
    expect(report.inventory.regenerable.buildOutputs).toEqual({
      grade: 'build_output', count: 16, origins: { untracked: 0, ignored: 16 },
    });
    expect(report.inventory.regenerable.installedDependencies).toEqual({
      grade: 'installed_dependency', count: 1, origins: { untracked: 0, ignored: 1 },
    });
    expect(report.inventory.enumerated).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dist/generator.ts', grade: 'source' }),
      expect.objectContaining({ path: 'src/new-tool.ts', grade: 'source' }),
      expect.objectContaining({ path: '.fc/campaigns/events.jsonl', grade: 'data_or_state' }),
      expect.objectContaining({ path: 'mystery/blob.bin', grade: 'unknown' }),
      expect.objectContaining({
        path: 'links/latest', grade: 'symlink', kind: 'symlink', linkTarget: '../.fc/campaigns/events.jsonl',
      }),
    ]));
    expect(stdout.value).toContain('REGENERABLE BUILD_OUTPUT 16 item(s)');
    expect(stdout.value).toContain('UNTRACKED SYMLINK "links/latest" -> "../.fc/campaigns/events.jsonl"');
    expect(stdout.value).not.toContain('dist/generated-0.js');
    expect(stdout.value).not.toContain('ui/dist/assets/index-AbCd1234.js');
  });

  it('requires the exact regenerable count and never lets that acknowledgement cover an ungraded path', async () => {
    writeProjectFile('src/generated.ts', 'export const generated = true;\n');
    writeProjectFile('dist/generated.js', 'export const generated = true;\n');
    const responses = {
      ...cleanRemovalResponses(),
      ignored: { exitCode: 0, stdout: ['dist/generated.js', ''].join('\0') },
    };

    const absentRunner = gitRunner(responses);
    const absent = await runLand(['land', '--run', fixture.runId, '--remove'], { git: absentRunner });
    expect(absent).toMatchObject({
      state: 'refused',
      removalAcknowledgement: { expectedRegenerableCount: 1, matches: false },
    });
    expect(absent.refusalReasons).toContain('regenerable-path acknowledgement is required: expected 1');
    expect(destructiveOperations(absentRunner)).toEqual([]);

    const wrongRunner = gitRunner(responses);
    const wrong = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=2',
    ], { git: wrongRunner });
    expect(wrong).toMatchObject({
      state: 'refused',
      removalAcknowledgement: { expectedRegenerableCount: 1, suppliedRegenerableCount: 2, matches: false },
    });
    expect(wrong.refusalReasons).toContain('regenerable-path acknowledgement mismatch: received 2, expected 1');
    expect(destructiveOperations(wrongRunner)).toEqual([]);

    const exactRunner = gitRunner(responses);
    const exact = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=1',
    ], { git: exactRunner });
    expect(exact).toMatchObject({
      state: 'removed',
      removalAcknowledgement: { expectedRegenerableCount: 1, suppliedRegenerableCount: 1, matches: true },
    });
    expect(destructiveOperations(exactRunner)).toEqual(['remove_worktree', 'prune_worktrees', 'delete_branch']);

    writeProjectFile('unique-generator.ts', 'export function generate() {}\n');
    const ungradedRunner = gitRunner({
      ...responses,
      status: { exitCode: 0, stdout: ['?? unique-generator.ts', ''].join('\0') },
    });
    const ungraded = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=1',
    ], { git: ungradedRunner });
    expect(ungraded.state).toBe('refused');
    expect(ungraded.refusalReasons).toContain('1 untracked ungraded path remains');
    expect(destructiveOperations(ungradedRunner)).toEqual([]);
  });

  it('reports unpushed commits but refuses only commits with no ref surviving topic-branch deletion', async () => {
    const runnerFor = (atRisk: string): ReturnType<typeof vi.fn<LandGitRunner>> => {
      const responses = cleanRemovalResponses();
      return vi.fn<LandGitRunner>((request) => {
        if (request.operation === 'unpushed') return { exitCode: 0, stdout: `${LOCAL_COMMIT}\n` };
        if ((request.operation as string) === 'at_risk') return { exitCode: 0, stdout: atRisk };
        return responses[request.operation] ?? { exitCode: 0, stdout: '' };
      });
    };

    const integratedRunner = runnerFor('');
    const integrated = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: integratedRunner });
    expect(integrated.state).toBe('removed');
    expect(integrated.inventory.unpushedCommits).toEqual([LOCAL_COMMIT]);
    expect(integrated.inventory.atRiskCommits).toEqual([]);
    expect(integrated.refusalReasons).not.toEqual(expect.arrayContaining([
      expect.stringContaining('absent from every remote ref'),
    ]));
    expect(integratedRunner).toHaveBeenCalledWith({
      command: 'git',
      args: [
        'rev-list', '--reverse', `${BASE}..HEAD`, '--not',
        '--exclude=refs/heads/topic-work', '--all',
      ],
      cwd: fixture.project,
      operation: 'at_risk',
    });

    const exposedRunner = runnerFor(`${LOCAL_COMMIT}\n`);
    const exposed = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: exposedRunner });
    expect(exposed.state).toBe('refused');
    expect(exposed.inventory.atRiskCommits).toEqual([LOCAL_COMMIT]);
    expect(exposed.refusalReasons).toContain('1 commit has no ref that would survive worktree branch deletion');
    expect(destructiveOperations(exposedRunner)).toEqual([]);
  });

  it('enumerates untracked source and ignored state even beneath dependency roots', async () => {
    const dependencyRoot = ['node', '_modules'].join('');
    const sourcePath = `${dependencyRoot}/local-only.ts`;
    const statePath = `${dependencyRoot}/pkg/cache.jsonl`;
    writeProjectFile(sourcePath, 'export const unique = true;\n');
    writeProjectFile(statePath, '{"unique":true}\n');
    const runner = gitRunner({
      status: { exitCode: 0, stdout: [`?? ${sourcePath}`, ''].join('\0') },
      ignored: { exitCode: 0, stdout: [statePath, ''].join('\0') },
    });

    const report = await runLand(['land', '--run', fixture.runId], { git: runner });

    expect(report.inventory.enumerated).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: sourcePath, grade: 'source' }),
      expect.objectContaining({ path: statePath, grade: 'data_or_state' }),
    ]));
    expect(report.inventory.regenerable.installedDependencies.count).toBe(0);
  });

  it('never lets an acknowledgement discard ignored source directly beneath a dependency root', async () => {
    const dependencyRoot = ['node', '_modules'].join('');
    const sourcePath = `${dependencyRoot}/local-only-generator.ts`;
    writeProjectFile(sourcePath, 'export function generateUniqueEvidence() { return 2379; }\n');
    const runner = gitRunner({
      ...cleanRemovalResponses(),
      ignored: { exitCode: 0, stdout: [sourcePath, ''].join('\0') },
    });

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=1',
    ], { git: runner });

    expect(report.state).toBe('refused');
    expect(report.inventory.enumerated).toContainEqual(expect.objectContaining({
      origin: 'ignored', path: sourcePath, grade: 'source',
    }));
    expect(report.inventory.regenerable.installedDependencies.count).toBe(0);
    expect(report.refusalReasons).toContain('1 ignored ungraded path remains');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('requires a build root and byte equality before summarizing artifact-like or copied files', async () => {
    writeProjectFile('only-copy.wasm', 'unique binary payload\n');
    writeProjectFile('public/logo.svg', '<svg>source</svg>\n');
    writeProjectFile('public/same.svg', '<svg>same</svg>\n');
    writeProjectFile('dist/logo.svg', '<svg>different unique output</svg>\n');
    writeProjectFile('dist/same.svg', '<svg>same</svg>\n');
    const runner = gitRunner({
      ignored: {
        exitCode: 0,
        stdout: ['only-copy.wasm', 'dist/logo.svg', 'dist/same.svg', ''].join('\0'),
      },
    });

    const report = await runLand(['land', '--run', fixture.runId], { git: runner });

    expect(report.inventory.enumerated).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'only-copy.wasm', grade: 'unknown' }),
      expect.objectContaining({ path: 'dist/logo.svg', grade: 'unknown' }),
    ]));
    expect(report.inventory.regenerable.buildOutputs).toEqual({
      grade: 'build_output', count: 1, origins: { untracked: 0, ignored: 1 },
    });
    expect(report.inventory.enumerated).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dist/same.svg' }),
    ]));
  });

  it('keeps a unique ignored FlowCrew state file named and refusal-driving', async () => {
    writeProjectFile('.fc/campaigns/only-copy.jsonl', '{"unique":true}\n');
    const runner = gitRunner({
      ignored: { exitCode: 0, stdout: ['.fc/campaigns/only-copy.jsonl', ''].join('\0') },
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdLandWithDeps(
      ['land', '--run', fixture.runId, '--remove', '--json'],
      { git: runner, stdout: stdout.writer, stderr: stderr.writer },
    );

    expect(code).toBe(1);
    expect(stdout.value).toBe('');
    const report = JSON.parse(stderr.value) as Awaited<ReturnType<typeof runLand>>;
    expect(report.inventory.enumerated).toContainEqual(expect.objectContaining({
      origin: 'ignored',
      path: '.fc/campaigns/only-copy.jsonl',
      grade: 'data_or_state',
    }));
    expect(report.refusalReasons).toContain('1 ignored ungraded path remains');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('refuses when a terminal artifact is absent even if Git inventory is empty', async () => {
    rmSync(join(fixture.project, 'docs', 'result.md'));
    const runner = gitRunner();

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: runner });

    expect(report.state).toBe('refused');
    expect(report.refusalReasons).toContain('declared terminal artifacts are absent: docs/result.md');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('accepts the scheduler snapshot when the project copy was clobbered', async () => {
    rmSync(join(fixture.project, 'docs', 'result.md'));
    writeFileSync(join(fixture.runDir, 'terminal_result.md'), '# Preserved result\n', 'utf-8');

    const report = await runLand(['land', '--run', fixture.runId], { git: gitRunner() });

    expect(report.artifacts).toEqual([
      expect.objectContaining({ projectPresent: false, snapshotPresent: true, present: true }),
    ]);
  });

  it('treats an incomplete Git inspection as unknown and refuses removal', async () => {
    const runner = gitRunner({ ignored: { exitCode: 2, stderr: 'index unreadable' } });

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: runner });

    expect(report.state).toBe('refused');
    expect(report.inspectionIssues).toEqual([
      expect.objectContaining({ operation: 'ignored', reason: expect.stringContaining('index unreadable') }),
    ]);
    expect(report.refusalReasons).toContain('inventory inspection is incomplete (1 issue)');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('removes only a proven linked worktree, then prunes and non-force deletes its exact branch', async () => {
    const runner = gitRunner(cleanRemovalResponses());

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: runner });

    expect(report.state).toBe('removed');
    expect(report.branch).toBe('topic-work');
    expect(report.primaryWorktree).toBe(fixture.primary);
    expect(runner).toHaveBeenCalledWith({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: fixture.project,
      operation: 'worktrees',
    });
    const destructive = runner.mock.calls
      .map(([request]) => request)
      .filter((request) => ['remove_worktree', 'prune_worktrees', 'delete_branch'].includes(request.operation));
    expect(destructive).toEqual([
      {
        command: 'git',
        args: ['worktree', 'remove', '--', fixture.project],
        cwd: fixture.primary,
        operation: 'remove_worktree',
      },
      {
        command: 'git',
        args: ['worktree', 'prune'],
        cwd: fixture.primary,
        operation: 'prune_worktrees',
      },
      {
        command: 'git',
        args: ['branch', '-d', '--', 'topic-work'],
        cwd: fixture.primary,
        operation: 'delete_branch',
      },
    ]);
  });

  it('stops destructive sequencing immediately when non-force worktree removal fails', async () => {
    const runner = gitRunner({
      ...cleanRemovalResponses(),
      remove_worktree: { exitCode: 1, stderr: 'worktree still locked' },
    });

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: runner });

    expect(report.state).toBe('removal_failed');
    expect(report.removalSteps).toEqual([
      expect.objectContaining({ operation: 'remove_worktree', exitCode: 1, error: expect.stringContaining('still locked') }),
    ]);
    expect(destructiveOperations(runner)).toEqual(['remove_worktree']);
  });

  it('never removes the repository primary worktree', async () => {
    const responses = cleanRemovalResponses();
    responses.worktrees = {
      exitCode: 0,
      stdout: [
        `worktree ${fixture.project}`,
        `HEAD ${BASE}`,
        'branch refs/heads/main',
        '',
      ].join('\n'),
    };
    responses.branch = { exitCode: 0, stdout: 'main\n' };
    const runner = gitRunner(responses);

    const report = await runLand([
      'land', '--run', fixture.runId, '--remove', '--acknowledge-regenerable=0',
    ], { git: runner });

    expect(report.state).toBe('refused');
    expect(report.refusalReasons).toContain('the primary or bare worktree cannot be removed by `flowcrew land`');
    expect(destructiveOperations(runner)).toEqual([]);
  });

  it('refuses a non-terminal run before discovering removal context', async () => {
    writeState({ status: 'running', terminalStates: {} });
    const runner = gitRunner();

    const report = await runLand(['land', '--run', fixture.runId, '--remove'], { git: runner });

    expect(report.state).toBe('refused');
    expect(report.refusalReasons).toContain('run has not reached a terminal status');
    expect(runner.mock.calls.map(([request]) => request.operation)).toEqual([
      'status', 'ignored', 'branch', 'unpushed', 'at_risk',
    ]);
  });
});

describe('land parsers preserve path data', () => {
  it('retains a complete Git census larger than the former 8 MiB tail buffer', () => {
    const padding = 'x'.repeat(180);
    const repeatedPathCount = 44_000;
    const raw = `.fc/campaigns/head-only.jsonl\0${`dist/chunk-00000-${padding}.js\0`.repeat(repeatedPathCount)}`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
    const capture = createLandOutputCapture();
    for (let offset = 0; offset < raw.length; offset += 64 * 1024) {
      capture.append(raw.slice(offset, offset + 64 * 1024));
    }

    const result = capture.finish();

    expect(result.complete).toBe(true);
    const records = result.value.split('\0').filter(Boolean);
    expect(records[0]).toBe('.fc/campaigns/head-only.jsonl');
    expect(records).toHaveLength(repeatedPathCount + 1);
  });

  it('marks output incomplete instead of returning a misleading tail after overflow', () => {
    const capture = createLandOutputCapture(8);
    capture.append('head');
    capture.append('-overflow');

    expect(capture.finish()).toEqual({ value: '', complete: false, maximum: 8 });
  });

  it('keeps spaces, newlines, and rename sources from NUL porcelain output', () => {
    const parsed = parseGitStatusPorcelain([
      'R  renamed file.ts',
      'old file.ts',
      '?? line\nbreak.txt',
      '',
    ].join('\0'));

    expect(parsed).toEqual({
      tracked: [{ code: 'R ', path: 'renamed file.ts', originalPath: 'old file.ts' }],
      untracked: ['line\nbreak.txt'],
    });
  });
});
