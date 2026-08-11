import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdAuditReportWithDeps,
  extractAuditClaims,
  parseDirectArgv,
  runAuditReport,
  type AuditCommandRunner,
} from '../src/cli-audit-report.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

interface Fixture {
  root: string;
  project: string;
  runDir: string;
  report: string;
}

let fixture: Fixture;
let previousGlobalDir: string;

beforeAll(() => {
  previousGlobalDir = fcGlobalDir();
});

beforeEach(() => {
  // Canonicalize the fixture root: on macOS the temp directory is reached through a
  // symlink (/var -> /private/var), so an uncanonicalized root makes every derived
  // path differ from what the code under test computes. Reproducible on Linux by
  // pointing TMPDIR at a symlink.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-audit-report-')));
  fixture = {
    root,
    project: join(root, 'project'),
    runDir: join(root, 'state', 'runs', 'fixture-run'),
    report: join(root, 'project', 'docs', 'final.md'),
  };
  mkdirSync(join(fixture.project, 'docs'), { recursive: true });
  mkdirSync(join(fixture.project, 'artifacts', 'nested'), { recursive: true });
  mkdirSync(fixture.runDir, { recursive: true });
  writeFileSync(join(fixture.runDir, 'run.json'), JSON.stringify({
    runId: 'fixture-run',
    projectDir: fixture.project,
    status: 'complete',
  }), 'utf-8');
  writeFileSync(join(fixture.project, 'docs', 'sample.md'), '# First\nbody\n## Second\nbody\n', 'utf-8');
  writeFileSync(join(fixture.project, 'artifacts', 'metrics.json'), JSON.stringify({
    series: { percentile: 97, values: [{ mean: -1.25 }] },
  }), 'utf-8');
  writeFileSync(join(fixture.project, 'artifacts', 'nested', 'evidence.txt'), 'evidence\n', 'utf-8');
  setFcGlobalDir(join(root, 'state'));
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(previousGlobalDir);
});

function writeReport(lines: string[]): void {
  writeFileSync(fixture.report, `${lines.join('\n')}\n`, 'utf-8');
}

function auditArgs(extra: string[] = []): string[] {
  return [
    'audit-report',
    '--report', fixture.report,
    '--run-dir', fixture.runDir,
    ...extra,
  ];
}

