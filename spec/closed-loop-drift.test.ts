import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeTaskWithRunState } from '../src/cli-daemon.js';
import { buildOperationalProjection, readOperationalProjection } from '../src/cli-events.js';
import { formatWatchPoll } from '../src/cli-watch.js';
import {
  buildRunDriftProjection,
  formatRunDriftProjection,
  formatRunDriftRow,
  readRunDriftProjection,
  type RunDriftProjection,
  type RunDriftRow,
  type RunDriftRowId,
} from '../src/run-drift.js';
import type { TaskEntry } from '../src/task-registry.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import {
  EXPECTED_DRIFT_ROW_IDS,
  fixtureMutationHash,
  loadClosedLoopDriftEvidence,
  materializeClosedLoopDriftFixture,
  resizeFixtureServiceLog,
  type MaterializedClosedLoopDriftFixture,
} from './test-support/closed-loop-drift-evidence.js';

const LOG_WARNING_BYTES = 64 * 1024 * 1024;
const temporaryRoots: string[] = [];

function fixture(): MaterializedClosedLoopDriftFixture {
  const value = materializeClosedLoopDriftFixture();
  temporaryRoots.push(value.root);
  return value;
}

function row(projection: RunDriftProjection, id: RunDriftRowId): RunDriftRow {
  const found = projection.rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing drift row ${id}`);
  return found;
}

function watchOnce(
  value: MaterializedClosedLoopDriftFixture,
  previous = createWatchState(),
) {
  return pollWatch(previous, {
    runsRoot: value.runsRoot,
    candidateRunIds: () => [value.runId],
    isProcessAlive: () => true,
    nowMs: () => Date.parse('2026-09-04T03:07:00.000Z'),
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('closed-loop drift projection', () => {
  it('replays all six evidence quantities with explicit thresholds and distributions', () => {
    const value = fixture();
    const projection = readRunDriftProjection(value.runDir);

    expect(new Set(projection.rows.map((candidate) => candidate.id))).toEqual(EXPECTED_DRIFT_ROW_IDS);
    expect(projection.rows).toHaveLength(6);
    for (const candidate of projection.rows) {
      expect(candidate.source.reference).not.toBe('');
      expect(candidate.source.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(candidate.threshold.display).not.toBe('');
      expect(candidate.unit).not.toBe('');
      expect(candidate.crossing).not.toBe('unavailable');
    }

    const dose = row(projection, 'research_dose');
    expect(dose).toMatchObject({
      value: value.evidence.historical.doseMinutes.at(-1),
      unit: 'minutes',
      crossing: 'below',
      threshold: { kind: 'floor', operator: '>=', value: 20, unit: 'minutes' },
      trend: { values: value.evidence.historical.doseMinutes, direction: 'mixed', unit: 'minutes' },
      distribution: {
        sampleCount: 3,
        mean: 1.818787555105746,
        median: 2.1175898313695143,
        reportedValue: 2.1175898313695143,
        reportedRank: 1,
        reportedPercentile: 50,
      },
    });
    expect(dose.source.reference).toBe('research_journal.json + research_round_<n>_consumed.json');
    expect(dose.source.reference).not.toMatch(/round_result/u);

    expect(row(projection, 'first_plan_admission')).toMatchObject({
      value: 'rejected',
      comparisonValue: 0,
      crossing: 'below',
      threshold: { kind: 'target', value: 1 },
      annotations: ['unsatisfied_requirements=1', 'later_admitted_attempt=2'],
    });
    expect(row(projection, 'supervisor_rejections')).toMatchObject({
      value: '2 total; max 1/stage; 2 overturned',
      comparisonValue: 1,
      crossing: 'below',
      threshold: { kind: 'budget', operator: '<=', value: 2, unit: 'rejections/stage' },
    });
    expect(row(projection, 'engine_overhead')).toMatchObject({
      value: 40067,
      unit: 'ms/attempt',
      crossing: 'below',
      threshold: { kind: 'warning', operator: '<=', value: 60000 },
      distribution: {
        samples: [41252, 41533, 40067, 38553, 39060],
        sampleCount: 5,
        mean: 40093,
        median: 40067,
        reportedValue: 40067,
        reportedRank: 2,
        reportedPercentile: 50,
      },
    });
    expect(row(projection, 'registry_growth')).toMatchObject({
      value: '22500000 bytes; 18691 records',
      crossing: 'above',
      threshold: { value: LOG_WARNING_BYTES },
      distribution: { mean: 22500000, median: 22500000, reportedPercentile: 50 },
    });
    expect(row(projection, 'log_growth')).toMatchObject({
      value: 168000000,
      crossing: 'above',
      threshold: { value: LOG_WARNING_BYTES },
      distribution: { mean: 168000000, median: 168000000, reportedPercentile: 50 },
    });

    expect(value.evidence.baseFailure).toEqual({
      exitCode: 1,
      logBytes: 988,
      logSha256: 'e7499b5894d598f07979c082a2b5bbf8416d4b691d80a2034198993f290baef5',
    });
    expect(value.evidence.anchors.map((anchor) => anchor.label)).toEqual(expect.arrayContaining([
      'b3-warn-flood-observation',
      'b3-registry-growth-observation',
      'b3-first-plan-admission-reason',
      'b3-supervisor-rejection-1',
      'b3-supervisor-rejection-2',
      'b4-dose-series',
      'b3-overhead-run-state',
    ]));
  });

  it('renders the identical canonical rows in status, task show, and watch without a write', () => {
    const value = fixture();
    const before = fixtureMutationHash(value);
    const status = readOperationalProjection(value.runDir, {
      state: value.state,
      nowMs: Date.parse('2026-09-04T03:07:00.000Z'),
    });
    const task: TaskEntry = {
      id: value.taskId,
      name: 'closed-loop drift replay',
      kind: 'campaign',
      projectDir: value.projectDir,
      systemd_unit: value.unit,
      run_id: value.runId,
      status: 'running',
      attempt: 1,
      max_retries: 3,
      created_at: '2026-09-03T17:09:00.000Z',
      tick_log_path: join(value.fcHome, 'task-ticks.jsonl'),
    };
    const taskShow = mergeTaskWithRunState(task, value.runsRoot);
    const watched = watchOnce(value);
    const after = fixtureMutationHash(value);

    const statusRows = formatRunDriftProjection(status.drift);
    const taskRows = formatRunDriftProjection(taskShow.operational?.drift);
    const watchRows = watched.drift.map((candidate) => formatRunDriftRow(candidate.row));
    expect(statusRows).toEqual(taskRows);
    expect(taskRows).toEqual(watchRows);
    expect(statusRows).toHaveLength(6);
    expect(statusRows.every((line) => line.includes('observed='))).toBe(true);
    expect(formatWatchPoll(watched).filter((line) => line.startsWith('[DRIFT] '))).toEqual(
      watchRows.map((canonical) => `[DRIFT] ${value.runId} · ${canonical}`),
    );
    expect(watched.drift.every((candidate) => !candidate.crossedNow)).toBe(true);
    expect(after).toBe(before);
  });

  it('reads the campaign engine canonical graded-floor line when no schema extension exists', () => {
    const value = fixture();
    const state = structuredClone(value.state) as Record<string, unknown> & {
      research: { resultSchema: Record<string, unknown> };
      taskDescription?: string;
    };
    delete state.research.resultSchema['x-flowcrew-drift'];
    state.taskDescription = [
      '# Successor',
      '',
      '**Graded floor:** `dose_minutes >= 20 minutes`. A value below this floor fails this criterion.',
    ].join('\n');
    writeFileSync(join(value.runDir, 'run.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    const before = fixtureMutationHash(value);

    const projection = readRunDriftProjection(value.runDir, { state });

    expect(fixtureMutationHash(value)).toBe(before);
    expect(row(projection, 'research_dose')).toMatchObject({
      value: value.evidence.historical.doseMinutes.at(-1),
      unit: 'minutes',
      crossing: 'below',
      threshold: {
        kind: 'floor',
        operator: '>=',
        value: 20,
        source: 'run.json#taskDescription[mechanically-derived graded floor]',
      },
      annotations: expect.arrayContaining([
        'definition=run.json#taskDescription[mechanically-derived graded floor]',
      ]),
    });
  });

  it('marks one in-memory watch crossing edge and never repeats or persists it', () => {
    const value = fixture();
    resizeFixtureServiceLog(value, LOG_WARNING_BYTES - 1);
    const firstBefore = fixtureMutationHash(value);
    const first = watchOnce(value);
    expect(fixtureMutationHash(value)).toBe(firstBefore);
    expect(row({ version: 1, rows: first.drift.map((candidate) => candidate.row) }, 'log_growth'))
      .toMatchObject({ crossing: 'below', value: LOG_WARNING_BYTES - 1 });

    resizeFixtureServiceLog(value, LOG_WARNING_BYTES + 1);
    const secondBefore = fixtureMutationHash(value);
    const second = watchOnce(value, first.state);
    expect(fixtureMutationHash(value)).toBe(secondBefore);
    expect(second.drift.filter((candidate) => candidate.crossedNow)).toMatchObject([{
      runId: value.runId,
      previousCrossing: 'below',
      crossedNow: true,
      row: { id: 'log_growth', crossing: 'above', value: LOG_WARNING_BYTES + 1 },
    }]);

    const thirdBefore = fixtureMutationHash(value);
    const third = watchOnce(value, second.state);
    expect(fixtureMutationHash(value)).toBe(thirdBefore);
    expect(third.drift).toEqual([]);
  });

  it('keeps malformed and legacy evidence visibly unavailable instead of fabricating zero', () => {
    const value = fixture();
    writeFileSync(join(value.runDir, 'research_round_2_no_candidate_consumed.json'), '{broken\n');
    writeFileSync(join(value.runDir, 'plan_retry_state.json'), '{broken\n');
    writeFileSync(join(value.runDir, 'signals', 'reject_counts.json'), '{broken\n');
    writeFileSync(join(value.runDir, 'events.jsonl'), '{broken\n');
    const before = fixtureMutationHash(value);
    const malformed = readRunDriftProjection(value.runDir);
    expect(fixtureMutationHash(value)).toBe(before);

    expect(row(malformed, 'research_dose')).toMatchObject({
      value: value.evidence.historical.doseMinutes.at(-1),
      source: { availability: 'partial' },
      annotations: expect.arrayContaining(['unavailable_rounds=2']),
    });
    expect(row(malformed, 'first_plan_admission')).toMatchObject({
      value: null,
      crossing: 'unavailable',
      source: { availability: 'malformed' },
    });
    expect(row(malformed, 'supervisor_rejections')).toMatchObject({
      value: null,
      crossing: 'unavailable',
      source: { availability: 'malformed' },
    });

    const legacy = buildRunDriftProjection({
      runId: 'legacy-run',
      status: 'running',
      research: {
        resultSchema: {
          type: 'object',
          required: ['label', 'result'],
          properties: { label: { type: 'string' }, result: { type: 'number' } },
        },
      },
    }, [
      { type: 'admission_rejected', detail: 'legacy event without an attempt index' },
      { type: 'supervisor_reject', stageId: 'gate', detail: 'reject 1/2: legacy canonical budget' },
    ]);
    expect(row(legacy, 'research_dose')).toMatchObject({ value: null, source: { availability: 'legacy' } });
    expect(row(legacy, 'first_plan_admission')).toMatchObject({ value: null, source: { availability: 'legacy' } });
    expect(row(legacy, 'supervisor_rejections')).toMatchObject({
      value: '1 total; max 1/stage; 0 overturned',
      threshold: { value: 2 },
      source: { availability: 'legacy' },
    });
    expect(legacy.rows.filter((candidate) => candidate.value === 0)).toEqual([]);

    const current = buildOperationalProjection(value.state, value.evidence.events);
    expect(formatRunDriftProjection(current.drift)).toHaveLength(6);
    expect(loadClosedLoopDriftEvidence().baseFailure.exitCode).toBe(1);
  });
});
