// Independent QA probe for the engine-boundaries-3 change. Run with:
//   node --import tsx spec/audit-engine-boundaries-3.mjs
// All fixture writes stay in the OS temporary directory.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRetryPreamble,
  captureRepairRoundSnapshot,
  changedProjectPathsSinceSnapshotCooperatively,
  closeRepairRoundSnapshot,
  consumeSupervisorReject,
  parseDispatchedStageConfig,
  restoreProjectPath,
} from '../src/scheduler.ts';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.ts';
import { inspectTemporalResearchTests } from '../src/temporal-test-guard.ts';
import { fcGlobalDir, runDir, setFcGlobalDir, writeRunState } from '../src/store.ts';

const findings = [];
const record = async (name, action) => {
  try { await action(); findings.push({ name, pass: true }); }
  catch (error) { findings.push({ name, pass: false, error: String(error?.stack ?? error) }); }
};
const temp = () => mkdtempSync(join(tmpdir(), 'flowcrew-eb3-audit-'));
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const stage = (values) => parseDispatchedStageConfig({
  prompt_template: 'fixture', skills: [], criterion_refs: [], is_gate: false,
  depends_on: [], dependency_reasons: {}, ...values,
});
const git = (project, args) => {
  const script = "import { spawnSync } from 'node:child_process'; const result = spawnSync('git', ['-c', 'gc.auto=0', ...JSON.parse(process.argv[1])], { stdio: 'ignore' }); process.exit(result.status ?? 1);";
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
    cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
    timeout: 15_000, stdio: 'ignore',
  });
};

await record('A: clean Git object snapshot detects and restores changed bytes', async () => {
  const project = temp(); const run = temp();
  try {
    const path = join(project, 'data', 'a.bin');
    const original = randomBytes(256 * 1024);
    write(path, original);
    git(project, ['init', '-q']); git(project, ['add', '.']);
    git(project, ['-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture']);
    const snapshot = captureRepairRoundSnapshot(project, [stage({ id: 'repair', role: 'coder', scope: ['data/**'] })], { runDirPath: run });
    try {
      const before = snapshot.allFileImages.get('data/a.bin');
      assert.equal(snapshot.measurement.scopedFilesRead, 0);
      assert.match(before.gitObjectId, /^[a-f0-9]{40,64}$/);
      assert.equal(before.bytes, undefined);
      write(path, randomBytes(original.length));
      assert.deepEqual(await changedProjectPathsSinceSnapshotCooperatively(snapshot, project), ['data/a.bin']);
      assert.deepEqual(restoreProjectPath(project, 'data/a.bin', before), { restored: true });
      assert.deepEqual(readFileSync(path), original);
    } finally { closeRepairRoundSnapshot(snapshot); }
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); }
});

await record('A: assume-unchanged local bytes remain the rollback preimage', async () => {
  const project = temp(); const run = temp();
  try {
    const path = join(project, 'data', 'local.txt');
    write(path, 'committed\n');
    git(project, ['init', '-q']); git(project, ['add', '.']);
    git(project, ['-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture']);
    git(project, ['update-index', '--assume-unchanged', 'data/local.txt']);
    write(path, 'operator-local\n');
    const snapshot = captureRepairRoundSnapshot(project, [stage({ id: 'repair', role: 'coder', scope: ['data/**'] })], { runDirPath: run });
    try {
      const before = snapshot.allFileImages.get('data/local.txt');
      assert.ok(before, 'run-start preimage must exist');
      write(path, 'stage-write\n');
      assert.deepEqual(restoreProjectPath(project, 'data/local.txt', before), { restored: true });
      assert.equal(readFileSync(path, 'utf8'), 'operator-local\n');
    } finally { closeRepairRoundSnapshot(snapshot); }
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); }
});

