import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_MANIFEST_FILENAME, createBuildManifest } from '../src/build-manifest.js';
import {
  cmdShipPreflightWithDeps,
  collectShipPreflight,
  extractBriefInputPaths,
  prepareValidationWriteGuard,
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import {
  extractBriefPathMentions,
  extractDeclaredBriefInputPaths,
  parseBriefInputs,
  verifyDeclaredBriefInputs,
} from '../src/ship-inputs.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { runValidationCommand, runProjectValidationBaseline, type ValidationCommandRunner } from '../src/project-validation.js';

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

interface Fixture {
  root: string;
  project: string;
  packageRoot: string;
  stateRoot: string;
}

let previousStateRoot: string;
let fixture: Fixture;

beforeAll(() => {
  previousStateRoot = fcGlobalDir();
});

beforeEach(() => {
  // Canonicalize the fixture root: on macOS the temp directory is reached through a
  // symlink (/var -> /private/var), so an uncanonicalized root makes every derived
  // path differ from what the code under test computes. Reproducible on Linux by
  // pointing TMPDIR at a symlink.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-ship-preflight-')));
  fixture = {
    root,
    project: join(root, 'project'),
    packageRoot: join(root, 'package'),
    stateRoot: join(root, 'state'),
  };
  mkdirSync(join(fixture.project, 'config'), { recursive: true });
  mkdirSync(join(fixture.packageRoot, 'src'), { recursive: true });
  mkdirSync(join(fixture.packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(fixture.packageRoot, 'src', 'probe.ts'), 'export const probe = true;\n', 'utf-8');
  writeFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'export const probe = true;\n', 'utf-8');
  writeFileSync(join(fixture.packageRoot, 'dist', 'probe.d.ts'), 'export declare const probe = true;\n', 'utf-8');
  writeFileSync(join(fixture.packageRoot, 'tsconfig.json'), '{}\n', 'utf-8');
  const manifest = createBuildManifest(fixture.packageRoot, join(fixture.packageRoot, 'dist'));
  writeFileSync(
    join(fixture.packageRoot, 'dist', BUILD_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
  const older = new Date(1_000);
  const newer = new Date(2_000);
  utimesSync(join(fixture.packageRoot, 'src', 'probe.ts'), older, older);
  utimesSync(join(fixture.packageRoot, 'dist', 'probe.js'), newer, newer);
  setFcGlobalDir(fixture.stateRoot);
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(previousStateRoot);
});

function commonDeps(overrides: ShipPreflightDependencies = {}): ShipPreflightDependencies {
  return {
    projectDir: fixture.project,
    packageRoot: fixture.packageRoot,
    readGitCommonDir: () => '.git',
    readCampaignEntries: () => [],
    // These fact/dispatch tests use mock runners. Enforcement cases below use
    // the production guard and real descendants instead of this test seam.
    prepareValidationWriteGuard: () => ({ wrap: (request) => request, cleanup: () => {} }),
    probeDaemon: async (): Promise<DaemonLoadedBuildProbe> => ({
      state: 'fresh', loadedBuild: 'same', diskBuild: 'same',
    }),
    ...overrides,
  };
}

function writeRun(id: string, state: Record<string, unknown>, mtime: number): string {
  const runPath = join(fixture.stateRoot, 'runs', id);
  mkdirSync(runPath, { recursive: true });
  const statePath = join(runPath, 'run.json');
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf-8');
  const timestamp = new Date(mtime);
  utimesSync(statePath, timestamp, timestamp);
  return runPath;
}

describe('live engine distribution validation boundary', () => {
  const consumers = [{ pid: 4242, kind: 'process' as const, label: 'fixture live engine process' }];

  function configureValidation(project: string): void {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      scripts: { build: 'node build-dist.mjs', test: 'node check.mjs', lint: 'node style.mjs' },
    }));
    writeFileSync(join(project, 'package-lock.json'), '{}\n');
    // The guard must stop this real dist-writing recipe before command one.
    writeFileSync(join(project, 'build-dist.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("dist/probe.js", "replacement engine build");\n');
  }

  it('keeps consumers visible while validating an independent Python project', async () => {
    writeFileSync(join(fixture.project, 'Makefile'), 'build:\n\tpython3 -m compileall -q package\ntest:\n\tpython3 -m pytest tests -q\nlint:\n\tpython3 -m compileall -q tests\n');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, durationMs: 1, stdout: 'fixture passed\n' }));
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      findDistConsumers: () => consumers, runValidationCommand: runner,
    }));
    expect(result.report.liveDistConsumers).toEqual(consumers);
    expect(runner).not.toHaveBeenCalled();
    expect(result.report.validationBaseline.execution).toBe('skipped');
  });

  it('keeps unrelated validation independent when the consumed dist directory is absent', async () => {
    rmSync(join(fixture.packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(fixture.project, 'Makefile'), 'build:\n\tpython3 -m compileall -q package\ntest:\n\tpython3 -m pytest tests -q\nlint:\n\tpython3 -m compileall -q tests\n');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'passed' }));
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      findDistConsumers: () => consumers, runValidationCommand: runner,
    }));
    expect(result.report.liveDistConsumers).toEqual(consumers);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['absolute', 'relative', 'alias', 'make-cd', 'output-alias', 'quoted-shell'])(
    'collects separate-project %s delegation facts without launching a command', async (form) => {
      configureValidation(fixture.packageRoot);
      let build = `npm --prefix "${fixture.packageRoot}" run build`;
      if (form === 'quoted-shell') build = `sh -c 'npm --prefix ${fixture.packageRoot} run build'`;
      if (form === 'relative') build = 'npm --prefix=../package run build';
      if (form === 'alias') {
        const alias = join(fixture.root, 'linked-engine');
        symlinkSync(fixture.packageRoot, alias, 'dir');
        build = `npm --prefix "${alias}" run build`;
      }
      if (form === 'output-alias') {
        symlinkSync(join(fixture.packageRoot, 'dist'), join(fixture.project, 'generated'), 'dir');
        build = 'tsc --outDir=generated/new-build';
      }
      if (form === 'make-cd') {
        writeFileSync(join(fixture.project, 'Makefile'), 'build:\n\tcd ../package && npm run build\ntest:\n\tpython3 -m pytest tests -q\nlint:\n\tpython3 -m compileall -q tests\n');
      } else {
        writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
          scripts: { build, test: 'node check.mjs', lint: 'node style.mjs' },
        }));
        writeFileSync(join(fixture.project, 'package-lock.json'), '{}\n');
      }
      const before = readFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'utf-8');
      const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'must not run' }));
      const stderr = new Capture();
      const deps = commonDeps({
        findDistConsumers: () => consumers, runValidationCommand: runner,
        stdout: new Capture().writer, stderr: stderr.writer,
      });
      expect(await cmdShipPreflightWithDeps(['ship-preflight'], deps)).toBe(0);
      expect(stderr.value).toContain('No project command was launched');
      expect(runner).not.toHaveBeenCalled();
      expect(readFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'utf-8')).toBe(before);
      expect(await cmdShipPreflightWithDeps(['ship-preflight', '--no-baseline'], deps)).toBe(0);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each(['own', 'ancestor', 'nested', 'project-alias', 'package-alias', 'dist-alias', 'unknown-project', 'unknown-package'])(
    'collects %s identity with live consumers without invoking a dist-writing build', async (relation) => {
      configureValidation(fixture.packageRoot);
      let project = fixture.packageRoot;
      let packageRoot = fixture.packageRoot;
      if (relation === 'ancestor') project = fixture.root;
      if (relation === 'nested') project = join(fixture.packageRoot, 'nested-project');
      if (relation === 'project-alias') {
        project = join(fixture.root, 'linked-engine');
        symlinkSync(fixture.packageRoot, project, 'dir');
      }
      if (relation === 'package-alias') {
        packageRoot = join(fixture.root, 'linked-package');
        symlinkSync(fixture.packageRoot, packageRoot, 'dir');
      }
      if (relation === 'dist-alias') {
        project = fixture.project;
        symlinkSync(join(fixture.packageRoot, 'dist'), join(project, 'dist'), 'dir');
      }
      if (relation === 'unknown-project' || relation === 'unknown-package') project = fixture.project;
      if (relation !== 'own' && relation !== 'project-alias' && relation !== 'package-alias') configureValidation(project);
      const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'must not run' }));
      const stderr = new Capture();
      const realpath = (path: string): string => {
        if ((relation === 'unknown-project' && path === resolve(project))
          || (relation === 'unknown-package' && path === resolve(packageRoot))) throw new Error('identity unavailable');
        return realpathSync.native(path);
      };
      const code = await cmdShipPreflightWithDeps(['ship-preflight', '--project', project], commonDeps({
        packageRoot, realpath, findDistConsumers: () => consumers, runValidationCommand: runner,
        stdout: new Capture().writer, stderr: stderr.writer,
      }));
      expect(code).toBe(0);
      expect(runner).not.toHaveBeenCalled();
      expect(stderr.value).toContain('No project command was launched');
    },
  );

  it('collects an independent target shared by a verified live run without executing validation', async () => {
    configureValidation(fixture.project);
    writeRun('live-target', { projectDir: fixture.project, status: 'running' }, 3_000);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'must not run' }));
    const stderr = new Capture();
    const deps = commonDeps({
      inspectLiveRun: () => true, findDistConsumers: () => consumers, runValidationCommand: runner,
      stdout: new Capture().writer, stderr: stderr.writer,
    });
    expect(await cmdShipPreflightWithDeps(['ship-preflight'], deps)).toBe(0);
    expect(stderr.value).toContain('live FlowCrew run(s): live-target');
    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--no-baseline'], deps)).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not prepare command confinement when collecting facts', async () => {
    configureValidation(fixture.project);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));
    const prepare = vi.fn(() => { throw new Error('confinement unavailable'); });
    const stderr = new Capture();
    const deps = commonDeps({
      findDistConsumers: () => consumers, runValidationCommand: runner,
      prepareValidationWriteGuard: prepare, stdout: new Capture().writer, stderr: stderr.writer,
    });
    expect(await cmdShipPreflightWithDeps(['ship-preflight'], deps)).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(stderr.value).toContain('No project command was launched');
    expect(runner).not.toHaveBeenCalled();
    prepare.mockClear();
    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--no-baseline'], deps)).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  // Unsupported hosts exercise the fail-closed case above. Only an available
  // kernel guard can exercise the real syscall/descendant controls below.
  function requireKernelGuard(context: { skip(note?: string): void }): void {
    try { prepareValidationWriteGuard(fixture.project, fixture.packageRoot).cleanup(); }
    catch { context.skip('Linux Landlock/Python 3 write confinement unavailable'); }
  }

  it.each(['imported-script', 'environment', 'make-script', 'shell-script'])(
    'denies a consumed-dist write hidden in %s without classifying the command', async (form, context) => {
      requireKernelGuard(context);
      const runtime = join(fixture.packageRoot, 'dist', 'probe.js');
      const before = readFileSync(runtime, 'utf-8');
      writeFileSync(join(fixture.project, 'target.json'), JSON.stringify({ runtime }));
      writeFileSync(join(fixture.project, 'writer.mjs'), [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const { runtime } = JSON.parse(readFileSync("target.json", "utf8"));',
        'writeFileSync(runtime, "replacement generation");',
      ].join('\n'));
      let build = 'node writer.mjs';
      if (form === 'environment') {
        // The path is loaded by executable code after dispatch, never by the
        // configured-recipe hint. Descendants inherit the kernel restriction.
        writeFileSync(join(fixture.project, 'env-writer.mjs'), [
          'import { readFileSync } from "node:fs";',
          'process.env.FIXTURE_ENGINE_OUTPUT = JSON.parse(readFileSync("target.json", "utf8")).runtime;',
          'await import("./env-child.mjs");',
        ].join('\n'));
        writeFileSync(join(fixture.project, 'env-child.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.FIXTURE_ENGINE_OUTPUT, "replacement");\n');
        build = 'node env-writer.mjs';
      }
      if (form === 'shell-script') build = 'sh -c "node writer.mjs"';
      if (form === 'make-script') {
        writeFileSync(join(fixture.project, 'Makefile'), 'build:\n\tnode writer.mjs\ntest:\n\tnode -e ""\nlint:\n\tnode -e ""\n');
      } else {
        writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({ scripts: {
          build, test: 'node -e ""', lint: 'node -e ""',
        } }));
        writeFileSync(join(fixture.project, 'package-lock.json'), '{}\n');
      }
      const stderr = new Capture();
      const guard = prepareValidationWriteGuard(fixture.project, fixture.packageRoot);
      let baseline;
      try {
        baseline = await runProjectValidationBaseline(fixture.project, { runCommand: request => runValidationCommand(guard.wrap(request)) });
      } finally { guard.cleanup(); }
      expect(baseline.results[0]).toMatchObject({ role: 'build', state: 'failed' });
      expect(baseline.results[0].output).toContain('EACCES');
      expect(baseline.results.slice(1).map(({ state }) => state)).toEqual(['passed', 'passed']);
      expect(readFileSync(runtime, 'utf-8')).toBe(before);
    },
  );

  it('allows independent project/home/temp writes while denying protected file mutations and symlink traversal', async (context) => {
    requireKernelGuard(context);
    const runtime = join(fixture.packageRoot, 'dist', 'probe.js');
    const before = readFileSync(runtime, 'utf-8');
    symlinkSync(runtime, join(fixture.project, 'output-alias'));
    writeFileSync(join(fixture.project, 'target.json'), JSON.stringify({ runtime }));
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({ scripts: {
      build: 'node mutations.mjs', test: 'node -e ""', lint: 'node -e ""',
    } }));
    writeFileSync(join(fixture.project, 'package-lock.json'), '{}\n');
    writeFileSync(join(fixture.project, 'mutations.mjs'), [
      'import fs from "node:fs"; import os from "node:os"; import path from "node:path";',
      'const { runtime } = JSON.parse(fs.readFileSync("target.json", "utf8"));',
      'const operations = { write: () => fs.writeFileSync(runtime, "changed"), truncate: () => fs.truncateSync(runtime, 0),',
      'readonlyTruncate: () => fs.closeSync(fs.openSync(runtime, fs.constants.O_RDONLY | fs.constants.O_TRUNC)),',
      'unlink: () => fs.unlinkSync(runtime), rename: () => fs.renameSync(runtime, "stolen"), link: () => fs.linkSync(runtime, "linked"),',
      'create: () => fs.writeFileSync(path.join(path.dirname(runtime), "new.js"), "changed"), alias: () => fs.writeFileSync("output-alias", "changed") };',
      'const results = {}; for (const [name, operation] of Object.entries(operations)) { try { operation(); results[name] = "ALLOWED"; } catch (error) { results[name] = error.code; } }',
      'fs.writeFileSync("denied.json", JSON.stringify(results));',
      'fs.writeFileSync(path.join(process.argv[2], "cache-write"), "ok"); fs.writeFileSync(path.join(os.tmpdir(), "temp-write"), "ok");',
      'fs.writeFileSync("independent-output", fs.readFileSync(runtime));',
    ].join('\n'));
    const runner = vi.fn<ValidationCommandRunner>((request) => {
      if (request.role !== 'build') return runValidationCommand(request);
      // Give the fixture its guard-owned home explicitly; no ambient user-home
      // lookup is needed to verify that temporary cache writes remain allowed.
      const { scratch } = JSON.parse(request.args[5]) as { scratch: string };
      return runValidationCommand({ ...request, args: [...request.args, '--', join(scratch, 'home')] });
    });
    const guard = prepareValidationWriteGuard(fixture.project, fixture.packageRoot);
    let baseline;
    try {
      baseline = await runProjectValidationBaseline(fixture.project, { runCommand: request => runner(guard.wrap(request)) });
    } finally { guard.cleanup(); }
    expect(baseline.results.map(({ state }) => state)).toEqual(['passed', 'passed', 'passed']);
    const denied = JSON.parse(readFileSync(join(fixture.project, 'denied.json'), 'utf-8')) as Record<string, string>;
    expect(Object.keys(denied)).toEqual(['write', 'truncate', 'readonlyTruncate', 'unlink', 'rename', 'link', 'create', 'alias']);
    for (const code of Object.values(denied)) expect(['EACCES', 'EPERM', 'EXDEV']).toContain(code);
    expect(readFileSync(runtime, 'utf-8')).toBe(before);
    expect(readFileSync(join(fixture.project, 'independent-output'), 'utf-8')).toBe(before);
    const payload = JSON.parse(runner.mock.calls[0][0].args[5]) as { scratch: string };
    expect(readdirSync(fixture.project)).toContain('denied.json');
    expect(() => statSync(payload.scratch)).toThrow();
  });

  it('refuses pre-existing consumed-file hard links before launching a guarded command', async (context) => {
    requireKernelGuard(context);
    configureValidation(fixture.project);
    const runtime = join(fixture.packageRoot, 'dist', 'probe.js');
    const before = readFileSync(runtime, 'utf-8');
    linkSync(runtime, join(fixture.project, 'existing-alias'));
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));
    expect(() => prepareValidationWriteGuard(fixture.project, fixture.packageRoot)).toThrow('unaccounted hard links');
    expect(runner).not.toHaveBeenCalled();
    expect(readFileSync(runtime, 'utf-8')).toBe(before);
  });
});

