/**
 * Phase-0 safety net — loop-engine behavior (mock-adapter driven, no LLM).
 *
 * Drives the real research loop end-to-end with a deterministic inline adapter that writes one
 * round_result per round. Pins the observable loop outcomes the refactor must preserve:
 *   - improving past the beat target → shipped
 *   - plateau (halt_after_no_improvement) → ceiling_hit
 * and (the terminal-authority invariant the P1.3 surgery must satisfy) that a research run does
 * NOT complete via a gate-pass/nextPhase bypass before the policy says ship/ceiling.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runWorkflow, type WorkflowConfig } from '../../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import { createRun, readRunState, runDir, writeRunState } from '../../src/store.js';

let projectDir: string;
beforeEach(() => { projectDir = join(tmpdir(), 'fc-loop-' + randomBytes(6).toString('hex')); mkdirSync(projectDir, { recursive: true }); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

const researchWorkflow: { config: WorkflowConfig; yaml: string } = {
  yaml: ['name: research', 'defaults:', '  max_iterations: 12', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
  config: { name: 'research', defaults: { max_iterations: 12 }, stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
};

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'researcher', 'qa']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [`name: ${role}`, 'description: test role', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: test'].join('\n'));
  }
  return agentsDir;
}

function setupRun(stop: Record<string, unknown>, confirmCommand?: string): string {
  const created = createRun(projectDir, 'research', researchWorkflow.yaml, ['plan']);
  const rd = runDir(projectDir, created.runId);
  writeFileSync(join(rd, 'scheduler.pid'), String(process.pid));
  const brief = [
    '---', 'research:', '  baseline: 0', '  policy: best_of_n', '  higher_is_better: true',
    '  result_file: docs/research_round_result.json',
    ...(confirmCommand ? ['  confirm:', `    command: ${JSON.stringify(confirmCommand)}`, '    requires: candidate must reconfirm on a fresh split'] : []),
    '  stop:',
    ...Object.entries(stop).map(([k, v]) => `    ${k}: ${v}`),
    '---', '# Test research task',
  ].join('\n');
  writeFileSync(join(rd, 'task_brief.md'), brief);
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.campaignId = 'loop-test';
  state.campaignStorageKey = 'loop-test';
  writeRunState(projectDir, created.runId, state);
  return created.runId;
}

const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });

/** Inline adapter: plan → dispatch a single measure stage; measure → write the next round_result. */
function loopAdapter(results: number[]): { adapter: Adapter; rounds: () => number } {
  let i = 0;
  const adapter = {
    async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: measure', '    role: researcher', '    depends_on: [plan]', '    task: measure this round'].join('\n'));
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
  return { adapter, rounds: () => i };
}

describe('loop engine — research behavior (mock-driven)', () => {
  it('ships when a round beats the target', async () => {
    const runId = setupRun({ beat: 1.5, max_rounds: 8, halt_after_no_improvement: 3 });
    const agentsDir = writeRoles();
    const { adapter } = loopAdapter([2.0]); // first round already beats 1.5
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('shipped');
  });

  it('ceilings after halt_after_no_improvement consecutive non-improving rounds', async () => {
    const runId = setupRun({ beat: 99, max_rounds: 8, halt_after_no_improvement: 2 });
    const agentsDir = writeRoles();
    const { adapter } = loopAdapter([0.5, 0.4, 0.3]); // improve, then 2 non-improving → ceiling
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('ceiling_hit');
  });

  // P2 RANGE PROOF: auto-engineering is the SAME loop engine with a different objective — an
  // "acceptance" objective is just a metric objective where result = fraction of acceptance checks
  // passed and the target is 1.0 (all pass). No engine branch: research and engineering share one loop.
  it('drives an auto-engineering acceptance objective (ship when all checks pass) on the same engine', async () => {
    const runId = setupRun({ beat: 1.0, max_rounds: 8, halt_after_no_improvement: 3 });
    const agentsDir = writeRoles();
    const { adapter } = loopAdapter([0.67, 1.0]); // 2/3 acceptance checks pass, then 3/3 → ship
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('shipped'); // all acceptance checks pass → ship, identical loop machinery
  });

  // TERMINAL-AUTHORITY INVARIANT (P1.3): a research run must NOT complete via a passing-gate
  // bypass with zero measured rounds. The policy is the sole terminal authority — with no
  // rounds the run keeps re-planning until budget, then resolves a policy-owned terminal; it
  // never silently 'complete's.
  // FIX A: with ZERO (or insufficient) banked measured rounds, the budget-exhaustion terminal is
  // `incomplete` (search ran out of attempts before measuring enough), NOT `ceiling_hit` (which is
  // reserved for a genuine honest-negative ceiling with enough measured rounds). required rounds
  // here = min(max_rounds 8, halt_after_no_improvement 2) = 2; banked = 0 < 2 → incomplete.
  it('does NOT complete via a gate-pass bypass when the policy has never shipped/ceilinged', async () => {
    const runId = setupRun({ beat: 99, max_rounds: 8, halt_after_no_improvement: 2 });
    const agentsDir = writeRoles();
    // Adapter that passes a gate every iteration but NEVER writes a round_result (0 rounds).
    let plans = 0;
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          plans++;
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: closeout', '    role: qa', '    depends_on: [plan]', '    is_gate: true', '    task: close out'].join('\n'));
          return ok('planned (no round)');
        }
        if (opts.stageId === 'closeout') {
          writeFileSync(join(opts.runDir, 'verdict_closeout.json'), JSON.stringify({ pass: true, reason: 'looks done' }));
          return ok('gate passed');
        }
        return ok(`noop ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).not.toBe('complete');   // the bypass must be closed
    expect(final.status).toBe('incomplete');     // FIX A: 0 banked rounds < required → incomplete, not a false ceiling
    expect(plans).toBeGreaterThan(1);            // it re-planned rather than completing on iteration 1
  });

  // A+(a) CONFIRM GATE (verify-before-trust): a candidate that would ship is only accepted
  // as `shipped` if the brief-declared confirm command exits 0; otherwise it downgrades to
  // ceiling_hit (unconfirmed). The engine carries no domain knowledge — the command is brief-owned.
  it('ALLOWS ship when the confirm gate passes (exit 0)', async () => {
    const runId = setupRun({ beat: 1.5, max_rounds: 8, halt_after_no_improvement: 3 }, 'exit 0');
    const agentsDir = writeRoles();
    const { adapter } = loopAdapter([2.0]); // beats 1.5 → would ship
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('shipped'); // confirm passed → ship stands
  });

  it('DOWNGRADES ship → ceiling_hit when the confirm gate fails (non-zero exit)', async () => {
    const runId = setupRun({ beat: 1.5, max_rounds: 8, halt_after_no_improvement: 3 }, 'exit 1');
    const agentsDir = writeRoles();
    const { adapter } = loopAdapter([2.0]); // beats 1.5 → would ship, but confirm fails
    const final = await runWorkflow(researchWorkflow.config, researchWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('ceiling_hit'); // unconfirmed candidate is NOT shipped
    expect(final.status).not.toBe('shipped');
  });
});
