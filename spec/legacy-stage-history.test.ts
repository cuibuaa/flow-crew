import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginStageAttempt, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState, type StageAttempt } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-legacy-stage-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  ({ runId, runDirPath: directory } = createRun(project, 'legacy-stage', 'name: legacy-stage\nstages: []\n', ['work']));
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

describe('first v2 write of legacy stage evidence', () => {
  it.each(['absent', 'partial'] as const)('retains attempt history when run.json attempts are %s', (history) => {
    const attempts: StageAttempt[] = [
      { index: 1, status: 'failed', startedAt: '2026-10-21T01:49:44.000Z', completedAt: '2026-10-21T01:50:44.000Z', exitCode: 1, tokens_in: 10, error: 'first attempt failed' },
      { index: 2, status: 'complete', startedAt: '2026-10-21T01:51:44.000Z', completedAt: '2026-10-21T01:52:44.000Z', exitCode: 0, tokens_in: 20, writes: ['delivery.json'] },
    ];
    const legacy = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    delete legacy.stateFormat;
    legacy.stages.work = { status: 'pending', retries: 0, ...(history === 'partial' ? { attempts: [{ index: 2, status: 'complete', startedAt: attempts[1].startedAt, completedAt: attempts[1].completedAt, exitCode: 0 }] } : {}) };
    writeFileSync(join(directory, 'run.json'), JSON.stringify(legacy));
    writeFileSync(join(directory, 'stages', 'work', 'status.json'), JSON.stringify({ status: 'complete', retries: 0, attempts }));

    // Metadata publication precedes resumed execution and must not erase its evidence.
    updateRunState(project, runId, state => { state.currentIteration = 2; });
    expect(readRunState(project, runId).stateFormat?.version).toBe(2);
    expect(readStageStatus(project, runId, 'work')).toMatchObject({ status: 'pending', attempts });
    expect(readRunState(project, runId).stages.work).toMatchObject({ status: 'pending', attempts });

    // The next execution must continue the retained ledger rather than reuse an index.
    const resumed = beginStageAttempt(project, runId, 'work', 0, '2026-10-21T01:53:44.000Z');
    expect(resumed.attempts?.slice(0, 2)).toEqual([attempts[0], { ...attempts[1], disposition: 'superseded' }]);
    expect(resumed.attempts?.at(-1)).toMatchObject({ index: 3, status: 'running' });
  });
});
