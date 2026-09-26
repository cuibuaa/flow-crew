import { appendFileSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRun,
  readOperationalRunState,
  readRunState,
  writeRunState,
  type SupervisorAttempt,
} from '../src/store.js';

function attempt(index: number): SupervisorAttempt {
  return {
    index,
    startedAt: `2026-09-24T00:00:${String(index).padStart(2, '0')}.000Z`,
    completedAt: `2026-09-24T00:00:${String(index).padStart(2, '0')}.100Z`,
    status: 'complete',
    duration_ms: 100,
    exitCode: 0,
    tokens_in: undefined,
    tokens_out: undefined,
    unverifiedAssessment: undefined,
    verdict: 'WAIT',
    effectiveReason: undefined,
    error: undefined,
  };
}

describe('scheduler history polling boundary', () => {
  it('uses the compact operational projection while explicit archival reads still hydrate and reject corruption', () => {
    const projectDir = process.env.FLOWCREW_VITEST_ROOT!;
    const created = createRun(projectDir, 'history-poll', 'name: history-poll', ['work']);
    const state = readRunState(projectDir, created.runId);
    state.supervisor = {
      status: 'running', calls: 1, tokens_in: 0, tokens_out: 0,
      duration_ms: 100, startedAt: state.startedAt, attempts: [attempt(1)],
    };
    writeRunState(projectDir, created.runId, state);

    const operational = readOperationalRunState(projectDir, created.runId);
    expect(operational.supervisor?.attempts).toEqual([]);
    expect(readRunState(projectDir, created.runId).supervisor?.attempts).toHaveLength(1);

    const historyPath = join(created.runDirPath, 'run-history.v1.jsonl');
    const acknowledged = operational.stateFormat!.history!.committedBytes;
    truncateSync(historyPath, acknowledged - 1);
    expect(readOperationalRunState(projectDir, created.runId).supervisor?.attempts).toEqual([]);
    expect(() => readRunState(projectDir, created.runId)).toThrow(/history is truncated/i);
  });

  it('compares deltas as persisted JSON while genuine attempts still append exactly once', () => {
    const projectDir = process.env.FLOWCREW_VITEST_ROOT!;
    const created = createRun(projectDir, 'stable-delta', 'name: stable-delta', []);
    const state = readRunState(projectDir, created.runId);
    state.supervisor = {
      status: 'running', calls: 1, tokens_in: 0, tokens_out: 0,
      duration_ms: 100, startedAt: state.startedAt, attempts: [attempt(1)],
    };
    writeRunState(projectDir, created.runId, state);
    const historyPath = join(created.runDirPath, 'run-history.v1.jsonl');
    const oneAttemptBytes = statSync(historyPath).size;

    for (let index = 0; index < 10; index += 1) writeRunState(projectDir, created.runId, state);
    expect(statSync(historyPath).size).toBe(oneAttemptBytes);
    expect(readFileSync(historyPath, 'utf-8').trim().split('\n')).toHaveLength(1);

    state.supervisor.attempts.push(attempt(2));
    state.supervisor.calls = 2;
    writeRunState(projectDir, created.runId, state);
    const afterGenuineAppend = statSync(historyPath).size;
    expect(afterGenuineAppend).toBeGreaterThan(oneAttemptBytes);
    expect(readFileSync(historyPath, 'utf-8').trim().split('\n')).toHaveLength(2);

    // An unacknowledged tail remains old behavior: full persistence removes
    // only that tail before deciding whether a real delta exists.
    appendFileSync(historyPath, '{crash tail', 'utf-8');
    writeRunState(projectDir, created.runId, state);
    expect(statSync(historyPath).size).toBe(afterGenuineAppend);
  });
});
