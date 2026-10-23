import './test-support/policy-runtime.js';
import { atomicWrite } from '../src/engine-fs.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { portCanBind } from './test-support/engine-fixtures.js';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { deriveRunTokenCost } from '../src/campaign-page.js';
import { startDashboard } from '../src/dashboard.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  runDir,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
} from '../src/store.js';
import { readRunEvents, recordRunEvent } from '../src/run-events.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

let projectDir: string;
let isolatedFcHome: string;
let previousFcHome: string;

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-p6-engine-project-'));
  isolatedFcHome = mkdtempSync(join(tmpdir(), 'flowcrew-p6-engine-home-'));
  setFcGlobalDir(isolatedFcHome);
});

afterEach(() => {
  setFcGlobalDir(previousFcHome);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedFcHome, { recursive: true, force: true });
});

function writeRoles(...roles: string[]): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of roles) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: P6 fixture role',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function dynamicWorkflow(name: string): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    `name: ${name}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 1',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {description: '',
      name,
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [],
        id: 'plan', role: 'planner', depends_on: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
      }],
    },
  };
}

function prepareRun(config: WorkflowConfig, yaml: string) {
  const created = createRun(projectDir, config.name, yaml, ['plan']);
  writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  writeRunState(projectDir, created.runId, state);
  return created;
}

describe('current-attempt truth', () => {
  it('keeps the running second attempt identical in stage status, run.json, and the run API', async () => {
    const created = createRun(projectDir, 'p6-attempt-truth', 'name: p6-attempt-truth', ['work']);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const firstStartedAt = '2026-08-02T18:00:00.000Z';
    const secondStartedAt = '2026-08-02T19:30:00.000Z';
    beginStageAttempt(projectDir, created.runId, 'work', 0, firstStartedAt);
    const first = completeStageAttempt(projectDir, created.runId, 'work', 0, {
      exitCode: 1,
      duration_ms: 60_000,
      completedAt: '2026-08-02T18:01:00.000Z',
      error: 'first attempt rejected',
    });
    const beforeSecond = readRunState(projectDir, created.runId);
    beforeSecond.status = 'running';
    beforeSecond.stages.work = first;
    writeRunState(projectDir, created.runId, beforeSecond);

    beginStageAttempt(projectDir, created.runId, 'work', 0, secondStartedAt);
    const authoritative = readStageStatus(projectDir, created.runId, 'work');
    const persisted = readRunState(projectDir, created.runId).stages.work;
    const app = await startDashboard(projectDir, 0, { distDir: join(projectDir, 'missing-dist') });
    let apiStage: { startedAt?: string; attempts?: Array<{ index: number; startedAt: string; status: string }> } | undefined;
    try {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { stages: Array<{ id: string; startedAt?: string; attempts?: Array<{ index: number; startedAt: string; status: string }> }> };
      apiStage = body.stages.find((stage) => stage.id === 'work');
    } finally {
      await app.close();
    }

    const observation = {
      authoritativeTopLevelStartedAt: authoritative.startedAt,
      authoritativeCurrent: authoritative.attempts?.at(-1),
      runJsonCurrent: persisted.attempts?.at(-1),
      apiCurrent: apiStage?.attempts?.at(-1),
    };
    console.info(`[P6_BASELINE_42] ${JSON.stringify(observation)}`);
    expect(observation).toMatchObject({
      authoritativeTopLevelStartedAt: firstStartedAt,
      authoritativeCurrent: { index: 2, startedAt: secondStartedAt, status: 'running' },
      runJsonCurrent: { index: 2, startedAt: secondStartedAt, status: 'running' },
      apiCurrent: { index: 2, startedAt: secondStartedAt, status: 'running' },
    });
  });
});

function waitForDashboard(child: ChildProcessByStdio<null, Readable, Readable>): Promise<{ port: number; output: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`dashboard did not announce a port within 10s: ${output.slice(-2_000)}`));
    }, 10_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Dashboard running at http:\/\/localhost:(\d+)\//.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ port: Number(match[1]), output });
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`dashboard exited before listening (code=${code}, signal=${signal}): ${output.slice(-2_000)}`));
    });
  });
}

function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}



