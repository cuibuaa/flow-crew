import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import {
  runLand,
  type LandGitRequest,
  type LandGitResponse,
  type LandGitRunner,
} from '../src/cli-land.js';
import {
  createEngineTaskRunResolver,
  publicTaskEntries,
  readTaskLedger,
  renderFcTasks,
  type FcTaskEntry,
} from '../src/fc-tasks.js';
import { readOperationalProjection } from '../src/cli-events.js';
import {
  clearAttemptSummaryRefreshDebounce,
  readRunEvents,
  recordRunEvent,
} from '../src/run-events.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const BASE_COMMIT = 'a'.repeat(40);
const TOPIC_COMMIT = 'b'.repeat(40);
const originalGlobalDir = fcGlobalDir();

class Capture {
  output = '';
  error = '';
  stdout = { write: (chunk: string) => { this.output += chunk; } };
  stderr = { write: (chunk: string) => { this.error += chunk; } };
}

interface Fixture {
  root: string;
  engineRoot: string;
  storeRoot: string;
  session: string;
  projectDir: string;
  primaryDir: string;
  runId: string;
  entryId: string;
  entryPath: string;
}

let root: string;

function entry(id: string, status: FcTaskEntry['status'], taskId: number): FcTaskEntry {
  return {
    id,
    subject: `subject-${id}`,
    description: `description-${id}`,
    activeForm: `active-${id}`,
    status,
    blocks: [],
    blockedBy: [],
    flowcrewTaskId: taskId,
  };
}

function writeEntry(
  storeRoot: string,
  session: string,
  value: FcTaskEntry,
): string {
  const directory = join(storeRoot, session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${value.id}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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
    workflowName: 'qa-fixture',
    projectDir,
    baseCommit: BASE_COMMIT,
    status,
    stages: {},
    startedAt: '2031-01-01T00:00:00.000Z',
    ...(status === 'running' || status === 'pending'
      ? {}
      : { completedAt: '2031-01-01T00:01:00.000Z' }),
  }, null, 2)}\n`, 'utf-8');
  return directory;
}

function writeEngineTask(
  engineRoot: string,
  taskId: number,
  projectDir: string,
  runId: string,
  status: string,
): void {
  mkdirSync(engineRoot, { recursive: true });
  appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({
    id: taskId,
    status,
    projectDir,
    run_id: runId,
  })}\n`, 'utf-8');
}

function seedLandFixture(): Fixture {
  const engineRoot = join(root, 'engine');
  const storeRoot = join(root, 'ledger');
  const session = 'session';
  const projectDir = join(root, 'topic');
  const primaryDir = join(root, 'primary');
  const runId = 'terminal-run';
  const entryId = 'operator-entry';
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(primaryDir, { recursive: true });
  writeRun(engineRoot, runId, projectDir, 'complete');
  writeEngineTask(engineRoot, 41, projectDir, runId, 'done');
  const entryPath = writeEntry(storeRoot, session, entry(entryId, 'in_progress', 41));
  return {
    root,
    engineRoot,
    storeRoot,
    session,
    projectDir,
    primaryDir,
    runId,
    entryId,
    entryPath,
  };
}

function successfulGitResponses(fixture: Fixture): Record<LandGitRequest['operation'], LandGitResponse> {
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
        'branch refs/heads/topic',
        '',
      ].join('\n'),
    },
    branch: { exitCode: 0, stdout: 'topic\n' },
    remove_worktree: { exitCode: 0 },
    prune_worktrees: { exitCode: 0 },
    delete_branch: { exitCode: 0 },
  };
}

function gitRunner(fixture: Fixture): ReturnType<typeof vi.fn<LandGitRunner>> {
  const responses = successfulGitResponses(fixture);
  return vi.fn<LandGitRunner>((request) => responses[request.operation]);
}

function landArgs(fixture: Fixture, includeClosure: boolean): string[] {
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

function statusOf(fixture: Fixture): FcTaskEntry['status'] {
  const ledger = readTaskLedger(fixture.storeRoot, fixture.session);
  expect(ledger.state).toBe('ready');
  const entries = publicTaskEntries(ledger);
  expect(entries).toHaveLength(1);
  return entries[0].status;
}

function destructiveOperations(runner: ReturnType<typeof vi.fn<LandGitRunner>>): string[] {
  return runner.mock.calls
    .map(([request]) => request.operation)
    .filter((operation) => ['remove_worktree', 'prune_worktrees', 'delete_branch'].includes(operation));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-ledger-'));
});

