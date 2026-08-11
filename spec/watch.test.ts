import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cmdWatchWithDeps,
  formatWatchPoll,
  parseWatchArgs,
  watchUsage,
} from '../src/cli-watch.js';
import {
  createWatchState,
  pollWatch,
  type WatchPollDependencies,
  type WatchState,
} from '../src/watch.js';

class Capture {
  value = '';
  writer = { write: (chunk: string) => { this.value += chunk; } };
}

class WatchFixture {
  readonly root = join(tmpdir(), 'flowcrew-watch-memory', 'runs');
  readonly files = new Map<string, string>();
  readonly mtimes = new Map<string, number>();
  readonly directories = new Map<string, string[]>();
  rootReads = 0;
  readonly livePids = new Set<number>();
  readonly livenessProbe = vi.fn((pid: number) => this.livePids.has(pid));
  private clockValue = 0;

  constructor() {
    this.directories.set(this.root, []);
  }

  private addEntry(parent: string, name: string): void {
    const entries = this.directories.get(parent) ?? [];
    if (!entries.includes(name)) entries.push(name);
    this.directories.set(parent, entries);
  }

  private addDirectory(parent: string, name: string): string {
    this.addEntry(parent, name);
    const path = join(parent, name);
    if (!this.directories.has(path)) this.directories.set(path, []);
    return path;
  }

  addUnreadableRunEntry(runId: string): void {
    this.addEntry(this.root, runId);
  }

  addRun(
    runId: string,
    state: Record<string, unknown>,
    options: { pid?: number; live?: boolean } = {},
  ): void {
    const runDir = this.addDirectory(this.root, runId);
    this.files.set(join(runDir, 'run.json'), JSON.stringify(state));
    if (options.pid !== undefined) {
      this.files.set(join(runDir, 'scheduler.pid'), String(options.pid));
      if (options.live !== false) this.livePids.add(options.pid);
    }
  }

  setRunState(runId: string, state: Record<string, unknown>): void {
    this.files.set(join(this.root, runId, 'run.json'), JSON.stringify(state));
  }

  addArtifact(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs);
  }

  addVerdict(
    runId: string,
    gateId: string,
    coordinate: { iteration?: number; round: number },
    verdict: Record<string, unknown> | string,
  ): void {
    const runDir = join(this.root, runId);
    const archive = this.addDirectory(runDir, 'gate_reevaluation');
    let parent = archive;
    if (coordinate.iteration !== undefined) {
      parent = this.addDirectory(archive, `iteration_${coordinate.iteration}`);
    }
    const round = this.addDirectory(parent, `round_${coordinate.round}`);
    const filename = `rejected_verdict_${gateId}.json`;
    this.addEntry(round, filename);
    this.files.set(join(round, filename), typeof verdict === 'string' ? verdict : JSON.stringify(verdict));
  }

  dependencies(overrides: WatchPollDependencies = {}): WatchPollDependencies {
    return {
      runsRoot: this.root,
      readDirectory: (path) => {
        if (path === this.root) this.rootReads += 1;
        const entries = this.directories.get(path);
        if (!entries) {
          throw Object.assign(new Error(`missing directory: ${path}`), { code: 'ENOENT' });
        }
        return [...entries];
      },
      readText: (path) => {
        const value = this.files.get(path);
        if (value === undefined) {
          throw Object.assign(new Error(`missing file: ${path}`), { code: 'ENOENT' });
        }
        return value;
      },
      isProcessAlive: this.livenessProbe,
      artifactMtimeMs: (path) => this.mtimes.get(path),
      nowMs: () => {
        const value = this.clockValue;
        this.clockValue += 275;
        return value;
      },
      ...overrides,
    };
  }

  snapshot(): string {
    return JSON.stringify({
      directories: [...this.directories].map(([path, entries]) => [path, [...entries]]),
      files: [...this.files],
      mtimes: [...this.mtimes],
    });
  }
}

function attempts(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({ index: index + 1 }));
}

function poll(
  fixture: WatchFixture,
  state: WatchState = createWatchState(),
): ReturnType<typeof pollWatch> {
  return pollWatch(state, fixture.dependencies());
}

