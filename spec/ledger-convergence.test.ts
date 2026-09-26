import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import { readOperationalProjection } from '../src/cli-events.js';
import {
  parseLandArgs,
  runLand,
  type LandGitRequest,
  type LandGitResponse,
  type LandGitRunner,
} from '../src/cli-land.js';
import {
  FC_TASK_STATUSES,
  createEngineTaskRunResolver,
  publicTaskEntries,
  readTaskLedger,
  reconcileFcTask,
  renderFcTasks,
  type FcTaskEntry,
  type FcTaskRunResolution,
} from '../src/fc-tasks.js';
import { RUN_STATUS, TASK_STATUS, isTerminalRunStatus } from '../src/lifecycle-status.js';
import {
  clearAttemptSummaryRefreshDebounce,
  readRunEvents,
  recordRunEvent,
} from '../src/run-events.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

class Capture {
  output = '';
  error = '';
  stdout = { write: (chunk: string) => { this.output += chunk; } };
  stderr = { write: (chunk: string) => { this.error += chunk; } };
}

const BASE_COMMIT = 'a'.repeat(40);
const TOPIC_COMMIT = 'b'.repeat(40);
const originalGlobalDir = fcGlobalDir();
let root: string;

function task(
  id: string,
  status: FcTaskEntry['status'],
  flowcrewTaskId: number,
): FcTaskEntry {
  return {
    id,
    subject: `subject-${id}`,
    description: `description-${id}`,
    activeForm: `active-${id}`,
    status,
    blocks: [],
    blockedBy: [],
    flowcrewTaskId,
  };
}

function writeEntry(
  storeRoot: string,
  session: string,
  entry: FcTaskEntry,
  filename = `${entry.id}.json`,
): string {
  const directory = join(storeRoot, session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  return path;
}

function writeRun(
  engineRoot: string,
  runId: string,
  projectDir: string,
  status: string,
): string {
  const directory = join(engineRoot, 'runs', runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify({
    runId,
    workflowName: 'fixture',
    projectDir,
    baseCommit: BASE_COMMIT,
    status,
    stages: {},
    startedAt: '2030-01-01T00:00:00.000Z',
    completedAt: isTerminalRunStatus(status) ? '2030-01-01T00:01:00.000Z' : undefined,
  }, null, 2)}\n`, 'utf-8');
  return directory;
}

function writeEngineTask(
  engineRoot: string,
  id: number,
  projectDir: string,
  runId: string,
  status = 'done',
): void {
  mkdirSync(engineRoot, { recursive: true });
  appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({
    id,
    status,
    projectDir,
    run_id: runId,
  })}\n`, 'utf-8');
}

function seedRecordedLedger(): {
  storeRoot: string;
  engineRoot: string;
  session: string;
  entryPaths: string[];
} {
  const storeRoot = join(root, 'ledger');
  const engineRoot = join(root, 'engine');
  const session = 'recorded-session';
  const projectDir = join(root, 'recorded-project');
  mkdirSync(projectDir, { recursive: true });
  const entryPaths: string[] = [];
  for (let id = 1; id <= 9; id += 1) {
    const status = id <= 4 ? 'in_progress' : 'completed';
    const runStatus = id <= 3 ? 'stopped' : id === 4 ? 'running' : 'complete';
    const runId = `recorded-run-${id}`;
    entryPaths.push(writeEntry(storeRoot, session, task(String(id), status, id)));
    writeRun(engineRoot, runId, projectDir, runStatus);
    writeEngineTask(engineRoot, id, projectDir, runId, id === 4 ? 'running' : 'done');
  }
  return { storeRoot, engineRoot, session, entryPaths };
}

interface LandFixture {
  engineRoot: string;
  storeRoot: string;
  session: string;
  entryId: string;
  entryPath: string;
  taskId: number;
  runId: string;
  runDirectory: string;
  projectDir: string;
  primaryDir: string;
}

