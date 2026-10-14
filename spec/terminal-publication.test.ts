import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir,
  TERMINAL_STATUSES, updateRunState, updateRunStateAtPath, writeRunState,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { publishRunCompletion } from '../src/scheduler/sched_loop/iteration-outcome.js';
import { StageWatchdog } from '../src/stage-watchdog.js';

// Setup imports the store before this file; reload it with the rename observer.
vi.hoisted(() => vi.resetModules());

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string;
let project: string;
let priorStore: string;
let id: string;
let directory: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'flowcrew-terminal-publication-'));
  project = join(root, 'project');
  fs.mkdirSync(project);
  priorStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  id = createRun(project, 'publication', 'name: publication', ['work']).runId;
  directory = runDir(project, id);
});

afterEach(() => {
  setFcGlobalDir(priorStore);
  fs.rmSync(root, { recursive: true, force: true });
});

const readers = ['write', 'update', 'path'] as const;

describe('terminal publication', () => {
  it.each(TERMINAL_STATUSES.flatMap(status => readers.map(writer => ({ status, writer }))))(
    'publishes the candidate artifacts before $status via $writer becomes observable',
    ({ status, writer }) => {
      fs.writeFileSync(join(directory, 'summary.md'), 'stale summary');
      fs.writeFileSync(join(directory, 'progress.md'), 'stale progress');
      const state = readRunState(project, id);
      state.status = status;
      state.completedAt = new Date().toISOString();
      state.failureReason = 'Final outcome evidence';
      state.stages.work = { status: 'complete', retries: 0 };
      state.retiredStageUsage = [{ stageId: 'earlier', iteration: 1,
        status: { status: 'complete', retries: 0, duration_ms: 12 } }];
      // A path publisher must use its bound directory, even when another store
      // is currently selected. No selected-store artifact may stand in for it.
      if (writer === 'path') setFcGlobalDir(join(root, 'other-store'));
      const originalRename = fs.renameSync;
      const actual = vi.mocked(originalRename).getMockImplementation()!;
      let observed = 0;
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === join(directory, 'run.json')) {
          expect(JSON.parse(fs.readFileSync(String(to), 'utf8')).status).toBe('running');
          for (const artifact of ['summary.md', 'progress.md']) {
            const content = fs.readFileSync(join(directory, artifact), 'utf8');
            expect(content).toContain(`Status: **${status}**`);
            expect(content).toContain('Final outcome evidence');
            expect(content).toContain('work: complete');
            expect(content).toContain('earlier [iteration 1, archived]: complete');
          }
        }
        actual(from, to);
        if (String(to) === join(directory, 'run.json')) observed++;
      });
      if (writer === 'write') writeRunState(project, id, state);
      else if (writer === 'update') updateRunState(project, id, current => Object.assign(current, state));
      else updateRunStateAtPath(directory, current => Object.assign(current, state));
      expect(observed).toBe(1);
      expect(JSON.parse(fs.readFileSync(join(directory, 'run.json'), 'utf8')).status).toBe(status);
    },
  );

  it.each(['summary.md', 'progress.md'])('keeps status and completion events unpublished when %s fails', artifact => {
    const state = readRunState(project, id);
    state.status = 'complete';
    state.completedAt = new Date().toISOString();
    // A directory at the artifact destination deterministically rejects rename.
    fs.mkdirSync(join(directory, artifact));
    expect(() => publishRunCompletion(state, project, id, () => ({ iteration: 1, detail: state.status }))).toThrow();
    expect(readRunState(project, id).status).toBe('running');
    expect(readRunEvents(project, id).some(event => event.type === 'run_completed')).toBe(false);
    fs.rmSync(join(directory, artifact), { recursive: true });
    publishRunCompletion(state, project, id, () => ({ iteration: 1, detail: state.status }));
    expect(readRunState(project, id).status).toBe('complete');
    expect(readRunEvents(project, id).some(event => event.type === 'run_completed')).toBe(true);
  });

  it('publishes a budget-exhaustion summary without unrecorded research quantities', () => {
    fs.writeFileSync(join(directory, 'research_journal.json'), JSON.stringify({ rounds: [] }));
    fs.writeFileSync(join(directory, 'research_decision.json'), JSON.stringify({
      decision: 'stop_ceiling', reason: 'Iteration budget exhausted', bankedRounds: 0,
    }));
    updateRunState(project, id, state => {
      state.status = 'ceiling_hit';
      state.completedAt = new Date().toISOString();
    });
    const summary = fs.readFileSync(join(directory, 'summary.md'), 'utf8');
    expect(summary).toContain('**Decision:** stop_ceiling — Iteration budget exhausted');
    expect(summary).toContain('**Rounds:** 0');
    expect(summary).not.toContain('kept:');
    expect(summary).not.toContain('no-improvement streak:');
    expect(fs.readFileSync(join(directory, 'progress.md'), 'utf8')).toBe(summary);
  });

  it('keeps terminal progress when a watchdog ticks after settlement', async () => {
    const watchdog = new StageWatchdog(project, id, { idleThresholdMs: 600_000 });
    await watchdog.tick();
    updateRunState(project, id, state => {
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
    });
    const progress = fs.readFileSync(join(directory, 'progress.md'), 'utf8');
    expect(progress).toContain('Status: **complete**');
    await watchdog.tick();
    expect(fs.readFileSync(join(directory, 'progress.md'), 'utf8')).toBe(progress);
  });
});
