import { validationReport } from './test-support/structured-validation.js';
import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { runDir, readRunState, readStageStatus, writeStageStatus } from '../src/store.js';
import { concludeRun } from '../src/scheduler/sched_policy/run-completion.js';
import { createRun } from './test-support/create-run.js';
import { seedAttemptValidation as seedValidation } from './test-support/attempt-validation.js';
import { appendEvidence, evidenceContext, projectValidationFact, readEvidence } from '../src/evidence-ledger.js';
import { discoverProjectValidation, evaluateValidationDelta, projectValidationResult, reconcileProjectValidation,
  runProjectCommand, runProjectValidationBaseline, type ValidationCommandResult } from '../src/project-validation.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { classifyGateRecoveryFact, findGateRecoveryStages } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { currentAuthorValidationRefusal, currentValidationResults, readValidationDelta, recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';
import { decodeRunnerReport } from '../src/validation-identity.js';
import { pollWatch, createWatchState } from '../src/watch.js';
import { readRunStateView } from '../src/run-state-view.js';
import { summarizeRunStateView } from '../src/run-state-access.js';
import { renderRunSummary } from '../src/run-summary.js';

const seedAttemptValidation = (...args: Parameters<typeof seedValidation>) => seedValidation(args[0], args[1], args[2], { ...args[3], validationVersion: 3 });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'control-validation-')); roots.push(root); return root; }
const report = { complete: true, numTotalTests: 1, numFailedTests: 1, numPassedTests: 0,
  testResults: [{ name: 'spec/fixture.test.ts', status: 'failed', message: '', assertionResults: [{ fullName: 'confirmed defect', status: 'failed' }] }] };

