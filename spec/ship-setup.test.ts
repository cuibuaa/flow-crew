import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { installDiskGuardFixture } from './test-support/disk-guard-fixture.js';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
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
  type GitCommandRequest,
  type GitCommandRunner,
  type GitWorktreeCreator,
  type GitWorktreeRequest,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { execWithStdin } from '../src/adapters/base.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';


// Temporary projects and outputs share this repository as a container, while
// their synthetic installation remains a separate sibling fixture namespace.
const installation = vi.hoisted(() => { vi.resetModules(); return { install: () => {} }; });
vi.mock('../src/ship-inputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-inputs.js')>();
  const { dirname, join } = await import('node:path');
  const external = actual.externalOutputDirectory, inventory = actual.inspectBriefOutputs;
  installation.install = () => {
    vi.spyOn(actual, 'externalOutputDirectory').mockImplementation((declaration, project, fs, context) =>
      external(declaration, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
    vi.spyOn(actual, 'inspectBriefOutputs').mockImplementation((brief, project, fs, context) =>
      inventory(brief, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
  };
  return actual;
});

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
  installation.install();
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
  writeFileSync(fixture.brief, [...lines, '## Requirements', '1. Produce the declared deliverable.'].join('\n'), 'utf-8');
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
  mkdirSync(join(request.targetDir, 'node_modules'), { recursive: true });
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

function writeDirectoryFixture(): void {
  writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
    scripts: { build: 'compile', test: 'check', lint: 'style' },
  }), 'utf-8');
  mkdirSync(join(fixture.project, 'spec'), { recursive: true });
  mkdirSync(join(fixture.project, 'checks', 'fixtures'), { recursive: true });
  writeFileSync(join(fixture.project, 'spec', 'public.test.ts'), 'export const publicTest = true;\n');
  writeFileSync(join(fixture.project, 'checks', 'fixtures', 'published.test.ts'), 'export const published = true;\n');
  writeFileSync(join(fixture.project, 'checks', 'private.test.ts'), 'export const privateTest = true;\n');
}

function copyDirectoryTrackedFiles(request: GitWorktreeRequest): void {
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
  if (!existsSync(directory)) return true;
  return readdirSync(directory).every((name) => {
    try {
      return JSON.parse(readFileSync(join(directory, name), 'utf-8')).state !== 'ready';
    } catch {
      return true;
    }
  });
}

