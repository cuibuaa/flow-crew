import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdShipPreflightWithDeps,
  collectShipPreflight,
  extractBriefInputPaths,
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import {
  extractBriefPathMentions,
  extractDeclaredBriefInputPaths,
  verifyBriefInputs,
} from '../src/ship-inputs.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

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
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-ship-preflight-'));
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

function writeRun(id: string, state: Record<string, unknown>, mtime: number): string {
  const runPath = join(fixture.stateRoot, 'runs', id);
  mkdirSync(runPath, { recursive: true });
  const statePath = join(runPath, 'run.json');
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf-8');
  const timestamp = new Date(mtime);
  utimesSync(statePath, timestamp, timestamp);
  return runPath;
}

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
    const future = new Date(5_000);
    utimesSync(source, future, future);
    writeFileSync(join(fixture.packageRoot, 'src', 'missing.ts'), 'export const missing = true;\n', 'utf-8');
    const output = new Capture();
    const code = await cmdShipPreflightWithDeps(['ship-preflight'], commonDeps({ stdout: output.writer }));

    expect(code).toBe(0);
    expect(output.value).toContain('Daemon → dist: FRESH');
    expect(output.value).toContain('Source → dist: STALE');
    expect(output.value).toContain('probe.js');
    expect(output.value).toContain('missing.js');
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
  it('runs the configuration-discovered validation set and reports delta criteria', async () => {
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

    expect(runner.mock.calls.map(([request]) => request.role)).toEqual(['build', 'test', 'lint']);
    expect(result.report.validationBaseline.results).toContainEqual(expect.objectContaining({
      role: 'test', state: 'failed', failureCount: 2,
    }));
    expect(result.report.validationBaseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'test', rule: 'no_regression_from_baseline', baselineFailureCount: 2,
    }));
    expect(result.report.validationBaseline.gateCriteria).toContainEqual(expect.objectContaining({
      role: 'build', rule: 'must_remain_green',
    }));
  });
});

describe('ship-preflight declared brief inputs fact', () => {
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
      'input_manifest: data/prices.csv',
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

    const confirmed = verifyBriefInputs(
      `# Inputs\nRead \`data/prices.csv\`; it has 2 rows, spans 2022-01-01 .. 2022-01-03, sha256: ${digest}.`,
      fixture.project,
    ).inputs[0];
    expect(confirmed.assertions.map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: 'row_count', state: 'confirmed' },
      { kind: 'time_span', state: 'confirmed' },
      { kind: 'sha256', state: 'confirmed' },
    ]);

    const refuted = verifyBriefInputs(
      `# Inputs\nRead \`data/prices.csv\`; it has 3 rows, spans 2022-01-02 .. 2022-01-04, sha256: ${'0'.repeat(64)}.`,
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
    const verification = verifyBriefInputs([
      '---',
      'input_manifest:',
      '  path: data/manifest.csv',
      '  rows: 2',
      `  sha256: ${digest}`,
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
    const confirmed = verifyBriefInputs(
      '# Inputs\nConsume `archive/`; it contains 2 files.',
      fixture.project,
    ).inputs[0].assertions[0];
    const refuted = verifyBriefInputs(
      '# Inputs\nConsume `archive/`; it contains 3 files.',
      fixture.project,
    ).inputs[0].assertions[0];
    expect(confirmed).toMatchObject({ kind: 'file_count', state: 'confirmed', observed: 2 });
    expect(refuted).toMatchObject({ kind: 'file_count', state: 'refuted', observed: 2 });

    writeFileSync(
      join(fixture.project, 'ambiguous.csv'),
      'start_date,end_date\n2022-01-01,2022-01-02\n',
      'utf-8',
    );
    const ambiguous = verifyBriefInputs(
      '# Inputs\nRead `ambiguous.csv`; it spans 2022-01-01 .. 2022-01-02.',
      fixture.project,
    ).inputs[0].assertions[0];
    expect(ambiguous).toMatchObject({
      kind: 'time_span',
      state: 'not_checkable',
      reason: expect.stringContaining('unambiguous'),
    });

    const unbound = verifyBriefInputs(
      '# Inputs\nRead `first.csv` and `second.csv`; together they contain 2 rows.',
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
