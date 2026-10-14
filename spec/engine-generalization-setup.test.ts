import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_MANIFEST_FILENAME, createBuildManifest } from '../src/build-manifest.js';
import {
  cmdShipPreflightWithDeps,
  collectShipPreflight,
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import {
  runShipSetup,
  type GitCommandRunner,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { rehearseBriefIsolated } from '../src/rehearse.js';

class Capture {
  value = '';
  writer = { write: (chunk: string): void => { this.value += chunk; } };
}

interface Fixture {
  root: string;
  project: string;
  state: string;
  packageRoot: string;
}

let fixture: Fixture;

function packageManifest(): Record<string, unknown> {
  return {
    scripts: { build: 'compile', test: 'check', lint: 'style' },
    flowcrew: { testPopulation: { files: [] } },
  };
}

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-engine-generalization-setup-')));
  fixture = {
    root,
    project: join(root, 'project'),
    state: join(root, 'state'),
    packageRoot: join(root, 'package'),
  };
  mkdirSync(fixture.project, { recursive: true });
  mkdirSync(join(fixture.project, 'node_modules'), { recursive: true });
  writeFileSync(join(fixture.project, 'package.json'), JSON.stringify(packageManifest()));
  writeFileSync(join(fixture.project, 'package-lock.json'), '{}\n');

  mkdirSync(join(fixture.packageRoot, 'src'), { recursive: true });
  mkdirSync(join(fixture.packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(fixture.packageRoot, 'src', 'probe.ts'), 'export const probe = true;\n');
  writeFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'export const probe = true;\n');
  writeFileSync(join(fixture.packageRoot, 'dist', 'probe.d.ts'), 'export declare const probe = true;\n');
  writeFileSync(join(fixture.packageRoot, 'tsconfig.json'), '{}\n');
  const manifest = createBuildManifest(fixture.packageRoot, join(fixture.packageRoot, 'dist'));
  writeFileSync(
    join(fixture.packageRoot, 'dist', BUILD_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

function validationRunner(
  effect?: (role: 'build' | 'test' | 'lint', cwd: string) => void,
): ReturnType<typeof vi.fn<ValidationCommandRunner>> {
  return vi.fn<ValidationCommandRunner>((request) => {
    effect?.(request.role, request.cwd);
    return { exitCode: 0, stdout: `${request.role} passed\n`, durationMs: 1 };
  });
}

function preflightDependencies(
  runsRoot: string,
  runner: ValidationCommandRunner,
  overrides: ShipPreflightDependencies = {},
): ShipPreflightDependencies {
  return {
    projectDir: fixture.project,
    packageRoot: fixture.packageRoot,
    runsRoot: () => runsRoot,
    readGitCommonDir: () => '.git',
    readCampaignEntries: () => [],
    probeDaemon: async (): Promise<DaemonLoadedBuildProbe> => ({
      state: 'fresh', loadedBuild: 'same', diskBuild: 'same',
    }),
    inspectLiveRun: () => true,
    runValidationCommand: runner,
    ...overrides,
  };
}

function writeRunningRun(runsRoot: string): void {
  const runDir = join(runsRoot, 'live-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({
    runId: 'live-run',
    projectDir: fixture.project,
    status: 'running',
  })}\n`);
}

describe('item 7: live-project validation binding', () => {
  it('discovers facts for live, idle and explicit-skip projects without executing commands', async () => {
    const liveRuns = join(fixture.state, 'live-runs');
    const emptyRuns = join(fixture.state, 'empty-runs');
    mkdirSync(emptyRuns, { recursive: true });
    writeRunningRun(liveRuns);

    const unsafeRunner = validationRunner();
    const unsafeOut = new Capture();
    const unsafeErr = new Capture();
    const unsafeCode = await cmdShipPreflightWithDeps(['ship-preflight'], preflightDependencies(
      liveRuns,
      unsafeRunner,
      { stdout: unsafeOut.writer, stderr: unsafeErr.writer },
    ));

    expect(unsafeCode).toBe(0);
    expect(unsafeRunner).not.toHaveBeenCalled();
    expect(unsafeErr.value).toContain('live FlowCrew run(s)');
    expect(unsafeErr.value).toContain('No project command was launched');

    const skippedRunner = validationRunner();
    const skippedErr = new Capture();
    const skippedCode = await cmdShipPreflightWithDeps(
      ['ship-preflight', '--no-baseline'],
      preflightDependencies(liveRuns, skippedRunner, { stderr: skippedErr.writer, stdout: new Capture().writer }),
    );
    expect(skippedCode).toBe(0);
    expect(skippedRunner).not.toHaveBeenCalled();
    expect(skippedErr.value).toContain('Validation baseline: SKIPPED');

    const idleRunner = validationRunner();
    const idleCode = await cmdShipPreflightWithDeps(
      ['ship-preflight'],
      preflightDependencies(emptyRuns, idleRunner, { stdout: new Capture().writer, stderr: new Capture().writer }),
    );
    expect(idleCode).toBe(0);
    expect(idleRunner).not.toHaveBeenCalled();

    const idleSkippedRunner = validationRunner();
    const idleSkippedCode = await cmdShipPreflightWithDeps(
      ['ship-preflight', '--no-baseline'],
      preflightDependencies(emptyRuns, idleSkippedRunner, {
        stdout: new Capture().writer,
        stderr: new Capture().writer,
      }),
    );
    expect(idleSkippedCode).toBe(0);
    expect(idleSkippedRunner).not.toHaveBeenCalled();
  });
});

function setupArgs(target: string, branch: string): string[] {
  return [
    'ship-setup',
    '--brief', 'brief.md',
    '--project', fixture.project,
    '--target', target,
    '--base', 'release-base',
    '--branch', branch,
  ];
}

function materializeTrackedTarget(target: string): void {
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, 'node_modules'), { recursive: true });
  copyFileSync(join(fixture.project, 'package.json'), join(target, 'package.json'));
  copyFileSync(join(fixture.project, 'package-lock.json'), join(target, 'package-lock.json'));
}

function creatingWorktree(): ReturnType<typeof vi.fn<GitWorktreeCreator>> {
  return vi.fn<GitWorktreeCreator>((request) => {
    materializeTrackedTarget(request.targetDir);
    return { exitCode: 0 };
  });
}

describe('item 14: declared-input stability binding', () => {
  it.each([false, true])('admits a declared output inside an input directory (existing=%s) through preflight, rehearsal, and setup', async existing => {
    mkdirSync(join(fixture.project, 'fixtures', 'source'), { recursive: true });
    writeFileSync(join(fixture.project, 'fixtures', 'source', 'evidence.txt'), 'preserved evidence\n');
    if (existing) writeFileSync(join(fixture.project, 'fixtures', 'source', 'report.md'), 'earlier report\n');
    const brief = [
      '---',
      'inputs: [fixtures/source]',
      'outputs:',
      '  - path: fixtures/source/report.md',
      ...(existing ? ['    on_existing: replace'] : []),
      '---',
      '# Goal',
      'Write a report using the source evidence.',
      '',
      '## Acceptance criteria',
      '1. Create fixtures/source/report.md using fixtures/source/evidence.txt.',
    ].join('\n');
    writeFileSync(join(fixture.project, 'brief.md'), brief);
    const preflight = await collectShipPreflight(['ship-preflight', '--brief', 'brief.md'],
      preflightDependencies(join(fixture.state, 'runs'), validationRunner()));
    expect(preflight.report.outputInventory.inventory.blocking).toEqual([]);
    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--brief', 'brief.md'],
      preflightDependencies(join(fixture.state, 'runs'), validationRunner(), {
        stdout: new Capture().writer, stderr: new Capture().writer,
      }))).toBe(0);
    const rehearsal = await rehearseBriefIsolated(brief, { projectDir: fixture.project, staticOnly: true });
    try {
      expect(rehearsal.exitCode, JSON.stringify(rehearsal.findings)).toBe(0);
      expect(rehearsal.preflight.contractReady).toBe(true);
      expect(rehearsal.outputInventory.blocking).toBe(0);
    } finally { rmSync(join(rehearsal.diagnosticsLogPath, '..'), { recursive: true, force: true }); }
    const target = join(fixture.root, 'overlap-target');
    const create = vi.fn<GitWorktreeCreator>((request) => {
      materializeTrackedTarget(request.targetDir);
      mkdirSync(join(request.targetDir, 'fixtures', 'source'), { recursive: true });
      copyFileSync(join(fixture.project, 'fixtures', 'source', 'evidence.txt'),
        join(request.targetDir, 'fixtures', 'source', 'evidence.txt'));
      if (existing) copyFileSync(join(fixture.project, 'fixtures', 'source', 'report.md'),
        join(request.targetDir, 'fixtures', 'source', 'report.md'));
      return { exitCode: 0 };
    });
    const setup = await runShipSetup(setupArgs(target, 'overlap-output'), {
      createWorktree: create, runValidationCommand: validationRunner(), globalDir: () => fixture.state,
    });
    expect(setup.state, JSON.stringify(setup.blockers)).toBe('ready');
    expect(readFileSync(join(target, 'fixtures', 'source', 'evidence.txt'), 'utf8')).toBe('preserved evidence\n');
  });

  it('refuses an existing create-only output inside its declared input at every admission surface', async () => {
    mkdirSync(join(fixture.project, 'fixtures', 'source'), { recursive: true });
    writeFileSync(join(fixture.project, 'fixtures', 'source', 'report.md'), 'existing report\n');
    const brief = [
      '---', 'inputs: [fixtures/source]', 'outputs: [fixtures/source/report.md]', '---',
      '# Goal', 'Produce a fresh report.', '', '## Acceptance criteria',
      '1. Create fixtures/source/report.md from the input evidence.',
    ].join('\n');
    writeFileSync(join(fixture.project, 'brief.md'), brief);
    const preflight = await collectShipPreflight(['ship-preflight', '--brief', 'brief.md'],
      preflightDependencies(join(fixture.state, 'runs'), validationRunner()));
    expect(preflight.report.outputInventory.inventory.blocking).toEqual([
      expect.objectContaining({ path: 'fixtures/source/report.md', reason: expect.stringContaining('create-only') }),
    ]);
    const preflightOutput = new Capture();
    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--brief', 'brief.md'],
      preflightDependencies(join(fixture.state, 'runs'), validationRunner(), {
        stdout: preflightOutput.writer, stderr: new Capture().writer,
      }))).toBe(0);
    expect(preflightOutput.value).toContain('BLOCKED fixtures/source/report.md');
    const rehearsal = await rehearseBriefIsolated(brief, { projectDir: fixture.project, staticOnly: true });
    try {
      expect(rehearsal.exitCode).toBe(1);
      expect(rehearsal.outputInventory.blocking).toBe(1);
    } finally { rmSync(join(rehearsal.diagnosticsLogPath, '..'), { recursive: true, force: true }); }
    const create = creatingWorktree();
    const setup = await runShipSetup(setupArgs(join(fixture.root, 'create-only-target'), 'create-only-output'), {
      createWorktree: create, runValidationCommand: validationRunner(), globalDir: () => fixture.state,
    });
    expect(setup.state).toBe('refused');
    expect(setup.blockers).toContainEqual(expect.objectContaining({
      input: 'fixtures/source/report.md', reason: expect.stringContaining('create-only'),
    }));
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses content and tree-membership mutations but permits generated-output writes', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    mkdirSync(join(fixture.project, 'fixtures', 'frozen'), { recursive: true });
    const frozenFile = join(fixture.project, 'data', 'frozen.csv');
    const frozenTreeFile = join(fixture.project, 'fixtures', 'frozen', 'record.json');
    writeFileSync(frozenFile, 'id,value\n1,original\n');
    writeFileSync(frozenTreeFile, '{"id":1}\n');
    writeFileSync(join(fixture.project, 'brief.md'), [
      '---',
      'inputs:',
      '  - data/frozen.csv',
      '  - fixtures/frozen',
      'outputs:',
      '  - path: generated/cache.txt',
      '    on_existing: replace',
      '---',
      '# Goal',
      'Validate without changing the declared inputs.',
    ].join('\n'));

    const mutatingTarget = join(fixture.root, 'mutating-target');
    const mutatingRunner = validationRunner((role, cwd) => {
      if (role !== 'test') return;
      writeFileSync(join(cwd, 'data', 'frozen.csv'), 'id,value\n1,mutated\n');
      writeFileSync(join(cwd, 'fixtures', 'frozen', 'added.json'), '{"added":true}\n');
    });
    const mutated = await runShipSetup(setupArgs(mutatingTarget, 'mutating-branch'), {
      createWorktree: creatingWorktree(),
      runValidationCommand: mutatingRunner,
      globalDir: () => fixture.state,
      timestamp: () => '2030-01-02T03:04:05.000Z',
    });

    expect(mutated.state).toBe('refused');
    expect(mutated.blockers).toContainEqual(expect.objectContaining({
      phase: 'validation',
      reason: expect.stringContaining('Declared read-only input changed during target validation baseline'),
    }));
    expect(mutated.declaredInputStability).toEqual([
      expect.objectContaining({
        phase: 'target_validation_baseline',
        state: 'changed',
        changedInputs: [
          expect.objectContaining({ path: 'data/frozen.csv' }),
          expect.objectContaining({ path: 'fixtures/frozen' }),
        ],
      }),
    ]);
    expect(readFileSync(frozenFile, 'utf8')).toContain('original');
    expect(existsSync(join(fixture.project, 'fixtures', 'frozen', 'added.json'))).toBe(false);

    writeFileSync(frozenFile, 'id,value\n1,original\n');
    rmSync(join(fixture.project, 'fixtures', 'frozen', 'added.json'), { force: true });
    const stableTarget = join(fixture.root, 'stable-target');
    const outputOnlyRunner = validationRunner((_role, cwd) => {
      mkdirSync(join(cwd, 'generated'), { recursive: true });
      writeFileSync(join(cwd, 'generated', 'cache.txt'), 'generated\n');
    });
    const stable = await runShipSetup(setupArgs(stableTarget, 'stable-branch'), {
      createWorktree: creatingWorktree(),
      runValidationCommand: outputOnlyRunner,
      globalDir: () => fixture.state,
      timestamp: () => '2030-01-02T03:04:06.000Z',
    });

    expect(stable.state).toBe('ready');
    expect(stable.declaredInputStability).toEqual([
      expect.objectContaining({ phase: 'target_validation_baseline', state: 'stable', changedInputs: [] }),
      expect.objectContaining({ phase: 'test_collection', state: 'stable', changedInputs: [] }),
    ]);
    expect(readFileSync(frozenFile, 'utf8')).toContain('original');
    expect(readFileSync(join(stableTarget, 'generated', 'cache.txt'), 'utf8')).toBe('generated\n');
  });

  it('protects declared inputs during test collection after baseline execution', async () => {
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'vitest run', lint: 'style' },
      devDependencies: { vitest: 'fixture' },
    }));
    mkdirSync(join(fixture.project, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(fixture.project, 'node_modules', 'vitest', 'package.json'), JSON.stringify({
      name: 'vitest', version: '0.0.0-fixture', exports: { './package.json': './package.json' },
    }));
    writeFileSync(join(fixture.project, 'node_modules', 'vitest', 'vitest.mjs'), 'export {};\n');
    mkdirSync(join(fixture.project, 'spec'), { recursive: true });
    writeFileSync(join(fixture.project, 'spec', 'example.test.ts'), 'export const example = true;\n');
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'original\n');
    writeFileSync(join(fixture.project, 'brief.md'), [
      '---',
      'inputs: [data/frozen.csv]',
      '---',
      '# Goal',
      'Collect the tests without changing inputs.',
    ].join('\n'));

    const target = join(fixture.root, 'collection-target');
    const create = vi.fn<GitWorktreeCreator>((request) => {
      materializeTrackedTarget(request.targetDir);
      mkdirSync(join(request.targetDir, 'node_modules', 'vitest'), { recursive: true });
      copyFileSync(
        join(request.projectDir, 'node_modules', 'vitest', 'package.json'),
        join(request.targetDir, 'node_modules', 'vitest', 'package.json'),
      );
      copyFileSync(
        join(request.projectDir, 'node_modules', 'vitest', 'vitest.mjs'),
        join(request.targetDir, 'node_modules', 'vitest', 'vitest.mjs'),
      );
      mkdirSync(join(request.targetDir, 'spec'), { recursive: true });
      copyFileSync(
        join(request.projectDir, 'spec', 'example.test.ts'),
        join(request.targetDir, 'spec', 'example.test.ts'),
      );
      return { exitCode: 0 };
    });
    const collector = vi.fn<ValidationCommandRunner>((request) => {
      if (request.cwd === target) writeFileSync(join(target, 'data', 'frozen.csv'), 'changed by collection\n');
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ file: join(request.cwd, 'spec', 'example.test.ts') }]),
        durationMs: 1,
      };
    });
    const baseline = validationRunner();
    const report = await runShipSetup(setupArgs(target, 'collection-branch'), {
      createWorktree: create,
      runTestCollectionCommand: collector,
      runValidationCommand: baseline,
      globalDir: () => fixture.state,
    });

    expect(report.state).toBe('refused');
    expect(report.declaredInputStability).toEqual([
      expect.objectContaining({ phase: 'target_validation_baseline', state: 'stable', changedInputs: [] }),
      expect.objectContaining({
        phase: 'test_collection',
        state: 'changed',
        changedInputs: expect.arrayContaining([
          expect.objectContaining({ path: 'data/frozen.csv' }),
        ]),
      }),
    ]);
    expect(collector).toHaveBeenCalledTimes(2);
    expect(baseline).toHaveBeenCalledTimes(3);
  });

  it('never executes the source fallback that could mutate an input', async () => {
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'custom-test-runner', lint: 'style' },
    }));
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'original\n');
    writeFileSync(join(fixture.project, 'brief.md'), [
      '---',
      'inputs: [data/frozen.csv]',
      '---',
      '# Goal',
      'Run the fallback without changing inputs.',
    ].join('\n'));
    const target = join(fixture.root, 'fallback-target');
    const runner = validationRunner((role, cwd) => {
      if (role === 'test' && cwd === fixture.project) {
        writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'changed by source fallback\n');
      }
    });
    const createTrackedInput = vi.fn<GitWorktreeCreator>((request) => {
      materializeTrackedTarget(request.targetDir);
      mkdirSync(join(request.targetDir, 'data'), { recursive: true });
      copyFileSync(
        join(request.projectDir, 'data', 'frozen.csv'),
        join(request.targetDir, 'data', 'frozen.csv'),
      );
      return { exitCode: 0 };
    });
    const report = await runShipSetup(setupArgs(target, 'fallback-branch'), {
      createWorktree: createTrackedInput,
      runValidationCommand: runner,
      globalDir: () => fixture.state,
    });

    expect(report.state).toBe('ready');
    expect(report.testPopulation?.state).toBe('unverified');
    expect(report.declaredInputStability).toEqual([
      expect.objectContaining({ phase: 'target_validation_baseline', state: 'stable' }),
      expect.objectContaining({ phase: 'test_collection', state: 'stable' }),
    ]);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.every(([request]) => request.cwd === target)).toBe(true);
    expect(readFileSync(join(fixture.project, 'data', 'frozen.csv'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(target, 'data', 'frozen.csv'), 'utf8')).toBe('original\n');
  });
});

const BASE_OID = '0123456789012345678901234567890123456789';

function worktreeRecord(target: string, head = BASE_OID, branch = 'reuse-branch'): string {
  return [
    `worktree ${fixture.project}`,
    `HEAD ${BASE_OID}`,
    'branch refs/heads/source',
    '',
    `worktree ${target}`,
    `HEAD ${head}`,
    `branch refs/heads/${branch}`,
    '',
  ].join('\n');
}

function reuseRunner(
  inventory: { exitCode: number | null; stdout?: string; stderr?: string; error?: string },
): ReturnType<typeof vi.fn<GitCommandRunner>> {
  return vi.fn<GitCommandRunner>((request) => {
    if (request.args.join(' ') === 'worktree list --porcelain') return inventory;
    if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${BASE_OID}\n` };
    return { exitCode: 1, stderr: `unexpected mocked Git operation: ${request.args.join(' ')}` };
  });
}

