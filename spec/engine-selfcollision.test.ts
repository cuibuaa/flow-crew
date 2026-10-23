import { artifacts, inputFile, stageArtifacts } from './spec_contracts/declared-fixtures.js';
import { createBuildManifest, BUILD_MANIFEST_FILENAME } from '../src/build-manifest.js';
import { readCampaignEntries } from '../src/campaigns.js';
import {
  cmdShipPreflightWithDeps,
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import {
  renderFcTasks,
  type FcTaskEntry,
  type FcTaskRunResolver,
  type LedgerReadResult,
} from '../src/fc-tasks.js';
import type {
  ProjectValidationBaseline,
  ValidationCommandResult,
  ValidationCommandRunner,
} from '../src/project-validation.js';
import { captureRepairRoundSnapshot, inspectDispatchAdmission, parseBriefFrontmatter, parseDispatchedStageConfig, readGateEvaluation, recordGateValidationDelta, restoreProjectPath, writeCampaignEntry, type StageConfig } from '../src/scheduler.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { createRun } from './test-support/create-run.js';
import {
  campaignsRoot,
  fcGlobalDir,
  readRunState,
  RUN_STATUS,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
  type StoreState,
} from '../src/store.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appendFault = vi.hoisted(() => ({
  eventPath: '',
  needle: '',
  remaining: 0,
}));

vi.mock('../src/append-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/append-boundary.js')>();
  return {
    ...actual,
    appendTextRecord(path: string, record: string) {
      if (path === appendFault.eventPath && appendFault.remaining > 0 && record.includes(appendFault.needle)) {
        appendFault.remaining -= 1;
        throw new Error('injected obligation append failure');
      }
      return actual.appendTextRecord(path, record);
    },
  };
});