afterEach(() => {
  clearAttemptSummaryRefreshDebounce();
  setFcGlobalDir(originalGlobalDir);
  rmSync(root, { recursive: true, force: true });
});

describe('independent ledger convergence replay', () => {
  it('separates engine-running work from operator-open ledger entries', () => {
    const engineRoot = join(root, 'engine');
    const storeRoot = join(root, 'ledger');
    const session = 'recorded';
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });

    for (let taskId = 1; taskId <= 9; taskId += 1) {
      const ledgerStatus = taskId <= 4 ? 'in_progress' : 'completed';
      const runStatus = taskId <= 3 ? 'stopped' : taskId === 4 ? 'running' : 'complete';
      const runId = `run-${taskId}`;
      writeEntry(storeRoot, session, entry(String(taskId), ledgerStatus, taskId));
      writeRun(engineRoot, runId, projectDir, runStatus);
      writeEngineTask(engineRoot, taskId, projectDir, runId, taskId === 4 ? 'running' : 'done');
    }

    const rendered = renderFcTasks({
      storeRoot,
      explicitSession: session,
      columns: 240,
      lines: 24,
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });

    expect(rendered.text.split('\n').slice(0, 5)).toEqual([
      'fc_tasks: 3 wrap-up overdue · engine 1 running · ledger 4 in progress, 0 pending, 5 done',
      '▶ wrap-up-overdue:run:stopped:#1 [1] active-1',
      '▶ wrap-up-overdue:run:stopped:#2 [2] active-2',
      '▶ wrap-up-overdue:run:stopped:#3 [3] active-3',
      '▶ run:running [4] active-4',
    ]);
  });

  it('reconciles the recorded ledger without changing entry bytes', () => {
    const engineRoot = join(root, 'engine');
    const storeRoot = join(root, 'ledger');
    const session = 'recorded';
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    const paths: string[] = [];

    for (let taskId = 1; taskId <= 4; taskId += 1) {
      const runId = `run-${taskId}`;
      paths.push(writeEntry(storeRoot, session, entry(String(taskId), 'in_progress', taskId)));
      writeRun(engineRoot, runId, projectDir, taskId < 4 ? 'stopped' : 'running');
      writeEngineTask(engineRoot, taskId, projectDir, runId, taskId < 4 ? 'done' : 'running');
    }
    const before = paths.map((path) => readFileSync(path));
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks', 'reconcile', '--json',
      '--session', session,
      '--store-root', storeRoot,
      '--engine-root', engineRoot,
    ], { env: {}, stdin: '', stdout: capture.stdout, stderr: capture.stderr });

    expect(code).toBe(0);
    expect(JSON.parse(capture.output)).toMatchObject({
      counts: { entries: 4, disagreements: 3, notComparable: 0, aligned: 1 },
      entries: [
        { entryId: '1', comparison: 'wrap_up_required' },
        { entryId: '2', comparison: 'wrap_up_required' },
        { entryId: '3', comparison: 'wrap_up_required' },
        {
          entryId: '4',
          comparison: 'aligned',
          engine: { lifecycle: 'executing', running: true, terminal: false },
        },
      ],
    });
    expect(capture.error).toBe('');
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });

  it('persists one unattended terminal obligation while leaving acceptance open', () => {
    const fixture = seedLandFixture();
    setFcGlobalDir(fixture.engineRoot);
    writeFileSync(join(fixture.engineRoot, 'runs', fixture.runId, 'run_event_status.json'), `${JSON.stringify({
      version: 1,
      status: 'running',
      observedAt: '2031-01-01T00:00:00.000Z',
    })}\n`, 'utf-8');

    for (const detail of ['terminal transition', 'later observation']) {
      recordRunEvent(fixture.projectDir, fixture.runId, {
        type: 'campaign_alert',
        runId: fixture.runId,
        timestamp: '2031-01-01T00:02:00.000Z',
        detail,
      }, { debounceMs: 60_000 });
    }

    const obligations = readRunEvents(fixture.projectDir, fixture.runId)
      .filter(({ type }) => type === 'operator_wrap_up_required');
    expect(obligations).toHaveLength(1);
    expect(obligations[0].detail).toContain('terminal state is not acceptance');
    expect(readOperationalProjection(join(fixture.engineRoot, 'runs', fixture.runId), {
      includeDrift: false,
    }).latestReason).toMatchObject({
      type: 'operator_wrap_up_required',
      historical: true,
    });
    expect(statusOf(fixture)).toBe('in_progress');
  });

  it('does not create a wrap-up obligation for a nonterminal transition', () => {
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'project');
    const runId = 'active-run';
    setFcGlobalDir(engineRoot);
    const runDirectory = writeRun(engineRoot, runId, projectDir, 'running');
    writeFileSync(join(runDirectory, 'run_event_status.json'), `${JSON.stringify({
      version: 1,
      status: 'pending',
      observedAt: '2031-01-01T00:00:00.000Z',
    })}\n`, 'utf-8');

    recordRunEvent(projectDir, runId, {
      type: 'campaign_alert',
      runId,
      timestamp: '2031-01-01T00:02:00.000Z',
      detail: 'active control',
    }, { debounceMs: 60_000 });

    expect(readRunEvents(projectDir, runId)
      .filter(({ type }) => type === 'operator_wrap_up_required')).toEqual([]);
  });

  it('completes the exact entry only after every reclaim step succeeds', async () => {
    const fixture = seedLandFixture();
    const runner = gitRunner(fixture);

    const report = await runLand(landArgs(fixture, true), {
      globalDir: () => fixture.engineRoot,
      git: runner,
    });

    expect(report.state).toBe('removed');
    expect(report.fcTaskCompletion).toMatchObject({
      entryId: fixture.entryId,
      expectedRunId: fixture.runId,
      state: 'completed',
    });
    expect(destructiveOperations(runner)).toEqual([
      'remove_worktree',
      'prune_worktrees',
      'delete_branch',
    ]);
    expect(statusOf(fixture)).toBe('completed');
  });

  it('preserves a deliberately open entry when closure identity is omitted', async () => {
    const fixture = seedLandFixture();
    const runner = gitRunner(fixture);

    const report = await runLand(landArgs(fixture, false), {
      globalDir: () => fixture.engineRoot,
      git: runner,
    });

    expect(report.state).toBe('removed');
    expect(report.fcTaskCompletion).toBeUndefined();
    expect(destructiveOperations(runner)).toEqual([
      'remove_worktree',
      'prune_worktrees',
      'delete_branch',
    ]);
    expect(statusOf(fixture)).toBe('in_progress');
  });

  it('refuses a mismatched entry before destructive Git work', async () => {
    const fixture = seedLandFixture();
    const runner = gitRunner(fixture);
    const args = landArgs(fixture, true);
    args[args.indexOf(fixture.entryId)] = 'different-entry';

    const report = await runLand(args, {
      globalDir: () => fixture.engineRoot,
      git: runner,
    });

    expect(report.state).toBe('refused');
    expect(report.fcTaskCompletion).toMatchObject({ state: 'preflight_failed' });
    expect(destructiveOperations(runner)).toEqual([]);
    expect(statusOf(fixture)).toBe('in_progress');
  });

  it('refuses a nonterminal run before destructive Git work', async () => {
    const fixture = seedLandFixture();
    writeRun(fixture.engineRoot, fixture.runId, fixture.projectDir, 'running');
    const runner = gitRunner(fixture);

    const report = await runLand(landArgs(fixture, true), {
      globalDir: () => fixture.engineRoot,
      git: runner,
    });

    expect(report.state).toBe('refused');
    expect(report.terminal).toBe(false);
    expect(report.fcTaskCompletion).toMatchObject({ state: 'not_attempted' });
    expect(destructiveOperations(runner)).toEqual([]);
    expect(statusOf(fixture)).toBe('in_progress');
  });

  it('preserves the open entry when final reclaim fails', async () => {
    const fixture = seedLandFixture();
    const responses = successfulGitResponses(fixture);
    responses.delete_branch = { exitCode: 1, stderr: 'branch still referenced' };
    const runner = vi.fn<LandGitRunner>((request) => responses[request.operation]);

    const report = await runLand(landArgs(fixture, true), {
      globalDir: () => fixture.engineRoot,
      git: runner,
    });

    expect(report.state).toBe('removal_failed');
    expect(report.fcTaskCompletion).toMatchObject({ state: 'verified' });
    expect(destructiveOperations(runner)).toEqual([
      'remove_worktree',
      'prune_worktrees',
      'delete_branch',
    ]);
    expect(statusOf(fixture)).toBe('in_progress');
  });
});