describe('declared runner identity owns the failure population', () => {
  it.each([false, true])('is complete despite stderr, human stdout and output truncation (report file=%s)', async file => {
    const measured = await runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'runner', args: [], display: 'runner', report: { format: 'vitest-json', ...(file ? { path: 'report.json' } : {}) } }],
      maxOutputBytes: 20,
      runCommand: () => ({ exitCode: 1, stdout: file ? 'human output'.repeat(100) : JSON.stringify(report),
        ...(file ? { report: JSON.stringify(report) } : {}), stderr: 'diagnostics'.repeat(100) }),
    });
    const command = measured.results.find(result => result.role === 'test')!;
    expect(command).toMatchObject({ state: 'failed', identityOwner: 'runner-json', failureIdentity: 'known', failureEvidence: 'complete', testsRun: 1,
      outputBytes: { stderr: 1100 }, failures: [{ testId: 'confirmed defect', file: 'spec/fixture.test.ts', messageClass: 'test-failure' }] });
    expect(evaluateValidationDelta(measured, measured.results).find(result => result.role === 'test')?.state).toBe('unverified');
  });

  it.each([false, true])('uses valid declared JSON despite non-UTF-8 diagnostic bytes (file=%s)', async file => {
    const root = project();
    const script = file ? `require('node:fs').writeFileSync('report.json',${JSON.stringify(JSON.stringify(report))});process.stdout.write(Buffer.from([0xc3]));`
      : `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`;
    const measured = await runProjectValidationBaseline(root, {
      commands: [{ role: 'test', command: process.execPath, args: ['-e', script + 'process.stderr.write(Buffer.from([0xc3]));process.exitCode=1;'],
        display: 'structured binary diagnostics', report: { format: 'vitest-json', ...(file ? { path: 'report.json' } : {}) } }],
    });
    expect(measured.results.find(result => result.role === 'test')).toMatchObject({ state: 'failed', identityOwner: 'runner-json',
      failureIdentity: 'known', failureEvidence: 'complete', outputBytes: { stderr: 1 } });
  });

  it('accounts for compact passing assertions without allocating irrelevant passing identities', () => {
    const compact = { ...report, numTotalTests: 2, numPassedTests: 1,
      testResults: [{ ...report.testResults[0], assertionResults: [...report.testResults[0].assertionResults, { status: 'passed' }] }] };
    expect(decodeRunnerReport(JSON.stringify(compact), 'vitest-json', '/workspace')).toMatchObject({ complete: true, testsRun: 2,
      failures: [{ testId: 'confirmed defect', file: 'spec/fixture.test.ts' }] });
    const missing = { ...report, testResults: [{ ...report.testResults[0], assertionResults: [{ status: 'failed' }] }] };
    expect(() => decodeRunnerReport(JSON.stringify(missing), 'vitest-json', '/workspace')).toThrow('identity is missing');
  });

  it('retains complete declared identity and raw failure regardless of host load', async () => {
    const measured = await runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'runner', args: [], display: 'runner', report: { format: 'vitest-json' } }],
      runCommand: () => ({ exitCode: 1, stdout: JSON.stringify(report), stderr: 'diagnostic',
        load: { start: { loadAverage1m: 2, cpuCount: 1 }, end: { loadAverage1m: 2, cpuCount: 1 }, ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 } }),
    });
    expect(measured.results.find(result => result.role === 'test')).toMatchObject({ state: 'failed', measurement: 'unverified',
      exitCode: 1, identityOwner: 'runner-json', failureEvidence: 'complete', failureIdentity: 'known' });
    expect(evaluateValidationDelta(measured, measured.results).find(result => result.role === 'test')?.state).toBe('unverified');
  });

  it.each([
    { name: 'invalid JSON', bytes: '{', exitCode: 1 },
    { name: 'inconsistent counts', bytes: JSON.stringify({ ...report, numFailedTests: 2 }), exitCode: 1 },
    { name: 'failed report with green exit', bytes: JSON.stringify(report), exitCode: 0 },
    { name: 'success flag with red exit', bytes: JSON.stringify({ ...report, success: true }), exitCode: 1 },
    { name: 'failed success flag with green exit', bytes: JSON.stringify({ complete: true, success: false, numTotalTests: 0, numFailedTests: 0, numPassedTests: 0, testResults: [] }), exitCode: 0 },
    { name: 'green report with red exit', bytes: JSON.stringify({ ...report, numFailedTests: 0, numPassedTests: 1,
      testResults: [{ name: 'spec/fixture.test.ts', assertionResults: [{ fullName: 'confirmed defect', status: 'passed' }] }] }), exitCode: 1 },
  ])('keeps $name unknown', async ({ bytes, exitCode }) => {
    const measured = await runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'runner', args: [], display: 'runner', report: { format: 'vitest-json' } }],
      runCommand: () => ({ exitCode, stdout: bytes, stderr: 'diagnostic' }),
    });
    expect(measured.results.find(result => result.role === 'test')).toMatchObject({ identityOwner: 'unknown', failureIdentity: 'unknown', failureIdentifiers: [] });
    expect(evaluateValidationDelta(measured, measured.results).find(result => result.role === 'test')?.state).toBe(exitCode === 0 ? 'verified' : 'unverified');
    expect(evaluateValidationDelta(undefined, measured.results).find(result => result.role === 'test')?.state).toBe(exitCode === 0 ? 'verified' : 'unverified');
  });

  it('keeps undeclared output unknown even when transport is bounded', async () => {
    const measured = await runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'opaque', args: [], display: 'opaque' }], maxOutputBytes: 40,
      runCommand: () => ({ exitCode: 1, stdout: 'arbitrary data'.repeat(100) }),
    });
    expect(measured.results[0]).toMatchObject({ identityOwner: 'unknown', failureIdentity: 'unknown' });
  });

  it('declares this repository runner in config and keeps the project reporter authoritative', () => {
    const discovery = discoverProjectValidation(resolve('.'));
    const test = discovery.commands.find(command => command.role === 'test')!;
    expect(test).toMatchObject({ report: { format: 'vitest-json', path: '.cache/validation-tests.json' }, evidencePath: join(resolve('.'), 'config/validation.json') + '#validation.commands.test' });
    expect(test.args).toContain('--reporter=./config/validation-reporter.ts');
    const conflict = reconcileProjectValidation(resolve('.'), [{ ...test, evidencePath: 'brief#test', report: { format: 'vitest-json' } }]);
    expect(conflict).toMatchObject({ state: 'unknown', commands: [], reason: expect.stringContaining('reporter conflict') });
  });

  it('refuses invalid explicit project configuration instead of falling through to an inferred command', async () => {
    const root = project(); mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'npm@10', scripts: { test: 'opaque' } }));
    writeFileSync(join(root, 'config/validation.json'), '{"commands":{"test":{"command":"runner","args":[],"report":{"format":"unknown"}}}}');
    expect(() => discoverProjectValidation(root)).toThrow('Invalid project validation configuration');
    let executed = false;
    await expect(runProjectValidationBaseline(root, { runCommand: () => { executed = true; return { exitCode: 0 }; } }))
      .rejects.toThrow('Invalid project validation configuration');
    expect(executed).toBe(false);
  });
});

