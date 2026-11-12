import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { runWorkflow, loadWorkflow } from '../src/scheduler.js';
import { readEvidence, type ValidationFact, type ValidationExecution } from '../src/evidence-ledger.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { recordAttemptValidation, snapshotShipSetupValidationBaseline } from '../src/scheduler/sched_settlement/gate-validation.js';
import { runDir, writeStageStatus } from '../src/store.js';
import { runProjectCommand, type ValidationRunRequest, type ValidationRunResponse } from '../src/project-validation.js';
import { createRun } from './test-support/create-run.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'confirmed-validation-')); roots.push(root); return root; }
function commit(root: string) {
  isolatedProjectCommand('git', ['init', '-q'], root, root);
  isolatedProjectCommand('git', ['add', '.'], root, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], root, root);
}
const command = { command: process.execPath, args: ['check.mjs'] };
function declaration(root: string, commands: Record<string, unknown>) {
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/validation.json'), JSON.stringify({ commands }));
}
const complete = { status: 'complete' as const, retries: 0, exitCode: 0,
  attempts: [{ index: 1, status: 'complete' as const, startedAt: 'start', completedAt: 'end', exitCode: 0 }] };
const alone = (fact: ValidationFact) => fact.executions.filter(execution => (execution as ValidationExecution & { rerun?: true }).rerun);

async function measure(shape: 'regression' | 'changing-tree' | 'regression-error' | 'flaky' | 'base-red' | 'base-hang' | 'hang' | 'real-hang' | 'slow-rerun' | 'green', options: { reporter?: boolean; template?: boolean; collection?: boolean; invalidReport?: boolean } = {}) {
  setEngineDefaults({ validation_timeout_ms: shape === 'slow-rerun' ? 100 : 10000 });
  const root = project();
  mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'base');
  writeFileSync(join(root, 'check.mjs'), shape === 'real-hang' ? "console.log('hang-started'); setInterval(()=>{},1000)" : shape === 'slow-rerun' ? "setTimeout(()=>{console.log('finite-complete');process.exit(0)},300)" : 'process.exit(0)');
  const test = { ...command, ...(options.reporter ? { report: { format: 'vitest-json' } } : {}),
    ...(options.template ? { rerun: { command: process.execPath, args: ['rerun.mjs', '{files}'] } } : shape === 'real-hang' || shape === 'slow-rerun' ? { rerun: { ...command, timeoutMs: shape === 'slow-rerun' ? 2000 : 1000 } } : {}) };
  declaration(root, { build: { ...command, args: ['build.mjs'] }, test, lint: { ...command, args: ['lint.mjs'] } });
  commit(root);
  const run = createRun(root, 'confirmation', 'name: confirmation\nstages: []\n', ['implement', 'review']);
  writeFileSync(runRecordPath(run.runDirPath, 'task_brief.md'), '# Validation confirmation\n');
  // Capture declarations and the committed base before an author can change bytes.
  snapshotShipSetupValidationBaseline(root, '# Validation confirmation\n', run.runDirPath);
  writeFileSync(join(root, 'docs/value.txt'), 'candidate');
  writeStageStatus(root, run.runId, 'implement', complete);
  const calls: ValidationRunRequest[] = []; let active = 0; let rerunValue: string | undefined;
  const runner = async (request: ValidationRunRequest): Promise<ValidationRunResponse> => {
    expect(active++).toBe(0);
    calls.push(request); await Promise.resolve();
    active--;
    const isBase = request.cwd !== root;
    const testCalls = calls.filter(call => call.role === 'test' && call.cwd === root).length;
    if (shape === 'changing-tree' && request.role === 'test' && !isBase) {
      if (testCalls === 1) writeFileSync(join(root, 'docs/value.txt'), 'transient');
      else { rerunValue = readFileSync(join(root, 'docs/value.txt'), 'utf8'); writeFileSync(join(root, 'docs/value.txt'), 'candidate'); }
    }
    const exitCode = request.role !== 'test' || shape === 'green' || isBase && shape !== 'base-red' || shape === 'flaky' && testCalls > 1 ? 0 : 1;
    if (shape === 'base-hang' && isBase && request.role === 'test') return { exitCode: 0, unfinished: true, error: 'Base execution did not finish' };
    if ((shape === 'real-hang' || shape === 'slow-rerun') && request.role === 'test' && testCalls > 1) return await runProjectCommand(request);
    if (shape === 'hang' && request.role === 'test' && testCalls > 1) return { exitCode: null, unfinished: true, error: 'Hang bound reached' };
    const report = options.invalidReport ? '{invalid' : JSON.stringify({ complete: true, success: exitCode === 0,
      numTotalTests: options.collection ? 0 : 1, numFailedTests: options.collection || exitCode === 0 ? 0 : 1,
      numPassedTests: options.collection ? 0 : exitCode === 0 ? 1 : 0,
      testResults: [{ name: 'spec/a file.test.ts', status: exitCode === 0 ? 'passed' : 'failed',
        assertionResults: options.collection ? [] : [{ fullName: 'declared failure', status: exitCode === 0 ? 'passed' : 'failed' }] }] });
    return { exitCode, ...(shape === 'regression-error' && request.role === 'test' ? { error: 'Auxiliary decoding unavailable; raw exit retained' } : {}), stdout: options.reporter ? report : 'Opaque output says any arbitrary thing, including a fake filename.test.ts' };
  };
  const fact = await recordAttemptValidation(root, run.runId, 'implement', { runCommand: runner });
  writeStageStatus(root, run.runId, 'review', complete);
  writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Scripted gate accepts', criteria: {},
    audit_findings: { version: 1, findings: [] }, validation_review: { commands: [{ role: 'test', display: [command.command, ...command.args].join(' '), disposition: 'unknown', reason: 'No attribution' }], request_base: [] } }));
  return { root, ...run, fact, calls, rerunValue, verdict: readGateEvaluation(root, 'review', run.runId, undefined, false) };
}

