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
  WATCH_TERMINAL_GRACE_MS,
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
  readonly unreadableDirectories = new Set<string>();
  readonly unreadableMetadata = new Set<string>();
  readonly metadataKinds = new Map<string, 'file' | 'directory' | 'symlink' | 'other'>();
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

  setMtime(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs);
  }

  setPathKind(path: string, kind: 'file' | 'directory' | 'symlink' | 'other'): void {
    this.metadataKinds.set(path, kind);
  }

  setRunMtime(runId: string, mtimeMs: number): void {
    this.setMtime(join(this.root, runId, 'run.json'), mtimeMs);
  }

  addStageEvidence(
    runId: string,
    stageId: string,
    files: Record<string, number> = { 'status.json': 0 },
  ): void {
    const runDir = join(this.root, runId);
    const stagesDir = this.directories.has(join(runDir, 'stages'))
      ? join(runDir, 'stages')
      : this.addDirectory(runDir, 'stages');
    const stageDir = this.addDirectory(stagesDir, stageId);
    for (const [name, mtimeMs] of Object.entries(files)) {
      this.addEntry(stageDir, name);
      this.files.set(join(stageDir, name), 'fixture evidence');
      this.mtimes.set(join(stageDir, name), mtimeMs);
    }
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
    this.mtimes.set(join(runDir, 'run.json'), 0);
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
  ): string {
    const runDir = join(this.root, runId);
    const archive = this.addDirectory(runDir, 'gate_reevaluation');
    let parent = archive;
    if (coordinate.iteration !== undefined) {
      parent = this.addDirectory(archive, `iteration_${coordinate.iteration}`);
    }
    const round = this.addDirectory(parent, `round_${coordinate.round}`);
    const filename = `rejected_verdict_${gateId}.json`;
    this.addEntry(round, filename);
    const path = join(round, filename);
    this.files.set(path, typeof verdict === 'string' ? verdict : JSON.stringify(verdict));
    return path;
  }

  addMetric(
    runId: string,
    gateId: string,
    coordinate: { iteration?: number; round: number },
    metric: Record<string, unknown> | string,
  ): string {
    const runDir = join(this.root, runId);
    const archive = this.addDirectory(runDir, 'gate_reevaluation');
    let parent = archive;
    if (coordinate.iteration !== undefined) {
      parent = this.addDirectory(archive, `iteration_${coordinate.iteration}`);
    }
    const round = this.addDirectory(parent, `round_${coordinate.round}`);
    const filename = `metric_${gateId}.json`;
    this.addEntry(round, filename);
    const path = join(round, filename);
    this.files.set(path, typeof metric === 'string' ? metric : JSON.stringify(metric));
    return path;
  }

  dependencies(overrides: WatchPollDependencies = {}): WatchPollDependencies {
    return {
      runsRoot: this.root,
      readDirectory: (path) => {
        if (this.unreadableDirectories.has(path)) throw new Error(`unreadable directory: ${path}`);
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
      readPathMetadata: (path) => {
        if (this.unreadableMetadata.has(path)) throw new Error(`unreadable metadata: ${path}`);
        const overriddenKind = this.metadataKinds.get(path);
        if (overriddenKind) return { kind: overriddenKind, mtimeMs: this.mtimes.get(path) ?? 0 };
        if (this.directories.has(path)) {
          return { kind: 'directory' as const, mtimeMs: this.mtimes.get(path) ?? 0 };
        }
        if (this.files.has(path)) {
          return { kind: 'file' as const, mtimeMs: this.mtimes.get(path) ?? 0 };
        }
        return undefined;
      },
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
      unreadableDirectories: [...this.unreadableDirectories],
      unreadableMetadata: [...this.unreadableMetadata],
      metadataKinds: [...this.metadataKinds],
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
    }, { pid: 40 });
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

  it('keeps a healthy third attempt quiet when its gate evidence is improving', () => {
    const fixture = new WatchFixture();
    fixture.addRun('converging-at-three', {
      status: 'running',
      stages: { verify: { status: 'running', attempts: attempts(3) } },
    }, { pid: 41 });
    fixture.addVerdict('converging-at-three', 'verify', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 17, threshold: 0,
    });
    fixture.addVerdict('converging-at-three', 'verify', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 1, threshold: 0,
    });

    const first = poll(fixture);
    expect(first.alerts).toEqual([]);
    const second = poll(fixture, first.state);
    expect(second.alerts).toEqual([]);
  });

  it('does not use attempt three or four as a stall proxy', () => {
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
    expect(atThree.alerts).toEqual([]);
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

  it('does not turn a high attempt count into a stall when the scheduler becomes live', () => {
    const fixture = new WatchFixture();
    fixture.addRun('revived', {
      status: 'running',
      stages: { verify: { status: 'running', attempts: attempts(3) } },
    }, { pid: 52, live: false });
    const dead = poll(fixture);
    fixture.livePids.add(52);

    const live = poll(fixture, dead.state);
    expect(live.stats.liveRuns).toBe(1);
    expect(live.alerts).toEqual([]);
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
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'run_liveness' }),
    ]);
    expect(fixture.livenessProbe).not.toHaveBeenCalled();
  });
});

