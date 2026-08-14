import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  buildSupervisorSystemPrompt,
  detectSupervisorAnomalySignals,
  selectSupervisorAssessmentTrigger,
  summarizeSupervisorGuidanceHistory,
  SUPERVISOR_VERDICTS,
} from '../src/supervisor.js';
import { loadSupervisorConfig } from '../src/config.js';
import type { StoreState } from '../src/store.js';

function productionAssessmentTimeoutMs(): number {
  const sourcePath = join(import.meta.dirname, '..', 'src', 'supervisor.ts');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const numericConstants = new Map<string, ts.Expression>();
  let timeout: number | undefined;

  function evaluateNumber(expression: ts.Expression, seen = new Set<string>()): number | undefined {
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (
      ts.isPrefixUnaryExpression(expression)
      && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
    ) {
      const operand = evaluateNumber(expression.operand, seen);
      return operand === undefined
        ? undefined
        : expression.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const initializer = numericConstants.get(expression.text);
      if (initializer) return evaluateNumber(initializer, new Set([...seen, expression.text]));
    }
    return undefined;
  }

  function collectConstants(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      numericConstants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConstants);
  }
  collectConstants(sourceFile);

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'run'
      && node.expression.expression.getText(sourceFile) === 'this.adapter'
      && node.arguments[2]
      && ts.isObjectLiteralExpression(node.arguments[2])
    ) {
      const property = node.arguments[2].properties.find((candidate): candidate is ts.PropertyAssignment => (
        ts.isPropertyAssignment(candidate)
        && candidate.name.getText(sourceFile) === 'timeout_ms'
      ));
      if (property) timeout = evaluateNumber(property.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (timeout === undefined) throw new Error('Supervisor assessment timeout is not statically numeric');
  return timeout;
}

function baseState(): StoreState {
  return {
    runId: 'run', workflowName: 'test', projectDir: '/tmp/project', status: 'running',
    startedAt: '2026-07-31T00:00:00.000Z', currentIteration: 1,
    stages: { work: { status: 'running', retries: 0 } },
  };
}

describe('supervisor routine/anomaly scheduling', () => {
  it('keeps every intervention verdict available', () => {
    expect(SUPERVISOR_VERDICTS.map((verdict) => verdict.id)).toEqual([
      'WAIT', 'GUIDE', 'ABORT', 'REPLAN', 'REJECT', 'DONE',
    ]);
  });

  it('allows repeated GUIDE decisions to escalate a high-output wrong direction to ABORT', () => {
    const prompt = buildSupervisorSystemPrompt(20 * 60_000);
    expect(prompt).toContain('same concrete wrong direction continues after repeated GUIDE decisions');
    expect(prompt).toContain('Active or high-volume output is not proof');
    expect(prompt).toContain('Do not ABORT slow but correct work');
    expect(prompt).not.toContain('ABORT only if a stage has been running');

    const history = summarizeSupervisorGuidanceHistory(
      Array.from({ length: 10 }, (_, index) => ({
        assessment: {
          verdict: 'GUIDE' as const,
          targetStage: 'run_round1',
          reason: `still following the same wrong recipe ${index + 1}`,
          guidance: 'use the required teacher rationale source',
        },
      })),
      ['run_round1'],
    );
    expect(history).toContain('run_round1: 10 cumulative GUIDE decisions');
    expect(history).toContain('same wrong recipe 8');
    expect(history).toContain('same wrong recipe 10');
    expect(history).not.toContain('same wrong recipe 7');
  });

  it('lets anomaly signals bypass cadence, output threshold, cooldown, and routine cap', () => {
    expect(selectSupervisorAssessmentTrigger({
      anomalySignals: ['gate_failed:release'],
      runningStageCount: 0,
      accumulatedOutputBytes: 0,
      minDeltaBytes: 4096,
      now: 1,
      lastRoutineAssessmentAt: 1,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 20,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: Number.MAX_SAFE_INTEGER,
    })).toBe('anomaly');
  });

  it('requires cumulative 4096 bytes and 180 seconds for an ordinary assessment', () => {
    const common = {
      anomalySignals: [] as string[],
      runningStageCount: 1,
      minDeltaBytes: 4096,
      now: 180_000,
      lastRoutineAssessmentAt: 0,
      routineAssessmentIntervalMs: 180_000,
      routineAssessmentsThisIteration: 0,
      maxRoutineAssessmentsPerIteration: 20,
      cooldownUntil: 0,
    };
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 1500 + 1500 + 1500 })).toBe('routine');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4095 })).toBe('none');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4096, now: 179_999 })).toBe('none');
    expect(selectSupervisorAssessmentTrigger({ ...common, accumulatedOutputBytes: 4096, routineAssessmentsThisIteration: 20 })).toBe('none');
  });

  it('retains enough semantic opportunities for the recorded 10 GUIDE → ABORT case', () => {
    const historical = [
      [5, '2026-07-06T08:04:10.409Z', 'GUIDE'],
      [7, '2026-07-06T08:05:43.309Z', 'GUIDE'],
      [11, '2026-07-06T08:07:59.316Z', 'GUIDE'],
      [21, '2026-07-06T08:13:14.799Z', 'GUIDE'],
      [31, '2026-07-06T08:18:30.731Z', 'GUIDE'],
      [41, '2026-07-06T08:23:39.211Z', 'GUIDE'],
      [51, '2026-07-06T08:28:48.101Z', 'GUIDE'],
      [61, '2026-07-06T08:33:55.903Z', 'GUIDE'],
      [72, '2026-07-06T08:39:32.545Z', 'GUIDE'],
      [82, '2026-07-06T08:44:42.067Z', 'GUIDE'],
      [92, '2026-07-06T08:49:48.315Z', 'ABORT'],
    ] as const;
    expect(historical.filter(([, , verdict]) => verdict === 'GUIDE')).toHaveLength(10);
    expect(historical.at(-1)).toEqual([92, '2026-07-06T08:49:48.315Z', 'ABORT']);
    const timestamps = historical.map(([, timestamp]) => Date.parse(timestamp));
    const historicalWindowMs = timestamps.at(-1)! - timestamps[0];
    const requiredAssessments = historical.length;
    const supervisor = loadSupervisorConfig();
    const conservativeCycleMs = supervisor.routineAssessmentIntervalMs + productionAssessmentTimeoutMs();
    const opportunities = Math.floor(historicalWindowMs / conservativeCycleMs);
    expect(opportunities).toBeGreaterThanOrEqual(requiredAssessments);
    expect(supervisor.maxAssessmentsPerIteration).toBeGreaterThanOrEqual(opportunities);
  });

  it('detects every enumerated immediate signal class', () => {
    const state = baseState();
    state.status = 'parked';
    state.campaignAlert = {
      type: 'plateau', action: 'inject_researcher', message: 'flat metric',
      source: 'campaign_health', triggeredAt: '2026-07-31T00:01:00.000Z', iteration: 1,
    };
    state.budget = { totalTokens: 1000, usedTokens: 950 };
    state.stages.work = {
      status: 'failed', retries: 1,
      attempts: [
        { index: 1, startedAt: 'a', completedAt: 'b', status: 'failed' },
        { index: 2, startedAt: 'c', completedAt: 'd', status: 'failed' },
      ],
    };
    const signals = detectSupervisorAnomalySignals({
      state,
      stageTransitionFingerprint: 'work:running>failed',
      stalledStageIds: ['work'],
      recentArtifacts: [{ path: 'verdict_release.json', content: '{"pass":false,"reason":"broken"}' }],
      userInput: 'inspect the failure',
      pendingApprovalFingerprint: 'work:123',
    });
    for (const prefix of [
      'stage_transition:', 'stalled:', 'gate_failed:', 'repeated_failure:',
      'metric_plateau:', 'budget_near_exhaustion:', 'pending_approval:',
      'pending_approval_state:', 'user_input:',
    ]) {
      expect(signals.some((signal) => signal.startsWith(prefix)), prefix).toBe(true);
    }
  });
});
