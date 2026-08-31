/**
 * Engine terminal truthfulness contracts for budget, integrity, summary, and confirm state.
 * (honesty edges the prior A+ work did not cover). All task-agnostic: no domain field/threshold.
 *
 *   FIX A — budget-exhaustion with INSUFFICIENT banked measured rounds → `incomplete`, not a
 *           false `ceiling_hit`; a genuine policy ceiling (enough banked rounds) stays `ceiling_hit`.
 *   FIX B — integrity-rejected (e.g. noop) round COUNT is surfaced in the terminal report/detail,
 *           so honest work the gate discarded is visible (gate decision unchanged).
 *   FIX C — summary.md Decision label derives from the TERMINAL run.json status, not a stale
 *           research_decision.json snapshot.
 *   FIX D — a brief-declared research.confirm that never runs (non-ship terminal) is recorded
 *           as not_run in research_confirm.json (never silently invisible).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runWorkflow, type WorkflowConfig } from '../../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import { createRun, readRunState, runDir, runsRoot, writeRunState } from '../../src/store.js';
import { generateRunSummary } from '../../src/run-summary.js';

let projectDir: string;
beforeEach(() => { projectDir = join(tmpdir(), 'fc-r3-' + randomBytes(6).toString('hex')); mkdirSync(projectDir, { recursive: true }); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

const researchWorkflow: { config: WorkflowConfig; yaml: string } = {
  yaml: ['name: research', 'defaults:', '  max_iterations: 6', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
  config: { name: 'research', defaults: { max_iterations: 6 }, stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
};

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'researcher', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [`name: ${role}`, 'description: test role', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: test'].join('\n'));
  }
  return agentsDir;
}

function setupRun(stop: Record<string, unknown>, opts?: { confirmCommand?: string; baseline?: number; maxIterations?: number }): string {
  const created = createRun(projectDir, 'research', researchWorkflow.yaml, ['plan']);
  const rd = runDir(projectDir, created.runId);
  writeFileSync(join(rd, 'scheduler.pid'), String(process.pid));
  const brief = [
    '---', 'research:', `  baseline: ${opts?.baseline ?? 0}`, '  policy: best_of_n', '  higher_is_better: true',
    '  result_file: docs/research_round_result.json',
    ...(opts?.confirmCommand ? ['  confirm:', `    command: ${JSON.stringify(opts.confirmCommand)}`, '    requires: candidate must reconfirm on a fresh split'] : []),
    '  stop:',
    ...Object.entries(stop).map(([k, v]) => `    ${k}: ${v}`),
    '---', '# Test research task',
  ].join('\n');
  writeFileSync(join(rd, 'task_brief.md'), brief);
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
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:', '  - id: measure', '    role: researcher', '    depends_on: [plan]',
          '    scope: [docs/research_round_result.json, docs/research_round_result.json.no_candidate.json]',
          '    dependency_reasons: {plan: "measure only after this iteration is planned"}',
          '    task: measure this round',
        ].join('\n'));
        return ok('planned a round');
      }
      if (opts.stageId === 'measure') {
        const result = results[Math.min(i, results.length - 1)];
        const label = `round_${i + 1}`;
        i++;
        const file = join(projectDir, 'docs', 'research_round_result.json');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify({ label, result }));
        return ok(`measured ${label}=${result}`);
      }
      return ok(`noop ${opts.stageId}`);
    },
    async discuss(): Promise<RunResult> { return ok(''); },
    spawnDiscuss() { throw new Error('unused'); },
    async spawnInteractive() { throw new Error('unused'); },
  } as unknown as Adapter;
}

// A summary-narrative adapter that returns an empty narrative, so generateRunSummary falls back to
// its deterministic facts (the Decision/Outcome line we want to assert) without an LLM call.
const emptyNarrativeAdapter = {
  async run(): Promise<RunResult> { return ok(''); },
  async discuss(): Promise<RunResult> { return ok(''); },
  spawnDiscuss() { throw new Error('unused'); },
  async spawnInteractive() { throw new Error('unused'); },
} as unknown as Adapter;

describe('FIX A — budget-exhaustion: incomplete (insufficient rounds) vs ceiling_hit (genuine ceiling)', () => {
  it('INSUFFICIENT banked rounds → `incomplete` (every round noop-rejected; 0 < required)', async () => {
    // baseline 0, every measured round == 0 → noop-rejected → 0 banked rounds.
    // required = min(max_rounds 8, halt 2) = 2; banked 0 < 2 → incomplete.
    const runId = setupRun({ beat: 99, max_rounds: 8, halt_after_no_improvement: 2 }, { baseline: 0, maxIterations: 4 });
    const agentsDir = writeRoles();
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, loopAdapter([0, 0, 0, 0]), new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('incomplete');
    expect(final.status).not.toBe('ceiling_hit');
  });

  it('SUFFICIENT banked rounds → `ceiling_hit` (policy stayed `continue`, budget ran out, enough measured)', async () => {
    // Strictly-improving rounds keep best_of_n at `continue` (streak never reaches halt 3), no
    // max_rounds → policy never self-ceilings; budget (4 iters) exhausts with >=3 banked rounds.
    // required = halt 3; banked >= 3 → ceiling_hit (a real exhaustive plateau, not a starved run).
    const runId = setupRun({ beat: 999, halt_after_no_improvement: 3 }, { baseline: 0, maxIterations: 4 });
    const agentsDir = writeRoles();
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, loopAdapter([0.1, 0.2, 0.3, 0.4]), new Map(), undefined, agentsDir, runId);
    const journal = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_journal.json'), 'utf-8'));
    expect(journal.rounds.length).toBeGreaterThanOrEqual(3); // banked >= required
    expect(final.status).toBe('ceiling_hit');
    expect(final.status).not.toBe('incomplete');
  });
});

describe('FIX B — integrity-rejected round count is surfaced in the terminal report/detail', () => {
  it('a run with noop-rejected rounds shows the rejection count in the run_completed event detail', async () => {
    const runId = setupRun({ beat: 99, max_rounds: 8, halt_after_no_improvement: 2 }, { baseline: 0, maxIterations: 4 });
    const agentsDir = writeRoles();
    await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, loopAdapter([0, 0, 0, 0]), new Map(), undefined, agentsDir, runId);
    // The noop gate must have recorded rejections (these are the honest ~0 results it discarded).
    const rej = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_integrity_rejections.json'), 'utf-8'));
    expect((rej.noop ?? 0)).toBeGreaterThan(0);
    // The terminal event detail must surface that count (observability — honest work made visible).
    const events = readFileSync(join(runDir(projectDir, runId), 'events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const completed = events.filter((e) => e.type === 'run_completed').at(-1);
    expect(completed).toBeDefined();
    expect(String(completed.detail)).toMatch(/integrity-rejected rounds:\s*\d+/);
    expect(String(completed.detail)).toMatch(/noop:\d+/);
  });
});

describe('rejected research rounds settle their repair before the journal advances', () => {
  it('runs repair and gate re-evaluation before banking the measured round', async () => {
    const runId = setupRun({ beat: 99, max_rounds: 2 }, { baseline: 0, maxIterations: 1 });
    const taskRunDir = runDir(projectDir, runId);
    const order: string[] = [];
    let gateCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          order.push('plan');
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            '  - id: measure',
            '    role: researcher',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "measure only after planning"}',
            '    scope: [docs/research_round_result.json, docs/research_round_result.json.no_candidate.json]',
            '    task: measure the current round',
            '  - id: audit_round',
            '    role: qa',
            '    depends_on: [measure]',
            '    dependency_reasons: {measure: "audit the measured round"}',
            '    scope: []',
            '    is_gate: true',
            '    task: audit the current round',
            '  - id: repair_round',
            '    role: repair',
            '    depends_on: [audit_round]',
            '    dependency_reasons: {audit_round: "repair an explicit audit rejection"}',
            '    scope: [docs/repair_marker.txt]',
            '    retry_to: [audit_round]',
            '    task: repair the rejected round',
          ].join('\n'));
          return ok('planned measured, audited, and repairable work');
        }
        if (opts.stageId === 'measure') {
          order.push('measure');
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'research_round_result.json'), JSON.stringify({ label: 'round_1', result: 0.5 }));
          return ok('measured round 1');
        }
        if (opts.stageId === 'audit_round') {
          gateCalls++;
          order.push(`audit_${gateCalls}`);
          expect(existsSync(join(taskRunDir, 'research_journal.json'))).toBe(false);
          writeFileSync(join(opts.runDir, 'verdict_audit_round.json'), JSON.stringify({
            pass: gateCalls > 1,
            reason: gateCalls > 1 ? 'repair verified' : 'repair required',
          }));
          return ok(`audit ${gateCalls}`);
        }
        if (opts.stageId === 'repair_round') {
          order.push('repair');
          expect(existsSync(join(taskRunDir, 'research_journal.json'))).toBe(false);
          writeFileSync(join(projectDir, 'docs', 'repair_marker.txt'), 'repaired\n');
          return ok('repaired round 1');
        }
        return ok(`noop ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(
      researchWorkflow.config,
      researchWorkflow.yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      runId,
    );

    expect(order).toEqual(['plan', 'measure', 'audit_1', 'repair', 'audit_2']);
    const journal = JSON.parse(readFileSync(join(taskRunDir, 'research_journal.json'), 'utf-8')) as { rounds: unknown[] };
    expect(journal.rounds).toHaveLength(1);
    expect(final.currentIteration).toBe(1);
  });
});

describe('FIX C — summary.md Decision derives from the TERMINAL run.json status, not a stale snapshot', () => {
  it('a terminal ceiling_hit with a stale research_decision.json={decision:continue} summarizes as stop_ceiling, not continue', async () => {
    // Build a terminal run dir by hand with a STALE decision snapshot (the failure mode FIX C closes).
    const runId = 'r3-fixc-' + randomBytes(4).toString('hex');
    const rd = join(runsRoot(), runId);
    mkdirSync(rd, { recursive: true });
    const state = {
      runId, projectDir, workflow: 'research', status: 'ceiling_hit',
      stages: {}, currentIteration: 4, maxIterations: 4,
      research: { baseline: 0, policy: 'best_of_n', higherIsBetter: true, stop: { beat: 99 } },
      taskDescription: 'test', completedAt: new Date().toISOString(),
    };
    writeFileSync(join(rd, 'run.json'), JSON.stringify(state));
    // STALE snapshot: last refreshed when the run was still improving → says continue/improved.
    writeFileSync(join(rd, 'research_decision.json'), JSON.stringify({
      runningBest: 0.333, keptLabels: ['r1'], latestKept: true, consecutiveNoImprovement: 0,
      decision: 'continue', reason: 'latest round improved running-best to 0.333',
    }));
    writeFileSync(join(rd, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'r1', result: 0.333 }] }));
    try {
      await generateRunSummary(projectDir, runId, emptyNarrativeAdapter);
      const summary = readFileSync(join(rd, 'summary.md'), 'utf-8');
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
      research: { baseline: 0, policy: 'best_of_n', higherIsBetter: true, stop: { beat: 99 } },
      taskDescription: 'test', completedAt: new Date().toISOString(),
    };
    writeFileSync(join(rd, 'run.json'), JSON.stringify(state));
    writeFileSync(join(rd, 'research_decision.json'), JSON.stringify({
      runningBest: 0.333, keptLabels: ['r1'], latestKept: false, consecutiveNoImprovement: 3,
      decision: 'stop_ceiling', reason: '3 consecutive rounds without improvement',
    }));
    writeFileSync(join(rd, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'r1', result: 0.333 }] }));
    try {
      await generateRunSummary(projectDir, runId, emptyNarrativeAdapter);
      const summary = readFileSync(join(rd, 'summary.md'), 'utf-8');
      const decisionLine = summary.split('\n').find((l) => l.includes('**Decision:**')) ?? '';
      expect(decisionLine).toContain('stop_ceiling');
      expect(decisionLine).toContain('3 consecutive rounds without improvement'); // consistent reason kept
    } finally {
      rmSync(rd, { recursive: true, force: true });
    }
  });
});

describe('FIX D — a declared confirm that never runs (non-ship terminal) is recorded as not_run', () => {
  it('a run with rc.confirm that ends ceiling_hit writes research_confirm.json with status not_run', async () => {
    // Strictly-improving rounds, halt 3, no max_rounds → ceiling_hit at budget; confirm never runs
    // (confirm only runs on ship). It must be recorded, not silently skipped.
    const runId = setupRun({ beat: 999, halt_after_no_improvement: 3 }, { baseline: 0, maxIterations: 4, confirmCommand: 'exit 0' });
    const agentsDir = writeRoles();
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, loopAdapter([0.1, 0.2, 0.3, 0.4]), new Map(), undefined, agentsDir, runId);
    expect(['ceiling_hit', 'incomplete']).toContain(final.status); // a non-ship terminal
    const confirmPath = join(runDir(projectDir, runId), 'research_confirm.json');
    expect(existsSync(confirmPath)).toBe(true);
    const confirm = JSON.parse(readFileSync(confirmPath, 'utf-8'));
    expect(confirm.status).toBe('not_run');
    expect(String(confirm.reason)).toMatch(/ship/);
    expect(confirm.command).toBe('exit 0');
  });

  it('does NOT clobber a real confirm result on a ship (research_confirm.json keeps the pass record)', async () => {
    const runId = setupRun({ beat: 1.5, max_rounds: 8, halt_after_no_improvement: 3 }, { baseline: 0, confirmCommand: 'exit 0' });
    const agentsDir = writeRoles();
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, loopAdapter([2.0]), new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('shipped');
    const confirm = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_confirm.json'), 'utf-8'));
    expect(confirm.pass).toBe(true);        // the real confirm result, not the not_run stub
    expect(confirm.status).not.toBe('not_run');
  });
});
