import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

let fixtureRoot: string;
let projectDir: string;
let previousFcGlobalDir: string;

function workflow(maxIterations: number, dynamicDispatch = true): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: replan-stage-obligation',
    'defaults:',
    `  max_iterations: ${maxIterations}`,
    '  max_retries: 0',
    'stages:',
    '  - id: plan',
    '    role: planner',
    ...(dynamicDispatch ? ['    dynamic_dispatch: true'] : []),
  ].join('\n');
  return {
    yaml,
    config: {
      name: 'replan-stage-obligation',
      defaults: { max_iterations: maxIterations, max_retries: 0 },
      stages: [{
        id: 'plan',
        role: 'planner',
        depends_on: [],
        prompt_template: '',
        dynamic_dispatch: dynamicDispatch,
        is_gate: false,
        skills: [],
      }],
    },
  };
}

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'builder', 'qa']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: re-plan obligation fixture role',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function result(output: string, exitCode = 0): RunResult {
  return { output, exitCode, duration_ms: 1 };
}

function writeVerdict(runDirPath: string, gateId: string, pass: boolean): void {
  writeFileSync(join(runDirPath, `verdict_${gateId}.json`), JSON.stringify({
    pass,
    reason: pass ? 'accepted' : 'phase 4 needs a re-plan',
  }, null, 2) + '\n');
}

function firstPlan(): string {
  return [
    'stages:',
    '  - id: phase4_work',
    '    role: builder',
    '    depends_on: [plan]',
    '    task: complete phase 4 work',
    '  - id: gate_phase4',
    '    role: qa',
    '    depends_on: [phase4_work]',
    '    is_gate: true',
    '    task: check phase 4',
    '  - id: phase5_ci_docs',
    '    role: builder',
    '    depends_on: [gate_phase4]',
    '    task: run phase 5 CI and documentation',
  ].join('\n');
}

function passingReplacementPlan(gateId = 'replacement_gate'): string {
  return [
    'stages:',
    `  - id: ${gateId}`,
    '    role: qa',
    '    depends_on: [plan]',
    '    is_gate: true',
    '    task: accept the replacement plan',
  ].join('\n');
}