describe('watch heartbeat and edge semantics', () => {
  it('alerts once on a terminal-artifact status disagreement and ignores matching or ambiguous controls', () => {
    const fixture = new WatchFixture();
    fixture.addRun('mismatched', {
      status: 'complete',
      terminalArtifact: 'escalation_note.md',
      terminalStates: {
        complete: { paths: ['docs/parity_verification.md'] },
        escalated: { paths: ['docs/front_end_parity/escalation_note.md'] },
      },
      stages: {},
    });
    fixture.addRun('matching', {
      status: 'escalated',
      terminalArtifact: 'result.md',
      terminalStates: { escalated: { paths: ['docs/result.md'] } },
      stages: {},
    });
    fixture.addRun('ambiguous', {
      status: 'complete',
      terminalArtifact: 'result.md',
      terminalStates: {
        complete: { paths: ['good/result.md'] },
        escalated: { paths: ['blocked/result.md'] },
      },
      stages: {},
    });
    const before = fixture.snapshot();

    const first = poll(fixture);
    expect(first.alerts).toEqual([expect.objectContaining({
      kind: 'terminal_status_mismatch',
      runId: 'mismatched',
      lifecycleStatus: 'complete',
      terminalStatus: 'escalated',
      terminalArtifact: 'escalation_note.md',
    })]);
    expect(formatWatchPoll(first)).toContain(
      '[STATUS MISMATCH] mismatched: lifecycle status complete; terminal artifact "escalation_note.md" declares escalated',
    );
    const second = poll(fixture, first.state);
    expect(second.alerts).toEqual([]);
    expect(formatWatchPoll(second)).toEqual([]);
    expect(fixture.snapshot()).toBe(before);
  });

  it('alerts when a settled running run has one fresh declared terminal artifact', () => {
    const fixture = new WatchFixture();
    const projectDir = join(fixture.root, 'projects', 'settled');
    fixture.addArtifact(join(projectDir, 'docs', 'final_verification.md'), 2_000);
    fixture.addRun('settled-but-running', {
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
      projectDir,
      stages: {
        implement: { status: 'complete' },
        verify: { status: 'complete' },
      },
      terminalStates: {
        complete: { paths: ['docs/final_verification.md'] },
        escalated: { paths: ['docs/escalation_note.md'] },
      },
    });
    const before = fixture.snapshot();

    const first = poll(fixture);
    expect(first.alerts).toEqual([expect.objectContaining({
      kind: 'terminal_status_mismatch',
      runId: 'settled-but-running',
      lifecycleStatus: 'running',
      terminalStatus: 'complete',
      terminalArtifact: 'final_verification.md',
    })]);
    expect(formatWatchPoll(first)).toContain(
      '[STATUS MISMATCH] settled-but-running: lifecycle status running; terminal artifact "final_verification.md" declares complete',
    );
    const second = poll(fixture, first.state);
    expect(second.alerts).toEqual([]);
    expect(fixture.snapshot()).toBe(before);
  });

  it('emits a first-pass heartbeat during silence and makes an identical second poll silent', () => {
    const fixture = new WatchFixture();
    fixture.addRun('finished', { status: 'complete', stages: {} });

    const first = poll(fixture);
    expect(first.heartbeat?.stats).toMatchObject({
      entries: 1,
      readableRuns: 1,
      unreadableRuns: 0,
      liveRuns: 0,
      elapsedMs: 275,
    });
    expect(first.alerts).toEqual([]);
    expect(formatWatchPoll(first)).toEqual([
      '[WATCH] armed · 1 entries · 1 readable · 0 live run(s) · scan 0.28s',
    ]);

    const second = poll(fixture, first.state);
    expect(second.heartbeat).toBeUndefined();
    expect(second.alerts).toEqual([]);
    expect(formatWatchPoll(second)).toEqual([]);
  });

  it('reports a pre-existing third attempt on the first pass and does not repeat it', () => {
    const fixture = new WatchFixture();
    fixture.addRun('already-stalled', {
      status: 'running',
      stages: { implementation: { status: 'running', attempts: attempts(3) } },
    }, { pid: 41 });

    const first = poll(fixture);
    expect(first.alerts).toEqual([
      expect.objectContaining({
        kind: 'stage_attempts',
        runId: 'already-stalled',
        stageId: 'implementation',
        attempts: 3,
      }),
    ]);
    const second = poll(fixture, first.state);
    expect(second.alerts).toEqual([]);
  });

  it('keeps attempt two quiet, alerts at attempt three, and stays quiet at attempt four', () => {
    const fixture = new WatchFixture();
    const stateAt = (count: number) => ({
      status: 'running',
      stages: { implementation: { status: 'running', attempts: attempts(count) } },
    });
    fixture.addRun('edge-at-three', stateAt(2), { pid: 42 });

    const atTwo = poll(fixture);
    expect(atTwo.alerts).toEqual([]);
    fixture.setRunState('edge-at-three', stateAt(3));
    const atThree = poll(fixture, atTwo.state);
    expect(atThree.alerts).toHaveLength(1);
    expect(atThree.alerts[0]).toMatchObject({ kind: 'stage_attempts', attempts: 3 });
    fixture.setRunState('edge-at-three', stateAt(4));
    const atFour = poll(fixture, atThree.state);
    expect(atFour.alerts).toEqual([]);
  });

  it('emits no ordinary stage or run transition noise', () => {
    const fixture = new WatchFixture();
    fixture.addRun('healthy', {
      status: 'running',
      stages: { verify: { status: 'pending', attempts: attempts(1) } },
    }, { pid: 43 });
    const first = poll(fixture);
    fixture.setRunState('healthy', {
      status: 'running',
      stages: { verify: { status: 'running', attempts: attempts(1) } },
    });

    const transitioned = poll(fixture, first.state);
    expect(transitioned.alerts).toEqual([]);
    expect(formatWatchPoll(transitioned)).toEqual([]);
  });
});

