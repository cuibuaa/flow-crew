import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as validation from '../src/project-validation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { runWorkflow, loadWorkflow } from '../src/scheduler.js';
import { runDir } from '../src/store.js';
import type { Adapter } from '../src/adapters/base.js';
import { renderRunSummary } from '../src/run-summary.js';
import { pollWatch, createWatchState } from '../src/watch.js';
import { formatWatchPoll } from '../src/cli-watch.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sample = (loadAverage1m = 48, cpuCount = 8) => ({ loadAverage1m, cpuCount });
const load = (reading = sample()): validation.ValidationLoad => ({ start: reading, end: reading,
  ceilingPerCpu: 1, waitBoundSeconds: 30, waitedSeconds: 30 });
const result = (exitCode: number, reading?: validation.ValidationLoad): validation.ValidationCommandResult => ({
  role: 'test', state: exitCode ? 'failed' : 'passed', exitCode, output: '', durationMs: 1,
  failureIdentifiers: exitCode ? ['opaque test'] : [], failureIdentity: exitCode ? 'known' : 'none', ...(reading ? { load: reading } : {}),
});

describe('validation measurement is code on bounded host readings', () => {
  it('records both readings, CPUs, ceiling, bound and actual wait, then runs anyway under load', async () => {
    setEngineDefaults({ validation_load_ceiling_per_cpu: 1, validation_load_wait_seconds: 3 });
    let now = 0;
    const execute = vi.fn(() => ({ exitCode: 1, stdout: 'opaque failure' }));
    const receipt = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace', timeoutMs: 5000 }, execute,
      { sample: () => sample(), now: () => now, wait: async ms => { now += ms; } });
    expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]).toHaveLength(1);
    expect(receipt).toMatchObject({ exitCode: 1, measurement: 'not_measured', load: {
      start: sample(), end: sample(), ceilingPerCpu: 1, waitBoundSeconds: 3, waitedSeconds: 3,
    } });
    expect(execute.mock.calls[0][0]).toMatchObject({ timeoutMs: 2000 });
  });

  it('retains actual elapsed waiting after a delayed wakeup and measures a pass under load', async () => {
    setEngineDefaults({ validation_load_ceiling_per_cpu: 1, validation_load_wait_seconds: 1 });
    let now = 0;
    const execute = vi.fn(() => ({ exitCode: 0 }));
    const receipt = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace', timeoutMs: 5000 }, execute,
      { sample: () => sample(), now: () => now, wait: async ms => { now += ms + 1000; } });
    expect(receipt.load).toMatchObject({ waitBoundSeconds: 1, waitedSeconds: 2 });
    expect(receipt.measurement).toBe('measured');
    expect(execute.mock.calls[0][0]).toMatchObject({ timeoutMs: 3000 });
  });

  it('starts after recovery, bounds waiting by the enclosing deadline, and retains end load as information', async () => {
    setEngineDefaults({ validation_load_ceiling_per_cpu: 1, validation_load_wait_seconds: 30 });
    let now = 0, samples = [sample(), sample(2), sample(10)];
    const response = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace', timeoutMs: 1500 },
      () => ({ exitCode: 0 }), { sample: () => samples.shift()!, now: () => now, wait: async ms => { now += ms; } });
    expect(response.load).toMatchObject({ start: sample(2), end: sample(10), waitBoundSeconds: 1.5, waitedSeconds: 1 });
    expect(response.measurement).toBe('measured');
    now = 0; samples = [sample(), sample(), sample(), sample()];
    const bounded = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace', timeoutMs: 1500 },
      () => ({ exitCode: 1 }), { sample: () => samples.shift()!, now: () => now, wait: async ms => { now += ms; } });
    expect(bounded.load?.waitedSeconds).toBe(1.5);
    expect(now).toBe(1500);
  });

  it('keeps 11/05 #2433 historical failures at load 48/8 not measured and measures green exits', () => {
    // Recorded test exits/counts from the supplied historical review receipts.
    // Load was observed by the operator, never present in the original receipts.
    const historical = [
      { identity: 'attempt_1_aa31f4fa4a1de155', exitCode: 0, failures: 0 },
      { identity: 'attempt_2_702b6010522a8f2f', exitCode: 1, failures: 14 },
      { identity: 'attempt_2_2832f0b2c62e4650', exitCode: 1, failures: 5 },
      { identity: 'attempt_3_524074ef499b6039', exitCode: 1, failures: 1 },
      { identity: 'attempt_4_7039b39817fc4553', exitCode: 0, failures: 0 },
    ];
    for (const fixture of historical) {
      const receipt = { ...result(fixture.exitCode, load()), failureCount: fixture.failures };
      expect(validation.validationMeasurement(receipt), fixture.identity).toBe(fixture.exitCode === 0 ? 'measured' : 'not_measured');
      const baseline: validation.ProjectValidationBaseline = { version: 1, projectDir: '/workspace', discovery: {
        state: 'configured', configPath: 'fixture', commands: [], missingRoles: [],
      }, results: [result(0, load(sample(1)))], gateCriteria: [] };
      expect(validation.evaluateValidationDelta(baseline, [receipt])[0].state).toBe(fixture.exitCode === 0 ? 'pass' : 'not_measured');
    }
    expect(validation.validationMeasurement(result(1, load(sample(8))))).toBe('measured');
    // A runner error or timeout that still reports exit 0 is a failure, not a pass.
    expect(validation.validationMeasurement({ exitCode: 0, error: 'timed out', load: load() })).toBe('not_measured');
    expect(validation.validationMeasurement({ exitCode: 0, state: 'launch_error', load: load() })).toBe('not_measured');
    expect(validation.validationMeasurement({ exitCode: 0, load: load() })).toBe('measured');
    expect(validation.validationMeasurement(result(0))).toBe('load_unknown');
    expect(validation.validationMeasurement({ load: { ...load(), waitedSeconds: 31 } })).toBe('not_measured');
    expect(validation.validationMeasurement({ load: { ...load(), waitedSeconds: Infinity } })).toBe('load_unknown');
    expect(validation.validationMeasurement({ load: { ...load(), end: sample(NaN) } })).toBe('load_unknown');
    expect(validation.validationMeasurement({ load: { ...load(), start: sample(1, 0) } })).toBe('load_unknown');
  });

  it.each([
    { exitCode: 0, start: 48, end: 48, measurement: 'measured', state: 'passed' },
    { exitCode: 0, start: 2, end: 48, measurement: 'measured', state: 'passed' },
    { exitCode: 0, start: 48, end: 2, measurement: 'measured', state: 'passed' },
    { exitCode: 1, start: 48, end: 2, measurement: 'not_measured', state: 'not_measured' },
    { exitCode: 1, start: 2, end: 48, measurement: 'measured', state: 'failed' },
    { exitCode: 1, start: 8, end: 48, measurement: 'measured', state: 'failed' },
    { exitCode: null, error: 'timed out', start: 48, end: 2, measurement: 'not_measured', state: 'not_measured' },
    { exitCode: null, error: 'timed out', start: 2, end: 48, measurement: 'measured', state: 'launch_error' },
    { exitCode: 127, error: 'could not launch', start: 48, end: 2, measurement: 'not_measured', state: 'not_measured' },
    { exitCode: 127, error: 'could not launch', start: 2, end: 48, measurement: 'measured', state: 'launch_error' },
  ])('uses exit $exitCode and start $start, retaining end $end: $measurement / $state', async fixture => {
    setEngineDefaults({ validation_load_ceiling_per_cpu: 1, validation_load_wait_seconds: 1 });
    const reading = { ...load(sample(fixture.start)), end: sample(fixture.end) };
    let now = 0, executed = false;
    const receipt = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace' },
      () => { executed = true; return { exitCode: fixture.exitCode, error: fixture.error }; }, {
        sample: () => executed ? reading.end : reading.start, now: () => now,
        wait: async ms => { now += ms; },
      });
    expect(receipt).toMatchObject({ measurement: fixture.measurement, load: { start: reading.start, end: reading.end } });
    // Consumers must classify the exit facts, even with a stale cached label.
    const response = { ...receipt, measurement: 'not_measured' as const };
    expect(validation.validationMeasurement(response)).toBe(fixture.measurement);
    const baseline = await validation.runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture' }], runCommand: () => response,
    });
    const command = baseline.results.find(entry => entry.role === 'test')!;
    expect(command).toMatchObject({ state: fixture.state, measurement: fixture.measurement, load: receipt.load });
    if (fixture.exitCode === 0) expect(validation.unmeasured(command)).toBe(false);
    if (fixture.exitCode === 1) {
      const known = { ...result(1, reading), failureIdentity: 'known' as const };
      expect(validation.unmeasured(known)).toBe(fixture.measurement === 'not_measured');
      expect(validation.evaluateValidationDelta({ ...baseline, results: [result(0, load(sample(1)))] }, [known])[0].state)
        .toBe(fixture.measurement === 'not_measured' ? 'not_measured' : 'regression');
    }
    const watched = pollWatch(createWatchState(), {
      runsRoot: '/workspace/runs', candidateRunIds: () => ['fixture'],
      readText: path => {
        if (!path.endsWith('/run.json')) throw Error('fixture has no other files');
        return JSON.stringify({ status: 'complete', stages: { review: { gate: { validation: [{ role: 'test', ...response }] } } } });
      },
    });
    expect(watched.alerts.find(alert => alert.kind === 'validation_measurement')).toMatchObject({ measurement: fixture.measurement });
  });

  it('keeps legacy and malformed successful readings load unknown in watch', () => {
    const watched = pollWatch(createWatchState(), {
      runsRoot: '/workspace/runs', candidateRunIds: () => ['fixture'],
      readText: path => {
        if (!path.endsWith('/run.json')) throw Error('fixture has no other files');
        return JSON.stringify({ status: 'complete', stages: { review: { gate: { validation: [
          { role: 'test', exitCode: 0, measurement: 'measured' },
          { role: 'lint', exitCode: 0, load: { ...load(), end: sample(-1) }, measurement: 'measured' },
        ] } } } });
      },
    });
    expect(watched.alerts.filter(alert => alert.kind === 'validation_measurement').map(alert => alert.measurement))
      .toEqual(['load_unknown', 'load_unknown']);
    expect(validation.validationMeasurement({ exitCode: 0, load: { ...load(), end: sample(NaN) } })).toBe('load_unknown');
  });

  it.each([1, 0])('publishes exit %s under load in gate, run facts, ledger, watch and report without a second validation', async exitCode => {
    const measurement = exitCode === 0 ? 'measured' : 'not_measured';
    const project = mkdtempSync(join(tmpdir(), 'load-gate-')); roots.push(project);
    const runner = vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({ exitCode, stdout: exitCode === 0 ? '' : 'arbitrary failure', load: load() });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.7', scripts: { test: 'fixture-check' } }));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
        return { output: JSON.stringify({ pass: true, reason: 'Independent criteria satisfied; validation not measured', audit_findings: { version: 1, findings: [] },
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Read value' }])) }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      mkdirSync(join(project, 'docs'), { recursive: true }); writeFileSync(join(project, 'docs/value.txt'), 'value');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Value', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1,
        writes: ['docs/value.txt'], writeAttribution: 'structured' };
    } };
    const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
    const brief = '---\noutputs: [docs/value.txt]\nvalidation:\n  commands:\n    test:\n      command: fixture-check\n      args: []\n---\n# Deliver a value\n\n## Acceptance criteria\n1. Value is independently checked.\n';
    const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
    expect(final.status).toBe('complete'); expect(calls).toEqual(['implement', 'review']); expect(runner).toHaveBeenCalledTimes(1);
    expect(final.stages.review.gate).toMatchObject({ pass: true, validation: [{ role: 'test', measurement, exitCode, load: load() }] });
    if (exitCode !== 0) {
      expect(final.stages.repair.attempts ?? []).toHaveLength(0);
    }
    else expect(final.stages.review.gate?.reason).not.toContain('Validation not measured (');
    const directory = runDir(project, final.runId), fact = readEvidence(directory).find(entry => entry.kind === 'validation')!;
    if (fact.kind !== 'validation') throw Error('missing validation');
    expect(fact.pass).toBe(exitCode === 0); expect(fact.delta.find(entry => entry.role === 'test')?.state).toBe(exitCode === 0 ? 'pass' : 'not_measured');
    expect(fact.executions[0].commands[0]).toMatchObject({ exitCode, state: exitCode === 0 ? 'passed' : 'not_measured', measurement, load: load() });
    expect(readFileSync(join(directory, 'iteration_log.md'), 'utf8')).toContain(`Gate verdict: PASS; validation: test: ${measurement.replaceAll('_', ' ')}`);
    const summary = renderRunSummary(project, directory, final);
    expect(summary).toContain(exitCode === 0 ? 'passed (measured)' : 'not measured (neither pass nor failure');
    const watched = pollWatch(createWatchState(), { runsRoot: resolve(directory, '..'), candidateRunIds: () => [final.runId] });
    expect(formatWatchPoll(watched).join('\n')).toContain(exitCode === 0 ? 'fixture-check: measured' : 'not measured; neither pass nor failure; no author action required');
  });
});
