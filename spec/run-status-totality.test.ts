import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusExplanation } from '../src/campaign-page.js';
import { LIVE_CAMPAIGN_RUN_ACTIONS } from '../src/campaign-loop-live.js';
import type { Adapter } from '../src/adapters/base.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import {
  fcGlobalDir,
  isActiveRunStatus,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isPendingRunStatus,
  isRunMutationBlockedStatus,
  isRunningRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  readArchivedRunState,
  readRunState,
  resolveRunStatus,
  RUN_STATUS,
  RUN_STATUS_SEMANTICS,
  runDir,
  setFcGlobalDir,
  UnknownRunStatusError,
  writeRunState,
  type RunStatus,
  type RunStatusSemantics,
  type StoreState,
} from '../src/store.js';

const EXPECTED_SEMANTICS = {
  [RUN_STATUS.PENDING]: { lifecycle: 'queued', successful: false, mutationBlocked: false },
  [RUN_STATUS.RUNNING]: { lifecycle: 'executing', successful: false, mutationBlocked: true },
  [RUN_STATUS.PARKED]: { lifecycle: 'paused', successful: false, mutationBlocked: true },
  [RUN_STATUS.COMPLETE]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.FAILED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.AWAITING_APPROVAL]: { lifecycle: 'legacy_approval', successful: false, mutationBlocked: true },
  [RUN_STATUS.SHIPPED]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.CEILING_HIT]: { lifecycle: 'terminal', successful: true, mutationBlocked: false },
  [RUN_STATUS.ESCALATED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.REALITY_GATE_FAILED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.PHASE_COMPLETE]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.STOPPED]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
  [RUN_STATUS.INCOMPLETE]: { lifecycle: 'terminal', successful: false, mutationBlocked: false },
} as const satisfies Record<RunStatus, RunStatusSemantics>;

describe('total run-status semantics', () => {
  it.each(Object.values(RUN_STATUS))('preserves every existing consequence for %s', (status) => {
    const expected = EXPECTED_SEMANTICS[status];
    expect(RUN_STATUS_SEMANTICS[status]).toEqual(expected);
    expect(isTerminalRunStatus(status)).toBe(expected.lifecycle === 'terminal');
    expect(isPendingRunStatus(status)).toBe(expected.lifecycle === 'queued');
    expect(isRunningRunStatus(status)).toBe(expected.lifecycle === 'executing');
    expect(isPausedRunStatus(status)).toBe(expected.lifecycle === 'paused');
    expect(isAwaitingApprovalRunStatus(status)).toBe(expected.lifecycle === 'legacy_approval');
    expect(isActiveRunStatus(status)).toBe(
      expected.lifecycle === 'executing' || expected.lifecycle === 'paused',
    );
    expect(isSuccessfulRunStatus(status)).toBe(expected.successful);
    expect(isRunMutationBlockedStatus(status)).toBe(expected.mutationBlocked);
    expect(LIVE_CAMPAIGN_RUN_ACTIONS[status]).toBe(
      status === RUN_STATUS.PARKED
        ? 'await_approval'
        : expected.successful ? 'score' : 'reject',
    );
  });

  it('keeps unknown text outside every known outcome and blocks mutation', () => {
    const resolution = resolveRunStatus('future_archived_state');
    expect(resolution).toMatchObject({
      kind: 'unknown',
      raw: 'future_archived_state',
      display: '"future_archived_state"',
    });
    expect(isTerminalRunStatus('future_archived_state')).toBe(false);
    expect(isSuccessfulRunStatus('future_archived_state')).toBe(false);
    expect(isRunMutationBlockedStatus('future_archived_state')).toBe(true);
    expect(statusExplanation('future_archived_state')).toContain(
      'Unrecognized archived run status "future_archived_state"',
    );
  });
});

describe('unknown archived run status boundary', () => {
  let root: string;
  let projectDir: string;
  let previousStateDir: string;
  const runId = 'synthetic-future-status';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flowcrew-status-boundary-'));
    projectDir = join(root, 'project');
    previousStateDir = fcGlobalDir();
    setFcGlobalDir(join(root, 'state'));
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    writeFileSync(join(runDir(projectDir, runId), 'run.json'), JSON.stringify({
      runId,
      workflowName: 'future-writer-fixture',
      projectDir,
      status: 'future_archived_state',
      stages: {},
      startedAt: '2030-01-01T00:00:00.000Z',
    }, null, 2));
  });

  afterEach(() => {
    setFcGlobalDir(previousStateDir);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads successfully, preserves the raw value, and refuses a known-state overwrite', () => {
    const archived = readArchivedRunState(projectDir, runId);
    expect(archived.state.status).toBe('future_archived_state');
    expect(archived.status).toMatchObject({ kind: 'unknown', raw: 'future_archived_state' });
    // Compatibility readers also preserve the runtime value; they do not coerce
    // future archive text merely because their live-writer type is narrower.
    expect(readRunState(projectDir, runId).status).toBe('future_archived_state');

    const proposed = {
      ...archived.state,
      status: RUN_STATUS.COMPLETE,
      completedAt: '2030-01-01T00:01:00.000Z',
    } as StoreState;
    expect(() => writeRunState(projectDir, runId, proposed)).toThrow(UnknownRunStatusError);
    expect(() => writeRunState(projectDir, runId, proposed)).toThrow(/Refusing to overwrite archived run/);
    expect(JSON.parse(readFileSync(join(runDir(projectDir, runId), 'run.json'), 'utf-8')).status)
      .toBe('future_archived_state');
  });

  it('refuses scheduler resume before claiming or executing the archived run', async () => {
    const workflow = WorkflowConfigSchema.parse({
      name: 'future-status-resume-fixture',
      defaults: { max_retries: 0, max_iterations: 1 },
      stages: [{
        id: 'work',
        role: 'worker',
        prompt_template: 'must not execute',
        scope: ['src/**'],
      }],
    });
    const run = vi.fn<Adapter['run']>(async () => ({
      output: 'must not execute',
      exitCode: 0,
      duration_ms: 1,
    }));

    await expect(runWorkflow(
      workflow,
      '',
      projectDir,
      { run },
      new Map(),
      undefined,
      undefined,
      runId,
      'synthetic future-status resume',
      true,
      false,
      undefined,
      false,
    )).rejects.toThrow(
      /Refusing to resume run synthetic-future-status.*Unrecognized archived run status "future_archived_state"/,
    );
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(runDir(projectDir, runId), 'run.json'), 'utf-8')).status)
      .toBe('future_archived_state');
  });
});