describe('ship-setup fail-closed worktree transaction', () => {
  it('refuses the deduplicated 27 GB input batch before worktree creation or any copy', async () => {
    const home = join(fixture.root, 'guard-home');
    const log = installDiskGuardFixture(home, 12_000_000_000);
    vi.stubEnv('HOME', home);
    try {
      mkdirSync(join(fixture.project, 'hf_cache'));
      for (const name of ['a', 'b', 'c']) writeFileSync(join(fixture.project, 'hf_cache', name), 'tiny fixture');
      writeBrief(['---', 'inputs: [hf_cache, hf_cache/a]', '---', '# Goal', 'Read the cache.']);
      const git = successfulGit();
      const copy = vi.fn(nodeShipSetupFileSystem.copyFile);
      const report = await runShipSetup(setupArgs(), {
        createWorktree: git, runValidationCommand: validationRunner(),
        fs: { ...nodeShipSetupFileSystem, copyFile: copy, stat: path => {
          const info = nodeShipSetupFileSystem.stat(path);
          if (path.startsWith(join(fixture.project, 'hf_cache') + '/') && !info.isDirectory()) {
            return { isDirectory: () => false, isFile: () => true, size: 9_000_000_000 };
          }
          return info;
        } },
      });
      expect(report.state).toBe('refused');
      expect(report.blockers[0].reason).toContain('Disk admission refused before copying 27000000000 bytes');
      expect(readFileSync(log, 'utf8').trim()).toBe('27000000000');
      expect(git).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(fixture.target)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('admits one small input batch, copies independent bytes, and skips admission when reused', async () => {
    const home = join(fixture.root, 'guard-home');
    const log = installDiskGuardFixture(home, 12);
    vi.stubEnv('HOME', home);
    try {
      mkdirSync(join(fixture.project, 'data'));
      for (const name of ['a', 'b']) writeFileSync(join(fixture.project, 'data', name), '123456');
      writeBrief(['---', 'inputs: [data, data/a]', '---', '# Goal', 'Read the inputs.']);
      const overrides = { createWorktree: successfulGit(), runValidationCommand: validationRunner() };
      const report = await runShipSetup(setupArgs(), overrides);
      expect(report.state, JSON.stringify(report)).toBe('ready');
      expect(readFileSync(log, 'utf8')).toBe('12\n');
      writeFileSync(join(fixture.target, 'data', 'a'), 'target');
      expect(readFileSync(join(fixture.project, 'data', 'a'), 'utf8')).toBe('123456');
      writeFileSync(join(fixture.target, 'data', 'a'), '123456');
      const reused = await runShipSetup(setupArgs(), {
        ...overrides,
        runGitCommand: request => {
          if (request.args[0] === 'worktree') return { exitCode: 0, stdout:
            `worktree ${fixture.target}\nHEAD fixture-base\nbranch refs/heads/autonomous-result\n` };
          if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: 'fixture-base\n' };
          return { exitCode: 1 };
        },
      });
      expect(reused.state, JSON.stringify(reused)).toBe('ready');
      expect(readFileSync(log, 'utf8')).toBe('12\n');
    } finally { vi.unstubAllEnvs(); }
  });

  it('copies both files under a declared gitignored data directory and records them in READY', async () => {
    isolatedProjectCommand('git', ['init', '-q'], fixture.project, fixture.root);
    mkdirSync(join(fixture.project, 'data'));
    writeFileSync(join(fixture.project, 'data', 'a.csv'), 'id\n1\n');
    writeFileSync(join(fixture.project, 'data', 'b.csv'), 'id\n2\n');
    expect(isolatedProjectCommand('git', ['check-ignore', 'data/a.csv', 'data/b.csv'], fixture.project, fixture.root))
      .toBe('data/a.csv\ndata/b.csv\n');
    writeBrief(['---', 'inputs: [data]', '---', '# Goal', 'Use the declared data.']);

    isolatedProjectCommand('git', ['add', '.gitignore', 'package.json', 'package-lock.json', 'brief.md'], fixture.project, fixture.root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Declared input fixture'], fixture.project, fixture.root);
    const args = setupArgs();
    args[args.indexOf('--base') + 1] = 'HEAD';
    const report = await runShipSetup(args, {
      runValidationCommand: validationRunner(),
    });

    expect(report.state, JSON.stringify(report.blockers)).toBe('ready');
    expect(readdirSync(join(fixture.target, 'data')).sort()).toEqual(['a.csv', 'b.csv']);
    for (const name of ['a.csv', 'b.csv']) {
      expect(readFileSync(join(fixture.target, 'data', name), 'utf8'))
        .toBe(readFileSync(join(fixture.project, 'data', name), 'utf8'));
    }
    expect(report.copies.map(copy => copy.path).sort()).toEqual(['data/a.csv', 'data/b.csv']);
    if (report.state !== 'ready') throw new Error('declared ignored data unexpectedly refused');
    const record = JSON.parse(readFileSync(report.readyRecordPath, 'utf8'));
    expect(record).toMatchObject({ state: 'ready', ready: true, copies: report.copies });
  });

  it('copies a declared frozen input into target-owned bytes and records its frozen declaration', async () => {
    mkdirSync(join(fixture.project, 'data'));
    writeFileSync(join(fixture.project, 'data', 'evidence.txt'), 'frozen evidence');
    writeBrief(['---', 'inputs: [{path: data, frozen: true}]', '---', '# Goal', 'Read the frozen evidence.']);
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(), runValidationCommand: validationRunner(),
    });
    expect(report.state, JSON.stringify(report.blockers)).toBe('ready');
    expect(lstatSync(join(fixture.target, 'data')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(fixture.target, 'data', 'evidence.txt'), 'utf8')).toBe('frozen evidence');
    expect(report.copies).toEqual([expect.objectContaining({ path: 'data/evidence.txt' })]);
    expect(report.sourceVerification?.inputs).toContainEqual(expect.objectContaining({ path: 'data', frozen: true }));
    writeFileSync(join(fixture.target, 'data', 'evidence.txt'), 'target edit');
    expect(readFileSync(join(fixture.project, 'data', 'evidence.txt'), 'utf8')).toBe('frozen evidence');
  });

  it('budgets both destinations for a declared directory and a file alias', async () => {
    const home = join(fixture.root, 'guard-home');
    const log = installDiskGuardFixture(home, 10);
    vi.stubEnv('HOME', home);
    try {
      isolatedProjectCommand('git', ['init', '-q'], fixture.project, home);
      mkdirSync(join(fixture.project, 'data'));
      writeFileSync(join(fixture.project, 'data', 'file'), '123456');
      symlinkSync('data/file', join(fixture.project, 'alias'));
      writeBrief(['---', 'inputs: [data, alias]', '---', '# Goal', 'Read the inputs.']);
      const git = successfulGit();
      const copy = vi.fn(nodeShipSetupFileSystem.copyFile);
      const report = await runShipSetup(setupArgs(), {
        createWorktree: git, runValidationCommand: validationRunner(),
        runGitCommand: () => ({ exitCode: 0, stdout: '' }),
        fs: { ...nodeShipSetupFileSystem, copyFile: copy },
      });
      expect(report.state).toBe('refused');
      expect(report.blockers[0].reason).toContain('before copying 12 bytes');
      expect(readFileSync(log, 'utf8')).toBe('12\n');
      expect(git).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(fixture.target)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('budgets missing descendants through an internal link when reusing a real target directory', async () => {
    const home = join(fixture.root, 'guard-home');
    const log = installDiskGuardFixture(home, 10);
    vi.stubEnv('HOME', home);
    try {
      mkdirSync(join(fixture.project, 'data', 'real'), { recursive: true });
      writeFileSync(join(fixture.project, 'data', 'real', 'large'), '123456');
      writeFileSync(join(fixture.project, 'data', 'new'), '123456');
      symlinkSync('real', join(fixture.project, 'data', 'alias'));
      mkdirSync(join(fixture.target, 'data', 'real'), { recursive: true });
      mkdirSync(join(fixture.target, 'data', 'alias'));
      copyFileSync(join(fixture.project, 'data', 'real', 'large'), join(fixture.target, 'data', 'real', 'large'));
      writeBrief(['---', 'inputs: [data]', '---', '# Goal', 'Read the inputs.']);
      const report = await runShipSetup(setupArgs(), {
        createWorktree: successfulGit(), runValidationCommand: validationRunner(),
        runGitCommand: () => ({ exitCode: 1 }),
      });
      expect(report.state).toBe('refused');
      expect(report.blockers[0].reason).toContain('before copying 12 bytes');
      expect(readFileSync(log, 'utf8')).toBe('12\n');
      expect(existsSync(join(fixture.target, 'data', 'new'))).toBe(false);
      expect(existsSync(join(fixture.target, 'data', 'alias', 'large'))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses an external output inside the launch target before creating it', async () => {
    const path = join(fixture.target, 'runs', 'results');
    writeBrief(['---', 'outputs:', `  - path: ${path}`, '    type: directory', '---', '# Goal', 'Retain results.']);
    const git = successfulGit();
    const report = await runShipSetup(setupArgs(), { createWorktree: git, runValidationCommand: validationRunner() });
    expect(report.state).toBe('refused');
    expect(report.sourceOutputInventory.blocking[0].reason).toContain('overlaps project');
    expect(git).not.toHaveBeenCalled();
    expect(existsSync(fixture.target)).toBe(false);
  });

  it.each([false, true])('checks source-overlapping outputs at setup and runtime (in-place=%s)', async inPlace => {
    const path = join(fixture.project, 'data', 'results');
    writeBrief(['---', 'outputs:', `  - path: ${path}`, '    type: directory', '---', '# Goal', 'Retain results.']);
    const git = successfulGit();
    const target = inPlace ? fixture.project : fixture.target;
    const args = setupArgs();
    args[args.indexOf('--target') + 1] = target;
    const report = await runShipSetup(args, { createWorktree: git, runValidationCommand: validationRunner() });
    expect(report.state).toBe(inPlace ? 'refused' : 'ready');
    expect(report.sourceOutputInventory.blocking).toHaveLength(inPlace ? 1 : 0);
    expect(git).toHaveBeenCalledTimes(inPlace ? 0 : 1);
    expect(existsSync(path)).toBe(false);
    const run = createRun(target, 'external-output', 'name: fixture\nstages: []\n', ['work']);
    writeFileSync(join(run.runDirPath, 'task_brief.md'), readFileSync(fixture.brief));
    const input = { projectDir: target, runDir: run.runDirPath, stageId: 'work',
      artifactContract: { version: 1 as const, produces: [], reads: [], groups: [] } };
    const action = vi.fn(async () => execWithStdin(process.execPath, ['-e', `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(path)},{recursive:true});fs.writeFileSync(${JSON.stringify(join(path, 'result.txt'))},'result');`], '', { cwd: target, timeout_ms: 5000 }));
    if (inPlace) {
      await expect(withEngineIntegrity(input, action)).rejects.toThrow('overlaps project');
      expect(action).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
    } else {
      expect(report.targetOutputInventory?.blocking).toHaveLength(0);
      const result = await withEngineIntegrity(input, action);
      expect(result.exitCode, result.output).toBe(0);
      expect(readFileSync(join(path, 'result.txt'), 'utf8')).toBe('result');
    }
  });

  it.each([false, true])('reports external outputs in setup (forbidden=%s) without creating the durable root', async forbidden => {
    const path = join(forbidden ? fixture.state : fixture.root, 'durable-results');
    writeBrief(['---', 'outputs:', `  - path: ${path}`, '    type: directory', '---', '# Goal', 'Retain per-item results.']);
    const git = successfulGit();
    const report = await runShipSetup(setupArgs(), { createWorktree: git, runValidationCommand: validationRunner() });
    expect(report.state).toBe(forbidden ? 'refused' : 'ready');
    expect(report.sourceOutputInventory.entries).toMatchObject([{
      path, blocking: forbidden, reason: expect.stringContaining(forbidden ? 'FC_HOME/run storage' : 'not inventoried or archived'),
    }]);
    if (!forbidden) expect(report.targetOutputInventory?.entries[0].blocking).toBe(false);
    expect(git).toHaveBeenCalledTimes(forbidden ? 0 : 1);
    expect(existsSync(path)).toBe(false);
  });

  it('H4 times worktree add from config, reports progress, and rolls back owned failure residue', async () => {
    setEngineDefaults({ default_timeout_ms: 60000, git_worktree_add_timeout_ms: 1800000 });
    writeBrief(['# Goal', 'Create an isolated worktree.']);
    const stderr = new Capture();
    const calls: string[][] = [];
    const baseOid = '0123456789012345678901234567890123456789';
    let showRefChecks = 0;
    const runner = vi.fn<GitCommandRunner>((request) => {
      calls.push([...request.args]);
      if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${baseOid}\n` };
      if (request.args[0] === 'show-ref') {
        showRefChecks++;
        return { exitCode: showRefChecks === 1 ? 1 : 0 };
      }
      if (request.args[0] === 'update-ref') return { exitCode: 0 };
      if (request.args[0] === 'worktree' && request.args[1] === 'add') {
        const configured = request as GitCommandRequest & {
          timeoutMs?: number;
          onProgress?: (progress: { elapsedMs: number; message: string }) => void;
        };
        expect(configured.timeoutMs).toBe(1_800_000);
        configured.onProgress?.({ elapsedMs: 61_000, message: 'git worktree add still running' });
        mkdirSync(fixture.target, { recursive: true });
        writeFileSync(join(fixture.target, '.git'), 'gitdir: fixture-owned-worktree\n');
        return { exitCode: null, error: 'Git ended by signal SIGTERM' };
      }
      if (request.args.slice(0, 3).join(' ') === 'worktree list --porcelain') {
        return {
          exitCode: 0,
          stdout: [
            `worktree ${fixture.target}`,
            `HEAD ${baseOid}`,
            'branch refs/heads/autonomous-result',
            '',
          ].join('\0'),
        };
      }
      if (request.args[0] === 'worktree' && request.args[1] === 'remove') {
        rmSync(fixture.target, { recursive: true, force: true });
        return { exitCode: 0 };
      }
      if (request.args[0] === 'branch' && request.args[1] === '-D') return { exitCode: 0 };
      return { exitCode: 0 };
    });

    const report = await runShipSetup(setupArgs(), {
      runGitCommand: runner,
      stderr: stderr.writer,
    });

    expect(report.state).toBe('refused');
    expect(stderr.value).toContain('git worktree add still running');
    expect(existsSync(fixture.target)).toBe(false);
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '--', fixture.target]);
    expect(calls).toContainEqual(['update-ref', '-d', 'refs/heads/autonomous-result', baseOid]);

    mkdirSync(fixture.target, { recursive: true });
    const sentinel = join(fixture.target, 'foreign.txt');
    writeFileSync(sentinel, 'not created by this invocation\n');
    const preExisting = await runShipSetup(setupArgs(), { runGitCommand: runner });
    // The mocked git lists this directory as the branch's worktree at the base, so setup reuses it without touching it.
    expect(preExisting.state).toBe('ready');
    expect(readFileSync(sentinel, 'utf8')).toBe('not created by this invocation\n');

    rmSync(fixture.target, { recursive: true, force: true });
    let deletedConcurrentBranch = false;
    let raceShowRefChecks = 0;
    const branchRaceRunner = vi.fn<GitCommandRunner>((request) => {
      if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${baseOid}\n` };
      if (request.args[0] === 'update-ref' && request.args[1] !== '-d') {
        return { exitCode: 128, stderr: 'cannot lock ref: reference already exists' };
      }
      if (request.args[0] === 'show-ref') {
        raceShowRefChecks++;
        return { exitCode: raceShowRefChecks === 1 ? 1 : 0 };
      }
      if (request.args[0] === 'worktree' && request.args[1] === 'add') {
        return { exitCode: 128, stderr: 'fatal: a branch named autonomous-result already exists' };
      }
      if (request.args.slice(0, 3).join(' ') === 'worktree list --porcelain') {
        return { exitCode: 0, stdout: '' };
      }
      if ((request.args[0] === 'branch' && request.args[1] === '-D')
          || (request.args[0] === 'update-ref' && request.args[1] === '-d')) {
        deletedConcurrentBranch = true;
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    });
    const branchRace = await runShipSetup(setupArgs(), { runGitCommand: branchRaceRunner });
    expect(branchRace.state).toBe('refused');
    expect(deletedConcurrentBranch).toBe(false);

    const targetRaceFs = {
      ...nodeShipSetupFileSystem,
      createDirectoryExclusive(path: string): void {
        if (path !== fixture.target) {
          nodeShipSetupFileSystem.createDirectoryExclusive(path);
          return;
        }
        mkdirSync(fixture.target, { recursive: true });
        writeFileSync(join(fixture.target, 'foreign.txt'), 'concurrent owner\n');
        const error = new Error('target appeared concurrently') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
    };
    const targetRaceRunner = vi.fn<GitCommandRunner>((request) => (
      request.args[0] === 'rev-parse'
        ? { exitCode: 0, stdout: `${baseOid}\n` }
        : { exitCode: 0 }
    ));
    const targetRace = await runShipSetup(setupArgs(), {
      fs: targetRaceFs,
      runGitCommand: targetRaceRunner,
    });
    expect(targetRace.state).toBe('refused');
    expect(readFileSync(join(fixture.target, 'foreign.txt'), 'utf8')).toBe('concurrent owner\n');
    expect(targetRaceRunner.mock.calls.some(([request]) => request.args[0] === 'worktree')).toBe(false);
  });

  it('H5 blocks only frontmatter inputs and accepts a base-ref-only declared input', async () => {
    writeBrief([
      '---',
      'inputs:',
      '  - base/only.txt',
      '---',
      '# Context',
      'The historical module is `prose/missing.ts`.',
    ]);
    const gitRunner = vi.fn<GitCommandRunner>((request) => {
      if (request.args[0] === 'cat-file') {
        return { exitCode: request.args.at(-1) === 'release-base:base/only.txt' ? 0 : 1 };
      }
      return { exitCode: 0 };
    });
    const createWorktree = successfulGit((request) => {
      mkdirSync(join(request.targetDir, 'base'), { recursive: true });
      writeFileSync(join(request.targetDir, 'base', 'only.txt'), 'from release base\n');
    });

    const accepted = await runShipSetup(setupArgs(), {
      createWorktree,
      runGitCommand: gitRunner,
      runValidationCommand: validationRunner(),
    });

    expect(accepted.state).toBe('ready');
    expect(accepted.sourceVerification.inputs).toEqual([
      expect.objectContaining({
        path: 'base/only.txt',
        sourceExists: false,
        baseRefExists: true,
      }),
    ]);
    expect(gitRunner).toHaveBeenCalledWith(expect.objectContaining({
      args: ['cat-file', '-e', 'release-base:base/only.txt'],
    }));

    rmSync(fixture.target, { recursive: true, force: true });
    writeBrief(['---', 'inputs: [base/absent.txt]', '---', '# Goal']);
    const refused = await runShipSetup(setupArgs(), {
      createWorktree,
      runGitCommand: gitRunner,
    });
    expect(refused).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'source',
        input: 'base/absent.txt',
        reason: expect.stringContaining('source working tree'),
      })],
    });
    expect(refused.state === 'refused' && refused.blockers[0].reason).toContain('base ref release-base');
  });

  it('refuses an occupied create-only output before creating a worktree', async () => {
    mkdirSync(join(fixture.project, 'docs'), { recursive: true });
    writeFileSync(join(fixture.project, 'docs', 'research-result.json'), 'x'.repeat(286 * 1024));
    writeBrief([
      '---',
      'outputs:',
      '  - path: docs/research-result.json',
      '---',
      '# Goal',
      'Produce a fresh research result.',
    ]);
    const git = successfulGit();

    const report = await runShipSetup(setupArgs(), { createWorktree: git });

    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: false,
      sourceOutputInventory: {
        blocking: [expect.objectContaining({
          path: 'docs/research-result.json', size: 286 * 1024,
        })],
      },
      blockers: [expect.objectContaining({
        phase: 'source', input: 'docs/research-result.json', reason: expect.stringContaining('create-only output'),
      })],
    });
    expect(git).not.toHaveBeenCalled();
  });

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

  it('creates the exact base and branch, copies only absent declared ignored inputs, rechecks them, and atomically records a delta baseline', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const prices = 'timestamp,price\n2022-01-01,10\n2022-01-03,12\n';
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), prices, 'utf-8');
    mkdirSync(join(fixture.project, 'node_modules', 'revision-generator'), { recursive: true });
    writeFileSync(join(fixture.project, 'node_modules', 'revision-generator', 'alpha.js'), 'export {};\n', 'utf-8');
    writeFileSync(join(fixture.project, 'node_modules', 'revision-generator', 'beta.js'), 'export {};\n', 'utf-8');
    const digest = createHash('sha256').update(prices).digest('hex');
    writeBrief([
      '---',
      'inputs:',
      '  - package.json',
      '  - path: data/frozen.csv',
      '    rows: 2',
      '    span: 2022-01-01 .. 2022-01-03',
      `    sha256: ${digest}`,
      `  - path: ${IGNORED_MODULE_PATH}/`,
      '    files: 2',
      '---',
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
    expect(lstatSync(linkedFile).isSymbolicLink()).toBe(false);
    expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkedFile, 'utf8')).toBe(prices);
    expect(readFileSync(join(linkedDirectory, 'alpha.js'), 'utf8')).toBe('export {};\n');
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
      links: [],
      copies: [
        expect.objectContaining({ path: 'data/frozen.csv' }),
        expect.objectContaining({ path: `${IGNORED_MODULE_PATH}/alpha.js` }),
        expect.objectContaining({ path: `${IGNORED_MODULE_PATH}/beta.js` }),
      ],
    });
    expect(record.sourceVerification.inputs).toHaveLength(3);
    expect(record.targetVerification.inputs).toHaveLength(3);
    expect(record.validationBaseline.results).toContainEqual(expect.objectContaining({
      role: 'test', state: 'failed', exitCode: 1, failureCount: 1,
    }));
    expect(record.validationBaseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'test', rule: 'no_regression_from_baseline', baselineFailureCount: 1,
    }));
  });

  it('executes and records both configured test commands for a mixed JavaScript/Python project', async () => {
    const python = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({ scripts: { test: 'check' } }));
    writeFileSync(join(fixture.project, 'pyproject.toml'), python);
    writeBrief(['# Goal', 'Validate both project environments.']);
    const runner = validationRunner();
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(request => writeFileSync(join(request.targetDir, 'pyproject.toml'), python)),
      runValidationCommand: runner,
    });
    expect(report.state).toBe('ready');
    expect(runner.mock.calls.map(([request]) => [request.display, request.cwd]))
      .toEqual([['npm run test', fixture.target], ['python -m pytest', fixture.target]]);
    expect(report.validationBaseline?.gateCriteria.filter(criterion => criterion.role === 'test')).toHaveLength(2);
  });

  it.each([
    ['TAP version 13\nok 1 - passes\nnot ok 2 - fails\n1..2', 'known', ['fails']],
    ['custom runner stopped', 'unknown', []],
  ])('retains target red baseline failure evidence and its delta rule (%s)', async (output, identity, failures) => {
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({ scripts: { test: 'custom-test-runner' } }));
    writeBrief(['# Goal', 'Record existing test failures.']);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 1, stdout: output as string }));
    const report = await runShipSetup(setupArgs(), { createWorktree: successfulGit(), runValidationCommand: runner });
    expect(report).toMatchObject({ state: 'ready', validationBaseline: {
      results: expect.arrayContaining([expect.objectContaining({ role: 'test', state: 'failed', exitCode: 1,
        failureIdentity: identity, failureIdentifiers: failures })]),
      gateCriteria: expect.arrayContaining([expect.objectContaining({ role: 'test', rule: 'no_regression_from_baseline' })]),
    } });
    expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'test', cwd: fixture.target }));
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

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: baseline,
    });

    expect(report).toMatchObject({
      state: 'ready',
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

  it('refuses a brief without criteria before creating a worktree', async () => {
    writeFileSync(fixture.brief, '# Goal\nProduce a deliverable.\n');
    const git = successfulGit();
    const runner = validationRunner();
    const report = await runShipSetup(setupArgs(), { createWorktree: git, runValidationCommand: runner });
    expect(report).toMatchObject({ state: 'refused', worktreeCreated: false,
      blockers: [expect.objectContaining({ reason: expect.stringContaining('No structurally extractable criterion') })] });
    expect(git).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
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

  it('reaches READY without engine validation when no command can be inferred and none is declared', async () => {
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
      state: 'ready',
      validationBaseline: {
        discovery: { state: 'unknown', commands: [] },
        results: [
          expect.objectContaining({ role: 'build', state: 'not_configured', reason: expect.stringContaining('No recognized') }),
          expect.objectContaining({ role: 'test', state: 'not_configured' }),
          expect.objectContaining({ role: 'lint', state: 'not_configured' }),
        ],
      },
      blockers: [],
    });
    expect(noReadyRecord()).toBe(false);
  });

  it('defaults the source project to the injected current directory and reports human-readable delta criteria', async () => {
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
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
    writeBrief(['---', 'inputs: [{path: data/missing.csv, rows: 2}]', '---', '# Goal', 'Use the declared input.']);
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

  it('refuses unreadable source evidence through the injected filesystem seam', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const input = join(fixture.project, 'data', 'locked.csv');
    writeFileSync(input, 'id\n1\n', 'utf-8');
    writeBrief(['---', 'inputs: [{path: data/locked.csv}]', '---', '# Goal', 'Use the declared input.']);
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

  it('refuses when an ignored input cannot be copied, and never runs or records the baseline', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n', 'utf-8');
    writeBrief(['---', 'inputs: [{path: data/frozen.csv, rows: 1}]', '---', '# Goal', 'Use the declared input.']);
    const runner = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
      fs: {
        ...nodeShipSetupFileSystem,
        copyFile: () => { throw new Error('copy denied by fixture'); },
      },
    });

    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      blockers: [expect.objectContaining({
        phase: 'target', input: 'data/frozen.csv', reason: expect.stringContaining('copy denied by fixture'),
      })],
    });
    expect(runner).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('compares copied bytes through the target and refuses a corrupted input', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n2\n', 'utf-8');
    writeBrief(['---', 'inputs: [{path: data/frozen.csv, rows: 2}]', '---', '# Goal', 'Use the declared input.']);
    const copyInput = vi.fn((_: string, target: string) => {
      writeFileSync(target, 'id\n1\n', 'utf-8');
    });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
      fs: { ...nodeShipSetupFileSystem, copyFile: copyInput },
    });

    expect(copyInput).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      state: 'refused',
      worktreeCreated: true,
      blockers: [expect.objectContaining({
        phase: 'target', input: 'data/frozen.csv', reason: expect.stringContaining('does not match the declared source bytes'),
      })],
    });
    expect(noReadyRecord()).toBe(true);
  });

  it('does not overwrite an existing target or an existing tracked input', async () => {
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
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
    writeBrief(['---', 'inputs: [{path: data/tracked.csv, rows: 2}]', '---', '# Goal', 'Use the declared input.']);
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
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
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

  it('refuses a declared target directory that resolves outside the worktree', async () => {
    mkdirSync(join(fixture.project, 'checks'));
    writeFileSync(join(fixture.project, 'checks', 'private.test.ts'), 'export {};\n');
    writeBrief(['---', 'inputs: [checks]', '---', '# Goal', 'Run the declared checks.']);
    const outside = join(fixture.root, 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel.txt'), 'unchanged\n');
    const git = successfulGit((request) => {
      symlinkSync(outside, join(request.targetDir, 'checks'), 'dir');
    });
    const baseline = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: baseline,
    });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'target',
        input: 'checks',
        reason: 'Existing declared target input resolves outside the worktree; recreate the target to materialize target-owned inputs',
      })],
    });
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf-8')).toBe('unchanged\n');
    expect(baseline).not.toHaveBeenCalled();
    expect(noReadyRecord()).toBe(true);
  });

  it('blocks a target parent that canonicalizes outside the worktree', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'frozen.csv'), 'id\n1\n', 'utf-8');
    writeBrief(['---', 'inputs: [{path: data/frozen.csv, rows: 1}]', '---', '# Goal', 'Use the declared input.']);
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
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
    const runner = validationRunner();
    const writeAtomic = vi.fn(() => { throw new Error('state volume unavailable'); });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
      fs: { ...nodeShipSetupFileSystem, writeAtomic },
    });

    expect(runner).toHaveBeenCalledTimes(3);
    // The ready write fails, then the fail-closed path makes one best-effort
    // attempt to persist the distinct refused outcome for launch diagnostics.
    expect(writeAtomic).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      state: 'refused',
      validationBaseline: { version: 1 },
      blockers: expect.arrayContaining([
        expect.objectContaining({ phase: 'record', reason: expect.stringContaining('ready record') }),
        expect.objectContaining({ phase: 'record', reason: expect.stringContaining('refused setup record') }),
      ]),
    });
    expect(noReadyRecord()).toBe(true);
    expect(report.blockers[0].repair).toMatch(/restore|choose|retry|writable/i);
  });

  it.each([
    { exitCode: null, error: 'spawn validation ENOENT' },
    { exitCode: 127, stderr: 'sh: validation-tool: command not found' },
    { exitCode: 1, stderr: '/usr/bin/python: No module named pytest' },
  ])('records unmeasurable inferred baselines as environment gaps: %j', async response => {
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
    const runner = vi.fn<ValidationCommandRunner>(() => response);
    const report = await runShipSetup(setupArgs(), { createWorktree: successfulGit(), runValidationCommand: runner });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(report).toMatchObject({ state: 'ready', blockers: [], validationBaseline: {
      results: expect.arrayContaining([expect.objectContaining({ role: 'test', failureIdentity: 'unknown',
        output: expect.stringContaining(response.stderr ?? ''), reason: expect.any(String) })]),
    } });
    expect(noReadyRecord()).toBe(false);
  });

  it('reports a missing inferred pytest module as an environment gap at setup', async () => {
    writeBrief(['# Goal', 'Change the project.']);
    const stdout = new Capture();
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 1, stderr: '/usr/bin/python: No module named pytest' }));
    const code = await cmdShipSetupWithDeps(setupArgs(), {
      createWorktree: successfulGit(), runValidationCommand: runner, stdout: stdout.writer,
    });
    expect(code).toBe(0);
    expect(stdout.value).toContain('test: ENVIRONMENT GAP exit=1');
    expect(noReadyRecord()).toBe(false);
  });

  it('refuses an unidentifiable brief-declared failure as unmeasurable', async () => {
    rmSync(join(fixture.project, 'package.json'));
    rmSync(join(fixture.project, 'package-lock.json'));
    writeBrief(['---', 'validation:', '  commands:', '    test:', '      command: python',
      '      args: [-m, pytest]', '---', '# Goal', 'Measure the declared tests.']);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 1, stderr: '/usr/bin/python: No module named pytest' }));
    const report = await runShipSetup(setupArgs(), {
      createWorktree: request => { mkdirSync(request.targetDir, { recursive: true }); return { exitCode: 0 }; },
      runValidationCommand: runner,
    });
    expect(report).toMatchObject({ state: 'refused', blockers: [expect.objectContaining({
      phase: 'validation', reason: expect.stringContaining(`${fixture.brief}#validation.commands.test`),
    })] });
    expect(noReadyRecord()).toBe(true);
  });

  it('records a project command that cannot run here while the others run, and reaches READY', async () => {
    writeBrief(['---', 'inputs: [{path: package.json}]', '---', '# Goal', 'Use the declared input.']);
    const runner = vi.fn<ValidationCommandRunner>(({ role }) => role === 'test'
      ? { exitCode: 127, stderr: 'sh: karma: command not found' }
      : { exitCode: 0, stdout: 'ok' });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: runner,
    });

    expect(report).toMatchObject({
      state: 'ready',
      blockers: [],
      validationBaseline: {
        results: expect.arrayContaining([
          expect.objectContaining({ role: 'build', state: 'passed' }),
          expect.objectContaining({ role: 'test', state: 'launch_error', exitCode: 127 }),
        ]),
      },
    });
    expect(noReadyRecord()).toBe(false);
  });

  it('records a tox.ini-inferred runner that is not installed here as a gap, and reaches READY', async () => {
    rmSync(join(fixture.project, 'package.json'));
    rmSync(join(fixture.project, 'package-lock.json'));
    writeFileSync(join(fixture.project, 'tox.ini'), '[testenv]\ncommands = python tests/runtests.py\n', 'utf-8');
    writeBrief(['# Goal', 'Change the project.']);
    const git = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      copyFileSync(join(request.projectDir, 'tox.ini'), join(request.targetDir, 'tox.ini'));
      return { exitCode: 0 };
    });
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: null, error: 'spawn tox ENOENT' }));

    const report = await runShipSetup(setupArgs(), { createWorktree: git, runValidationCommand: runner });

    expect(report).toMatchObject({
      state: 'ready',
      blockers: [],
      validationBaseline: { results: expect.arrayContaining([expect.objectContaining({ role: 'test', state: 'launch_error' })]) },
    });
    expect(noReadyRecord()).toBe(false);
  });

  it('materializes a bare directory named in the explicit inputs list', async () => {
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
    expect(report.copies).toContainEqual(expect.objectContaining({
      path: 'dependency_cache/tool.js',
    }));
    expect(lstatSync(join(fixture.target, 'dependency_cache')).isSymbolicLink()).toBe(false);
  });

  it('refuses a destination link introduced immediately before copying an input', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'a.txt'), 'source bytes');
    const outside = join(fixture.root, 'engine-carrier.json');
    writeFileSync(outside, 'protected bytes');
    writeBrief(['---', 'inputs: [data]', '---', '# Goal', 'Read the stable input.']);
    const runner = validationRunner();
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(request => { mkdirSync(join(request.targetDir, 'data')); }),
      runValidationCommand: runner,
      fs: { ...nodeShipSetupFileSystem, copyFile: (source, target) => {
        symlinkSync(outside, target);
        nodeShipSetupFileSystem.copyFile(source, target);
      } },
    });
    expect(report.state).toBe('refused');
    expect(readFileSync(outside, 'utf8')).toBe('protected bytes');
    expect(runner).not.toHaveBeenCalled();
  });

  it('preserves internal dependency links within the prepared target', async () => {
    mkdirSync(join(fixture.project, 'tools', '.bin'), { recursive: true });
    mkdirSync(join(fixture.project, 'tools', 'pkg'));
    writeFileSync(join(fixture.project, 'tools', 'pkg', 'tool.js'), 'export {};');
    symlinkSync('../pkg/tool.js', join(fixture.project, 'tools', '.bin', 'tool'));
    writeBrief(['---', 'inputs: [tools]', '---', '# Goal', 'Read the dependency tree.']);
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(), runValidationCommand: validationRunner(),
    });
    expect(report.state).toBe('ready');
    expect(lstatSync(join(fixture.target, 'tools', '.bin', 'tool')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(fixture.target, 'tools', '.bin', 'tool'))).toBe(join(fixture.target, 'tools', 'pkg', 'tool.js'));
    expect(readFileSync(join(fixture.target, 'tools', '.bin', 'tool'), 'utf8')).toBe('export {};');
  });

  it.each([false, true])('compares large declared input bytes without whole-file reads (existing=%s)', async existing => {
    const source = join(fixture.project, 'data', 'records.bin');
    const target = join(fixture.target, 'data', 'records.bin');
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const contents = Buffer.alloc(1024 * 1024 + 13, 91);
    writeFileSync(source, contents);
    writeBrief(['---', 'inputs: [data/records.bin]', '---', '# Goal', 'Read the declared dataset.']);
    const readBytes = vi.fn((path: string) => {
      if (path === source || path === target) throw new Error('whole-file input read');
      return nodeShipSetupFileSystem.readBytes(path);
    });
    const runner = validationRunner();
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(request => {
        if (existing) {
          mkdirSync(join(request.targetDir, 'data'));
          copyFileSync(source, target);
        }
      }),
      runValidationCommand: runner,
      fs: { ...nodeShipSetupFileSystem, readBytes },
    });
    expect(report.state, JSON.stringify(report.blockers)).toBe('ready');
    expect(readFileSync(target).equals(contents)).toBe(true);
    expect(readBytes.mock.calls.some(([path]) => path === source || path === target)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('does not blame materialization for an independent source membership update', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'a.txt'), 'A');
    writeBrief(['---', 'inputs: [data]', '---', '# Goal', 'Read the stable input.']);
    const runner = validationRunner();
    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(request => { mkdirSync(join(request.targetDir, 'data')); }),
      runValidationCommand: runner,
      fs: { ...nodeShipSetupFileSystem, copyFile: (source, target) => {
        nodeShipSetupFileSystem.copyFile(source, target);
        writeFileSync(join(fixture.project, 'data', 'added.txt'), 'new member');
      } },
    });
    expect(report.state).toBe('ready');
    expect(readFileSync(join(fixture.target, 'data', 'a.txt'), 'utf8')).toBe('A');
    expect(existsSync(join(fixture.target, 'data', 'added.txt'))).toBe(false);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('reconciles missing descendants when a declared directory already has tracked target content', async () => {
    writeDirectoryFixture();
    writeBrief([
      '---',
      'inputs:',
      '  - checks',
      '---',
      '# Goal',
      'Materialize the declared directory.',
    ]);
    const baseline = validationRunner();

    const report = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(copyDirectoryTrackedFiles),
      runValidationCommand: baseline,
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
    expect(baseline).toHaveBeenCalledTimes(3);
  });

  it('refuses a content collision inside a declared directory without overwriting the target', async () => {
    writeDirectoryFixture();
    writeBrief([
      '---',
      'inputs:',
      '  - checks',
      '---',
      '# Goal',
      'Materialize the declared directory.',
    ]);
    const baseline = validationRunner();
    const git = successfulGit((request) => {
      copyDirectoryTrackedFiles(request);
      writeFileSync(
        join(request.targetDir, 'checks', 'fixtures', 'published.test.ts'),
        'export const published = false;\n',
      );
    });

    const report = await runShipSetup(setupArgs(), {
      createWorktree: git,
      runValidationCommand: baseline,
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
    const firstBrief = '# Goal\nMeasure the first brief.\n## Requirements\n1. Report the first measurement.\n';
    writeFileSync(fixture.brief, firstBrief, 'utf-8');
    const first = await runShipSetup(setupArgs(), {
      createWorktree: successfulGit(),
      runValidationCommand: validationRunner(),
    });
    expect(first.state).toBe('ready');
    if (first.state !== 'ready') throw new Error('first setup unexpectedly refused');

    rmSync(fixture.target, { recursive: true, force: true });
    const secondBrief = '# Goal\nMeasure a substantively different second brief.\n## Requirements\n1. Report the second measurement.\n';
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
