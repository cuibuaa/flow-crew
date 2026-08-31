import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readCampaignEntries } from '../src/campaigns.js';
import {
  runWorkflow,
  type WorkflowConfig,
} from '../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { createRun, readRunState, runDir, writeRunState } from '../src/store.js';

let projectDir: string;

function freshProject() {
  return join(tmpdir(), 'terminal-contract-workflow-' + randomBytes(6).toString('hex'));
}

function writeRoleConfigs() {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: test role',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: test',
    ].join('\n'));
  }
  return agentsDir;
}

function workflow(maxIterations = 3): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: default',
    'defaults:',
    `  max_iterations: ${maxIterations}`,
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {
      name: 'default',
      defaults: { max_iterations: maxIterations },
      stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }],
    },
  };
}

function createCampaignRun(workflowYaml: string) {
  const created = createRun(projectDir, 'default', workflowYaml, ['plan']);
  writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.campaignId = 'btc-training';
  state.campaignStorageKey = 'btc-training';
  writeRunState(projectDir, created.runId, state);
  return created.runId;
}

function result(output: string, exitCode = 0): RunResult {
  return { output, exitCode, duration_ms: 1 };
}

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function terminalVerdict(value = 93.45724937752809) {
  return {
    pass: false,
    reason: 'study_complete_without_model_success',
    model_success: false,
    study_complete: true,
    metric: 'BTCTransferRobustScore',
    value,
    threshold: 300,
    net_2024_evaluation: value,
    net_2025_evaluation: 109.25,
  };
}

beforeEach(() => {
  projectDir = freshProject();
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('terminal final contract workflow behavior', () => {
  it('runs retry_to for an ordinary final-gate failure and only completes after the rerun passes', async () => {
    const gateId = 'btc_transfer_gate';
    const fixId = 'fix_transfer_gate';
    const { config, yaml } = workflow(2);
    const runId = createCampaignRun(yaml);
    const agentsDir = writeRoleConfigs();
    const calls: string[] = [];
    let gateAttempts = 0;

    const adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            `  - id: ${gateId}`,
            '    role: qa',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "evaluate the planned final transfer evidence"}',
            '    scope: []',
            '    is_gate: true',
            '    task: evaluate final transfer gate',
            `  - id: ${fixId}`,
            '    role: repair',
            `    depends_on: [${gateId}]`,
            `    dependency_reasons: {${gateId}: "repair the rejected final gate"}`,
            '    scope: []',
            `    retry_to: [${gateId}]`,
            '    task: repair final gate evidence',
          ].join('\n'));
          return result('planned');
        }
        if (opts.stageId === gateId) {
          gateAttempts++;
          writeJson(join(opts.runDir, `verdict_${gateId}.json`), gateAttempts === 1
            ? { pass: false, reason: 'missing_required_replay_artifact', model_success: false, study_complete: false }
            : { pass: true, reason: 'model_success', model_success: true, study_complete: true });
          return result(`gate attempt ${gateAttempts}`);
        }
        if (opts.stageId === fixId) return result('fixed missing replay artifact');
        return result(`unexpected ${opts.stageId}`, 1);
      },
      async discuss(): Promise<RunResult> { return result(''); },
      spawnDiscuss() { throw new Error('not used'); },
      async spawnInteractive() { throw new Error('not used'); },
    } as unknown as Adapter;

    const finalState = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);

    expect(finalState.status).toBe('complete');
    expect(gateAttempts).toBe(2);
    expect(calls.filter((stageId) => stageId !== '_summary')).toEqual(['plan', gateId, fixId, gateId]);
    expect(finalState.stages[fixId].status).toBe('complete');
    expect(finalState.stages[gateId].status).toBe('complete');
  });

  it('replans after a phase continuation gate instead of treating it as terminal final completion', async () => {
    const phaseGate = 'qa_phase3_protocols';
    const finalGate = 'btc_transfer_gate';
    const { config, yaml } = workflow(3);
    const runId = createCampaignRun(yaml);
    const agentsDir = writeRoleConfigs();
    const calls: string[] = [];
    let planCalls = 0;

    const adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), planCalls === 1
            ? [
                'stages:',
                `  - id: ${phaseGate}`,
                '    role: qa',
                '    depends_on: [plan]',
                '    dependency_reasons: {plan: "verify the current campaign phase"}',
                '    scope: []',
                '    is_gate: true',
                '    task: verify phase progress',
              ].join('\n')
            : [
                'stages:',
                `  - id: ${finalGate}`,
                '    role: qa',
                '    depends_on: [plan]',
                '    dependency_reasons: {plan: "verify final campaign evidence"}',
                '    scope: []',
                '    is_gate: true',
                '    task: verify final transfer gate',
              ].join('\n'));
          return result(`planned ${planCalls}`);
        }
        if (opts.stageId === phaseGate) {
          writeJson(join(opts.runDir, `verdict_${phaseGate}.json`), {
            pass: true,
            reason: 'phase3_complete_continue_next_phase',
            phase: 'phase3',
            phaseComplete: true,
            nextPhase: 'final',
            outcome: 'phase3_complete_continue_next_phase',
          });
          return result('phase complete');
        }
        if (opts.stageId === finalGate) {
          const verdict = terminalVerdict();
          writeJson(join(opts.runDir, `pre_gate_verdict_${finalGate}.json`), verdict);
          writeJson(join(opts.runDir, `verdict_${finalGate}.json`), verdict);
          return result('terminal final completion');
        }
        return result(`unexpected ${opts.stageId}`, 1);
      },
      async discuss(): Promise<RunResult> { return result(''); },
      spawnDiscuss() { throw new Error('not used'); },
      async spawnInteractive() { throw new Error('not used'); },
    } as unknown as Adapter;

    const finalState = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);

    expect(finalState.status).toBe('complete');
    expect(planCalls).toBe(2);
    expect(calls.filter((stageId) => stageId !== '_summary')).toEqual(['plan', phaseGate, 'plan', finalGate]);

    const campaignRows = readFileSync(join(projectDir, '.fc', 'campaigns', 'btc-training.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(campaignRows.some((row) => row.phase === 'phase3' && row.status === 'running')).toBe(true);
    expect(campaignRows.at(-1)).toMatchObject({
      pass: true,
      status: 'complete',
      modelPass: false,
      modelSuccess: false,
      terminalStudyComplete: true,
      outcome: 'study_complete_without_model_success',
    });
  });

  it('normalizes historical campaign rows from terminal run evidence without converting model failure into model success', () => {
    const runId = 'historical-' + randomBytes(4).toString('hex');
    const gateId = 'btc_transfer_gate';
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    mkdirSync(join(projectDir, '.fc', 'campaigns'), { recursive: true });
    writeJson(join(runDir(projectDir, runId), `verdict_${gateId}.json`), terminalVerdict(88.5));
    writeFileSync(join(projectDir, '.fc', 'campaigns', 'btc-training.jsonl'), JSON.stringify({
      seq: 1,
      runId,
      iteration: 5,
      gate: gateId,
      pass: false,
      score: 88.5,
      metric: 'BTCTransferRobustScore',
      timestamp: '2026-05-04T03:00:00.000Z',
      campaignId: 'btc-training',
      campaignStorageKey: 'btc-training',
    }) + '\n', 'utf-8');

    const entries = readCampaignEntries(projectDir, 'btc-training');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pass: true,
      score: 88.5,
      metric: 'BTCTransferRobustScore',
      workflowSatisfied: true,
      terminalStudyComplete: true,
      modelSuccess: false,
      outcome: 'study_complete_without_model_success',
    });
  });
});
