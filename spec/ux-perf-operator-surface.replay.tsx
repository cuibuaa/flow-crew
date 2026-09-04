// @vitest-environment jsdom

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdShipPreflightWithDeps } from '../src/cli-ship-preflight.js';
import { startRpcServer, type RpcResponse } from '../src/orchestrator-rpc.js';
import { AttemptDeadlineController } from '../src/attempt-deadline.js';
import { runStage } from '../src/worker.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { runValidationCommand } from '../src/project-validation.js';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import RunDetail from '../ui/src/components/RunDetail';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = import.meta.resolve('tsx');
let root: string;
let fcHome: string;
let project: string;
let server: Server | undefined;
const originalFcGlobal = fcGlobalDir();

class Capture {
  stream = new PassThrough();
  error = new PassThrough();
  private chunks: Buffer[] = [];
  private errors: Buffer[] = [];

  constructor() {
    this.stream.on('data', (chunk) => this.chunks.push(Buffer.from(chunk)));
    this.error.on('data', (chunk) => this.errors.push(Buffer.from(chunk)));
  }

  text(): string { return Buffer.concat(this.chunks).toString('utf-8'); }
  errorText(): string { return Buffer.concat(this.errors).toString('utf-8'); }
}

function runCli(cliArgs: string[], cwd = project) {
  return spawnSync(
    process.execPath,
    ['--import', tsxLoader, join(repositoryRoot, 'src', 'cli.ts'), ...cliArgs],
    {
      cwd,
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        FC_HOME: fcHome,
        PROJECT_DIR: '',
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
}

function runCliAsync(cliArgs: string[], cwd = project): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, join(repositoryRoot, 'src', 'cli.ts'), ...cliArgs], {
      cwd,
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        FC_HOME: fcHome,
        PROJECT_DIR: '',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveChild({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveChild({ status, stdout, stderr });
    });
  });
}

function followGuidanceEvent(runDirectory: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, [
      '--import', tsxLoader, join(repositoryRoot, 'src', 'cli.ts'),
      'events', '--run', 'live-run', '--stage', 'implement', '--type', 'guidance_written', '--json', '--follow',
    ], {
      cwd: project,
      env: { ...process.env, HOME: join(root, 'home'), FC_HOME: fcHome, PROJECT_DIR: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const appendTimer = setTimeout(() => appendFileSync(join(runDirectory, 'events.jsonl'), `${JSON.stringify({
      type: 'guidance_written',
      runId: 'live-run',
      timestamp: '2026-09-03T10:01:45.000Z',
      stageId: 'implement',
      attemptIndex: 2,
      detail: 'inspect the immutable manifest',
    })}\n`, 'utf-8'), 750);
    const hardTimeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('inspect the immutable manifest')) child.kill('SIGINT');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const finish = (status: number | null, extraError = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(appendTimer);
      clearTimeout(hardTimeout);
      resolveChild({ status, stdout, stderr: `${stderr}${extraError}` });
    };
    child.once('error', (error) => finish(null, error.message));
    child.once('close', (status) => finish(status));
  });
}

