import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildRetryPreamble, captureRepairRoundSnapshot, changedProjectPathsSinceSnapshotCooperatively, closeRepairRoundSnapshot, parseDispatchedStageConfig, restoreProjectPath } from '../src/scheduler.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { artifacts, inputFile, stageArtifacts } from './spec_contracts/declared-fixtures.js';
import { verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { inspectTemporalResearchTests } from '../src/temporal-test-guard.js';
import { fcGlobalDir, runDir, setFcGlobalDir, writeRunState, type StoreState } from '../src/store.js';

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'flowcrew-boundaries-3-'));
  roots.push(path);
  return path;
}
function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function git(project: string, args: string[]): void {
  const script = "import { spawnSync } from 'node:child_process'; const result = spawnSync('git', ['-c', 'gc.auto=0', ...JSON.parse(process.argv[1])], { stdio: 'inherit' }); process.exit(result.status ?? 1);";
  execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
    cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
    stdio: 'ignore', timeout: 15_000,
  });
}
function pytestAvailable(project: string): boolean {
  const script = "import { spawnSync } from 'node:child_process'; const result = spawnSync('python3', ['-m', 'pytest', '--version'], { stdio: 'ignore' }); process.exit(result.status ?? 1);";
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
      stdio: 'ignore', timeout: 15_000,
    });
    return true;
  } catch { return false; }
}
function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
    prompt_template: 'fixture', skills: [], criterion_refs: [], is_gate: false,
    depends_on: [], dependency_reasons: {}, ...raw,
  });
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('A — tracked Git preimages', () => {
  it('captures an unfiltered clean tree by object identity and still restores changed bytes', async () => {
    const project = root();
    const run = root();
    mkdirSync(join(project, 'data'), { recursive: true });
    for (let index = 0; index < 8; index++) write(join(project, 'data', `${index}.bin`), randomBytes(128 * 1024));
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const snapshot = captureRepairRoundSnapshot(project, [stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'repair', role: 'coder', scope: ['data/**'] })], { runDirPath: run });
    try {
      expect(snapshot.measurement).toMatchObject({ scopedFilesVisited: 8, scopedFilesRead: 0, scopedFilesHashed: 0 });
      const before = snapshot.allFileImages.get('data/0.bin')!;
      expect(before.gitObjectId).toMatch(/^[a-f0-9]{40,64}$/);
      expect(before.bytes).toBeUndefined();
      const original = readFileSync(join(project, 'data/0.bin'));
      write(join(project, 'data/0.bin'), randomBytes(original.length));
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, project)).toContain('data/0.bin');
      expect(restoreProjectPath(project, 'data/0.bin', before)).toEqual({ restored: true });
      expect(readFileSync(join(project, 'data/0.bin'))).toEqual(original);
    } finally { closeRepairRoundSnapshot(snapshot); }
  });

  it('still materializes dirty and attribute-filtered preimages before rollback', () => {
    const project = root();
    const run = root();
    write(join(project, '.gitattributes'), 'data/filtered.bin filter=copy\n');
    write(join(project, 'data/filtered.bin'), 'filtered-old');
    write(join(project, 'data/dirty.bin'), 'dirty-old');
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    write(join(project, 'data/dirty.bin'), 'dirty-now');
    write(join(project, 'data/filtered.bin'), 'filtered-now');
    const snapshot = captureRepairRoundSnapshot(project, [stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'repair', role: 'coder', scope: ['data/**'] })], { runDirPath: run });
    try {
      const dirty = snapshot.allFileImages.get('data/dirty.bin')!;
      const filtered = snapshot.files.get('data/filtered.bin')!;
      expect(dirty.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(filtered.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(filtered.gitObjectId).toBeUndefined();
      write(join(project, 'data/dirty.bin'), 'dirty-bad');
      expect(restoreProjectPath(project, 'data/dirty.bin', dirty)).toEqual({ restored: true });
      expect(readFileSync(join(project, 'data/dirty.bin'), 'utf8')).toBe('dirty-now');
      write(join(project, 'data/filtered.bin'), 'filtered-bad');
      expect(restoreProjectPath(project, 'data/filtered.bin', filtered)).toEqual({ restored: true });
      expect(readFileSync(join(project, 'data/filtered.bin'), 'utf8')).toBe('filtered-now');
    } finally { closeRepairRoundSnapshot(snapshot); }
  });

  it('keeps local bytes hidden by assume-unchanged as the rollback preimage', () => {
    const project = root();
    const run = root();
    write(join(project, 'data/local.txt'), 'committed\n');
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    git(project, ['update-index', '--assume-unchanged', 'data/local.txt']);
    write(join(project, 'data/local.txt'), 'operator-local\n');
    const snapshot = captureRepairRoundSnapshot(project, [stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'repair', role: 'coder', scope: ['data/**'] })], { runDirPath: run });
    try {
      const before = snapshot.files.get('data/local.txt')!;
      expect(before.gitObjectId).toBeUndefined();
      write(join(project, 'data/local.txt'), 'stage-change\n');
      expect(restoreProjectPath(project, 'data/local.txt', before)).toEqual({ restored: true });
      expect(readFileSync(join(project, 'data/local.txt'), 'utf8')).toBe('operator-local\n');
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
});