describe('watch process-authoritative liveness', () => {
  it('does not treat a stale running status with a dead scheduler as work in flight', () => {
    const fixture = new WatchFixture();
    fixture.addRun('orphan', {
      status: 'running',
      stages: { verify: { status: 'running', attempts: attempts(3) } },
    }, { pid: 51, live: false });

    const result = poll(fixture);
    expect(result.stats.liveRuns).toBe(0);
    expect(result.alerts).toEqual([]);
    expect(fixture.livenessProbe).toHaveBeenCalledExactlyOnceWith(51);
  });

  it('alerts when the scheduler probe later makes the same on-disk stall live', () => {
    const fixture = new WatchFixture();
    fixture.addRun('revived', {
      status: 'running',
      stages: { verify: { status: 'running', attempts: attempts(3) } },
    }, { pid: 52, live: false });
    const dead = poll(fixture);
    fixture.livePids.add(52);

    const live = poll(fixture, dead.state);
    expect(live.stats.liveRuns).toBe(1);
    expect(live.alerts).toEqual([
      expect.objectContaining({ kind: 'stage_attempts', runId: 'revived' }),
    ]);
  });

  it('rejects malformed and missing scheduler markers without probing a process', () => {
    const fixture = new WatchFixture();
    fixture.addRun('malformed-pid', {
      status: 'running',
      stages: { verify: { attempts: attempts(3) } },
    });
    fixture.files.set(join(fixture.root, 'malformed-pid', 'scheduler.pid'), '53 trailing');
    fixture.addRun('missing-pid', {
      status: 'running',
      stages: { verify: { attempts: attempts(3) } },
    });

    const result = poll(fixture);
    expect(result.stats.liveRuns).toBe(0);
    expect(result.alerts).toEqual([]);
    expect(fixture.livenessProbe).not.toHaveBeenCalled();
  });
});