function supervisorCase(producerReason, gateReason) {
  const project = temp(); const priorHome = fcGlobalDir();
  setFcGlobalDir(join(project, 'fc-home'));
  try {
    const id = 'audit'; const path = runDir(project, id);
    const work = stage({ id: 'work', role: 'coder', scope: ['docs/**'] });
    const gate = stage({ id: 'gate', role: 'qa', is_gate: true, depends_on: ['work'], dependency_reasons: { work: 'Audit output.' }, scope: [] });
    const repair = stage({ id: 'repair', role: 'coder', depends_on: ['gate'], dependency_reasons: { gate: 'Repair failure.' }, retry_to: ['gate'], scope: ['docs/**'] });
    const now = new Date().toISOString();
    const state = { runId: id, workflowName: 'audit', projectDir: project, status: 'running', startedAt: now,
      stages: { work: { status: 'complete', retries: 0, completedAt: now }, gate: { status: 'complete', retries: 0, completedAt: now }, repair: { status: 'skipped', retries: 0 } } };
    mkdirSync(path, { recursive: true });
    writeRunState(project, id, state);
    write(join(path, 'verdict_gate.json'), JSON.stringify({ pass: false, reason: gateReason }));
    write(join(path, 'signals', 'reject_work.json'), JSON.stringify({ stage: 'work', reason: producerReason }));
    const acted = consumeSupervisorReject(state, [work, gate, repair], ['work', 'gate'], { projectDir: project, runId: id, runDirPath: path, iteration: 1 });
    return { acted, producer: state.stages.work.status, gate: state.stages.gate.status,
      repair: state.stages.repair.status, verdictExists: existsSync(join(path, 'verdict_gate.json')) };
  } finally { setFcGlobalDir(priorHome); rmSync(project, { recursive: true, force: true }); }
}

await record('B: shared wording does not consume a producer REJECT', () => {
  const outcome = supervisorCase('section 7 baseline validation mtime is wrong', 'section 7 baseline validation mtime is wrong and needs repair');
  assert.deepEqual(outcome, { acted: true, producer: 'pending', gate: 'pending', repair: 'skipped', verdictExists: false });
});

await record('B: unrelated supervisor safety defect still forces producer rework', () => {
  // Both messages describe section 7 baseline validation, but one is stale
  // timing evidence and the other is disclosure outside the allowed scope.
  const outcome = supervisorCase('section 7 baseline validation disclosed credentials outside scope', 'section 7 baseline validation mtime is wrong and needs repair');
  assert.deepEqual(outcome, { acted: true, producer: 'pending', gate: 'pending', repair: 'skipped', verdictExists: false });
});

await record('B: shared validation command does not hide an independent supervisor defect', () => {
  // The gate reports a failed validation command before the report write;
  // the supervisor reports that command writing credentials outside scope.
  const outcome = supervisorCase('Validation: make test caused a credential write outside project scope', 'Validation: make test failed before final report write');
  assert.deepEqual(outcome, { acted: true, producer: 'pending', gate: 'pending', repair: 'skipped', verdictExists: false });
});

await record('B: equal fault categories for different files remain independent REJECTs', () => {
  const outcome = supervisorCase(
    'tests/test_beta.py failed and the manifest is missing in reports/beta',
    'tests/test_alpha.py failed and the manifest is missing in reports/alpha',
  );
  assert.deepEqual(outcome, { acted: true, producer: 'pending', gate: 'pending', repair: 'skipped', verdictExists: false });
});

await record('C: temporal retry names the rejected file; unchanged absence still fails', () => {
  const project = temp(); const run = temp();
  try {
    const file = 'tests/test_temporal.py';
    write(join(project, file), 'from pathlib import Path\nROOT = Path(__file__).resolve().parents[1]\ndef test_absence():\n    assert not (ROOT / "docs/ship.md").exists()\n');
    const check = () => inspectTemporalResearchTests({ projectDir: project, writes: [file], terminalPaths: ['docs/ship.md'] });
    assert.equal(check()[0]?.kind, 'asserts_terminal_absence');
    write(join(run, 'stages', 'verify', 'status.json'), JSON.stringify({ error: `Temporal test contract rejected 1 generated test(s): ${file}: ${check()[0]?.reason}` }));
    const preamble = buildRetryPreamble(1, 1000, run, 'verify', { previousBudgetMs: 1000, nextBudgetMs: 2000 });
    assert.match(preamble, /RETRY FIX/);
    assert.ok(preamble.includes(file));
    assert.ok(!preamble.includes('timed out'));
    assert.equal(check()[0]?.kind, 'asserts_terminal_absence');
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); }
});