async function partialWorkflow(confirmed: boolean) {
  const root = project();
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.mjs'], report: { format: 'vitest-json' } } } }));
  writeFileSync(join(root, 'check.mjs'), `console.log(${JSON.stringify(validationReport(['fixture failure'], { complete: false }))});process.exitCode=1;`);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']]) {
    isolatedProjectCommand('git', args, root, root);
  }
  const calls: string[] = [];
  let review = 0;
  const adapter: Adapter = { async run(prompt, _role, opts) {
    const result = (value: unknown, writes: string[] = []) => ({ output: JSON.stringify(value), exitCode: 0, duration_ms: 1,
      writes, writeAttribution: 'structured' as const });
    calls.push(opts.stageId);
    if (opts.stageId === 'review') {
      const reject = confirmed && review++ === 0;
      let reproduction: number | undefined;
      if (reject) {
        const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
        const request = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(require('node:fs').readFileSync('docs/value.txt','utf8')==='repaired'?0:1)")}`,
          cwd: root, shell: '/bin/sh' };
        const child = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', `${client} '${JSON.stringify(request).replaceAll("'", "'\\''")}'`],
          display: 'reviewer reproduction', cwd: root, runDir: opts.runDir, timeoutMs: 30000 });
        expect(child.exitCode).toBe(0);
        const recorded = JSON.parse(child.stdout!).record;
        expect(recorded.exitCode).toBe(1); reproduction = recorded.sequence;
      }
      const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
      return result({ pass: !reject, reason: reject ? 'Confirmed repairable defect' : 'Semantic criteria satisfied',
        ...(reject ? { repairability: { version: 1, disposition: 'repairable', evidence: `ledger #${reproduction}` } } : {}),
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: reject ? 'fail' : 'pass', evidence: 'Read value' }])),
        audit_findings: { version: 1, findings: reject ? [{ id: 'value', paths: ['docs/value.txt'], reason: 'Value predicate failed',
          criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction }] : [] } });
    }
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/value.txt'), opts.stageId === 'repair' ? 'repaired' : 'bad');
    return result({ status: 'delivered', summary: 'Value written', caveats: [], remaining_work: [] }, ['docs/value.txt']);
  } };
  const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
  const brief = `---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Independently verify the value.\"}]\noutputs: [docs/value.txt]\nvalidation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: [check.mjs]\n      report: {format: vitest-json}\n---\n# Value\n\n## Acceptance criteria\n1. Independently verify the value.\n`;
  const final = await runWorkflow(config, raw, root, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
  return { root, final, calls, ledger: readEvidence(runDir(root, final.runId)) };
}

describe('repair admission and certification have distinct evidence demands', () => {
  it('repairs a confirmed reproduction and continues rejecting a completed nonzero configured command', { timeout: 60_000 }, async () => {
    const { final, calls, ledger } = await partialWorkflow(true);
    expect(calls.slice(0, 4)).toEqual(['implement', 'review', 'repair', 'review']);
    const validations = ledger.filter(entry => entry.kind === 'validation');
    expect(validations).toHaveLength(2);
    for (const fact of validations) {
      expect(fact.delta.find(entry => entry.role === 'test')?.state).toBe('unverified');
      expect(fact.executions[0].commands[0]).toMatchObject({ exitCode: 1, failureEvidence: 'partial' });
    }
    const original = ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.exitCode === 1)!;
    expect(original).toBeDefined();
    expect(ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence)).toMatchObject({ exitCode: 0 });
    expect(final.status).toBe('incomplete');
    expect(final.stages.review.gate).toMatchObject({ pass: false });
  });

  it('rejects nonzero configured validation even when independent semantic review passes', async () => {
    const { final, calls } = await partialWorkflow(false);
    expect(calls.slice(0, 4)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(final.status).toBe('incomplete');
    expect(final.stages.review.gate).toMatchObject({ pass: false });
  });

  it('admits confirmed repair even when a historic effective verdict retained a validation refusal', () => {
    const verdict = { pass: false, refusal: { kind: 'validation_unresolved' as const }, findings: { confirmed: [{ id: 'value' }], unconfirmed: [] } } as unknown as import('../src/store.js').GateVerdict;
    const fact = classifyGateRecoveryFact('review', { pass: false }, verdict);
    const repair = { id: 'repair', retry_to: ['review'] } as import('../src/scheduler/sched_admission/configuration.js').StageConfig;
    expect(findGateRecoveryStages([repair], ['review'], { review: fact })).toEqual([repair]);
  });
});

