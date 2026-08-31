import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  createRun,
  readRunState,
  readStageStatus,
  runDir,
  writeRunState,
} from '../src/store.js';

let projectDir: string;

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`, 'description: test role', 'model: default',
      'reasoning_effort: default', 'tools: []', 'prompt: test',
    ].join('\n'));
  }
  return agentsDir;
}

function workflow(): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: attempts',
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
      name: 'attempts',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }],
    },
  };
}

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-e6-attempts-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('append-only stage attempts', () => {
  it('aggregates two executions while retaining each independent record', () => {
    const created = createRun(projectDir, 'attempt-ledger', 'name: attempt-ledger', ['work']);
    beginStageAttempt(projectDir, created.runId, 'work', 0, '2026-07-31T00:00:00.000Z');
    completeStageAttempt(projectDir, created.runId, 'work', 0, {
      exitCode: 1, duration_ms: 1000, completedAt: '2026-07-31T00:00:01.000Z',
      tokens_in: 10, tokens_out: 20, error: 'first failed', writes: ['src/a.ts'], writeAttribution: 'structured',
    });
    beginStageAttempt(projectDir, created.runId, 'work', 0, '2026-07-31T00:00:02.000Z');
    const final = completeStageAttempt(projectDir, created.runId, 'work', 0, {
      exitCode: 0, duration_ms: 3000, completedAt: '2026-07-31T00:00:05.000Z',
      tokens_in: 30, tokens_out: 40, writes: ['src/b.ts'], writeAttribution: 'structured',
    });

    expect(final.attempts).toHaveLength(2);
    expect(final.attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'complete']);
    expect(final).toMatchObject({
      status: 'complete', reruns: 1, duration_ms: 4000,
      tokens_in: 40, tokens_out: 60,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
    });
    expect(final.writes).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records gate fail → fix → pass as two gate attempts with cumulative time/tokens', async () => {
    const { config, yaml } = workflow();
    const created = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    let gateCalls = 0;

    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: '## What was done\n- fixed and verified', exitCode: 0, duration_ms: 1 };
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            '  - id: release_gate',
            '    role: qa',
            '    scope: []',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "evaluate the planned release"}',
            '    is_gate: true',
            '    task: verify release',
            '  - id: fix_release',
            '    role: repair',
            '    scope: [src/release.ts]',
            '    depends_on: [release_gate]',
            '    dependency_reasons: {release_gate: "repair only after an explicit release rejection"}',
            '    retry_to: [release_gate]',
            '    task: fix release',
          ].join('\n'));
          return { output: 'planned', exitCode: 0, duration_ms: 2000, tokens_out: 2 };
        }
        if (opts.stageId === 'release_gate') {
          gateCalls++;
          writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({
            pass: gateCalls > 1,
            reason: gateCalls > 1 ? 'fixed' : 'needs fix',
          }));
          return { output: `gate ${gateCalls}`, exitCode: 0, duration_ms: gateCalls === 1 ? 11_000 : 13_000, tokens_out: gateCalls === 1 ? 5 : 7 };
        }
        if (opts.stageId === 'fix_release') return { output: 'fixed', exitCode: 0, duration_ms: 17_000, tokens_out: 9 };
        return { output: 'unexpected', exitCode: 1, duration_ms: 1 };
      },
    };

    const finalState = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles(), created.runId, 'release task', true);
    const gate = finalState.stages.release_gate;
    expect(finalState.status).toBe('complete');
    expect(gate.attempts).toHaveLength(2);
    expect(gate.attempts?.map((attempt) => attempt.duration_ms)).toEqual([11_000, 13_000]);
    expect(gate).toMatchObject({ retries: 0, reruns: 1, duration_ms: 24_000, tokens_out: 12 });
    expect(finalState.stages.fix_release.attempts).toHaveLength(1);
    expect(finalState.stages.fix_release.reruns).toBe(0);

    const summary = readFileSync(join(runDir(projectDir, created.runId), 'summary.md'), 'utf-8');
    expect(summary).toContain('release_gate: complete — ran 2 times, 24s cumulative');
  });

  it('retains a failed technical retry between gate rejection and final pass', async () => {
    const { config, yaml } = workflow();
    const created = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    let gateCalls = 0;

    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: '## What was done\n- retained retry evidence', exitCode: 0, duration_ms: 1 };
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
            '    depends_on: [release_gate]',
            '    dependency_reasons: {release_gate: "repair only after an explicit release rejection"}',
            '    retry_to: [release_gate]',
            '    task: fix release',
          ].join('\n'));
          return { output: 'planned', exitCode: 0, duration_ms: 10 };
        }
        if (opts.stageId === 'fix_release') return { output: 'fixed', exitCode: 0, duration_ms: 200 };
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
        return { output: 'unexpected', exitCode: 1, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles(), created.runId, 'release task', true);
    const gate = final.stages.release_gate;
    expect(final.status).toBe('complete');
    expect(gate.attempts?.map((attempt) => attempt.status)).toEqual(['complete', 'failed', 'complete']);
    expect(gate.attempts?.map((attempt) => attempt.duration_ms)).toEqual([100, 200, 300]);
    expect(gate).toMatchObject({ duration_ms: 600, tokens_out: 6, retries: 1, reruns: 2 });
  });

  it('keeps top-level compatibility values equal to a single successful attempt', () => {
    const created = createRun(projectDir, 'single', 'name: single', ['one']);
    beginStageAttempt(projectDir, created.runId, 'one', 0, '2026-07-31T00:00:00.000Z');
    completeStageAttempt(projectDir, created.runId, 'one', 0, {
      exitCode: 0, duration_ms: 1234, completedAt: '2026-07-31T00:00:01.234Z',
      tokens_in: 12, tokens_out: 34, writeAttribution: 'structured', writes: [],
    });
    const status = readStageStatus(projectDir, created.runId, 'one');
    expect(status).toMatchObject({ status: 'complete', exitCode: 0, duration_ms: 1234, tokens_in: 12, tokens_out: 34, reruns: 0 });
    expect(status.attempts).toHaveLength(1);
  });
});
