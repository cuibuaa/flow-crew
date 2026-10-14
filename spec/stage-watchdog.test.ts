import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StageWatchdog, type StageExecutionFacts } from '../src/stage-watchdog.js';
import { beginStageAttempt, createRun, readStageStatus, updateRunState, type StageStatus } from '../src/store.js';

let project: string, directory: string, runId: string;
const stageId = 'work';
const threshold = 1_000;
beforeEach(() => {
  project = join(process.env.FLOWCREW_VITEST_ROOT!, 'watchdog-project');
  mkdirSync(project, { recursive: true });
  ({ runId, runDirPath: directory } = createRun(project, 'watchdog', 'name: watchdog\nstages: []', [stageId]));
  begin();
});
afterEach(() => vi.restoreAllMocks());
function begin() {
  const status = beginStageAttempt(project, runId, stageId, 0);
  updateRunState(project, runId, state => { state.status = 'running'; state.stages[stageId] = status; });
  return status;
}
const signalPath = () => join(directory, 'signals', `abort_${stageId}.json`);
const saved = () => JSON.parse(readFileSync(join(directory, 'stage_watchdog.json'), 'utf8'));
function monitor() { return new StageWatchdog(project, runId, { idleThresholdMs: threshold }); }

describe('deterministic idle watchdog', () => {
  it('aborts one idle execution exactly once at its bound without any model actor', async () => {
    const watchdog = monitor();
    await watchdog.tick();
    const started = saved().stageProgress.work.lastProgressAt;
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold - 1);
    await watchdog.tick();
    expect(existsSync(signalPath())).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold);
    await watchdog.tick();
    const firstSignal = readFileSync(signalPath(), 'utf8');
    expect(JSON.parse(firstSignal)).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold * 2);
    await watchdog.tick();
    expect(readFileSync(signalPath(), 'utf8')).toBe(firstSignal);
    expect(existsSync(join(directory, 'stages', '_supervisor'))).toBe(false);
    expect(existsSync(join(directory, 'supervisor_log.md'))).toBe(false);
  });

  it('starts a fresh idle clock when a same-name stage begins its next execution', async () => {
    const watchdog = monitor();
    await watchdog.tick();
    const started = saved().stageProgress.work.lastProgressAt;
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold);
    begin();
    await watchdog.tick();
    expect(saved().stageProgress.work).toMatchObject({ attemptIndex: 2, lastProgressAt: Date.now() });
    expect(existsSync(signalPath())).toBe(false);
  });

  it('restores an old run idle clock from the recorded supervisor progress snapshot', async () => {
    const status = readStageStatus(project, runId, stageId);
    const attempt = status.attempts!.at(-1)!;
    const lastProgressAt = Date.now() - threshold;
    writeFileSync(join(directory, 'supervisor_state.json'), JSON.stringify({
      stageProgress: { work: { stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, lastProgressAt } },
      stageProgressObservedAt: Date.now() - 1,
    }));
    const watchdog = monitor();
    watchdog.restoreProgress();
    await watchdog.tick();
    expect(JSON.parse(readFileSync(signalPath(), 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
  });

  it('rejects a historical progress clock owned by another execution', async () => {
    writeFileSync(join(directory, 'supervisor_state.json'), JSON.stringify({
      stageProgress: { work: { stageId, attemptIndex: 99, attemptStartedAt: '2000-01-01T00:00:00.000Z', lastProgressAt: 1 } },
    }));
    const watchdog = monitor();
    watchdog.restoreProgress();
    await watchdog.tick();
    expect(existsSync(signalPath())).toBe(false);
    expect(saved().stageProgress.work.lastProgressAt).toBeGreaterThan(1);
  });

  it('rechecks durable progress immediately before writing an idle cancellation', async () => {
    const watchdog = monitor();
    await watchdog.tick();
    const started = saved().stageProgress.work.lastProgressAt;
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold);
    const internal = watchdog as unknown as {
      inspectFacts(stageId: string, status: StageStatus, sinceMs: number, baseCommit?: string): StageExecutionFacts;
    };
    const inspect = internal.inspectFacts.bind(watchdog);
    let calls = 0;
    vi.spyOn(internal, 'inspectFacts').mockImplementation((...args) => {
      if (++calls === 2) {
        const artifact = join(directory, 'stages', stageId, 'checkpoint.json');
        writeFileSync(artifact, '{"finished":1}');
        utimesSync(artifact, new Date(Date.now()), new Date(Date.now()));
      }
      return inspect(...args);
    });
    await watchdog.tick();
    expect(calls).toBe(2);
    expect(existsSync(signalPath())).toBe(false);
    expect(saved().stageProgress.work.lastProgressAt).toBe(Date.now());
  });

  it('refuses an idle cancellation when the execution changes during final verification', async () => {
    const watchdog = monitor();
    await watchdog.tick();
    const started = saved().stageProgress.work.lastProgressAt;
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold);
    const internal = watchdog as unknown as { authoritativeStageStatus(stageId: string, fallback: StageStatus): StageStatus };
    const read = internal.authoritativeStageStatus.bind(watchdog);
    let calls = 0;
    vi.spyOn(internal, 'authoritativeStageStatus').mockImplementation((...args) => ++calls === 2 ? begin() : read(...args));
    await watchdog.tick();
    expect(readStageStatus(project, runId, stageId).attempts!.at(-1)!.index).toBe(2);
    expect(existsSync(signalPath())).toBe(false);
  });
});
