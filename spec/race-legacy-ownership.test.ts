import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCancellationResult } from '../src/cancellation-client.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let directory: string, project: string, previous: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flowcrew-checkpoint-'));
  project = join(directory, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(directory, 'store'));
});
afterEach(() => {
  setFcGlobalDir(previous); rmSync(directory, { recursive: true, force: true });
});

describe('checkpoint ownership', () => {
  it('publishes the stronger enclosing ownership contract in new checkpoints', () => {
    const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
    expect(captureEngineCheckpoint(project, runId).version).toBe(2);
  });

  it('accepts recorded cancellation with unknown command fate while rejecting an unfinished decision', () => {
    const result = { ok: true, status: 'cancelled', message: 'Cancellation recorded.', observation: {
      unit: null, unitState: { kind: 'absent' }, runReadable: true, schedulerPid: null,
      schedulerAlive: false, launchInFlight: false, commandFateKnown: false,
    } };
    expect(isCancellationResult(result)).toBe(true);
    expect(isCancellationResult({ ...result, status: 'cancelling' })).toBe(false);
  });
});
