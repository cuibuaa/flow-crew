import { buildGateReevaluationPreamble } from './test-support/gate-reevaluation.js';
import { artifacts } from './spec_contracts/declared-fixtures.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { assessCampaignHygiene } from '../src/campaign-hygiene.js';
import type { SupervisorConfig } from '../src/config.js';
import type { RunEvent } from '../src/run-events.js';
import {
  inspectRealityCheckReachability,
  type StageConfig,
} from '../src/scheduler.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import {
  Supervisor,
  projectSupervisorStageEvidence,
  verifyRepeatedWrongDirection,
  type DirectionEvidenceBinding,
  type DirectionGuidanceFact,
  type SupervisorAssessment,
  type SupervisorStageEvidence,
} from '../src/supervisor.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
} from '../src/store.js';

const temporaryRoots: string[] = [];
const originalGlobalRoot = fcGlobalDir();

afterEach(() => {
  setFcGlobalDir(originalGlobalRoot);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

function supervisorConfig(): SupervisorConfig {
  return {
    enabled: true,
    adapter: 'fixture',
    model: 'fixture',
    reasoningEffort: 'low',
    pollIntervalMs: 30_000,
    routineAssessmentIntervalMs: 180_000,
    cooldownAfterActionMs: 0,
    maxAssessmentsPerIteration: 20,
    tailBytes: 16_384,
    minDeltaBytes: 4_096,
    stuckThresholdMs: 60_000,
  };
}

interface SupervisorAct {
  act(
    assessment: SupervisorAssessment,
    progressSinceMs?: number,
    source?: 'supervisor' | 'operator',
    observedDirectionEvidence?: ReadonlyMap<string, DirectionEvidenceBinding>,
    observedStageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
  ): Promise<SupervisorAssessment>;
}

function supervisorFixture(raw: string) {
  const root = temporaryRoot('audit-five-supervisor-');
  const projectDir = join(root, 'project');
  setFcGlobalDir(join(root, 'state'));
  mkdirSync(projectDir, { recursive: true });
  const created = createRun(projectDir, 'audit probe', 'name: audit\nstages: []\n', ['work']);
  const startedAt = '2026-08-01T05:30:00.000Z';
  const status = {
    status: 'running' as const,
    retries: 0,
    startedAt,
    attempts: [{ index: 1, startedAt, status: 'running' as const }],
  };
  const state = readRunState(projectDir, created.runId);
  state.status = 'running';
  state.stages.work = status;
  writeRunState(projectDir, created.runId, state);
  writeStageStatus(projectDir, created.runId, 'work', status);
  const projection = projectSupervisorStageEvidence({
    stageId: 'work',
    attemptIndex: 1,
    attemptStartedAt: startedAt,
    raw,
  });
  const adapter: Adapter = {
    run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }),
  };
  const supervisor = new Supervisor(
    projectDir,
    created.runId,
    adapter,
    supervisorConfig(),
    'preserve the declared objective',
  ) as unknown as SupervisorAct;
  return { projection, supervisor };
}

function guideAssessment(evidenceId: string): SupervisorAssessment {
  return {
    verdict: 'GUIDE',
    targetStage: 'work',
    reason: 'the stage is pursuing an unrelated market workflow',
    guidance: 'stop the unrelated workflow and return to the declared objective',
    directionKey: 'unrelated_market_workflow',
    evidenceIds: [evidenceId],
  };
}

