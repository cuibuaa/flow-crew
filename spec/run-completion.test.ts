import './test-support/policy-runtime.js';
import { createRun } from './test-support/create-run.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflowIterations } from '../src/scheduler/sched_loop/workflow-loop.js';
import { concludeWorkflowIteration } from '../src/scheduler/sched_loop/iteration-outcome.js';
import { createResearchBudgetFinalizer } from '../src/scheduler/sched_loop/research-terminal.js';
import { beginResearchInputGeneration, captureResearchGateCandidate, readResearchGateCandidate } from '../src/research-candidate.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import { log } from '../src/scheduler/sched_admission/shared.js';
import { concludeRun, settleTerminalResearchCandidates } from '../src/scheduler/sched_policy/run-completion.js';
import * as store from '../src/store.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(resolve(import.meta.dirname, '..'), '.tmp_run-completion-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = store.fcGlobalDir();
  store.setFcGlobalDir(join(root, 'store'));
  const run = createRun(project, 'completion', 'name: completion\nstages: []\n', []);
  runId = run.runId;
  directory = run.runDirPath;
  const state = store.readRunState(project, runId);
  state.status = 'running';
  state.startedAt = new Date(0).toISOString();
  state.research = { baseline: 0, policy: 'greedy_stack', resultFile: 'round.json' };
  beginResearchInputGeneration(project, state);
  store.writeRunState(project, runId, state);
  writeFileSync(join(project, 'round.json'), JSON.stringify({ label: 'pending-measurement', result: 0.2 }));
  captureResearchGateCandidate(project, directory, 'review');
});
afterEach(() => {
  store.setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

it.each(['complete', 'failed', 'incomplete', 'ceiling_hit', 'escalated', 'cancelled'] as const)(
  'settles research evidence before publishing %s state, campaign and completion event', async status => {
    const state = store.readRunState(project, runId);
    state.status = status;
    state.completedAt = new Date().toISOString();
    const write = store.writeRunState;
    const observed: string[] = [];
    vi.spyOn(store, 'writeRunState').mockImplementation((...args) => {
      expect(readResearchGateCandidate(directory, 'review')?.settlement?.disposition).toBe('rejected');
      observed.push('state');
      return write(...args);
    });
    await concludeRun(state, { status, reasonCode: 'workflow_complete', eventFields: () => ({ detail: status }), writeCampaignEntry: () => {
      expect(readResearchGateCandidate(directory, 'review')?.settlement?.disposition).toBe('rejected');
      expect(readRunEvents(project, runId).filter(event => ['research_gate_candidate_settled', 'run_completed'].includes(event.type)).map(event => event.type)).toEqual(['research_gate_candidate_settled']);
      observed.push('campaign');
    } });
    expect(observed).toEqual(['state', 'campaign']);
    expect(store.readRunState(project, runId).status).toBe(status);
    expect(readRunEvents(project, runId).filter(event => ['research_gate_candidate_settled', 'run_completed'].includes(event.type)).map(event => event.type)).toEqual([
      'research_gate_candidate_settled', 'run_completed',
    ]);
  },
);

it('records corrupt-candidate cleanup errors and still publishes the original terminal outcome', () => {
  writeFileSync(join(directory, 'research_gate_candidate.json'), '{corrupt');
  const error = vi.spyOn(log, 'error');
  const state = store.readRunState(project, runId);
  state.status = 'failed';
  state.failureReason = 'Original scheduler failure';
  state.completedAt = new Date().toISOString();
  const campaign = vi.fn();
  expect(() => concludeRun(state, { status: 'failed', reasonCode: 'scheduler_failed', detail: state.failureReason, eventFields: () => ({ detail: state.failureReason }), writeCampaignEntry: campaign })).not.toThrow();
  expect(error).toHaveBeenCalledWith({ err: expect.any(SyntaxError), runId }, 'Failed to settle pending research gate candidates');
  expect(campaign).toHaveBeenCalledWith(project, state);
  expect(store.readRunState(project, runId)).toMatchObject({ status: 'failed', failureReason: 'Original scheduler failure' });
  expect(readRunEvents(project, runId).find(event => event.type === 'run_completed')).toMatchObject({ type: 'run_completed', detail: 'Original scheduler failure' });
  expect(readFileSync(join(directory, 'research_gate_candidate.json'), 'utf8')).toBe('{corrupt');
});

it('does not retry a transient cleanup failure after completion, including with reread state', () => {
  const corrupt = join(directory, 'research_gate_candidate.json');
  writeFileSync(corrupt, '{corrupt');
  const error = vi.spyOn(log, 'error');
  const state = store.readRunState(project, runId);
  state.status = 'failed';
  state.failureReason = 'Original scheduler failure';
  state.completedAt = new Date().toISOString();
  concludeRun(state, { status: 'failed', reasonCode: 'scheduler_failed', detail: state.failureReason, eventFields: () => ({ detail: state.failureReason }) });
  expect(error).toHaveBeenCalledTimes(1);
  rmSync(corrupt);
  settleTerminalResearchCandidates(project, store.readRunState(project, runId));
  expect(readResearchGateCandidate(directory, 'review')?.settlement).toBeUndefined();
  expect(readRunEvents(project, runId).filter(event => ['research_gate_candidate_settled', 'run_completed'].includes(event.type)).map(event => event.type))
    .toEqual(['run_completed']);
});

it('settles a later terminal outcome despite a prior completion event', () => {
  appendRunEvent(project, runId, {
    type: 'run_completed', runId, timestamp: new Date(0).toISOString(), detail: 'Prior stopped outcome',
  });
  const state = store.readRunState(project, runId);
  state.status = 'failed';
  state.completedAt = new Date(1).toISOString();
  concludeRun(state, { status: 'failed', reasonCode: 'scheduler_failed', eventFields: () => ({ detail: 'New outcome' }) });
  expect(readResearchGateCandidate(directory, 'review')?.settlement?.disposition).toBe('rejected');
  expect(readRunEvents(project, runId).filter(event => ['research_gate_candidate_settled', 'run_completed'].includes(event.type)).map(event => event.type))
    .toEqual(['run_completed', 'research_gate_candidate_settled', 'run_completed']);
});

it.each(['stage-failure', 'iteration-safety-net', 'research-budget'] as const)(
  'orders actual candidate settlement before the %s completion event', async path => {
    const adapter = new ScriptedAdapter({});
    const workflow = { name: 'completion', description: '', defaults: {}, stages: [] };
    const state = store.readRunState(project, runId);
    const finalizer = createResearchBudgetFinalizer(project, runId, directory, workflow, adapter, new Map(), '', new Map());
    if (path === 'stage-failure') {
      const producer = StageConfigSchema.parse({ id: 'measure', role: 'engineer' });
      state.stages.measure = { status: 'failed', retries: 0, error: 'Synthetic measurement failure' };
      await concludeWorkflowIteration(state, [producer], 1, [], 0, 0, 1, finalizer,
        project, runId, directory, adapter, new Set(), new Map());
    } else if (path === 'iteration-safety-net') {
      await runWorkflowIterations([], '', 0, 1, false, project, runId, directory,
        workflow, adapter, new Map(), '', new Map());
    } else {
      await finalizer(state, 1, 'Synthetic budget exhausted', {
        stages: [], injectedDispatchStages: new Set(),
      });
    }
    expect(readResearchGateCandidate(directory, 'review')?.settlement?.disposition).toBe('rejected');
    const events = readRunEvents(project, runId);
    const settlement = events.findIndex(event => event.type === 'research_gate_candidate_settled');
    const completion = events.findIndex(event => event.type === 'run_completed');
    expect(settlement).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(settlement);
  },
);
