import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import type { SupervisorConfig } from '../src/config.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
} from '../src/store.js';
import {
  buildSupervisorSystemPrompt,
  parseSupervisorVerdict,
  Supervisor,
  verifyRepeatedWrongDirection,
  type DirectionEvidenceBinding,
  type DirectionGuidanceFact,
  type SupervisorAssessment,
} from '../src/supervisor.js';

const stageId = 'work';
const config: SupervisorConfig = {
  enabled: true,
  adapter: 'scripted',
  model: 'test',
  reasoningEffort: 'low',
  pollIntervalMs: 30_000,
  routineAssessmentIntervalMs: 180_000,
  cooldownAfterActionMs: 0,
  maxAssessmentsPerIteration: 20,
  tailBytes: 16_384,
  minDeltaBytes: 4_096,
  stuckThresholdMs: 60_000,
};

interface ActionFixture extends DirectionGuidanceFact {
  tick: number;
  runningStages: string[];
}

interface SupervisorInternals {
  actions: ActionFixture[];
  stageLastProgressMs: Record<string, number>;
  act(
    assessment: SupervisorAssessment,
    progressSinceMs?: number,
    source?: 'supervisor' | 'operator',
    observedDeliverables?: ReadonlyMap<string, never>,
    observedDirectionEvidence?: ReadonlyMap<string, DirectionEvidenceBinding>,
  ): Promise<SupervisorAssessment>;
}

let projectDir: string;
let stateRoot: string;
let priorStateRoot: string;
let runDirectory: string;
let runId: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-direction-project-'));
  stateRoot = mkdtempSync(join(tmpdir(), 'flowcrew-direction-state-'));
  priorStateRoot = fcGlobalDir();
  setFcGlobalDir(stateRoot);
  const created = createRun(
    projectDir,
    'direction-persistence',
    'name: direction-persistence\nstages:\n  - id: work\n    role: coder\n',
    [stageId],
  );
  runDirectory = created.runDirPath;
  runId = created.runId;
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const status = {
    status: 'running' as const,
    retries: 1,
    startedAt,
    attempts: [
      {
        index: 1,
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        completedAt: startedAt,
        status: 'failed' as const,
      },
      { index: 2, startedAt, status: 'running' as const },
    ],
  };
  const state = readRunState(projectDir, runId);
  state.status = 'running';
  state.stages[stageId] = status;
  writeRunState(projectDir, runId, state);
  writeStageStatus(projectDir, runId, stageId, status);
  mkdirSync(join(runDirectory, 'signals'), { recursive: true });
});

