import { runRecordPath, stageWorkPath } from '../../src/run-layout.js';
import { withConfirmedRejections } from '../test-support/confirmed-rejection.js';
import { fixtureResult, declaredDispatch } from '../test-support/declared-dispatch.js';
import { artifacts } from '../spec_contracts/declared-fixtures.js';
/**
 * Engine terminal truthfulness contracts for budget, integrity, summary, and confirm state.
 * (honesty edges the prior A+ work did not cover). All task-agnostic: no domain field/threshold.
 *
 *   FIX A — budget-exhaustion with INSUFFICIENT banked measured rounds → `incomplete`, not a
 *           false `ceiling_hit`; a genuine policy ceiling (enough banked rounds) stays `ceiling_hit`.
 *   FIX B — integrity-rejected round COUNT is surfaced in the terminal report/detail,
 *           so honest work the gate discarded is visible (gate decision unchanged).
 *   FIX C — summary.md Decision label derives from the TERMINAL run.json status, not a stale
 *           research_decision.json snapshot.
 *   FIX D — a brief-declared research.confirm that never runs (non-ship terminal) is recorded
 *           as not_run in research_confirm.json (never silently invisible).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runWorkflow, type WorkflowConfig } from '../../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import { createRun } from '../test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, runsRoot, setFcGlobalDir, writeRunState } from '../../src/store.js';
import { generateRunSummary } from '../test-support/run-summary.js';


let fixtureRoot: string, projectDir: string, previousStore: string;
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'fc-r3-'));
  projectDir = join(fixtureRoot, 'project'); mkdirSync(projectDir);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(fixtureRoot, 'state'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(fixtureRoot, { recursive: true, force: true }); });

const researchWorkflow: { config: WorkflowConfig; yaml: string } = {
  yaml: ['name: research', 'defaults:', '  max_iterations: 6', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
  config: {description: '',  name: 'research', defaults: { max_iterations: 6 }, stages: [{ artifact_contract: artifacts([], [], []),criterion_refs: [],  id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
};

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'researcher', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [`name: ${role}`, 'description: test role', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: test'].join('\n'));
  }
  return agentsDir;
}

function setupRun(stop: Record<string, unknown>, opts?: { confirmCommand?: string; baseline?: number; maxIterations?: number; resultMinimum?: number }): string {
  const created = createRun(projectDir, 'research', researchWorkflow.yaml, ['plan']);
  const rd = runDir(projectDir, created.runId);
  writeFileSync(runRecordPath(rd, 'scheduler.pid'), String(process.pid));
  const brief = [
    '---', 'research:', `  baseline: ${opts?.baseline ?? 0}`, '  policy: greedy_stack', '  higher_is_better: true',
    '  result_file: docs/research_round_result.json',
    ...(opts?.resultMinimum === undefined ? [] : [
      '  result_schema:',
      '    type: object',
      '    required: [label, result]',
      '    properties:',
      '      label: {type: string}',
      `      result: {type: number, minimum: ${opts.resultMinimum}}`,
    ]),
    ...(opts?.confirmCommand ? ['  confirm:', `    command: ${JSON.stringify(opts.confirmCommand)}`, '    requires: candidate must reconfirm on a fresh split'] : []),
    '  stop:',
    ...Object.entries(stop).map(([k, v]) => `    ${k}: ${v}`),
    '---', '# Test research task',
  ].join('\n');
  writeFileSync(runRecordPath(rd, 'task_brief.md'), brief);
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.campaignId = 'r3-test';
  state.campaignStorageKey = 'r3-test';
  if (opts?.maxIterations) state.maxIterations = opts.maxIterations;
  writeRunState(projectDir, created.runId, state);
  return created.runId;
}

const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });

/** Inline adapter: plan → dispatch a measure stage; measure → write the i-th round_result. */
function loopAdapter(results: number[]): Adapter {
  let i = 0;
  return {
    async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === 'plan') {
        writeFileSync(stageWorkPath(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          'stages:', '  - id: measure', '    role: researcher', '    depends_on: [plan]',
          '    scope: [docs/research_round_result.json, docs/research_round_result.json.no_candidate.json]',
          '    dependency_reasons: {plan: "measure only after this iteration is planned"}',
          '    task: measure this round',
        ].join('\n')));
        return fixtureResult(ok('planned a round'), opts);
      }
      if (opts.stageId === 'measure') {
        const result = results[Math.min(i, results.length - 1)];
        const label = `round_${i + 1}`;
        i++;
        const file = join(projectDir, 'docs', 'research_round_result.json');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify({ label, result }));
        return fixtureResult(ok(`measured ${label}=${result}`), opts);
      }
      return fixtureResult(ok(`noop ${opts.stageId}`), opts);
    },
    async discuss(): Promise<RunResult> { return ok(''); },
    spawnDiscuss() { throw new Error('unused'); },
    async spawnInteractive() { throw new Error('unused'); },
  } as unknown as Adapter;
}