function seedLandFixture(status: FcTaskEntry['status'] = 'in_progress'): LandFixture {
  const engineRoot = join(root, 'land-engine');
  const storeRoot = join(root, 'land-ledger');
  const session = 'land-session';
  const entryId = 'land-entry';
  const taskId = 901;
  const runId = 'land-run';
  const projectDir = join(root, 'topic-worktree');
  const primaryDir = join(root, 'primary-worktree');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(primaryDir, { recursive: true });
  const runDirectory = writeRun(engineRoot, runId, projectDir, 'complete');
  writeEngineTask(engineRoot, taskId, projectDir, runId);
  const entryPath = writeEntry(storeRoot, session, task(entryId, status, taskId));
  setFcGlobalDir(engineRoot);
  return {
    engineRoot,
    storeRoot,
    session,
    entryId,
    entryPath,
    taskId,
    runId,
    runDirectory,
    projectDir,
    primaryDir,
  };
}

function landResponses(fixture: LandFixture): Record<LandGitRequest['operation'], LandGitResponse> {
  return {
    status: { exitCode: 0, stdout: '' },
    ignored: { exitCode: 0, stdout: '' },
    unpushed: { exitCode: 0, stdout: '' },
    at_risk: { exitCode: 0, stdout: '' },
    root: { exitCode: 0, stdout: `${fixture.projectDir}\n` },
    worktrees: {
      exitCode: 0,
      stdout: [
        `worktree ${fixture.primaryDir}`,
        `HEAD ${BASE_COMMIT}`,
        'branch refs/heads/main',
        '',
        `worktree ${fixture.projectDir}`,
        `HEAD ${TOPIC_COMMIT}`,
        'branch refs/heads/topic-work',
        '',
      ].join('\n'),
    },
    branch: { exitCode: 0, stdout: 'topic-work\n' },
    remove_worktree: { exitCode: 0 },
    prune_worktrees: { exitCode: 0 },
    delete_branch: { exitCode: 0 },
  };
}

function gitRunner(
  fixture: LandFixture,
  options: {
    fail?: LandGitRequest['operation'];
    before?: (request: LandGitRequest) => void;
  } = {},
): ReturnType<typeof vi.fn<LandGitRunner>> {
  const responses = landResponses(fixture);
  return vi.fn<LandGitRunner>((request) => {
    options.before?.(request);
    if (request.operation === options.fail) {
      return { exitCode: 1, stderr: `${request.operation} fixture failure` };
    }
    return responses[request.operation];
  });
}

function landArguments(fixture: LandFixture, includeClosure = true): string[] {
  const args = [
    'land',
    '--run', fixture.runId,
    '--remove',
    '--acknowledge-regenerable=0',
  ];
  if (includeClosure) {
    args.push(
      '--complete-fc-task', fixture.entryId,
      '--fc-task-session', fixture.session,
      '--fc-tasks-root', fixture.storeRoot,
    );
  }
  return args;
}

function ledgerEntry(fixture: LandFixture): FcTaskEntry {
  const ledger = readTaskLedger(fixture.storeRoot, fixture.session);
  expect(ledger.state).toBe('ready');
  const entries = publicTaskEntries(ledger);
  expect(entries).toHaveLength(1);
  return entries[0];
}

function destructiveOperations(runner: ReturnType<typeof vi.fn<LandGitRunner>>): string[] {
  return runner.mock.calls
    .map(([request]) => request.operation)
    .filter((operation) => ['remove_worktree', 'prune_worktrees', 'delete_branch'].includes(operation));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-convergence-'));
});

afterEach(() => {
  clearAttemptSummaryRefreshDebounce();
  setFcGlobalDir(originalGlobalDir);
  rmSync(root, { recursive: true, force: true });
});