describe('one projection across historic receipts and every reader', () => {
  it.each(['changed', 'unreadable', 'different-tree'] as const)('keeps an exit-zero legacy execution unverified when its source is %s', async binding => {
    const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['author', 'review']);
    const command = { role: 'test' as const, command: 'fixture', args: [], display: 'source-mutating command',
      exitCode: 0, state: 'passed' as const, durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'none' as const };
    writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline: {
      version: 1, projectDir: root, discovery: { state: 'configured', configPath: 'fixture', commands: [command], missingRoles: [] }, results: [], gateCriteria: [],
    } }));
    const seeded = seedAttemptValidation(root, runId, [command]);
    if (seeded.kind !== 'validation') throw Error('Fixture validation missing');
    const other = 'a'.repeat(64);
    const fact = appendEvidence(base, { kind: 'validation', stageId: seeded.stageId, attemptIndex: seeded.attemptIndex,
      attemptStartedAt: seeded.attemptStartedAt, treeHash: seeded.treeHash, failures: [], validationVersion: 2, executions: [{ ...seeded.executions[0],
      treeHash: binding === 'unreadable' ? null : other,
      treeAfterHash: binding === 'different-tree' ? other : seeded.treeHash,
    }], delta: [{ role: 'test', display: command.display, state: 'unresolved', reason: 'Historical coverage unresolved', newFailureIdentifiers: [] }], pass: false });
    if (fact.kind !== 'validation') throw Error('Fixture validation missing');
    const attempt = { index: 1, status: 'complete' as const, startedAt: '2000-01-01T00:00:00Z', completedAt: '2000-01-01T00:00:01Z', exitCode: 0 };
    writeStageStatus(root, runId, 'review', { status: 'complete', retries: 0, attempts: [attempt] });
    const receiptPath = runRecordPath(base, 'validation_delta_review.json');
    writeFileSync(receiptPath, JSON.stringify({ version: 2, stageId: 'review', checkedAt: attempt.completedAt,
      ledgerSequence: fact.sequence, current: [command], delta: fact.delta, pass: false }));
    writeFileSync(runRecordPath(base, 'verdict_review.json'), JSON.stringify({ pass: true, audit_findings: { version: 1, findings: [] } }));
    const before = readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8'), receiptBefore = readFileSync(receiptPath, 'utf8');
    const unverified = { exitCode: 0, state: 'unverified', measurement: 'unverified', sourceBound: false };
    expect(projectValidationFact(fact)).toMatchObject({ pass: false, executions: [{ commands: [unverified] }], delta: [{ state: 'unverified' }] });
    expect(readValidationDelta(receiptPath)).toMatchObject({ pass: false, current: [unverified], delta: [{ state: 'unverified' }] });
    expect(currentValidationResults(root, runId)).toMatchObject([unverified]);
    const gate = readGateEvaluation(root, 'review', runId)!;
    expect(gate).toMatchObject({ pass: true, validation: [unverified] });
    expect(gate.reason).toContain('Validation unverified');
    const terminal = await concludeRun(readRunState(root, runId), { status: 'complete', reasonCode: 'workflow_complete' });
    expect(terminal).toMatchObject({ status: 'incomplete', reasonCode: 'validation_unresolved', validation: [unverified] });
    expect(readRunStateView(root, runId).validation).toMatchObject([unverified]);
    expect(JSON.stringify(summarizeRunStateView(readRunStateView(root, runId)))).toContain('"sourceBound":false');
    const alerts = pollWatch(createWatchState(), { runsRoot: resolve(base, '..'), candidateRunIds: () => [runId] }).alerts;
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'validation_measurement', measurement: 'unverified', state: 'unverified' }));
    const summary = renderRunSummary(root, base, terminal);
    expect(summary).toContain('source-mutating command: unverified (direct exit 0)');
    expect(summary).toContain('comparison unverified');
    expect(summary).not.toContain('comparison verified');
    expect(readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8')).toBe(before);
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBefore);
  });

  it('preserves unresolved inline legacy coverage without interpreting its reason', () => {
    const root = project(), path = join(root, 'inline.json');
    const current = [{ role: 'test', display: 'legacy command', state: 'passed', exitCode: 0,
      output: '', durationMs: 1, failureIdentifiers: [], failureIdentity: 'none' }];
    const receipt = JSON.stringify({ version: 1, current, pass: false,
      delta: [{ role: 'test', display: 'legacy command', state: 'unresolved', reason: 'opaque legacy fact', newFailureIdentifiers: [] }] });
    writeFileSync(path, receipt);
    expect(readValidationDelta(path)).toMatchObject({ pass: false, current: [{ exitCode: 0, sourceBound: false, measurement: 'unverified' }], delta: [{ state: 'unverified' }] });
    expect(readFileSync(path, 'utf8')).toBe(receipt);
  });

  it.each([1, 2])('preserves role-only inline legacy uncertainty in readers and reports (version=%s)', version => {
    const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['review']);
    const command = { role: 'test', display: 'legacy check', state: 'passed', exitCode: 0,
      output: '', durationMs: 1, failureIdentifiers: [], failureIdentity: 'none' };
    const current = [command, { ...command, display: 'another check' }, { ...command, role: 'lint', display: 'lint check' }];
    const path = runRecordPath(base, 'validation_delta_review.json');
    for (const display of [undefined, command.display]) {
      const receipt = JSON.stringify({ version, stageId: 'review', current, pass: false,
        delta: [{ role: 'test', ...(display === undefined ? {} : { display }), state: 'unresolved',
          reason: 'Opaque historical source coverage', newFailureIdentifiers: [] }] });
      writeFileSync(path, receipt);
      const read = readValidationDelta(path)!;
      expect(read).toMatchObject({ pass: false, current: [
        { exitCode: 0, sourceBound: false, measurement: 'unverified' },
        { exitCode: 0, measurement: display === undefined ? 'unverified' : 'verified' },
        { exitCode: 0, measurement: 'verified' },
      ] });
      const summary = renderRunSummary(root, base, readRunState(root, runId));
      expect(summary).toContain('comparison unverified');
      expect(summary).not.toContain('comparison verified');
      expect(readFileSync(path, 'utf8')).toBe(receipt);
    }
  });

  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/control-validation-history.json', import.meta.url), 'utf8')) as Array<{ sequence: number; commands: ValidationCommandResult[] }>;
  it.each(fixtures)('projects b4c75c fact $sequence without changing its recorded labels', async fixture => {
    const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['author', 'review']);
    const commands = fixture.commands;
    const baseline = { version: 1, projectDir: root, results: commands, gateCriteria: [], discovery: { state: 'configured', configPath: 'fixture', missingRoles: [],
      commands: commands.map(command => ({ role: command.role, command: 'fixture', args: [], display: command.display })) } };
    writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline }));
    const fact = seedAttemptValidation(root, runId, commands, { delta: commands.map(command => ({ role: command.role, display: command.display, state: 'not_measured', reason: 'Historical stored interpretation', newFailureIdentifiers: [] })) });
    const attempt = readStageStatus(root, runId, 'author').attempts!.at(-1)!;
    appendEvidence(base, { kind: 'attempt', stageId: 'author', attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, exitCode: 0,
      status: 'complete', treeHash: fact.treeHash, files: [], measurements: { inputTokens: 0, outputTokens: 0, durationMs: 1, provenance: 'adapter-reported' } });
    writeStageStatus(root, runId, 'review', { status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' }],
      gate: { pass: true, validationRequired: true, kind: 'pass', verdictSha256: null,
        validation: commands.map(command => ({ role: command.role, exitCode: command.exitCode, state: command.state, measurement: command.measurement!, load: command.load })) } });
    await recordGateValidationDelta(root, runId, 'review');
    const before = readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8');
    const view = readRunStateView(root, runId);
    expect(view.stages.review.gate?.validation?.map(result => result.measurement)).toEqual(['verified', 'verified', 'verified']);
    expect(JSON.stringify(summarizeRunStateView(view))).toContain('\"measurement\":\"verified\"');
    for (const command of commands) expect(projectValidationResult(command)).toEqual({ state: 'passed', measurement: 'verified' });
    expect(evaluateValidationDelta({ results: commands }, commands).map(entry => entry.state)).toEqual(['verified', 'verified', 'verified']);
    expect(projectValidationFact(fact).delta.map(entry => entry.state)).toEqual(['verified', 'verified', 'verified']);
    expect(currentAuthorValidationRefusal(root, runId)).toBeUndefined();
    const verdict = readGateEvaluation(root, 'review', runId)!;
    expect(verdict.pass).toBe(true);
    expect(verdict.validation?.map(command => command.state)).toEqual(['passed', 'passed', 'passed']);
    expect(verdict.validation?.map(command => command.storedState)).toEqual(commands.map(command => command.state));
    const delta = readValidationDelta(runRecordPath(base, 'validation_delta_review.json'))!;
    expect(delta.current.map(command => command.state)).toEqual(['passed', 'passed', 'passed']);
    expect(delta.delta.map(entry => entry.state)).toEqual(['verified', 'verified', 'verified']);
    const alerts = pollWatch(createWatchState(), { runsRoot: resolve(base, '..'), candidateRunIds: () => [runId] }).alerts.filter(alert => alert.kind === 'validation_measurement');
    expect(alerts).toHaveLength(3);
    for (const alert of alerts) expect(alert).toMatchObject({ state: 'passed', measurement: 'verified' });
    const summary = renderRunSummary(root, base, readRunState(root, runId));
    expect(summary).toContain('comparison verified');
    expect(summary.match(/passed \(verified\)/g)).toHaveLength(3);
    expect(summary).toContain('recorded state not_measured');
    const display = evidenceContext(root, base);
    for (const field of ['"storedState":"not_measured"', '"measurement":"verified"', '"state":"passed"']) expect(display).toContain(field);
    expect(readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8')).toBe(before);
    writeFileSync(runRecordPath(base, 'validation_delta_legacy.json'), JSON.stringify({ version: 2, pass: false, stageId: 'legacy', current: commands, delta: fact.delta }));
    const legacy = readValidationDelta(runRecordPath(base, 'validation_delta_legacy.json'))!;
    for (const command of legacy.current) expect(command).toMatchObject({ state: 'passed', measurement: 'verified' });
    expect(legacy.delta.map(entry => entry.state)).toEqual(['verified', 'verified', 'verified']);
    expect(legacy.pass).toBe(true);
    expect(renderRunSummary(root, base, readRunState(root, runId))).toContain('legacy — comparison verified');
    expect(readFileSync(runRecordPath(base, 'validation_delta_legacy.json'), 'utf8')).toBe(JSON.stringify({ version: 2, pass: false, stageId: 'legacy', current: commands, delta: fact.delta }));
  });

  it('keeps inline red comparison unknown when the base execution is unavailable', () => {
    const root = project(), path = join(root, 'inline.json');
    const command: ValidationCommandResult = { role: 'test', state: 'not_measured', measurement: 'not_measured', exitCode: 1,
      output: '', durationMs: 1, failureIdentifiers: ['current-only'], failureIdentity: 'known', failureEvidence: 'complete',
      load: { start: { loadAverage1m: 0, cpuCount: 1 }, end: { loadAverage1m: 0, cpuCount: 1 }, ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 } };
    writeFileSync(path, JSON.stringify({ version: 2, current: [command], delta: [{ role: 'test', state: 'not_measured' }], pass: false }));
    expect(readValidationDelta(path)).toMatchObject({ pass: false, current: [{ state: 'failed', measurement: 'unverified', storedState: 'not_measured' }],
      delta: [{ state: 'unverified', reason: 'Command did not complete with exit 0' }] });
  });

  it('never republishes historical unconfigured slots as passing validation', () => {
    const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['author']);
    const commands: ValidationCommandResult[] = ['build', 'test', 'lint'].map(role => ({
      role: role as ValidationCommandResult['role'], state: 'not_configured', durationMs: 0, output: '',
      failureIdentifiers: [], failureIdentity: 'none', reason: 'No command was configured',
    }));
    const delta = commands.map(({ role }) => ({ role, state: 'pass' as const,
      reason: 'Historical absence was called a pass', newFailureIdentifiers: [] }));
    writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline: {
      version: 1, projectDir: root, discovery: { state: 'unknown', configPath: 'fixture', commands: [], missingRoles: ['build', 'test', 'lint'] },
      results: [], gateCriteria: [],
    } }));
    const fact = seedAttemptValidation(root, runId, commands, { delta });
    appendEvidence(base, { kind: 'attempt', stageId: fact.stageId, attemptIndex: fact.attemptIndex,
      attemptStartedAt: fact.attemptStartedAt, exitCode: 0, status: 'complete', treeHash: fact.treeHash, files: [],
      measurements: { inputTokens: 0, outputTokens: 0, durationMs: 1, provenance: 'adapter-reported' } });
    const before = readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8');
    expect(projectValidationFact(fact)).toMatchObject({ pass: false,
      delta: commands.map(({ role }) => ({ role, state: 'unverified' })) });
    const path = runRecordPath(base, 'validation_delta_legacy.json');
    writeFileSync(path, JSON.stringify({ version: 2, stageId: 'legacy', current: commands, delta, pass: true }));
    expect(readValidationDelta(path)).toMatchObject({ pass: false,
      delta: commands.map(({ role }) => ({ role, state: 'unverified' })) });
    expect(evidenceContext(root, base)).toContain('"pass":false');
    expect(renderRunSummary(root, base, readRunState(root, runId))).not.toContain('comparison verified');
    expect(readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8')).toBe(before);
  });

  it('retains auxiliary runner errors while projecting completed exit zero as a pass', async () => {
    const measured = await runProjectValidationBaseline('/workspace', { commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture' }],
      runCommand: () => ({ exitCode: 0, error: 'runner did not complete', load: { start: { loadAverage1m: 0, cpuCount: 1 }, end: { loadAverage1m: 0, cpuCount: 1 }, ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 } }) });
    const result = measured.results.find(command => command.role === 'test')!;
    expect(result).toMatchObject({ exitCode: 0, error: 'runner did not complete', state: 'passed' });
    expect(projectValidationResult(result)).toEqual({ state: 'passed', measurement: 'verified' });
    expect(evaluateValidationDelta({ results: [{ ...result, state: 'passed', error: undefined }] }, [result])[0].state).toBe('verified');
  });

  it.each(['overloaded', 'measured', 'missing-load'] as const)('preserves legacy runner errors across repeated projection and readers (%s)', async mode => {
    const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['author', 'review']);
    const command: ValidationCommandResult = { role: 'test', display: 'legacy command', state: 'launch_error', exitCode: 0,
      output: '', durationMs: 1, failureIdentifiers: [], failureIdentity: 'unknown',
      ...(mode === 'missing-load' ? {} : { load: { start: { loadAverage1m: mode === 'overloaded' ? 2 : 0, cpuCount: 1 },
        end: { loadAverage1m: 0, cpuCount: 1 }, ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 } }) };
    const expected = { state: 'passed', measurement: 'verified' };
    const once = { ...command, storedState: command.state, ...projectValidationResult(command) };
    expect(projectValidationResult(once)).toEqual(expected);
    const delta = evaluateValidationDelta(undefined, [command]);
    expect(evaluateValidationDelta(undefined, [once])).toEqual(delta);
    expect(delta[0].state).toBe('verified');
    const baseline = { version: 1, projectDir: root, results: [command], gateCriteria: [], discovery: { state: 'configured', configPath: 'fixture', missingRoles: [],
      commands: [{ role: 'test', command: 'fixture', args: [], display: command.display }] } };
    writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline }));
    const fact = seedAttemptValidation(root, runId, [command], { delta });
    const projected = projectValidationFact(fact);
    expect(projectValidationFact(projected)).toEqual(projected);
    expect(projected).toMatchObject({ pass: true, delta, executions: [{ commands: [{ ...expected, storedState: 'launch_error', exitCode: 0 }] }] });
    expect(currentAuthorValidationRefusal(root, runId)).toBeUndefined();
    writeStageStatus(root, runId, 'review', { status: 'complete', retries: 0,
      gate: { pass: false, validation: [once] } });
    const verdict = readGateEvaluation(root, 'review', runId)!;
    expect(verdict.validation![0]).toMatchObject({ ...expected, storedState: 'launch_error' });
    const alerts = pollWatch(createWatchState(), { runsRoot: resolve(base, '..'), candidateRunIds: () => [runId] }).alerts;
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'validation_measurement', ...expected, storedState: 'launch_error' }));
    const before = readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8');
    for (const ledgerSequence of [undefined, fact.sequence]) {
      const path = runRecordPath(base, 'validation_delta_review.json');
      const raw = JSON.stringify({ version: 2, stageId: 'review', pass: false, current: [command], delta, ledgerSequence });
      writeFileSync(path, raw);
      const receipt = readValidationDelta(path)!;
      expect(receipt).toMatchObject({ pass: true, delta, current: [{ ...expected, storedState: 'launch_error' }] });
      // Re-reading a projected receipt must preserve its raw runner-error fact too.
      writeFileSync(path, JSON.stringify(receipt));
      expect(readValidationDelta(path)).toEqual(receipt);
      const summary = renderRunSummary(root, base, readRunState(root, runId));
      expect(summary).toContain('recorded state launch_error');
      expect(summary).toContain('comparison verified');
      expect(readFileSync(runRecordPath(base, 'evidence-ledger.jsonl'), 'utf8')).toBe(before);
    }
  });
});