// A summary-narrative adapter that returns an empty narrative, so generateRunSummary falls back to
// its deterministic facts (the Decision/Outcome line we want to assert) without an LLM call.
const emptyNarrativeAdapter = {
  async run(_record0, _record1, recordOpts: import("../../src/adapters/base.js").RunOpts): Promise<RunResult> { return fixtureResult(ok(''), recordOpts); },
  async discuss(): Promise<RunResult> { return ok(''); },
  spawnDiscuss() { throw new Error('unused'); },
  async spawnInteractive() { throw new Error('unused'); },
} as unknown as Adapter;

describe('FIX C — summary.md Decision derives from the TERMINAL run.json status, not a stale snapshot', () => {
  it('a terminal ceiling_hit with a stale research_decision.json={decision:continue} summarizes as stop_ceiling, not continue', async () => {
    // Build a terminal run dir by hand with a STALE decision snapshot (the failure mode FIX C closes).
    const runId = 'r3-fixc-' + randomBytes(4).toString('hex');
    const rd = join(runsRoot(), runId);
    mkdirSync(rd, { recursive: true });
    const state = {
      runId, projectDir, workflow: 'research', status: 'ceiling_hit',
      stages: {}, currentIteration: 4, maxIterations: 4,
      research: { baseline: 0, policy: 'greedy_stack', higherIsBetter: true, stop: { beat: 99 } },
      taskDescription: 'test', completedAt: new Date().toISOString(),
    };
    writeFileSync(runRecordPath(rd, 'run.json'), JSON.stringify(state));
    // STALE snapshot: last refreshed when the run was still improving → says continue/improved.
    writeFileSync(runRecordPath(rd, 'research_decision.json'), JSON.stringify({
      runningBest: 0.333, keptLabels: ['r1'], latestKept: true, consecutiveNoImprovement: 0,
      decision: 'continue', reason: 'latest round improved running-best to 0.333',
    }));
    writeFileSync(runRecordPath(rd, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'r1', result: 0.333 }] }));
    try {
      await generateRunSummary(projectDir, runId, emptyNarrativeAdapter);
      const summary = readFileSync(runRecordPath(rd, 'summary.md'), 'utf-8');
      const decisionLine = summary.split('\n').find((l) => l.includes('**Decision:**')) ?? '';
      expect(decisionLine).toContain('stop_ceiling');     // FIX C: reflects the terminal status
      expect(decisionLine).not.toContain('continue');     // not the stale snapshot decision
      // the stale snapshot's "improved" rationale must NOT be echoed (snapshot inconsistent with terminal)
      expect(decisionLine).not.toContain('improved running-best');
    } finally {
      rmSync(rd, { recursive: true, force: true });
    }
  });

  it('a consistent snapshot still contributes its reason (no false suppression)', async () => {
    const runId = 'r3-fixc2-' + randomBytes(4).toString('hex');
    const rd = join(runsRoot(), runId);
    mkdirSync(rd, { recursive: true });
    const state = {
      runId, projectDir, workflow: 'research', status: 'ceiling_hit',
      stages: {}, currentIteration: 4, maxIterations: 4,
      research: { baseline: 0, policy: 'greedy_stack', higherIsBetter: true, stop: { beat: 99 } },
      taskDescription: 'test', completedAt: new Date().toISOString(),
    };
    writeFileSync(runRecordPath(rd, 'run.json'), JSON.stringify(state));
    writeFileSync(runRecordPath(rd, 'research_decision.json'), JSON.stringify({
      runningBest: 0.333, keptLabels: ['r1'], latestKept: false, consecutiveNoImprovement: 3,
      decision: 'stop_ceiling', reason: '3 consecutive rounds without improvement',
    }));
    writeFileSync(runRecordPath(rd, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'r1', result: 0.333 }] }));
    try {
      await generateRunSummary(projectDir, runId, emptyNarrativeAdapter);
      const summary = readFileSync(runRecordPath(rd, 'summary.md'), 'utf-8');
      const decisionLine = summary.split('\n').find((l) => l.includes('**Decision:**')) ?? '';
      expect(decisionLine).toContain('stop_ceiling');
      expect(decisionLine).toContain('3 consecutive rounds without improvement'); // consistent reason kept
    } finally {
      rmSync(rd, { recursive: true, force: true });
    }
  });
});
