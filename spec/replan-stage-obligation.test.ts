import { atomicWrite } from '../src/engine-fs.js';
import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, StageConfigSchema, type WorkflowConfig } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import {
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
    config: {description: '', 
      name: 'replan-stage-obligation',
      defaults: { max_iterations: maxIterations, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [], 
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
  writeFileSync(join(runDirPath, `fixture_verdict_${gateId}.json`), JSON.stringify({
    pass,
    reason: pass ? 'accepted' : 'phase 4 needs repair',
  }, null, 2) + '\n');
}

function firstPlan(): string {
  return [
    'stages:',
    '  - id: phase4_work',
    '    role: builder',
    '    depends_on: [plan]',
    '    dependency_reasons: {plan: "execute phase 4"}',
    '    scope: []',
    '    task: complete phase 4 work',
    '  - id: gate_phase4',
    '    role: qa',
    '    depends_on: [phase4_work]',
    '    dependency_reasons: {phase4_work: "verify phase 4"}',
    '    scope: []',
    '    is_gate: true',
    '    task: check phase 4',
    '  - id: phase4_repair',
    '    role: builder',
    '    depends_on: [gate_phase4]',
    '    retry_to: [gate_phase4]',
    '    scope: []',
    '    task: repair rejected phase 4 work',
    '  - id: phase5_ci_docs',
    '    role: builder',
    '    depends_on: [gate_phase4]',
    '    dependency_reasons: {gate_phase4: "continue only after phase 4 acceptance"}',
    '    scope: []',
    '    task: run phase 5 CI and documentation',
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
  it('stops after bounded repair and retains the unexecuted downstream obligation', async () => {
    const { config, yaml } = workflow(2);
    const calls: string[] = [];
    let planCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === '_summary') return fixtureResult(result('summary'), opts);
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(firstPlan()));
          return fixtureResult(result(`plan ${planCalls}`), opts);
        }
        if (opts.stageId === 'gate_phase4') {
          writeVerdict(opts.runDir, opts.stageId, false);
          return fixtureResult(result('phase 4 rejected'), opts);
        }
        return fixtureResult(result(opts.stageId), opts);
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
      'The rejected phase 4 gate must retain the downstream phase5_ci_docs obligation.',
      true,
    );

    expect(final.status).toBe('incomplete');
    expect(planCalls).toBe(1);
    expect(final.currentIteration).toBe(1);
    expect(calls).toContain('phase4_repair');
    expect(calls).not.toContain('phase5_ci_docs');
    expect(final.unresolvedStageObligations?.map((entry) => entry.stageId)).toEqual(['phase5_ci_docs']);
    expect(final.failureReason).toContain('phase5_ci_docs');
  });

  it('does not let a supervisor DONE signal bypass a pending obligation', async () => {
    const { config, yaml } = workflow(2);
    let planCalls = 0;
    const calls: string[] = [];
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === '_summary') return fixtureResult(result('summary'), opts);
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(firstPlan()));
          return fixtureResult(result(`plan ${planCalls}`), opts);
        }
        if (opts.stageId === 'gate_phase4') {
          writeVerdict(opts.runDir, opts.stageId, false);
          mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
          atomicWrite(join(opts.runDir, 'signals', 'goal_met.json'), JSON.stringify({ reason: 'premature DONE' }));
          return fixtureResult(result('phase 4 rejected while supervisor says done'), opts);
        }
        return fixtureResult(result(opts.stageId), opts);
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

    expect(final.status).toBe('incomplete');
    expect(planCalls).toBe(1);
    expect(final.currentIteration).toBe(1);
    expect(calls).toContain('phase4_repair');
    expect(calls).not.toContain('phase5_ci_docs');
    expect(final.stages.phase5_ci_docs.status).toBe('pending');
    expect(final.unresolvedStageObligations?.map(entry => entry.stageId)).toContain('phase5_ci_docs');
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
    }];
    writeRunState(projectDir, run.runId, seeded);
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        return fixtureResult(result(opts.stageId === '_summary' ? 'summary' : 'static plan complete'), opts);
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

  it('withholds an authored terminal_states outcome until carried obligations settle', async () => {
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
        if (opts.stageId === '_summary') return fixtureResult(result('summary'), opts);
        adapterCalls++;
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
            'stages:',
            '  - id: terminal_writer',
            '    role: builder',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "write the sole declared terminal artifact"}',
            '    scope: [docs/explicit-terminal.md]',
            '    task: write the explicit terminal artifact',
          ].join('\n')));
          return fixtureResult(result('planned terminal writer'), opts);
        }
        expect(opts.stageId).toBe('terminal_writer');
        mkdirSync(join(projectDir, 'docs'), { recursive: true });
        writeFileSync(join(projectDir, 'docs', 'explicit-terminal.md'), '# Explicitly complete\n');
        return fixtureResult({
          ...result('wrote the explicit terminal artifact'),
          writes: ['docs/explicit-terminal.md'],
          writeAttribution: 'structured',
        }, opts);
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

    expect(final.status).toBe('incomplete');
    expect(final.terminalArtifact).toBeUndefined();
    expect(final.failureReason).toContain('phase5_ci_docs');
    expect(adapterCalls).toBe(2);
    expect(final.unresolvedStageObligations?.map((entry) => entry.stageId)).toEqual(['phase5_ci_docs']);
  });
});
