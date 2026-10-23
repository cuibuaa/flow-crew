import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StageConfigSchema, type StageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { allDone } from '../src/scheduler/sched_scope/stage-group.js';
import { reconcileUnresolvedStageObligations } from '../src/scheduler/sched_settlement/completion.js';
import { collectGateRuntimeFacts } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { STAGE_STATUS, type StoreState } from '../src/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(transitive = false) {
  const projectDir = mkdtempSync(join(process.cwd(), '.research-branch-'));
  roots.push(projectDir);
  const stage = (id: string, extra: Record<string, unknown> = {}): StageConfig => StageConfigSchema.parse({
    id, role: 'worker', prompt_template: 'Branch settlement contract.', scope: [], depends_on: [],
    artifact_contract: { version: 1, produces: [], reads: [], groups: [] },
    ...extra,
  });
  const stages = [
    stage('report', { condition: 'research.terminalPath == "artifacts/ceiling.md"' }),
    ...(transitive ? [stage('index', { depends_on: ['report'] })] : []),
    stage('review', { depends_on: [transitive ? 'index' : 'report'], is_gate: true }),
  ];
  const state: StoreState = {
    runId: 'fixture', workflowName: 'research', projectDir, status: 'running',
    startedAt: new Date(0).toISOString(),
    stages: Object.fromEntries(stages.map(stage => [stage.id, {
      status: stage.id === 'report' ? STAGE_STATUS.SKIPPED : STAGE_STATUS.PENDING,
      retries: 0,
    }])),
  };
  return { projectDir, stages, state };
}

describe('conditional branch settlement', () => {
  it.each([false, true])('settles an unexecuted review behind a conditional skip (transitive: %s)', transitive => {
    const { projectDir, stages, state } = fixture(transitive);
    expect(collectGateRuntimeFacts(stages, state, projectDir)).toMatchObject({
      allPass: true, failedGateIds: [], evaluations: [],
    });
    expect(allDone(state, stages)).toBe(true);
    expect(reconcileUnresolvedStageObligations(state, stages, 1, projectDir).stageIds).toEqual([]);
  });

  it('releases an existing downstream obligation after the producer is conditionally skipped', () => {
    const { projectDir, stages, state } = fixture(true);
    state.unresolvedStageObligations = [{ stageId: 'review', declaredIteration: 1 }];
    expect(reconcileUnresolvedStageObligations(state, stages, 2, projectDir)).toEqual({ changed: true, stageIds: [] });
    expect(state.unresolvedStageObligations).toBeUndefined();
  });

  it('requires the review again when its producer is reactivated', () => {
    const { projectDir, stages, state } = fixture();
    expect(collectGateRuntimeFacts(stages, state, projectDir).allPass).toBe(true);
    state.stages.report.status = STAGE_STATUS.COMPLETE;
    expect(collectGateRuntimeFacts(stages, state, projectDir)).toMatchObject({ allPass: false, failedGateIds: ['review'] });
    expect(allDone(state, stages)).toBe(false);
    expect(reconcileUnresolvedStageObligations(state, stages, 2, projectDir).stageIds).toEqual(['review']);
  });

  it('keeps an unconditional skipped gate required', () => {
    const { projectDir, stages, state } = fixture();
    state.stages.report.status = STAGE_STATUS.COMPLETE;
    state.stages.review.status = STAGE_STATUS.SKIPPED;
    expect(collectGateRuntimeFacts(stages, state, projectDir)).toMatchObject({ allPass: false, failedGateIds: ['review'] });
  });

  it('does not accept completed production when its conditional review skips itself', () => {
    const { projectDir, stages, state } = fixture();
    state.stages.report.status = STAGE_STATUS.COMPLETE;
    state.stages.review.status = STAGE_STATUS.SKIPPED;
    stages[1].condition = 'report.exitCode == 1';
    expect(collectGateRuntimeFacts(stages, state, projectDir)).toMatchObject({ allPass: false, failedGateIds: ['review'] });
  });

  it.each([STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, STAGE_STATUS.RUNNING])('retains a %s gate for adjudication despite an ancestor skip', status => {
    const { projectDir, stages, state } = fixture();
    state.stages.review.status = status;
    const facts = collectGateRuntimeFacts(stages, state, projectDir);
    expect(facts.evaluations).toHaveLength(1);
    expect(facts.evaluations[0]).toMatchObject({ id: 'review', status });
    expect(facts.allPass).toBe(false);
    if (status !== STAGE_STATUS.COMPLETE) expect(allDone(state, stages)).toBe(false);
    if (status === STAGE_STATUS.RUNNING) {
      expect(reconcileUnresolvedStageObligations(state, stages, 1, projectDir).stageIds).toEqual(['review']);
    }
  });

  it('does not infer a skipped branch from an unexecuted producer condition', () => {
    const { projectDir, stages, state } = fixture();
    state.stages.report.status = STAGE_STATUS.PENDING;
    expect(collectGateRuntimeFacts(stages, state, projectDir)).toMatchObject({ allPass: false, failedGateIds: ['review'] });
    expect(allDone(state, stages)).toBe(false);
    expect(reconcileUnresolvedStageObligations(state, stages, 1, projectDir).stageIds).toEqual(['review']);
  });
});
