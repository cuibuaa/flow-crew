import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { settleGateRetries } from '../src/scheduler/sched_loop/gate-loop.js';
import { prepareWorkflowIteration } from '../src/scheduler/sched_loop/iteration-setup.js';
import * as iteration from '../src/scheduler/sched_loop/iteration.js';
import { advanceSettledResearch } from '../src/scheduler/sched_loop/research-progress.js';
import * as services from '../src/scheduler/sched_loop/services.js';
import { beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import type { SupervisorBackend } from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

const repository = join(import.meta.dirname, '..');
let root: string, project: string, previousStore: string;
const units: SupervisorBackend = {
  isActive: async () => ({ kind: 'absent' }), runUnit: async () => {},
  stopUnit: async () => {}, journalTail: async () => '',
};

beforeEach(() => {
  root = mkdtempSync(join(repository, 'docs/.cancel-repend-paths-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  vi.restoreAllMocks();
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workflow = WorkflowConfigSchema.parse({ name: 'cancel-repend-paths', defaults: { max_iterations: 3, max_retries: 1 }, stages: [
    { id: 'repair', role: 'coder', scope: [], depends_on: [], retry_to: ['review'], prompt_template: 'Repair fixture.',
      artifact_contract: { version: 1, produces: [], reads: [] } },
    { id: 'review', role: 'coder', scope: [], depends_on: ['repair'], is_gate: true, prompt_template: 'Review fixture.',
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }], reads: [] } },
  ] });
  const yaml = stringify(workflow);
  const run = createRun(project, workflow.name, yaml, workflow.stages.map(stage => stage.id));
  updateRunState(project, run.runId, state => {
    state.status = 'running'; state.currentIteration = 1; state.maxIterations = 3; state.maxRetries = 1;
  });
  // A real failed first attempt and successful retry leave retries=1 in each
  // execution ledger before any scheduler path resets its projection to zero.
  for (const id of ['repair', 'review']) {
    beginStageAttempt(project, run.runId, id, 0);
    completeStageAttempt(project, run.runId, id, 0, { exitCode: 124, duration_ms: 1, error: 'Fixture timeout' });
    beginStageAttempt(project, run.runId, id, 1);
    completeStageAttempt(project, run.runId, id, 1, { exitCode: 0, duration_ms: 1 });
  }
  writeFileSync(join(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: false, reason: 'Fixture requires a repair.' }));
  const roles = join(root, 'roles'); mkdirSync(roles);
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\nprompt: Complete fixture.\ntools: []\n');
  return { ...run, workflow, yaml, roles };
}

async function cancelAndContinue(run: ReturnType<typeof fixture>, stageId: string, matchingLedger = false) {
  const projection = readRunState(project, run.runId).stages[stageId];
  const ledgerPath = join(run.runDirPath, 'stages', stageId, 'status.json');
  const ledger = readStageStatus(project, run.runId, stageId);
  const before = readFileSync(ledgerPath, 'utf8');
  expect(projection).toMatchObject({ status: 'pending', retries: 0, attempts: ledger.attempts });
  expect(ledger).toMatchObject(matchingLedger ? { status: 'pending', retries: 0 } : { status: 'complete', retries: 1 });
  const registry = new TaskRegistry({ baseDir: root });
  const task = registry.create({ projectDir: project, run_id: run.runId, status: TASK_STATUS.RUNNING });
  expect(await new RunCancellationCoordinator({ registry, units, timeoutMs: 0, signalGraceMs: 0 }).cancelTask(task.id))
    .toMatchObject({ ok: true, status: 'cancelled' });
  expect(readRunState(project, run.runId)).toMatchObject({ status: 'stopped', failureReason: 'Cancelled by user',
    stages: { [stageId]: projection } });
  expect(() => assertContinuationCompatible(project, run.runId)).not.toThrow();
  expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
}

