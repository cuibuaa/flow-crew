import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { stageWrapUpTiming, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { createRun } from './test-support/create-run.js';
import { readStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
const role: AgentConfig = { name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture' };
function manualClock() {
  let elapsed = 0;
  const start = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, {
    at: number;
    callback: () => void;
  }>();
  const clock: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => start + elapsed,
    setTimer(callback, delay) { const timer = {} as ReturnType<typeof setTimeout>; timers.set(timer, { at: elapsed + delay, callback }); return timer; },
    clearTimer(timer) { timers.delete(timer); } };
  return { clock, timers, advanceTo(value: number) { elapsed = value; for (const [timer, entry] of [...timers])
      if (entry.at <= elapsed) {
        timers.delete(timer);
        entry.callback();
      } } };
}
let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), 'fc-retry-deadline-')); });
afterEach(() => rmSync(project, { recursive: true, force: true }));
describe('each retained execution owns one immutable hard stop', () => {
  it('R01 publishes a fresh deadline and prior work references on a later execution, including an explicit resumed UUID', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const budget = 20000;
    const observed: Array<{
      attempt: number;
      id: string;
      budgetMs: number;
      prompt: string;
      resume?: string;
      remaining: number;
    }> = [];
    for (let execution = 1; execution <= 2; execution++) {
      const time = manualClock();
      let calls = 0;
      const adapter: Adapter = { async run(prompt, _role, opts) {
          const status = readStageStatus(project, created.runId, 'work');
          observed.push({ attempt: opts.attemptIndex!, id: status.timeout!.attemptId, budgetMs: status.timeout!.budgetMs, prompt, resume: opts.resumeSessionId, remaining: status.timeout!.remainingMs });
          expect(status.attempts?.at(-1)).toMatchObject({ index: execution, status: 'running', timeout: status.timeout });
          expect(status.continuation).toBeUndefined();
          if (execution === 2 || calls++)
            return { exitCode: 0, output: 'Done: retained unit. Remaining: next unit.', duration_ms: 1 };
          return new Promise<RunResult>(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'retained unit', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
        } };
      const result = await runStage(adapter, { stageId: 'work', role, dependsOn: [], promptTemplate: 'Continue retained work.', artifactContract: fixtureArtifactContract('work'),
        projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0, timeout_ms: budget, deadlineClock: time.clock,
        ...(execution === 2 ? { resumeSessionId: '123e4567-e89b-42d3-a456-426614174000' } : {}) });
      expect(result.exitCode).toBe(0);
      expect(time.timers.size).toBe(0);
    }
    expect(observed.map(entry => entry.attempt)).toEqual([1, 1, 2]);
    expect(observed[0].id).toBe(observed[1].id);
    expect(observed[2].id).not.toBe(observed[1].id);
    expect(observed.map(entry => entry.budgetMs)).toEqual([budget, budget, budget]);
    expect(observed[2].remaining).toBe(budget);
    expect(observed[2].resume).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(observed[2].prompt).toContain('Own-stage continuation evidence');
    expect(observed[2].prompt).not.toContain('# Stage budget wrap-up');
    const status = readStageStatus(project, created.runId, 'work');
    expect(status.attempts?.map(attempt => attempt.exitCode)).toEqual([0, 0]);
  });
  it('R02 disposes the warning/deadline owner when setup throws before invoking an adapter', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const time = manualClock();
    let calls = 0;
    await expect(runStage({ async run() { calls++; return { exitCode: 0, output: 'unused', duration_ms: 1 }; } }, {
      stageId: 'work', role, dependsOn: [], artifactContract: fixtureArtifactContract('work'),
      projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0, timeout_ms: 20000, deadlineClock: time.clock,
      get promptTemplate() { throw new Error('setup refused'); },
    })).rejects.toThrow('setup refused');
    expect(time.timers.size).toBe(0);
    expect(calls).toBe(0);
  });
});