afterEach(() => {
  setFcGlobalDir(priorStateRoot);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function supervisorFixture(): SupervisorInternals {
  const adapter: Adapter = { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) };
  const supervisor = new Supervisor(projectDir, runId, adapter, config, 'prove direction persistence');
  return supervisor as unknown as SupervisorInternals;
}

function evidence(generation: string): DirectionEvidenceBinding {
  const state = readRunState(projectDir, runId);
  const attempt = state.stages[stageId].attempts!.at(-1)!;
  return {
    version: 1,
    stageId,
    attemptIndex: attempt.index,
    attemptStartedAt: attempt.startedAt,
    generation,
  };
}

function guide(input: {
  tick: number;
  timestamp: string;
  directionKey?: string;
  generation?: string;
  reason?: string;
  guidance?: string;
}): ActionFixture {
  return {
    timestamp: input.timestamp,
    tick: input.tick,
    assessment: {
      verdict: 'GUIDE',
      targetStage: stageId,
      reason: input.reason ?? 'same concrete wrong direction',
      guidance: input.guidance ?? 'use the required evidence path',
      ...(input.directionKey ? { directionKey: input.directionKey } : {}),
    },
    runningStages: [stageId],
    targetAttemptIndex: 2,
    source: 'supervisor',
    ...(input.generation ? { directionEvidence: evidence(input.generation) } : {}),
  };
}

function signalPath(): string {
  return join(runDirectory, 'signals', `abort_${stageId}.json`);
}

describe('repeated wrong-direction abort evidence', () => {
  it('replays the recorded two-GUIDE case and suppresses ABORT after newer corrective progress', async () => {
    const supervisor = supervisorFixture();
    const now = Date.now();
    supervisor.actions = [
      guide({ tick: 1, timestamp: new Date(now - 3_000).toISOString() }),
      guide({ tick: 2, timestamp: new Date(now - 2_000).toISOString() }),
    ];
    const liveLog = join(runDirectory, 'stages', stageId, 'live.log');
    writeFileSync(liveLog, 'The required mechanism is now implemented; I am finishing its evidence.\n');
    supervisor.stageLastProgressMs = { [stageId]: Date.now() };

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the same wrong direction continues',
      guidance: null,
    }, Date.now() + 1_000);

    expect(result).toMatchObject({ verdict: 'WAIT', targetStage: stageId });
    expect(result.reason).toContain('durable worker evidence changed after the latest unbound GUIDE');
    expect(existsSync(signalPath())).toBe(false);
  });

  it('keeps the old judgment for a bound unchanged direction over three advancing generations', async () => {
    const supervisor = supervisorFixture();
    const now = Date.now();
    const directionKey = 'replacing_required_evidence_source';
    supervisor.actions = [
      guide({
        tick: 1,
        timestamp: new Date(now - 4_000).toISOString(),
        directionKey,
        generation: 'a'.repeat(64),
        reason: 'the stage keeps replacing the required evidence source',
        guidance: 'read the required evidence source before deriving the result',
      }),
      guide({
        tick: 2,
        timestamp: new Date(now - 2_000).toISOString(),
        directionKey,
        generation: 'b'.repeat(64),
        reason: 'the stage keeps replacing the required evidence source',
        guidance: 'read the required evidence source before deriving the result',
      }),
    ];
    supervisor.stageLastProgressMs = { [stageId]: now };

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the stage still replaces the required evidence source after both corrections',
      guidance: null,
      directionKey,
    }, Date.now() + 1_000, 'supervisor', undefined, new Map([
      [stageId, evidence('c'.repeat(64))],
    ]));

    expect(result.verdict).toBe('ABORT');
    expect(result.reason).toContain('three advancing evidence generations');
    expect(JSON.parse(readFileSync(signalPath(), 'utf-8'))).toMatchObject({
      stageId,
      attemptIndex: 2,
      source: 'supervisor',
    });
  });

  it('preserves a true idle ABORT independently of direction history', async () => {
    const supervisor = supervisorFixture();
    supervisor.actions = [];
    supervisor.stageLastProgressMs = { [stageId]: Date.now() - 120_000 };

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the stage has made no progress beyond the configured threshold',
      guidance: null,
    }, Date.now() + 1_000);

    expect(result.verdict).toBe('ABORT');
    expect(result.reason).toContain('no verified live/artifact/transition progress');
    expect(existsSync(signalPath())).toBe(true);
  });

  it('rechecks live bytes written after assessment starts before emitting a direction signal', async () => {
    const supervisor = supervisorFixture();
    const now = Date.now();
    const directionKey = 'replacing_required_evidence_source';
    supervisor.actions = [
      guide({ tick: 1, timestamp: new Date(now - 4_000).toISOString(), directionKey, generation: 'a'.repeat(64) }),
      guide({ tick: 2, timestamp: new Date(now - 2_000).toISOString(), directionKey, generation: 'b'.repeat(64) }),
    ];
    supervisor.stageLastProgressMs = { [stageId]: now };
    const assessmentStartedAt = Date.now() - 1_000;
    writeFileSync(join(runDirectory, 'stages', stageId, 'live.log'), 'new bytes arrived while the supervisor was judging\n');

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the bound direction continues',
      guidance: null,
      directionKey,
    }, assessmentStartedAt, 'supervisor', undefined, new Map([
      [stageId, evidence('c'.repeat(64))],
    ]));

    expect(result.verdict).toBe('WAIT');
    expect(result.reason).toContain('progress changed after the assessed evidence snapshot');
    expect(existsSync(signalPath())).toBe(false);
  });

  it('enumerates the bound-chain decision population and calibrates both outcomes', () => {
    const now = Date.now();
    const directionKey = 'replacing_required_evidence_source';
    const boundGuides = [
      guide({ tick: 1, timestamp: new Date(now - 4_000).toISOString(), directionKey, generation: 'a'.repeat(64) }),
      guide({ tick: 2, timestamp: new Date(now - 2_000).toISOString(), directionKey, generation: 'b'.repeat(64) }),
    ];
    const assessment = (key?: string): SupervisorAssessment => ({
      verdict: 'ABORT', targetStage: stageId, reason: 'direction judgment', guidance: null,
      ...(key ? { directionKey: key } : {}),
    });
    const cases = [
      {
        id: 'known-positive',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        expected: true,
      },
      {
        id: 'missing-key',
        guidance: boundGuides,
        assessment: assessment(),
        currentEvidence: evidence('c'.repeat(64)),
        expected: false,
      },
      {
        id: 'different-direction',
        guidance: boundGuides,
        assessment: assessment('different_direction'),
        currentEvidence: evidence('c'.repeat(64)),
        expected: false,
      },
      {
        id: 'intervening-different-direction',
        guidance: [
          boundGuides[0],
          guide({
            tick: 2,
            timestamp: new Date(now - 3_000).toISOString(),
            directionKey: 'different_direction',
            generation: 'd'.repeat(64),
          }),
          guide({
            tick: 3,
            timestamp: new Date(now - 2_000).toISOString(),
            directionKey,
            generation: 'e'.repeat(64),
          }),
        ],
        assessment: assessment(directionKey),
        currentEvidence: evidence('f'.repeat(64)),
        expected: false,
      },
      {
        id: 'no-post-second-guide-generation',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('b'.repeat(64)),
        expected: false,
      },
      {
        id: 'one-guide',
        guidance: boundGuides.slice(0, 1),
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        durableProgressAfterLatestGuide: true,
        expected: false,
      },
      {
        id: 'legacy-identical-no-new-durable-evidence',
        guidance: [
          guide({ tick: 1, timestamp: new Date(now - 4_000).toISOString() }),
          guide({ tick: 2, timestamp: new Date(now - 2_000).toISOString() }),
        ],
        assessment: assessment(),
        currentEvidence: undefined,
        durableProgressAfterLatestGuide: false,
        expected: true,
      },
      {
        id: 'legacy-identical-with-new-durable-evidence',
        guidance: [
          guide({ tick: 1, timestamp: new Date(now - 4_000).toISOString() }),
          guide({ tick: 2, timestamp: new Date(now - 2_000).toISOString() }),
        ],
        assessment: assessment(),
        currentEvidence: undefined,
        durableProgressAfterLatestGuide: true,
        expected: false,
      },
      {
        id: 'legacy-different-corrections',
        guidance: [
          guide({ tick: 1, timestamp: new Date(now - 4_000).toISOString() }),
          guide({
            tick: 2,
            timestamp: new Date(now - 2_000).toISOString(),
            reason: 'a different concrete wrong direction',
            guidance: 'use a different required path',
          }),
        ],
        assessment: assessment(),
        currentEvidence: undefined,
        durableProgressAfterLatestGuide: false,
        expected: false,
      },
    ];
    const observed = cases.map((candidate) => ({
      id: candidate.id,
      verified: verifyRepeatedWrongDirection({
        stageId,
        attemptIndex: 2,
        assessment: candidate.assessment,
        currentEvidence: candidate.currentEvidence,
        guidance: candidate.guidance,
        durableProgressAfterLatestGuide: candidate.durableProgressAfterLatestGuide ?? true,
      }).verified,
      expected: candidate.expected,
    }));

    expect(observed).toEqual(cases.map((candidate) => ({
      id: candidate.id,
      verified: candidate.expected,
      expected: candidate.expected,
    })));
    expect(observed.filter((candidate) => candidate.verified)).toHaveLength(2);
    expect(observed.filter((candidate) => !candidate.verified)).toHaveLength(7);
  });

  it('publishes and parses the stable direction identity without changing other verdicts', () => {
    const prompt = buildSupervisorSystemPrompt(config.stuckThresholdMs);
    expect(prompt).toContain('direction_key');
    expect(prompt).toContain('reuse that exact key');
    expect(parseSupervisorVerdict(JSON.stringify({
      verdict: 'GUIDE',
      target_stage: stageId,
      reason: 'concrete direction',
      guidance: 'correct it',
      direction_key: 'REPLACING_REQUIRED_EVIDENCE_SOURCE',
    }))).toMatchObject({
      verdict: 'GUIDE',
      directionKey: 'replacing_required_evidence_source',
    });
    expect(parseSupervisorVerdict(JSON.stringify({
      verdict: 'WAIT', target_stage: null, reason: 'progress', guidance: null, direction_key: null,
    }))).toEqual({ verdict: 'WAIT', targetStage: null, reason: 'progress', guidance: null });
  });
});
