import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as validation from '../src/project-validation.js';
import { EngineStateError } from '../src/engine-integrity.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { loadWorkflow } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
import { runDir } from '../src/store.js';
import type { Adapter } from '../src/adapters/base.js';
import { renderRunSummary } from '../src/run-summary.js';
import { pollWatch, createWatchState } from '../src/watch.js';
import { formatWatchPoll } from '../src/cli-watch.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sample = (loadAverage1m = 48, cpuCount = 8) => ({ loadAverage1m, cpuCount });
// Include the old receipt's declared ceiling to exercise its actual mask when the fix is reverted.
const load = (reading = sample()) => ({ start: reading, end: reading,
  ceilingPerCpu: 1, waitBoundSeconds: 0, waitedSeconds: 0 });
const result = (exitCode: number, reading?: validation.ValidationLoad): validation.ValidationCommandResult => ({
  role: 'test', state: exitCode ? 'failed' : 'passed', exitCode, output: '', durationMs: 1,
  failureIdentifiers: exitCode ? ['opaque test'] : [], failureIdentity: exitCode ? 'known' : 'none', ...(reading ? { load: reading } : {}),
});

describe('host load is telemetry, never a command judgment', () => {
  it('records start and end without waiting or spending the command allowance', async () => {
    const samples = [sample(), sample(80)], wait = vi.fn(), execute = vi.fn(() => ({ exitCode: 4 }));
    const receipt = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace', timeoutMs: 5000 }, execute,
      { sample: () => samples.shift()!, wait });
    expect(wait).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][0]).toMatchObject({ timeoutMs: 5000 });
    expect(receipt).toMatchObject({ exitCode: 4, load: { start: sample(), end: sample(80) } });
    expect(Object.keys(receipt.load!).sort()).toEqual(['end', 'start']);
  });

  it.each(['start', 'end'] as const)('keeps the real exit when the %s load sample is unavailable', async boundary => {
    let calls = 0;
    const execute = vi.fn(() => ({ exitCode: 4, stdout: 'real failure' }));
    const receipt = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace' }, execute,
      { sample: () => { if (++calls === (boundary === 'start' ? 1 : 2)) throw Error('load unavailable'); return sample(); } });
    expect(execute).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ exitCode: 4, stdout: 'real failure', load: { [boundary]: null } });
    expect(validation.projectValidationResult(receipt)).toEqual({ state: 'failed', measurement: 'unverified' });
  });

  it('retains both load samples and an absent exit when execution throws', async () => {
    const readings = [sample(48), sample(2)];
    const response = await validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace' },
      () => { throw Error('fixture launch refused'); }, { sample: () => readings.shift()! });
    expect(response).toMatchObject({ exitCode: null, error: 'fixture launch refused', load: { start: sample(48), end: sample(2) } });
    expect(validation.projectValidationResult(response)).toEqual({ state: 'unverified', measurement: 'unverified' });
  });

  it('preserves typed integrity violations even when telemetry sampling is unavailable', async () => {
    const error = new EngineStateError('ENGINE_STATE_TAMPERED: fixture integrity violation');
    await expect(validation.withValidationLoad({ role: 'test', command: 'fixture', args: [], display: 'fixture', cwd: '/workspace' },
      () => { throw error; }, { sample: () => { throw Error('load unavailable'); } })).rejects.toBe(error);
  });

  it.each([127, 4, 1, 2])('retains historical above-ceiling exit %s in every receipt projection', async exitCode => {
    const raw = { ...result(exitCode, load()), state: 'not_measured', measurement: 'not_measured' };
    expect(validation.projectValidationResult(raw)).toEqual({ state: 'failed', measurement: 'unverified' });
    const batch = await validation.runProjectValidationBaseline('/workspace', {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture' }], runCommand: () => raw,
    });
    expect(batch.results[0]).toMatchObject({ state: 'failed', measurement: 'unverified', exitCode });
    expect(validation.evaluateValidationDelta({ results: [result(0)] }, batch.results)[0].state).toBe('unverified');
    const watched = pollWatch(createWatchState(), { runsRoot: '/workspace/runs', candidateRunIds: () => ['fixture'],
      readText: path => {
        if (!path.endsWith('/run.json')) throw Error('fixture has no other files');
        return JSON.stringify({ status: 'complete', stages: { review: { gate: { validation: [{ role: 'test', ...raw }] } } } });
      } });
    expect(watched.alerts.find(alert => alert.kind === 'validation_measurement')).toMatchObject({ state: 'failed', measurement: 'unverified' });
  });

  it.each([undefined, { start: sample(NaN), end: sample(-1) }])('uses raw exits even with unavailable telemetry (%j)', load => {
    expect(validation.projectValidationResult({ exitCode: 0, load })).toEqual({ state: 'passed', measurement: 'verified' });
    expect(validation.projectValidationResult({ exitCode: 1, load })).toEqual({ state: 'failed', measurement: 'unverified' });
    expect(validation.projectValidationResult({ exitCode: 0, unfinished: true, load })).toEqual({ state: 'unverified', measurement: 'unverified' });
    expect(validation.projectValidationResult({ load })).toEqual({ state: 'unverified', measurement: 'unverified' });
  });

  it.each([127, 4, 1, 2, 0])('publishes exit %s under load in gate, run facts, ledger, watch and report from the single completed engine record', async exitCode => {
    const measurement = exitCode === 0 ? 'verified' : 'unverified';
    const project = mkdtempSync(join(tmpdir(), 'load-gate-')); roots.push(project);
    const runner = vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({ exitCode, stdout: exitCode === 0 ? '' : 'arbitrary failure', load: load() });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.7', scripts: { test: 'fixture-check' } }));
    writeFileSync(join(project, 'fixture-exit.txt'), String(exitCode));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
        return { output: JSON.stringify({ pass: true, reason: 'Independent criteria satisfied; validation unverified if any command failed', audit_findings: { version: 1, findings: [] },
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Read value' }])) }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      mkdirSync(join(project, 'docs'), { recursive: true }); writeFileSync(join(project, 'docs/value.txt'), 'value');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Value', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1,
        writes: ['docs/value.txt'], writeAttribution: 'structured' };
    } };
    const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Value is independently checked.\"}]\noutputs: [docs/value.txt]\nvalidation:\n  commands:\n    test:\n      command: fixture-check\n      args: []\n---\n# Deliver a value\n\n## Acceptance criteria\n1. Value is independently checked.\n";
    const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
    expect(final.status).toBe(exitCode === 0 ? 'complete' : 'incomplete');
    expect(calls.slice(0, 2)).toEqual(['implement', 'review']); expect(runner).toHaveBeenCalledTimes(1);
    expect(final.stages.review.gate).toMatchObject({ pass: exitCode === 0, validation: [{ role: 'test', measurement, exitCode, load: load() }] });
    if (exitCode !== 0) {
      expect(final.stages.repair.attempts?.length).toBeGreaterThan(0);
    }
    else expect(final.stages.review.gate?.reason).not.toContain('Validation not measured (');
    const directory = runDir(project, final.runId), fact = readEvidence(directory).find(entry => entry.kind === 'validation')!;
    if (fact.kind !== 'validation') throw Error('missing validation');
    expect(fact.executions.map(execution => [execution.target, execution.rerun ?? false, execution.commands[0].exitCode])).toEqual([['attempt', false, exitCode]]);
    expect(fact.regressions ?? []).toEqual([]);
    expect(fact.pass).toBe(exitCode === 0); expect(fact.delta.find(entry => entry.role === 'test')?.state).toBe(exitCode === 0 ? 'verified' : 'unverified');
    expect(fact.executions[0].commands[0]).toMatchObject({ exitCode, state: exitCode === 0 ? 'passed' : 'failed', measurement, load: load() });
    expect(readFileSync(runRecordPath(directory, 'iteration_log.md'), 'utf8')).toContain(`Gate verdict: ${exitCode === 0 ? 'PASS' : 'FAIL'}; validation: test: ${measurement.replaceAll('_', ' ')}`);
    const summary = renderRunSummary(project, directory, final);
    expect(summary).toContain(exitCode === 0 ? 'passed (verified)' : 'failed (unverified)');
    const watched = pollWatch(createWatchState(), { runsRoot: resolve(directory, '..'), candidateRunIds: () => [final.runId] });
    expect(formatWatchPoll(watched).join('\n')).toContain(exitCode === 0 ? 'fixture-check: verified' : 'fixture-check: unverified');
  });
});