await record('D: configured pytest executes, while unconfigured and shell commands do not', () => {
  const project = temp(); const run = temp(); const unconfigured = temp();
  try {
    write(join(project, 'pyproject.toml'), '[project]\nname="audit"\nversion="0.1.0"\ndependencies=["pytest"]\n');
    write(join(project, 'tests', 'test_ok.py'), 'def test_ok():\n    assert True\n');
    write(join(unconfigured, 'tests', 'test_ok.py'), 'def test_ok():\n    assert True\n');
    const audit = (root, name, command) => {
      write(join(root, name), `# Audit\nReplay command: \`${command}\`\n`);
      return inspectStageArtifactContract({ stageId: 'audit', template: `Write ${name}.`, projectDir: root, runDir: run, writes: [name] }).replayExecutions[0];
    };
    const passing = audit(project, 'reports/pass.md', 'python3 -m pytest tests/test_ok.py -q');
    assert.deepEqual(Object.fromEntries(['runner', 'status', 'exitCode', 'executedTests'].map(k => [k, passing[k]])),
      { runner: 'pytest', status: 'passed', exitCode: 0, executedTests: 1 });
    assert.equal(audit(unconfigured, 'reports/refuse.md', 'python3 -m pytest tests/test_ok.py -q').status, 'not_run');
    assert.equal(audit(project, 'reports/shell.md', 'python3 -m pytest tests/test_ok.py -q && touch escaped.marker').status, 'not_run');
    assert.equal(existsSync(join(project, 'escaped.marker')), false);
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(unconfigured, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); }
});

await record('D: pytest summary text cannot turn a skipped-only replay into verified tests', () => {
  const project = temp(); const run = temp();
  try {
    write(join(project, 'pyproject.toml'), '[project]\nname="audit"\nversion="0.1.0"\ndependencies=["pytest"]\n');
    write(join(project, 'conftest.py'), 'def pytest_terminal_summary(terminalreporter):\n    terminalreporter.write_line("1 passed")\n');
    write(join(project, 'tests', 'test_skip.py'), 'import pytest\ndef test_skip():\n    pytest.skip("no executed test")\n');
    const name = 'reports/replay.md';
    write(join(project, name), '# Replay\nReplay command: `python3 -m pytest tests/test_skip.py -q`\n');
    const replay = inspectStageArtifactContract({ stageId: 'audit', template: `Write ${name}.`, projectDir: project, runDir: run, writes: [name] }).replayExecutions[0];
    assert.equal(replay.exitCode, 0);
    assert.equal(replay.status, 'failed', JSON.stringify(replay));
    assert.equal(replay.executedTests, 0);
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); }
});

await record('Report: numbered evidence, replay, limits and validation sections exist', () => {
  const report = readFileSync(new URL('../docs/engine-boundaries-3/report.md', import.meta.url), 'utf8');
  for (let i = 1; i <= 12; i++) assert.match(report, new RegExp(`^## ${i}\\.`, 'm'));
  for (const word of ['within_expected_range', 'method_was_not_adjusted_to_match_expectation', '0/20 before and 0/20 after']) assert.ok(report.includes(word), word);
});

process.stdout.write(`${JSON.stringify({ checks: findings.length, failures: findings.filter(x => !x.pass).length, findings }, null, 2)}\n`);
process.exitCode = findings.some(x => !x.pass) ? 1 : 0;
