import './test-support/policy-runtime.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { assertMeasuredSetupLaunch, measuredSetupFacts, SetupLaunchRefusal } from '../src/ship-setup-record.js';
import type { ProjectValidationBaseline } from '../src/project-validation.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { fcGlobalDir, setFcGlobalDir, runsRoot, readRunState, runDir } from '../src/store.js';
import { Orchestrator, type SupervisorBackend } from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { createRun } from './test-support/create-run.js';
import { stationaryStageClock } from './test-support/stage-deadline.js';
import { fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, previous: string;
const brief = '# Controlled launch';
const workflow = () => WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 0 },
  stages: [{ id: 'work', role: 'worker', prompt_template: 'work', artifact_contract: { version: 1, produces: [], reads: [] } }] });
const admission = () => createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: '2030-01-01T00:00:00Z' });
function seed(exitCode: number | null = 1) {
  const path = writeReadySetupRecord(project, brief, fcGlobalDir());
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.validationBaseline.results[0].exitCode = exitCode;
  writeFileSync(path, JSON.stringify(record));
  return { path, record, baseline: record.validationBaseline as ProjectValidationBaseline,
    save: () => writeFileSync(path, JSON.stringify(record)) };
}
const acknowledge = (baseline: ProjectValidationBaseline) => {
  const receipt = admission();
  if (receipt.acknowledgement.kind === 'explicit') receipt.acknowledgement.measuredSetupIdentity = measuredSetupFacts(baseline).identity;
  return receipt;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ms-')); project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

describe('measured setup launch rule', () => {
  it.each(['nonzero', 'missing exit', 'null exit', 'unfinished', 'missing result', 'wrong command', 'wrong args', 'wrong env'])(
    'requires acknowledgement for %s without reading labels or reporter totals', scenario => {
      const item = seed(0); const result = item.baseline.results[0];
      if (scenario === 'nonzero') result.exitCode = 1;
      if (scenario === 'missing exit') delete result.exitCode;
      if (scenario === 'null exit') result.exitCode = null;
      if (scenario === 'unfinished') result.unfinished = true;
      if (scenario === 'missing result') item.baseline.results = [];
      if (scenario === 'wrong command') result.command = 'different';
      if (scenario === 'wrong args') result.args = ['different'];
      if (scenario === 'wrong env') result.env = { DIFFERENT: 'value' };
      // Deliberately misleading display evidence never grants launch permission.
      result.state = 'passed'; result.failureIdentity = 'none'; result.failureCount = 0;
      item.save();
      expect(() => assertMeasuredSetupLaunch(project, brief, admission())).toThrow('setup_acknowledgement_required');
      expect(() => assertMeasuredSetupLaunch(project, brief, acknowledge(item.baseline))).not.toThrow();
    });

  it('retains acknowledgement across output, duration and diagnostic remeasurement', () => {
    const item = seed(); const receipt = acknowledge(item.baseline);
    Object.assign(item.baseline.results[0], { output: 'new diagnostic output', durationMs: 321,
      state: 'launch_error', reason: 'different diagnosis', failureIdentifiers: ['different'], failureCount: 7 });
    item.baseline.discovery.reason = 'new discovery explanation'; item.save();
    expect(() => assertMeasuredSetupLaunch(project, brief, receipt)).not.toThrow();
  });

  it.each(['command', 'args', 'env', 'completion'] as const)('requires fresh acknowledgement after changed %s', field => {
    const item = seed(); const receipt = acknowledge(item.baseline);
    if (field === 'completion') item.baseline.results[0].unfinished = true;
    else {
      const patch = field === 'command' ? { command: 'different' } : field === 'args' ? { args: ['different'] } : { env: { DIFFERENT: 'value' } };
      Object.assign(item.baseline.discovery.commands[0], patch); Object.assign(item.baseline.results[0], patch);
    }
    item.save();
    expect(() => assertMeasuredSetupLaunch(project, brief, receipt)).toThrow('setup_acknowledgement_required');
  });

  it('admits completed zero exits despite failed labels, reporter totals and cause text', () => {
    const item = seed(0); Object.assign(item.baseline.results[0], { state: 'failed', failureCount: 99,
      failureIdentity: 'unknown', reason: 'unrelated text', reportError: 'unreadable reporter' }); item.save();
    expect(assertMeasuredSetupLaunch(project, brief).acknowledgementRequired).toBe(false);
  });

  it('admits an empty declared command list with no acknowledgement', () => {
    const item = seed(); item.baseline.discovery.commands = []; item.baseline.results = []; item.save();
    expect(assertMeasuredSetupLaunch(project, brief).acknowledgementRequired).toBe(false);
  });

  it('refuses pre-measurement admission and invalidates changed results and target under the same brief', () => {
    const before = admission(); const item = seed();
    expect(() => assertMeasuredSetupLaunch(project, brief, before)).toThrow('setup_acknowledgement_required');
    const receipt = acknowledge(item.baseline);
    expect(() => assertMeasuredSetupLaunch(project, brief, receipt)).not.toThrow();
    item.baseline.results[0].exitCode = 2; item.save();
    expect(() => assertMeasuredSetupLaunch(project, brief, receipt)).toThrow('setup_acknowledgement_required');
    project = join(root, 'another'); mkdirSync(project); seed();
    expect(() => assertMeasuredSetupLaunch(project, brief, receipt)).toThrow('setup_acknowledgement_required');
  });

  it.each(['skipped', 'absent'] as const)('refuses an old %s record for first launch and retains initialized history', execution => {
    const item = seed(0); if (execution === 'absent') delete item.baseline.execution; else item.baseline.execution = execution; item.save();
    expect(() => assertMeasuredSetupLaunch(project, brief, admission())).toThrow('setup_unmeasured');
    const w = workflow();
    const created = createRun(project, w.name, stringify(w), ['work'], brief);
    const resumed = prepareWorkflowLaunch(w, stringify(w), project, created.runId, brief);
    expect(resumed.kind).toBe('ready');
    expect(readRunState(project, created.runId).briefAdmission?.digest).toBe(inspectBrief(brief).digest);
    expect(readFileSync(item.path, 'utf8')).toBe(JSON.stringify(item.record));
  });

  it('direct library red launch stops before an adapter or run starts', async () => {
    seed(); const run = vi.fn(); const w = workflow();
    await expect(runWorkflow(w, stringify(w), project, { run }, new Map(), undefined, undefined, undefined, brief))
      .rejects.toBeInstanceOf(SetupLaunchRefusal);
    expect(run).not.toHaveBeenCalled(); expect(existsSync(runsRoot())).toBe(false);
  });

  it.each(['green', 'empty', 'acknowledged red'] as const)('direct library %s launch reaches the adapter', async scenario => {
    const item = seed(scenario === 'green' ? 0 : 1);
    if (scenario === 'empty') { item.baseline.discovery.commands = []; item.baseline.results = []; item.save(); }
    const run = vi.fn(async () => { throw new Error('controlled adapter reached'); }); const w = workflow();
    const agents = join(project, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'worker.yaml'), stringify({ name: 'worker', description: 'fixture', model: 'mock', reasoning_effort: 'low', tools: [], prompt: 'work' }));
    await runWorkflow(w, stringify(w), project, { run }, new Map(), undefined, agents, undefined, brief,
      undefined, undefined, scenario === 'acknowledged red' ? acknowledge(item.baseline) : undefined, stationaryStageClock);
    expect(run).toHaveBeenCalled();
  });

  it.each(['green', 'empty', 'acknowledged red'] as const)('background registration %s launches with the same predicate', async scenario => {
    const item = seed(scenario === 'green' ? 0 : 1);
    if (scenario === 'empty') { item.baseline.discovery.commands = []; item.baseline.results = []; item.save(); }
    const registry = new TaskRegistry({ baseDir: fcGlobalDir() });
    const runUnit = vi.fn(async () => {});
    const systemd: SupervisorBackend = { runUnit, isActive: async () => ({ kind: 'absent' }), stopUnit: async () => {}, journalTail: async () => '' };
    const orchestrator = new Orchestrator({ registry, systemd, isProjectBusy: () => null });
    try {
      if (scenario === 'acknowledged red') {
        await expect(orchestrator.register({ projectDir: project, brief_text: brief, brief_admission: admission() })).rejects.toThrow('setup_acknowledgement_required');
        expect(registry.list()).toHaveLength(0); expect(runUnit).not.toHaveBeenCalled();
      }
      await orchestrator.register({ projectDir: project, brief_text: brief,
        brief_admission: scenario === 'acknowledged red' ? acknowledge(item.baseline) : admission() });
      expect(runUnit).toHaveBeenCalledTimes(1);
    } finally { await orchestrator.stop(); }
  });

  it.each([0, 1])('acknowledged red base completes exactly when final validation exits 0 (actual=%s)', async finalExit => {
    const item = seed(); const command = item.baseline.discovery.commands[0];
    command.args = ['-e', `process.exit(${finalExit})`]; Object.assign(item.baseline.results[0], command); item.save();
    const agents = join(project, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'worker.yaml'), stringify({ name: 'worker', description: 'fixture', model: 'mock', reasoning_effort: 'low', tools: [], prompt: 'work' }));
    const w = workflow();
    w.stages.push({ ...w.stages[0], id: 'qa', is_gate: true, depends_on: ['work'],
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'work/verdict_qa.json', kind: 'file' }], reads: [] } });
    w.stages.push({ ...w.stages[0], id: 'repair', depends_on: ['qa'], retry_to: ['qa'] });
    const run = vi.fn(async (_prompt, _agent, opts) => fixtureResult({
      output: opts.stageId === 'qa' ? JSON.stringify({ pass: true, reason: 'controlled pass', criteria: {}, audit_findings: { version: 1, findings: [] } }) : 'done', exitCode: 0, duration_ms: 0 }, opts));
    const state = await runWorkflow(w, stringify(w), project, { run }, new Map(), undefined, agents, undefined, brief,
      undefined, undefined, acknowledge(item.baseline), stationaryStageClock);
    expect(run, JSON.stringify(state)).toHaveBeenCalled(); expect(state.status === 'complete', state.failureReason).toBe(finalExit === 0);
    const validations = readEvidence(runDir(project, state.runId)).filter(entry => entry.kind === 'validation');
    expect(validations.flatMap(entry => entry.kind === 'validation' ? entry.executions.flatMap(execution => execution.commands) : []))
      .toContainEqual(expect.objectContaining({ exitCode: finalExit }));
  });
});
