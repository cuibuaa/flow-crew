import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import './test-support/policy-runtime.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { seedAttemptValidation } from './test-support/attempt-validation.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { projectCommit, VALIDATION_FACT_VERSION } from '../src/evidence-ledger.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { fixtureResult, declaredDispatch } from './test-support/declared-dispatch.js';
import { artifacts, stageArtifacts } from './spec_contracts/declared-fixtures.js';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { appendResearchPathContract, findGateRecoveryStages, inspectDispatchAdmission, parseDispatchedStageConfig, recordGateValidationDelta, tryTerminateOnTerminalState, type GateRecoveryFact, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
import { validationPathImpacts } from './test-support/validation-path-impacts.js';
import {
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ProjectValidationDependencies,
} from '../src/project-validation.js';
import { createRun } from './test-support/create-run.js';
import {
  fcGlobalDir,
  readRunState,
  readStageStatus,
  runDir,
  setFcGlobalDir,
  writeStageStatus,
  writeRunState,
  type StoreState,
} from '../src/store.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import { settleGateRetries } from '../src/scheduler/sched_loop/gate-loop.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';

const roots: string[] = [];
const originalStateRoot = fcGlobalDir();

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-runtime-${label}-`));
  roots.push(root);
  return root;
}

function seedProject(label: string, ...roles: string[]): { projectDir: string; agentsDir: string } {
  const projectDir = join(temporaryRoot(label), 'project');
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  setEngineDefaults({ max_iterations: 1, gate_retry_loops: 1, stage_technical_retries: 0 });
  for (const role of roles) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: bounded runtime fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: bounded runtime fixture',
    ].join('\n'));
  }
  setFcGlobalDir(join(dirname(projectDir), 'state'));
  return { projectDir, agentsDir };
}

function stage(raw: Record<string, unknown>): StageConfig {
  return parseDispatchedStageConfig({ artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
    role: 'worker',
    prompt_template: 'runtime fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function summaryResult(opts: RunOpts): RunResult | undefined {
  return opts.stageId === '_summary'
    ? { output: 'runtime fixture summary', exitCode: 0, duration_ms: 1 }
    : undefined;
}

function researchBrief(maxRounds = 3): string {
  return [
    '---',
    'research:',
    '  baseline: 0',
    '  policy: greedy_stack',
    '  result_file: artifacts/round.json',
    '  report_dir: artifacts',
    '  stop:',
    `    max_rounds: ${maxRounds}`,
    '---',
    '# Runtime fixture',
  ].join('\n');
}

function writeValidationSnapshot(
  runDirPath: string,
  baseline: ProjectValidationBaseline,
  seed = true,
): { bytes: string; sha256: string } {
  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: 'ship-setup-ready-record',
    baseCommit: projectCommit(baseline.projectDir),
    baseline,
  };
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(runRecordPath(runDirPath, 'validation_baseline.json'), bytes);
  if (seed) seedAttemptValidation(baseline.projectDir, basename(runDirPath), baseline.results);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function validationRunner(exitCode: number): NonNullable<ProjectValidationDependencies['runCommand']> {
  return (request) => ({
    exitCode,
    stdout: exitCode === 0 ? 'ok\n' : '',
    stderr: exitCode === 0 ? '' : 'FAIL spec/delivered.test.ts\n',
    durationMs: 1,
  });
}

async function configuredBaseline(projectDir: string): Promise<ProjectValidationBaseline> {
  return runProjectValidationBaseline(projectDir, {
    commands: (['build', 'test', 'lint'] as const).map((role) => ({
      role,
      command: process.execPath,
      args: [`fixture-${role}.mjs`],
      display: `node fixture-${role}.mjs`,
      evidencePath: `fixture-${role}.mjs`,
    })),
    runCommand: validationRunner(0),
  });
}

function terminalState(
  projectDir: string,
  runId: string,
  terminalPath: string,
  completedAt: string,
): StoreState {
  return {
    ...readRunState(projectDir, runId),
    runId,
    workflowName: 'terminal-validation-fixture',
    projectDir,
    status: 'running',
    terminalStates: { complete: { paths: [terminalPath] } },
    terminalArtifactBaselines: { [terminalPath]: { state: 'absent' } },
    stages: {
      finalizer: {
        status: 'complete',
        retries: 0,
        startedAt: new Date(Date.parse(completedAt) - 100).toISOString(),
        completedAt,
        writes: [terminalPath],
        attempts: [{
          index: 1,
          status: 'complete',
          startedAt: new Date(Date.parse(completedAt) - 100).toISOString(),
          completedAt,
          writes: [terminalPath],
          writeAttribution: 'structured',
        }],
      },
    },
    startedAt: new Date(Date.parse(completedAt) - 1_000).toISOString(),
  };
}

afterEach(() => {
  setFcGlobalDir(originalStateRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine generalization runtime bindings', () => {
  it.each(['regression', 'authored-rejection', 'peer-regression', 'peer-green'])('settles static completion after %s against current validation', async (failure) => {
    const { projectDir, agentsDir } = seedProject('static-gate-acceptance', 'qa', 'coder');
    setEngineDefaults({ max_iterations: 1, gate_retry_loops: 0, stage_technical_retries: 0 });
    const gate = stage({ id: 'qa', role: 'qa', is_gate: true });
    const workflow: WorkflowConfig = { name: 'static-gate-acceptance', defaults: { max_iterations: 1, max_retries: 0 }, stages: failure.startsWith('peer-') ? [gate, stage({ id: 'peer', role: 'coder', scope: ['validation.cjs'] }), stage({ id: 'peer_review', role: 'qa', is_gate: true, depends_on: ['peer'] })] : [gate] };
    workflow.stages.push(...workflow.stages.filter(item => item.is_gate).map(item => stage({
      id: `repair_${item.id}`, role: 'coder', scope: [], depends_on: [item.id], retry_to: [item.id],
    })));
    workflow.stages.unshift(stage({ id: 'author', role: 'coder' }));
    for (const item of workflow.stages) if (item.id === 'qa' || item.id === 'peer') { item.depends_on = ['author']; item.dependency_reasons = { author: 'Inspect the settled author attempt' }; }
    expect(inspectDispatchAdmission({ dispatched: workflow.stages, baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
    const created = createRun(projectDir, workflow.name, `name: ${workflow.name}`, workflow.stages.map(item => item.id));
    const command = join(projectDir, 'validation.cjs');
    writeFileSync(command, failure === 'regression'
      ? 'console.log("FAIL spec/regression.test.ts");process.exitCode=1'
      : 'console.log("ok")');
    writeFileSync(command, 'console.log("ok")');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']]) isolatedProjectCommand('git', args, projectDir, dirname(projectDir));
    if (failure === 'regression') writeFileSync(command, 'process.exitCode=1');
    const baseline = await runProjectValidationBaseline(projectDir, {
      commands: (['build', 'test', 'lint'] as const).map(role => ({ role, command: process.execPath, args: [command], display: `private ${role}` })),
      runCommand: validationRunner(0),
    });
    writeValidationSnapshot(created.runDirPath, baseline, false);
    let reviews = 0;
    let reviewStarted!: () => void, peerFinished!: () => void;
    const reviewing = new Promise<void>(resolve => { reviewStarted = resolve; });
    const peerDone = new Promise<void>(resolve => { peerFinished = resolve; });
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      const summary = summaryResult(opts); if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'author' || opts.stageId.startsWith('repair_')) return fixtureResult({ output: 'Author attempt complete', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      if (opts.stageId === 'peer_review') return { output: JSON.stringify({ pass: true, reason: 'Peer reviewed', criteria: {}, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      if (opts.stageId === 'peer') {
        await reviewing;
        writeFileSync(command, failure === 'peer-regression' ? 'console.log("FAIL spec/regression.test.ts");process.exitCode=1' : 'console.log("ok")');
        peerFinished();
        return fixtureResult({ output: 'peer', exitCode: 0, duration_ms: 1, writes: ['validation.cjs'], writeAttribution: 'structured' }, opts);
      }
      reviews++; reviewStarted();
      writeFileSync(stageWorkPath(opts.runDir, 'fixture_verdict_qa.json'), JSON.stringify({ pass: failure !== 'authored-rejection', reason: 'Authored review' }));
      return fixtureResult({ output: 'review', exitCode: 0, duration_ms: 1, writes: ['run:verdict_qa.json'], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(workflow, `name: ${workflow.name}`, projectDir, adapter, new Map(), undefined, agentsDir,
      created.runId, '# Require accepted gates.', true);
    const confirmed = failure === 'regression' || failure === 'peer-regression';
    expect(final.status).toBe(failure === 'authored-rejection' || confirmed ? 'incomplete' : 'complete');
    if (confirmed) {
      const rejected = failure === 'peer-regression' ? final.stages.peer_review : final.stages.qa;
      expect(rejected.gate).toMatchObject({ pass: false, refusal: { kind: 'audit_findings' } });
      expect(rejected.gate?.findings?.confirmed).toHaveLength(3);
      expect(rejected.gate?.findings?.confirmed[0].record).toMatchObject({ owner: 'code', exitCode: 1 });
    }
    const receipt = JSON.parse(readFileSync(runRecordPath(created.runDirPath, 'validation_delta_qa.json'), 'utf8'));
    expect(receipt.pass).toBe(failure !== 'regression');
    if (failure === 'peer-regression') expect(final.stages.peer_review.gate).toMatchObject({ pass: false, kind: 'audit_findings', validation: expect.arrayContaining([expect.objectContaining({ measurement: 'unverified' })]) });
    expect(final.stages.qa.status).toBe('complete');
    expect(reviews).toBe(1);
    expect(final.stages.qa.attempts).toHaveLength(1);
  });
  it.each(['regression', 'regression-with-report', 'post-write-regression', 'persistent-unknown', 'transient-unknown', 'semantic'])
  ('uses raw exits regardless of failure identity and never reruns from a gate: %s', async failure => {
    const { projectDir } = seedProject('validation-routing');
    const created = createRun(projectDir, 'routing', 'name: routing', ['qa']);
    const baseline = await configuredBaseline(projectDir);
    writeValidationSnapshot(created.runDirPath, baseline);
    const unknown = failure.endsWith('unknown');
    const semantic = failure === 'semantic';
    const current = baseline.results.map(result => result.state === 'not_configured' || semantic ? result : {
      ...result, state: 'failed' as const, exitCode: 1,
      failureIdentity: unknown ? 'unknown' as const : 'known' as const,
      failureIdentifiers: unknown ? [] : ['declared-test-identity'],
    });
    seedAttemptValidation(projectDir, created.runId, current, { delta: current.filter(result => result.state !== 'not_configured').map(result => ({
      role: result.role, display: result.display, state: semantic ? 'pass' as const : unknown ? 'unresolved' as const : 'regression' as const,
      reason: unknown ? 'Identity reading unavailable' : 'Declared attempt result', newFailureIdentifiers: unknown || semantic ? [] : ['declared-test-identity'],
    })) });
    const at = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', { status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt: at, completedAt: at, exitCode: 0 }] });
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), JSON.stringify({ pass: !semantic, reason: 'Independent behavioral review',
      ...{} }));
    let commands = 0;
    const dependencies = { runCommand: () => { commands++; throw Error('A gate cannot execute configured validation'); } };
    await recordGateValidationDelta(projectDir, created.runId, 'qa', dependencies);
    if (failure === 'post-write-regression') writeFileSync(join(projectDir, 'peer.ts'), 'changed after measurement');
    const verdict = readGateEvaluation(projectDir, 'qa', created.runId);
    expect(verdict?.pass).toBe(failure === 'post-write-regression');
    const kind = semantic || failure === 'post-write-regression' ? undefined : 'audit_findings';
    expect(verdict?.refusal?.kind).toBe(kind);
    for (let read = 0; read < 3; read++) expect(readGateEvaluation(projectDir, 'qa', created.runId)).toEqual(verdict);
    expect(commands).toBe(0);
    expect(readStageStatus(projectDir, created.runId, 'qa').attempts).toHaveLength(1);
    if (!semantic) expect(verdict?.validation?.every(result => result.measurement === 'unverified')).toBe(true);
  });
  it('reads settled validation without another command execution or authored review', async () => {
    const { projectDir, agentsDir } = seedProject('gate-settlement-parity');
    const created = createRun(projectDir, 'gate-settlement-parity', 'name: gate-settlement-parity', ['qa']);
    const at = new Date().toISOString();
    const status = { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt: at, completedAt: at, status: 'complete', exitCode: 0, terminationCause: 'exit' as const }] };
    writeStageStatus(projectDir, created.runId, 'qa', status);
    const state = readRunState(projectDir, created.runId);
    state.status = 'running'; state.stages.qa = status; state.maxRetries = 0;
    writeRunState(projectDir, created.runId, state);
    const command = join(projectDir, 'validation.cjs');
    writeFileSync(command, 'console.log("ok")');
    const baseline = await runProjectValidationBaseline(projectDir, {
      commands: (['build', 'test', 'lint'] as const).map(role => ({ role, command: process.execPath, args: [command], display: `private ${role}` })),
      runCommand: validationRunner(0),
    });
    writeValidationSnapshot(created.runDirPath, baseline);
    const verdict = '{"pass":true,"reason":"Authored review remains valid"}';
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), verdict);
    const first = await recordGateValidationDelta(projectDir, created.runId, 'qa', { runCommand: () => ({ exitCode: null, error: 'validation runner unavailable' }) });
    const gate = stage({ id: 'qa', is_gate: true });
    const workflow: WorkflowConfig = { name: 'gate-settlement-parity', defaults: { max_iterations: 1, max_retries: 0 }, stages: [gate] };
    const adapter: Adapter = { run: async () => { throw new Error('Mechanical settlement must preserve the authored review'); } };
    await settleGateRetries(state, [gate], 1, new Set(), projectDir, created.runId, created.runDirPath,
      workflow, adapter, new Map(), agentsDir, new Map());
    const settled = JSON.parse(readFileSync(runRecordPath(created.runDirPath, 'validation_delta_qa.json'), 'utf8'));
    const { current: _current, ...reference } = first!;
    expect(settled).toEqual(reference);
    expect(settled.pass).toBe(true); expect(settled.ledgerSequence).toBe(first?.ledgerSequence);
    expect(readFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), 'utf8')).toBe(verdict);
    expect(readFileSync(runRecordPath(created.runDirPath, first!.immutablePath!), 'utf8')).toContain('ledgerSequence');
    expect(readRunState(projectDir, created.runId).stages.qa.attempts).toEqual(status.attempts);
  });
  it('does not let green validation approve a failed gate execution', async () => {
    const { projectDir } = seedProject('failed-gate-receipt');
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    const at = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', { status: 'failed', retries: 0, attempts: [{
      index: 1, startedAt: at, completedAt: at, status: 'failed', exitCode: 1,
    }] });
    writeValidationSnapshot(created.runDirPath, await configuredBaseline(projectDir));
    await recordGateValidationDelta(projectDir, created.runId, 'qa', { runCommand: validationRunner(0) });
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), '{"pass":true,"reason":"Authored pass"}');
    expect(readGateEvaluation(projectDir, 'qa', created.runId)).toBeNull();
  });
  it('refuses a synthetic terminal receipt for a normal gate with the same legal stage name', async () => {
    const { projectDir } = seedProject('receipt-namespace');
    const gate = parseDispatchedStageConfig({ id: 'terminal_author', role: 'qa', is_gate: true, scope: [] });
    const created = createRun(projectDir, 'fixture', 'name: fixture', [gate.id]);
    writeValidationSnapshot(created.runDirPath, await configuredBaseline(projectDir));
    const synthetic = await recordGateValidationDelta(projectDir, created.runId, gate.id, { runCommand: validationRunner(0) });
    expect(synthetic).toBeUndefined();
    const receiptTime = Date.now();
    writeStageStatus(projectDir, created.runId, gate.id, { status: 'complete', retries: 0, attempts: [{
      index: 1, status: 'complete', startedAt: new Date(receiptTime + 1000).toISOString(),
      completedAt: new Date(receiptTime + 2000).toISOString(), exitCode: 0,
    }] });
    const verdict = JSON.stringify({ pass: true, reason: 'Authored work passes' });
    writeFileSync(runRecordPath(created.runDirPath, `verdict_${gate.id}.json`), verdict);
    expect(readGateEvaluation(projectDir, gate.id, created.runId)).toMatchObject({ pass: true });
    expect(readGateEvaluation(projectDir, gate.id, created.runId)).toMatchObject({ pass: true });
    expect(readFileSync(runRecordPath(created.runDirPath, `verdict_${gate.id}.json`), 'utf8')).toBe(verdict);
    expect(readdirSync(runRecordPath(created.runDirPath, '.')).some(name => name.startsWith('validation_delta_terminal_author_attempt_0'))).toBe(false);
  });

  it.each([
    ['index', '1'], ['startedAt', 123], ['completedAt', 456],
  ] as const)('refuses malformed %s even when receipt and settled ledger fields agree', async (field, value) => {
    const { projectDir } = seedProject('malformed-receipt');
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    writeValidationSnapshot(created.runDirPath, await configuredBaseline(projectDir));
    const at = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', { status: 'complete', retries: 0, attempts: [{
      index: 1, status: 'complete', startedAt: at, completedAt: at, [field]: value,
    }] });
    const receipt = await recordGateValidationDelta(projectDir, created.runId, 'qa', { runCommand: validationRunner(0) });
    expect(receipt?.pass).toBe(true);
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), JSON.stringify({ pass: true, reason: 'Authored work passes' }));
    expect(readGateEvaluation(projectDir, 'qa', created.runId)).toMatchObject({ pass: true });
  });

  it.each([undefined, 99, VALIDATION_FACT_VERSION])('uses supported receipt semantics before terminal completion without rerunning validation (version=%s)', async (version) => {
    const { projectDir } = seedProject('terminal-receipt-version');
    const terminalPath = 'docs/final.md';
    mkdirSync(dirname(join(projectDir, terminalPath)), { recursive: true });
    writeFileSync(join(projectDir, terminalPath), '# delivered bytes\n');
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['finalizer'], `---\nterminal_states: {complete: ${terminalPath}}\n---\n`);
    const state = terminalState(projectDir, created.runId, terminalPath, new Date(Date.now() - 200).toISOString());
    writeRunState(projectDir, created.runId, state);
    writeFileSync(runRecordPath(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, errors: [], terminalOwners: { [terminalPath]: 'finalizer' },
    }));
    const baseline = await configuredBaseline(projectDir);
    writeValidationSnapshot(created.runDirPath, baseline, false);
    seedAttemptValidation(projectDir, created.runId, baseline.results, { stageId: 'finalizer' });
    // Declared legacy/future receipt fixtures; keep all facts and their binding
    // identical so only supported semantics can authorize the terminal result.
    const ledgerPath = runRecordPath(created.runDirPath, 'evidence-ledger.jsonl');
    const fact = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (version === undefined) delete fact.validationVersion;
    else fact.validationVersion = version;
    const receiptBytes = `${JSON.stringify(fact)}\n`;
    writeFileSync(ledgerPath, receiptBytes);
    const accepted = true;
    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1,
      stages: [],
    });
    expect(result.decision).toBe(accepted ? 'matched' : 'deferred');
    expect(state.status).toBe(accepted ? 'complete' : 'running');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(receiptBytes);
    expect(existsSync(runRecordPath(created.runDirPath, 'validation_delta_terminal_finalizer.json'))).toBe(false);
  });

  it('keeps unfinished validation out of completed gate references without gate-owned retries', async () => {
    const { projectDir } = seedProject('validation-only');
    const created = createRun(projectDir, 'validation-only', 'name: validation-only', ['qa']);
    const at = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', { status: 'complete', retries: 0,
      attempts: [{ index: 1, startedAt: at, completedAt: at, status: 'complete', exitCode: 0 }] });
    writeValidationSnapshot(created.runDirPath, await configuredBaseline(projectDir), false);
    const measured = await runProjectValidationBaseline(projectDir, { commands: (await configuredBaseline(projectDir)).discovery.commands,
      runCommand: () => ({ exitCode: null, error: 'validation runner unavailable' }) });
    seedAttemptValidation(projectDir, created.runId, measured.results);
    const verdict = JSON.stringify({ pass: true, reason: 'Authored review remains valid' });
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), verdict);
    const first = await recordGateValidationDelta(projectDir, created.runId, 'qa', { runCommand: () => ({ exitCode: null, error: 'validation runner unavailable' }) });
    expect(first?.pass).toBe(false);
    expect(first?.delta.every((entry) => entry.state === 'unverified')).toBe(true);
    expect(readFileSync(runRecordPath(created.runDirPath, 'verdict_qa.json'), 'utf8')).toBe(verdict);
    expect(readFileSync(runRecordPath(created.runDirPath, first!.immutablePath!), 'utf8')).not.toContain('ledgerSequence');
    expect(readGateEvaluation(projectDir, 'qa', created.runId)?.pass).toBe(true);
  });
  it('does not let a gate retry a persistent unfinished engine execution', async () => {
    const { projectDir } = seedProject('validation-unresolved');
    const created = createRun(projectDir, 'validation-unresolved', 'name: validation-unresolved', ['qa']);
    const at = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', { status: 'complete', retries: 0,
      attempts: [{ index: 1, startedAt: at, completedAt: at, status: 'complete', exitCode: 0 }] });
    writeValidationSnapshot(created.runDirPath, await configuredBaseline(projectDir), false);
    const measured = await runProjectValidationBaseline(projectDir, { commands: (await configuredBaseline(projectDir)).discovery.commands,
      runCommand: () => ({ exitCode: null, error: 'validation runner unavailable' }) });
    seedAttemptValidation(projectDir, created.runId, measured.results);
    let commands = 0;
    const deps = { runCommand: () => { commands++; return { exitCode: null, error: 'validation runner unavailable' }; } };
    await recordGateValidationDelta(projectDir, created.runId, 'qa', deps);
    await recordGateValidationDelta(projectDir, created.runId, 'qa', deps);
    await recordGateValidationDelta(projectDir, created.runId, 'qa', deps);
    expect(commands).toBe(0);
  });
  it('9 — routes authored/effective rejection facts to the responsible producer', async () => {
    const measure = stage({ id: 'measure', scope: ['artifacts/round.json'] });
    const gate = stage({ criterion_refs: [], artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_qa.json" }], [], []),
      id: 'qa', role: 'qa', is_gate: true, depends_on: ['measure'],
      dependency_reasons: { measure: 'audit measured work' },
    });
    const repair = stage({
      id: 'repair', depends_on: ['qa'], dependency_reasons: { qa: 'repair a substantive rejection' },
      retry_to: ['qa'],
    });
    const contractFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: true, reason: 'work itself passes' },
      effectiveVerdict: { pass: false, reason: 'Gate contract violation: missing required numeric gate value' },
      rejectionKind: 'engine_contract_or_evidence_rejection',
    };
    const substantiveFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: false, reason: 'product behavior is wrong' },
      effectiveVerdict: { pass: false, reason: 'product behavior is wrong' },
      rejectionKind: 'repairable_failure',
    };
    const omittedFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: true, reason: 'audit completed' },
      effectiveVerdict: { pass: false, reason: 'Research round outcome is absent: no usable evidence' },
      rejectionKind: 'engine_contract_or_evidence_rejection',
    };
    const legacyFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: null,
      effectiveVerdict: { pass: false, reason: 'legacy rejection without typed authorship' },
      rejectionKind: 'unclassified_rejection',
    };
    const research = { baseline: 0, policy: 'greedy_stack' as const, resultFile: 'artifacts/round.json' };
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: contractFact },
    ).map((entry) => entry.id)).toEqual([]);
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: substantiveFact },
    ).map((entry) => entry.id)).toEqual([]);
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: omittedFact },
    ).map((entry) => entry.id)).toEqual([]); // Retired result-slot omissions cannot rerun a producer.
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: legacyFact },
    ).map((entry) => entry.id)).toEqual([]);

    const { projectDir, agentsDir } = seedProject('recovery', 'planner', 'qa', 'repair');
    const workflow: WorkflowConfig = {description: '', 
      name: 'typed-gate-recovery',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'plan', role: 'planner', dynamic_dispatch: true })],
    };
    const created = createRun(projectDir, workflow.name, 'name: typed-gate-recovery', ['plan']);
    writeFileSync(runRecordPath(created.runDirPath, 'gate_contract.json'), JSON.stringify({
      metric: 'quality', threshold: 7, higherIsBetter: true,
    }));
    let gateCalls = 0;
    let repairCalls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'plan') {
        writeFileSync(stageWorkPath(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          'stages:',
          '  - id: qa',
          '    role: qa',
          '    scope: []',
          '    depends_on: [plan]',
          '    dependency_reasons: {plan: "audit the planned work"}',
          '    is_gate: true',
          '    prompt_template: Write the typed verdict.',
          '  - id: repair',
          '    role: repair',
          '    scope: []',
          '    depends_on: [qa]',
          '    dependency_reasons: {qa: "repair a substantive product rejection"}',
          '    retry_to: [qa]',
          '    prompt_template: Repair only a product defect.',
        ].join('\n')));
        return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === 'qa') {
        gateCalls++;
        writeFileSync(stageWorkPath(opts.runDir, 'fixture_verdict_qa.json'), JSON.stringify(gateCalls === 1
          ? { pass: true, reason: 'work itself passes', metric: 'quality' }
          : { pass: true, reason: 'contract evidence supplied', metric: 'quality', value: 8 }));
        if (gateCalls === 2) expect(prompt).toContain('engine_rejection_reason');
        return fixtureResult({ output: `gate ${gateCalls}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === 'repair') repairCalls++;
      return fixtureResult({ output: 'unexpected repair', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(
      workflow,
      'name: typed-gate-recovery',
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      created.runId,
      '# Supply typed gate evidence.',
      true,
    );
    expect({ status: final.status, gateCalls, repairCalls }).toEqual({
      // Invalid gate evidence does not authorize product repair or another
      // unchanged gate review. The contract refusal remains a terminal failure.
      status: 'failed', gateCalls: 1, repairCalls: 0,
    });
  });

  it('16 — identifies configured-command inputs without scope negotiation', async () => {
    const { projectDir, agentsDir } = seedProject('scope-message', 'worker');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'export {};\n');
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(projectDir, 'vitest.config.ts'), [
      'export default { test: {',
      "  include: ['spec/**/*.test.ts'],",
      '} };',
    ].join('\n'));
    const commands = [{
      role: 'test' as const,
      command: 'npm',
      args: ['run', 'test'],
      display: 'npm run test',
      evidencePath: 'package.json',
    }];
    expect(validationPathImpacts(projectDir, commands, ['spec/new-audit.test.ts'])).toEqual([
      expect.objectContaining({ path: 'spec/new-audit.test.ts', role: 'test', command: 'npm run test' }),
    ]);
    expect(validationPathImpacts(projectDir, commands, ['docs/note.md'])).toEqual([]);
    const misleadingConfig = [
      'export default { test: {',
      "  coverage: { include: ['docs/**'] },",
      "  // include: ['docs/**'],",
      '} };',
    ].join('\n');
    expect(validationPathImpacts(projectDir, commands, ['docs/note.md'], {
      exists: (path) => path.endsWith('vitest.config.ts'),
      readText: () => misleadingConfig,
    })).toEqual([]);


  });
});
