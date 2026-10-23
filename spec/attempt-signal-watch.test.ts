import { atomicWrite } from '../src/engine-fs.js';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { requestStageCommandInterrupt } from '../src/command-interrupt.js';
import { readStageStatus, updateRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

const observation = vi.hoisted(() => ({ watchUnavailable: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (observation.watchUnavailable) throw new Error('fixture: watch unavailable');
      return Reflect.apply(actual.watch, actual, args);
    },
  };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const role: AgentConfig = { name: 'coder', description: 'signal fixture', tools: [], prompt: 'fixture' };

it.each([
  ['watch', 'abort'], ['watch', 'interrupt'],
  ['fallback', 'abort'], ['fallback', 'interrupt'],
] as const)('delivers %s requests for %s with one fallback interval per attempt', async (delivery, signal) => {
  observation.watchUnavailable = delivery === 'fallback';
  const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, `signals-${delivery}-${signal}`);
  mkdirSync(projectDir, { recursive: true });
  const created = createRun(projectDir, 'signals', 'name: signals\nstages: []', ['work']);
  writeFileSync(join(created.runDirPath, 'task_brief.md'), '# Finish the fixture\n');
  // Signal delivery has no elapsed-time requirement. Keep the attempt budget
  // clock fixed while exercising real watch events and explicit reconciliation.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const nativeInterval = globalThis.setInterval;
  // Suppress periodic callbacks: watch cases must deliver without polling;
  // fallback cases invoke the captured reconciliation once, synchronously.
  const intervals = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => nativeInterval(() => {}, 60_000));
  const clears = vi.spyOn(globalThis, 'clearInterval');
  let calls = 0;
  let consumed = false;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    if (++calls > 1) return { output: 'continued', exitCode: 0, duration_ms: 1 };
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(intervals.mock.calls[0][1]).toBe(1_000);
    const status = readStageStatus(projectDir, created.runId, 'work');
    updateRunState(projectDir, created.runId, state => { state.status = 'running'; state.stages.work = status; });
    const tracker = new CommandActivityTracker({ runDir: opts.runDir, stageId: 'work',
      attemptIndex: opts.attemptIndex!, attemptStartedAt: opts.attemptStartedAt!, onLifecycle: opts.onCommandLifecycle });
    tracker.started('active', 'sleep 60');
    const stopped = new Promise<void>(resolve => opts.abortSignal!.addEventListener('abort', () => resolve(), { once: true }));
    if (signal === 'abort') {
      atomicWrite(join(opts.runDir, 'signals', 'abort_work.json'), JSON.stringify({
        version: 1, stageId: 'work', attemptIndex: opts.attemptIndex, source: 'watchdog',
        reason: 'verified idle fixture', timestamp: new Date().toISOString(),
      }));
    } else {
      requestStageCommandInterrupt({ runDir: opts.runDir, stageId: 'work' });
    }
    if (delivery === 'fallback') {
      (intervals.mock.calls[0][0] as () => void)();
      expect(opts.abortSignal!.aborted).toBe(true);
    }
    await stopped;
    consumed = !existsSync(join(opts.runDir, 'signals', `${signal}_work.json`));
    tracker.close();
    return { output: 'stopped', exitCode: 137, duration_ms: 1 };
  } };
  const result = await runStage(adapter, { stageId: 'work', role, dependsOn: [], promptTemplate: 'Finish.',
    timeout_ms: 10_000, projectDir, runId: created.runId, runDir: created.runDirPath, retries: 0,
    artifactContract: fixtureArtifactContract('work') });
  expect(consumed).toBe(true);
  expect(result.output).not.toContain('ENGINE_STATE_TAMPERED');
  expect(calls).toBe(signal === 'abort' ? 1 : 2);
  expect(result.exitCode).toBe(signal === 'abort' ? 137 : 0);
  expect(intervals).toHaveBeenCalledTimes(1);
  expect(clears).toHaveBeenCalledWith(intervals.mock.results[0].value);
});
