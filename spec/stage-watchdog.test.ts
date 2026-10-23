import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageLiveLogPath } from '../src/stage-live-log.js';
import { inspectStageExecutionFacts, StageWatchdog, type StageExecutionFacts } from '../src/stage-watchdog.js';
import { beginAttemptEvidenceGeneration } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, readStageStatus, setFcGlobalDir, updateRunState, type StageStatus } from '../src/store.js';

const observations = vi.hoisted(() => {
  vi.resetModules();
  return { processes: [] as string[], directories: [] as string[] };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, ...Object.fromEntries((['execFileSync', 'spawn', 'spawnSync'] as const).map(name => [
    name, (...args: unknown[]) => {
      observations.processes.push(String(args[0]));
      return Reflect.apply(actual[name], actual, args);
    },
  ])) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync(...args: Parameters<typeof actual.readdirSync>) {
    observations.directories.push(String(args[0]));
    return Reflect.apply(actual.readdirSync, actual, args);
  } };
});

let project: string, directory: string, runId: string;
const stageId = 'work';
const threshold = 1_000;
beforeEach(() => {
  setFcGlobalDir(join(process.env.FLOWCREW_VITEST_ROOT!, 'watchdog-home'));
  project = join(process.env.FLOWCREW_VITEST_ROOT!, 'watchdog-project');
  mkdirSync(project, { recursive: true });
  ({ runId, runDirPath: directory } = createRun(project, 'watchdog', 'name: watchdog\nstages: []', [stageId]));
  begin();
  observations.processes.length = 0;
  observations.directories.length = 0;
});
afterEach(() => vi.restoreAllMocks());
function begin() {
  const status = beginStageAttempt(project, runId, stageId, 0);
  const attempt = status.attempts!.at(-1)!;
  beginAttemptEvidenceGeneration(directory, stageId, attempt.index, attempt.startedAt);
  updateRunState(project, runId, state => { state.status = 'running'; state.stages[stageId] = status; });
  return status;
}
const signalPath = () => join(directory, 'signals', `abort_${stageId}.json`);
const saved = () => JSON.parse(readFileSync(join(directory, 'stage_watchdog.json'), 'utf8'));
function monitor() { return new StageWatchdog(project, runId, { idleThresholdMs: threshold }); }

describe('deterministic idle watchdog', () => {
  it('observes an idle tick without spawning a subprocess', async () => {
    const watchdog = monitor();
    await watchdog.tick();
    const started = saved().stageProgress.work.lastProgressAt;
    vi.spyOn(Date, 'now').mockReturnValue(started + threshold);
    await watchdog.tick();
    expect(observations.processes).toEqual([]);
    expect(observations.directories.filter(path => path.startsWith(join(directory, 'stages')))).toEqual([]);
    expect(existsSync(signalPath())).toBe(true);
  });

  it('recognizes changed attempt evidence even when its mtime predates the attempt', () => {
    const status = readStageStatus(project, runId, stageId);
    const artifacts = [
      join(directory, 'stages', stageId, 'output.md'),
      join(directory, `verdict_${stageId}.json`),
      join(directory, `handoff_${stageId}.md`),
    ];
    for (const artifact of artifacts) {
      writeFileSync(artifact, 'current attempt bytes');
      const beforeAttempt = new Date(Date.parse(status.attempts!.at(-1)!.startedAt) - 1_500);
      utimesSync(artifact, beforeAttempt, beforeAttempt);
    }
    expect(inspectStageExecutionFacts({ runDir: directory, stageId, status }))
      .toMatchObject({ outputObserved: true, verdictObserved: true, handoffObserved: true });
  });

  it('rejects unchanged prior-attempt evidence even after its mtime advances', () => {
    const artifacts = [
      join(directory, 'stages', stageId, 'output.md'),
      join(directory, `verdict_${stageId}.json`),
      join(directory, `handoff_${stageId}.md`),
    ];
    for (const artifact of artifacts) writeFileSync(artifact, 'previous attempt bytes');
    const status = begin();
    for (const artifact of artifacts) {
      const later = new Date(Date.now() + 10_000);
      utimesSync(artifact, later, later);
    }
    expect(inspectStageExecutionFacts({ runDir: directory, stageId, status }))
      .toMatchObject({ outputObserved: false, verdictObserved: false, handoffObserved: false, protectedFromIdleAbort: false });
  });

  it.each(['changed', 'unchanged', 'absent', 'missing'] as const)('uses the mtime boundary for old attempt-generation slots with %s content', async shape => {
    const status = readStageStatus(project, runId, stageId);
    const attempt = status.attempts!.at(-1)!;
    const segmentStart = statSync(stageLiveLogPath(directory, stageId)).size;
    const fingerprint = createHash('sha256').update('prior attempt bytes').digest('hex');
    // Exact old version-1 shape: output was output_attempt_N, hashes/null,
    // and no handoff baseline. Do not use the new writer to build this record.
    writeFileSync(join(directory, 'stages', stageId, 'attempt_generation.json'), JSON.stringify({
      version: 1, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
      segmentStart, ...(shape === 'missing' ? {} : { artifactBaselines: {
        output: shape === 'absent' ? null : fingerprint,
        verdict: shape === 'absent' ? null : fingerprint,
      } }), recordedAt: attempt.startedAt,
    }));
    for (const artifact of [join(directory, 'stages', stageId, 'output.md'),
      join(directory, `verdict_${stageId}.json`), join(directory, `handoff_${stageId}.md`)]) {
      writeFileSync(artifact, shape === 'unchanged' ? 'prior attempt bytes' : 'current attempt bytes');
      const modified = new Date(Date.parse(attempt.startedAt) + 1_000);
      utimesSync(artifact, modified, modified);
    }
    const watchdog = monitor();
    await watchdog.tick();
    expect(saved().stageProgress.work).toMatchObject({
      outputObserved: true, verdictObserved: true, handoffObserved: true,
      // M8 deliberately grants idle immunity only to live/process progress.
      protectedFromIdleAbort: false,
    });
    const old = new Date(Date.parse(attempt.startedAt) - 1_500);
    for (const artifact of [join(directory, 'stages', stageId, 'output.md'),
      join(directory, `verdict_${stageId}.json`), join(directory, `handoff_${stageId}.md`)]) utimesSync(artifact, old, old);
    expect(inspectStageExecutionFacts({ runDir: directory, stageId, status })).toMatchObject({
      outputObserved: false, verdictObserved: false, handoffObserved: false,
    });
  });

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

  it('restores an idle clock from the recorded watchdog progress snapshot', async () => {
    const status = readStageStatus(project, runId, stageId);
    const attempt = status.attempts!.at(-1)!;
    const lastProgressAt = Date.now() - threshold;
    writeFileSync(join(directory, 'stage_watchdog.json'), JSON.stringify({
      stageProgress: { work: { stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, lastProgressAt } },
      stageProgressObservedAt: Date.now() - 1,
    }));
    const watchdog = monitor();
    watchdog.restoreProgress();
    await watchdog.tick();
    expect(JSON.parse(readFileSync(signalPath(), 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
  });

  it('rejects a historical progress clock owned by another execution', async () => {
    writeFileSync(join(directory, 'stage_watchdog.json'), JSON.stringify({
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
      inspectFacts(stageId: string, status: StageStatus): StageExecutionFacts;
    };
    const inspect = internal.inspectFacts.bind(watchdog);
    let calls = 0;
    vi.spyOn(internal, 'inspectFacts').mockImplementation((...args) => {
      if (++calls === 2) {
        appendFileSync(stageLiveLogPath(directory, stageId), 'provider output');
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
