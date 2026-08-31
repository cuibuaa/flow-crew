/**
 * Phase-0 safety net — regression contracts for two grounded engine failures
 * (fixed on branch autonomous-loop-refactor):
 *
 *   FIX 1: a dynamic_dispatch (plan) stage that exits 0 but emits ZERO valid
 *   injected stages (truncated/empty/invalid dispatch.yaml — a transient LLM
 *   flake) was FATAL: it set status='failed' and punted to the human, bypassing
 *   the re-plan + technical-retry machinery. It is now a BOUNDED RETRY of the
 *   plan stage, escalating WITH SPECIFICS (parse error / unknown roles) only
 *   after the budget — and failing FASTER for a genuine unknown-role brief.
 *
 *   FIX 2: the supervisor had no verdict that could REJECT an emitted deliverable
 *   / force re-work — GUIDE only wrote advisory guidance the agent could ignore,
 *   which let a run codify a smoke as an "honest negative". A REJECT verdict now
 *   re-pends the stage (+ its gate) so the work is RE-DONE, bounded by a max
 *   reject count, with a guard against over-rejecting a legitimate honest negative.
 *
 * Both fixes are GENERIC engine mechanism (no domain/trading logic).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  runWorkflow,
  diagnoseEmptyDispatch,
  decideEmptyDispatchAction,
  decideRejectAction,
  buildRetryPreamble,
  type WorkflowConfig,
} from '../../src/scheduler.js';
import { SUPERVISOR_VERDICTS, parseSupervisorVerdict } from '../../src/supervisor.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import { createRun, readRunState, runDir, writeRunState } from '../../src/store.js';

let projectDir: string;
beforeEach(() => { projectDir = join(tmpdir(), 'fc-dr-' + randomBytes(6).toString('hex')); mkdirSync(projectDir, { recursive: true }); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

const planWorkflow: { config: WorkflowConfig; yaml: string } = {
  yaml: ['name: plan-only', 'defaults:', '  max_iterations: 4', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
  config: { name: 'plan-only', defaults: { max_iterations: 4 }, stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
};

function writeRoles(roles: string[]): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of roles) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [`name: ${role}`, 'description: test role', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: test'].join('\n'));
  }
  return agentsDir;
}

/** A non-research run (no research: frontmatter) so plain gate-pass / fail
 * terminal semantics apply — the simplest way to observe FIX 1/FIX 2 behavior. */
function setupPlainRun(): string {
  const created = createRun(projectDir, 'plan-only', planWorkflow.yaml, ['plan']);
  const rd = runDir(projectDir, created.runId);
  writeFileSync(join(rd, 'scheduler.pid'), String(process.pid));
  writeFileSync(join(rd, 'task_brief.md'), '# Test task\nDo the thing.');
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  writeRunState(projectDir, created.runId, state);
  return created.runId;
}

const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });

// =====================================================================================
// FIX 1 — pure decision helpers
// =====================================================================================
describe('FIX 1 (pure) — diagnoseEmptyDispatch distinguishes transient flakes from genuine failures', () => {
  it('no dispatch.yaml written → transient', () => {
    const d = diagnoseEmptyDispatch(false, null, ['planner', 'qa']);
    expect(d.transient).toBe(true);
    expect(d.unknownRoles).toEqual([]);
    expect(d.detail).toMatch(/No dispatch\.yaml/);
  });
  it('unparseable YAML → transient with parse detail', () => {
    const d = diagnoseEmptyDispatch(true, 'stages:\n  - id: x\n  role: : : oops\n   bad indent', ['planner']);
    expect(d.transient).toBe(true);
    expect(d.detail).toMatch(/could not be parsed|no stages|schema-valid/);
  });
  it('parsed but empty list → transient', () => {
    const d = diagnoseEmptyDispatch(true, 'stages: []', ['planner']);
    expect(d.transient).toBe(true);
    expect(d.detail).toMatch(/no stages/);
  });
  it('every stage names an unknown role → GENUINE (not transient), names the roles', () => {
    const d = diagnoseEmptyDispatch(true, 'stages:\n  - id: a\n    role: wizard\n  - id: b\n    role: sorcerer', ['planner', 'qa']);
    expect(d.transient).toBe(false);
    expect(d.unknownRoles).toEqual(['"wizard"', '"sorcerer"']);
    expect(d.detail).toContain('wizard');
    expect(d.detail).toContain('Available roles: planner, qa');
  });
});