describe('dashboard signal shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('releases the listening port and exits zero after the first %s', { timeout: 20_000 }, async (signal) => {
    const childHome = mkdtempSync(join(tmpdir(), 'flowcrew-p6-signal-home-'));
    const childProject = mkdtempSync(join(tmpdir(), 'flowcrew-p6-signal-project-'));
    const dashboardUrl = pathToFileURL(join(process.cwd(), 'dist', 'dashboard.js')).href;
    const listenerPolicyUrl = pathToFileURL(join(process.cwd(), 'spec', 'test-support', 'loopback-listen.mjs')).href;
    const source = `
      import { installLoopbackListenFence } from ${JSON.stringify(listenerPolicyUrl)};
      installLoopbackListenFence('engine-truthfulness.test.ts');
      import { startDashboard } from ${JSON.stringify(dashboardUrl)};
      await startDashboard(process.env.P6_PROJECT_DIR, 0, { distDir: process.env.P6_DIST_DIR });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: childHome,
        FC_HOME: join(childHome, '.fc'),
        P6_PROJECT_DIR: childProject,
        P6_DIST_DIR: join(process.cwd(), 'dist'),
        FLOWCREW_STARTUP_RECOVERY_LIMIT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const listening = await waitForDashboard(child);
      child.kill(signal);
      let exit = await waitForExit(child, 2_000);
      const exitAfterFirstSignal = exit !== null;
      const releasedAfterFirstSignal = await portCanBind(listening.port);
      let secondSignalSent = false;
      if (!exit) {
        secondSignalSent = true;
        child.kill(signal);
        exit = await waitForExit(child, 2_000);
      }
      if (!exit) {
        child.kill('SIGKILL');
        exit = await waitForExit(child, 2_000);
      }
      const releasedAfterCleanup = await portCanBind(listening.port);
      const observation = {
        firstSignal: signal,
        port: listening.port,
        exitAfterFirstSignal,
        secondSignalSent,
        exit,
        releasedAfterFirstSignal,
        releasedAfterCleanup,
      };
      console.info(`[P6_BASELINE_44] ${JSON.stringify(observation)}`);
      expect(observation).toMatchObject({
        exitAfterFirstSignal: true,
        exit: { code: 0, signal: null },
        releasedAfterFirstSignal: true,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 2_000);
      }
      rmSync(childHome, { recursive: true, force: true });
      rmSync(childProject, { recursive: true, force: true });
    }
  });
});

describe('inbox stale truth', () => {
  it('lists only stale campaigns whose underlying run still exists', async () => {
    const present = createRun(projectDir, 'p6-present-stale-run', 'name: p6-present-stale-run', ['work']);
    const missingRunId = 'cleaned-run-fixture';
    const staleCampaign = (id: string, staleRunId: string) => ({
      id,
      name: id,
      status: 'stale',
      badges: [],
      metric: null,
      iterations: null,
      phases: null,
      runs: [],
      runs_total: 1,
      staleRunId,
    });
    const app = await startDashboard(projectDir, 0, {
      distDir: join(projectDir, 'missing-dist'),
      listTasks: async () => [],
      inboxSources: {
        listApprovals: () => [],
        listCampaigns: () => [
          staleCampaign('cleaned-campaign', missingRunId),
          staleCampaign('actionable-campaign', present.runId),
        ],
        readPendingReviews: () => [],
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
      const body = response.json() as { stale: { items: Array<{ id: string; staleRunId?: string }> } };
      const observation = {
        missingRunJson: !existsSync(join(runDir(projectDir, missingRunId), 'run.json')),
        staleItems: body.stale.items,
      };
      console.info(`[P6_BASELINE_STALE] ${JSON.stringify(observation)}`);
      expect(response.statusCode).toBe(200);
      expect(observation.missingRunJson).toBe(true);
      expect(body.stale.items).toEqual([
        expect.objectContaining({ id: 'actionable-campaign', staleRunId: present.runId }),
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('campaign cost honesty', () => {
  it('does not turn historical one-sided token telemetry into a complete total', () => {
    const state = readRunState(projectDir, createRun(projectDir, 'p6-partial-cost', 'name: p6-partial-cost', ['work']).runId);
    state.status = 'complete';
    state.stages.work = { status: 'complete', retries: 0, tokens_out: 24_055 };
    const cost = deriveRunTokenCost(state);
    console.info(`[P6_COST_ONE_SIDED] ${JSON.stringify(cost)}`);
    expect(cost).toEqual({
      tokens: 24_055,
      complete: false,
      attemptEvidence: { known: 0, recordedUnknown: 0, unrecorded: 1 },
    });
  });

  it('keeps usage from stages replaced by a deliberate next phase', { timeout: 15_000 }, async () => {
    const yaml = [
      'name: p6-replan-cost',
      'defaults:',
      '  max_iterations: 2',
      '  max_retries: 0',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
    ].join('\n');
    const config: WorkflowConfig = {description: '',
      name: 'p6-replan-cost',
      defaults: { max_iterations: 2, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [],
        id: 'plan', role: 'planner', depends_on: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
      }],
    };
    const created = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    let planCalls = 0;
    const planPrompts: string[] = [];
    const adapter: Adapter = {
      async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return fixtureResult({ output: '## What was done\n- completed after a re-plan', exitCode: 0, duration_ms: 1 }, opts);
        if (opts.stageId === 'plan') {
          planCalls++;
          planPrompts.push(prompt);
          const suffix = planCalls === 1 ? 'one' : 'two';
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
            'stages:',
            `  - id: work_${suffix}`,
            '    role: coder',
            '    depends_on: [plan]',
            '    scope: []',
            `    dependency_reasons: {plan: "execute iteration ${planCalls}"}`,
            `    task: execute iteration ${planCalls}`,
            `  - id: gate_${suffix}`,
            '    role: qa',
            `    depends_on: [work_${suffix}]`,
            '    scope: []',
            `    dependency_reasons: {work_${suffix}: "verify iteration ${planCalls}"}`,
            '    is_gate: true',
            `    task: verify iteration ${planCalls}`,
            `  - id: repair_${suffix}`,
            '    role: coder',
            `    depends_on: [gate_${suffix}]`,
            '    scope: []',
            `    dependency_reasons: {gate_${suffix}: "repair only an explicit rejection"}`,
            `    retry_to: [gate_${suffix}]`,
            '    task: repair the rejected iteration',
          ].join('\n')));
          return fixtureResult({ output: `plan ${planCalls}`, exitCode: 0, duration_ms: 1, tokens_in: 10, tokens_out: 1 }, opts);
        }
        if (opts.stageId === 'work_one') {
          const signalDir = join(opts.runDir, 'signals');
          mkdirSync(signalDir, { recursive: true });
          const reason = 'recorded corpus text was mistaken for the stage direction';
          const signalTimestamp = new Date().toISOString();
          atomicWrite(join(signalDir, 'replan.json'), JSON.stringify({ reason, timestamp: signalTimestamp }));
          atomicWrite(join(opts.runDir, 'supervisor_state.json'), JSON.stringify({ actions: [{
            tick: 1,
            timestamp: new Date(Date.parse(signalTimestamp) + 1).toISOString(),
            verdict: 'REPLAN',
            targetStage: 'work_one',
            targetAttemptIndex: opts.attemptIndex,
            directionEvidence: {
              attemptIndex: opts.attemptIndex,
              attemptStartedAt: opts.attemptStartedAt,
            },
            reason,
          }] }));
          return fixtureResult({ output: 'first work', exitCode: 0, duration_ms: 1, tokens_in: 100, tokens_out: 10 }, opts);
        }
        if (opts.stageId === 'gate_one') {
          writeFileSync(join(opts.runDir, 'fixture_verdict_gate_one.json'), JSON.stringify({ pass: true, reason: 'phase accepted', phaseComplete: true, nextPhase: 'phase two' }));
          return fixtureResult({ output: 'first gate rejected', exitCode: 0, duration_ms: 1, tokens_in: 20, tokens_out: 2 }, opts);
        }
        if (opts.stageId === 'work_two') return fixtureResult({ output: 'second work', exitCode: 0, duration_ms: 1, tokens_in: 200, tokens_out: 20 }, opts);
        if (opts.stageId === 'gate_two') {
          writeFileSync(join(opts.runDir, 'fixture_verdict_gate_two.json'), JSON.stringify({ pass: true, reason: 'accepted' }));
          return fixtureResult({ output: 'second gate passed', exitCode: 0, duration_ms: 1, tokens_in: 30, tokens_out: 3 }, opts);
        }
        return fixtureResult({ output: 'unexpected', exitCode: 1, duration_ms: 1 }, opts);
      },
    };

    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'coder', 'qa'), created.runId, 're-plan cost fixture', true);
    const cost = deriveRunTokenCost(final);
    const replanEvents = readRunEvents(projectDir, created.runId).filter((event) => event.type === 'supervisor_replan');
    const observation = { status: final.status, stageIds: Object.keys(final.stages), planCalls, cost, replanEvents };
    console.info(`[P6_COST_REPLAN] ${JSON.stringify(observation)}`);
    expect(final.status).toBe('complete');
    expect(planCalls).toBe(2);
    expect(planPrompts[1]).not.toContain('PIVOT REQUIRED');
    expect(replanEvents).toEqual([]);
    expect(cost).toEqual({
      tokens: 407,
      complete: false,
      attemptEvidence: { known: 6, recordedUnknown: 0, unrecorded: 2 },
    });
    const unexecuted = [final.stages.repair_two, final.stageEvidence!.find(entry => entry.stageId === 'repair_one')!.status];
    for (const stage of unexecuted) {
      expect(stage.status).toBe('skipped');
      expect(stage.attempts ?? []).toHaveLength(0);
    }
    expect(final.stageEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'work_one', status: expect.objectContaining({ tokens_in: 100, tokens_out: 10 }) }),
      expect.objectContaining({ stageId: 'gate_one', status: expect.objectContaining({ tokens_in: 20, tokens_out: 2 }) }),
    ]));
    expect(final.retiredStageUsage ?? []).toHaveLength(0);
  });
});

describe('gate-aware DAG ordering', () => {
  it('does not run an ordinary dependent until a rejected gate has been repaired and passed', async () => {
    const { config, yaml } = dynamicWorkflow('p6-gate-order');
    const created = prepareRun(config, yaml);
    const calls: string[] = [];
    let gateCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return fixtureResult({ output: '## What was done\n- verified ordering', exitCode: 0, duration_ms: 1 }, opts);
        if (opts.stageId === 'plan') {
          calls.push('plan');
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
            'stages:',
            '  - id: design_gate',
            '    role: qa',
            '    scope: []',
            '    depends_on: [plan]',
            '    dependency_reasons: {plan: "review the design"}',
            '    is_gate: true',
            '    task: review design',
            '  - id: repair_design',
            '    role: repair',
            '    scope: [src/design.ts]',
            '    depends_on: [design_gate]',
            '    dependency_reasons: {design_gate: "repair only after an explicit design rejection"}',
            '    retry_to: [design_gate]',
            '    task: repair design',
            '  - id: build_product',
            '    role: coder',
            '    scope: [src/product.ts]',
            '    depends_on: [design_gate]',
            '    dependency_reasons: {design_gate: "build only from an accepted design"}',
            '    task: build product',
          ].join('\n')));
          return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 1 }, opts);
        }
        if (opts.stageId === 'design_gate') {
          gateCalls++;
          const pass = gateCalls > 1;
          calls.push(`gate:${pass ? 'pass' : 'fail'}`);
          writeFileSync(join(opts.runDir, 'fixture_verdict_design_gate.json'), JSON.stringify({ pass, reason: pass ? 'accepted' : 'design rejected' }));
          return fixtureResult({ output: pass ? 'accepted' : 'rejected', exitCode: 0, duration_ms: 1 }, opts);
        }
        if (opts.stageId === 'repair_design') {
          calls.push('repair');
          return fixtureResult({ output: 'repaired', exitCode: 0, duration_ms: 1, writes: ['src/design.ts'], writeAttribution: 'structured' }, opts);
        }
        if (opts.stageId === 'build_product') {
          calls.push('downstream');
          return fixtureResult({ output: 'built', exitCode: 0, duration_ms: 1, writes: ['src/product.ts'], writeAttribution: 'structured' }, opts);
        }
        return fixtureResult({ output: 'unexpected', exitCode: 1, duration_ms: 1 }, opts);
      },
    };

    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'qa', 'repair', 'coder'), created.runId, 'gate ordering fixture', true);
    console.info(`[P6_BASELINE_45] ${JSON.stringify({ status: final.status, calls })}`);
    expect(final.status).toBe('complete');
    expect(calls).toEqual(['plan', 'gate:fail', 'repair', 'gate:pass', 'downstream']);
  });
});
