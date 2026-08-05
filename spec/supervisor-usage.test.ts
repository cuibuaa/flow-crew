import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import type { SupervisorConfig } from '../src/config.js';
import { startDashboard } from '../src/dashboard.js';
import { generateRunSummary } from '../src/run-summary.js';
import { createRun, readRunState, runDir, writeRunState } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { readTraceEvents } from '../src/trace.js';

let projectDir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-e6-supervisor-usage-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

describe('supervisor cost visibility', () => {
  it('counts success, non-zero, and unparseable calls in trace, run state, summary, and API', async () => {
    const yaml = 'name: supervisor-usage\nstages:\n  - id: work\n    role: coder\n';
    const created = createRun(projectDir, 'supervisor-usage', yaml, ['work']);
    const state = readRunState(projectDir, created.runId);
    state.stages.work = { status: 'running', retries: 0, startedAt: new Date().toISOString() };
    writeRunState(projectDir, created.runId, state);
    const outputs: RunResult[] = [
      { output: 'not json', exitCode: 0, duration_ms: 10, tokens_in: 100, tokens_out: 10 },
      { output: '{"verdict":"WAIT","target_stage":null,"reason":"progress","guidance":null}', exitCode: 0, duration_ms: 20, tokens_in: 200, tokens_out: 20 },
      { output: 'adapter failed', exitCode: 2, duration_ms: 30, tokens_in: 300, tokens_out: 30 },
    ];
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        expect(opts.stageId).toBe('_supervisor');
        return outputs.shift()!;
      },
    };
    const config: SupervisorConfig = {
      enabled: true,
      adapter: 'mock',
      model: 'default',
      reasoningEffort: 'low',
      pollIntervalMs: 100_000,
      routineAssessmentIntervalMs: 180_000,
      cooldownAfterActionMs: 0,
      maxAssessmentsPerIteration: 20,
      tailBytes: 16_384,
      minDeltaBytes: 4096,
      stuckThresholdMs: 600_000,
    };
    const supervisor = new Supervisor(projectDir, created.runId, adapter, config, 'test supervisor accounting');
    supervisor.start();
    const tick = () => (supervisor as unknown as { tick(): Promise<void> }).tick();

    await tick(); // initial stage transition -> unparseable call
    writeFileSync(join(runDir(projectDir, created.runId), 'user_input.md'), 'check the evidence', 'utf-8');
    await tick(); // user-input anomaly -> valid WAIT
    const transitioned = readRunState(projectDir, created.runId);
    transitioned.stages.work.status = 'failed';
    transitioned.stages.work.completedAt = new Date().toISOString();
    writeRunState(projectDir, created.runId, transitioned);
    await tick(); // stage transition -> non-zero call

    // Reproduce the scheduler race that existed before E6: a stale scheduler
    // write can temporarily omit supervisor usage, and summary generation runs
    // just before Supervisor.stop() in the scheduler's finally block.
    const stale = readRunState(projectDir, created.runId);
    stale.supervisor = undefined;
    stale.status = 'complete';
    stale.completedAt = new Date().toISOString();
    writeRunState(projectDir, created.runId, stale);
    const summaryAdapter: Adapter = {
      run: async () => ({ output: '## What was done\n- accounted supervisor cost', exitCode: 0, duration_ms: 1 }),
    };
    await generateRunSummary(projectDir, created.runId, summaryAdapter);
    supervisor.stop();

    const accounted = readRunState(projectDir, created.runId);
    expect(accounted.supervisor).toMatchObject({
      status: 'complete', calls: 3, tokens_in: 600, tokens_out: 60, duration_ms: 60,
    });
    expect(accounted.supervisor?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'complete', 'failed']);
    expect(readTraceEvents(projectDir, created.runId, '_supervisor')).toHaveLength(3);
    const statusPath = join(runDir(projectDir, created.runId), 'stages', '_supervisor', 'status.json');
    expect(existsSync(statusPath)).toBe(true);
    expect(JSON.parse(readFileSync(statusPath, 'utf-8')).calls).toBe(3);

    const summary = readFileSync(join(runDir(projectDir, created.runId), 'summary.md'), 'utf-8');
    expect(summary).toContain('_supervisor: 3 calls, 0s cumulative, 660 tokens total (600 in + 60 out)');

    app = await startDashboard(projectDir, 0);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.supervisor).toMatchObject({ calls: 3, tokens_in: 600, tokens_out: 60 });
    expect(body.supervisor.tokens_in + body.supervisor.tokens_out).toBe(660);
    expect(body.stages.find((stage: { id: string }) => stage.id === '_supervisor')).toMatchObject({
      role: 'supervisor', attempts: expect.any(Array), calls: 3,
    });
  });
});