it('retains an explicitly unrun command as unverified and refuses successful terminal publication', async () => {
  const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['review']);
  writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline: {
    version: 1, projectDir: root, discovery: { state: 'configured', configPath: 'fixture', commands: [
      { role: 'test', command: 'declared', args: [], display: 'declared' },
    ], missingRoles: ['build', 'lint'] }, results: [], gateCriteria: [],
  } }));
  writeFileSync(runRecordPath(base, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Independent acceptance of the stated unrun command',
    audit_findings: { version: 1, findings: [] }, validation_review: { commands: [{ role: 'test', display: 'declared', disposition: 'unknown', reason: 'No execution was available' }], request_base: [] } }));
  const gate = readGateEvaluation(root, 'review', runId)!;
  expect(gate.pass).toBe(true);
  expect(gate.validation).toEqual([expect.objectContaining({ exitCode: null, state: 'unverified', measurement: 'unverified' })]);
  const terminal = await concludeRun(readRunState(root, runId), { status: 'complete', reasonCode: 'workflow_complete' });
  expect(terminal.status).toBe('incomplete');
  expect(terminal.reasonCode).toBe('validation_unresolved');
  expect(terminal.validation).toEqual([expect.objectContaining({ exitCode: null, state: 'unverified', measurement: 'unverified' })]);
  expect(renderRunSummary(root, base, terminal)).toContain('declared: unverified (direct exit absent)');
  const view = readRunStateView(root, runId);
  expect(view.validation).toEqual([expect.objectContaining({ exitCode: null, measurement: 'unverified' })]);
  expect(JSON.stringify(summarizeRunStateView(view))).toContain('\"measurement\":\"unverified\"');
  const alerts = pollWatch(createWatchState(), { runsRoot: resolve(base, '..'), candidateRunIds: () => [runId] }).alerts;
  expect(alerts).toContainEqual(expect.objectContaining({ kind: 'validation_measurement', role: 'declared', measurement: 'unverified' }));
});