describe('ship-preflight previous-run fact', () => {
  it('matches canonical project paths in one runs-root pass and exposes non-clean evidence', async () => {
    const linkedProject = join(fixture.root, 'linked-project');
    symlinkSync(fixture.project, linkedProject, 'dir');
    writeRun('older-other', {
      projectDir: join(fixture.root, 'other'), status: 'complete', terminalArtifact: 'other.md',
    }, 1_000);
    const latest = writeRun('latest-match', {
      projectDir: fixture.project,
      status: 'reality_gate_failed',
      terminalArtifact: 'failure.md',
      failureReason: 'fallback reason',
    }, 3_000);
    writeFileSync(join(latest, 'terminal_failure.md'), 'Gate rejected the claimed result.\n', 'utf-8');
    writeFileSync(join(latest, '.reality-gate.json'), JSON.stringify({ pass: false, checksRun: 2 }), 'utf-8');
    mkdirSync(join(fixture.stateRoot, 'runs', 'broken'), { recursive: true });
    writeFileSync(join(fixture.stateRoot, 'runs', 'broken', 'run.json'), '{broken', 'utf-8');

    const stateRuns = join(fixture.stateRoot, 'runs');
    let rootReads = 0;
    const result = await collectShipPreflight(['ship-preflight', '--project', linkedProject], commonDeps({
      readDirectory: (path) => {
        if (path === stateRuns) rootReads += 1;
        return readdirSync(path);
      },
    }));

    expect(rootReads).toBe(1);
    expect(result.report.project.canonicalPath).toBe(fixture.project);
    expect(result.report.previousRun).toMatchObject({
      state: 'found',
      id: 'latest-match',
      status: 'reality_gate_failed',
      evidence: { source: 'terminal_artifact', text: 'Gate rejected the claimed result.\n' },
      realityGate: { source: 'artifact', evidence: { pass: false, checksRun: 2 } },
      scan: { entries: 3, readable: 2, unreadable: 1 },
    });
  });

  it('does not select another project or print failure evidence for a clean finish', async () => {
    writeRun('unrelated', { projectDir: join(fixture.root, 'other'), status: 'failed' }, 4_000);
    const absent = await collectShipPreflight(['ship-preflight'], commonDeps());
    expect(absent.report.previousRun.state).toBe('none');

    writeRun('clean', {
      projectDir: fixture.project,
      status: 'shipped',
      terminalArtifact: 'report.md',
      failureReason: 'must not be treated as failure evidence',
    }, 5_000);
    const clean = await collectShipPreflight(['ship-preflight'], commonDeps());
    expect(clean.report.previousRun).toMatchObject({ state: 'found', id: 'clean', status: 'shipped' });
    expect(clean.report.previousRun.evidence).toBeUndefined();
    expect(clean.report.previousRun.realityGate).toBeUndefined();
  });

  it('preserves and labels an unrecognized previous-run status', async () => {
    writeRun('future-status', {
      projectDir: fixture.project,
      status: 'future_archived_state',
      failureReason: 'future writer retained this evidence',
    }, 5_000);
    const output = new Capture();

    const code = await cmdShipPreflightWithDeps(
      ['ship-preflight'],
      commonDeps({ stdout: output.writer }),
    );

    expect(code).toBe(0);
    expect(output.value).toContain('Previous run: future-status — future_archived_state [UNRECOGNIZED:');
    expect(output.value).toContain('Unrecognized archived run status "future_archived_state"');
  });

  it('summarises thousands of unreadable entries without retaining or printing their names', async () => {
    const stateRuns = join(fixture.stateRoot, 'runs');
    const ids = Array.from({ length: 7_603 }, (_, index) => `entry-${index}`);
    const output = new Capture();
    const code = await cmdShipPreflightWithDeps(['ship-preflight'], commonDeps({
      stdout: output.writer,
      runsRoot: () => stateRuns,
      readDirectory: (path) => path === stateRuns ? ids : readdirSync(path),
      readText: (path) => {
        if (!path.startsWith(stateRuns)) return readFileSync(path, 'utf-8');
        const index = Number(path.match(/entry-(\d+)/)?.[1]);
        if (index < 3_026) {
          return JSON.stringify({ projectDir: join(fixture.root, 'other'), status: 'complete' });
        }
        const error = new Error('missing run state') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      stat: (path) => path.startsWith(stateRuns)
        ? { mtimeMs: 1, isDirectory: () => false, isFile: () => true }
        : statSync(path),
    }));

    expect(code).toBe(0);
    expect(output.value).toContain('3026/7603 readable, 4577 unreadable');
    expect(output.value).toContain('missing run.json 4577');
    expect(output.value).not.toContain('entry-3026');
    expect(output.value).not.toContain('Unreadable run entry');
  });
});

describe('ship-preflight campaign hygiene fact', () => {
  it('honours explicit precedence and suggests a context reset after three adverse recent endings', async () => {
    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), 'campaign: configured line\n', 'utf-8');
    const reader = vi.fn(() => [
      { seq: 1, runId: 'one', kind: 'task_started', pass: false, timestamp: 'a' },
      { seq: 2, runId: 'one', kind: 'task_ended', status: 'failed', pass: false, timestamp: 'b' },
      { seq: 3, runId: 'two', kind: 'task_ended', status: 'complete', pass: true, timestamp: 'c' },
      { seq: 4, runId: 'three', kind: 'task_ended', status: 'ceiling_hit', pass: true, timestamp: 'd' },
      { seq: 5, runId: 'four', kind: 'task_ended', status: 'stopped', pass: false, timestamp: 'e' },
    ]);

    const result = await collectShipPreflight(
      ['ship-preflight', '--campaign', 'Chosen Line'],
      commonDeps({ readCampaignEntries: reader }),
    );

    expect(reader).toHaveBeenCalledWith(fixture.project, 'chosen-line');
    expect(result.report.campaign).toMatchObject({
      state: 'resolved',
      source: 'explicit',
      storageKey: 'chosen-line',
      totalEntries: 5,
      totalEnded: 4,
      recentEnded: 4,
      recentAdverse: 3,
      suggestContextSkip: true,
    });
  });

  it('does not suggest a reset for clean history and reports malformed defaults as unknown without guessing', async () => {
    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), 'campaign: stable line\n', 'utf-8');
    const clean = await collectShipPreflight(['ship-preflight'], commonDeps({
      readCampaignEntries: () => [
        { seq: 1, runId: 'one', kind: 'task_ended', status: 'complete', pass: true, timestamp: 'a' },
        { seq: 2, runId: 'two', kind: 'task_ended', status: 'shipped', pass: true, timestamp: 'b' },
      ],
    }));
    expect(clean.report.campaign).toMatchObject({
      state: 'resolved', storageKey: 'stable-line', recentAdverse: 0, suggestContextSkip: false,
    });

    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), 'campaign: [unterminated\n', 'utf-8');
    const forbiddenReader = vi.fn(() => []);
    const unknown = await collectShipPreflight(['ship-preflight'], commonDeps({
      readCampaignEntries: forbiddenReader,
    }));
    expect(unknown.report.campaign.state).toBe('unknown');
    expect(unknown.report.campaign.reason).toContain('Cannot resolve campaign');
    expect(forbiddenReader).not.toHaveBeenCalled();
  });

  it('derives the fallback campaign from the repository main worktree', async () => {
    const mainWorktree = join(fixture.root, 'Main Repository');
    const reader = vi.fn(() => []);
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      readGitCommonDir: () => join(mainWorktree, '.git'),
      readCampaignEntries: reader,
    }));

    expect(result.report.campaign).toMatchObject({
      state: 'resolved', source: 'repository', name: 'Main Repository', storageKey: 'main-repository',
    });
    expect(reader).toHaveBeenCalledWith(fixture.project, 'main-repository');
  });

  it('treats a null defaults campaign as unset and reads the repository campaign', async () => {
    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), 'campaign: null\n', 'utf-8');
    const mainWorktree = join(fixture.root, 'main-repository');
    const reader = vi.fn(() => []);
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      readGitCommonDir: () => join(mainWorktree, '.git'),
      readCampaignEntries: reader,
    }));

    expect(result.report.campaign).toMatchObject({
      state: 'resolved', source: 'repository', storageKey: 'main-repository',
    });
    expect(reader).toHaveBeenCalledWith(fixture.project, 'main-repository');
  });

  it('reports uncertain repository resolution without reading fallback campaign history', async () => {
    const reader = vi.fn(() => []);
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      readGitCommonDir: () => { throw new Error('not a repository'); },
      readCampaignEntries: reader,
    }));

    expect(result.report.campaign).toMatchObject({
      state: 'unknown', reason: expect.stringContaining('Cannot resolve a repository campaign'),
    });
    expect(reader).not.toHaveBeenCalled();

    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), 'campaign: 42\n', 'utf-8');
    const malformedDefault = await collectShipPreflight(['ship-preflight'], commonDeps({
      readCampaignEntries: reader,
    }));
    expect(malformedDefault.report.campaign).toMatchObject({
      state: 'unknown', reason: expect.stringContaining('non-empty string or null'),
    });
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('ship-preflight daemon and build freshness fact', () => {
  it('reports matching daemon/dist and current paired source outputs', async () => {
    const result = await collectShipPreflight(['ship-preflight'], commonDeps());
    expect(result.report.daemonFreshness.daemonToDist.state).toBe('fresh');
    expect(result.report.daemonFreshness.sourceToDist).toMatchObject({
      state: 'current', sourceFiles: 1, pairedOutputs: 1, stalePaths: [],
    });
  });

  it('does not call stale source current merely because daemon matches dist', async () => {
    const source = join(fixture.packageRoot, 'src', 'probe.ts');
    writeFileSync(source, 'export const probe = false;\n', 'utf-8');
    writeFileSync(join(fixture.packageRoot, 'src', 'missing.ts'), 'export const missing = true;\n', 'utf-8');
    const output = new Capture();
    const code = await cmdShipPreflightWithDeps(['ship-preflight'], commonDeps({ stdout: output.writer }));

    expect(code).toBe(0);
    expect(output.value).toContain('Daemon → dist: FRESH');
    expect(output.value).toContain('Source → dist: STALE');
    expect(output.value).toContain('source/config digest');
    expect(output.value).toContain('A dist build that is behind src can still report FRESH');
  });

  it('reports a daemon/dist mismatch as stale without turning the finding into a command error', async () => {
    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      probeDaemon: async () => ({
        state: 'stale', loadedBuild: 'loaded-old-build', diskBuild: 'disk-new-build',
      }),
    }));

    expect(result.report.daemonFreshness.daemonToDist).toEqual({
      state: 'stale', loadedBuild: 'loaded-old-build', diskBuild: 'disk-new-build',
    });
  });
});