describe.sequential('five-instrument independent QA', () => {
  it('does not let a read-only corpus command authorize a pursuit correction', async () => {
    const raw = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'read-corpus',
        type: 'command_execution',
        command: "sed -n '1p' committed/corpus.jsonl",
        aggregated_output: 'an unrelated market workflow appears in this preserved row',
        exit_code: 0,
        status: 'completed',
      },
    });
    const { projection, supervisor } = supervisorFixture(raw);
    const command = projection.rows.find((row) => row.kind === 'command_invocation');
    const output = projection.rows.find((row) => row.kind === 'tool_output');
    expect(output?.authority).toBe('inspection');
    expect(command?.text).toContain('committed/corpus.jsonl');

    const result = await supervisor.act(
      guideAssessment(command!.id),
      Date.now(),
      'supervisor',
      undefined,
      new Map([['work', projection]]),
    );

    expect(result.verdict).toBe('WAIT');
  });

  it('still lets an actual wrong-workflow invocation authorize correction', async () => {
    const raw = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'run-wrong-workflow',
        type: 'command_execution',
        command: 'python scripts/run_market_workflow.py --write reports/result.json',
        aggregated_output: 'wrote reports/result.json',
        exit_code: 0,
        status: 'completed',
      },
    });
    const { projection, supervisor } = supervisorFixture(raw);
    const command = projection.rows.find((row) => row.kind === 'command_invocation');
    const result = await supervisor.act(
      guideAssessment(command!.id),
      Date.now(),
      'supervisor',
      undefined,
      undefined,
      new Map([['work', projection]]),
    );
    expect(result.verdict).toBe('GUIDE');
    expect(result.guidanceId).toMatch(/^[0-9a-f]{20}$/);
  });

  it('counts jointly delivered corrections as one opportunity and separate deliveries as two', () => {
    const startedAt = '2026-08-01T05:30:00.000Z';
    const at = (minute: number) => `2026-08-01T05:${String(minute).padStart(2, '0')}:00.000Z`;
    const evidence = (value: string): DirectionEvidenceBinding => ({
      version: 1,
      stageId: 'work',
      attemptIndex: 1,
      attemptStartedAt: startedAt,
      generation: value.repeat(64),
    });
    const guides: DirectionGuidanceFact[] = [
      {
        timestamp: at(31),
        targetAttemptIndex: 1,
        source: 'supervisor',
        directionEvidence: evidence('a'),
        assessment: {
          verdict: 'GUIDE', targetStage: 'work', reason: 'same direction', guidance: 'correct it',
          directionKey: 'same_wrong_action', guidanceId: 'guide-one', evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
        },
      },
      {
        timestamp: at(33),
        targetAttemptIndex: 1,
        source: 'supervisor',
        directionEvidence: evidence('b'),
        assessment: {
          verdict: 'GUIDE', targetStage: 'work', reason: 'same direction', guidance: 'correct it',
          directionKey: 'same_wrong_action', guidanceId: 'guide-two', evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
        },
      },
    ];
    const assessment: SupervisorAssessment = {
      verdict: 'ABORT', targetStage: 'work', reason: 'same direction persists', guidance: null,
      directionKey: 'same_wrong_action', evidenceIds: ['ev_cccccccccccccccccccc'],
    };
    const event = (timestamp: string, invocationIndex: number, guidanceIds: string[]): RunEvent => ({
      type: 'guidance_delivery_checked', runId: 'run', timestamp, stageId: 'work',
      attemptIndex: 1, attemptStartedAt: startedAt, boundary: 'adapter_invocation',
      invocationIndex, guidanceIds, delivered: true, source: 'worker',
    });
    const verify = (deliveryEvents: RunEvent[]) => verifyRepeatedWrongDirection({
      stageId: 'work', attemptIndex: 1, assessment, currentEvidence: evidence('c'), guides,
      guidance: guides, deliveryEvents, assessmentTimestamp: at(35),
      accusedEvidence: {
        version: 1, stageId: 'work', attemptIndex: 1, attemptStartedAt: startedAt,
        rows: [{
          id: 'ev_cccccccccccccccccccc', kind: 'command_invocation', authority: 'action',
          text: 'continue the same wrong action',
        }],
      },
      siblingEvidence: [{
        version: 1, stageId: 'unaccused', attemptIndex: 1, attemptStartedAt: startedAt,
        rows: [{ id: 'ev_dddddddddddddddddddd', kind: 'command_invocation', authority: 'action', text: 'npm test completed' }],
      }],
    } as Parameters<typeof verifyRepeatedWrongDirection>[0]);

    expect(verify([event(at(34), 8, ['guide-one', 'guide-two'])]).verified).toBe(false);
    expect(verify([
      event(at(32), 8, ['guide-one']),
      event(at(34), 9, ['guide-two']),
    ])).toMatchObject({ verified: true, mode: 'delivered_opportunities' });
  });

  it('keeps script and prompt mentions inert while enforcing exact declarations', () => {
    const root = temporaryRoot('audit-five-paths-');
    const projectDir = join(root, 'project');
    const runDir = join(root, 'run');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const markdown = (script: string) => [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: probe',
      '    type: exec-script-exit-zero',
      '    reads: []',
      '    params:',
      `      script: ${JSON.stringify(script)}`,
      '```',
    ].join('\n');
    const escaped = inspectRealityCheckReachability({
      markdown: markdown(String.raw`grep -E 'round_result\.json(\.sidecar\.json)?'`),
      projectDir,
      stages: [],
    });
    const explicit = inspectRealityCheckReachability({
      markdown: markdown('test -s docs/report.json'),
      projectDir,
      stages: [],
    });
    const patternAudit = inspectStageArtifactContract({
      stageId: 'probe',
      template: String.raw`Compare \`input\.md\` and \`docs\/report\.md\`.`,
      artifactContract: artifacts(),
      projectDir,
      runDir,
      writes: [],
    });
    const literalAudit = inspectStageArtifactContract({
      stageId: 'probe',
      template: 'Write `docs/report.md`.',
      artifactContract: artifacts([{ id: 'report', root: 'project', path: 'docs/report.md' }]),
      projectDir,
      runDir,
      writes: [],
    });
    expect(escaped).toEqual([]);
    expect(explicit).toEqual([]);
    const declared = markdown('test -s docs/report.json').replace('reads: []', 'reads: [{id: report, root: project, path: docs/report.json, source: {kind: stage, stage: absent, artifact: report}}]');
    expect(inspectRealityCheckReachability({ markdown: declared, projectDir, stages: [] }).join(';')).toContain('ARTIFACT_READ_UNREACHABLE');
    expect(patternAudit.obligations).toEqual([]);
    expect(literalAudit.obligations).toEqual([]);
    expect(literalAudit.violations).toEqual([]);
  });

  it('derives the campaign default boundary from the full recent window', () => {
    const entry = (seq: number, status: string) => ({
      seq,
      runId: `run-${seq}`,
      kind: 'task_ended' as const,
      pass: status === 'complete',
      status,
      timestamp: `2026-08-01T00:${String(seq).padStart(2, '0')}:00.000Z`,
    });
    const history = [
      entry(1, 'failed'),
      ...Array.from({ length: 8 }, (_, index) => entry(index + 2, 'complete')),
      entry(10, 'failed'),
      entry(11, 'unknown-future-status'),
    ];
    expect(assessCampaignHygiene(history)).toMatchObject({
      totalEnded: 11,
      recentEnded: 10,
      recentAdverse: 2,
      suggestContextSkip: false,
    });
    expect(assessCampaignHygiene([...history, entry(12, 'failed')])).toMatchObject({
      recentEnded: 10,
      recentAdverse: 3,
      suggestContextSkip: true,
    });
  });

  it('treats a gate attempt without a verdict as interrupted while retaining its available input', () => {
    const root = temporaryRoot('audit-five-gate-');
    const roundDir = join(root, 'gate_reevaluation', 'iteration_1', 'round_1');
    mkdirSync(roundDir, { recursive: true });
    const inputPath = join(roundDir, 'evaluated_input_review.md');
    writeFileSync(inputPath, 'first exact gate prompt\n', 'utf8');
    const present = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 1,
      repairRound: 1,
      runDirPath: root,
      gateId: 'review',
      fixStageIds: ['repair'],
      roundDiffPath: join(roundDir, 'repair_diff.json'),
    });
    rmSync(inputPath);
    const legacy = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 1,
      repairRound: 1,
      runDirPath: root,
      gateId: 'review',
      fixStageIds: ['repair'],
      roundDiffPath: join(roundDir, 'repair_diff.json'),
    });
    expect(present).toContain('INTERRUPTED EVALUATION (round 2)');
    expect(present).toContain(`Exact input seen by the interrupted gate: ${inputPath}`);
    expect(present).toContain('No rejected verdict was recorded');
    expect(legacy).toContain('INTERRUPTED EVALUATION (round 2)');
    expect(legacy).toContain('Exact input seen by the interrupted gate: unavailable');
  });
});