function writeRun(id: string, status: 'running' | 'complete', mtimeMs: number): string {
  const runDirectory = join(fcHome, 'runs', id);
  mkdirSync(join(runDirectory, 'stages', 'implement'), { recursive: true });
  const startedAt = '2026-09-03T10:00:00.000Z';
  const runJson = join(runDirectory, 'run.json');
  writeFileSync(runJson, JSON.stringify({
    runId: id,
    projectDir: resolve(project),
    workflowName: 'fixture',
    taskDescription: `# ${status === 'running' ? 'Live operator fixture' : 'Finished operator fixture'}`,
    status,
    startedAt,
    ...(status === 'complete' ? { completedAt: '2026-09-03T10:02:00.000Z' } : {}),
    currentIteration: 1,
    maxIterations: 2,
    stages: {
      implement: status === 'running'
        ? { status: 'running', retries: 1, attempts: [{ index: 2, status: 'running', startedAt: '2026-09-03T10:01:00.000Z' }] }
        : { status: 'complete', retries: 0, duration_ms: 120_000, attempts: [{ index: 1, status: 'complete', startedAt, completedAt: '2026-09-03T10:02:00.000Z' }] },
    },
  }), 'utf-8');
  writeFileSync(join(runDirectory, 'events.jsonl'), `${JSON.stringify(status === 'running' ? {
    type: 'admission_rejected',
    runId: id,
    timestamp: '2026-09-03T10:01:30.000Z',
    stageId: 'implement',
    attemptIndex: 2,
    detail: 'the proposal omitted a declared producer',
  } : {
    type: 'run_status_changed',
    runId: id,
    timestamp: '2026-09-03T10:02:00.000Z',
    runStatus: 'complete',
    detail: 'all declared gates passed',
  })}\n`, 'utf-8');
  const timestamp = new Date(mtimeMs);
  utimesSync(runJson, timestamp, timestamp);
  return runDirectory;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-operator-surface-'));
  fcHome = join(root, 'state');
  project = join(root, 'project');
  for (const path of [fcHome, project, join(root, 'home')]) mkdirSync(path, { recursive: true });
  setFcGlobalDir(fcHome);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  server = undefined;
  setFcGlobalDir(originalFcGlobal);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bounded task and status projections', () => {
  it('unchanged-base seam: black-box task show gives live context while raw ticks remain opt-in', async () => {
    const socket = join(root, 'daemon.sock');
    const hugeTick = JSON.stringify({ raw: 'x'.repeat(40_000) });
    const requestedRawFlags: Array<boolean | undefined> = [];
    server = await startRpcServer(socket, (request): RpcResponse => {
      if (request.cmd !== 'show') return { error: 'unexpected request' };
      requestedRawFlags.push(request.raw);
      const live = request.id === 1;
      return {
        task: {
          id: request.id,
          name: live ? 'Live task' : 'Finished task',
          kind: 'quick',
          brief_text: 'fixture',
          projectDir: project,
          systemd_unit: `fixture-${request.id}.service`,
          status: live ? 'running' : 'complete',
          attempt: live ? 2 : 1,
          max_retries: 3,
          created_at: '2026-09-03T10:00:00.000Z',
          tick_log_path: join(root, 'tick.jsonl'),
          run_id: live ? 'live-run' : 'finished-run',
          operational: {
            version: 1,
            runId: live ? 'live-run' : 'finished-run',
            projectDir: project,
            runStatus: live ? 'running' : 'complete',
            runElapsedMs: live ? 90_000 : 120_000,
            activeStages: live ? [{ id: 'implement', status: 'running', execution: 2, elapsedMs: 30_000 }] : [],
            latestReason: { type: live ? 'admission_rejected' : 'run_status_changed', detail: live ? 'missing producer' : 'all gates passed' },
            ...(live ? { lastRejection: { type: 'admission_rejected', detail: 'missing producer' } } : {}),
            pendingScope: [],
            sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
          },
        },
        recent_ticks: [hugeTick],
      };
    });

    const live = await runCliAsync(['task', 'show', '1', '--port', socket]);
    const raw = await runCliAsync(['task', 'show', '1', '--raw', '--port', socket]);
    expect({
      status: live.status,
      hasRun: live.stdout.includes('Run: live-run'),
      hasExecution: live.stdout.includes('Current stage: implement · execution 2 · 30s'),
      hasRejection: live.stdout.includes('Latest rejection: missing producer'),
      rawHidden: live.stdout.includes('Raw ticks: hidden (pass --raw)'),
      rawLeaked: live.stdout.includes('x'.repeat(100)),
      rawOptInWorks: raw.stdout.includes('Recent ticks (raw JSON):') && raw.stdout.includes('x'.repeat(100)),
      requestedRawFlags,
    }).toEqual({
      status: 0,
      hasRun: true,
      hasExecution: true,
      hasRejection: true,
      rawHidden: true,
      rawLeaked: false,
      rawOptInWorks: true,
      requestedRawFlags: [false, true],
    });
  });

  it('unchanged-base seam: black-box task show gives finished context', async () => {
    const socket = join(root, 'daemon.sock');
    server = await startRpcServer(socket, (request): RpcResponse => ({
      task: {
        id: request.cmd === 'show' ? request.id : 2,
        name: 'Finished task',
        kind: 'quick',
        brief_text: 'fixture',
        projectDir: project,
        systemd_unit: 'fixture-2.service',
        status: 'complete',
        attempt: 1,
        max_retries: 3,
        created_at: '2026-09-03T10:00:00.000Z',
        tick_log_path: join(root, 'tick.jsonl'),
        run_id: 'finished-run',
        operational: {
          version: 1,
          runId: 'finished-run',
          projectDir: project,
          runStatus: 'complete',
          runElapsedMs: 120_000,
          activeStages: [],
          latestReason: { type: 'run_status_changed', detail: 'all gates passed' },
          pendingScope: [],
          sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
        },
      },
      recent_ticks: [],
    }));
    const finished = await runCliAsync(['task', 'show', '2', '--port', socket]);
    expect({
      status: finished.status,
      hasRun: finished.stdout.includes('Run: finished-run'),
      idle: finished.stdout.includes('Current stage: none executing'),
      hasReason: finished.stdout.includes('Latest reason: all gates passed'),
    }).toEqual({ status: 0, hasRun: true, idle: true, hasReason: true });
  });

  it('unchanged-base seam: black-box task list summarizes live and finished runs', async () => {
    const socket = join(root, 'daemon.sock');
    const common = {
      kind: 'quick' as const,
      brief_text: 'fixture',
      projectDir: project,
      max_retries: 3,
      created_at: '2026-09-03T10:00:00.000Z',
      tick_log_path: join(root, 'tick.jsonl'),
    };
    server = await startRpcServer(socket, (request): RpcResponse => request.cmd === 'list' ? ({ tasks: [{
      ...common,
      id: 1,
      name: 'Live task',
      systemd_unit: 'fixture-1.service',
      status: 'running',
      attempt: 2,
      run_id: 'live-run',
      operational: {
        version: 1,
        runId: 'live-run',
        projectDir: project,
        runStatus: 'running',
        runElapsedMs: 90_000,
        activeStages: [{ id: 'implement', status: 'running', execution: 2, elapsedMs: 30_000 }],
        latestReason: { type: 'admission_rejected', detail: 'missing producer' },
        lastRejection: { type: 'admission_rejected', detail: 'missing producer' },
        pendingScope: [],
        sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
      },
    }, {
      ...common,
      id: 2,
      name: 'Finished task',
      systemd_unit: 'fixture-2.service',
      status: 'complete',
      attempt: 1,
      run_id: 'finished-run',
      operational: {
        version: 1,
        runId: 'finished-run',
        projectDir: project,
        runStatus: 'complete',
        runElapsedMs: 120_000,
        activeStages: [],
        latestReason: { type: 'run_status_changed', detail: 'all gates passed' },
        pendingScope: [],
        sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
      },
    }] }) : { error: 'unexpected request' });

    const listed = await runCliAsync(['task', 'list', '--status', 'all', '--port', socket]);
    expect({
      status: listed.status,
      columns: ['Launch', 'Run', 'Current stage', 'Elapsed', 'Latest reason']
        .every((heading) => listed.stdout.includes(heading)),
      live: listed.stdout.includes('live-run') && listed.stdout.includes('implement (execution 2)')
        && listed.stdout.includes('missing producer'),
      finished: listed.stdout.includes('finished-run') && listed.stdout.includes('all gates passed'),
    }).toEqual({ status: 0, columns: true, live: true, finished: true });
  });

  it('unchanged-base seam: black-box status identifies the live execution', () => {
    writeRun('live-run', 'running', 1_000);
    const live = runCli(['status']);
    expect({
      status: live.status,
      hasRun: live.stdout.includes('Run: live-run'),
      hasExecution: live.stdout.includes('Now: implement · execution 2'),
      hasRejection: live.stdout.includes('Latest rejection: the proposal omitted a declared producer'),
    }, live.stderr).toEqual({ status: 0, hasRun: true, hasExecution: true, hasRejection: true });
  });

  it('unchanged-base seam: black-box status identifies the finished reason', () => {
    writeRun('finished-run', 'complete', 2_000);
    const finished = runCli(['status']);
    expect({
      status: finished.status,
      hasRun: finished.stdout.includes('Run: finished-run'),
      idle: finished.stdout.includes('Now: no stage executing'),
      hasReason: finished.stdout.includes('Latest reason: all declared gates passed'),
    }, finished.stderr).toEqual({ status: 0, hasRun: true, idle: true, hasReason: true });
  });
});