describe('FIX 1 (pure) — decideEmptyDispatchAction retries under budget, escalates with specifics after', () => {
  const transient = { detail: 'dispatch.yaml could not be parsed', unknownRoles: [], transient: true };
  const genuine = { detail: 'every stage referenced an unknown role: "wizard"', unknownRoles: ['"wizard"'], transient: false };

  it('transient flake under budget → RETRY (not fatal)', () => {
    const a = decideEmptyDispatchAction(transient, 0, 2);
    expect(a.action).toBe('retry');
    if (a.action === 'retry') {
      expect(a.nextRetry).toBe(1);
      expect(a.error).toMatch(/^invalid dispatch\.yaml/);
    }
  });
  it('transient flake at budget → ESCALATE as failed WITH the specific detail (not the generic punt)', () => {
    const a = decideEmptyDispatchAction(transient, 2, 2);
    expect(a.action).toBe('escalate');
    if (a.action === 'escalate') {
      expect(a.status).toBe('failed');
      expect(a.reason).toContain('could not be parsed');
      expect(a.reason).not.toMatch(/Refine the task brief and try again\.?$/);
    }
  });
  it('genuine unknown-role failure → ESCALATE IMMEDIATELY (fail faster), prefer escalated, name the roles', () => {
    const a = decideEmptyDispatchAction(genuine, 0, 2); // budget remaining, but genuine → no retry
    expect(a.action).toBe('escalate');
    if (a.action === 'escalate') {
      expect(a.status).toBe('escalated');
      expect(a.unknownRoles).toEqual(['"wizard"']);
      expect(a.reason).toContain('wizard');
    }
  });
});

describe('FIX 1 (pure) — buildRetryPreamble renders the dispatch-specific re-prompt', () => {
  it('emits "you failed to emit a valid dispatch.yaml", the detail, the schema, and "write ONLY the file"', () => {
    const rd = join(projectDir, 'rd'); mkdirSync(join(rd, 'stages', 'plan'), { recursive: true });
    writeFileSync(join(rd, 'stages', 'plan', 'status.json'),
      JSON.stringify({ status: 'pending', retries: 1, error: 'invalid dispatch.yaml: some stages referenced unknown role(s): "wizard". Available roles: planner.' }));
    const p = buildRetryPreamble(1, 1000, rd, 'plan');
    expect(p).toMatch(/failed to emit a valid dispatch\.yaml/i);
    expect(p).toContain('wizard');
    expect(p).toMatch(/Required dispatch\.yaml schema/);
    expect(p).toMatch(/Write ONLY the dispatch\.yaml file/);
    expect(p).not.toMatch(/continue from where you left off/);
  });
});

// =====================================================================================
// FIX 1 — end-to-end loop behavior (mock-adapter driven, real runWorkflow)
// =====================================================================================
describe('FIX 1 (e2e) — empty dispatch is RETRYABLE, not fatal', () => {
  it('first plan emits empty dispatch, retry emits a valid stage → run completes (no fatal punt)', async () => {
    const runId = setupPlainRun();
    const agentsDir = writeRoles(['planner', 'qa']);
    let planCalls = 0;
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          planCalls++;
          if (planCalls === 1) {
            // First plan: emit an EMPTY dispatch (a transient flake).
            writeFileSync(join(opts.runDir, 'dispatch.yaml'), 'stages: []');
            return ok('planned (empty — flake)');
          }
          // Retry: emit a valid single stage.
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: work', '    role: qa', '    depends_on: [plan]', '    dependency_reasons:', '      plan: consumes the admitted plan proposal', '    scope: []', '    criterion_refs: []', '    prompt_template: do the work'].join('\n'));
          return ok('planned (valid)');
        }
        return ok(`did ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(planCalls).toBeGreaterThanOrEqual(2);       // it RETRIED the plan stage
    expect(final.status).not.toBe('failed');           // NOT a fatal punt on the first miss
    expect(final.status).toBe('complete');             // the valid retry let the run finish
  });

  it('every plan emits an unknown-role dispatch → ESCALATES with the specific roles (no generic punt)', async () => {
    const runId = setupPlainRun();
    const agentsDir = writeRoles(['planner', 'qa']);
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: cast', '    role: wizard', '    depends_on: [plan]', '    task: cast a spell'].join('\n'));
          return ok('planned (unknown role)');
        }
        return ok(`did ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('escalated');                       // genuine unsatisfiable brief → escalated terminal
    expect(final.failureReason ?? '').toContain('wizard');        // names the specific unknown role
    expect(final.failureReason ?? '').not.toMatch(/Refine the task brief and try again\.?$/); // NOT the old generic punt
  });
});