beforeEach(() => {
  previousFcGlobalDir = fcGlobalDir();
  fixtureRoot = join(tmpdir(), `flowcrew-replan-obligation-${randomBytes(6).toString('hex')}`);
  projectDir = join(fixtureRoot, 'project');
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  setFcGlobalDir(previousFcGlobalDir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('engine-owned unresolved stage obligations', () => {
  it('does not complete when iteration 2 omits an unexecuted downstream stage and passes', async () => {
    const { config, yaml } = workflow(2);
    const calls: string[] = [];
    let planCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === '_summary') return result('summary');
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), planCalls === 1
            ? firstPlan()
            : passingReplacementPlan());
          return result(`plan ${planCalls}`);
        }
        if (opts.stageId === 'gate_phase4') {
          writeVerdict(opts.runDir, opts.stageId, false);
          return result('phase 4 rejected');
        }
        if (opts.stageId === 'replacement_gate') {
          writeVerdict(opts.runDir, opts.stageId, true);
          return result('replacement accepted');
        }
        return result(opts.stageId);
      },
    } as Adapter;

    const final = await runWorkflow(
      config,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'Iteration 1 declares phase5_ci_docs; iteration 2 must not forget it.',
      true,
    );

    expect(final.status).toBe('incomplete');
    expect(planCalls).toBe(2);
    expect(calls).not.toContain('phase5_ci_docs');
    expect(final.unresolvedStageObligations?.map((entry) => entry.stageId)).toEqual(['phase5_ci_docs']);
    expect(final.failureReason).toContain('phase5_ci_docs');
  });

  it('keeps re-planning until the same downstream stage ID is satisfied', async () => {
    const { config, yaml } = workflow(3);
    const calls: string[] = [];
    const planPrompts: string[] = [];
    let planCalls = 0;
    const adapter: Adapter = {
      async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === '_summary') return result('summary');
        if (opts.stageId === 'plan') {
          planCalls++;
          planPrompts.push(prompt);
          const dispatch = planCalls === 1
            ? firstPlan()
            : planCalls === 2
              ? passingReplacementPlan('iteration_2_gate')
              : [
                  'stages:',
                  '  - id: phase5_ci_docs',
                  '    role: builder',
                  '    depends_on: [plan]',
                  '    task: finally run phase 5 CI and documentation',
                  '  - id: final_gate',
                  '    role: qa',
                  '    depends_on: [phase5_ci_docs]',
                  '    is_gate: true',
                  '    task: accept the fully discharged plan',
                ].join('\n');
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), dispatch);
          return result(`plan ${planCalls}`);
        }
        if (opts.stageId === 'gate_phase4') {
          writeVerdict(opts.runDir, opts.stageId, false);
          return result('phase 4 rejected');
        }
        if (opts.stageId === 'iteration_2_gate' || opts.stageId === 'final_gate') {
          writeVerdict(opts.runDir, opts.stageId, true);
          return result(`${opts.stageId} accepted`);
        }
        return result(opts.stageId);
      },
    } as Adapter;

    const final = await runWorkflow(
      config,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'A later plan must discharge phase5_ci_docs by exact stage ID.',
      true,
    );

    expect(final.status).toBe('complete');
    expect(planCalls).toBe(3);
    expect(calls.filter((stageId) => stageId === 'phase5_ci_docs')).toHaveLength(1);
    expect(planPrompts[1]).toContain('phase5_ci_docs');
    expect(planPrompts[2]).toContain('phase5_ci_docs');
    expect(final.unresolvedStageObligations).toBeUndefined();
  });

  it('does not let a supervisor DONE signal bypass a pending obligation', async () => {
    const { config, yaml } = workflow(2);
    let planCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return result('summary');
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), planCalls === 1
            ? firstPlan()
            : [
                'stages:',
                '  - id: phase5_ci_docs',
                '    role: builder',
                '    depends_on: [plan]',
                '    task: discharge the forgotten stage',
                '  - id: final_gate',
                '    role: qa',
                '    depends_on: [phase5_ci_docs]',
                '    is_gate: true',
                '    task: accept after discharge',
              ].join('\n'));
          return result(`plan ${planCalls}`);
        }
        if (opts.stageId === 'gate_phase4') {
          writeVerdict(opts.runDir, opts.stageId, false);
          mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
          writeFileSync(join(opts.runDir, 'signals', 'goal_met.json'), JSON.stringify({ reason: 'premature DONE' }));
          return result('phase 4 rejected while supervisor says done');
        }
        if (opts.stageId === 'final_gate') {
          writeVerdict(opts.runDir, opts.stageId, true);
          return result('final accepted');
        }
        return result(opts.stageId);
      },
    } as Adapter;

    const final = await runWorkflow(
      config,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'Supervisor DONE cannot erase an engine-owned stage obligation.',
      true,
    );

    expect(final.status).toBe('complete');
    expect(planCalls).toBe(2);
    expect(final.stages.phase5_ci_docs.status).toBe('complete');
  });

  it('guards the no-dispatch allDone completion path', async () => {
    const { config, yaml } = workflow(1, false);
    const run = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, run.runId), 'scheduler.pid'), String(process.pid));
    const seeded = readRunState(projectDir, run.runId);
    seeded.autoApprove = true;
    seeded.unresolvedStageObligations = [{
      stageId: 'phase5_ci_docs',
      declaredIteration: 1,
      scopePlanningDigests: ['undisposed-scope-digest'],
    }];
    writeRunState(projectDir, run.runId, seeded);
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        return result(opts.stageId === '_summary' ? 'summary' : 'static plan complete');
      },
    } as Adapter;

    const final = await runWorkflow(
      config,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      run.runId,
      'A static allDone branch must honor carried obligations.',
      true,
    );

    expect(final.status).toBe('incomplete');
    expect(final.failureReason).toContain('phase5_ci_docs');
  });

  it('keeps an authored terminal_states artifact as explicit terminal authority', async () => {
    const brief = [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/explicit-terminal.md]',
      '---',
      '# Explicit terminal fixture',
    ].join('\n');
    const { config, yaml } = workflow(1);
    const run = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, run.runId), 'scheduler.pid'), String(process.pid));
    const seeded = readRunState(projectDir, run.runId);
    seeded.autoApprove = true;
    seeded.unresolvedStageObligations = [{ stageId: 'phase5_ci_docs', declaredIteration: 1 }];
    writeRunState(projectDir, run.runId, seeded);
    let adapterCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return result('summary');
        adapterCalls++;
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            '  - id: terminal_writer',
            '    role: builder',
            '    depends_on: [plan]',
            '    task: write the explicit terminal artifact',
          ].join('\n'));
          return result('planned terminal writer');
        }
        expect(opts.stageId).toBe('terminal_writer');
        mkdirSync(join(projectDir, 'docs'), { recursive: true });
        writeFileSync(join(projectDir, 'docs', 'explicit-terminal.md'), '# Explicitly complete\n');
        return result('wrote the explicit terminal artifact');
      },
    } as Adapter;

    const final = await runWorkflow(
      config,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      run.runId,
      brief,
      true,
    );

    expect(final.status).toBe('complete');
    expect(final.terminalArtifact).toBe('explicit-terminal.md');
    expect(adapterCalls).toBe(2);
    expect(final.unresolvedStageObligations?.map((entry) => entry.stageId)).toEqual(['phase5_ci_docs']);
  });
});