describe('one confirmed-regression veto', () => {
  it.each(['pass', 'unknown'] as const)('blocks a scripted gate %s and admits repair with the exact confirmed reproduction', async disposition => {
    setEngineDefaults({ default_timeout_ms: 30000, validation_timeout_ms: 10000 });
    const root = project();
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/value.txt'), 'good');
    writeFileSync(join(root, 'check.mjs'), "import {readFileSync} from 'node:fs'; process.exit(readFileSync('docs/value.txt','utf8')==='good' && process.env.REQUIRED_VALUE==='good'?0:1);\n");
    declaration(root, { test: { ...command, env: { REQUIRED_VALUE: 'good' } } }); commit(root);
    const calls: Array<{ stage: string; prompt: string }> = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push({ stage: opts.stageId, prompt });
      const success = (value: unknown, writes: string[] = []) => ({ output: JSON.stringify(value), exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' as const });
      if (opts.stageId === 'review') {
        const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
        return success({ pass: true, reason: 'The scripted gate accepts despite validation failure',
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Scripted independent product review' }])),
          audit_findings: { version: 1, findings: [] }, ...(disposition === 'unknown' ? { validation_review: {
            commands: [{ role: 'test', display: [command.command, ...command.args].join(' '), disposition: 'unknown', reason: 'Cause unknown to this gate' }], request_base: [],
          } } : {}) });
      }
      writeFileSync(join(root, 'docs/value.txt'), opts.stageId === 'repair' ? 'good' : 'bad');
      return success({ status: 'delivered', summary: 'Value delivered', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Independently verify the value.\"}]\noutputs: [docs/value.txt]\n---\n# Deliver a value\n\n## Acceptance criteria\n1. Independently verify the value.\n";
    const final = await runWorkflow(config, raw, root, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
    const directory = runDir(root, final.runId), ledger = readEvidence(directory);
    expect(calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(final.status).toBe('complete');
    const first = ledger.find(entry => entry.kind === 'validation') as ValidationFact;
    expect(first.executions.map(execution => execution.commands[0].exitCode)).toEqual([1, 1, 0]);
    const rejected = JSON.parse(readFileSync(runRecordPath(directory, 'gate_reevaluation/iteration_1/round_1/engine_verdict_review.json'), 'utf8'));
    expect(rejected.engine_effective_pass).toBe(false);
    expect(rejected.findings.confirmed).toHaveLength(1);
    const original = rejected.findings.confirmed[0].record;
    expect(original).toMatchObject({ kind: 'command', owner: 'code', exitCode: 1, timeoutMs: 300000, context: { cwd: root, shell: '/bin/sh' } });
    expect(original.command).toContain('check.mjs');
    expect(original.treeHash).toBe(original.treeAfterHash);
    const repair = calls.find(call => call.stage === 'repair')!.prompt;
    const repairFacts = JSON.parse(repair.split('# Gate repair facts\n')[1].split('\n')[0]);
    expect(repairFacts.confirmedFindings.review[0].record.command).toBe(original.command);
    expect(ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence)).toMatchObject({ command: original.command, exitCode: 0 });
  });

  it('runs every initial validation command before the candidate rerun and runs the identical whole command on base', async () => {
    const value = await measure('regression');
    expect(value.calls.map(call => `${call.role}:${call.cwd === value.root ? 'attempt' : 'base'}`)).toEqual(['build:attempt', 'test:attempt', 'lint:attempt', 'test:attempt', 'test:base']);
    expect(value.calls.slice(3).map(call => [call.command, call.args])).toEqual([[command.command, command.args], [command.command, command.args]]);
    // Full hang allowance includes command setup; it is not the initial batch's ten-second share.
    expect(value.calls[3].timeoutMs).toBeGreaterThanOrEqual(299000);
    expect(value.verdict?.pass).toBe(false);
    expect(value.verdict?.findings?.confirmed).toHaveLength(1);
    expect(value.verdict?.validation?.find(result => result.role === 'test')).toMatchObject({ exitCode: 1, measurement: 'unverified', disposition: 'unknown' });
  });

  it('rejects confirmation when the alone failure ran a transient tree and restored the judged tree', async () => {
    const value = await measure('changing-tree');
    expect(value.rerunValue).toBe('transient');
    const candidate = alone(value.fact).find(execution => execution.target === 'attempt')!;
    expect(candidate.treeHash).not.toBe(value.fact.treeHash);
    expect(candidate.treeAfterHash).toBe(value.fact.treeHash);
    expect(value.fact.regressions ?? []).toEqual([]);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] },
      validation: expect.arrayContaining([expect.objectContaining({ role: 'test', exitCode: 1, measurement: 'unverified', sourceBound: false })]) });
  });

  it('uses completed direct exits despite auxiliary error facts and confirms candidate 1 against base 0', async () => {
    const value = await measure('regression-error');
    expect(alone(value.fact).map(execution => execution.commands[0].exitCode)).toEqual([1, 0]);
    expect(alone(value.fact).every(execution => Boolean(execution.commands[0].error))).toBe(true);
    expect(value.verdict).toMatchObject({ pass: false, findings: { confirmed: [expect.objectContaining({ record: expect.objectContaining({ exitCode: 1 }) })] } });
  });

  it('leaves a failure that passes when rerun alone unverified and accepts the gate decision', async () => {
    const value = await measure('flaky');
    expect(alone(value.fact).map(execution => execution.commands[0].exitCode)).toEqual([0]);
    expect(value.calls.filter(call => call.cwd !== value.root)).toHaveLength(0);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] }, validation: expect.arrayContaining([expect.objectContaining({ role: 'test', exitCode: 1, measurement: 'unverified' })]) });
  });

  it('leaves a failure that also fails on base unverified and accepts the gate decision', async () => {
    const value = await measure('base-red');
    expect(alone(value.fact).map(execution => execution.commands[0].exitCode)).toEqual([1, 1]);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] }, validation: expect.arrayContaining([expect.objectContaining({ role: 'test', measurement: 'unverified' })]) });
  });

  it('leaves an unfinished base run unverified even if it carries an apparent zero exit', async () => {
    const value = await measure('base-hang');
    expect(alone(value.fact)).toMatchObject([{ target: 'attempt', commands: [{ exitCode: 1 }] },
      { target: 'base', commands: [{ exitCode: 0, unfinished: true, measurement: 'unverified' }] }]);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] } });
  });

  it('records an alone rerun hang as unfinished and accepts without a base comparison', async () => {
    const value = await measure('hang');
    expect(alone(value.fact)).toMatchObject([{ target: 'attempt', commands: [{ exitCode: null, unfinished: true, measurement: 'unverified' }] }]);
    expect(value.calls.filter(call => call.cwd !== value.root)).toHaveLength(0);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] } });
  });

  it('retires a real hanging alone command at its declared hang bound and keeps the gate authoritative', async () => {
    const started = Date.now();
    const value = await measure('real-hang');
    expect(alone(value.fact)).toMatchObject([{ target: 'attempt', commands: [{ exitCode: null, unfinished: true, measurement: 'unverified' }] }]);
    expect(alone(value.fact)[0].commands[0].output).toContain('hang-started');
    expect(Date.now() - started).toBeLessThan(10000);
    expect(value.calls.filter(call => call.cwd !== value.root)).toHaveLength(0);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] } });
  });

  it('uses the declared hang allowance for a finite rerun instead of the short initial batch cap', async () => {
    const value = await measure('slow-rerun');
    expect(alone(value.fact)).toMatchObject([{ target: 'attempt', commands: [{ exitCode: 0, measurement: 'verified' }] }]);
    expect(alone(value.fact)[0].commands[0].output).toContain('finite-complete');
    expect(value.calls[3].timeoutMs).toBeGreaterThan(1000);
    expect(value.calls.filter(call => call.cwd !== value.root)).toHaveLength(0);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] },
      validation: expect.arrayContaining([expect.objectContaining({ role: 'test', exitCode: 1, measurement: 'unverified' })]) });
  });

  it('reruns the whole command with no declared reporter, even when a template is present', async () => {
    const value = await measure('regression', { template: true });
    expect(value.calls.filter(call => call.role === 'test').map(call => call.args)).toEqual([command.args, command.args, command.args]);
    expect(value.verdict?.pass).toBe(false);
  });

  it.each([false, true])('selects declared structured failure files for assertions or collection failures (collection=%s)', async collection => {
    const value = await measure('regression', { reporter: true, template: true, collection });
    expect(value.calls.filter(call => call.role === 'test').map(call => call.args)).toEqual([command.args, ['rerun.mjs', 'spec/a file.test.ts'], ['rerun.mjs', 'spec/a file.test.ts']]);
    expect(value.verdict?.pass).toBe(false);
    expect(value.verdict?.findings?.confirmed[0].record.command).toContain('spec/a file.test.ts');
  });

  it('does not guess failure files from logs when the declared structured report is invalid', async () => {
    const value = await measure('regression', { reporter: true, template: true, invalidReport: true });
    expect(value.calls).toHaveLength(3);
    expect(value.verdict).toMatchObject({ pass: true, findings: { confirmed: [] }, validation: expect.arrayContaining([expect.objectContaining({ role: 'test', measurement: 'unverified' })]) });
  });

  it('spends no rerun or base execution when all selected commands pass', async () => {
    const value = await measure('green');
    expect(value.calls).toHaveLength(3); expect(alone(value.fact)).toEqual([]);
    expect(value.verdict?.pass).toBe(true);
    expect(value.verdict?.validation?.every(result => result.measurement === 'verified')).toBe(true);
  });
});