describe('ship-preflight validation baseline fact', () => {
  it('discovers validation commands without executing them or manufacturing delta criteria', async () => {
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'check', lint: 'lint' },
    }), 'utf-8');
    writeFileSync(join(fixture.project, 'package-lock.json'), '{}', 'utf-8');
    const runner = vi.fn(({ role }: { role: string }) => ({
      exitCode: role === 'test' ? 1 : 0,
      stderr: role === 'test' ? 'Tests 2 failed' : '',
    }));

    const result = await collectShipPreflight(['ship-preflight'], commonDeps({
      runValidationCommand: runner,
    }));

    expect(runner).not.toHaveBeenCalled();
    expect(result.report.validationBaseline.execution).toBe('skipped');
    expect(result.report.validationBaseline.discovery.commands.map(command => command.role)).toEqual(['build', 'test', 'lint']);
    expect(result.report.validationBaseline.results.every(result => result.state === 'unresolved')).toBe(true);
    expect(result.report.validationBaseline.gateCriteria.every(criterion => criterion.rule === 'baseline_unresolved')).toBe(true);
  });
});

describe('ship-preflight declared brief inputs fact', () => {
  it('surfaces a nonempty declared output as blocking with its observed size', async () => {
    mkdirSync(join(fixture.project, 'docs'), { recursive: true });
    writeFileSync(join(fixture.project, 'docs', 'research-result.json'), 'x'.repeat(286 * 1024));
    writeFileSync(join(fixture.project, 'brief.md'), [
      '---',
      'research:',
      '  baseline: 0',
      '  policy: best_of_n',
      '  result_file: docs/research-result.json',
      '---',
      '# Goal',
      'Measure a result.',
    ].join('\n'), 'utf-8');

    const result = await collectShipPreflight(
      ['ship-preflight', '--brief', 'brief.md'],
      commonDeps(),
    );

    expect(result.report.outputInventory).toMatchObject({
      state: 'checked',
      inventory: {
        blocking: [expect.objectContaining({
          path: 'docs/research-result.json', blocking: true, size: 286 * 1024,
        })],
      },
    });
  });

  it('keeps leading declarations distinct from neutral path mentions', () => {
    const brief = [
      '---',
      'inputs:',
      '  - ignored/declared.csv',
      '---',
      '# Constraints',
      '| path | role |',
      '| --- | --- |',
      '| `ignored/declared.csv` | source |',
      '| `ignored/only-mentioned.csv` | source |',
      'Do not read `ignored/excluded.csv`.',
      '# Outputs',
      '- Write `ignored/generated.csv`.',
    ].join('\n');

    expect(extractDeclaredBriefInputPaths(brief)).toEqual(['ignored/declared.csv']);
    expect(extractBriefPathMentions(brief).map((mention) => mention.path)).toEqual([
      'ignored/declared.csv',
      'ignored/only-mentioned.csv',
    ]);
  });

  it('does not report escaped patterns or acronym pairs as prose paths', () => {
    const brief = [
      '# Pattern examples',
      String.raw`\`input\.md\` and \`scheduler\.ts\` are regex fragments.`,
      'V1389 CPI/FOMC is a corpus label.',
      'The old warnings were `input/.md` and `scheduler/.ts`.',
      'The literal input is `docs/report.md`.',
    ].join('\n');

    expect(extractBriefPathMentions(brief).map((mention) => mention.path)).toEqual([
      'docs/report.md',
    ]);
  });

  it('takes explicit bare-directory entries literally, reports invalid declarations, and keeps prose conservative', async () => {
    mkdirSync(join(fixture.project, 'dependency_cache'), { recursive: true });
    const brief = [
      '---',
      'inputs:',
      '  - dependency_cache',
      '  - ../outside-cache',
      '---',
      '# Background',
      'The ordinary words scheduler and generator are descriptive prose.',
      '## What the report must show',
      '1. Report every invalid leading input declaration.',
    ].join('\n');

    expect(extractDeclaredBriefInputPaths(brief)).toEqual(['dependency_cache']);
    const verification = verifyDeclaredBriefInputs(brief, fixture.project);
    expect(verification.inputs).toEqual([
      expect.objectContaining({ path: 'dependency_cache', exists: true, readable: true }),
    ]);
    expect(verification.unresolvedInputs).toEqual([
      expect.objectContaining({ value: '../outside-cache', line: 4, reason: expect.stringContaining('project-relative') }),
    ]);
    expect(extractBriefInputPaths('# Background\nThe scheduler and generator remain ordinary nouns.')).toEqual([]);

    writeFileSync(join(fixture.project, 'brief.md'), brief, 'utf-8');
    const stdout = new Capture();
    const code = await cmdShipPreflightWithDeps(
      ['ship-preflight', '--brief', 'brief.md'],
      commonDeps({ stdout: stdout.writer, stderr: new Capture().writer }),
    );
    expect(code).toBe(0);
    expect(stdout.value).toContain('UNRESOLVED DECLARED "../outside-cache" at line 4');
  });

  it('reports explicit punctuation, traversal, null, and malformed YAML instead of rewriting or dropping them', () => {
    const punctuation = parseBriefInputs([
      '---',
      'inputs:',
      '  - "package.json,"',
      '---',
    ].join('\n'));
    expect(punctuation.references).not.toContainEqual(expect.objectContaining({ path: 'package.json' }));
    expect(punctuation.unresolvedInputs).toContainEqual(expect.objectContaining({
      value: 'package.json,', line: 3,
    }));

    const traversal = parseBriefInputs([
      '---',
      'inputs:',
      '  - cache/..',
      '---',
    ].join('\n'));
    expect(traversal.unresolvedInputs).toContainEqual(expect.objectContaining({
      value: 'cache/..', line: 3,
    }));

    const nullEntry = parseBriefInputs([
      '---',
      'inputs:',
      '  -',
      '---',
    ].join('\n'));
    expect(nullEntry.unresolvedInputs).toContainEqual(expect.objectContaining({ line: 3 }));

    const malformed = parseBriefInputs([
      '---',
      'inputs:',
      '  - [unterminated',
      '---',
    ].join('\n'));
    expect(malformed.unresolvedInputs).toContainEqual(expect.objectContaining({
      value: '[unterminated', line: 3, reason: expect.stringContaining('YAML'),
    }));
  });

  it('rejects a numeric fraction while accepting a genuinely path-shaped numeric fixture', () => {
    const inputs = extractBriefInputPaths([
      '# Evidence',
      'The suite passed 103/103 checks.',
      'Read `fixtures/103/103.json` as the comparison input.',
    ].join('\n'));

    expect(inputs).not.toContain('103/103');
    expect(inputs).toContain('fixtures/103/103.json');
  });

  it('ignores neutral bare sibling filenames but accepts an explicit root-level read directive', () => {
    const neutral = extractBriefInputPaths([
      '# Background',
      'The generator has cost_model.py, metrics.py, delisting.py, and `package.json` siblings.',
    ].join('\n'));
    const explicit = extractBriefInputPaths([
      '# Preparation',
      'Read package.json before establishing the baseline.',
    ].join('\n'));

    expect(neutral).toEqual([]);
    expect(explicit).toEqual(['package.json']);
  });

  it('binds paths to nearby input roles without promoting conceptual prose or rejected code spans', () => {
    const neutral = extractBriefInputPaths([
      'The report covers daemon/build freshness and whether declared inputs resolve.',
      'Declared outputs are not inputs: `docs/<x>/conclusion.md` is what the run will write.',
      'The command is dispatched from `src/cli.ts` following the existing pattern.',
      'Tests in `spec/`, fixtures under a temporary directory, use injected processes.',
    ].join('\n'));
    const explicit = extractBriefInputPaths([
      'Read package.json before establishing the baseline.',
      '`fixtures/reference.csv` is required.',
    ].join('\n'));

    expect(neutral).toEqual([]);
    expect(explicit).toEqual(['fixtures/reference.csv', 'package.json']);
  });

  it('extracts an unquoted root-level input without treating an unquoted output as input', () => {
    const inputs = extractBriefInputPaths([
      '# Inputs',
      'Read package.json before making changes.',
      'Write generated.json after the checks pass.',
    ].join('\n'));

    expect(inputs).toContain('package.json');
    expect(inputs).not.toContain('generated.json');
  });

  it('classifies input and output paths independently when one sentence declares both', () => {
    const inputs = extractBriefInputPaths([
      '# Inputs and deliverable',
      '- Read `data/input.arrow` and write `docs/report.md`.',
      '# Notes',
      '- `fixtures/generated-output.csv` is required.',
    ].join('\n'));

    expect(inputs).toContain('data/input.arrow');
    expect(inputs).toContain('fixtures/generated-output.csv');
    expect(inputs).not.toContain('docs/report.md');
  });

  it('reports readable, unreadable, and missing inputs while excluding outputs, globs, and escapes', async () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    writeFileSync(join(fixture.project, 'data', 'prices.csv'), 'price\n', 'utf-8');
    mkdirSync(join(fixture.project, 'locked'), { recursive: true });
    const briefPath = join(fixture.project, 'brief.md');
    const escapingPath = ['..', 'outside.txt'].join('/');
    const absolutePath = join(fixture.root, 'external.csv');
    writeFileSync(briefPath, [
      '---',
      'inputs:',
      '  - data/prices.csv',
      '  - .cache/snapshot',
      '  - locked',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/report.md]',
      '---',
      '# Inputs',
      '- Consume `.cache/snapshot/`.',
      '- Input locked/.',
      `- Do not consume \`${absolutePath}\`.`,
      `- Ignore \`${escapingPath}\` and \`src/**/*.ts\`.`,
      '# Deliverables',
      '- Write `docs/report.md` and `src/generated.ts`.',
    ].join('\n'), 'utf-8');

    const result = await collectShipPreflight(
      ['ship-preflight', '--brief', 'brief.md'],
      commonDeps({ readable: (path) => path !== join(fixture.project, 'locked') }),
    );

    expect(result.report.briefInputs.state).toBe('checked');
    expect(result.report.briefInputs.inputs).toEqual([
      expect.objectContaining({ path: '.cache/snapshot', exists: false, readable: false }),
      expect.objectContaining({ path: 'data/prices.csv', exists: true, readable: true }),
      expect.objectContaining({ path: 'locked', exists: true, readable: false }),
    ]);
    const names = result.report.briefInputs.inputs.map((input) => input.path);
    expect(names).not.toContain('docs/report.md');
    expect(names).not.toContain('src/generated.ts');
    expect(names).not.toContain(escapingPath);
    expect(names).not.toContain('external.csv');
  });

  it('emits equivalent JSON facts and fails only when the requested brief itself is unreadable', async () => {
    const output = new Capture();
    const error = new Capture();
    const jsonCode = await cmdShipPreflightWithDeps(
      ['ship-preflight', '--json'],
      commonDeps({ stdout: output.writer, stderr: error.writer }),
    );
    expect(jsonCode).toBe(0);
    expect(JSON.parse(output.value)).toMatchObject({
      version: 1,
      project: { canonicalPath: fixture.project },
      briefInputs: { state: 'not_requested', inputs: [] },
    });
    expect(error.value).toBe('');

    const missingOutput = new Capture();
    const missingError = new Capture();
    const missingCode = await cmdShipPreflightWithDeps(
      ['ship-preflight', '--brief', 'missing.md'],
      commonDeps({ stdout: missingOutput.writer, stderr: missingError.writer }),
    );
    expect(missingCode).toBe(1);
    expect(missingOutput.value).toBe('');
    expect(missingError.value).toContain('Cannot read requested brief');
  });

  it('confirms and refutes row-count, time-span, and sha256 assertions against file contents', () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const path = join(fixture.project, 'data', 'prices.csv');
    const content = 'timestamp,price\n2022-01-01,10\n2022-01-03,12\n';
    writeFileSync(path, content, 'utf-8');
    const digest = createHash('sha256').update(content).digest('hex');

    const confirmed = verifyDeclaredBriefInputs(
      `---\ninputs: [data/prices.csv]\n---\n# Inputs\nRead \`data/prices.csv\`; it has 2 rows, spans 2022-01-01 .. 2022-01-03, sha256: ${digest}.`,
      fixture.project,
    ).inputs[0];
    expect(confirmed.assertions.map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: 'row_count', state: 'confirmed' },
      { kind: 'time_span', state: 'confirmed' },
      { kind: 'sha256', state: 'confirmed' },
    ]);

    const refuted = verifyDeclaredBriefInputs(
      `---\ninputs: [data/prices.csv]\n---\n# Inputs\nRead \`data/prices.csv\`; it has 3 rows, spans 2022-01-02 .. 2022-01-04, sha256: ${'0'.repeat(64)}.`,
      fixture.project,
    ).inputs[0];
    expect(refuted.assertions.every((assertion) => assertion.state === 'refuted')).toBe(true);
    expect(refuted.assertions.map((assertion) => assertion.observed)).toEqual([
      2,
      { start: '2022-01-01', end: '2022-01-03' },
      digest,
    ]);
  });

  it('binds structured input-manifest assertions without treating terminal paths as inputs', () => {
    mkdirSync(join(fixture.project, 'data'), { recursive: true });
    const content = 'id,value\n1,a\n2,b\n';
    writeFileSync(join(fixture.project, 'data', 'manifest.csv'), content, 'utf-8');
    const digest = createHash('sha256').update(content).digest('hex');
    const verification = verifyDeclaredBriefInputs([
      '---',
      'inputs:',
      '  - path: data/manifest.csv',
      '    rows: 2',
      `    sha256: ${digest}`,
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '---',
      '# Goal',
      'Use the frozen manifest.',
    ].join('\n'), fixture.project);

    expect(verification.inputs).toHaveLength(1);
    expect(verification.inputs[0].path).toBe('data/manifest.csv');
    expect(verification.inputs[0].assertions.map((assertion) => assertion.state)).toEqual([
      'confirmed', 'confirmed',
    ]);
    expect(verification.inputs.map((input) => input.path)).not.toContain('docs/result.md');
  });

  it('confirms and refutes recursive file counts and labels ambiguous spans not checkable', () => {
    mkdirSync(join(fixture.project, 'archive', 'nested'), { recursive: true });
    writeFileSync(join(fixture.project, 'archive', 'one.txt'), 'one', 'utf-8');
    writeFileSync(join(fixture.project, 'archive', 'nested', 'two.txt'), 'two', 'utf-8');
    const confirmed = verifyDeclaredBriefInputs(
      '---\ninputs: [archive/]\n---\n# Inputs\nConsume `archive/`; it contains 2 files.',
      fixture.project,
    ).inputs[0].assertions[0];
    const refuted = verifyDeclaredBriefInputs(
      '---\ninputs: [archive/]\n---\n# Inputs\nConsume `archive/`; it contains 3 files.',
      fixture.project,
    ).inputs[0].assertions[0];
    expect(confirmed).toMatchObject({ kind: 'file_count', state: 'confirmed', observed: 2 });
    expect(refuted).toMatchObject({ kind: 'file_count', state: 'refuted', observed: 2 });

    writeFileSync(
      join(fixture.project, 'ambiguous.csv'),
      'start_date,end_date\n2022-01-01,2022-01-02\n',
      'utf-8',
    );
    const ambiguous = verifyDeclaredBriefInputs(
      '---\ninputs: [ambiguous.csv]\n---\n# Inputs\nRead `ambiguous.csv`; it spans 2022-01-01 .. 2022-01-02.',
      fixture.project,
    ).inputs[0].assertions[0];
    expect(ambiguous).toMatchObject({
      kind: 'time_span',
      state: 'not_checkable',
      reason: expect.stringContaining('unambiguous'),
    });

    const unbound = verifyDeclaredBriefInputs(
      '---\ninputs:\n  - paths: [first.csv, second.csv]\n    rows: 2\n---',
      fixture.project,
    );
    expect(unbound.inputs.every((input) => input.assertions.length === 0)).toBe(true);
    expect(unbound.unboundAssertions).toContainEqual(expect.objectContaining({
      kind: 'row_count',
      state: 'not_checkable',
      reason: expect.stringContaining('2 inputs'),
    }));
  });
});
