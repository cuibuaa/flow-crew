import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateValidationDelta,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
} from '../src/project-validation.js';
import { inspectApprovalRunStanding } from '../src/run-standing.js';
import { listAll, recordRequest } from '../src/inbox.js';
import { writeSchedulerProcessIdentity } from '../src/run-lock.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
  RUN_STATUS,
} from '../src/store.js';
import {
  inspectDispatchAdmission,
  parseDispatchedStageConfig,
  type StageConfig,
} from '../src/scheduler.js';
import {
  classifyLiveConstraintGitIndexEntry,
  parseLiveConstraintGitIndexEntries,
} from '../src/live-constraint-guard.js';

function validationResult(
  state: ValidationCommandResult['state'],
  options: Partial<ValidationCommandResult> = {},
): ValidationCommandResult {
  return {
    role: 'test',
    state,
    durationMs: 1,
    output: '',
    failureIdentifiers: [],
    failureIdentity: state === 'passed' ? 'none' : 'unknown',
    ...options,
  };
}

function baseline(result: ValidationCommandResult): ProjectValidationBaseline {
  return {
    version: 1,
    execution: 'executed',
    projectDir: '/tmp/validation-delta-fixture',
    discovery: {
      state: 'configured',
      configPath: 'package.json',
      commands: [],
      missingRoles: [],
    },
    results: [result],
    gateCriteria: [],
  };
}

function stage(id: string, scope: string[], dependsOn: string[] = []): StageConfig {
  return parseDispatchedStageConfig({
    id,
    role: 'coder',
    scope,
    depends_on: dependsOn,
    dependency_reasons: Object.fromEntries(dependsOn.map((dependency) => [dependency, `Consumes ${dependency}.`])),
    criterion_refs: [],
    prompt_template: 'work',
  });
}