describe('flowcrew audit-report claim re-derivation', () => {
  it('confirms line, recursive-file, Markdown-section, command, and JSON-field claims', async () => {
    writeReport([
      '# Final verification',
      '`docs/sample.md`: 4 lines.',
      '`artifacts` contains 2 files.',
      '`docs/sample.md`: 2 sections.',
      'Validation command `npm test`: exit 0; 3 passed, 0 failed.',
      '`artifacts/metrics.json` field `series.percentile` = 97.',
    ]);
    const runner = vi.fn<AuditCommandRunner>(() => ({
      exitCode: 0,
      stdout: 'Tests  3 passed, 0 failed\n',
    }));

    const report = await runAuditReport(auditArgs(), { runCommand: runner });

    expect(report.totals).toEqual({ confirmed: 5, contradicted: 0, not_checkable: 0 });
    expect(report.claims.map((claim) => [claim.kind, claim.classification, claim.observed])).toEqual([
      ['line_count', 'confirmed', 4],
      ['file_count', 'confirmed', 2],
      ['section_count', 'confirmed', 2],
      ['validation_command', 'confirmed', { exitCode: 0, tallies: { passed: 3, failed: 0 } }],
      ['json_field', 'confirmed', 97],
    ]);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith({ command: 'npm', args: ['test'], cwd: fixture.project });
  });

  it('contradicts falsified counts, validation evidence, and attributed JSON values and exits non-zero', async () => {
    writeReport([
      '# Falsified report',
      '`docs/sample.md`: 7 lines.',
      'Validation command `npm test`: exit 0; 4 passed, 0 failed.',
      '`artifacts/metrics.json` field `/series/percentile` = 96.',
    ]);
    const runner = vi.fn<AuditCommandRunner>(() => ({
      exitCode: 1,
      stdout: 'Tests  3 passed, 1 failed\n',
    }));
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdAuditReportWithDeps(auditArgs(), {
      runCommand: runner,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    const report = await runAuditReport(auditArgs(), { runCommand: runner });

    expect(code).toBe(1);
    expect(stderr.value).toBe('');
    expect(stdout.value).toContain('CONTRADICTED claim-1');
    expect(stdout.value).toContain('CONTRADICTED claim-2');
    expect(stdout.value).toContain('CONTRADICTED claim-3');
    expect(report.totals).toEqual({ confirmed: 0, contradicted: 3, not_checkable: 0 });
    expect(report.claims[1].reason).toContain('exit code expected 0, observed 1');
    expect(report.claims[1].reason).toContain('passed expected 4, observed 3');
    expect(report.claims[2]).toMatchObject({ expected: 96, observed: 97 });
  });

  it('keeps unsupported, ambiguous, missing-field, unsafe-command, and escaping-path claims not_checkable without a failing exit', async () => {
    writeFileSync(join(fixture.runDir, 'docs-sample.md'), 'unrelated\n', 'utf-8');
    writeFileSync(join(fixture.runDir, 'shared.json'), '{"value":1}\n', 'utf-8');
    writeFileSync(join(fixture.project, 'shared.json'), '{"value":1}\n', 'utf-8');
    const escaping = ['..', 'outside.json'].join('/');
    writeReport([
      '# Honest unknowns',
      '`docs/sample.md` has about 4 meaningful lines.',
      '`shared.json` field `value` = 1.',
      '`artifacts/metrics.json` field `series.missing` = 3.',
      'Validation command `npm test | tee output.log`: exit 0.',
      `\`${escaping}\` field \`value\` = 1.`,
    ]);
    const runner = vi.fn<AuditCommandRunner>();
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await cmdAuditReportWithDeps(auditArgs(), {
      runCommand: runner,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(runner).not.toHaveBeenCalled();
    expect(stdout.value).toContain('Totals: confirmed=0 contradicted=0 not_checkable=5');
    expect(stdout.value).toContain('does not judge whether the measured quantity was the right one');
  });

  it('supports a multiline validation heading and quoted argv without a shell', async () => {
    writeReport([
      '# Checks',
      '### `node --test "spec/a file.test.js"`',
      'Exit code: 0',
      'Tallies: 2 passed, 0 failed',
      '',
    ]);
    const runner = vi.fn<AuditCommandRunner>(() => ({
      exitCode: 0,
      stdout: '2 passed, 0 failed\n',
    }));

    const report = await runAuditReport(auditArgs(), { runCommand: runner });

    expect(report.totals.confirmed).toBe(1);
    expect(runner).toHaveBeenCalledWith({
      command: 'node',
      args: ['--test', 'spec/a file.test.js'],
      cwd: fixture.project,
    });
  });

  it('resolves project: and run: prefixes and JSON Pointer array segments', async () => {
    writeFileSync(join(fixture.runDir, 'round.json'), JSON.stringify({ rows: [{ result: -1.25 }] }), 'utf-8');
    writeReport([
      '`project:docs/sample.md`: 4 lines.',
      '`run:round.json` field `/rows/0/result` = -1.25.',
    ]);

    const report = await runAuditReport(auditArgs(), { runCommand: vi.fn<AuditCommandRunner>() });

    expect(report.totals).toEqual({ confirmed: 2, contradicted: 0, not_checkable: 0 });
  });

  it('does not follow an artifact symlink outside both allowed roots', async () => {
    const outside = join(fixture.root, 'outside.json');
    writeFileSync(outside, '{"value":9}\n', 'utf-8');
    symlinkSync(outside, join(fixture.project, 'artifacts', 'escape.json'));
    writeReport(['`artifacts/escape.json` field `value` = 9.']);

    const report = await runAuditReport(auditArgs(), { runCommand: vi.fn<AuditCommandRunner>() });

    expect(report.totals).toEqual({ confirmed: 0, contradicted: 0, not_checkable: 1 });
    expect(report.claims[0].reason).toContain('outside its allowed root');
  });

  it('counts headings outside fenced examples as sections', async () => {
    writeFileSync(join(fixture.project, 'docs', 'fenced.md'), [
      '# Visible',
      '```md',
      '# Example only',
      '```',
      '## Also visible',
      '',
    ].join('\n'), 'utf-8');
    writeReport(['`docs/fenced.md`: 2 sections.']);

    const report = await runAuditReport(auditArgs(), { runCommand: vi.fn<AuditCommandRunner>() });

    expect(report.claims[0]).toMatchObject({ classification: 'confirmed', observed: 2 });
  });
});

describe('audit-report claim/token parsers', () => {
  it('extracts supported claims and leaves a vague path-bearing number visible', () => {
    const claims = extractAuditClaims([
      '`file.md`: 3 lines.',
      '`artifact.json` field `metric.value` = 4.5.',
      '`operator.md` — the shared skill, 244 lines, two parts.',
      '`file.md` has roughly 3 relevant lines.',
    ].join('\n'));

    expect(claims.map((claim) => claim.kind)).toEqual([
      'line_count', 'json_field', 'line_count', 'unsupported',
    ]);
  });

  it('retains an unquoted path-bearing numeric sentence as not checkable', () => {
    const claims = extractAuditClaims('docs/sample.md has about 4 meaningful lines.');

    expect(claims).toEqual([
      expect.objectContaining({ kind: 'unsupported', line: 1 }),
    ]);
  });

  it('tokenizes quotes and escapes but rejects shell composition', () => {
    expect(parseDirectArgv('npm test -- --name "two words"')).toEqual({
      argv: ['npm', 'test', '--', '--name', 'two words'],
    });
    expect(parseDirectArgv('npm test | tee output.log')).toEqual({
      reason: 'shell operator "|" is not argv-safe',
    });
  });
});
