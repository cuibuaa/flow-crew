import { fixtureResult, declaredDispatch } from './test-support/declared-dispatch.js';
import { emptyArtifactContract, gateArtifactContract, planArtifactContract } from './spec_presentation/declared-fixtures.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { createRun, readRunState, runDir, writeRunState } from '../src/store.js';


let projectDir: string;

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-e6-acceptance-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: acceptance probe',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: acceptance probe',
    ].join('\n'));
  }
  return agentsDir;
}

describe('append-only gate history under a technical retry', () => {
  it('retains initial rejection, timed-out re-evaluation, and final pass', async () => {
    const yaml = [
      'name: gate-technical-retry-history',
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 1',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
      '    artifact_contract: {version: 1, produces: [{id: dispatch, root: run, path: dispatch.yaml}], reads: [], replays: []}',
    ].join('\n');
    const workflow: WorkflowConfig = {description: '', 
      name: 'gate-technical-retry-history',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{criterion_refs: [], 
        id: 'plan', role: 'planner', depends_on: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
        artifact_contract: planArtifactContract(),
      }],
    };
    const created = createRun(projectDir, workflow.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);

    let gateCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') {
          return fixtureResult({ output: '## What was done\n- verified retry history', exitCode: 0, duration_ms: 1 }, opts);
        }
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), declaredDispatch([
            'stages:',
            '  - id: release_gate',
            '    role: qa',
            '    scope: []',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "evaluate the planned release"}',
            '    is_gate: true',
            '    max_retries: 1',
            '    task: verify release',
            '  - id: fix_release',
            '    role: repair',
            '    scope: [src/release.ts]',
            '    depends_on: [release_gate]',
            '    dependency_reasons: {release_gate: "repair only after an explicit release rejection"}',
            '    retry_to: [release_gate]',
            '    task: fix release',
          ].join('\n'), { release_gate: gateArtifactContract('release_gate'), fix_release: emptyArtifactContract() }));
          return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 10 }, opts);
        }
        if (opts.stageId === 'fix_release') {
          return fixtureResult({ output: 'fixed', exitCode: 0, duration_ms: 200 }, opts);
        }
        if (opts.stageId === 'release_gate') {
          gateCalls++;
          if (gateCalls === 1) {
            writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({ pass: false, reason: 'needs fix' }));
            return fixtureResult({ output: 'initial rejection', exitCode: 0, duration_ms: 100, tokens_out: 1 }, opts);
          }
          if (gateCalls === 2) {
            return fixtureResult({ output: 'timed out while re-evaluating', exitCode: 124, duration_ms: 200, tokens_out: 2 }, opts);
          }
          writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({ pass: true, reason: 'fixed' }));
          return fixtureResult({ output: 'final pass', exitCode: 0, duration_ms: 300, tokens_out: 3 }, opts);
        }
        return fixtureResult({ output: 'unexpected stage', exitCode: 1, duration_ms: 1 }, opts);
      },
    };

    const final = await runWorkflow(
      workflow,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      created.runId,
      'release acceptance probe',
      true,
    );

    const gate = final.stages.release_gate;
    expect(final.status).toBe('complete');
    expect(gate.attempts?.map((attempt) => attempt.status)).toEqual(['complete', 'failed', 'complete']);
    expect(gate.attempts?.map((attempt) => attempt.duration_ms)).toEqual([100, 200, 300]);
    expect(gate).toMatchObject({ duration_ms: 600, tokens_out: 6, reruns: 2 });
  });
});
