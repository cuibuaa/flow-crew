import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { ScriptedAdapter, type StageScript } from '../src/adapters/scripted.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const repository = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures', 'research-round-settlement.yaml');
const resultPath = 'artifacts/research/round_result.json';
const brief = `---
terminal_states:
  ceiling_hit:
    paths: [artifacts/research/ceiling_report.md]
research:
  baseline: 0
  policy: greedy_stack
  result_file: ${resultPath}
  report_dir: artifacts/research
  stop:
    max_rounds: 2
---
# Measure independently reviewed rounds until the declared ceiling.
`;

let root: string;
let previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(repository, '.tmp_research-settlement-'));
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

async function scenario(producer: string, gate: 'passed' | 'rejected' | 'missing' = 'passed') {
  const { config, raw } = loadWorkflow(fixture);
  const stages = config.stages.filter(stage => stage.id !== 'plan');
  // The persisted real workflow contains the planner's expanded stages. Start
  // from its planner and admit that same shape through normal dynamic dispatch.
  config.stages = config.stages.filter(stage => stage.id === 'plan');
  const dispatch = stringify(stages).replaceAll('baseline_round', producer);
  const verdict = (stage: string, pass: boolean): StageScript => ({
    output: `Independent review ${pass ? 'passed' : 'rejected'}.`,
    runFiles: {
      [`stages/${stage}/review/evidence.md`]: 'Independent review receipt.\n',
      [`verdict_${stage}.json`]: JSON.stringify({
        pass, reason: pass ? 'The independently recomputed measurement agrees.' : 'The measurement does not reproduce.',
        criteria: {}, audit_findings: { version: 1, findings: [] },
      }),
    },
  });
  const measurement = (round: number) => ({
    output: `Measured round ${round}.`,
    projectFiles: {
      [resultPath]: JSON.stringify({ label: `measurement-${round}`, result: round / 10, evidence: `artifacts/research/rounds/round_01/evidence-${round}.json` }),
      [`artifacts/research/rounds/round_01/evidence-${round}.json`]: JSON.stringify({ round, result: round / 10 }),
      'artifacts/research/stage_01_verdict.md': `Round ${round} measurement evidence.\n`,
    },
  });
  const adapter = new ScriptedAdapter({
    plan: [{ runFiles: { 'dispatch.yaml': dispatch } }, { runFiles: { 'dispatch.yaml': dispatch } }],
    [producer]: [measurement(1), measurement(2)],
    baseline_review: gate === 'missing'
      ? { output: 'Review ended without its verdict.' }
      : verdict('baseline_review', gate === 'passed'),
    baseline_repair: { output: 'No admissible correction is available.' },
    ceiling_report: { projectFiles: { 'artifacts/research/ceiling_report.md': '# Ceiling\nTwo independent measurements settled.\n' } },
    ceiling_review: verdict('ceiling_review', true),
    _summary: { output: 'Measurement campaign summary.' },
  });
  const journalsBeforePlanning: unknown[] = [];
  const executeScript = adapter.run.bind(adapter);
  adapter.run = async (prompt, role, opts) => {
    if (opts.stageId === 'plan') {
      const journal = join(opts.runDir, 'research_journal.json');
      journalsBeforePlanning.push(existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : undefined);
    }
    return executeScript(prompt, role, opts);
  };
  const project = join(root, 'project');
  mkdirSync(project);
  const state = await runWorkflow(config, raw, project, adapter, new Map(), undefined,
    join(repository, 'config', 'agents'), undefined, brief, true, undefined, false);
  const run = runDir(project, state.runId);
  const read = (name: string) => JSON.parse(readFileSync(join(run, name), 'utf8'));
  return { state, adapter, run, read, journalsBeforePlanning };
}

describe('planner-authored research round settlement', () => {
  it.each(['baseline_round', 'experiment_alpha'])('settles %s and replans despite the unselected terminal gate', async producer => {
    const { state, adapter, read, journalsBeforePlanning } = await scenario(producer);
    expect(read('research_journal.json').rounds).toEqual([
      expect.objectContaining({ label: 'measurement-1', result: 0.1 }),
      expect.objectContaining({ label: 'measurement-2', result: 0.2 }),
    ]);
    const plannerCalls = adapter.calls.filter(call => call.stageId === 'plan');
    expect(plannerCalls).toHaveLength(2);
    expect(journalsBeforePlanning).toEqual([
      undefined,
      expect.objectContaining({ rounds: [expect.objectContaining({ label: 'measurement-1', result: 0.1 })] }),
    ]);
    expect(adapter.calls.filter(call => call.stageId === producer)).toHaveLength(2);
    expect(adapter.calls.filter(call => call.stageId === 'baseline_review')).toHaveLength(2);
    expect(adapter.calls.filter(call => call.stageId === 'ceiling_report')).toHaveLength(1);
    expect(state.currentIteration).toBe(2);
    expect(state.status).toBe('ceiling_hit');
    expect(state.terminalArtifact).toBe('artifacts/research/ceiling_report.md');
  }, 60000);

  it.each(['rejected', 'missing'] as const)('does not bank a round with a %s gate', async gate => {
    const { state, adapter, run } = await scenario('baseline_round', gate);
    expect(existsSync(join(run, 'research_journal.json'))).toBe(false);
    expect(adapter.calls.filter(call => call.stageId === 'plan')).toHaveLength(1);
    expect(adapter.calls.some(call => call.stageId === 'ceiling_report')).toBe(false);
    expect(state.status).toBe('incomplete');
  }, 60000);
});