it('retains legacy diagnostics while completed zero exits stay verified through every reader', async () => {
  const root = project(), { runId, runDirPath: base } = createRun(root, 'fixture', 'name: fixture', ['author', 'review']);
  const commands = [
    { role: 'build', command: 'build', args: [], display: 'build' },
    { role: 'test', command: 'test', args: [], display: 'test' },
  ];
  writeFileSync(runRecordPath(base, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline: {
    version: 1, projectDir: root, discovery: { state: 'configured', configPath: 'fixture', commands, missingRoles: ['lint'] }, results: [], gateCriteria: [],
  } }));
  seedAttemptValidation(root, runId, [
    { role: 'build', display: 'build', state: 'launch_error', exitCode: 0, durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'unknown' },
    { role: 'test', display: 'test', state: 'passed', exitCode: 0, dependencyPreparationFailed: true, durationMs: 1, output: '', failureIdentifiers: [], failureIdentity: 'unknown' },
  ]);
  writeFileSync(runRecordPath(base, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Independent acceptance with two legacy execution gaps', audit_findings: { version: 1, findings: [] } }));
  const gate = readGateEvaluation(root, 'review', runId)!;
  expect(gate.pass).toBe(true);
  expect(gate.validation?.map(result => projectValidationResult(result).measurement)).toEqual(['verified', 'verified']);
  const terminal = await concludeRun(readRunState(root, runId), { status: 'complete', reasonCode: 'workflow_complete' });
  expect(terminal.validation?.map(result => projectValidationResult(result).measurement)).toEqual(['verified', 'verified']);
  expect(readRunStateView(root, runId).validation?.map(result => result.measurement)).toEqual(['verified', 'verified']);
  const alerts = pollWatch(createWatchState(), { runsRoot: resolve(base, '..'), candidateRunIds: () => [runId] }).alerts;
  expect(alerts.filter(alert => alert.kind === 'validation_measurement').map(alert => alert.measurement)).toEqual(['verified', 'verified']);
});


it('projects historical accepted-from validation facts in watch', () => {
  const results = [{ role: 'test', display: 'legacy test', state: 'not_measured', exitCode: 1, measurement: 'not_measured',
    load: { start: { loadAverage1m: 48, cpuCount: 8 }, end: { loadAverage1m: 48, cpuCount: 8 }, ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 } }];
  const poll = pollWatch(createWatchState(), { runsRoot: '/workspace/runs', candidateRunIds: () => ['history'],
    readText: path => {
      if (!path.endsWith('/run.json')) throw Error('No other fixture artifacts');
      return JSON.stringify({ status: 'complete', stages: { review: { acceptedFrom: { verdict: { pass: true, validation: results } } } } });
    },
  });
  expect(poll.alerts).toContainEqual(expect.objectContaining({ kind: 'validation_measurement', state: 'failed', measurement: 'unverified' }));
});