describe('engine-recorded facts used at their decision boundaries', () => {
  let root: string;
  let projectDir: string;
  let priorFcHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flowcrew-engine-records-'));
    projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    priorFcHome = fcGlobalDir();
    setFcGlobalDir(join(root, 'fc-home'));
  });

  afterEach(() => {
    setFcGlobalDir(priorFcHome);
    rmSync(root, { recursive: true, force: true });
  });

  it('distinguishes unavailable green-to-red evidence while retaining a complete named regression', () => {
    const green = baseline(validationResult('passed'));
    const unknown = validationResult('failed', {
      exitCode: 2,
      output: '/usr/bin/python3: No module named ruff',
      failureIdentity: 'unknown',
    });
    const partial = validationResult('failed', {
      exitCode: 1,
      output: '[... earlier output omitted ...]\nFAIL spec/known.test.ts',
      failureIdentity: 'known',
      failureEvidence: 'partial',
      failureCount: 1,
      failureIdentifiers: ['spec/known.test.ts'],
    });
    const launchError = validationResult('launch_error', {
      reason: 'spawn failed',
      failureIdentity: 'unknown',
    });
    const completeNamed = validationResult('failed', {
      exitCode: 1,
      output: 'FAIL spec/new.test.ts',
      failureIdentity: 'known',
      failureEvidence: 'complete',
      failureCount: 1,
      failureIdentifiers: ['spec/new.test.ts'],
    });

    expect(evaluateValidationDelta(green, [unknown])[0]).toMatchObject({
      state: 'unresolved',
      reason: expect.stringContaining('identity/count is unavailable'),
      newFailureIdentifiers: [],
    });
    expect(evaluateValidationDelta(green, [partial])[0]).toMatchObject({
      state: 'unresolved',
      reason: expect.stringContaining('partial'),
      newFailureIdentifiers: [],
    });
    expect(evaluateValidationDelta(green, [launchError])[0]).toMatchObject({
      state: 'unresolved',
      reason: expect.stringContaining('launch_error'),
      newFailureIdentifiers: [],
    });
    expect(evaluateValidationDelta(green, [completeNamed])[0]).toEqual({
      role: 'test',
      state: 'regression',
      reason: 'A green baseline no longer passes',
      newFailureIdentifiers: ['spec/new.test.ts'],
    });
  });

  it('keeps approval state human-owned while projecting live, parked, ended, and orphaned run standing', () => {
    const terminal = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);
    recordRequest({
      runId: terminal.runId,
      projectDir,
      requestId: 'terminal-cleanup',
      action: 'remove_generated_cache',
      risk: 'write',
      title: 'Review cleanup after the run ended',
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const terminalState = readRunState(projectDir, terminal.runId);
    terminalState.status = RUN_STATUS.STOPPED;
    terminalState.completedAt = '2026-09-18T00:00:00.000Z';
    writeRunState(projectDir, terminal.runId, terminalState);

    const parked = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);
    const parkedState = readRunState(projectDir, parked.runId);
    parkedState.status = RUN_STATUS.PARKED;
    writeRunState(projectDir, parked.runId, parkedState);

    const orphaned = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);

    const live = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', []);
    writeFileSync(join(runDir(projectDir, live.runId), 'scheduler.pid'), `${process.pid}\n`, 'utf-8');
    writeSchedulerProcessIdentity(runDir(projectDir, live.runId), live.runId);

    expect(listAll({ runId: terminal.runId })).toEqual([
      expect.objectContaining({ requestId: 'terminal-cleanup', state: 'pending' }),
    ]);
    expect(inspectApprovalRunStanding(projectDir, terminal.runId)).toMatchObject({
      kind: 'ended', live: false, runStatus: RUN_STATUS.STOPPED,
    });
    expect(inspectApprovalRunStanding(projectDir, parked.runId)).toMatchObject({
      kind: 'parked', live: false, runStatus: RUN_STATUS.PARKED,
    });
    expect(inspectApprovalRunStanding(projectDir, orphaned.runId)).toMatchObject({
      kind: 'orphaned', live: false, runStatus: RUN_STATUS.RUNNING, scheduler: { kind: 'missing' },
    });
    expect(inspectApprovalRunStanding(projectDir, live.runId)).toMatchObject({
      kind: 'live', live: true, runStatus: RUN_STATUS.RUNNING, scheduler: { kind: 'live', pid: process.pid },
    });
  });

  it('advises on a literal negative validation assertion intersecting a future scope and stays silent for two-factor controls', () => {
    mkdirSync(join(projectDir, 'tests'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0',
      scripts: { test: 'pytest' },
    }), 'utf-8');
    const testPath = join(projectDir, 'tests', 'test_scope.py');
    const negative = [
      'from pathlib import Path',
      'ROOT = Path(__file__).resolve().parents[1]',
      'ARTIFACTS = ROOT / "artifacts" / "prescreen-gonogo"',
      'def test_before_inference():',
      '    assert not (ARTIFACTS / "local").exists()',
      '',
    ].join('\n');
    writeFileSync(testPath, negative, 'utf-8');
    const writer = stage('measure_local', ['artifacts/prescreen-gonogo/local/**']);

    const conflict = inspectDispatchAdmission({
      dispatched: [writer],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    expect(conflict.pass).toBe(true);
    expect(conflict.validationPlanConflicts).toEqual([
      expect.objectContaining({
        kind: 'negative_path_assertion_future_scope',
        assertionPath: 'artifacts/prescreen-gonogo/local',
        assertionSource: 'tests/test_scope.py',
        stageId: 'measure_local',
        scope: 'artifacts/prescreen-gonogo/local/**',
      }),
    ]);
    expect(conflict.warnings).toEqual([
      expect.stringContaining('scope is capability, not proof of a write'),
    ]);

    writeFileSync(testPath, negative.replace('assert not', 'assert'), 'utf-8');
    const positiveAndDisjoint = inspectDispatchAdmission({
      dispatched: [stage('measure_elsewhere', ['artifacts/other/**'])],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    expect(positiveAndDisjoint.validationPlanConflicts).toEqual([]);
    expect(positiveAndDisjoint.warnings).toEqual([]);
  });

  it('retains every Git index stage and assigns explicit entry kinds', () => {
    const oid = 'a'.repeat(40);
    const entries = parseLiveConstraintGitIndexEntries([
      `100644 ${oid} 0\tregular.txt`,
      `100755 ${oid} 0\texecutable.sh`,
      `120000 ${oid} 0\tlink`,
      `160000 ${oid} 0\tsubmodule`,
      `040000 ${oid} 0\tsparse-directory`,
      `100644 ${oid} 1\tconflicted.txt`,
      `100644 ${oid} 2\tconflicted.txt`,
      `100644 ${oid} 3\tconflicted.txt`,
      '',
    ].join('\0'));

    expect([...entries.values()].flat().map(({ path, mode, stage, kind }) => ({ path, mode, stage, kind })))
      .toEqual([
        { path: 'regular.txt', mode: '100644', stage: 0, kind: 'regular' },
        { path: 'executable.sh', mode: '100755', stage: 0, kind: 'executable' },
        { path: 'link', mode: '120000', stage: 0, kind: 'symlink' },
        { path: 'submodule', mode: '160000', stage: 0, kind: 'gitlink' },
        { path: 'sparse-directory', mode: '040000', stage: 0, kind: 'sparse_tree' },
        { path: 'conflicted.txt', mode: '100644', stage: 1, kind: 'unmerged' },
        { path: 'conflicted.txt', mode: '100644', stage: 2, kind: 'unmerged' },
        { path: 'conflicted.txt', mode: '100644', stage: 3, kind: 'unmerged' },
      ]);
    expect(classifyLiveConstraintGitIndexEntry('100600', 0)).toBe('unknown');
  });
});