describe('watch gate convergence judgements', () => {
  it('alerts on the first pass when two same-metric rejections made no progress', () => {
    const fixture = new WatchFixture();
    fixture.addRun('gate-stall', { status: 'running', stages: {} }, { pid: 61 });
    fixture.addVerdict('gate-stall', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 17, threshold: 0, pass: false,
    });
    fixture.addVerdict('gate-stall', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 17, threshold: 0, pass: false,
    });

    const first = poll(fixture);
    expect(first.alerts).toEqual([
      expect.objectContaining({
        kind: 'gate_not_converging',
        gateId: 'verify_ship',
        metric: 'failing_tests',
        previousScore: 17,
        latestScore: 17,
        threshold: 0,
        rejections: 2,
      }),
    ]);
    const second = poll(fixture, first.state);
    expect(second.alerts).toEqual([]);
    fixture.addVerdict('gate-stall', 'verify_ship', { iteration: 1, round: 3 }, {
      metric: 'failing_tests', score: 18, threshold: 0, pass: false,
    });
    const thirdRejection = poll(fixture, second.state);
    expect(thirdRejection.alerts).toEqual([]);
  });

  it('keeps two rejections quiet when the latest score improves toward the threshold', () => {
    const fixture = new WatchFixture();
    fixture.addRun('improving-gate', { status: 'running', stages: {} }, { pid: 62 });
    fixture.addVerdict('improving-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 17, threshold: 0,
    });
    fixture.addVerdict('improving-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 12, threshold: 0,
    });

    expect(poll(fixture).alerts).toEqual([]);
  });

  it('re-arms a gate edge after measurable improvement clears the prior stall', () => {
    const fixture = new WatchFixture();
    fixture.addRun('rearmed-gate', { status: 'running', stages: {} }, { pid: 66 });
    fixture.addVerdict('rearmed-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 17, threshold: 0,
    });
    fixture.addVerdict('rearmed-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 17, threshold: 0,
    });
    const stalled = poll(fixture);
    expect(stalled.alerts).toHaveLength(1);

    fixture.addVerdict('rearmed-gate', 'verify_ship', { iteration: 1, round: 3 }, {
      metric: 'failing_tests', score: 12, threshold: 0,
    });
    const improving = poll(fixture, stalled.state);
    expect(improving.alerts).toEqual([]);
    expect(improving.state.activeConditionIds.size).toBe(0);

    fixture.addVerdict('rearmed-gate', 'verify_ship', { iteration: 1, round: 4 }, {
      metric: 'failing_tests', score: 12, threshold: 0,
    });
    const stalledAgain = poll(fixture, improving.state);
    expect(stalledAgain.alerts).toEqual([
      expect.objectContaining({
        kind: 'gate_not_converging', previousScore: 12, latestScore: 12,
      }),
    ]);
  });

  it('does not compare different metrics or thresholds as one stalled condition', () => {
    const fixture = new WatchFixture();
    fixture.addRun('incomparable-gate', { status: 'running', stages: {} }, { pid: 63 });
    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'warnings', score: 4, threshold: 0,
    });
    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 4, threshold: 0,
    });
    expect(poll(fixture).alerts).toEqual([]);

    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 3 }, {
      metric: 'failing_tests', score: 4, threshold: 1,
    });
    expect(poll(fixture).alerts).toEqual([]);
  });

  it('ignores stale legacy rounds when a canonical iteration namespace exists', () => {
    const fixture = new WatchFixture();
    fixture.addRun('mixed-layout', { status: 'running', stages: {} }, { pid: 64 });
    fixture.addVerdict('mixed-layout', 'verify_ship', { round: 1 }, {
      metric: 'failing_tests', score: 9, threshold: 0,
    });
    fixture.addVerdict('mixed-layout', 'verify_ship', { round: 2 }, {
      metric: 'failing_tests', score: 9, threshold: 0,
    });
    fixture.addVerdict('mixed-layout', 'verify_ship', { iteration: 2, round: 1 }, {
      metric: 'failing_tests', score: 3, threshold: 0,
    });

    expect(poll(fixture).alerts).toEqual([]);
  });

  it('still judges a pure legacy round-only archive without changing it', () => {
    const fixture = new WatchFixture();
    fixture.addRun('legacy-layout', { status: 'running', stages: {} }, { pid: 67 });
    fixture.addVerdict('legacy-layout', 'verify_ship', { round: 1 }, {
      metric: 'failing_tests', score: 5, threshold: 0,
    });
    fixture.addVerdict('legacy-layout', 'verify_ship', { round: 2 }, {
      metric: 'failing_tests', score: 5, threshold: 0,
    });
    const before = fixture.snapshot();

    expect(poll(fixture).alerts).toEqual([
      expect.objectContaining({ kind: 'gate_not_converging', runId: 'legacy-layout' }),
    ]);
    expect(fixture.snapshot()).toBe(before);
  });

  it('aggregates invalid verdict diagnostics without emitting a false stall', () => {
    const fixture = new WatchFixture();
    fixture.addRun('bad-evidence', { status: 'running', stages: {} }, { pid: 65 });
    fixture.addVerdict('bad-evidence', 'verify_ship', { iteration: 1, round: 1 }, '{not-json');
    fixture.addVerdict('bad-evidence', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: '17', threshold: 0,
    });

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(2);
    expect(result.alerts).toEqual([]);
    const lines = formatWatchPoll(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 invalid verdicts');
    expect(lines[0]).not.toContain('verify_ship');
  });
});