describe('C — temporal retry context', () => {
  it('names the rejected test and keeps the temporal guard authoritative', () => {
    const project = root();
    const run = root();
    const file = 'tests/test_temporal.py';
    write(join(project, file), 'from pathlib import Path\nROOT = Path(__file__).resolve().parents[1]\ndef test_absence():\n    assert not (ROOT / "docs/ship.md").exists()\n');
    const finding = () => inspectTemporalResearchTests({ projectDir: project, writes: [file], terminalPaths: ['docs/ship.md'] });
    expect(finding()[0]?.kind).toBe('asserts_terminal_absence');
    write(join(run, 'stages', 'verify', 'status.json'), JSON.stringify({ error: `Temporal test contract rejected 1 generated test(s): ${file}: ${finding()[0]?.reason}` }));
    const preamble = buildRetryPreamble(1, 1000, run, 'verify', { previousBudgetMs: 1000, nextBudgetMs: 2000 });
    expect(preamble).toContain(file);
    expect(preamble).toContain('terminal artifact');
    expect(preamble).not.toContain('timed out');
    expect(finding()[0]?.kind).toBe('asserts_terminal_absence');
  });

  it('still describes a real budget timeout as a timeout and retains its larger retry budget', () => {
    const run = root();
    write(join(run, 'stages', 'work', 'status.json'), JSON.stringify({ error: 'attempt timeout exceeded' }));
    const preamble = buildRetryPreamble(1, 1000, run, 'work', { previousBudgetMs: 1000, nextBudgetMs: 2000 });
    expect(preamble).toContain('timed out with an effective budget of 1000ms');
    expect(preamble).toContain('strictly larger immutable budget of 2000ms');
  });
});