// =====================================================================================
// FIX 2 — supervisor REJECT verdict
// =====================================================================================
describe('FIX 2 — REJECT is a first-class supervisor verdict', () => {
  it('REJECT is in the verdict vocabulary and parses', () => {
    expect(SUPERVISOR_VERDICTS.map(v => v.id)).toContain('REJECT');
    const parsed = parseSupervisorVerdict('{"verdict":"REJECT","target_stage":"work","reason":"verdict claims pass but artifact missing","guidance":null}');
    expect(parsed?.verdict).toBe('REJECT');
    expect(parsed?.targetStage).toBe('work');
  });
});

describe('FIX 2 (pure) — decideRejectAction re-works under budget, then escalates (no silent acceptance)', () => {
  const sig = { targetStage: 'work', reason: 'verdict says pass but the cited metric shows fail' };
  it('under budget → REWORK the named stage', () => {
    const d = decideRejectAction(sig, 'work', 0, 2);
    expect(d.action).toBe('rework');
    if (d.action === 'rework') { expect(d.targetStage).toBe('work'); expect(d.nextCount).toBe(1); }
  });
  it('at budget → ESCALATE (avoid infinite loop without accepting rejected work)', () => {
    const d = decideRejectAction(sig, 'work', 2, 2);
    expect(d.action).toBe('escalate');
    if (d.action === 'escalate') expect(d.reason).toMatch(/budget exhausted/i);
  });
  it('no resolvable target → ESCALATE (cannot mechanically force re-work)', () => {
    const d = decideRejectAction({ targetStage: null, reason: 'x' }, null, 0, 2);
    expect(d.action).toBe('escalate');
  });
});

describe('FIX 2 (e2e) — REJECT forces re-work; the rejected deliverable is NOT accepted', () => {
  it('a stage whose first deliverable is rejected is re-run before the run completes', async () => {
    const runId = setupPlainRun();
    const agentsDir = writeRoles(['planner', 'qa']);
    let workCalls = 0;
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: work', '    role: qa', '    depends_on: [plan]', '    dependency_reasons:', '      plan: consumes the admitted plan proposal', '    scope: []', '    criterion_refs: []', '    prompt_template: produce the deliverable'].join('\n'));
          return ok('planned');
        }
        if (opts.stageId === 'work') {
          workCalls++;
          if (workCalls === 1) {
            // First deliverable is a smoke — drop a supervisor REJECT signal (as
            // the supervisor's act() would) so the scheduler consumer fires.
            mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
            writeFileSync(join(opts.runDir, 'signals', 'reject_work.json'),
              JSON.stringify({ stage: 'work', reason: 'deliverable claims success but the required artifact is empty', timestamp: new Date().toISOString() }));
            return ok('produced (smoke)');
          }
          return ok('produced (real, re-worked)');
        }
        return ok(`did ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(workCalls).toBeGreaterThanOrEqual(2);   // the work stage was RE-DONE (not accepted on the smoke)
    // The rejection guidance was injected for the re-work.
    const rd = runDir(projectDir, runId);
    const guidancePath = join(rd, 'supervisor_guidance.md');
    if (existsSync(guidancePath)) {
      expect(readFileSync(guidancePath, 'utf-8')).toMatch(/DELIVERABLE REJECTED/);
    }
    // The reject signal was consumed (one-shot).
    expect(existsSync(join(rd, 'signals', 'reject_work.json'))).toBe(false);
  });

  it('a mis-firing supervisor that rejects every pass is BOUNDED — the run still terminates', async () => {
    const runId = setupPlainRun();
    const agentsDir = writeRoles(['planner', 'qa']);
    let workCalls = 0;
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: work', '    role: qa', '    depends_on: [plan]', '    dependency_reasons:', '      plan: consumes the admitted plan proposal', '    scope: []', '    criterion_refs: []', '    prompt_template: produce the deliverable'].join('\n'));
          return ok('planned');
        }
        if (opts.stageId === 'work') {
          workCalls++;
          // ALWAYS reject — simulate a mis-firing supervisor. The bound must stop it.
          mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
          writeFileSync(join(opts.runDir, 'signals', 'reject_work.json'),
            JSON.stringify({ stage: 'work', reason: 'still not good enough (mis-fire)', timestamp: new Date().toISOString() }));
          return ok(`produced attempt ${workCalls}`);
        }
        return ok(`did ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    // It must NOT loop forever: bounded by default_supervisor_max_rejects (2) per
    // iteration × iterations. Terminates and does not hang.
    expect(['complete', 'failed', 'escalated', 'ceiling_hit', 'incomplete', 'stopped']).toContain(final.status);
    expect(workCalls).toBeLessThan(50); // sanity: not an unbounded loop
  });
});