describe('watch single-pass and read-only behavior', () => {
  it('scans a large runs root once, summarizes unreadable entries, and leaves every byte unchanged', () => {
    const fixture = new WatchFixture();
    for (let index = 0; index < 3_026; index++) {
      fixture.addRun(`readable-${index}`, { status: 'complete', stages: {} });
    }
    for (let index = 0; index < 4_577; index++) {
      fixture.addUnreadableRunEntry(`unreadable-${index}`);
    }
    const before = fixture.snapshot();

    const result = poll(fixture);

    expect(result.stats).toMatchObject({
      entries: 7_603,
      readableRuns: 3_026,
      unreadableRuns: 4_577,
      liveRuns: 0,
    });
    expect(fixture.rootReads).toBe(1);
    expect(fixture.livenessProbe).not.toHaveBeenCalled();
    expect(result.alerts).toEqual([]);
    expect(formatWatchPoll(result)).toHaveLength(1);
    expect(formatWatchPoll(result)[0]).toContain('4577 unreadable run entries');
    expect(formatWatchPoll(result)[0]).not.toContain('unreadable-0');
    expect(fixture.snapshot()).toBe(before);
  });

  it('bounds an unavailable runs root to one heartbeat diagnostic', () => {
    const result = pollWatch(createWatchState(), {
      runsRoot: join(tmpdir(), 'missing-watch-root'),
      readDirectory: () => { throw new Error('unavailable'); },
      readText: () => { throw new Error('must not read'); },
      isProcessAlive: () => { throw new Error('must not probe'); },
      nowMs: () => 100,
    });

    expect(result.stats).toMatchObject({ entries: 0, rootReadErrors: 1 });
    expect(formatWatchPoll(result)).toEqual([
      '[WATCH] armed · 0 entries · 0 readable · 0 live run(s) · scan 0.00s · diagnostics: runs root unavailable',
    ]);
  });
});

describe('watch command adapter', () => {
  it('runs exactly one injected poll with --once and never sleeps', async () => {
    const fixture = new WatchFixture();
    const stdout = new Capture();
    const stderr = new Capture();
    const sleep = vi.fn(async () => {});

    const code = await cmdWatchWithDeps(['watch', '--once'], {
      ...fixture.dependencies(),
      stdout: stdout.writer,
      stderr: stderr.writer,
      sleep,
    });

    expect(code).toBe(0);
    expect(fixture.rootReads).toBe(1);
    expect(stdout.value).toContain('[WATCH] armed');
    expect(stderr.value).toBe('');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('accepts a bounded positive interval and rejects zero, excessive, or nonnumeric values', () => {
    expect(parseWatchArgs(['watch', '--poll', '1'])).toMatchObject({ pollMs: 1_000 });
    expect(parseWatchArgs(['--poll=3600'])).toMatchObject({ pollMs: 3_600_000 });
    expect(() => parseWatchArgs(['watch', '--poll', '0'])).toThrow(/between 1 and 3600/);
    expect(() => parseWatchArgs(['watch', '--poll', '3601'])).toThrow(/between 1 and 3600/);
    expect(() => parseWatchArgs(['watch', '--poll', 'soon'])).toThrow(/number of seconds/);
  });

  it('prints help without reading runs and fails closed on an unknown option', async () => {
    const fixture = new WatchFixture();
    const helpOut = new Capture();
    const helpCode = await cmdWatchWithDeps(['watch', '--help'], {
      ...fixture.dependencies(),
      stdout: helpOut.writer,
    });
    expect(helpCode).toBe(0);
    expect(helpOut.value).toBe(`${watchUsage()}\n`);
    expect(fixture.rootReads).toBe(0);

    const errorOut = new Capture();
    const errorCode = await cmdWatchWithDeps(['watch', '--transition-events'], {
      ...fixture.dependencies(),
      stderr: errorOut.writer,
    });
    expect(errorCode).toBe(1);
    expect(errorOut.value).toContain('unknown watch option');
    expect(fixture.rootReads).toBe(0);
  });
});