describe('ledger convergence projection', () => {
  it('replays the recorded nine-entry drift with labeled engine and ledger counts', () => {
    const fixture = seedRecordedLedger();
    const rendered = renderFcTasks({
      storeRoot: fixture.storeRoot,
      explicitSession: fixture.session,
      columns: 240,
      lines: 24,
      taskRunResolver: createEngineTaskRunResolver({ engineRoot: fixture.engineRoot }),
    });

    expect(rendered.text).toBe([
      'fc_tasks: 3 wrap-up overdue · engine 1 running · ledger 4 in progress, 0 pending, 5 done',
      '▶ wrap-up-overdue:run:stopped:#1 [1] active-1',
      '▶ wrap-up-overdue:run:stopped:#2 [2] active-2',
      '▶ wrap-up-overdue:run:stopped:#3 [3] active-3',
      '▶ run:running [4] active-4',
      '',
    ].join('\n'));
  });

  it('uses the same read-only projection for human and JSON reconciliation', () => {
    const fixture = seedRecordedLedger();
    const before = fixture.entryPaths.map((path) => readFileSync(path));
    const human = new Capture();
    const humanCode = cmdFcTasks([
      'fc_tasks', 'reconcile',
      '--session', fixture.session,
      '--store-root', fixture.storeRoot,
      '--engine-root', fixture.engineRoot,
    ], { stdin: '', env: {}, stdout: human.stdout, stderr: human.stderr });
    const json = new Capture();
    const jsonCode = cmdFcTasks([
      'fc_tasks', 'reconcile', '--json',
      '--session', fixture.session,
      '--store-root', fixture.storeRoot,
      '--engine-root', fixture.engineRoot,
    ], { stdin: '', env: {}, stdout: json.stdout, stderr: json.stderr });

    expect(humanCode).toBe(0);
    expect(human.output).toContain('3 disagreements · 0 not comparable · 6 aligned');
    expect(human.output).toContain('WRAP_UP_REQUIRED [1]');
    expect(human.output).toContain('ALIGNED [4] ledger=in_progress · engine=run:running:recorded-run-4');
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({
      version: 1,
      counts: { entries: 9, disagreements: 3, notComparable: 0, aligned: 6 },
    });
    expect(fixture.entryPaths.map((path) => readFileSync(path))).toEqual(before);
  });

  it('reports clean agreement and evidence gaps without inventing a disagreement', () => {
    const live = reconcileFcTask(
      task('live-control', 'in_progress', 1),
      {
        state: 'resolved',
        taskId: 1,
        taskStatus: TASK_STATUS.RUNNING,
        projectDir: root,
        runId: 'live-control-run',
        runStatus: RUN_STATUS.RUNNING,
      },
    );
    const closedWhileActive = reconcileFcTask(
      task('closed-active-control', 'completed', 2),
      {
        state: 'resolved',
        taskId: 2,
        taskStatus: TASK_STATUS.RUNNING,
        projectDir: root,
        runId: 'closed-active-control-run',
        runStatus: RUN_STATUS.RUNNING,
      },
    );
    const unlinked = reconcileFcTask(
      task('unlinked-control', 'in_progress', 3),
      { state: 'never_linked' },
    );

    expect(live).toMatchObject({
      comparison: 'aligned',
      recommendedAction: 'none',
      engine: { lifecycle: 'executing', running: true, terminal: false },
    });
    expect(closedWhileActive).toMatchObject({
      comparison: 'ledger_closed_engine_active',
      recommendedAction: 'inspect_active_work_then_reopen_or_stop',
    });
    expect(unlinked).toMatchObject({
      comparison: 'not_comparable',
      recommendedAction: 'link_entry_to_engine_task',
      authority: { linkage: 'not_verified' },
    });
  });

  it('executes every member of the derived two-account product', () => {
    const engineCases: FcTaskRunResolution[] = [
      ...Object.values(RUN_STATUS).map((runStatus, index): FcTaskRunResolution => ({
        state: 'resolved',
        taskId: index + 1,
        taskStatus: runStatus === RUN_STATUS.RUNNING ? TASK_STATUS.RUNNING : TASK_STATUS.DONE,
        projectDir: root,
        runId: `run-${index + 1}`,
        runStatus,
      })),
      {
        state: 'resolved', taskId: 100, taskStatus: TASK_STATUS.DONE,
        projectDir: root, runId: 'unknown-run', runStatus: 'future-status',
      },
      { state: 'never_linked' },
      { state: 'stale', taskId: 101, detail: 'known stale control' },
      { state: 'unavailable', taskId: 102, detail: 'known unavailable control' },
      ...Object.values(TASK_STATUS).map((taskStatus, index): FcTaskRunResolution => ({
        state: 'resolved',
        taskId: 200 + index,
        taskStatus,
        projectDir: root,
      })),
    ];
    const expectedEngineCases = Object.values(RUN_STATUS).length
      + 1 // one unknown run lifecycle
      + 3 // never-linked, stale, and unavailable evidence
      + Object.values(TASK_STATUS).length;
    expect(engineCases).toHaveLength(expectedEngineCases);

    const counts = {
      executed: 0,
      aligned: 0,
      wrap_up_required: 0,
      ledger_closed_engine_active: 0,
      not_comparable: 0,
      engineRunning: 0,
      oldLedgerRunning: 0,
    };
    for (const status of FC_TASK_STATUSES) {
      for (const resolution of engineCases) {
        const projection = reconcileFcTask(task(`${status}-${counts.oldLedgerRunning}`, status, 1), resolution);
        counts.executed += 1;
        counts[projection.comparison] += 1;
        if (projection.engine.running) counts.engineRunning += 1;
        if (status === 'in_progress') counts.oldLedgerRunning += 1;
      }
    }

    expect(counts).toEqual({
      executed: FC_TASK_STATUSES.length * expectedEngineCases,
      aligned: 31,
      wrap_up_required: 30,
      ledger_closed_engine_active: 8,
      not_comparable: 12,
      engineRunning: 6,
      oldLedgerRunning: 27,
    });
    expect(reconcileFcTask(
      task('known-positive', 'in_progress', 1),
      { state: 'resolved', taskId: 1, taskStatus: 'running', projectDir: root, runId: 'live', runStatus: 'running' },
    ).engine.running).toBe(true);
    expect(reconcileFcTask(
      task('known-negative', 'in_progress', 2),
      { state: 'resolved', taskId: 2, taskStatus: 'done', projectDir: root, runId: 'done', runStatus: 'complete' },
    ).engine.running).toBe(false);
    expect(reconcileFcTask(
      task('known-wrap-up-positive', 'in_progress', 3),
      { state: 'resolved', taskId: 3, taskStatus: 'done', projectDir: root, runId: 'done', runStatus: 'complete' },
    ).comparison).toBe('wrap_up_required');
    expect(reconcileFcTask(
      task('known-wrap-up-negative', 'in_progress', 4),
      { state: 'resolved', taskId: 4, taskStatus: 'running', projectDir: root, runId: 'live', runStatus: 'running' },
    ).comparison).toBe('aligned');
  });
});

