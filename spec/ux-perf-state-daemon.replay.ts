import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { cmdDaemon } from '../src/cli-daemon.js';
import { createDaemonIdentity, writeDaemonIdentity } from '../src/daemon-identity.js';
import type { Adapter } from '../src/adapters/base.js';
import {
  Orchestrator,
  type GitAdapter,
  type SupervisorBackend,
  type UnitStatus,
} from '../src/orchestrator.js';
import type { DaemonStatusRpcResponse } from '../src/orchestrator-rpc.js';
import {
  listOperationalRunIdsFromIndex,
  rebuildRunIndex,
} from '../src/run-index.js';
import { writeSchedulerProcessIdentity } from '../src/run-lock.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  runsRoot,
  setFcGlobalDir,
  updateRunState,
  writeRunState,
  type StageEvidenceRecord,
  type StoreState,
  type SupervisorAttempt,
} from '../src/store.js';
import { TaskRegistry, type TaskEntry } from '../src/task-registry.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { tryTerminateOnTerminalState } from '../src/scheduler.js';
import { recordedEvidence } from './test-support/recorded-evidence.js';

let root: string;
let projectDir: string;
let registryDir: string;
let previousFcDir: string;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-state-daemon-'));
  projectDir = join(root, 'project');
  registryDir = join(root, 'registry');
  mkdirSync(projectDir);
  mkdirSync(registryDir);
  previousFcDir = fcGlobalDir();
  setFcGlobalDir(join(root, 'fc-home'));
  clock = Date.parse('2026-09-03T00:00:00.000Z');
});

afterEach(() => {
  setFcGlobalDir(previousFcDir);
  rmSync(root, { recursive: true, force: true });
});

function admitted(brief: string) {
  return {
    brief_text: brief,
    brief_admission: createBriefAdmission(inspectBrief(brief), {
      kind: 'explicit' as const,
      source: 'cli_current_input_flag' as const,
      at: new Date(clock).toISOString(),
    }),
  };
}

function taskRow(id: number, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id,
    name: `task-${id}`,
    projectDir,
    systemd_unit: `task-${id}.service`,
    status: 'running',
    attempt: 1,
    max_retries: 2,
    created_at: '2026-09-03T00:00:00.000Z',
    tick_log_path: join(registryDir, 'tasks', String(id), 'tick_log.md'),
    ...overrides,
  };
}

function writeRows(directory: string, rows: TaskEntry[], finalNewline = true): string {
  mkdirSync(directory, { recursive: true });
  const raw = rows.map((row) => JSON.stringify(row)).join('\n') + (finalNewline ? '\n' : '');
  writeFileSync(join(directory, 'tasks.jsonl'), raw, 'utf-8');
  return raw;
}

class FakeUnits implements SupervisorBackend {
  readonly states = new Map<string, UnitStatus>();
  readonly launches: Array<{ unit: string; command: string }> = [];

  async isActive(unit: string): Promise<UnitStatus> {
    return this.states.get(unit) ?? { kind: 'absent' };
  }

  async runUnit(opts: { unit: string; command: string }): Promise<void> {
    this.launches.push({ unit: opts.unit, command: opts.command });
    this.states.set(opts.unit, { kind: 'active' });
  }

  async stopUnit(): Promise<void> {}
  async journalTail(): Promise<string> { return ''; }
}

const cleanGit: GitAdapter = {
  async findCommitByPrefix() { return undefined; },
  async hasUncommittedChanges() { return false; },
  async findCommitSince() { return undefined; },
};

