import '../test-support/policy-runtime.js';
import { parse as parseYaml } from 'yaml';
import { planRetryRequirement, preparePlanRetryCandidate, recordPlanRetryRefusal } from '../../src/plan-retry-monotone.js';
import { fixtureResult, declaredDispatch } from '../test-support/declared-dispatch.js';
import { artifacts } from '../spec_contracts/declared-fixtures.js';
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow, diagnoseEmptyDispatch, decideEmptyDispatchAction, buildRetryPreamble, type WorkflowConfig } from '../../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import { createRun } from '../test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, writeRunState } from '../../src/store.js';

let fixtureRoot: string, projectDir: string, previousStore: string;
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'fc-dr-'));
  projectDir = join(fixtureRoot, 'project'); mkdirSync(projectDir);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(fixtureRoot, 'state'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(fixtureRoot, { recursive: true, force: true }); });

const planWorkflow: { config: WorkflowConfig; yaml: string } = {
  yaml: ['name: plan-only', 'defaults:', '  max_iterations: 4', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
  config: {description: '',  name: 'plan-only', defaults: { max_iterations: 4 }, stages: [{ artifact_contract: artifacts([], [], []),criterion_refs: [],  id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
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

function setupResearchAdmissionRun(): string {
  const runId = setupPlainRun();
  const rd = runDir(projectDir, runId);
  const state = readRunState(projectDir, runId);
  state.terminalStates = { shipped: { paths: ['docs/final.md'] } };
  state.research = {
    baseline: 0,
    policy: 'greedy_stack',
    resultFile: 'docs/round.json',
    reportDir: 'docs',
    stop: { beat: 0.5, maxRounds: 2 },
  };
  writeRunState(projectDir, runId, state);
  writeFileSync(join(rd, 'task_brief.md'), [
    '---',
    'terminal_states:',
    '  shipped:',
    '    paths: [docs/final.md]',
    'research:',
    '  baseline: 0',
    '  policy: greedy_stack',
    '  result_file: docs/round.json',
    '  report_dir: docs',
    '  stop: {beat: 0.5, max_rounds: 2}',
    '---',
    '# Research admission retry fixture',
  ].join('\n'));
  return runId;
}

const measuringOwnerDispatch = [
  'stages:',
  '  - id: measure',
  '    role: qa',
  '    depends_on: []',
  '    dependency_reasons: {}',
  '    scope: [docs/round.json, docs/final.md]',
  '    criterion_refs: []',
  '    condition: research.decision != continue',
  '    prompt_template: measure and finalize in one unsafe stage',
].join('\n');

const separatedResearchDispatch = [
  'stages:',
  '  - id: measure',
  '    role: qa',
  '    depends_on: []',
  '    dependency_reasons: {}',
  '    scope: [docs/round.json]',
  '    criterion_refs: []',
  '    prompt_template: measure one result',
  '  - id: finalize',
  '    role: qa',
  '    depends_on: [measure]',
  '    dependency_reasons:',
  '      measure: consumes the framework-settled research result',
  '    scope: [docs/final.md]',
  '    criterion_refs: []',
  '    condition: research.terminalPath == docs/final.md',
  '    prompt_template: write only the selected terminal path',
].join('\n');

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
    const a = decideEmptyDispatchAction(transient);
    expect(a.action).toBe('retry');
    if (a.action === 'retry') {
      expect(a.detail).toContain('could not be parsed');
    }
  });
  it('genuine unknown-role failure → ESCALATE IMMEDIATELY (fail faster), prefer escalated, name the roles', () => {
    const a = decideEmptyDispatchAction(genuine); // budget remaining, but genuine → no retry
    expect(a.action).toBe('escalate');
    if (a.action === 'escalate') {
      expect(a.status).toBe('escalated');
      expect(a.unknownRoles).toEqual(['"wizard"']);
      expect(a.reason).toContain('wizard');
    }
  });
});

describe('FIX 1 (pure) — buildRetryPreamble renders the dispatch-specific re-prompt', () => {
  it('preserves valid work and evidence while permitting invalid partial work to be redone', () => {
    const rd = join(projectDir, 'rd'); mkdirSync(join(rd, 'stages', 'work'), { recursive: true });
    writeFileSync(join(rd, 'stages', 'work', 'status.json'), JSON.stringify({ error: 'command failed' }));
    const prompt = buildRetryPreamble(1, 1000, rd, 'work');
    expect(prompt).toContain('Preserve valid work and recorded evidence');
    expect(prompt).toContain('repair or redo invalid partial work');
    expect(prompt).toContain('within the current scope and deadline');
  });

  it('emits the dispatch failure, detail, schema, and incumbent-replacement instruction', () => {
    const rd = join(projectDir, 'rd'); mkdirSync(join(rd, 'stages', 'plan'), { recursive: true });
    writeFileSync(join(rd, 'stages', 'plan', 'status.json'),
      JSON.stringify({ status: 'pending', retries: 1, admissionFailure: { code: 'dispatch_refused', attemptIndex: 0 }, error: 'invalid dispatch.yaml: some stages referenced unknown role(s): "wizard". Available roles: planner.' }));
    writeFileSync(join(rd, 'dispatch.yaml'), 'stages: []');
    recordPlanRetryRefusal({ runDirPath: rd, prepared: preparePlanRetryCandidate({ runDirPath: rd, stageId: 'plan', iteration: 1, attemptIndex: 1 }), maxAttempts: 3,
      unsatisfied: [planRetryRequirement({ code: 'role_unknown', field: 'role', stageId: 'cast', message: 'Unknown role wizard; available roles: planner.' })] });
    const p = buildRetryPreamble(1, 1000, rd, 'plan');
    expect(p).toContain('dispatch admission rejected');
    expect(p).toContain('wizard');
    expect(p).toMatch(/dispatch\.yaml interface/);
    expect(p).toContain('complete replacement');
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
            writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch('stages: []'));
            return fixtureResult(ok('planned (empty — flake)'), opts);
          }
          // Retry: emit a valid single stage.
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(['stages:', '  - id: work', '    role: qa', '    depends_on: [plan]', '    dependency_reasons:', '      plan: consumes the admitted plan proposal', '    scope: []', '    criterion_refs: []', '    prompt_template: do the work'].join('\n')));
          return fixtureResult(ok('planned (valid)'), opts);
        }
        return fixtureResult(ok(`did ${opts.stageId}`), opts);
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
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(['stages:', '  - id: cast', '    role: wizard', '    depends_on: [plan]', '    task: cast a spell'].join('\n')));
          return fixtureResult(ok('planned (unknown role)'), opts);
        }
        return fixtureResult(ok(`did ${opts.stageId}`), opts);
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

  it('archives an admission refusal, exposes its exact error on retry, and admits the repaired proposal', async () => {
    const runId = setupResearchAdmissionRun();
    const rd = runDir(projectDir, runId);
    const agentsDir = writeRoles(['planner', 'qa']);
    let planCalls = 0;
    let measureCalls = 0;
    const planPrompts: string[] = [];
    const adapter = {
      async run(prompt: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          planCalls += 1;
          planPrompts.push(prompt);
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(planCalls === 1
            ? measuringOwnerDispatch
            : separatedResearchDispatch));
          return fixtureResult(ok(`planned attempt ${planCalls}`), opts);
        }
        if (opts.stageId === 'measure') {
          measureCalls += 1;
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'round.json'), JSON.stringify({ label: 'repair_converged', result: 1 }));
          return fixtureResult(ok('measured'), opts);
        }
        if (opts.stageId === 'finalize') {
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'final.md'), '# admitted terminal\n');
          return fixtureResult(ok('finalized'), opts);
        }
        return fixtureResult(ok(`did ${opts.stageId}`), opts);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);

    expect(planCalls).toBe(2);
    expect(measureCalls).toBe(1);
    expect(final.status).toBe('shipped');
    expect(planPrompts[1]).toContain('research result producer path docs/round.json cannot be owned by a terminal writer');
    expect(planPrompts[1]).toContain(join(rd, 'dispatch_rejections', 'attempt_1', 'dispatch.yaml'));
    expect(planPrompts[1]).toContain(join(rd, 'dispatch_rejections', 'attempt_1', 'dispatch_admission.json'));
    expect(parseYaml(readFileSync(join(rd, 'dispatch_rejections', 'attempt_1', 'dispatch.yaml'), 'utf-8')))
      .toEqual(parseYaml(declaredDispatch(measuringOwnerDispatch)));
    const archived = JSON.parse(readFileSync(join(rd, 'dispatch_rejections', 'attempt_1', 'dispatch_admission.json'), 'utf-8')) as { errors: Array<{message: string}> };
    expect(archived.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('separate measurement from terminalization');
  }, 60_000);

  it('refuses terminal settlement for a finalizer product delta with no independent review', async () => {
    const runId = setupPlainRun();
    const rd = runDir(projectDir, runId);
    const agentsDir = writeRoles(['planner', 'qa']);
    const state = readRunState(projectDir, runId);
    state.terminalStates = { complete: { paths: ['docs/final.md'] } };
    writeRunState(projectDir, runId, state);
    writeFileSync(join(rd, 'task_brief.md'), [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/final.md]',
      '---',
      '# Terminal validation-scope fixture',
    ].join('\n'));
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'generated.ts'), 'export const value = "before";\n');
    let finalizerCalls = 0;
    const adapter = {
      async run(_prompt: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
            'stages:',
            '  - id: finalize',
            '    role: qa',
            '    depends_on: []',
            '    dependency_reasons: {}',
            '    scope: [docs/final.md, src/generated.ts]',
            '    criterion_refs: []',
            '    prompt_template: validate and write the terminal report',
          ].join('\n')));
          return fixtureResult(ok('planned'), opts);
        }
        if (opts.stageId === 'finalize') {
          finalizerCalls += 1;
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'final.md'), '# terminal candidate\n');
          writeFileSync(join(projectDir, 'src', 'generated.ts'), 'export const value = "after gate";\n');
          return fixtureResult({
            ...ok('finalized with a forbidden durable delta'),
            writes: ['docs/final.md', 'src/generated.ts'],
            writeAttribution: 'structured',
          }, opts);
        }
        return fixtureResult(ok(`did ${opts.stageId}`), opts);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);

    expect(finalizerCalls).toBeGreaterThan(0);
    expect(final.status).not.toBe('complete');
    expect(readFileSync(join(projectDir, 'src', 'generated.ts'), 'utf-8'))
      .toBe('export const value = "after gate";\n');
    expect(final.failureReason).toContain('unreviewed product writes (src/generated.ts)');
    const audit = JSON.parse(readFileSync(join(rd, 'stages', 'finalize', `constraint_audit_attempt_${finalizerCalls}.json`), 'utf-8')) as {
      rolledBackWrites: string[];
      durableWrites: string[];
    };
    expect(audit.rolledBackWrites).toEqual([]);
    expect(audit.durableWrites).toContain('src/generated.ts');
  }, 60_000);
});