describe('item 18: portable existing-worktree inventory', () => {
  it('reaches safe reuse without the unsupported option and retains every fail-closed identity check', async () => {
    writeFileSync(join(fixture.project, 'brief.md'), '# Goal\nReuse the exact existing target.\n');
    const target = join(fixture.root, 'reusable-target');
    materializeTrackedTarget(target);
    const portableRunner = reuseRunner({ exitCode: 0, stdout: worktreeRecord(target) });
    const ready = await runShipSetup(setupArgs(target, 'reuse-branch'), {
      runGitCommand: portableRunner,
      runValidationCommand: validationRunner(),
      globalDir: () => fixture.state,
    });

    expect(ready).toMatchObject({ state: 'ready', worktreeCreated: false, worktreeReused: true });
    expect(portableRunner.mock.calls.map(([request]) => request.args)).toContainEqual([
      'worktree', 'list', '--porcelain',
    ]);
    expect(portableRunner.mock.calls.flatMap(([request]) => request.args)).not.toContain('-z');

    const controls = [
      {
        name: 'unregistered',
        inventory: { exitCode: 0, stdout: worktreeRecord(join(fixture.root, 'somewhere-else')) },
        reason: 'not registered',
      },
      {
        name: 'wrong-branch',
        inventory: { exitCode: 0, stdout: worktreeRecord(join(fixture.root, 'wrong-branch-target'), BASE_OID, 'other') },
        reason: 'does not match requested branch',
      },
      {
        name: 'wrong-head',
        inventory: { exitCode: 0, stdout: worktreeRecord(join(fixture.root, 'wrong-head-target'), 'f'.repeat(40)) },
        reason: 'does not match requested base',
      },
      {
        name: 'unreadable-inventory',
        inventory: { exitCode: 128, stderr: 'inventory unavailable' },
        reason: 'inventory unavailable',
      },
    ];
    for (const control of controls) {
      const controlTarget = join(fixture.root, `${control.name}-target`);
      materializeTrackedTarget(controlTarget);
      const inventory = control.name === 'wrong-branch'
        ? { exitCode: 0, stdout: worktreeRecord(controlTarget, BASE_OID, 'other') }
        : control.name === 'wrong-head'
          ? { exitCode: 0, stdout: worktreeRecord(controlTarget, 'f'.repeat(40)) }
          : control.inventory;
      const refused = await runShipSetup(setupArgs(controlTarget, 'reuse-branch'), {
        runGitCommand: reuseRunner(inventory),
        runValidationCommand: validationRunner(),
        globalDir: () => fixture.state,
      });
      expect(refused.state, control.name).toBe('refused');
      expect(refused.blockers[0]?.reason, control.name).toContain(control.reason);
    }
  });
});