it('continues after the actual next-iteration reset with settled retry ledgers', async () => {
  const run = fixture();
  const prepared = await prepareWorkflowIteration(2, 1, false, project, run.runId, run.runDirPath,
    new ScriptedAdapter({}), run.workflow.stages, run.yaml);
  expect(prepared.kind).toBe('ready');
  expect(readRunState(project, run.runId).stages.review).toMatchObject({ status: 'pending', retries: 0 });
  await cancelAndContinue(run, 'repair');
});

it.each(['repair', 'review'] as const)('continues cancellation at the actual gate-loop %s repend boundary', async stageId => {
  const run = fixture();
  const interrupted = new Error('Fixture scheduler stopped at cancellation boundary');
  const dispatch = services.runScopeSafeStageGroup;
  const calls: string[][] = [];
  vi.spyOn(services, 'runScopeSafeStageGroup').mockImplementation(async (...args) => {
    calls.push(args[0].map(stage => stage.id));
    if (args[0].some(stage => stage.id === stageId)) {
      await cancelAndContinue(run, stageId);
      // A cancelled scheduler cannot continue past this dispatch boundary.
      throw interrupted;
    }
    return dispatch(...args);
  });
  const adapter = new ScriptedAdapter({ repair: { output: 'Repair completed.' } });
  await expect(settleGateRetries(readRunState(project, run.runId), run.workflow.stages, 1, new Set(), new Map(),
    project, run.runId, run.runDirPath, run.workflow, adapter, new Map(), run.roles, new Map())).rejects.toBe(interrupted);
  expect(calls).toEqual(stageId === 'repair' ? [['repair']] : [['repair'], ['review']]);
  expect(adapter.calls.map(call => call.stageId)).toEqual(stageId === 'repair' ? [] : ['repair']);
});

it('continues after terminal ambiguity repends its admitted owner and ledger', async () => {
  const run = fixture();
  updateRunState(project, run.runId, state => {
    state.startedAt = '2000-01-01T00:00:00.000Z';
    state.terminalStates = { complete: { paths: ['complete.md'] }, escalated: { paths: ['escalated.md'] } };
  });
  writeFileSync(join(run.runDirPath, 'dispatch_admission.json'), JSON.stringify({ pass: true,
    terminalOwners: { 'complete.md': 'repair', 'escalated.md': 'repair' } }));
  writeFileSync(join(project, 'complete.md'), 'Fixture successful outcome.');
  writeFileSync(join(project, 'escalated.md'), 'Fixture competing outcome.');
  const result = await services.tryTerminateOnTerminalState(readRunState(project, run.runId), {
    projectDir: project, runId: run.runId, runDirPath: run.runDirPath, iteration: 1, adapter: new ScriptedAdapter({}),
  });
  expect(result).toMatchObject({ decision: 'deferred', reasons: [expect.stringContaining('multiple fresh terminal outcomes')] });
  await cancelAndContinue(run, 'repair', true);
});

it('continues after research progress repends its terminal finalizer and ledger', async () => {
  const run = fixture();
  updateRunState(project, run.runId, state => {
    state.research = { baseline: 0, policy: 'greedy_stack', resultFile: 'round_result.json', stop: { maxRounds: 3 } };
  });
  mkdirSync(join(run.runDirPath, 'signals'));
  writeFileSync(join(run.runDirPath, 'signals/research_terminal_ready.json'), JSON.stringify({ terminalOwner: 'repair' }));
  const interrupted = new Error('Fixture scheduler stopped before terminal finalizer dispatch');
  const dispatch = vi.spyOn(iteration, 'executeIteration').mockImplementation(async () => {
    await cancelAndContinue(run, 'repair', true);
    throw interrupted;
  });
  // This research round has no outcome gate and no new mutable result to ingest;
  // its durable ready signal asks the admitted finalizer to run again.
  const stages = run.workflow.stages.filter(stage => stage.id === 'repair');
  await expect(advanceSettledResearch(readRunState(project, run.runId), stages, stages, 1, [], 0, 1, 3,
    new Set(), new Map(), project, run.runId, run.runDirPath, { ...run.workflow, stages }, new ScriptedAdapter({}),
    new Map(), run.roles, new Map())).rejects.toBe(interrupted);
  expect(dispatch).toHaveBeenCalledOnce();
});
