import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { createRun, readRunState, runDir, writeRunState } from '../src/store.js';

type Measurements = {
  parallel_raw: {
    wall_ms: number;
    stage_duration_sum_ms: number;
    run_status: string;
    exit_code: number;
  };
  session_reuse_on_raw: {
    brief_sha256: string;
    wall_ms: number;
    business_tokens_out: number;
  };
  session_reuse_off_raw: {
    brief_sha256: string;
    wall_ms: number;
    business_tokens_out: number;
  };
  session_reuse: { wall_benefit_pct: number; recommendation: string };
  supervisor: {
    calls: number;
    tokens_in: number;
    tokens_out: number;
    trace_calls: number;
    run_json_calls: number;
    summary_calls: number;
    status_calls: number;
    trace_tokens_out: number;
    run_json_tokens_out: number;
    summary_tokens_out: number;
    status_tokens_out: number;
  };
  tmp_audit: { path: string; under_tmpdir: boolean; under_project: boolean };
};

const measurementPath = process.env.E6_MEASUREMENTS_PATH;
const measured = measurementPath
  ? JSON.parse(readFileSync(measurementPath, 'utf-8')) as Measurements
  : undefined;
const measuredIt = measurementPath ? it : it.skip;

describe('recorded real-run acceptance evidence', () => {
  measuredIt('demonstrates real parallel overlap mechanically', () => {
    expect(measured!.parallel_raw).toMatchObject({ run_status: 'complete', exit_code: 0 });
    expect(measured!.parallel_raw.wall_ms).toBeLessThan(measured!.parallel_raw.stage_duration_sum_ms);
  });

  measuredIt('recomputes the preregistered session-reuse recommendation', () => {
    const on = measured!.session_reuse_on_raw;
    const off = measured!.session_reuse_off_raw;
    expect(on.brief_sha256).toBe(off.brief_sha256);
    const benefit = (off.wall_ms - on.wall_ms) / off.wall_ms * 100;
    expect(benefit).toBeCloseTo(measured!.session_reuse.wall_benefit_pct, 3);
    expect(benefit).toBeGreaterThanOrEqual(10);
    expect(measured!.session_reuse.recommendation).toBe('enable');
    expect(on.business_tokens_out).toBeGreaterThan(off.business_tokens_out);
  });

  measuredIt('keeps supervisor usage consistent in every recorded ledger', () => {
    const usage = measured!.supervisor;
    expect([usage.trace_calls, usage.run_json_calls, usage.summary_calls, usage.status_calls])
      .toEqual([usage.calls, usage.calls, usage.calls, usage.calls]);
    expect([usage.trace_tokens_out, usage.run_json_tokens_out, usage.summary_tokens_out, usage.status_tokens_out])
      .toEqual([usage.tokens_out, usage.tokens_out, usage.tokens_out, usage.tokens_out]);
    expect(usage.tokens_in + usage.tokens_out).toBeGreaterThan(usage.tokens_out);
  });

  measuredIt('records the clean audit below the operating-system temporary root', () => {
    const auditPath = measured!.tmp_audit.path;
    expect(isAbsolute(auditPath)).toBe(true);
    expect(relative(tmpdir(), auditPath)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(measured!.tmp_audit).toMatchObject({ under_tmpdir: true, under_project: false });
  });
});

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
    ].join('\n');
    const workflow: WorkflowConfig = {
      name: 'gate-technical-retry-history',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
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
          return { output: '## What was done\n- verified retry history', exitCode: 0, duration_ms: 1 };
        }
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
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
            '    retry_to: [release_gate]',
            '    task: fix release',
          ].join('\n'));
          return { output: 'planned', exitCode: 0, duration_ms: 10 };
        }
        if (opts.stageId === 'fix_release') {
          return { output: 'fixed', exitCode: 0, duration_ms: 200 };
        }
        if (opts.stageId === 'release_gate') {
          gateCalls++;
          if (gateCalls === 1) {
            writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({ pass: false, reason: 'needs fix' }));
            return { output: 'initial rejection', exitCode: 0, duration_ms: 100, tokens_out: 1 };
          }
          if (gateCalls === 2) {
            return { output: 'timed out while re-evaluating', exitCode: 124, duration_ms: 200, tokens_out: 2 };
          }
          writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({ pass: true, reason: 'fixed' }));
          return { output: 'final pass', exitCode: 0, duration_ms: 300, tokens_out: 3 };
        }
        return { output: 'unexpected stage', exitCode: 1, duration_ms: 1 };
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