describe('watch delayed terminal indecision', () => {
  const terminalContract = {
    complete: { paths: ['docs/final_verification.md'] },
    escalated: { paths: ['docs/escalation_note.md'] },
  };

  function quiescentState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
      stages: {
        verify: { status: 'complete' },
        repair: { status: 'pending' },
      },
      terminalStates: terminalContract,
      ...overrides,
    };
  }

  it('alerts after a very old last write even when an unused repair stage remains pending', () => {
    const fixture = new WatchFixture();
    fixture.addRun('undecided', quiescentState(), { pid: 71 });
    fixture.addStageEvidence('undecided', 'verify', { 'status.json': 1_000, 'output.md': 2_000 });
    fixture.addStageEvidence('undecided', 'repair', { 'status.json': 2_000 });
    fixture.setRunMtime('undecided', 2_000);
    const before = fixture.snapshot();

    const first = pollWatch(createWatchState(), fixture.dependencies({ nowMs: () => 86_400_000 }));
    expect(first.alerts).toEqual([
      expect.objectContaining({
        kind: 'terminal_indecision',
        runId: 'undecided',
      }),
    ]);
    expect(formatWatchPoll(first).some((line) => (
      line.includes('[STALL]') && line.includes('terminal decision')
    ))).toBe(true);
    const second = pollWatch(first.state, fixture.dependencies({ nowMs: () => 86_400_000 }));
    expect(second.alerts).toEqual([]);
    expect(fixture.snapshot()).toBe(before);
  });

  it('fires at the derived grace boundary and stays silent one millisecond before it', () => {
    const below = new WatchFixture();
    below.addRun('below-grace', quiescentState(), { pid: 79 });
    below.setRunMtime('below-grace', 0);
    const belowResult = pollWatch(createWatchState(), below.dependencies({
      nowMs: () => WATCH_TERMINAL_GRACE_MS - 1,
    }));
    expect(belowResult.alerts.filter((alert) => alert.kind === 'terminal_indecision')).toEqual([]);

    const at = new WatchFixture();
    at.addRun('at-grace', quiescentState(), { pid: 80 });
    at.setRunMtime('at-grace', 0);
    const atResult = pollWatch(createWatchState(), at.dependencies({
      nowMs: () => WATCH_TERMINAL_GRACE_MS,
    }));
    expect(atResult.alerts).toEqual([
      expect.objectContaining({
        kind: 'terminal_indecision',
        quietForMs: WATCH_TERMINAL_GRACE_MS,
        graceMs: WATCH_TERMINAL_GRACE_MS,
      }),
    ]);
  });

  it('stays silent within grace, during execution, after a fresh stage-log write, and after terminal status', () => {
    const fixture = new WatchFixture();
    fixture.addRun('fresh-run', quiescentState(), { pid: 72 });
    fixture.setRunMtime('fresh-run', 9_999_999);
    fixture.addRun('executing', quiescentState({
      stages: { verify: { status: 'running' }, repair: { status: 'pending' } },
    }), { pid: 73 });
    fixture.setRunMtime('executing', 1_000);
    fixture.addRun('growing-log', quiescentState(), { pid: 74 });
    fixture.setRunMtime('growing-log', 1_000);
    fixture.addStageEvidence('growing-log', 'verify', { 'live.log': 9_999_999 });
    fixture.addRun('terminal', quiescentState({
      status: 'complete',
      completedAt: new Date(9_000_000).toISOString(),
      terminalArtifact: 'final_verification.md',
    }));

    const result = pollWatch(createWatchState(), fixture.dependencies({ nowMs: () => 10_000_000 }));
    expect(result.alerts.filter((alert) => alert.kind === 'terminal_indecision')).toEqual([]);
  });

  it('diagnoses an unreadable activity clock instead of calling the candidate healthy or stalled', () => {
    const fixture = new WatchFixture();
    fixture.addRun('unknown-clock', quiescentState(), { pid: 75 });
    fixture.unreadableMetadata.add(join(fixture.root, 'unknown-clock', 'run.json'));

    const result = pollWatch(createWatchState(), fixture.dependencies({ nowMs: () => 86_400_000 }));
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        runId: 'unknown-clock',
        evidence: 'terminal_activity',
      }),
    ]);
    expect(formatWatchPoll(result).some((line) => line.includes('[EVIDENCE GAP]'))).toBe(true);
  });

  it('does not follow a symlinked stage-evidence directory', () => {
    const fixture = new WatchFixture();
    fixture.addRun('symlinked-evidence', quiescentState(), { pid: 81 });
    fixture.addStageEvidence('symlinked-evidence', 'verify', { 'live.log': 86_399_999 });
    fixture.setPathKind(join(fixture.root, 'symlinked-evidence', 'stages'), 'symlink');

    const result = pollWatch(createWatchState(), fixture.dependencies({ nowMs: () => 86_400_000 }));
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        runId: 'symlinked-evidence',
        evidence: 'terminal_activity',
        reason: 'malformed',
      }),
    ]);
  });

  it('diagnoses malformed stage and terminal-contract shapes without inferring a stall', () => {
    const fixture = new WatchFixture();
    fixture.addRun('bad-stages', quiescentState({ stages: 'not-an-object' }), { pid: 76 });
    fixture.addRun('bad-contract', quiescentState({ terminalStates: { complete: { paths: 'not-an-array' } } }), { pid: 77 });

    const result = pollWatch(createWatchState(), fixture.dependencies({ nowMs: () => 86_400_000 }));
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', runId: 'bad-contract', evidence: 'terminal_shape' }),
      expect.objectContaining({ kind: 'evidence_gap', runId: 'bad-stages', evidence: 'terminal_shape' }),
    ]);
    expect(result.alerts.some((alert) => alert.kind === 'terminal_indecision')).toBe(false);
  });
});

