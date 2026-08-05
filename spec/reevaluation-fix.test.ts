import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { generateRunSummary } from '../src/run-summary.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  readRunState,
  runDir,
  writeRunState,
} from '../src/store.js';

let projectDir: string;

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-e6-reevaluation-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: reevaluation fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: reevaluation fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function dynamicWorkflow(): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: reevaluation-retry-ledger',
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {
      name: 'reevaluation-retry-ledger',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], scope: [],
        prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [],
      }],
    },
  };
}

describe('repair-stage retry ledger reevaluation', () => {
  it('retains a timed-out fix attempt before its successful retry', async () => {
    const { config, yaml } = dynamicWorkflow();
    const created = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);

    let gateCalls = 0;
    let fixCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') {
          return { output: '## What was done\n- verified repair retry ledger', exitCode: 0, duration_ms: 1 };
        }
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            '  - id: release_gate',
            '    role: qa',
            '    scope: []',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "evaluate the materialized plan"}',
            '    is_gate: true',
            '    task: verify release',
            '  - id: fix_release',
            '    role: repair',
            '    scope: [src/release.ts]',
            '    depends_on: [release_gate]',
            '    dependency_reasons: {release_gate: "consume the failed gate verdict"}',
            '    retry_to: [release_gate]',
            '    max_retries: 1',
            '    task: repair release',
          ].join('\n'));
          return { output: 'planned', exitCode: 0, duration_ms: 10 };
        }
        if (opts.stageId === 'release_gate') {
          gateCalls++;
          writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({
            pass: gateCalls > 1,
            reason: gateCalls > 1 ? 'fixed' : 'repair required',
          }));
          return { output: `gate ${gateCalls}`, exitCode: 0, duration_ms: 100, tokens_out: 1 };
        }
        if (opts.stageId === 'fix_release') {
          fixCalls++;
          return fixCalls === 1
            ? { output: 'repair timed out', exitCode: 124, duration_ms: 200, tokens_in: 20, tokens_out: 2 }
            : { output: 'repair complete', exitCode: 0, duration_ms: 300, tokens_in: 30, tokens_out: 3 };
        }
        return { output: 'unexpected stage', exitCode: 1, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles(), created.runId, 'repair retry ledger', true,
    );
    const repair = final.stages.fix_release;

    expect(final.status).toBe('complete');
    expect(repair.attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'complete']);
    expect(repair.attempts?.map((attempt) => attempt.exitCode)).toEqual([124, 0]);
    expect(repair).toMatchObject({
      status: 'complete', retries: 1, reruns: 1,
      duration_ms: 500, tokens_in: 50, tokens_out: 5,
    });
  });
});

describe('supervisor total-token summary reevaluation', () => {
  it('does not hide input usage when output usage is zero', async () => {
    const created = createRun(projectDir, 'supervisor-zero-output', 'name: supervisor-zero-output', ['work']);
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    state.completedAt = '2026-07-31T00:00:02.000Z';
    state.stages.work = { status: 'complete', retries: 0, duration_ms: 1_000 };
    state.supervisor = {
      status: 'complete', calls: 1, tokens_in: 999, tokens_out: 0,
      duration_ms: 1_500, startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.500Z', attempts: [],
    };
    writeRunState(projectDir, created.runId, state);
    const adapter: Adapter = {
      run: async () => ({ output: '## What was done\n- summarized usage', exitCode: 0, duration_ms: 1 }),
    };

    await generateRunSummary(projectDir, created.runId, adapter);
    const summary = readFileSync(join(runDir(projectDir, created.runId), 'summary.md'), 'utf-8');

    expect(summary).toContain('_supervisor: 1 calls, 2s cumulative, 999 tokens total (999 in + 0 out)');
  });
});