describe('durable wrap-up obligation', () => {
  it('executes the full 182-transition matrix and surfaces the event operationally', () => {
    const engineRoot = join(root, 'event-engine');
    setFcGlobalDir(engineRoot);
    const priorStatuses: Array<string | undefined> = [undefined, ...Object.values(RUN_STATUS)];
    let transitionCount = 0;
    let obligationCount = 0;
    let positiveRunDirectory = '';
    let negativeRunDirectory = '';

    for (const [priorIndex, prior] of priorStatuses.entries()) {
      for (const [nextIndex, next] of Object.values(RUN_STATUS).entries()) {
        transitionCount += 1;
        const runId = `transition-${priorIndex}-${nextIndex}`;
        const runDirectory = writeRun(engineRoot, runId, root, next);
        if (prior !== undefined) {
          writeFileSync(join(runDirectory, 'run_event_status.json'), `${JSON.stringify({
            version: 1,
            status: prior,
            observedAt: '2030-01-01T00:00:00.000Z',
          })}\n`, 'utf-8');
        }
        recordRunEvent(root, runId, {
          type: 'campaign_alert',
          runId,
          timestamp: '2030-01-01T00:02:00.000Z',
          detail: 'later scheduler-owned record',
        }, { debounceMs: 60_000 });
        const obligations = readRunEvents(root, runId)
          .filter(({ type }) => type === 'operator_wrap_up_required');
        const expected = isTerminalRunStatus(next) && !isTerminalRunStatus(prior);
        expect(obligations).toHaveLength(expected ? 1 : 0);
        if (expected) obligationCount += 1;
        if (prior === RUN_STATUS.RUNNING && next === RUN_STATUS.COMPLETE) {
          positiveRunDirectory = runDirectory;
        }
        if (prior === RUN_STATUS.PENDING && next === RUN_STATUS.RUNNING) {
          negativeRunDirectory = runDirectory;
        }
      }
    }

    const nextStatuses = Object.values(RUN_STATUS);
    const terminalStatuses = nextStatuses.filter(isTerminalRunStatus);
    const nonterminalPriors = priorStatuses.filter((status) => !isTerminalRunStatus(status));
    expect(transitionCount).toBe(priorStatuses.length * nextStatuses.length);
    expect(obligationCount).toBe(nonterminalPriors.length * terminalStatuses.length);
    expect(readRunEvents(root, basename(positiveRunDirectory))
      .filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(1);
    expect(readRunEvents(root, basename(negativeRunDirectory))
      .filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(0);
    const projection = readOperationalProjection(positiveRunDirectory, { includeDrift: false });
    expect(projection.latestReason).toMatchObject({
      type: 'operator_wrap_up_required',
      detail: expect.stringContaining('terminal state is not acceptance'),
    });

    const positiveRunId = basename(positiveRunDirectory);
    recordRunEvent(root, positiveRunId, {
      type: 'campaign_alert',
      runId: positiveRunId,
      timestamp: '2030-01-01T00:03:00.000Z',
      detail: 'repeated observation',
    }, { debounceMs: 60_000 });
    expect(readRunEvents(root, positiveRunId)
      .filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(1);
  });
});

describe('explicit successful wrap-up closes one exact entry', () => {
  it('ends an unattended terminal session accurately without invoking reconciliation', async () => {
    const fixture = seedLandFixture();
    writeFileSync(join(fixture.runDirectory, 'run_event_status.json'), `${JSON.stringify({
      version: 1,
      status: RUN_STATUS.RUNNING,
      observedAt: '2030-01-01T00:00:00.000Z',
    })}\n`, 'utf-8');
    recordRunEvent(fixture.projectDir, fixture.runId, {
      type: 'run_completed',
      runId: fixture.runId,
      timestamp: '2030-01-01T00:02:00.000Z',
      detail: 'run completed while no renderer or reconciler was active',
    }, { debounceMs: 60_000 });

    expect(ledgerEntry(fixture).status).toBe('in_progress');

    const runner = gitRunner(fixture);
    const report = await runLand(landArguments(fixture), { git: runner });

    expect(report.state).toBe('removed');
    expect(report.fcTaskCompletion).toMatchObject({ state: 'completed', expectedRunId: fixture.runId });
    expect(destructiveOperations(runner)).toEqual([
      'remove_worktree', 'prune_worktrees', 'delete_branch',
    ]);
    expect(ledgerEntry(fixture).status).toBe('completed');
    expect(readRunEvents(fixture.projectDir, fixture.runId)
      .filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(1);
  });

  it('leaves the operator entry open when closure intent is omitted', async () => {
    const fixture = seedLandFixture();
    const successfulRunner = gitRunner(fixture);
    const successful = await runLand(landArguments(fixture, false), { git: successfulRunner });

    expect(successful.state).toBe('removed');
    expect(successful.fcTaskCompletion).toBeUndefined();
    expect(ledgerEntry(fixture).status).toBe('in_progress');

    const failedRunner = gitRunner(fixture, { fail: 'remove_worktree' });
    const failed = await runLand(landArguments(fixture, false), { git: failedRunner });
    expect(failed.state).toBe('removal_failed');
    expect(ledgerEntry(fixture).status).toBe('in_progress');
  });

  it('refuses mismatched identity before any destructive Git operation', async () => {
    const fixture = seedLandFixture();
    const runner = gitRunner(fixture);
    const args = landArguments(fixture);
    args[args.indexOf(fixture.entryId)] = 'different-entry';

    const report = await runLand(args, { git: runner });

    expect(report.state).toBe('refused');
    expect(report.fcTaskCompletion).toMatchObject({ state: 'preflight_failed' });
    expect(destructiveOperations(runner)).toEqual([]);
    expect(ledgerEntry(fixture).status).toBe('in_progress');
  });

  it('leaves the entry open when the selected run is nonterminal', async () => {
    const fixture = seedLandFixture();
    writeRun(fixture.engineRoot, fixture.runId, fixture.projectDir, RUN_STATUS.RUNNING);
    const runner = gitRunner(fixture);

    const report = await runLand(landArguments(fixture), { git: runner });

    expect(report.state).toBe('refused');
    expect(report.terminal).toBe(false);
    expect(report.fcTaskCompletion).toMatchObject({ state: 'not_attempted' });
    expect(destructiveOperations(runner)).toEqual([]);
    expect(ledgerEntry(fixture).status).toBe('in_progress');
  });

  it.each([
    'status',
    'ignored',
    'unpushed',
    'at_risk',
    'root',
    'worktrees',
    'branch',
    'remove_worktree',
    'prune_worktrees',
    'delete_branch',
  ] as const)(
    'preserves the ledger when Git %s fails',
    async (operation) => {
      const fixture = seedLandFixture();
      const runner = gitRunner(fixture, { fail: operation });

      const report = await runLand(landArguments(fixture), { git: runner });

      const destructive = ['remove_worktree', 'prune_worktrees', 'delete_branch'].includes(operation);
      expect(report.state).toBe(destructive ? 'removal_failed' : 'refused');
      expect(report.fcTaskCompletion).toMatchObject({
        state: destructive ? 'verified' : 'not_attempted',
      });
      expect(ledgerEntry(fixture).status).toBe('in_progress');
      if (destructive) {
        expect(destructiveOperations(runner).at(-1)).toBe(operation);
      } else {
        expect(destructiveOperations(runner)).toEqual([]);
      }
    },
  );

  it('detects a concurrent relink under the ledger lock after Git reclaim', async () => {
    const fixture = seedLandFixture();
    const otherRunId = 'other-run';
    writeRun(fixture.engineRoot, otherRunId, fixture.projectDir, 'complete');
    writeEngineTask(fixture.engineRoot, 902, fixture.projectDir, otherRunId);
    const runner = gitRunner(fixture, {
      before(request) {
        if (request.operation !== 'delete_branch') return;
        writeFileSync(fixture.entryPath, `${JSON.stringify({
          ...task(fixture.entryId, 'in_progress', 902),
        }, null, 2)}\n`, 'utf-8');
      },
    });

    const report = await runLand(landArguments(fixture), { git: runner });

    expect(report.state).toBe('removed_ledger_open');
    expect(report.fcTaskCompletion).toMatchObject({
      state: 'failed',
      ledgerStatusAfterFailure: 'in_progress',
      repairCommand: expect.stringContaining('--expected-run-id'),
    });
    expect(ledgerEntry(fixture)).toMatchObject({ status: 'in_progress', flowcrewTaskId: 902 });
  });

  it('does not rewrite an entry that was already completed', async () => {
    const fixture = seedLandFixture('completed');
    const before = readFileSync(fixture.entryPath);

    const report = await runLand(landArguments(fixture), { git: gitRunner(fixture) });

    expect(report.state).toBe('removed');
    expect(report.fcTaskCompletion).toMatchObject({ state: 'already_completed' });
    expect(readFileSync(fixture.entryPath)).toEqual(before);
  });

  it('reports an unconfirmed ledger outcome when the entry disappears after reclaim', async () => {
    const fixture = seedLandFixture();
    const runner = gitRunner(fixture, {
      before(request) {
        if (request.operation === 'delete_branch') rmSync(fixture.entryPath);
      },
    });

    const report = await runLand(landArguments(fixture), { git: runner });

    expect(report.state).toBe('removed_ledger_unconfirmed');
    expect(report.fcTaskCompletion).toMatchObject({
      state: 'failed',
      repairCommand: expect.stringContaining('--expected-run-id'),
    });
    expect(report.fcTaskCompletion).not.toHaveProperty('ledgerStatusAfterFailure');
    expect(destructiveOperations(runner)).toEqual([
      'remove_worktree', 'prune_worktrees', 'delete_branch',
    ]);
  });

  it('requires paired exact closure identity and a removal request', () => {
    expect(() => parseLandArgs([
      'land', '--run', 'run-id', '--complete-fc-task', 'entry', '--fc-task-session', 'session',
    ])).toThrow('require --remove');
    expect(() => parseLandArgs([
      'land', '--run', 'run-id', '--remove', '--complete-fc-task', 'entry',
    ])).toThrow('must be supplied together');
  });
});
