import './test-support/policy-runtime.js';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
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
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import {
  extractBriefOutputDeclarations,
  extractDeclaredBriefInputPaths,
  parseBriefInputs,
  parseDeclaredBriefInputs,
  verifyDeclaredBriefInputs,
} from '../src/ship-inputs.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { type ValidationCommandRunner } from '../src/project-validation.js';

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
    probeDaemon: async (): Promise<DaemonLoadedBuildProbe> => ({
      state: 'fresh', loadedBuild: 'same', diskBuild: 'same',
    }),
    ...overrides,
  };
}

it('reports the authored workflow and refuses an impossible direct loop', async () => {
  const path = join(fixture.project, 'brief.md');
  const output = new Capture();
  const args = ['ship-preflight', '--brief', 'brief.md'];
  const deps = commonDeps({ stdout: output.writer });
  const brief = '---\nworkflow: direct\n---\n# Goal\n\n## Acceptance criteria\n1. Deliver the coherent change.\n';
  writeFileSync(path, brief);
  expect(await cmdShipPreflightWithDeps(args, deps)).toBe(0);
  expect(output.value).toContain('Workflow without --workflow: direct (brief declares workflow: direct)');
  writeFileSync(path, brief.replace('workflow: direct', 'workflow: direct\nresearch:\n  baseline: 0.5'));
  expect(await cmdShipPreflightWithDeps(args, deps)).toBe(1);
  expect(output.value).toContain('direct cannot run the research loop');
});

function writeRun(id: string, state: Record<string, unknown>, mtime: number): string {
  const runPath = join(fixture.stateRoot, 'runs', id);
  mkdirSync(runPath, { recursive: true });
  const statePath = join(runPath, 'run.json');
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf-8');
  const timestamp = new Date(mtime);
  utimesSync(statePath, timestamp, timestamp);
  return runPath;
}