function recoveryFixture(options: { maxRetries?: number; attempt?: number } = {}) {
  const brief = '# Resume only this run';
  const created = createRun(projectDir, 'recovery', 'name: recovery\nstages: []\n', []);
  const run = readRunState(projectDir, created.runId);
  const recordedTick = recordedEvidence('item5_nonterminal_state_before_crash').toString('utf-8');
  const stagesOffset = recordedTick.indexOf(' stages=');
  expect(stagesOffset).toBeGreaterThan(0);
  run.status = 'running';
  run.stages = JSON.parse(recordedTick.slice(stagesOffset + ' stages='.length).trim()) as StoreState['stages'];
  run.terminalStates = { ceiling_hit: { paths: ['terminal_ceiling_report.md'] } };
  run.taskDescription = brief;
  run.briefAdmission = admitted(brief).brief_admission;
  writeRunState(projectDir, created.runId, run);
  writeFileSync(join(created.runDirPath, 'task_brief.md'), brief, 'utf-8');
  writeFileSync(
    join(projectDir, 'terminal_ceiling_report.md'),
    recordedEvidence('item5_terminal_candidate'),
  );

  const registry = new TaskRegistry({ baseDir: registryDir, now: () => new Date(clock) });
  const task = registry.create({
    ...admitted(brief),
    projectDir,
    run_id: created.runId,
    status: 'running',
    attempt: options.attempt ?? 1,
    max_retries: options.maxRetries ?? 2,
  });
  writeFileSync(task.tick_log_path, recordedTick, 'utf-8');
  const units = new FakeUnits();
  const recordedExit = JSON.parse(recordedEvidence('item5_unit_exit').toString('utf-8')) as { exitCode: number };
  units.states.set(task.systemd_unit, { kind: 'terminal', exitCode: recordedExit.exitCode });
  const orchestrator = new Orchestrator({
    registry,
    systemd: units,
    git: cleanGit,
    cliPath: '/tmp/flowcrew-cli.js',
    now: () => new Date(clock),
    isProjectBusy: () => null,
  });
  return { created, registry, task, units, orchestrator };
}

describe('identity-bound dead scheduler recovery', () => {
  it('queues one budgeted retry and relaunches only the exact existing run when scheduler.pid is missing', async () => {
    const fixture = recoveryFixture();

    await fixture.orchestrator.tickOnce();
    expect(fixture.registry.get(fixture.task.id)).toMatchObject({
      status: 'deferred',
      attempt: 1,
      defer_kind: 'retry',
      run_id: fixture.created.runId,
    });
    expect(fixture.registry.get(fixture.task.id)?.defer_reason).toContain('scheduler is missing');
    expect(fixture.units.launches).toHaveLength(0);

    clock += 31_000;
    await fixture.orchestrator.tickOnce();

    const recovered = fixture.registry.get(fixture.task.id)!;
    expect(recovered).toMatchObject({ status: 'running', attempt: 2, run_id: fixture.created.runId });
    expect(fixture.units.launches).toHaveLength(1);
    expect(fixture.units.launches[0].command).toContain(`'--existing-run-id' '${fixture.created.runId}'`);
    expect(readdirSync(runsRoot())).toEqual([fixture.created.runId]);

    // The resumed scheduler consumes the exact recorded terminal candidate and
    // reaches its declared status instead of leaving the daemon in a defer loop.
    const state = readRunState(projectDir, fixture.created.runId);
    const adapter = {
      async run() { return { output: 'summary unavailable in replay', exitCode: 1, duration_ms: 1 }; },
    } as Adapter;
    const terminal = await tryTerminateOnTerminalState(state, {
      projectDir,
      runId: fixture.created.runId,
      runDirPath: fixture.created.runDirPath,
      iteration: state.currentIteration ?? 1,
      adapter,
    });
    expect(terminal.decision).toBe('matched');
    expect(readRunState(projectDir, fixture.created.runId).status).toBe('ceiling_hit');
    const exactRecordedTick = recordedEvidence('item5_nonterminal_state_before_crash');
    expect(readFileSync(fixture.task.tick_log_path).subarray(0, exactRecordedTick.byteLength))
      .toEqual(exactRecordedTick);
  });

  it('waits without spending budget while the recorded PID/start identity still owns the run', async () => {
    const fixture = recoveryFixture();
    writeFileSync(join(fixture.created.runDirPath, 'scheduler.pid'), `${process.pid}\n`, 'utf-8');
    writeSchedulerProcessIdentity(fixture.created.runDirPath, fixture.created.runId);

    await fixture.orchestrator.tickOnce();

    expect(fixture.registry.get(fixture.task.id)).toMatchObject({ status: 'deferred', attempt: 1 });
    expect(fixture.registry.get(fixture.task.id)?.defer_reason).toContain(`live scheduler pid ${process.pid}`);
    expect(fixture.units.launches).toHaveLength(0);
  });

  it('recognizes a live but unrelated recycled PID as non-owning and preserves the same run binding', async () => {
    const fixture = recoveryFixture();
    writeFileSync(join(fixture.created.runDirPath, 'scheduler.pid'), `${process.pid}\n`, 'utf-8');

    await fixture.orchestrator.tickOnce();

    expect(fixture.registry.get(fixture.task.id)).toMatchObject({
      status: 'deferred', attempt: 1, defer_kind: 'retry', run_id: fixture.created.runId,
    });
    expect(fixture.registry.get(fixture.task.id)?.defer_reason).toContain('scheduler is reused');
  });

  it('fails visibly on corrupt identity and on an exhausted retry budget, with executable remedies', async () => {
    const corrupt = recoveryFixture();
    writeFileSync(join(corrupt.created.runDirPath, 'scheduler.pid'), 'not-a-pid\n', 'utf-8');
    await corrupt.orchestrator.tickOnce();
    expect(corrupt.registry.get(corrupt.task.id)).toMatchObject({ status: 'stuck', attempt: 1 });
    expect(corrupt.registry.get(corrupt.task.id)?.notes).toContain(`flowcrew task retry ${corrupt.task.id}`);

    const exhausted = recoveryFixture({ maxRetries: 1, attempt: 1 });
    await exhausted.orchestrator.tickOnce();
    expect(exhausted.registry.get(exhausted.task.id)).toMatchObject({ status: 'stuck', attempt: 1 });
    expect(exhausted.registry.get(exhausted.task.id)?.notes).toContain('retry budget exhausted (1/1)');
    expect(exhausted.units.launches).toHaveLength(0);
  });

  it('settles terminal run truth before consulting a corrupt scheduler marker', async () => {
    const fixture = recoveryFixture();
    const state = readRunState(projectDir, fixture.created.runId);
    state.status = 'reality_gate_failed';
    writeRunState(projectDir, fixture.created.runId, state);
    writeFileSync(join(fixture.created.runDirPath, 'scheduler.pid'), 'corrupt\n', 'utf-8');

    await fixture.orchestrator.tickOnce();

    expect(fixture.registry.get(fixture.task.id)).toMatchObject({ status: 'reality_gate_failed' });
    expect(fixture.units.launches).toHaveLength(0);
  });
});

