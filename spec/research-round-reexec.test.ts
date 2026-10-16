import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureResearchGateCandidate, readResearchGateCandidate } from '../src/research-candidate.js';
import { advanceSettledResearch } from '../src/scheduler/sched_loop/research-progress.js';
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
  { id: 'recurring_input', role: 'qa', depends_on: [], scope: ['artifacts/check.json'] },
  { id: 'recurring_gate', role: 'qa', depends_on: ['review_beta'], is_gate: true },
  { id: 'recurring_check', role: 'qa', depends_on: ['review_beta'] },
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
    state.startedAt = new Date(0).toISOString();
    if (research) state.research = { baseline: 0, policy: 'greedy_stack', resultFile: resultPath, stop: { maxRounds: 5 } };
    for (const stage of stages.slice(0, -1)) state.stages[stage.id] = { status: 'complete', retries: 0 };
    state.stages.round_gamma = { status: 'skipped', retries: 0 };
    state.stages.new_measurement = { status: 'complete', retries: 0 };
  });
  for (const gate of ['review_alpha', 'review_beta', 'recurring_gate', 'new_review']) {
    writeFileSync(join(directory, `verdict_${gate}.json`), JSON.stringify({ pass: true, reason: 'Synthetic independent review.' }));
  }
  mkdirSync(join(project, 'artifacts/research'), { recursive: true });
  const rounds = ['alpha', 'beta'].map((label, index) => ({ label: `measurement-${label}`, result: (index + 1) / 10 }));
  writeFileSync(join(directory, 'research_journal.json'), JSON.stringify({ rounds }));
  rounds.forEach((round, index) => {
    writeFileSync(join(project, resultPath), JSON.stringify(round));
    if (research) captureResearchGateCandidate(project, directory, `review_${index ? 'beta' : 'alpha'}`);
    writeFileSync(join(directory, `research_round_${index + 1}_consumed.json`), JSON.stringify(round));
  });
  // A downstream gate can recapture consumed beta without owning a new round.
  if (research) captureResearchGateCandidate(project, directory, 'recurring_gate');
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
    for (const stage of stages.filter(stage => /^(round|review)_(alpha|beta)$/.test(stage.id))) expect(prepared.state.stages[stage.id].status).toBe('complete');
    for (const id of ['recurring_check', 'recurring_gate', 'recurring_input']) expect(prepared.state.stages[id].status).toBe('pending');
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
    expect(ready.map(stage => stage.id)).toEqual(['plan', 'recurring_input', 'recurring_gate', 'recurring_check', 'round_gamma']);
    expect(JSON.parse(readFileSync(join(project, resultPath), 'utf8')).label).toBe('measurement-new');
    expect(readRunState(project, runId).stages.round_beta.status).toBe('complete');
  });

  it.each(['journal', 'consumed'] as const)('derives retained work from the %s record rather than completion alone', async record => {
    seed(true);
    if (record === 'journal') {
      for (const index of [1, 2]) unlinkSync(join(directory, `research_round_${index}_consumed.json`));
    } else unlinkSync(join(directory, 'research_journal.json'));
    const prepared = await reset();
    expect(prepared.state.stages.round_beta.status).toBe('complete');
    for (const id of ['recurring_check', 'recurring_gate', 'recurring_input']) expect(prepared.state.stages[id].status).toBe('pending');
  });

  it('reruns a consumed round gate when a recurring reviewed input resets', async () => {
    seed(true);
    const withRecurringInput = stages.map(stage => stage.id === 'review_beta'
      ? { ...stage, depends_on: ['round_beta', 'recurring_input'] } : stage);
    const prepared = await prepareWorkflowIteration(3, 1, false, project, runId, directory,
      new ScriptedAdapter({}), withRecurringInput, workflow);
    expect(prepared.state.stages.round_beta.status).toBe('complete');
    expect(prepared.state.stages.recurring_input.status).toBe('pending');
    expect(prepared.state.stages.review_beta.status).toBe('pending');
    expect(existsSync(join(directory, 'verdict_review_beta.json'))).toBe(false);
    const ready = createReadyFinder({ loadGateContract: () => null,
      readGateVerdict: (dir, id, run, contract) => readGateVerdict(dir, id, run, contract, false, false),
    })(prepared.kind === 'ready' ? prepared.sorted : [], prepared.state);
    expect(ready.map(stage => stage.id)).toContain('recurring_input');
    expect(ready.map(stage => stage.id)).not.toContain('round_gamma');
  });

  it('remeasures a passing round excluded by another gate, then journals its fresh outcome once', async () => {
    seed(true);
    // Alpha was consumed; beta passed its own gate but an independent gate failed.
    const alpha = { label: 'measurement-alpha', result: 0.1 };
    writeFileSync(join(directory, 'research_journal.json'), JSON.stringify({ rounds: [alpha] }));
    unlinkSync(join(directory, 'research_round_2_consumed.json'));
    const otherGate = StageConfigSchema.parse({ id: 'other_review', role: 'qa', is_gate: true });
    const active = [...stages, otherGate];
    updateRunState(project, runId, state => { state.stages.other_review = { status: 'complete', retries: 0 }; });
    writeFileSync(join(directory, 'verdict_other_review.json'), JSON.stringify({ pass: false, reason: 'Independent check failed.' }));
    const advance = () => advanceSettledResearch(readRunState(project, runId), active, stages, readRunState(project, runId).currentIteration!, [], 0, 1, 5,
      new Set(), new Map(), project, runId, directory,
      { name: 'research-reexec', description: '', defaults: {}, stages: active }, new ScriptedAdapter({}),
      new Map(), join(repository, 'config/agents'), new Map());
    await advance();
    expect(readResearchGateCandidate(directory, 'review_beta')?.settlement).toMatchObject({ disposition: 'rejected' });
    const prepared = await reset();
    expect(prepared.state.stages.round_alpha.status).toBe('complete');
    expect(prepared.state.stages.round_beta.status).toBe('pending');
    expect(prepared.state.stages.review_beta.status).toBe('pending');
    expect(existsSync(join(directory, 'verdict_review_beta.json'))).toBe(false);
    const ready = createReadyFinder({ loadGateContract: () => null,
      readGateVerdict: (dir, id, run, contract) => readGateVerdict(dir, id, run, contract, false, false),
    })(prepared.kind === 'ready' ? prepared.sorted : [], prepared.state);
    expect(ready.map(stage => stage.id)).toContain('round_beta');
    // Fresh measurement and accepted gates settle through the same ingestion path.
    writeFileSync(join(project, resultPath), JSON.stringify({ label: 'measurement-beta-fresh', result: 0.25 }));
    captureResearchGateCandidate(project, directory, 'review_beta');
    updateRunState(project, runId, state => {
      for (const stage of active) state.stages[stage.id] = { status: 'complete', retries: 0 };
    });
    for (const id of ['review_beta', 'recurring_gate', 'other_review']) {
      writeFileSync(join(directory, `verdict_${id}.json`), JSON.stringify({ pass: true, reason: 'Independent check passed.' }));
    }
    await advance();
    await advance();
    expect(JSON.parse(readFileSync(join(directory, 'research_journal.json'), 'utf8')).rounds.map((round: { label: string }) => round.label))
      .toEqual(['measurement-alpha', 'measurement-beta-fresh']);
  });

  it('resets completed rounds without durable outcomes, including captured but unconsumed outcomes', async () => {
    seed(true);
    unlinkSync(join(directory, 'research_journal.json'));
    for (const index of [1, 2]) unlinkSync(join(directory, `research_round_${index}_consumed.json`));
    const prepared = await reset();
    expect(stages.every(stage => prepared.state.stages[stage.id].status === 'pending')).toBe(true);
    expect(existsSync(join(directory, 'verdict_review_alpha.json'))).toBe(false);
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
