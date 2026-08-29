import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { deriveRunTokenCost } from '../src/campaign-page.js';
import type { SupervisorConfig } from '../src/config.js';
import { startDashboard } from '../src/dashboard.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  runDir,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
} from '../src/store.js';
import { Supervisor, type SupervisorAssessment } from '../src/supervisor.js';
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
    config: {
      name,
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{
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

function waitForDashboard(child: ChildProcessWithoutNullStreams): Promise<{ port: number; output: string }> {
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

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
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

function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

describe('dashboard signal shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('releases the listening port and exits zero after the first %s', { timeout: 20_000 }, async (signal) => {
    const childHome = mkdtempSync(join(tmpdir(), 'flowcrew-p6-signal-home-'));
    const childProject = mkdtempSync(join(tmpdir(), 'flowcrew-p6-signal-project-'));
    const dashboardUrl = pathToFileURL(join(process.cwd(), 'src', 'dashboard.ts')).href;
    const source = `
      import { startDashboard } from ${JSON.stringify(dashboardUrl)};
      await startDashboard(process.env.P6_PROJECT_DIR, 0, { distDir: process.env.P6_DIST_DIR });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
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
      brief_revisions: null,
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
    state.supervise = false;
    state.stages.work = { status: 'complete', retries: 0, tokens_out: 24_055 };
    const cost = deriveRunTokenCost(state);
    console.info(`[P6_COST_ONE_SIDED] ${JSON.stringify(cost)}`);
    expect(cost).toEqual({
      tokens: 24_055,
      supervisorTokens: 0,
      complete: false,
      attemptEvidence: { known: 0, recordedUnknown: 0, unrecorded: 1 },
    });
  });

  it('keeps an absent supervisor ledger unknown unless the run explicitly disabled supervision', () => {
    const created = createRun(projectDir, 'p6-supervisor-cost', 'name: p6-supervisor-cost', ['work']);
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    state.stages.work = { status: 'skipped', retries: 0 };
    delete state.supervisor;
    delete state.supervise;
    const unknown = deriveRunTokenCost(state);
    state.supervise = false;
    const disabled = deriveRunTokenCost(state);
    console.info(`[P6_COST_SUPERVISOR] ${JSON.stringify({ unknown, disabled })}`);
    expect(unknown.complete).toBe(false);
    expect(disabled).toEqual({
      tokens: 0,
      supervisorTokens: 0,
      complete: true,
      attemptEvidence: { known: 0, recordedUnknown: 0, unrecorded: 0 },
    });
  });

  it('keeps usage from stages replaced by a later successful outer re-plan', { timeout: 15_000 }, async () => {
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
    const config: WorkflowConfig = {
      name: 'p6-replan-cost',
      defaults: { max_iterations: 2, max_retries: 0 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
      }],
    };
    const created = createRun(projectDir, config.name, yaml, ['plan']);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    initial.supervise = false;
    writeRunState(projectDir, created.runId, initial);
    let planCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: '## What was done\n- completed after a re-plan', exitCode: 0, duration_ms: 1 };
        if (opts.stageId === 'plan') {
          planCalls++;
          const suffix = planCalls === 1 ? 'one' : 'two';
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
            'stages:',
            `  - id: work_${suffix}`,
            '    role: coder',
            '    depends_on: [plan]',
            `    dependency_reasons: {plan: "execute iteration ${planCalls}"}`,
            `    task: execute iteration ${planCalls}`,
            `  - id: gate_${suffix}`,
            '    role: qa',
            `    depends_on: [work_${suffix}]`,
            `    dependency_reasons: {work_${suffix}: "verify iteration ${planCalls}"}`,
            '    is_gate: true',
            `    task: verify iteration ${planCalls}`,
          ].join('\n'));
          return { output: `plan ${planCalls}`, exitCode: 0, duration_ms: 1, tokens_in: 10, tokens_out: 1 };
        }
        if (opts.stageId === 'work_one') return { output: 'first work', exitCode: 0, duration_ms: 1, tokens_in: 100, tokens_out: 10 };
        if (opts.stageId === 'gate_one') {
          writeFileSync(join(opts.runDir, 'verdict_gate_one.json'), JSON.stringify({ pass: false, reason: 're-plan required' }));
          return { output: 'first gate rejected', exitCode: 0, duration_ms: 1, tokens_in: 20, tokens_out: 2 };
        }
        if (opts.stageId === 'work_two') return { output: 'second work', exitCode: 0, duration_ms: 1, tokens_in: 200, tokens_out: 20 };
        if (opts.stageId === 'gate_two') {
          writeFileSync(join(opts.runDir, 'verdict_gate_two.json'), JSON.stringify({ pass: true, reason: 'accepted' }));
          return { output: 'second gate passed', exitCode: 0, duration_ms: 1, tokens_in: 30, tokens_out: 3 };
        }
        return { output: 'unexpected', exitCode: 1, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'coder', 'qa'), created.runId, 're-plan cost fixture', true);
    const cost = deriveRunTokenCost(final);
    const observation = { status: final.status, stageIds: Object.keys(final.stages), planCalls, cost };
    console.info(`[P6_COST_REPLAN] ${JSON.stringify(observation)}`);
    expect(final.status).toBe('complete');
    expect(planCalls).toBe(2);
    expect(cost).toEqual({
      tokens: 407,
      supervisorTokens: 0,
      complete: true,
      attemptEvidence: { known: 6, recordedUnknown: 0, unrecorded: 0 },
    });
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
        if (opts.stageId === '_summary') return { output: '## What was done\n- verified ordering', exitCode: 0, duration_ms: 1 };
        if (opts.stageId === 'plan') {
          calls.push('plan');
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
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
            '    retry_to: [design_gate]',
            '    task: repair design',
            '  - id: build_product',
            '    role: coder',
            '    scope: [src/product.ts]',
            '    depends_on: [design_gate]',
            '    dependency_reasons: {design_gate: "build only from an accepted design"}',
            '    task: build product',
          ].join('\n'));
          return { output: 'planned', exitCode: 0, duration_ms: 1 };
        }
        if (opts.stageId === 'design_gate') {
          gateCalls++;
          const pass = gateCalls > 1;
          calls.push(`gate:${pass ? 'pass' : 'fail'}`);
          writeFileSync(join(opts.runDir, 'verdict_design_gate.json'), JSON.stringify({ pass, reason: pass ? 'accepted' : 'design rejected' }));
          return { output: pass ? 'accepted' : 'rejected', exitCode: 0, duration_ms: 1 };
        }
        if (opts.stageId === 'repair_design') {
          calls.push('repair');
          return { output: 'repaired', exitCode: 0, duration_ms: 1, writes: ['src/design.ts'], writeAttribution: 'structured' };
        }
        if (opts.stageId === 'build_product') {
          calls.push('downstream');
          return { output: 'built', exitCode: 0, duration_ms: 1, writes: ['src/product.ts'], writeAttribution: 'structured' };
        }
        return { output: 'unexpected', exitCode: 1, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'qa', 'repair', 'coder'), created.runId, 'gate ordering fixture', true);
    console.info(`[P6_BASELINE_45] ${JSON.stringify({ status: final.status, calls })}`);
    expect(final.status).toBe('complete');
    expect(calls).toEqual(['plan', 'gate:fail', 'repair', 'gate:pass', 'downstream']);
  });
});

interface ScopeRevisionRequest {
  version: 1;
  requestId: string;
  stageId: string;
  attemptIndex: number;
  requestedPaths: string[];
  reason: string;
}

interface ScopeRevisionDecision {
  accepted: boolean;
  raw: Record<string, unknown>;
  path: string;
}

function scopeDecision(stagePath: string, requestId: string): ScopeRevisionDecision | undefined {
  let files: string[] = [];
  try { files = readdirSync(stagePath); } catch { return undefined; }
  for (const file of files.sort()) {
    if (file === 'scope_revision_request.json' || !/scope.*\.json$/i.test(file)) continue;
    const path = join(stagePath, file);
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (raw.requestId !== undefined && raw.requestId !== requestId) continue;
      const decision = String(raw.decision ?? raw.status ?? '').toLowerCase();
      if (raw.accepted === true || decision === 'accepted' || decision === 'approved') return { accepted: true, raw, path };
      if (raw.accepted === false || decision === 'rejected' || decision === 'denied') return { accepted: false, raw, path };
    } catch { /* another process may still be completing an atomic write */ }
  }
  return undefined;
}

async function awaitScopeDecision(stagePath: string, requestId: string): Promise<ScopeRevisionDecision> {
  return waitForPathEvent(stagePath, () => scopeDecision(stagePath, requestId));
}

async function runScopeRevisionScenario(input: {
  requestedPath: string;
  reason: string;
  expectAcceptance: boolean;
  peerConflict?: boolean;
}) {
  const { config, yaml } = dynamicWorkflow(`p6-scope-${input.expectAcceptance ? 'accept' : 'reject'}`);
  const created = prepareRun(config, yaml);
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
  writeFileSync(join(projectDir, 'src', 'store.ts'), 'original\n');
  writeFileSync(join(projectDir, 'src', 'peer.ts'), 'peer-original\n');
  let gateCalls = 0;
  let observedDecision: ScopeRevisionDecision | undefined;
  let reportPeerStarted!: () => void;
  const peerStarted = new Promise<void>((resolvePeerStarted) => { reportPeerStarted = resolvePeerStarted; });
  let releasePeer!: () => void;
  const peerMayFinish = new Promise<void>((resolvePeer) => { releasePeer = resolvePeer; });
  const requestId = `scope-${input.expectAcceptance ? 'accept' : 'reject'}`;
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return { output: '## What was done\n- scope scenario', exitCode: 0, duration_ms: 1 };
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:',
          '  - id: scope_gate',
          '    role: qa',
          '    scope: []',
          '    depends_on: [plan]',
          '    dependency_reasons: {plan: "verify the repair"}',
          '    is_gate: true',
          '    task: verify repair',
          '  - id: repair_scope',
          '    role: repair',
          '    scope: [src/declared.ts]',
          '    retry_to: [scope_gate]',
          '    task: repair with a reasoned scope revision',
          ...(input.peerConflict ? [
            '  - id: peer_repair',
            '    role: repair',
            '    scope: [src/peer.ts]',
            '    retry_to: [scope_gate]',
            '    task: peer repair',
          ] : []),
        ].join('\n'));
        return { output: 'planned', exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === 'scope_gate') {
        gateCalls++;
        const pass = input.expectAcceptance && readFileSync(join(projectDir, 'src', 'store.ts'), 'utf-8').includes('audit fields');
        writeFileSync(join(opts.runDir, 'verdict_scope_gate.json'), JSON.stringify({ pass, reason: pass ? 'fixed' : 'still missing' }));
        return { output: `gate ${gateCalls}`, exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === 'peer_repair') {
        writeFileSync(join(projectDir, 'src', 'peer.ts'), 'peer-active\n');
        reportPeerStarted();
        await peerMayFinish;
        return { output: 'peer complete', exitCode: 0, duration_ms: 1, writes: ['src/peer.ts'], writeAttribution: 'structured' };
      }
      if (opts.stageId === 'repair_scope') {
        if (input.peerConflict) await peerStarted;
        const stagePath = join(opts.runDir, 'stages', opts.stageId);
        mkdirSync(stagePath, { recursive: true });
        const request: ScopeRevisionRequest = {
          version: 1,
          requestId,
          stageId: opts.stageId,
          attemptIndex: 1,
          requestedPaths: [input.requestedPath],
          reason: input.reason,
        };
        writeFileSync(join(stagePath, 'scope_revision_request.json'), JSON.stringify(request, null, 2));
        try {
          observedDecision = await awaitScopeDecision(stagePath, requestId);
        } finally {
          if (input.peerConflict) releasePeer();
        }
        if (observedDecision?.accepted && input.requestedPath === 'src/store.ts') {
          writeFileSync(join(projectDir, 'src', 'store.ts'), 'audit fields\n');
        }
        return {
          output: observedDecision ? `scope ${observedDecision.accepted ? 'accepted' : 'rejected'}` : 'scope decision missing',
          exitCode: input.expectAcceptance && !observedDecision?.accepted ? 1 : 0,
          duration_ms: 800,
          writes: observedDecision?.accepted && input.requestedPath === 'src/store.ts' ? ['src/store.ts'] : [],
          writeAttribution: 'structured',
        };
      }
      return { output: 'unexpected', exitCode: 1, duration_ms: 1 };
    },
  };
  const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'qa', 'repair'), created.runId, 'scope revision fixture', true);
  const diffPath = join(created.runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1', 'repair_diff.json');
  const diff = existsSync(diffPath) ? readFileSync(diffPath, 'utf-8') : '';
  return {
    final,
    observedDecision,
    diff,
    storeText: readFileSync(join(projectDir, 'src', 'store.ts'), 'utf-8'),
    peerText: readFileSync(join(projectDir, 'src', 'peer.ts'), 'utf-8'),
  };
}

describe('reasoned scope revision', () => {
  it('accepts a non-conflicting project-relative addition before the stage writes it and audits the reason', { timeout: 15_000 }, async () => {
    const reason = 'The gate requires durable audit fields in the authoritative store type.';
    const result = await runScopeRevisionScenario({ requestedPath: 'src/store.ts', reason, expectAcceptance: true });
    const observation = {
      status: result.final.status,
      decision: result.observedDecision?.raw ?? null,
      storeText: result.storeText.trim(),
      diffHasPath: result.diff.includes('src/store.ts'),
      diffHasReason: result.diff.includes(reason),
      diffHasAcceptedDecision: /accepted|approved/i.test(result.diff),
    };
    console.info(`[P6_BASELINE_43_ACCEPT] ${JSON.stringify(observation)}`);
    expect(observation).toMatchObject({
      status: 'complete',
      decision: { accepted: true },
      storeText: 'audit fields',
      diffHasPath: true,
      diffHasReason: true,
      diffHasAcceptedDecision: true,
    });
  });

  it.each([
    { requestedPath: 'src/store.ts', reason: '', label: 'empty reason' },
    { requestedPath: '../outside.ts', reason: 'write outside the project', label: 'path traversal' },
  ])('rejects $label before any newly requested path is written', { timeout: 15_000 }, async ({ requestedPath, reason }) => {
    const result = await runScopeRevisionScenario({ requestedPath, reason, expectAcceptance: false });
    const observation = {
      decision: result.observedDecision?.raw ?? null,
      storeUnchanged: result.storeText === 'original\n',
      diffHasRejectedDecision: /rejected|denied/i.test(result.diff),
      diffHasRequestedPath: result.diff.includes(requestedPath),
    };
    console.info(`[P6_BASELINE_43_REJECT] ${JSON.stringify({ requestedPath, ...observation })}`);
    expect(observation).toMatchObject({
      decision: { accepted: false },
      storeUnchanged: true,
      diffHasRejectedDecision: true,
      diffHasRequestedPath: true,
    });
  });

  it('rejects an addition that overlaps a still-running repair peer', { timeout: 15_000 }, async () => {
    const result = await runScopeRevisionScenario({
      requestedPath: 'src/peer.ts',
      reason: 'The repair would otherwise duplicate the peer type change.',
      expectAcceptance: false,
      peerConflict: true,
    });
    const observation = {
      decision: result.observedDecision?.raw ?? null,
      peerRan: result.peerText === 'peer-active\n',
      diffHasConflict: /conflict|overlap|running peer/i.test(result.diff),
    };
    console.info(`[P6_BASELINE_43_CONFLICT] ${JSON.stringify(observation)}`);
    expect(observation).toMatchObject({
      decision: { accepted: false },
      peerRan: true,
      diffHasConflict: true,
    });
  });
});

const supervisorConfig: SupervisorConfig = {
  enabled: true,
  adapter: 'scripted',
  model: 'test',
  reasoningEffort: 'low',
  pollIntervalMs: 30_000,
  routineAssessmentIntervalMs: 180_000,
  cooldownAfterActionMs: 0,
  maxAssessmentsPerIteration: 20,
  tailBytes: 16_384,
  minDeltaBytes: 4096,
  stuckThresholdMs: 60_000,
};

type SupervisorActionFixture = {
  timestamp: string;
  tick: number;
  assessment: SupervisorAssessment;
  runningStages: string[];
  targetAttemptIndex: number;
  source: 'supervisor' | 'operator';
};

function runningSupervisorFixture(attemptIndex = 2) {
  const created = createRun(projectDir, 'p6-supervisor', 'name: p6-supervisor', ['review_design']);
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const previousStartedAt = new Date(Date.now() - 120_000).toISOString();
  const status = {
    status: 'running' as const,
    retries: 0,
    startedAt: previousStartedAt,
    attempts: [
      { index: 1, startedAt: previousStartedAt, completedAt: startedAt, status: 'failed' as const, duration_ms: 119_000, exitCode: 1 },
      { index: attemptIndex, startedAt, status: 'running' as const },
    ],
  };
  const state = readRunState(projectDir, created.runId);
  state.status = 'running';
  state.stages.review_design = status;
  writeRunState(projectDir, created.runId, state);
  writeStageStatus(projectDir, created.runId, 'review_design', status);
  mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
  const adapter: Adapter = { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) };
  const supervisor = new Supervisor(projectDir, created.runId, adapter, supervisorConfig, 'P6 supervisor fixture');
  const internals = supervisor as unknown as {
    act(assessment: SupervisorAssessment): Promise<SupervisorAssessment>;
    actions: SupervisorActionFixture[];
    stageLastProgressMs: Record<string, number>;
  };
  internals.stageLastProgressMs = { review_design: Date.now() };
  return { created, internals };
}

function guideAction(tick: number, targetAttemptIndex: number, source: 'supervisor' | 'operator'): SupervisorActionFixture {
  return {
    timestamp: new Date().toISOString(),
    tick,
    assessment: {
      verdict: 'GUIDE',
      targetStage: 'review_design',
      reason: source === 'operator' ? 'operator supplied an additional requirement' : 'same concrete wrong direction',
      guidance: source === 'operator' ? 'also include the new evidence' : 'use the required evidence path',
    },
    runningStages: ['review_design'],
    targetAttemptIndex,
    source,
  };
}

describe('attempt- and source-scoped supervisor guidance', () => {
  it('does not let two GUIDE decisions from attempt 1 authorize aborting attempt 2', async () => {
    const { created, internals } = runningSupervisorFixture(2);
    internals.actions = [guideAction(1, 1, 'supervisor'), guideAction(2, 1, 'supervisor')];
    const result = await internals.act({
      verdict: 'ABORT', targetStage: 'review_design',
      reason: 'the same wrong direction continues', guidance: null,
    });
    const signalExists = existsSync(join(created.runDirPath, 'signals', 'abort_review_design.json'));
    console.info(`[P6_BASELINE_46_ATTEMPT] ${JSON.stringify({ verdict: result.verdict, reason: result.reason, signalExists })}`);
    expect({ verdict: result.verdict, signalExists }).toEqual({ verdict: 'WAIT', signalExists: false });
  });

  it('does not count operator additions as supervisor wrong-direction corrections', async () => {
    const { created, internals } = runningSupervisorFixture(2);
    internals.actions = [guideAction(1, 2, 'operator'), guideAction(2, 2, 'operator')];
    const result = await internals.act({
      verdict: 'ABORT', targetStage: 'review_design',
      reason: 'the same wrong direction continues', guidance: null,
    });
    const signalExists = existsSync(join(created.runDirPath, 'signals', 'abort_review_design.json'));
    console.info(`[P6_BASELINE_46_OPERATOR] ${JSON.stringify({ verdict: result.verdict, reason: result.reason, signalExists })}`);
    expect({ verdict: result.verdict, signalExists }).toEqual({ verdict: 'WAIT', signalExists: false });
  });

  it('still aborts after two supervisor corrections in the current attempt', async () => {
    const { created, internals } = runningSupervisorFixture(2);
    internals.actions = [guideAction(1, 2, 'supervisor'), guideAction(2, 2, 'supervisor')];
    const result = await internals.act({
      verdict: 'ABORT', targetStage: 'review_design',
      reason: 'the same wrong direction continues', guidance: null,
    });
    const signalPath = join(created.runDirPath, 'signals', 'abort_review_design.json');
    const signal = existsSync(signalPath) ? JSON.parse(readFileSync(signalPath, 'utf-8')) as { attemptIndex?: number } : null;
    expect({ verdict: result.verdict, signalAttempt: signal?.attemptIndex }).toEqual({ verdict: 'ABORT', signalAttempt: 2 });
  });
});