describe('incremental append-durable task registry', () => {
  it('reads only a complete appended delta, suppresses a byte-identical update, and rebuilds after truncation/replacement', () => {
    const first = taskRow(1);
    const raw = writeRows(registryDir, [first]);
    const registry = new TaskRegistry({ baseDir: registryDir });
    expect(registry.snapshot().tasks).toEqual([first]);
    const warmed = registry.cacheDiagnostics();
    expect(warmed.lastBytesParsed).toBe(Buffer.byteLength(raw));

    const second = taskRow(2, { status: 'done' });
    const appended = `${JSON.stringify(second)}\n`;
    appendFileSync(registry.registryPath, appended, 'utf-8');
    expect(registry.snapshot().tasks).toEqual([first, second]);
    expect(registry.cacheDiagnostics().lastBytesParsed).toBe(Buffer.byteLength(appended));
    const beforeNoop = statSync(registry.registryPath).size;
    registry.update(1, { status: 'running' });
    expect(statSync(registry.registryPath).size).toBe(beforeNoop);
    expect(registry.cacheDiagnostics().suppressedAppends).toBe(1);

    const truncated = taskRow(3, { status: 'pending' });
    writeRows(registryDir, [truncated]);
    expect(registry.snapshot().tasks).toEqual([truncated]);
    const afterTruncate = registry.cacheDiagnostics().rebuilds;

    const replacement = taskRow(4, { status: 'cancelled' });
    const replacementPath = join(registryDir, 'replacement.jsonl');
    writeFileSync(replacementPath, `${JSON.stringify(replacement)}\n`, 'utf-8');
    renameSync(replacementPath, registry.registryPath);
    expect(registry.snapshot().tasks).toEqual([replacement]);
    expect(registry.cacheDiagnostics().rebuilds).toBeGreaterThan(afterTruncate);
  });

  it('does not apply an incomplete trailing row, then completes it without rereading history', () => {
    const row = taskRow(7);
    const encoded = JSON.stringify(row);
    const split = Math.floor(encoded.length / 2);
    writeFileSync(join(registryDir, 'tasks.jsonl'), encoded.slice(0, split), 'utf-8');
    const registry = new TaskRegistry({ baseDir: registryDir });

    expect(registry.snapshot()).toMatchObject({ tasks: [], unreadableRecords: 1 });
    expect(() => registry.update(7, { status: 'done' })).toThrow(/integrity check failed/i);
    appendFileSync(registry.registryPath, `${encoded.slice(split)}\n`, 'utf-8');

    expect(registry.snapshot()).toMatchObject({ tasks: [row], unreadableRecords: 0 });
    expect(registry.cacheDiagnostics().lastBytesParsed).toBe(Buffer.byteLength(encoded.slice(split) + '\n'));
  });

  it('hydrates a valid legacy EOF row and inserts a safe separator before the next durable append', () => {
    const row = taskRow(8);
    writeRows(registryDir, [row], false);
    const registry = new TaskRegistry({ baseDir: registryDir });

    expect(registry.get(8)).toEqual(row);
    registry.update(8, { status: 'done' });

    const lines = readFileSync(registry.registryPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).status)).toEqual(['running', 'done']);
  });

  it('acknowledges only after fsync and remains readable from a fresh registry instance', () => {
    let syncCalls = 0;
    const durable = new TaskRegistry({
      baseDir: registryDir,
      syncFile: (fd) => { syncCalls += 1; fsyncSync(fd); },
    });
    const created = durable.create({ brief_text: 'durable', projectDir });
    expect(syncCalls).toBe(1);
    expect(new TaskRegistry({ baseDir: registryDir }).get(created.id)).toEqual(created);

    const faulted = new TaskRegistry({
      baseDir: registryDir,
      syncFile: () => { throw new Error('injected sync failure'); },
    });
    expect(() => faulted.update(created.id, { notes: 'must not be acknowledged' }))
      .toThrow('injected sync failure');
    expect(faulted.cacheDiagnostics().durableAppends).toBe(0);
  });

  it.each([100, 1_000, 10_000])('does zero historical parsing and zero append on a warmed %,i-record no-op', (records) => {
    const row = taskRow(1);
    writeRows(registryDir, Array.from({ length: records }, () => row));
    const registry = new TaskRegistry({ baseDir: registryDir });
    expect(registry.metrics()).toMatchObject({ records, tasks: 1, activeTasks: 1 });
    const parsedBefore = registry.cacheDiagnostics().totalBytesParsed;
    const bytesBefore = statSync(registry.registryPath).size;

    registry.update(1, { status: 'running' });
    const metrics = registry.metrics();

    expect(registry.cacheDiagnostics().totalBytesParsed - parsedBefore).toBe(0);
    expect(registry.cacheDiagnostics().lastBytesParsed).toBe(0);
    expect(statSync(registry.registryPath).size).toBe(bytesBefore);
    expect(metrics).toMatchObject({ records, tasks: 1 });
  });

  it('writes bounded status deltas and suppresses identical active ticks', () => {
    const registry = new TaskRegistry({ baseDir: registryDir });
    const task = registry.create({ brief_text: 'ticks', projectDir });
    const attempts = Array.from({ length: 100 }, (_, index) => ({ index, output: 'large history must not enter ticks' }));
    const stages = {
      plan: { status: 'complete', retries: 0, attempts },
      run: { status: 'running', retries: 0, attempts },
    };
    for (let index = 0; index < 100; index += 1) registry.appendTick(task.id, { status: 'active', stages });
    registry.appendTick(task.id, {
      status: 'active',
      stages: { ...stages, run: { ...stages.run, status: 'complete' } },
    });

    const ticks = readFileSync(task.tick_log_path, 'utf-8').trim().split('\n');
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toContain('stage_delta=');
    expect(ticks[0]).not.toContain('stages=');
    expect(ticks.join('\n')).not.toContain('large history must not enter ticks');
    expect(ticks[1]).toContain('"run"');
    expect(ticks[1]).not.toContain('"plan"');
    expect(Buffer.byteLength(ticks.join('\n'))).toBeLessThan(1_000);
  });
});

