import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { prepareWorkflowIteration } from '../src/scheduler/sched_loop/iteration-setup.js';
import { createReadyFinder } from '../src/scheduler/sched_admission/frontier.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { readGateVerdict } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';

const repository = resolve(import.meta.dirname, '..');
const resultPath = 'artifacts/research/round_result.json';
const stages = [
  { id: 'plan', role: 'planner', depends_on: [], dynamic_dispatch: true },
  { id: 'round_alpha', role: 'coder', depends_on: [], scope: [resultPath] },
  { id: 'review_alpha', role: 'qa', depends_on: ['round_alpha'], is_gate: true },
  { id: 'round_beta', role: 'coder', depends_on: ['review_alpha'], scope: [resultPath] },
  { id: 'review_beta', role: 'qa', depends_on: ['round_beta'], is_gate: true },
  { id: 'round_gamma', role: 'coder', depends_on: ['review_beta'], scope: [resultPath] },
].map(stage => StageConfigSchema.parse(stage));
const workflow = 'name: research-reexec\nstages: []\n';
let root: string, project: string, runId: string, directory: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(repository, '.tmp_research-reexec-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'research-reexec', workflow, stages.map(stage => stage.id)).runId;
  directory = runDir(project, runId);
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

function seed(research: boolean) {
  updateRunState(project, runId, state => {
    state.status = 'running';
    state.currentIteration = 2;
    if (research) state.research = { baseline: 0, policy: 'greedy_stack', stop: { maxRounds: 5 } };
    for (const stage of stages.slice(0, -1)) state.stages[stage.id] = { status: 'complete', retries: 0 };
    state.stages.round_gamma = { status: 'skipped', retries: 0 };
    state.stages.new_measurement = { status: 'complete', retries: 0 };
  });
  for (const gate of ['review_alpha', 'review_beta', 'new_review']) {
    writeFileSync(join(directory, `verdict_${gate}.json`), JSON.stringify({ pass: true, reason: 'Synthetic independent review.' }));
  }
  const consumed = { label: 'measurement-beta', result: 0.2 };
  writeFileSync(join(directory, 'research_journal.json'), JSON.stringify({ rounds: [consumed] }));
  writeFileSync(join(directory, 'research_round_1_consumed.json'), JSON.stringify(consumed));
  mkdirSync(join(project, 'artifacts/research'), { recursive: true });
  writeFileSync(join(project, resultPath), JSON.stringify({ label: 'measurement-new', result: 0.3 }));
}

async function reset() {
  return prepareWorkflowIteration(3, 1, false, project, runId, directory, new ScriptedAdapter({}), stages, workflow);
}

describe('research round identity across outer iteration resets', () => {
  it('keeps completed static measurements settled and executable new work behind their retained reviews', async () => {
    seed(true);
    const prepared = await reset();
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Unexpected terminal iteration.');
    for (const stage of stages.slice(1, -1)) expect(prepared.state.stages[stage.id].status).toBe('complete');
    expect(prepared.state.stages.plan.status).toBe('pending');
    expect(prepared.state.stages.round_gamma.status).toBe('pending');
    expect(prepared.state.stages.new_measurement).toBeUndefined();
    expect(prepared.state.stageEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'new_measurement', iteration: 2 }),
    ]));
    expect(existsSync(join(directory, 'verdict_new_review.json'))).toBe(false);
    // Use the real verdict reader, bypassing validation-delta receipts only:
    // the reset must keep each retained gate's own authored verdict available.
    const ready = createReadyFinder({
      loadGateContract: () => null,
      readGateVerdict: (projectDir, stageId, id, contract) => readGateVerdict(projectDir, stageId, id, contract, false, false),
    })(prepared.sorted, prepared.state);
    expect(ready.map(stage => stage.id)).toEqual(['plan', 'round_gamma']);
    expect(JSON.parse(readFileSync(join(project, resultPath), 'utf8')).label).toBe('measurement-new');
    expect(readRunState(project, runId).stages.round_beta.status).toBe('complete');
  });

  it('continues to reset completed static stages and verdicts for ordinary workflows', async () => {
    seed(false);
    const prepared = await reset();
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Unexpected terminal iteration.');
    expect(stages.every(stage => prepared.state.stages[stage.id].status === 'pending')).toBe(true);
    expect(existsSync(join(directory, 'verdict_review_beta.json'))).toBe(false);
  });
});