const roots: string[] = [];
const originalFcRoot = fcGlobalDir();
const dependencyDirectory = ['node', 'modules'].join('_');

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-selfcollision-after-${label}-`));
  roots.push(root);
  return root;
}

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function stage(raw: Record<string, unknown>): StageConfig {
  return parseDispatchedStageConfig({ artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
    id: 'fixture',
    role: 'worker',
    prompt_template: 'bounded engine-self-collision fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function recordAfter(item: number, construction: string, observed: Record<string, unknown>): void {
  process.stdout.write(`ENGINE_SELF_COLLISION_AFTER=${JSON.stringify({
    item,
    capturedAt: new Date().toISOString(),
    construction,
    observed,
  })}\n`);
}

function validationResult(
  role: ValidationCommandResult['role'],
  state: ValidationCommandResult['state'],
): ValidationCommandResult {
  return {
    role,
    display: `fixture ${role}`,
    state,
    exitCode: state === 'passed' ? 0 : 1,
    durationMs: 1,
    output: '',
    failureCount: 0,
    failureIdentifiers: [],
    failureIdentity: state === 'passed' ? 'none' : 'known',
    ...(state === 'passed' ? {} : { failureEvidence: 'complete' as const }),
  };
}

function validationBaseline(projectDir: string): ProjectValidationBaseline {
  return {
    version: 1,
    execution: 'executed',
    projectDir,
    discovery: {
      state: 'configured',
      configPath: join(projectDir, 'package.json'),
      commands: [{ role: 'test', command: 'fixture', args: ['test'], display: 'fixture test' }],
      missingRoles: ['build', 'lint'],
    },
    results: [validationResult('test', 'passed')],
    gateCriteria: [{
      role: 'test',
      rule: 'must_remain_green',
      baselineFailureIdentifiers: [],
      description: 'test passed at baseline and must remain green',
    }],
  };
}

function settleGateAttempt(
  projectDir: string,
  runId: string,
  attempts: Array<{ index: number; startedAt: string; completedAt: string }>,
): void {
  const latest = attempts.at(-1)!;
  writeStageStatus(projectDir, runId, 'qa', {
    status: 'complete',
    retries: 0,
    startedAt: attempts[0].startedAt,
    completedAt: latest.completedAt,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      status: 'complete',
      duration_ms: 1,
      exitCode: 0,
      tokenUsage: 'unknown',
    })),
  });
}

function seedCampaignPhase(
  projectDir: string,
  stateRoot: string,
  campaignStorageKey: string,
): { state: StoreState; runDirectory: string } {
  setFcGlobalDir(stateRoot);
  const created = createRun(projectDir, 'campaign-fixture', 'name: campaign-fixture', ['qa']);
  const state = readRunState(projectDir, created.runId);
  state.campaignId = campaignStorageKey;
  state.campaignStorageKey = campaignStorageKey;
  state.campaignName = campaignStorageKey;
  state.research = { baseline: 0, policy: 'greedy_stack' };
  state.dispatchedStages = [stage({ criterion_refs: [], artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_qa.json" }], [], []), id: 'qa', role: 'qa', is_gate: true })];
  state.stages.qa = { status: 'complete', retries: 0 };
  write(join(created.runDirPath, 'verdict_qa.json'), `${JSON.stringify({
    pass: true, phase: 'research', phaseComplete: false,
  })}\n`);
  return { state, runDirectory: created.runDirPath };
}

function linkedWorktree(root: string, name: string, common: string): string {
  const projectDir = join(root, name);
  const gitDir = join(common, 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  write(join(gitDir, 'commondir'), '../..\n');
  mkdirSync(projectDir, { recursive: true });
  write(join(projectDir, '.git'), `gitdir: ${gitDir}\n`);
  return projectDir;
}

afterEach(async () => {
  try {
    const events = await import('../src/run-events.js');
    } catch { /* module may not have loaded */ }
  setFcGlobalDir(originalFcRoot);
  appendFault.eventPath = '';
  appendFault.needle = '';
  appendFault.remaining = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine self-collision after-state replays and controls', () => {
  it('1 — keeps scheduler campaign bookkeeping outside the guarded project while guarding a stage-authored local ledger', async () => {
    const root = temporaryRoot('item-1');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    const { state, runDirectory } = seedCampaignPhase(projectDir, stateRoot, 'collision');
    const localRelative = '.fc/campaigns/collision.jsonl';
    const localPath = join(projectDir, localRelative);
    const globalPath = join(campaignsRoot(), 'collision.jsonl');
    const research = parseBriefFrontmatter([
      '---',
      'research:',
      '  baseline: 0',
      '  policy: greedy_stack',
      '  result_file: artifacts/round.json',
      '  report_dir: artifacts',
      '---',
    ].join('\n')).research!;
    const reservation = inspectDispatchAdmission({
      dispatched: [stage({ id: 'terminal_report', scope: ['artifacts/run_manifest.json'] })],
      baseStages: [],
      dispatchStageId: 'plan',
      research,
    });

    writeCampaignEntry(projectDir, state);
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(localPath)).toBe(false);

    write(localPath, 'stage-authored\n');
    const restored = restoreProjectPath(projectDir, localRelative, {
      exists: false,
      provenance: 'observed',
    });
    expect(restored).toEqual({ restored: true });
    expect(existsSync(localPath)).toBe(false);

    recordAfter(1, 'write a scored campaign row while an empty-scope stage guard is active', {
      engineWrite: { path: globalPath.slice(root.length + 1), projectRelative: false },
      projectLedgerExists: existsSync(localPath),
      frameworkReservedScopes: reservation.frameworkReservedScopes,
      control: { actor: 'stage', path: localRelative, restored },
    });
  });

  it('2 — carries new campaign history across linked worktrees without merging an unrelated repository', () => {
    const root = temporaryRoot('item-2');
    const common = join(root, 'repo.git');
    const first = linkedWorktree(root, 'worktree-a', common);
    const fresh = linkedWorktree(root, 'worktree-b', common);
    const unrelated = linkedWorktree(root, 'unrelated', join(root, 'other.git'));
    const stateRoot = join(root, 'state');
    const { state } = seedCampaignPhase(first, stateRoot, 'portable-history');
    writeCampaignEntry(first, state);

    const firstEntries = readCampaignEntries(first, 'portable-history');
    const freshEntries = readCampaignEntries(fresh, 'portable-history');
    const unrelatedEntries = readCampaignEntries(unrelated, 'portable-history');
    expect(firstEntries).toHaveLength(1);
    expect(freshEntries).toHaveLength(1);
    expect(unrelatedEntries).toEqual([]);
    rmSync(first, { recursive: true, force: true });
    expect(readCampaignEntries(fresh, 'portable-history')).toHaveLength(1);

    const legacyPath = join(fresh, '.fc', 'campaigns', 'legacy.jsonl');
    write(legacyPath, `${JSON.stringify({
      seq: 1,
      runId: 'legacy-run',
      score: 2,
      metric: 'quality',
      pass: true,
      timestamp: new Date().toISOString(),
      campaignId: 'legacy',
    })}\n`);
    expect(readCampaignEntries(fresh, 'legacy')).toHaveLength(1);

    recordAfter(2, 'write in linked worktree A, read in B before and after reclaim, then read from an unrelated repository', {
      globalWriterPath: join(campaignsRoot(), 'portable-history.jsonl').slice(root.length + 1),
      firstWorktreeEntries: firstEntries.length,
      freshWorktreeEntriesBeforeReclaim: freshEntries.length,
      freshWorktreeEntriesAfterReclaim: readCampaignEntries(fresh, 'portable-history').length,
      unrelatedRepositoryEntries: unrelatedEntries.length,
      legacyLocalEntries: readCampaignEntries(fresh, 'legacy').length,
    });
  });

  it('5 — rejects a prior-attempt delta by execution identity and preserves immutable attempt evidence', async () => {
    const root = temporaryRoot('item-5');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'validation-fixture', 'name: validation-fixture', ['qa']);
    write(join(created.runDirPath, 'validation_baseline.json'), `${JSON.stringify({
      version: 1,
      capturedAt: new Date().toISOString(),
      source: 'ship-setup-ready-record',
      baseline: validationBaseline(projectDir),
    }, null, 2)}\n`);
    write(join(created.runDirPath, 'verdict_qa.json'), `${JSON.stringify({
      pass: true,
      reason: 'gate-authored verdict before engine validation',
      recordedAt: new Date().toISOString(),
    })}\n`);
    const first = {
      index: 1,
      startedAt: new Date(Date.now() - 40).toISOString(),
      completedAt: new Date(Date.now() - 30).toISOString(),
    };
    settleGateAttempt(projectDir, created.runId, [first]);
    const failed = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({
        exitCode: 1,
        durationMs: 1,
        stdout: 'TAP version 13\nnot ok 1 - spec/regression-a.test.ts\nnot ok 2 - spec/regression-b.test.ts\nnot ok 3 - spec/regression-c.test.ts\n1..3\n# tests 3\n# pass 0\n# fail 3\n',
      }),
    });
    const currentRegression = readGateEvaluation(projectDir, 'qa', created.runId);
    expect(currentRegression).toMatchObject({ pass: false, reason: expect.stringContaining('recorded regressions') });
    const immutableFailure = readFileSync(join(created.runDirPath, failed!.immutablePath!), 'utf-8');
    const second = {
      index: 2,
      startedAt: new Date(Date.now() - 20).toISOString(),
      completedAt: new Date(Date.now() - 10).toISOString(),
    };
    settleGateAttempt(projectDir, created.runId, [first, second]);
    write(join(created.runDirPath, 'verdict_qa.json'), `${JSON.stringify({
      pass: true,
      reason: 'repair complete; no new failing identifiers',
      recordedAt: new Date().toISOString(),
    })}\n`);
    const stale = readGateEvaluation(projectDir, 'qa', created.runId);
    expect(stale).toMatchObject({ pass: false, reason: expect.stringContaining('not current execution') });
    expect(stale?.reason).toContain('run configured validation for the current gate attempt');

    const passing = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({
        exitCode: 0,
        durationMs: 1,
        stdout: 'TAP version 13\nok 1 - spec/repaired.test.ts\n1..1\n# tests 1\n# pass 1\n# fail 0\n',
      }),
    });
    expect(readGateEvaluation(projectDir, 'qa', created.runId)).toMatchObject({ pass: true });
    expect(JSON.parse(immutableFailure)).toMatchObject({
      attemptIndex: 1,
      pass: false,
      executionId: failed?.executionId,
    });
    expect(passing).toMatchObject({ attemptIndex: 2, pass: true });

    recordAfter(5, 'record a failing attempt-1 delta, settle a passing attempt-2 verdict, then validate attempt 2', {
      staleDecision: stale,
      currentRegressionDecision: currentRegression,
      failedDelta: failed,
      passingDelta: passing,
      immutableAttemptOneStillFailing: JSON.parse(immutableFailure),
      currentDecision: readGateEvaluation(projectDir, 'qa', created.runId),
    });
  });

  it('7 — permits unrelated validation when a cross-project run consumes this checkout dist', async () => {
    const root = temporaryRoot('item-7');
    const projectDir = join(root, 'target-project');
    const otherProject = join(root, 'other-project');
    const packageRoot = join(root, 'engine-package');
    const stateRoot = join(root, 'state');
    const runRoot = join(stateRoot, 'runs');
    mkdirSync(join(projectDir, dependencyDirectory), { recursive: true });
    mkdirSync(otherProject, { recursive: true });
    write(join(projectDir, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'check', lint: 'style' },
    }));
    write(join(projectDir, 'package-lock.json'), '{}\n');
    write(join(packageRoot, 'src', 'probe.ts'), 'export const probe = true;\n');
    write(join(packageRoot, 'dist', 'probe.js'), 'export const probe = true;\n');
    write(join(packageRoot, 'dist', 'probe.d.ts'), 'export declare const probe = true;\n');
    write(join(packageRoot, 'tsconfig.json'), '{}\n');
    write(join(packageRoot, 'dist', BUILD_MANIFEST_FILENAME), `${JSON.stringify(
      createBuildManifest(packageRoot, join(packageRoot, 'dist')),
      null,
      2,
    )}\n`);
    write(join(runRoot, 'cross-project-run', 'run.json'), `${JSON.stringify({
      runId: 'cross-project-run', projectDir: otherProject, status: 'running',
    })}\n`);
    class Capture {
      value = '';
      writer = { write: (chunk: string): void => { this.value += chunk; } };
    }
    const stderr = new Capture();
    const runner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0, durationMs: 1, stdout: `${request.role} passed\n`,
    }));
    const dependencies: ShipPreflightDependencies = {
      projectDir,
      packageRoot,
      runsRoot: () => runRoot,
      readGitCommonDir: () => '.git',
      readCampaignEntries: () => [],
      probeDaemon: async (): Promise<DaemonLoadedBuildProbe> => ({
        state: 'fresh', loadedBuild: 'same', diskBuild: 'same',
      }),
      inspectLiveRun: () => true,
      runValidationCommand: runner,
      stdout: new Capture().writer,
      stderr: stderr.writer,
    };
    const unrelatedTarget = await cmdShipPreflightWithDeps(['ship-preflight'], dependencies);
    expect(unrelatedTarget).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(stderr.value).not.toContain('Validation baseline refused');

    const terminalRunner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0, durationMs: 1, stdout: `${request.role} passed\n`,
    }));
    const terminal = await cmdShipPreflightWithDeps(['ship-preflight'], {
      ...dependencies,
      inspectLiveRun: () => false,
      runValidationCommand: terminalRunner,
      stderr: new Capture().writer,
    });
    expect(terminal).toBe(0);
    expect(terminalRunner).not.toHaveBeenCalled();

    recordAfter(7, 'run preflight for a cross-project run, then a terminal-run control', {
      unrelatedTargetExitCode: unrelatedTarget,
      unrelatedTargetRoles: runner.mock.calls.map(([request]) => request.role),
      validationOutput: stderr.value,
      terminalRunExitCode: terminal,
      terminalRunRoles: terminalRunner.mock.calls.map(([request]) => request.role),
    });
  });

  it('8 — counts distinct running execution identities while retaining both ledger rows', () => {
    const root = temporaryRoot('item-8');
    const entries: FcTaskEntry[] = ['1', '2'].map((id) => ({
      id,
      subject: `task-${id}`,
      description: `task-${id}`,
      activeForm: `running-${id}`,
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      flowcrewTaskId: Number(id),
    }));
    const readLedger = (): LedgerReadResult => ({
      state: 'ready',
      entries: entries.map((entry) => ({
        ...entry,
        sourceName: `${entry.id}.json`,
        sourcePath: join(root, `${entry.id}.json`),
        sourceRecord: { ...entry },
      })),
      issues: [],
    });
    const render = (resolver: FcTaskRunResolver) => renderFcTasks({
      storeRoot: root,
      explicitSession: 'fixture',
      columns: 180,
      readLedger,
      taskRunResolver: resolver,
    }).text.split('\n')[0];
    const resolver = (runId: (entry: FcTaskEntry) => string | undefined, status = 'running'): FcTaskRunResolver => ({
      resolve: (entry) => ({
        state: 'resolved',
        taskId: entry.flowcrewTaskId!,
        taskStatus: status === 'running' ? 'running' : 'done',
        projectDir: root,
        ...(runId(entry) ? { runId: runId(entry) } : {}),
        ...(runId(entry) ? { runStatus: status } : {}),
      }),
    });
    const shared = render(resolver(() => 'one-running-run'));
    const distinct = render(resolver((entry) => `running-${entry.id}`));
    const taskOnly = render(resolver(() => undefined));
    const terminal = render(resolver(() => 'one-terminal-run', 'complete'));
    expect(shared).toContain('engine 1 running');
    expect(distinct).toContain('engine 2 running');
    expect(taskOnly).toContain('engine 2 running');
    expect(terminal).toContain('engine 0 running');

    recordAfter(8, 'render two ledger rows resolving to one, two, task-only, and terminal execution identities', {
      sharedRunHeader: shared,
      distinctRunHeader: distinct,
      taskOnlyHeader: taskOnly,
      terminalHeader: terminal,
      renderedLedgerRowsRetained: entries.length,
    });
  });

  it.each(['snapshot', 'stopped snapshot', 'operational'] as const)('9 — commits the cursor after retryably appending every obligation exactly once (%s)', async kind => {
    const root = temporaryRoot('item-9');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'cursor-fixture', 'name: cursor-fixture', []);
    let state = readRunState(projectDir, created.runId);
    state.status = kind === 'stopped snapshot' ? RUN_STATUS.CANCELLED : RUN_STATUS.COMPLETE;
    state.completedAt = new Date().toISOString();
    writeRunState(projectDir, created.runId, state);
    state = readRunState(projectDir, created.runId);
    // Isolate the interrupted observation from createRun/publication history.
    write(join(created.runDirPath, 'events.jsonl'), '');
    const cursorPath = join(created.runDirPath, 'run_event_status.json');
    write(cursorPath, `${JSON.stringify({
      version: 1, status: RUN_STATUS.RUNNING, observedAt: new Date(0).toISOString(),
    })}\n`);

    vi.resetModules();
    const isolatedStore = await import('../src/store.js');
    isolatedStore.setFcGlobalDir(stateRoot);
    const isolatedEvents = await import('../src/run-events.js');
    appendFault.eventPath = join(created.runDirPath, 'events.jsonl');
    appendFault.needle = '"type":"operator_wrap_up_required"';
    appendFault.remaining = 1;
    const publish = () => kind === 'operational'
      ? isolatedStore.updateOperationalRunStateAtPath(created.runDirPath, () => {})
      : isolatedStore.writeRunState(projectDir, created.runId, state);
    expect(publish)
      .toThrow('injected obligation append failure');
    const cursorAfterFailure = JSON.parse(readFileSync(cursorPath, 'utf-8')) as { status: string };
    const failureEvents = isolatedEvents.readRunEvents(projectDir, created.runId);
    expect(cursorAfterFailure.status).toBe(RUN_STATUS.RUNNING);
    expect(failureEvents.map(({ type }) => type)).toEqual(['run_status_changed']);
    const interruptedObservationId = failureEvents[0].observationId;
    expect(interruptedObservationId).toBe(`${new Date(0).toISOString()}:running->${state.status}`);

    appendFault.remaining = 0;
    publish();
    publish();
    const retryEvents = isolatedEvents.readRunEvents(projectDir, created.runId);
    expect(retryEvents.filter(({ type }) => type === 'run_status_changed')).toHaveLength(1);
    expect(retryEvents.filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(1);
    expect(retryEvents.every(({ observationId }) => observationId === interruptedObservationId)).toBe(true);
    expect(new Set(retryEvents.map(({ timestamp }) => timestamp)).size).toBe(1);
    expect(JSON.parse(readFileSync(cursorPath, 'utf-8'))).toMatchObject({ status: state.status });
    recordAfter(9, 'append the status event, inject the wrap-up obligation failure, retry, then observe the unchanged status again', {
      cursorAfterFailure,
      eventTypesAfterFailure: failureEvents.map(({ type }) => type),
      cursorAfterRetry: JSON.parse(readFileSync(cursorPath, 'utf-8')),
      eventTypesAfterRetryAndRepeat: retryEvents.map(({ type }) => type),
      statusEventCount: retryEvents.filter(({ type }) => type === 'run_status_changed').length,
      obligationCount: retryEvents.filter(({ type }) => type === 'operator_wrap_up_required').length,
    });
  });
});
