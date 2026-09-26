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
import { recordRunEvent, type RunEvent } from '../src/run-events.js';
import {
  buildSupervisorSystemPrompt,
  parseSupervisorVerdict,
  projectSupervisorStageEvidence,
  Supervisor,
  verifyRepeatedWrongDirection,
  type DirectionEvidenceBinding,
  type DirectionGuidanceFact,
  type SupervisorAssessment,
  type SupervisorStageEvidence,
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
    observedStageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
    comparisonStageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
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

function unrelatedComparisonEvidence(): ReadonlyMap<string, SupervisorStageEvidence> {
  return new Map([['unaccused', {
    version: 1,
    stageId: 'unaccused',
    attemptIndex: 1,
    attemptStartedAt: '2026-09-22T17:00:00.000Z',
    rows: [{
      id: 'ev_dddddddddddddddddddd',
      kind: 'command_invocation',
      authority: 'action',
      text: 'npm test completed',
    }],
  }]]);
}

function accusedComparisonEvidence(): SupervisorStageEvidence {
  const binding = evidence('c'.repeat(64));
  return {
    version: 1,
    stageId,
    attemptIndex: binding.attemptIndex,
    attemptStartedAt: binding.attemptStartedAt,
    rows: [{
      id: 'ev_cccccccccccccccccccc',
      kind: 'command_invocation',
      authority: 'action',
      text: 'replacing the required evidence source with another input',
    }],
  };
}

function guide(input: {
  tick: number;
  timestamp: string;
  directionKey?: string;
  generation?: string;
  reason?: string;
  guidance?: string;
  guidanceId?: string;
  evidenceIds?: string[];
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
      ...(input.guidanceId ? { guidanceId: input.guidanceId } : {}),
      ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
    },
    runningStages: [stageId],
    targetAttemptIndex: 2,
    source: 'supervisor',
    ...(input.generation ? { directionEvidence: evidence(input.generation) } : {}),
  };
}

function deliveryEvent(input: {
  timestamp: string;
  invocationIndex: number;
  guidanceIds: string[];
}): RunEvent {
  const state = readRunState(projectDir, runId);
  const attempt = state.stages[stageId].attempts!.at(-1)!;
  return {
    type: 'guidance_delivery_checked',
    runId,
    timestamp: input.timestamp,
    stageId,
    attemptIndex: attempt.index,
    attemptStartedAt: attempt.startedAt,
    boundary: 'adapter_invocation',
    invocationIndex: input.invocationIndex,
    guidanceIds: input.guidanceIds,
    delivered: true,
    source: 'worker',
  };
}

function signalPath(): string {
  return join(runDirectory, 'signals', `abort_${stageId}.json`);
}