describe('watch gate convergence judgements', () => {
  it('joins current rejected verdicts to their co-archived metric artifacts', () => {
    const fixture = new WatchFixture();
    fixture.addRun('split-metric', { status: 'running', stages: {} }, { pid: 83 });
    for (const round of [1, 2]) {
      fixture.addVerdict('split-metric', 'audit_lint', { iteration: 1, round }, {
        pass: false, reason: 'lint gate rejected',
      });
      fixture.addMetric('split-metric', 'audit_lint', { iteration: 1, round }, {
        hasMetric: true,
        metric: 'warning_count',
        value: round === 1 ? 32 : 32,
        higherIsBetter: false,
        threshold: 0,
        pass: false,
      });
    }

    const result = poll(fixture);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'gate_not_converging',
        movement: 'plateau',
        previousScore: 32,
        latestScore: 32,
        threshold: 0,
      }),
    ]);
  });

  it('keeps a valid unscored rejected gate quiet', () => {
    const fixture = new WatchFixture();
    fixture.addRun('unscored-gate', { status: 'running', stages: {} }, { pid: 84 });
    fixture.addVerdict('unscored-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      pass: false, reason: 'contract issue',
    });

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(0);
    expect(result.alerts).toEqual([]);
  });

  it('treats hasMetric false as authoritative over legacy-looking verdict fields', () => {
    const fixture = new WatchFixture();
    fixture.addRun('authoritative-unscored', { status: 'running', stages: {} }, { pid: 88 });
    for (const [round, score] of [[1, 2], [2, 3]] as const) {
      fixture.addVerdict('authoritative-unscored', 'verify_ship', { iteration: 1, round }, {
        pass: false,
        metric: 'failing_tests',
        score,
        threshold: 0,
      });
      fixture.addMetric('authoritative-unscored', 'verify_ship', { iteration: 1, round }, {
        hasMetric: false,
        reason: 'no trustworthy numeric metric',
      });
    }

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(0);
    expect(result.alerts).toEqual([]);
  });

  it('does not reuse an older plateau after a newer unscored rejection', () => {
    const fixture = new WatchFixture();
    fixture.addRun('newest-unscored', { status: 'running', stages: {} }, { pid: 89 });
    for (const round of [1, 2]) {
      fixture.addVerdict('newest-unscored', 'verify_ship', { iteration: 1, round }, {
        metric: 'failing_tests', score: 32, threshold: 0,
      });
    }
    fixture.addVerdict('newest-unscored', 'verify_ship', { iteration: 1, round: 3 }, {
      pass: false, reason: 'no numeric campaign metric',
    });

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(0);
    expect(result.alerts).toEqual([]);
  });

  it('diagnoses a malformed newest rejection without reviving an older plateau', () => {
    const fixture = new WatchFixture();
    fixture.addRun('newest-malformed', { status: 'running', stages: {} }, { pid: 90 });
    for (const round of [1, 2]) {
      fixture.addVerdict('newest-malformed', 'verify_ship', { iteration: 1, round }, {
        metric: 'failing_tests', score: 32, threshold: 0,
      });
    }
    fixture.addVerdict(
      'newest-malformed',
      'verify_ship',
      { iteration: 1, round: 3 },
      '{not-json',
    );

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(1);
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'gate_archive' }),
    ]);
  });

  it('does not fall back to verdict fields when the current metric artifact is malformed', () => {
    const fixture = new WatchFixture();
    fixture.addRun('malformed-current-metric', { status: 'running', stages: {} }, { pid: 91 });
    for (const round of [1, 2]) {
      fixture.addVerdict('malformed-current-metric', 'verify_ship', { iteration: 1, round }, {
        pass: false,
        metric: 'failing_tests',
        score: 32,
        threshold: 0,
      });
    }
    fixture.addMetric(
      'malformed-current-metric',
      'verify_ship',
      { iteration: 1, round: 2 },
      '{not-json',
    );

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(1);
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'gate_archive' }),
    ]);
  });

  it('diagnoses a numeric metric without a threshold as unjudgeable', () => {
    const fixture = new WatchFixture();
    fixture.addRun('thresholdless-gate', { status: 'running', stages: {} }, { pid: 85 });
    for (const round of [1, 2]) {
      fixture.addVerdict('thresholdless-gate', 'verify_ship', { iteration: 1, round }, {
        pass: false, reason: 'below campaign target',
      });
      fixture.addMetric('thresholdless-gate', 'verify_ship', { iteration: 1, round }, {
        hasMetric: true,
        metric: 'score',
        value: round,
        higherIsBetter: true,
        threshold: null,
        pass: false,
      });
    }

    expect(poll(fixture).alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        evidence: 'gate_comparison',
        reason: 'threshold_missing',
      }),
    ]);
  });

  it('diagnoses rejected metrics that contradict their declared direction', () => {
    const fixture = new WatchFixture();
    fixture.addRun('contradictory-gate', { status: 'running', stages: {} }, { pid: 86 });
    for (const round of [1, 2]) {
      fixture.addVerdict('contradictory-gate', 'verify_ship', { iteration: 1, round }, {
        pass: false, reason: 'unexpected rejection',
      });
      fixture.addMetric('contradictory-gate', 'verify_ship', { iteration: 1, round }, {
        hasMetric: true,
        metric: 'score',
        value: round + 10,
        higherIsBetter: true,
        threshold: 10,
        pass: false,
      });
    }

    expect(poll(fixture).alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        evidence: 'gate_comparison',
        reason: 'rejection_contradiction',
      }),
    ]);
  });

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
        movement: 'plateau',
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

  it('alerts explicitly when a gate metric moves away from its threshold', () => {
    const fixture = new WatchFixture();
    fixture.addRun('regressing-gate', { status: 'running', stages: {} }, { pid: 68 });
    fixture.addVerdict('regressing-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 2, threshold: 0,
    });
    fixture.addVerdict('regressing-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 3, threshold: 0,
    });

    const result = poll(fixture);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'gate_not_converging',
        movement: 'regression',
        previousScore: 2,
        latestScore: 3,
        threshold: 0,
      }),
    ]);
    expect(formatWatchPoll(result).some((line) => line.includes('moving away'))).toBe(true);
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

  it('reports that changed metrics or thresholds are not comparable', () => {
    const fixture = new WatchFixture();
    fixture.addRun('incomparable-gate', { status: 'running', stages: {} }, { pid: 63 });
    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'warnings', score: 4, threshold: 0,
    });
    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 4, threshold: 0,
    });
    expect(poll(fixture).alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        runId: 'incomparable-gate',
        evidence: 'gate_comparison',
      }),
    ]);

    fixture.addVerdict('incomparable-gate', 'verify_ship', { iteration: 1, round: 3 }, {
      metric: 'failing_tests', score: 4, threshold: 1,
    });
    expect(poll(fixture).alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        evidence: 'gate_comparison',
      }),
    ]);
  });

  it('does not infer direction when rejected scores cross the threshold', () => {
    const fixture = new WatchFixture();
    fixture.addRun('crossing-gate', { status: 'running', stages: {} }, { pid: 69 });
    fixture.addVerdict('crossing-gate', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'score', score: -2, threshold: 0,
    });
    fixture.addVerdict('crossing-gate', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'score', score: 3, threshold: 0,
    });

    const result = poll(fixture);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        runId: 'crossing-gate',
        evidence: 'gate_comparison',
      }),
    ]);
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

  it('emits an evidence-gap edge for invalid verdicts without emitting a false stall', () => {
    const fixture = new WatchFixture();
    fixture.addRun('bad-evidence', { status: 'running', stages: {} }, { pid: 65 });
    fixture.addVerdict('bad-evidence', 'verify_ship', { iteration: 1, round: 1 }, '{not-json');
    fixture.addVerdict('bad-evidence', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: '17', threshold: 0,
    });

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(2);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        evidence: 'gate_archive',
        count: 2,
      }),
    ]);
    const lines = formatWatchPoll(result);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2 invalid verdicts');
    expect(lines[1]).toContain('[EVIDENCE GAP]');
    expect(lines.join('\n')).not.toContain('verify_ship');
  });

  it('emits an evidence-gap edge for a malformed co-archived metric', () => {
    const fixture = new WatchFixture();
    fixture.addRun('bad-metric', { status: 'running', stages: {} }, { pid: 87 });
    fixture.addVerdict('bad-metric', 'verify_ship', { iteration: 1, round: 1 }, {
      pass: false, reason: 'rejected',
    });
    fixture.addMetric('bad-metric', 'verify_ship', { iteration: 1, round: 1 }, '{not-json');

    const result = poll(fixture);
    expect(result.stats.invalidVerdicts).toBe(1);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        kind: 'evidence_gap',
        evidence: 'gate_archive',
        runId: 'bad-metric',
      }),
    ]);
  });

  it('reports malformed evidence introduced after initialization, recovers, and re-arms', () => {
    const fixture = new WatchFixture();
    fixture.addRun('late-bad-evidence', { status: 'running', stages: {} }, { pid: 70 });
    const armed = poll(fixture);
    const verdictPath = fixture.addVerdict(
      'late-bad-evidence',
      'verify_ship',
      { iteration: 1, round: 1 },
      '{not-json',
    );

    const malformed = poll(fixture, armed.state);
    expect(malformed.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'gate_archive' }),
    ]);
    expect(formatWatchPoll(malformed).some((line) => line.includes('[EVIDENCE GAP]'))).toBe(true);
    const unchanged = poll(fixture, malformed.state);
    expect(unchanged.alerts).toEqual([]);

    fixture.files.set(verdictPath, JSON.stringify({
      metric: 'failing_tests', score: 1, threshold: 0,
    }));
    const recovered = poll(fixture, unchanged.state);
    expect(recovered.alerts).toEqual([]);
    expect(recovered.state.activeConditionIds.size).toBe(0);

    fixture.files.set(verdictPath, '{broken-again');
    const recurred = poll(fixture, recovered.state);
    expect(recurred.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'gate_archive' }),
    ]);
  });

  it('reports an archive directory read failure as an evidence gap', () => {
    const fixture = new WatchFixture();
    fixture.addRun('unreadable-archive', { status: 'running', stages: {} }, { pid: 78 });
    fixture.addVerdict('unreadable-archive', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 2, threshold: 0,
    });
    fixture.unreadableDirectories.add(join(
      fixture.root,
      'unreadable-archive',
      'gate_reevaluation',
      'iteration_1',
      'round_1',
    ));

    const result = poll(fixture);
    expect(result.stats.archiveReadErrors).toBe(1);
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'gate_archive' }),
    ]);
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
    expect(result.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'run_state', count: 4_577 }),
    ]);
    expect(formatWatchPoll(result)).toHaveLength(2);
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
      '[EVIDENCE GAP] runs root unavailable; no runs were judged',
    ]);
  });

  it('emits a stable runs-root evidence edge after initialization and re-arms after recovery', () => {
    const fixture = new WatchFixture();
    const armed = poll(fixture);
    fixture.unreadableDirectories.add(fixture.root);

    const unavailable = poll(fixture, armed.state);
    expect(unavailable.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'runs_root' }),
    ]);
    expect(formatWatchPoll(unavailable)).toEqual([
      '[EVIDENCE GAP] runs root unavailable; no runs were judged',
    ]);
    const unchanged = poll(fixture, unavailable.state);
    expect(unchanged.alerts).toEqual([]);

    fixture.unreadableDirectories.delete(fixture.root);
    const recovered = poll(fixture, unchanged.state);
    expect(recovered.alerts).toEqual([]);
    fixture.unreadableDirectories.add(fixture.root);
    const recurred = poll(fixture, recovered.state);
    expect(recurred.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'runs_root' }),
    ]);
  });

  it('does not re-emit an unchanged stall merely because the runs root was temporarily unavailable', () => {
    const fixture = new WatchFixture();
    fixture.addRun('persistent-stall', { status: 'running', stages: {} }, { pid: 82 });
    fixture.addVerdict('persistent-stall', 'verify_ship', { iteration: 1, round: 1 }, {
      metric: 'failing_tests', score: 2, threshold: 0,
    });
    fixture.addVerdict('persistent-stall', 'verify_ship', { iteration: 1, round: 2 }, {
      metric: 'failing_tests', score: 2, threshold: 0,
    });
    const stalled = poll(fixture);
    expect(stalled.alerts).toEqual([
      expect.objectContaining({ kind: 'gate_not_converging' }),
    ]);

    fixture.unreadableDirectories.add(fixture.root);
    const unavailable = poll(fixture, stalled.state);
    expect(unavailable.alerts).toEqual([
      expect.objectContaining({ kind: 'evidence_gap', evidence: 'runs_root' }),
    ]);

    fixture.unreadableDirectories.delete(fixture.root);
    const recovered = poll(fixture, unavailable.state);
    expect(recovered.alerts).toEqual([]);
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