describe('events, help, watch, and preflight', () => {
  it('unchanged-base seam: exposes a filterable JSON event feed without dropping detail', () => {
    writeRun('live-run', 'running', 1_000);
    const result = runCli(['events', '--run', 'live-run', '--stage', 'implement', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: 'admission_rejected',
      stageId: 'implement',
      attemptIndex: 2,
      detail: 'the proposal omitted a declared producer',
    });

    const projectFiltered = runCli(['events', '--project', project, '--type', 'admission_rejected', '--json']);
    expect(projectFiltered.status, projectFiltered.stderr).toBe(0);
    expect(JSON.parse(projectFiltered.stdout)).toMatchObject({
      runId: 'live-run',
      type: 'admission_rejected',
      stageId: 'implement',
      detail: 'the proposal omitted a declared producer',
    });
  });

  it('unchanged-base seam: follows filtered JSON events without dropping guidance detail', async () => {
    const runDirectory = writeRun('live-run', 'running', 1_000);
    const result = await followGuidanceEvent(runDirectory);
    const rows = result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
    expect({
      status: result.status,
      count: rows.length,
      event: rows[0],
    }, result.stderr).toMatchObject({
      status: 0,
      count: 1,
      event: {
        type: 'guidance_written',
        stageId: 'implement',
        attemptIndex: 2,
        detail: 'inspect the immutable manifest',
      },
    });
  });

  it('unchanged-base seam: help exits zero before contacting a daemon', () => {
    const commands = [
      ['task', '--help'],
      ['task', 'list', '--help'],
      ['task', 'show', '--help'],
      ['daemon', '--help'],
      ['quick', '--help'],
      ['rehearse', '--help'],
      ['brief', '--help'],
      ['campaign', '--help'],
      ['events', '--help'],
    ];
    for (const command of commands) {
      const result = runCli(command);
      expect(result.status, `${command.join(' ')}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Usage:');
    }
  });

  it('unchanged-base seam: watch defaults to indexed operational candidates and --all is explicit', () => {
    writeRun('live-run', 'running', 1_000);
    for (let index = 0; index < 200; index += 1) mkdirSync(join(fcHome, 'runs', `test-fixture-${index}`), { recursive: true });
    const indexed = runCli(['watch', '--once']);
    expect(indexed.status, indexed.stderr).toBe(0);
    expect(indexed.stdout).toContain('[WATCH] armed · 1 entries');
    const all = runCli(['watch', '--once', '--all']);
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toContain('[WATCH] armed · 201 entries');
  });

  it('unchanged-base seam: preflight can skip all commands and streams progress with a live-project warning', async () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { build: 'fixture-build', test: 'fixture-test', lint: 'fixture-lint' } }), 'utf-8');
    writeFileSync(join(project, 'package-lock.json'), '{}', 'utf-8');
    const runDirectory = writeRun('live-run', 'running', 1_000);
    const stdout = new Capture();
    const stderr = new Capture();
    const runner = vi.fn((request: { role: string; observer?: { onCommandOutput?: Function; onCommandHeartbeat?: Function } }) => {
      request.observer?.onCommandOutput?.(request, 'stdout', `${request.role} streamed output\n`);
      request.observer?.onCommandHeartbeat?.(request, 10_000);
      return { exitCode: 0, durationMs: 25 };
    });
    const dependencies = {
      projectDir: project,
      packageRoot: repositoryRoot,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runsRoot: () => join(fcHome, 'runs'),
      readGitCommonDir: () => '.git',
      readCampaignEntries: () => [],
      probeDaemon: async () => ({ state: 'unavailable' as const }),
      inspectLiveRun: (_runId: string, candidate: string) => candidate === runDirectory,
      runValidationCommand: runner as never,
    };

    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--no-baseline'], dependencies)).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(stdout.text()).toContain('Validation baseline: SKIPPED');
    expect(stderr.text()).toContain('shared by live FlowCrew run(s): live-run');
    expect(stderr.text()).toContain('no project command was launched');

    const streamedOut = new Capture();
    const streamedErr = new Capture();
    expect(await cmdShipPreflightWithDeps(['ship-preflight'], {
      ...dependencies,
      stdout: streamedOut.stream,
      stderr: streamedErr.stream,
    })).toBe(0);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(streamedErr.text().indexOf('shared by live FlowCrew run(s)')).toBeLessThan(streamedErr.text().indexOf('Validation baseline: START build'));
    expect(streamedErr.text()).toContain('build streamed output');
    expect(streamedErr.text()).toContain('Validation baseline: RUNNING build — 10s elapsed');
    expect(streamedErr.text()).toContain('Validation baseline: FINISH lint — exit 0');
  });

  it('unchanged-base seam: the production validation runner streams child output', async () => {
    const chunks: string[] = [];
    const response = await runValidationCommand({
      role: 'test',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("visible baseline output\\n")'],
      display: 'node streaming fixture',
      cwd: project,
      observer: {
        onCommandOutput: (_command, stream, chunk) => chunks.push(`${stream}:${chunk}`),
      },
    });
    expect({ exitCode: response.exitCode, streamed: chunks.join('').includes('stdout:visible baseline output') })
      .toEqual({ exitCode: 0, streamed: true });
  });
});

describe('operator dashboard vocabulary', () => {
  it('unchanged-base seam: shows projection reasons and uses execution terminology', () => {
    const html = renderToStaticMarkup(<MemoryRouter><RunDetail run={{
      runId: 'live-run',
      projectDir: project,
      workflowName: 'fixture',
      status: 'running',
      startedAt: '2026-09-03T10:00:00.000Z',
      stages: [{
        id: 'implement', role: 'coder', depends_on: [], status: 'running',
        attempts: [{ index: 2, status: 'running', startedAt: '2026-09-03T10:01:00.000Z' }],
      }],
      operational: {
        version: 1,
        runStatus: 'running',
        activeStages: [{ id: 'implement', status: 'running', execution: 2, elapsedMs: 30_000 }],
        latestReason: { type: 'admission_rejected', detail: 'the proposal omitted a declared producer' },
        lastRejection: { type: 'admission_rejected', detail: 'the proposal omitted a declared producer' },
        pendingScope: [{ requestId: 'scope-1', stageId: 'implement' }],
        sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
      },
      kg: { nodes: [], edges: [] },
      events: [{
        timestamp: '2026-09-03T10:01:30.000Z', type: 'admission_rejected', stageId: 'implement',
        attemptIndex: 2, detail: 'the proposal omitted a declared producer',
      }],
      stage_outputs: {},
    }} /></MemoryRouter>);
    expect(html).toContain('data-testid="operational-projection"');
    expect(html).toContain('the proposal omitted a declared producer');
    expect(html).toContain('Current execution:');
    expect(html).toContain('Admission rejected a proposal');
    expect(html).not.toContain('Current attempt:');
  });

  it('unchanged-base seam: a finished dashboard keeps the terminal reason in the bounded projection', () => {
    const html = renderToStaticMarkup(<MemoryRouter><RunDetail run={{
      runId: 'finished-run',
      projectDir: project,
      workflowName: 'fixture',
      status: 'complete',
      startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:02:00.000Z',
      stages: [{
        id: 'implement', role: 'coder', depends_on: [], status: 'complete',
        attempts: [{
          index: 1, status: 'complete', startedAt: '2026-09-03T10:00:00.000Z',
          completedAt: '2026-09-03T10:02:00.000Z',
        }],
      }],
      operational: {
        version: 1,
        runStatus: 'complete',
        runElapsedMs: 120_000,
        activeStages: [],
        latestReason: { type: 'run_status_changed', detail: 'all declared gates passed' },
        pendingScope: [],
        sourceCoverage: { runState: 'read', events: 'read', stageCount: 1 },
      },
      kg: { nodes: [], edges: [] },
      events: [{
        timestamp: '2026-09-03T10:02:00.000Z', type: 'run_status_changed',
        runStatus: 'complete', detail: 'all declared gates passed',
      }],
      stage_outputs: { implement: 'finished fixture' },
    }} /></MemoryRouter>);
    expect(html).toContain('data-testid="operational-projection"');
    expect(html).toContain('all declared gates passed');
    expect(html).toContain('Stage execution history');
    expect(html).not.toContain('Stage attempt history');
  });

  it('unchanged-base seam: names budget journals by execution', () => {
    const stageDirectory = join(root, 'run', 'stages', 'implement');
    const deadline = new AttemptDeadlineController({
      budgetMs: 60_000,
      ledgerDir: stageDirectory,
      executionIndex: 3,
    });
    deadline.dispose();
    expect(readdirSync(stageDirectory)).toContain('attempt_deadline_execution_3_budget.jsonl');
  });

  it('unchanged-base seam: clears stale status and explains an empty supervisor abort through runStage', async () => {
    const runId = 'operator-item-10';
    const stageId = 'implement';
    const runDirectory = join(fcHome, 'runs', runId);
    const stageDirectory = join(runDirectory, 'stages', stageId);
    mkdirSync(join(runDirectory, 'signals'), { recursive: true });
    mkdirSync(stageDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'task_brief.md'), '# Operator fixture\n', 'utf-8');
    writeFileSync(join(stageDirectory, 'status.json'), JSON.stringify({
      status: 'failed',
      retries: 0,
      error: 'stale prior failure',
      exitCode: 1,
      completedAt: '2026-09-03T10:00:00.000Z',
      attempts: [{
        index: 1,
        status: 'failed',
        startedAt: '2026-09-03T09:59:00.000Z',
        completedAt: '2026-09-03T10:00:00.000Z',
        error: 'retained in history',
      }],
    }), 'utf-8');
    let runningStatus: Record<string, unknown> | undefined;
    const adapter: Adapter = {
      run: async (_prompt, _role, options) => {
        runningStatus = JSON.parse(readFileSync(join(stageDirectory, 'status.json'), 'utf-8')) as Record<string, unknown>;
        writeFileSync(join(runDirectory, 'signals', `abort_${stageId}.json`), JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 2,
          reason: 'superseded by verified evidence',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }), 'utf-8');
        await new Promise<void>((resolveAbort) => {
          if (options.abortSignal?.aborted) return resolveAbort();
          options.abortSignal?.addEventListener('abort', () => resolveAbort(), { once: true });
        });
        return { output: '', exitCode: 137, duration_ms: 1, timedOut: false };
      },
    };
    const role: AgentConfig = { name: 'fixture', description: 'fixture', tools: [], prompt: 'system' };
    await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'fixture work',
      timeout_ms: 10_000,
      projectDir: project,
      runId,
      runDir: runDirectory,
      retries: 1,
      projectWriteScope: [],
    });

    const output = readFileSync(join(stageDirectory, 'output.md'), 'utf-8');
    const guidanceReceipt = readFileSync(join(stageDirectory, 'guidance_consumed.md'), 'utf-8');
    expect({
      running: runningStatus?.status === 'running' && runningStatus.retries === 1,
      staleErrorCleared: !Object.hasOwn(runningStatus ?? {}, 'error'),
      staleExitCleared: !Object.hasOwn(runningStatus ?? {}, 'exitCode'),
      staleCompletionCleared: !Object.hasOwn(runningStatus ?? {}, 'completedAt'),
      abortExplained: output.includes('Execution aborted by supervisor')
        && output.includes('superseded by verified evidence'),
      emptyGuidanceExplained: guidanceReceipt.includes('No supervisor guidance was delivered to this execution.'),
    }).toEqual({
      running: true,
      staleErrorCleared: true,
      staleExitCleared: true,
      staleCompletionCleared: true,
      abortExplained: true,
      emptyGuidanceExplained: true,
    });
  });

  it('unchanged-base seam: omits cache noise and labels run-local artifacts through runStage', async () => {
    const runId = 'operator-artifact-paths';
    const stageId = 'implement';
    const runDirectory = join(fcHome, 'runs', runId);
    mkdirSync(join(runDirectory, 'stages', stageId), { recursive: true });
    writeFileSync(join(runDirectory, 'task_brief.md'), '# Operator fixture\n', 'utf-8');
    mkdirSync(join(project, 'fixture-root'), { recursive: true });
    const adapter: Adapter = {
      run: async () => {
        const cachePath = join(project, 'fixture-root', '.pytest_cache', 'v', 'cache', 'nodeids');
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, '[]\n', 'utf-8');
        writeFileSync(join(runDirectory, 'knowledge_graph.json'), '{"nodes":[],"edges":[]}\n', 'utf-8');
        return { output: 'complete', exitCode: 0, duration_ms: 1, timedOut: false };
      },
    };
    const role: AgentConfig = { name: 'fixture', description: 'fixture', tools: [], prompt: 'system' };
    const result = await runStage(adapter, {
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'fixture work',
      timeout_ms: 10_000,
      projectDir: project,
      runId,
      runDir: runDirectory,
      retries: 0,
      projectWriteScope: ['fixture-root/**'],
    });
    expect({
      runArtifact: result.writes?.includes('run:knowledge_graph.json') ?? false,
      cacheNoise: result.writes?.some((path) => path.includes('.pytest_cache')) ?? false,
    }).toEqual({ runArtifact: true, cacheNoise: false });
  });

  it('unchanged-base seam: operator guides describe the enforced admission and surface contracts', () => {
    const architecture = readFileSync(join(repositoryRoot, 'guide', 'architecture.md'), 'utf-8');
    const contract = readFileSync(join(repositoryRoot, 'guide', 'brief-contract.md'), 'utf-8');
    const cli = readFileSync(join(repositoryRoot, 'guide', 'cli.md'), 'utf-8');
    const lifecycle = readFileSync(join(repositoryRoot, 'guide', 'run-lifecycle.md'), 'utf-8');
    expect(architecture).toContain('task **launch**, stage');
    expect(architecture).toContain('**execution**, and gate **re-evaluation**');
    expect(contract).toContain('scope` is required; omitting it rejects the');
    expect(contract).toContain('Terminal snapshot basenames must also be unique');
    expect(contract).toContain('remove the condition or declare research mode');
    expect(contract).toContain('An accepted revision is inherited and revalidated');
    expect(contract).toContain('framework-owned `run_manifest.json`');
    expect(cli).toContain('flowcrew events --run <run-id>');
    expect(cli).toContain('task show <id> [--summary-only | --raw]');
    expect(cli).toContain('`--no-baseline` performs');
    expect(cli).toContain('`--all`\nexplicitly audits every entry');
    expect(lifecycle).toContain('**launches**, a stage may have multiple **executions**');
  });
});