describe('repeated wrong-direction abort evidence', () => {
  it('separates inspected corpus output from action evidence before delivering GUIDE', async () => {
    const supervisor = supervisorFixture();
    const attempt = readRunState(projectDir, runId).stages[stageId].attempts!.at(-1)!;
    const projection = projectSupervisorStageEvidence({
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      raw: [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'read-corpus', type: 'command_execution', command: "sed -n '1p' committed/corpus.jsonl",
            aggregated_output: 'V1389 CPI/FOMC workflow is being backtested',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'statement', type: 'agent_message', text: 'I am replacing the required evidence source.' },
        }),
      ].join('\n'),
    });
    const inspected = projection.rows.find((row) => row.text.includes('V1389'))!;
    const readCommand = projection.rows.find((row) => row.kind === 'command_invocation')!;
    const authored = projection.rows.find((row) => row.text.includes('I am replacing'))!;
    expect({ command: readCommand.authority, inspected: inspected.authority, authored: authored.authority }).toEqual({
      command: 'inspection', inspected: 'inspection', authored: 'action',
    });

    const commandSuppressed = await supervisor.act({
      verdict: 'GUIDE', targetStage: stageId,
      reason: 'the corpus output was mistaken for pursuit', guidance: 'stop the unrelated workflow',
      directionKey: 'unrelated_workflow', evidenceIds: [readCommand.id],
    }, Date.now(), 'supervisor', undefined, undefined, new Map([[stageId, projection]]));
    expect(commandSuppressed).toMatchObject({ verdict: 'WAIT', guidance: null });
    expect(commandSuppressed.reason).toContain('inspection-only');

    const suppressed = await supervisor.act({
      verdict: 'GUIDE', targetStage: stageId,
      reason: 'the corpus output was mistaken for pursuit', guidance: 'stop the unrelated workflow',
      directionKey: 'unrelated_workflow', evidenceIds: [inspected.id],
    }, Date.now(), 'supervisor', undefined, undefined, new Map([[stageId, projection]]));
    expect(suppressed).toMatchObject({ verdict: 'WAIT', guidance: null });
    expect(suppressed.reason).toContain('inspection-only');

    const delivered = await supervisor.act({
      verdict: 'GUIDE', targetStage: stageId,
      reason: 'the stage authored a replacement of the required source', guidance: 'retain the required source and annotate it',
      directionKey: 'replacing_required_source', evidenceIds: [authored.id],
    }, Date.now(), 'supervisor', undefined, undefined, new Map([[stageId, projection]]));
    expect(delivered.verdict).toBe('GUIDE');
    expect(delivered.guidanceId).toMatch(/^[0-9a-f]{20}$/);
  });

  it('requires a cited action to support the consequential claim while retaining a real invocation control', async () => {
    const supervisor = supervisorFixture();
    const attempt = readRunState(projectDir, runId).stages[stageId].attempts!.at(-1)!;
    const projection = projectSupervisorStageEvidence({
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      raw: [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'unrelated-action', type: 'command_execution', command: 'npm test',
            aggregated_output: 'market workflow text appeared in a fixture',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'wrong-workflow', type: 'command_execution',
            command: 'python scripts/run_market_workflow.py --write reports/result.json',
            aggregated_output: 'wrote reports/result.json',
          },
        }),
      ].join('\n'),
    });
    const unrelated = projection.rows.find((row) => row.text === 'npm test')!;
    const wrongWorkflow = projection.rows.find((row) => row.text.includes('run_market_workflow.py'))!;
    expect({ unrelated: unrelated.authority, wrongWorkflow: wrongWorkflow.authority }).toEqual({
      unrelated: 'action', wrongWorkflow: 'action',
    });

    const unsupported = await supervisor.act({
      verdict: 'GUIDE', targetStage: stageId,
      reason: 'the stage is pursuing an unrelated market workflow',
      guidance: 'return to the declared objective', directionKey: 'unrelated_market_workflow',
      evidenceIds: [unrelated.id],
    }, Date.now(), 'supervisor', undefined, undefined, new Map([[stageId, projection]]));
    expect(unsupported).toMatchObject({ verdict: 'WAIT', guidance: null });
    expect(unsupported.reason).toContain('share no concrete claim term');

    const supported = await supervisor.act({
      verdict: 'GUIDE', targetStage: stageId,
      reason: 'the stage is pursuing an unrelated market workflow',
      guidance: 'return to the declared objective', directionKey: 'unrelated_market_workflow',
      evidenceIds: [wrongWorkflow.id],
    }, Date.now(), 'supervisor', undefined, undefined, new Map([[stageId, projection]]));
    expect(supported.verdict).toBe('GUIDE');
    expect(supported.guidanceId).toMatch(/^[0-9a-f]{20}$/);
  });

  it('suppresses a direction ABORT when no correction has a recorded delivery opportunity', async () => {
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
    expect(result.reason).toContain('no stable wrong-direction key');
    expect(existsSync(signalPath())).toBe(false);
  });

  it('keeps the old judgment after two separately delivered corrections and later action evidence', async () => {
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
        guidanceId: 'guide-one',
        evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      }),
      guide({
        tick: 2,
        timestamp: new Date(now - 2_000).toISOString(),
        directionKey,
        generation: 'b'.repeat(64),
        reason: 'the stage keeps replacing the required evidence source',
        guidance: 'read the required evidence source before deriving the result',
        guidanceId: 'guide-two',
        evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
      }),
    ];
    supervisor.stageLastProgressMs = { [stageId]: now };
    recordRunEvent(projectDir, runId, deliveryEvent({
      timestamp: new Date(now - 3_000).toISOString(), invocationIndex: 8, guidanceIds: ['guide-one'],
    }));
    recordRunEvent(projectDir, runId, deliveryEvent({
      timestamp: new Date(now - 1_000).toISOString(), invocationIndex: 9, guidanceIds: ['guide-two'],
    }));

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the stage still replaces the required evidence source after both corrections',
      guidance: null,
      directionKey,
      evidenceIds: ['ev_cccccccccccccccccccc'],
      assessedAt: new Date(now).toISOString(),
    }, Date.now() + 1_000, 'supervisor', undefined, new Map([
      [stageId, evidence('c'.repeat(64))],
    ]), undefined, new Map([
      [stageId, accusedComparisonEvidence()],
      ...unrelatedComparisonEvidence(),
    ]));

    expect(result.verdict).toBe('ABORT');
    expect(result.reason).toContain('two distinct worker invocation opportunities');
    expect(JSON.parse(readFileSync(signalPath(), 'utf-8'))).toMatchObject({
      stageId,
      attemptIndex: 2,
      source: 'supervisor',
    });
  });

  it('refuses the recorded same-turn pair when both corrections first become visible together', async () => {
    const supervisor = supervisorFixture();
    const now = Date.now();
    const directionKey = 'replacing_required_evidence_source';
    supervisor.actions = [
      guide({
        tick: 1,
        timestamp: new Date(now - 4_000).toISOString(),
        directionKey,
        generation: 'a'.repeat(64),
        guidanceId: 'guide-one',
        evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      }),
      guide({
        tick: 2,
        timestamp: new Date(now - 3_953).toISOString(),
        directionKey,
        generation: 'b'.repeat(64),
        guidanceId: 'guide-two',
        evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
      }),
    ];
    supervisor.stageLastProgressMs = { [stageId]: now };
    recordRunEvent(projectDir, runId, deliveryEvent({
      timestamp: new Date(now - 2_000).toISOString(),
      invocationIndex: 8,
      guidanceIds: ['guide-one', 'guide-two'],
    }));

    const result = await supervisor.act({
      verdict: 'ABORT',
      targetStage: stageId,
      reason: 'the direction allegedly persisted after both corrections',
      guidance: null,
      directionKey,
      evidenceIds: ['ev_cccccccccccccccccccc'],
      assessedAt: new Date(now).toISOString(),
    }, Date.now() + 1_000, 'supervisor', undefined, new Map([
      [stageId, evidence('c'.repeat(64))],
    ]));

    expect(result.verdict).toBe('WAIT');
    expect(result.reason).toContain('only one worker response opportunity');
    expect(existsSync(signalPath())).toBe(false);
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

  it('enumerates the delivery-opportunity decision population and calibrates both outcomes', () => {
    const now = Date.now();
    const directionKey = 'replacing_required_evidence_source';
    const boundGuides = [
      guide({
        tick: 1, timestamp: new Date(now - 4_000).toISOString(), directionKey,
        generation: 'a'.repeat(64), guidanceId: 'guide-one', evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      }),
      guide({
        tick: 2, timestamp: new Date(now - 2_000).toISOString(), directionKey,
        generation: 'b'.repeat(64), guidanceId: 'guide-two', evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
      }),
    ];
    const assessment = (key?: string): SupervisorAssessment => ({
      verdict: 'ABORT', targetStage: stageId, reason: 'direction judgment', guidance: null,
      evidenceIds: ['ev_cccccccccccccccccccc'], assessedAt: new Date(now).toISOString(),
      ...(key ? { directionKey: key } : {}),
    });
    const distinctDeliveries = [
      deliveryEvent({ timestamp: new Date(now - 3_000).toISOString(), invocationIndex: 8, guidanceIds: ['guide-one'] }),
      deliveryEvent({ timestamp: new Date(now - 1_000).toISOString(), invocationIndex: 9, guidanceIds: ['guide-two'] }),
    ];
    const cases = [
      {
        id: 'known-positive',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: distinctDeliveries,
        expected: true,
      },
      {
        id: 'same-turn-delivery',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: [deliveryEvent({
          timestamp: new Date(now - 1_500).toISOString(), invocationIndex: 8,
          guidanceIds: ['guide-one', 'guide-two'],
        })],
        expected: false,
      },
      {
        id: 'not-delivered',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: [],
        expected: false,
      },
      {
        id: 'missing-key',
        guidance: boundGuides,
        assessment: assessment(),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: distinctDeliveries,
        expected: false,
      },
      {
        id: 'different-direction',
        guidance: boundGuides,
        assessment: assessment('different_direction'),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: distinctDeliveries,
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
            guidanceId: 'guide-other',
            evidenceIds: ['ev_dddddddddddddddddddd'],
          }),
          guide({
            tick: 3,
            timestamp: new Date(now - 2_000).toISOString(),
            directionKey,
            generation: 'e'.repeat(64),
            guidanceId: 'guide-three',
            evidenceIds: ['ev_eeeeeeeeeeeeeeeeeeee'],
          }),
        ],
        assessment: assessment(directionKey),
        currentEvidence: evidence('f'.repeat(64)),
        deliveryEvents: distinctDeliveries,
        expected: false,
      },
      {
        id: 'no-post-second-guide-generation',
        guidance: boundGuides,
        assessment: assessment(directionKey),
        currentEvidence: evidence('b'.repeat(64)),
        deliveryEvents: distinctDeliveries,
        expected: false,
      },
      {
        id: 'no-new-action-evidence-after-second-guide',
        guidance: boundGuides,
        assessment: { ...assessment(directionKey), evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'] },
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: distinctDeliveries,
        expected: false,
      },
      {
        id: 'one-guide',
        guidance: boundGuides.slice(0, 1),
        assessment: assessment(directionKey),
        currentEvidence: evidence('c'.repeat(64)),
        deliveryEvents: distinctDeliveries,
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
        deliveryEvents: candidate.deliveryEvents,
        assessmentTimestamp: new Date(now).toISOString(),
        accusedEvidence: accusedComparisonEvidence(),
        siblingEvidence: [...unrelatedComparisonEvidence().values()],
      }).verified,
      expected: candidate.expected,
    }));

    expect(observed).toEqual(cases.map((candidate) => ({
      id: candidate.id,
      verified: candidate.expected,
      expected: candidate.expected,
    })));
    expect(observed.filter((candidate) => candidate.verified)).toHaveLength(1);
    expect(observed.filter((candidate) => !candidate.verified)).toHaveLength(8);
    expect(verifyRepeatedWrongDirection({
      stageId,
      attemptIndex: 2,
      assessment: assessment(directionKey),
      currentEvidence: evidence('c'.repeat(64)),
      guidance: boundGuides,
      deliveryEvents: distinctDeliveries,
      assessmentTimestamp: new Date(now).toISOString(),
      siblingEvidence: [...unrelatedComparisonEvidence().values()],
    }).verified).toBe(false);
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