describe('D — bounded configured pytest replay', () => {
  const previousPythonUserBase = process.env.PYTHONUSERBASE;
  beforeAll(() => { process.env.PYTHONUSERBASE ??= join(userInfo().homedir, '.local'); });
  afterAll(() => {
    if (previousPythonUserBase === undefined) delete process.env.PYTHONUSERBASE;
    else process.env.PYTHONUSERBASE = previousPythonUserBase;
  });
  async function audit(project: string, report: string, target: string) {
    const run = root();
    const artifactContract = artifacts([{ id: 'report', root: 'project', path: report }], [inputFile('test', target)],
      [{ id: 'pytest_evidence', runner: 'pytest', targets: ['test'], argv: ['-q'], expected: { exit_code: 0, failures: [] } }]);
    write(join(project, report), '# Evidence is declared, independently of this prose.\n');
    return verifyStageArtifactContract({ stageId: 'audit', template: `Write ${report}.`, artifactContract, projectDir: project, runDir: run, writes: [report] }, { remainingMs: () => 30_000 });
  }

  it('executes configured Python and Makefile pytest evidence and refuses a failing test', async () => {
    const project = root();
    if (!pytestAvailable(project)) throw new Error('pytest is required for the configured replay; missing dependencies cannot pass');
    write(join(project, 'pyproject.toml'), '[project]\nname="probe"\nversion="0.1.0"\ndependencies=["pytest"]\n');
    write(join(project, 'tests/test_ok.py'), 'def test_ok():\n    assert True\n');
    expect((await audit(project, 'reports/pass.md', 'tests/test_ok.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'passed', exitCode: 0, executedTests: 1 });
    write(join(project, 'tests/test_fail.py'), 'def test_fail():\n    assert False\n');
    expect((await audit(project, 'reports/fail.md', 'tests/test_fail.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'failed', exitCode: 1, failedTests: 1 });
    write(join(project, 'tests/test_skip.py'), 'import pytest\ndef test_skip():\n    pytest.skip("no execution")\n');
    expect((await audit(project, 'reports/skipped.md', 'tests/test_skip.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'failed', exitCode: 0, executedTests: 0 });
    const make = root();
    write(join(make, 'Makefile'), 'PYTHON ?= python3\ntest:\n\t$(PYTHON) -m pytest tests/test_ok.py -q\n');
    write(join(make, 'tests/test_ok.py'), 'def test_ok():\n    assert True\n');
    expect((await audit(make, 'reports/make.md', 'tests/test_ok.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'passed', executedTests: 1 });
  });

  it('refuses skipped-only pytest evidence despite a spoofed terminal summary', async () => {
    const project = root();
    if (!pytestAvailable(project)) throw new Error('pytest is required for this replay');
    write(join(project, 'pyproject.toml'), '[project]\nname="probe"\nversion="0.1.0"\ndependencies=["pytest"]\n');
    write(join(project, 'conftest.py'), 'def pytest_terminal_summary(terminalreporter):\n    terminalreporter.write_line("1 passed")\n');
    write(join(project, 'tests/test_skip.py'), 'import pytest\ndef test_skip():\n    pytest.skip("no execution")\n');
    expect((await audit(project, 'reports/spoof.md', 'tests/test_skip.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'failed', exitCode: 0, executedTests: 0, skippedTests: 1 });
  });

  it('refuses unconfigured runners, unsafe argv, absent targets and outward aliases before execution', async () => {
    const unconfigured = root(); write(join(unconfigured, 'tests/test_ok.py'), 'def test_ok():\n    assert True\n');
    expect((await audit(unconfigured, 'reports/unconfigured.md', 'tests/test_ok.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'not_run', reason: expect.stringContaining('configured') });
    const configured = root();
    write(join(configured, 'pyproject.toml'), '[project]\nname="probe"\nversion="0.1.0"\ndependencies=["pytest"]\n');
    write(join(configured, 'tests/test_ok.py'), 'def test_ok():\n    assert True\n');
    for (const argv of [['-q', '&&', 'touch escaped.marker'], ['-q', '-c', 'outside.ini']]) {
      expect(() => ArtifactContractSchema.parse({ version: 1, produces: [], reads: [inputFile('test', 'tests/test_ok.py')], replays: [{ id: 'unsafe', runner: 'pytest', targets: ['test'], argv, expected: { exit_code: 0, failures: [] } }] })).toThrow(/argv/);
    }
    expect(existsSync(join(configured, 'escaped.marker'))).toBe(false);
    expect((await audit(configured, 'reports/missing.md', 'tests/test_missing.py')).replayExecutions[0])
      .toMatchObject({ runner: 'pytest', status: 'not_run' });
    const outside = root(); write(join(outside, 'test_escape.py'), 'def test_escape():\n    assert True\n');
    symlinkSync(join(outside, 'test_escape.py'), join(configured, 'tests/test_escape.py'));
    await expect(audit(configured, 'reports/escape.md', 'tests/test_escape.py')).rejects.toThrow('ARTIFACT_PATH_ESCAPE');
  });
});
