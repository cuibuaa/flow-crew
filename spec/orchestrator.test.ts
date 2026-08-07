import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  buildCommand,
  NodeSystemd,
  Orchestrator,
  type GitAdapter,
  type SupervisorBackend,
  type UnitStatus,
} from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import {
  activeRunsByProject,
  claimLaunchIntent,
  findParkedRunForProject,
  invalidateRunLockCache,
  releaseLaunchIntent,
  writeSchedulerProcessIdentity,
  processStartTimeTicks,
} from '../src/run-lock.js';
import { recordRequest, resolveRequest } from '../src/inbox.js';
import { supervisionPaths } from '../src/supervision.js';
import {
  fcGlobalDir,
  initializeReservedRun,
  readRunReservation,
  readRunState,
  runsRoot,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

let tempDir: string;
let registry: TaskRegistry;
const ACTIVE_UNIT: UnitStatus = { kind: 'active' };
const CLEAN_UNIT_EXIT: UnitStatus = { kind: 'terminal', exitCode: 0 };
const FAILED_UNIT_EXIT: UnitStatus = { kind: 'terminal', exitCode: 1 };
let systemd: FakeSystemd;
let git: FakeGit;
let orchestrator: Orchestrator;
let clock: number;
let busyProject: string | null;
let realFcHome: string;

/** Advance the injected clock past any deferred-queue backoff window. */
const advance = (ms: number) => { clock += ms; };

function admittedBrief(brief_text: string) {
  const report = inspectBrief(brief_text);
  return {
    brief_text,
    brief_admission: createBriefAdmission(report, {
      kind: 'explicit' as const,
      source: 'cli_current_input_flag' as const,
      at: '2026-07-30T00:00:00.000Z',
    }),
  };
}

beforeAll(() => {
  realFcHome = fcGlobalDir();
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-orch-${randomBytes(4).toString('hex')}-`));
  clock = Date.parse('2026-07-30T00:00:00.000Z');
  setFcGlobalDir(join(tempDir, 'fc-home'));
  invalidateRunLockCache();
  registry = new TaskRegistry({ baseDir: tempDir, now: () => new Date(clock) });
  systemd = new FakeSystemd();
  git = new FakeGit();
  busyProject = null;
  orchestrator = new Orchestrator({
    registry, systemd, git, cliPath: '/tmp/flowcrew-cli.js',
    now: () => new Date(clock),
    // Never touch the developer's real ~/.fc/runs from a unit test.
    isProjectBusy: (projectDir) => (busyProject === projectDir ? 'run-x' : null),
  });
});

afterEach(() => {
  invalidateRunLockCache();
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(realFcHome);
});

function writeRun(
  runId: string,
  status: string,
  parked?: { requestId?: string; pausedAt?: string },
  failureReason?: string,
): string {
  const dir = join(runsRoot(), runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    runId,
    projectDir: tempDir,
    status,
    ...(parked ? { parked } : {}),
    ...(failureReason ? { failureReason } : {}),
  }, null, 2), 'utf-8');
  return dir;
}

function addPendingApproval(runId: string, requestId: string): void {
  recordRequest({
    runId,
    projectDir: tempDir,
    requestId,
    action: 'deploy',
    target: 'test-target',
    risk: 'external',
    title: 'approval fixture',
    createdAt: new Date(clock).toISOString(),
  });
}

describe('Orchestrator', () => {
  it('reports registry corruption in daemon status without hiding readable active tasks', () => {
    registry.create({ brief_text: 'visible task', projectDir: tempDir });
    appendFileSync(registry.registryPath, '{broken registry row\n', 'utf-8');

    expect(orchestrator.status()).toMatchObject({
      watched_tasks: 1,
      registry_unreadable_records: 1,
    });
  });

  describe('buildCommand campaign ownership', () => {
    it.each([
      {
        name: '--campaign X',
        launchArgs: ['--campaign', 'X'],
        expectedToken: "'--campaign'",
      },
      {
        name: '--no-campaign',
        launchArgs: ['--no-campaign'],
        expectedToken: "'--no-campaign'",
      },
      {
        name: '--campaign-context=skip',
        launchArgs: ['--campaign-context=skip'],
        expectedToken: "'--campaign-context=skip'",
      },
      {
        name: '--campaign-context=inherit',
        launchArgs: ['--campaign-context=inherit'],
        expectedToken: "'--campaign-context=inherit'",
      },
      {
        name: 'legacy --no-inherit-campaign alias',
        launchArgs: ['--no-inherit-campaign'],
        expectedToken: "'--no-inherit-campaign'",
      },
    ])('passes through $name exactly once', ({ launchArgs, expectedToken }) => {
      const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir, launch_args: launchArgs });
      const command = buildCommand(task, '/tmp/flowcrew-cli.js');

      expect(command.split(expectedToken)).toHaveLength(2);
    });

    it('does not invent any campaign flag when launch args express none', () => {
      const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir, launch_args: [] });
      const command = buildCommand(task, '/tmp/flowcrew-cli.js');

      expect(command).not.toContain("'--campaign'");
      expect(command).not.toContain("'--no-campaign'");
      expect(command).not.toContain("'--campaign-context=inherit'");
      expect(command).not.toContain("'--campaign-context=skip'");
      expect(command).not.toContain("'--no-inherit-campaign'");
    });

    it('uses the daemon absolute Node interpreter instead of a PATH-dependent node word', () => {
      const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir });
      const command = buildCommand(task, '/tmp/flowcrew-cli.js');

      expect(command.startsWith(`'${process.execPath}' '/tmp/flowcrew-cli.js'`)).toBe(true);
      expect(command.startsWith("'node' ")).toBe(false);
    });
  });

  it('records active ticks and marks pending tasks running', async () => {
    const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir });
    systemd.states.set(task.systemd_unit, ACTIVE_UNIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('running');
    expect(registry.readRecentTicks(task.id).some((l) => l.includes('status=active'))).toBe(true);
  });

  it('marks inactive tasks done when a matching commit and artifacts exist', async () => {
    writeFileSync(join(tempDir, 'result.txt'), 'ok', 'utf-8');
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'task_summary.md'), validSummary(), 'utf-8');
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running', commit_prefix: 'feat(x)', expected_artifacts: ['result.txt'] });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);
    git.commit = 'abc123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'done',
      completing_commit: 'abc123',
      summary_verdict: 'PASS',
      summary_one_liner: 'The task completed with an operator-readable summary.',
      summary_source: join(tempDir, 'docs', 'task_summary.md'),
    });
  });

  it('marks inactive tasks needs_summary when summary is missing', async () => {
    writeFileSync(join(tempDir, 'result.txt'), 'ok', 'utf-8');
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running', commit_prefix: 'feat(x)', expected_artifacts: ['result.txt'] });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);
    git.commit = 'abc123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'needs_summary', completing_commit: 'abc123' });
    expect(registry.get(task.id)?.notes).toContain('task_summary.md not found');
    expect(registry.readRecentTicks(task.id).at(-1)).toContain('status=needs_summary');
  });

  it('marks inactive tasks needs_summary when summary is malformed', async () => {
    writeFileSync(join(tempDir, 'result.txt'), 'ok', 'utf-8');
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'task_summary.md'), '# Task Summary\n\n**Verdict**: SUCCESS\n', 'utf-8');
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running', commit_prefix: 'feat(x)', expected_artifacts: ['result.txt'] });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);
    git.commit = 'abc123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('needs_summary');
    expect(registry.get(task.id)?.notes).toContain('task_summary.md malformed');
    expect(registry.get(task.id)?.notes).toContain('invalid verdict: SUCCESS');
  });

  it('loads task summaries from a configured expected summary directory', async () => {
    writeFileSync(join(tempDir, 'result.txt'), 'ok', 'utf-8');
    mkdirSync(join(tempDir, 'summaries'), { recursive: true });
    writeFileSync(join(tempDir, 'summaries', 'task_summary.md'), validSummary('ESCALATE'), 'utf-8');
    const task = registry.create({
      brief_text: 'task',
      projectDir: tempDir,
      status: 'running',
      commit_prefix: 'feat(x)',
      expected_artifacts: ['result.txt'],
      expected_summary_path: 'summaries',
    });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);
    git.commit = 'abc123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'done', summary_verdict: 'ESCALATE' });
  });

  it('marks inactive tasks stuck when commit exists but artifacts are missing', async () => {
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running', commit_prefix: 'feat(x)', expected_artifacts: ['missing.txt'] });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);
    git.commit = 'abc123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('stuck');
    expect(registry.get(task.id)?.notes).toContain('missing artifacts');
  });

  it('retries inactive tasks with no commit until retry budget is exhausted', async () => {
    const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir, status: 'running', max_retries: 2 });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);

    await orchestrator.tickOnce();

    // A retry is QUEUED with backoff, not relaunched inline (a crash-looping
    // task used to re-spawn on every sweep with no spacing).
    expect(registry.get(task.id)?.status).toBe('deferred');
    expect(systemd.runs.length).toBe(0);

    advance(60_000);
    await orchestrator.tickOnce();

    const retried = registry.get(task.id)!;
    expect(retried.attempt).toBe(2);
    expect(retried.systemd_unit).toBe('flowcrew-task-1-attempt-2.service');
    expect(systemd.runs.at(-1)?.unit).toBe('flowcrew-task-1-attempt-2.service');

    systemd.states.set(retried.systemd_unit, CLEAN_UNIT_EXIT);
    await orchestrator.tickOnce();
    advance(120_000);
    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('stuck');
  });

  it('relaunches failed tasks and then marks stuck after budget', async () => {
    const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir, status: 'running', max_retries: 2 });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();
    expect(registry.get(task.id)?.status).toBe('deferred');

    advance(60_000);
    await orchestrator.tickOnce();

    const retried = registry.get(task.id)!;
    expect(retried.attempt).toBe(2);
    expect(retried.systemd_unit).toContain('attempt-2');

    systemd.states.set(retried.systemd_unit, FAILED_UNIT_EXIT);
    await orchestrator.tickOnce();
    advance(120_000);
    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('stuck');
  });

  it.each([
    ['failed', 'failed'],
    ['reality_gate_failed', 'reality_gate_failed'],
    ['escalated', 'failed'],
    ['incomplete', 'failed'],
    ['stopped', 'failed'],
  ] as const)('settles a %s bound run when systemd reports failed without relaunching', async (runStatus, taskStatus) => {
    const runId = `terminal-${runStatus}`;
    writeRun(runId, runStatus);
    const task = registry.create({
      brief_text: 'must not replay',
      projectDir: tempDir,
      status: 'running',
      run_id: runId,
    });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: taskStatus,
      notes: `bound run ${runId} ended ${runStatus}`,
    });
    expect(systemd.runs).toHaveLength(0);
  });

  it.each(['running', 'parked'])('waits for a readable %s bound run when its unit reports failed', async (runStatus) => {
    const runId = `bound-${runStatus}`;
    writeRun(runId, runStatus);
    const task = registry.create({
      brief_text: 'must not replay',
      projectDir: tempDir,
      status: 'running',
      run_id: runId,
    });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'deferred', attempt: 1, run_id: runId });
    expect(systemd.runs).toHaveLength(0);
  });

  it('fails closed when a known run binding is unreadable and not a reservation', async () => {
    const task = registry.create({
      brief_text: 'must not replay',
      projectDir: tempDir,
      status: 'running',
      run_id: 'missing-bound-run',
    });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'stuck', attempt: 1 });
    expect(registry.get(task.id)?.notes).toContain('refusing to replay brief');
    expect(systemd.runs).toHaveLength(0);
  });

  it('settles a terminal bound run from the inactive-unit path without retrying', async () => {
    const runId = 'inactive-incomplete';
    writeRun(runId, 'incomplete');
    const task = registry.create({
      brief_text: 'must not replay',
      projectDir: tempDir,
      status: 'running',
      run_id: runId,
    });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'failed',
      notes: `bound run ${runId} ended incomplete`,
    });
    expect(systemd.runs).toHaveLength(0);
  });

  it('registers and cancels a launched task', async () => {
    mkdirSync(join(tempDir, 'project'), { recursive: true });
    const task = await orchestrator.register({ ...admittedBrief('task'), projectDir: join(tempDir, 'project') });

    expect(systemd.runs[0].unit).toBe('flowcrew-task-1.service');
    expect(registry.get(task.id)?.status).toBe('running');

    await orchestrator.cancel(task.id);

    expect(systemd.stopped).toEqual(['flowcrew-task-1.service']);
    expect(registry.get(task.id)?.status).toBe('cancelled');
  });

  it('binds a reserved run before launch and passes the daemon-owned existing id to the CLI', async () => {
    let release!: () => void;
    systemd.runGate = new Promise<void>((resolve) => { release = resolve; });

    const registering = orchestrator.register({
      ...admittedBrief('task'),
      projectDir: tempDir,
      launch_args: ['--existing-run-id', 'caller-must-not-win'],
    });
    await Promise.resolve();

    const bound = registry.get(1);
    expect(bound?.run_id).toBeTruthy();
    expect(readRunReservation(tempDir, bound!.run_id!, clock)).toMatchObject({ runId: bound!.run_id });
    expect(systemd.runs[0].command).toContain(`'--existing-run-id' '${bound!.run_id}'`);
    expect(systemd.runs[0].command).not.toContain('caller-must-not-win');

    initializeReservedRun(tempDir, bound!.run_id!, 'test', 'name: test', []);
    expect(readRunState(tempDir, bound!.run_id!).status).toBe('running');
    expect(readRunReservation(tempDir, bound!.run_id!, clock)).toBeUndefined();
    release();
    await registering;
  });

  it('auto-binds an unbound registration and settles its terminal run without a second launch', async () => {
    const task = await orchestrator.register({
      ...admittedBrief('must not replay after terminal reality gate'),
      projectDir: tempDir,
    });

    expect(task.run_id).toBeTruthy();
    expect(readRunReservation(tempDir, task.run_id!, clock)).toMatchObject({ runId: task.run_id });
    expect(systemd.runs).toHaveLength(1);
    expect(systemd.runs[0].command).toContain(`'--existing-run-id' '${task.run_id}'`);

    initializeReservedRun(tempDir, task.run_id!, 'test', 'name: test', []);
    const terminal = readRunState(tempDir, task.run_id!);
    terminal.status = 'reality_gate_failed';
    writeRunState(tempDir, task.run_id!, terminal);
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'reality_gate_failed',
      attempt: 1,
      run_id: task.run_id,
      notes: `bound run ${task.run_id} ended reality_gate_failed`,
    });
    expect(systemd.runs).toHaveLength(1);
  });

  it('retries a genuine early crash while the bound run is still an uninitialized reservation', async () => {
    const task = await orchestrator.register({ ...admittedBrief('task'), projectDir: tempDir });
    const reservedRunId = task.run_id!;
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'deferred',
      attempt: 1,
      run_id: reservedRunId,
      defer_kind: 'retry',
    });

    advance(31_000);
    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'running',
      attempt: 2,
      run_id: reservedRunId,
      systemd_unit: `flowcrew-task-${task.id}-attempt-2.service`,
    });
    expect(systemd.runs).toHaveLength(2);
  });

  it('does not launch when persisting the reserved run association fails', async () => {
    const update = registry.update.bind(registry);
    registry.update = ((id, patch) => {
      if (typeof patch.run_id === 'string') throw new Error('injected bind failure');
      return update(id, patch);
    }) as typeof registry.update;
    const guarded = new Orchestrator({
      registry, systemd, git, cliPath: '/tmp/flowcrew-cli.js',
      now: () => new Date(clock),
      isProjectBusy: () => null,
    });

    const task = await guarded.register({ ...admittedBrief('task'), projectDir: tempDir });

    expect(task.status).toBe('stuck');
    expect(task.notes).toContain('could not reserve and bind run before launch');
    expect(registry.readRecentTicks(task.id)).toContainEqual(
      expect.stringContaining('status=stuck could not reserve and bind run before launch'),
    );
    expect(systemd.runs).toHaveLength(0);
  });

  it('leaves legacy done tasks without summary fields readable', async () => {
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'done' });

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({ status: 'done' });
    expect(registry.get(task.id)?.summary_verdict).toBeUndefined();
  });
});

function validSummary(verdict = 'PASS'): string {
  return `# Task Summary

**Verdict**: ${verdict}

## What was achieved
The task completed with an operator-readable summary.

## Key numbers
- 1 completion path verified

## Files produced
- result.txt

## What operator should do next
Review the summary in task show.
`;
}

class FakeSystemd implements SupervisorBackend {
  states = new Map<string, UnitStatus>();
  runs: { unit: string; command: string }[] = [];
  stopped: string[] = [];
  runGate?: Promise<void>;

  async isActive(unit: string): Promise<UnitStatus> {
    return this.states.get(unit) ?? { kind: 'absent' };
  }

  async runUnit(opts: { unit: string; command: string }): Promise<void> {
    this.runs.push({ unit: opts.unit, command: opts.command });
    if (this.runGate) await this.runGate;
    this.states.set(opts.unit, ACTIVE_UNIT);
  }

  async stopUnit(unit: string): Promise<void> {
    this.stopped.push(unit);
    this.states.set(unit, CLEAN_UNIT_EXIT);
  }

  async journalTail(): Promise<string> {
    return 'journal';
  }
}

describe('Orchestrator queue policies (skip-on-overlap / backoff / catch-up)', () => {
  it('invalidates the run probe cache before register admission', async () => {
    activeRunsByProject();
    const runPath = writeRun('just-started', 'running');
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, 'just-started');
    const diskOrchestrator = new Orchestrator({
      registry, systemd, git, cliPath: '/tmp/flowcrew-cli.js',
      now: () => new Date(clock),
    });

    const task = await diskOrchestrator.register({ ...admittedBrief('second task'), projectDir: tempDir });

    expect(task.status).toBe('deferred');
    expect(systemd.runs).toHaveLength(0);
  });

  it('invalidates the run probe cache before draining a queued task', async () => {
    const task = registry.create({ brief_text: 'queued task', projectDir: tempDir, status: 'deferred' });
    activeRunsByProject();
    const runPath = writeRun('started-before-drain', 'running');
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, 'started-before-drain');
    const diskOrchestrator = new Orchestrator({
      registry, systemd, git, cliPath: '/tmp/flowcrew-cli.js',
      now: () => new Date(clock),
    });

    await diskOrchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('deferred');
    expect(systemd.runs).toHaveLength(0);
  });

  it('honors a cross-instance launch intent before run.json exists, then releases it after TTL', async () => {
    expect(claimLaunchIntent(tempDir, 'other-path-run', clock).claimed).toBe(true);
    const secondInstance = new Orchestrator({
      registry, systemd, git, cliPath: '/tmp/flowcrew-cli.js',
      now: () => new Date(clock),
      isProjectBusy: () => null,
    });

    const deferred = await secondInstance.register({ ...admittedBrief('second task'), projectDir: tempDir });

    expect(deferred).toMatchObject({ status: 'deferred', attempt: 1 });
    expect(deferred.defer_reason).toContain('other-path-run');
    expect(systemd.runs).toHaveLength(0);

    advance(61_000);
    const afterTtl = await secondInstance.register({ ...admittedBrief('after ttl'), projectDir: tempDir });
    expect(afterTtl.status).toBe('running');
    expect(systemd.runs).toHaveLength(1);
    releaseLaunchIntent(tempDir, afterTtl.run_id!);
  });

  it('defers instead of launching into a busy project, and never spends an attempt', async () => {
    busyProject = tempDir;
    const task = await orchestrator.register({ ...admittedBrief('task'), projectDir: tempDir });

    expect(task.status).toBe('deferred');
    expect(task.attempt).toBe(1);            // waiting is not a failure
    expect(systemd.runs.length).toBe(0);     // no unit spawned into the conflict
    expect(task.defer_reason).toContain('project busy');
  });

  it('drains the deferred queue once the project frees up', async () => {
    busyProject = tempDir;
    const task = await orchestrator.register({ ...admittedBrief('task'), projectDir: tempDir });

    advance(60_000);
    await orchestrator.tickOnce();
    expect(registry.get(task.id)?.status).toBe('deferred');   // still busy

    busyProject = null;
    advance(60_000);
    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('running');
    expect(systemd.runs.at(-1)?.unit).toBe(task.systemd_unit);
    expect(registry.get(task.id)?.attempt).toBe(1);           // still no attempt spent
  });

  it('a unit that died on a project conflict is re-queued, not counted as a crash', async () => {
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running', max_retries: 2 });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);
    busyProject = tempDir;                                     // the sibling that killed it is still live

    await orchestrator.tickOnce();

    const after = registry.get(task.id)!;
    expect(after.status).toBe('deferred');
    expect(after.attempt).toBe(1);                             // budget intact
    expect(after.defer_reason).toContain('project busy');
  });

  it('does not consume an attempt when the bound run records a single-in-flight collision', async () => {
    const runId = 'guard-collision';
    writeRun(runId, 'failed', undefined, 'Single-in-flight: another active run exists');
    const task = registry.create({
      ...admittedBrief('task'),
      projectDir: tempDir,
      status: 'running',
      run_id: runId,
      max_retries: 2,
    });
    registry.update(task.id, { started_at: new Date(clock).toISOString() });
    systemd.states.set(task.systemd_unit, FAILED_UNIT_EXIT);

    await orchestrator.tickOnce();

    const waiting = registry.get(task.id)!;
    expect(waiting).toMatchObject({ status: 'deferred', attempt: 1, defer_kind: 'wait' });
    expect(waiting.run_id).toBeUndefined();
    expect(systemd.runs).toHaveLength(0);

    advance(31_000);
    await orchestrator.tickOnce();

    const relaunched = registry.get(task.id)!;
    expect(relaunched).toMatchObject({ status: 'running', attempt: 1 });
    expect(relaunched.run_id).toBeTruthy();
    expect(relaunched.run_id).not.toBe(runId);
    expect(relaunched.systemd_unit).not.toBe(task.systemd_unit);
    expect(systemd.runs).toHaveLength(1);
  });

  it('adopts an already-live unit instead of double-launching it', async () => {
    // Daemon died between launch and the status write: task looks never-launched.
    const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir });
    systemd.states.set(task.systemd_unit, ACTIVE_UNIT);

    await orchestrator.tickOnce();

    expect(systemd.runs.length).toBe(0);                       // no second spawn
    expect(registry.get(task.id)?.status).toBe('running');
    expect(registry.readRecentTicks(task.id).some((l) => l.includes('adopted live unit'))).toBe(true);
  });

  it('is reentrancy-guarded: an overlapping sweep cannot double-launch', async () => {
    const task = registry.create({ ...admittedBrief('task'), projectDir: tempDir });
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);

    await Promise.all([orchestrator.tickOnce(), orchestrator.tickOnce()]);

    expect(systemd.runs.filter((r) => r.unit === task.systemd_unit).length).toBe(1);
    expect(registry.get(task.id)?.status).toBe('running');
  });

  it('publishes register launch ownership before await so a concurrent tick cannot double-launch (M4)', async () => {
    let release!: () => void;
    systemd.runGate = new Promise<void>((resolve) => { release = resolve; });

    const registering = orchestrator.register({ ...admittedBrief('task'), projectDir: tempDir });
    await Promise.resolve();
    expect(systemd.runs).toHaveLength(1);
    expect(registry.get(1)?.status).toBe('running');

    await orchestrator.tickOnce();
    expect(systemd.runs).toHaveLength(1);

    release();
    const task = await registering;
    expect(task.status).toBe('running');
    expect(systemd.runs.filter((run) => run.unit === task.systemd_unit)).toHaveLength(1);
  });

  it('two queued tasks for the same project do not both launch in one sweep', async () => {
    const a = registry.create({ ...admittedBrief('a'), projectDir: tempDir });
    const b = registry.create({ ...admittedBrief('b'), projectDir: tempDir });
    systemd.states.set(a.systemd_unit, CLEAN_UNIT_EXIT);
    systemd.states.set(b.systemd_unit, CLEAN_UNIT_EXIT);

    await orchestrator.tickOnce();

    expect(systemd.runs.length).toBe(1);
    expect(registry.get(a.id)?.status).toBe('running');
    expect(registry.get(b.id)?.status).toBe('deferred');
  });

  it('uses created_at for never-started tasks so an older parked run cannot pin them (H2)', async () => {
    const task = registry.create({ ...admittedBrief('fresh task'), projectDir: tempDir });
    writeRun('old-park', 'parked', {
      requestId: 'old-request',
      pausedAt: '2026-07-29T23:59:59.000Z',
    });
    addPendingApproval('old-park', 'old-request');
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);

    expect(findParkedRunForProject(tempDir)).toBeNull();
    await orchestrator.tickOnce();

    expect(registry.get(task.id)?.status).toBe('running');
    expect(systemd.runs).toHaveLength(1);
  });

  it('rejects parked records without pausedAt and ignores already-resolved requests (H2)', () => {
    writeRun('no-paused-at', 'parked', { requestId: 'missing-time' });
    addPendingApproval('no-paused-at', 'missing-time');

    writeRun('resolved-park', 'parked', {
      requestId: 'resolved-request',
      pausedAt: '2026-07-30T00:00:01.000Z',
    });
    addPendingApproval('resolved-park', 'resolved-request');
    expect(resolveRequest(tempDir, 'resolved-park', 'resolved-request', 'approve', { by: 'test' }).won).toBe(true);

    expect(findParkedRunForProject(tempDir, '2026-07-30T00:00:00.000Z')).toBeNull();
  });

  it('gives approval deferrals a bounded recheck window (H2)', async () => {
    const task = registry.create({ brief_text: 'task', projectDir: tempDir, status: 'running' });
    registry.update(task.id, { started_at: new Date(clock).toISOString() });
    writeRun('approval-park', 'parked', {
      requestId: 'approval-request',
      pausedAt: '2026-07-30T00:00:01.000Z',
    });
    addPendingApproval('approval-park', 'approval-request');
    systemd.states.set(task.systemd_unit, CLEAN_UNIT_EXIT);

    await orchestrator.tickOnce();
    const first = registry.get(task.id)!;
    expect(first).toMatchObject({ status: 'deferred', run_id: 'approval-park', defer_kind: 'wait' });
    expect(Date.parse(first.not_before!)).toBeGreaterThan(clock);
    expect(systemd.runs).toHaveLength(0);

    const firstCheck = first.not_before!;
    advance(31_000);
    await orchestrator.tickOnce();
    const second = registry.get(task.id)!;
    expect(second.status).toBe('deferred');
    expect(Date.parse(second.not_before!)).toBeGreaterThan(Date.parse(firstCheck));
    expect(systemd.runs).toHaveLength(0);
  });

  it('defers a readable running bound run instead of starting a new run (C2)', async () => {
    const runId = 'bound-running';
    writeRun(runId, 'running');
    const task = registry.create({
      brief_text: 'must not relaunch',
      projectDir: tempDir,
      status: 'deferred',
      run_id: runId,
    });
    registry.update(task.id, { started_at: new Date(clock).toISOString() });

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'deferred',
      run_id: runId,
    });
    expect(registry.get(task.id)?.defer_reason).toContain('waiting for existing run');
    expect(systemd.runs).toHaveLength(0);
  });

  it('reconciles a terminal bound run through completion without launching (C2)', async () => {
    const runId = 'bound-complete';
    const runPath = writeRun(runId, 'complete');
    writeFileSync(join(runPath, 'task_summary.md'), validSummary(), 'utf-8');
    const task = registry.create({
      brief_text: 'must not relaunch',
      projectDir: tempDir,
      status: 'deferred',
      run_id: runId,
      commit_prefix: 'feat(done)',
    });
    registry.update(task.id, {
      started_at: new Date(clock).toISOString(),
      not_before: new Date(clock + 600_000).toISOString(),
    });
    git.commit = 'terminal123';

    await orchestrator.tickOnce();

    expect(registry.get(task.id)).toMatchObject({
      status: 'done',
      completing_commit: 'terminal123',
      summary_source: join(runPath, 'task_summary.md'),
    });
    expect(systemd.runs).toHaveLength(0);
  });
});

class FakeGit implements GitAdapter {
  commit: string | undefined;
  dirty = false;

  async findCommitByPrefix(): Promise<string | undefined> {
    return this.commit;
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return this.dirty;
  }

  async findCommitSince(): Promise<{ sha: string; subject: string } | undefined> {
    return this.commit ? { sha: this.commit, subject: 'commit' } : undefined;
  }
}

describe('portable log tail snapshots', () => {
  it('derives the tail output and byte cursor from one UTF-8 file snapshot', async () => {
    const baseDir = join(tempDir, 'snapshot-backend');
    const unit = 'flowcrew-task-42.service';
    const paths = supervisionPaths(baseDir, unit);
    const log = 'older line\n雪と🙂 latest\n';
    mkdirSync(paths.unitDir, { recursive: true });
    writeFileSync(paths.log, log, 'utf-8');

    const snapshot = await new NodeSystemd(baseDir).tailSnapshot(unit, 1);

    expect(snapshot).toEqual({
      output: '雪と🙂 latest\n',
      source: {
        kind: 'file',
        path: paths.log,
        offset: Buffer.byteLength(log),
      },
    });
    expect(Buffer.byteLength(log)).toBeGreaterThan(log.length);
  });
});

describe('fallback stop binds the pid to a process identity', () => {
  // The fallback path exists because `systemd-run` can be unavailable. Before this binding it
  // signalled whatever pid the record held with no evidence the pid was still that child, and
  // the kernel reuses pids, so the target could be any process — including the operator's. The
  // removed line was an unconditional `process.kill(fallbackPid, 'SIGTERM')`.
  //
  // Proving "a live bystander is not killed" needs a real process, which `spec/` may not spawn
  // (see spec/purity.ts `child-process`; CI runs this suite with no host dependencies). The
  // machine-independent half is proven here instead: the refusal is recorded, and the recorded
  // reason is a field the previous code never wrote, so a regression is visible even against a
  // pid that does not exist. The live-process proof lives in `tests/`, which may use the host.
  const unit = 'flowcrew-task-999999.service';
  const NONEXISTENT_PID = 0x7ffffff0;
  let base: string;
  let systemd: NodeSystemd;
  let recordPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'p4-m2-'));
    systemd = new NodeSystemd(base);
    recordPath = join(base, 'systemd-fallback', `${unit}.json`);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // `systemctl stop` fails for a unit that was never loaded, and the unverifiable paths
  // deliberately surface that failure rather than reporting a silent success.
  const stop = async (): Promise<void> => {
    try { await systemd.stopUnit(unit); } catch { /* expected: unit not loaded */ }
  };

  it('records a refusal for a pid captured before start times existed', async () => {
    writeFileSync(recordPath, JSON.stringify({ pid: NONEXISTENT_PID, state: 'active', command: 'x' }));
    await stop();
    const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
    expect(record.unverifiedPid).toBe(NONEXISTENT_PID);
    expect(String(record.reason)).toContain('predates start-time binding');
  });

  it('records a refusal when the recorded start time no longer matches the pid', async () => {
    writeFileSync(recordPath, JSON.stringify({
      pid: NONEXISTENT_PID, state: 'active', command: 'x', startTimeTicks: '1',
    }));
    await stop();
    expect(String(JSON.parse(readFileSync(recordPath, 'utf-8')).reason)).toContain('recycled pid');
  });

  it('keeps the identity in the record it rewrites while deactivating', () => {
    // `stopUnit` must not drop `startTimeTicks` when it rewrites the record, or the next stop
    // would find an unverifiable pid and refuse — turning one guard into a dead end.
    const source = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf-8');
    const deactivating = source.slice(source.indexOf("state: 'deactivating'") - 400, source.indexOf("state: 'deactivating'") + 200);
    expect(deactivating).toContain('startTimeTicks');
  });

  it('persists an inactive terminal record when a read observes that the child is gone', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = base;
    try {
      writeFileSync(recordPath, JSON.stringify({
        pid: NONEXISTENT_PID,
        state: 'active',
        command: 'x',
        startTimeTicks: '1',
      }));

      await expect(systemd.isActive(unit)).resolves.toEqual({
        kind: 'terminal-unknown',
        reason: 'fallback process ended without an exit status',
      });
      expect(JSON.parse(readFileSync(recordPath, 'utf-8'))).toMatchObject({
        pid: NONEXISTENT_PID,
        state: 'inactive',
        command: 'x',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('consumes an asynchronous fallback spawn error and persists the named launch failure', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = base;
    const failedUnit = 'flowcrew-task-spawn-error.service';
    const failedRecordPath = join(base, 'systemd-fallback', `${failedUnit}.json`);
    try {
      const missingShell = join(base, 'missing-shell');
      const backend = new NodeSystemd(base, { shellPath: missingShell });
      await backend.runUnit({ unit: failedUnit, workingDirectory: base, command: "'ignored'" });

      let record: Record<string, unknown> = {};
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { record = JSON.parse(readFileSync(failedRecordPath, 'utf-8')) as Record<string, unknown>; } catch {}
        if (record.state === 'failed') break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(record.state).toBe('failed');
      expect(String(record.reason)).toMatch(/fallback spawn failed:.*ENOENT/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