function supervisorAttempt(index: number): SupervisorAttempt {
  return {
    index,
    startedAt: `2026-09-03T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    completedAt: `2026-09-03T00:00:${String(index % 60).padStart(2, '0')}.500Z`,
    status: 'complete',
    duration_ms: 500,
    exitCode: 0,
    tokens_in: 10,
    tokens_out: 2,
    verdict: 'WAIT',
    effectiveReason: `attempt ${index} evidence`,
  };
}

function evidence(index: number): StageEvidenceRecord {
  return {
    stageId: `retired-${index}`,
    iteration: index,
    status: { status: 'complete', retries: 0, duration_ms: 100 },
    statusPath: `stage_evidence/${index}/status.json`,
    outputPath: `stage_evidence/${index}/output.md`,
    attemptOutputPaths: [],
  };
}

describe('compact atomic run projection', () => {
  it('externalizes growing histories, hydrates them compatibly, skips no-op writes, and grows by one delta', () => {
    const created = createRun(projectDir, 'compact', 'name: compact\nstages: []\n', []);
    const state = readRunState(projectDir, created.runId);
    const attempts = Array.from({ length: 80 }, (_, index) => supervisorAttempt(index + 1));
    state.supervisor = {
      status: 'running', calls: attempts.length, tokens_in: 800, tokens_out: 160,
      duration_ms: 40_000, startedAt: state.startedAt, attempts,
    };
    state.retiredStageUsage = Array.from({ length: 80 }, (_, index) => ({
      stageId: `retired-${index}`, iteration: index,
      status: { status: 'complete', retries: 0, duration_ms: 100 },
    }));
    state.stageEvidence = Array.from({ length: 80 }, (_, index) => evidence(index));
    writeRunState(projectDir, created.runId, state);

    const statePath = join(created.runDirPath, 'run.json');
    const historyPath = join(created.runDirPath, 'run-history.v1.jsonl');
    const projectionBytes = readFileSync(statePath);
    const projection = JSON.parse(projectionBytes.toString('utf-8')) as StoreState;
    expect(projectionBytes.toString('utf-8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(projection.retiredStageUsage).toBeUndefined();
    expect(projection.stageEvidence).toBeUndefined();
    expect(projection.supervisor?.attempts).toEqual([]);
    expect(projection.stateFormat).toMatchObject({
      version: 2,
      history: { counts: { supervisorAttempts: 80, retiredStageUsage: 80, stageEvidence: 80 } },
    });
    expect(projectionBytes.byteLength).toBeLessThan(2_000);

    const hydrated = readRunState(projectDir, created.runId);
    expect(hydrated.supervisor?.attempts).toHaveLength(80);
    expect(hydrated.retiredStageUsage).toHaveLength(80);
    expect(hydrated.stageEvidence).toHaveLength(80);

    const stateBeforeNoop = readFileSync(statePath);
    const historyBeforeNoop = readFileSync(historyPath);
    writeRunState(projectDir, created.runId, hydrated);
    expect(readFileSync(statePath)).toEqual(stateBeforeNoop);
    expect(readFileSync(historyPath)).toEqual(historyBeforeNoop);

    hydrated.supervisor!.attempts.push(supervisorAttempt(81));
    hydrated.supervisor!.calls = 81;
    writeRunState(projectDir, created.runId, hydrated);
    const historyAfter = readFileSync(historyPath);
    expect(historyAfter.byteLength - historyBeforeNoop.byteLength).toBeLessThan(1_000);
    expect(readRunState(projectDir, created.runId).supervisor?.attempts).toHaveLength(81);
    expect(Math.abs(readFileSync(statePath).byteLength - stateBeforeNoop.byteLength)).toBeLessThan(100);
  });

  it('ignores and removes only an unacknowledged crash tail, but refuses acknowledged truncation', () => {
    const created = createRun(projectDir, 'faults', 'name: faults\nstages: []\n', []);
    const state = readRunState(projectDir, created.runId);
    state.supervisor = {
      status: 'running', calls: 1, tokens_in: 1, tokens_out: 1,
      duration_ms: 1, startedAt: state.startedAt, attempts: [supervisorAttempt(1)],
    };
    writeRunState(projectDir, created.runId, state);
    const historyPath = join(created.runDirPath, 'run-history.v1.jsonl');
    const acknowledged = readRunState(projectDir, created.runId).stateFormat!.history!.committedBytes;
    appendFileSync(historyPath, '{unacknowledged crash tail', 'utf-8');

    const recovered = readRunState(projectDir, created.runId);
    expect(recovered.supervisor?.attempts).toHaveLength(1);
    recovered.failureReason = 'state update after recovery';
    writeRunState(projectDir, created.runId, recovered);
    expect(readFileSync(historyPath, 'utf-8')).not.toContain('unacknowledged crash tail');
    expect(statSync(historyPath).size).toBe(acknowledged);

    truncateSync(historyPath, acknowledged - 1);
    expect(() => readRunState(projectDir, created.runId)).toThrow(/history is truncated/i);
  });

  it('hydrates acknowledged history into exported run bundles', () => {
    const created = createRun(projectDir, 'export', 'name: export\nstages: []\n', []);
    const state = readRunState(projectDir, created.runId);
    state.supervisor = {
      status: 'running', calls: 1, tokens_in: 1, tokens_out: 1,
      duration_ms: 1, startedAt: state.startedAt, attempts: [supervisorAttempt(1)],
    };
    writeRunState(projectDir, created.runId, state);
    const raw = JSON.parse(readFileSync(join(created.runDirPath, 'run.json'), 'utf-8')) as StoreState;
    expect(raw.supervisor?.attempts).toEqual([]);

    const exportDir = join(root, 'export-output');
    mkdirSync(exportDir);
    execFileSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'export',
      created.runId,
    ], {
      cwd: exportDir,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() },
      stdio: 'pipe',
    });

    const bundle = JSON.parse(
      readFileSync(join(exportDir, `flowcrew-export-${created.runId}.json`), 'utf-8'),
    ) as { state?: StoreState };
    expect(bundle.state?.supervisor?.attempts).toEqual([supervisorAttempt(1)]);
  });

  it('migrates and hydrates a pretty-printed legacy run without changing its history semantics', () => {
    const runId = 'legacy-run';
    const path = runDir(projectDir, runId);
    mkdirSync(path, { recursive: true });
    const legacy: StoreState = {
      runId,
      workflowName: 'legacy',
      projectDir,
      status: 'running',
      stages: {},
      startedAt: '2026-09-03T00:00:00.000Z',
      supervisor: {
        status: 'running', calls: 1, tokens_in: 1, tokens_out: 1, duration_ms: 1,
        startedAt: '2026-09-03T00:00:00.000Z', attempts: [supervisorAttempt(1)],
      },
      retiredStageUsage: [{
        stageId: 'old', iteration: 1, status: { status: 'complete', retries: 0 },
      }],
      stageEvidence: [evidence(1)],
    };
    writeFileSync(join(path, 'run.json'), JSON.stringify(legacy, null, 2), 'utf-8');

    const before = readRunState(projectDir, runId);
    writeRunState(projectDir, runId, before);
    const raw = JSON.parse(readFileSync(join(path, 'run.json'), 'utf-8')) as StoreState;

    expect(raw.stateFormat?.version).toBe(2);
    expect(raw.retiredStageUsage).toBeUndefined();
    expect(raw.stageEvidence).toBeUndefined();
    expect(readRunState(projectDir, runId)).toMatchObject({
      supervisor: { attempts: legacy.supervisor!.attempts },
      retiredStageUsage: legacy.retiredStageUsage,
      stageEvidence: legacy.stageEvidence,
    });
  });

  it('serializes mutation commits and recovers a stale lock left by a dead writer', () => {
    const created = createRun(projectDir, 'cas', 'name: cas\nstages: []\n', []);
    writeFileSync(join(created.runDirPath, '.run-state.lock'), JSON.stringify({
      pid: 2_000_000_000,
      token: 'dead-writer',
      acquiredAt: '2026-09-03T00:00:00.000Z',
    }), 'utf-8');

    updateRunState(projectDir, created.runId, (state) => { state.taskDescription = 'first mutation'; });
    updateRunState(projectDir, created.runId, (state) => { state.failureReason = 'second mutation'; });

    expect(readRunState(projectDir, created.runId)).toMatchObject({
      taskDescription: 'first mutation',
      failureReason: 'second mutation',
    });
    expect(existsSync(join(created.runDirPath, '.run-state.lock'))).toBe(false);
  });
});

describe('indexed readers and cached status RPC', () => {
  it('selects only operational run candidates while retaining the explicit legacy fallback seam', () => {
    for (let index = 0; index < 100; index += 1) {
      const id = `finished-${String(index).padStart(3, '0')}`;
      const path = runDir(projectDir, id);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'run.json'), JSON.stringify({
        runId: id, workflowName: 'done', projectDir, status: 'complete', stages: {}, startedAt: '',
      }), 'utf-8');
    }
    const activeId = 'live-only';
    const activePath = runDir(projectDir, activeId);
    mkdirSync(activePath, { recursive: true });
    writeFileSync(join(activePath, 'run.json'), JSON.stringify({
      runId: activeId, workflowName: 'live', projectDir, status: 'running', stages: {}, startedAt: '',
    }), 'utf-8');
    rebuildRunIndex(projectDir);

    expect(listOperationalRunIdsFromIndex(projectDir)).toEqual([activeId]);
    let runStateReads = 0;
    const result = pollWatch(createWatchState(), {
      readText: (path) => {
        if (path.endsWith('run.json')) runStateReads += 1;
        return readFileSync(path, 'utf-8');
      },
      nowMs: () => clock,
    });
    expect(result.stats.entries).toBe(1);
    expect(runStateReads).toBe(1);

    let legacyRootReads = 0;
    pollWatch(createWatchState(), {
      runsRoot: runsRoot(),
      candidateRunIds: () => null,
      readDirectory: (path) => {
        if (path === runsRoot()) legacyRootReads += 1;
        return readdirSync(path);
      },
      nowMs: () => clock,
    });
    expect(legacyRootReads).toBe(1);
  });

  it('returns registry scale from the daemon cache and does not substitute local registry bytes', async () => {
    const socketPath = join(root, 'status', 'daemon.sock');
    const distDir = join(root, 'dist');
    mkdirSync(distDir);
    writeFileSync(join(distDir, 'runtime.js'), 'export const value = 1;\n', 'utf-8');
    const identity = createDaemonIdentity({ socketPath, distDir, pid: process.pid, startedAt: new Date(clock).toISOString() });
    writeDaemonIdentity(socketPath, identity);
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(join(root, 'status', 'tasks.jsonl'), `${JSON.stringify({ id: 1 })}\n`, 'utf-8');
    const response: DaemonStatusRpcResponse = {
      uptime: 10,
      watched_tasks: 2,
      registry_unreadable_records: 0,
      registry_bytes: 777_777,
      registry_records: 8_888,
      registry_tasks: 999,
      pid: identity.pid,
      startedAt: identity.startedAt,
      socketPath: identity.socketPath,
      build: identity.build.hash,
      buildFiles: identity.build.files,
      buildNewestMtimeMs: identity.build.newestMtimeMs,
    };
    const output = new Capture();

    const code = await cmdDaemon(['daemon', 'status', '--socket', socketPath], {
      stdout: output.stdout as never,
      stderr: output.stderr as never,
      distDir,
      controls: {
        sendRpc: async () => response,
        findSocketOwnerPid: () => process.pid,
      },
    });

    expect(code, output.error()).toBe(0);
    expect(output.output()).toContain('registry_bytes: 777777');
    expect(output.output()).toContain('registry_records: 8888');
    expect(output.output()).toContain('registry_tasks: 999');
    expect(output.error()).toBe('');
  });
});

class Capture {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly out: Buffer[] = [];
  private readonly err: Buffer[] = [];

  constructor() {
    this.stdout.on('data', (chunk) => this.out.push(Buffer.from(chunk)));
    this.stderr.on('data', (chunk) => this.err.push(Buffer.from(chunk)));
  }

  output(): string { return Buffer.concat(this.out).toString('utf-8'); }
  error(): string { return Buffer.concat(this.err).toString('utf-8'); }
}