describe('ship-preflight command discovery boundary', () => {
  it('discovers a dist-writing engine build without launching any command', async () => {
    writeFileSync(join(fixture.packageRoot, 'package.json'), JSON.stringify({
      scripts: { build: 'node build-dist.mjs', test: 'node check.mjs', lint: 'node style.mjs' },
    }));
    writeFileSync(join(fixture.packageRoot, 'package-lock.json'), '{}\n');
    writeFileSync(join(fixture.packageRoot, 'build-dist.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("dist/probe.js", "replacement engine build");\n');
    const before = readFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'utf-8');
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'must not run' }));
    const result = await collectShipPreflight(['ship-preflight', '--project', fixture.packageRoot], commonDeps({
      runValidationCommand: runner,
    }));
    expect(result.report.validationBaseline.execution).toBe('skipped');
    expect(result.report.validationBaseline.discovery.commands.map(command => command.role)).toEqual(['build', 'test', 'lint']);
    expect(runner).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.packageRoot, 'dist', 'probe.js'), 'utf-8')).toBe(before);
  });

  it('reports a target shared by a verified live run without executing validation', async () => {
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'check', lint: 'lint' },
    }));
    writeRun('live-target', { projectDir: fixture.project, status: 'running' }, 3_000);
    const runner = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0, stdout: 'must not run' }));
    const stderr = new Capture();
    const deps = commonDeps({
      inspectLiveRun: () => true, runValidationCommand: runner,
      stdout: new Capture().writer, stderr: stderr.writer,
    });
    expect(await cmdShipPreflightWithDeps(['ship-preflight'], deps)).toBe(0);
    expect(stderr.value).toContain('live FlowCrew run(s): live-target');
    expect(runner).not.toHaveBeenCalled();
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
    const reader = vi.fn(() => [
      { seq: 1, runId: 'one', kind: 'task_started', pass: false, timestamp: 'a' },
      { seq: 2, runId: 'one', kind: 'task_ended', status: 'failed', pass: false, timestamp: 'b' },
      { seq: 3, runId: 'two', kind: 'task_ended', status: 'complete', pass: true, timestamp: 'c' },
      { seq: 4, runId: 'three', kind: 'task_ended', status: 'ceiling_hit', pass: true, timestamp: 'd' },
      { seq: 5, runId: 'four', kind: 'task_ended', status: 'cancelled', pass: false, timestamp: 'e' },
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

  it('does not suggest a reset for clean repository history', async () => {
    const clean = await collectShipPreflight(['ship-preflight'], commonDeps({
      readCampaignEntries: () => [
        { seq: 1, runId: 'one', kind: 'task_ended', status: 'complete', pass: true, timestamp: 'a' },
        { seq: 2, runId: 'two', kind: 'task_ended', status: 'shipped', pass: true, timestamp: 'b' },
      ],
    }));
    expect(clean.report.campaign).toMatchObject({
      state: 'resolved', source: 'repository', storageKey: 'project', recentAdverse: 0, suggestContextSkip: false,
    });
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

  it.each(['campaign: legacy-name', 'campaign: null', 'campaign: 42', 'campaign: [unterminated'])('ignores project campaign configuration %s', async content => {
    writeFileSync(join(fixture.project, 'config', 'defaults.yaml'), `${content}\n`, 'utf-8');
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
  it('blocks a nonempty declared output even when the body also reads it as context', async () => {
    mkdirSync(join(fixture.project, 'docs'), { recursive: true });
    writeFileSync(join(fixture.project, 'docs', 'research-result.json'), 'x'.repeat(286 * 1024));
    writeFileSync(join(fixture.project, 'brief.md'), [
      '---',
      'research:',
      '  baseline: 0',
      '  policy: greedy_stack',
      '  result_file: docs/research-result.json',
      '---',
      '# Goal',
      'Measure a result.',
      'Read `docs/research-result.json` as context before producing the result.',
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

  it.each([false, true])('reports external directory capability admission (forbidden=%s) without scanning it', async forbidden => {
    const path = join(forbidden ? fixture.stateRoot : fixture.root, 'durable-results');
    writeFileSync(join(fixture.project, 'brief.md'), `---\noutputs:\n  - path: ${path}\n    type: directory\n---\n# Goal\nRetain per-item results.\n`);
    const result = await collectShipPreflight(['ship-preflight', '--brief', 'brief.md'], commonDeps());
    expect(result.report.outputInventory.inventory.entries).toMatchObject([{
      path, blocking: forbidden, reason: expect.stringContaining(forbidden ? 'FC_HOME/run storage' : 'not inventoried or archived'),
    }]);
    expect(existsSync(path)).toBe(false);
  });

  it.each(['unknown', 'in-place', 'project', 'worktree', 'target-overlap'])('judges source-overlapping output against the launch project (%s)', async launch => {
    const target = join(fixture.root, 'worktree');
    const path = join(launch === 'target-overlap' ? target : fixture.project, 'runs', 'results');
    writeFileSync(join(fixture.project, '.gitignore'), 'runs/\n');
    writeFileSync(join(fixture.project, 'brief.md'), `---\noutputs:\n  - path: ${path}\n    type: directory\n---\n# Goal\nRetain results.\n\n## Acceptance criteria\n1. Retain results in the declared directory.\n`);
    const args = ['ship-preflight', '--brief', 'brief.md'];
    if (launch === 'project') args.push('--project', fixture.project);
    else if (launch !== 'unknown') args.push('--target', launch === 'in-place' ? fixture.project : target);
    const stdout = new Capture();
    const deps = commonDeps({ stdout: stdout.writer });
    const result = await collectShipPreflight(args, deps);
    const inventory = result.report.outputInventory.inventory;
    expect(inventory.blocking).toHaveLength(['in-place', 'project', 'target-overlap'].includes(launch) ? 1 : 0);
    if (launch === 'unknown') {
      expect(inventory.entries[0].warning).toMatch(/worktree launch.*blocks if launched in place/);
      expect(await cmdShipPreflightWithDeps(args, deps)).toBe(0);
      expect(stdout.value).toContain('WARNING');
      expect(stdout.value).toContain('blocks if launched in place');
    }
    expect(existsSync(path)).toBe(false);
  });

  it('takes input and output roles only from declarations, including paths read in the body', () => {
    const brief = [
      '---',
      'inputs: [data/source.csv]',
      'outputs:',
      '  - docs/report.md',
      '  - data/source.csv',
      '---',
      '# Inputs',
      'Read `docs/report.md` as context before writing the report.',
      'Read `data/prose-only.csv`; it has 3 rows.',
      'The historical table lists `data/only-mentioned.csv` as a source.',
    ].join('\n');

    expect(extractDeclaredBriefInputPaths(brief)).toEqual(['data/source.csv']);
    expect(parseDeclaredBriefInputs(brief).references.map(reference => reference.path)).toEqual(['data/source.csv']);
    expect(extractBriefOutputDeclarations(brief)).toEqual([
      expect.objectContaining({ path: 'docs/report.md', disposition: 'create' }),
      expect.objectContaining({ path: 'data/source.csv', disposition: 'input' }),
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
    expect(parseDeclaredBriefInputs('# Background\nThe scheduler and generator remain ordinary nouns.').references.map(reference => reference.path)).toEqual([]);

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

});
