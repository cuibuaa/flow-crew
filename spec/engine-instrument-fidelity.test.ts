import { describe, expect, it } from 'vitest';
import {
  assessCampaignHygiene,
  CAMPAIGN_CONTEXT_SKIP_THRESHOLD,
} from '../src/campaign-hygiene.js';
import { classifyGenericPathLexeme } from '../src/path-lexeme.js';
import {
  evaluateSupervisorReplanFreshness,
  reconcileSupervisorReplan,
  type StageConfig,
  type SupervisorReplanSignalV2,
} from '../src/scheduler.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import type { RunEvent } from '../src/run-events.js';
import { classifySupervisorCommandEvidence } from '../src/supervisor.js';

function ended(seq: number, status: string): CampaignHistoryEntry {
  return {
    seq,
    runId: `run-${seq}`,
    kind: 'task_ended',
    pass: status === 'complete',
    status,
    timestamp: `2026-08-01T00:0${seq}:00.000Z`,
  };
}

describe('engine instrument fidelity boundaries', () => {
  it('separates read-only inspection commands from action-bearing controls', () => {
    const commands = [
      { command: "sed -n '1p' committed/corpus.jsonl", authority: 'inspection' },
      { command: 'rg -n workflow committed/corpus.jsonl | head -20', authority: 'inspection' },
      { command: 'git show HEAD:committed/corpus.jsonl', authority: 'inspection' },
      { command: "sed -i 's/old/new/' src/file.ts", authority: 'action' },
      { command: 'rg -n workflow committed/corpus.jsonl > reports/result.txt', authority: 'action' },
      { command: 'python scripts/run_market_workflow.py --write reports/result.json', authority: 'action' },
      { command: 'echo $(node scripts/generate.js)', authority: 'action' },
    ].map(({ command, authority }) => ({
      command,
      expected: authority,
      actual: classifySupervisorCommandEvidence(command),
    }));

    expect(commands.every((row) => row.actual === row.expected)).toBe(true);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "sed -n '1p' committed/corpus.jsonl", actual: 'inspection' }),
      expect.objectContaining({ command: 'python scripts/run_market_workflow.py --write reports/result.json', actual: 'action' }),
    ]));
  });

  it('derives the adverse-history threshold used by reporting and launch', () => {
    const sweep = [0, 1, 2, 3, 4].map((adverse) => assessCampaignHygiene([
      ...Array.from({ length: adverse }, (_, index) => ended(index + 1, 'failed')),
      ...Array.from({ length: 4 - adverse }, (_, index) => ended(adverse + index + 1, 'complete')),
    ]).suggestContextSkip);

    expect(CAMPAIGN_CONTEXT_SKIP_THRESHOLD).toBe(3);
    expect(sweep).toEqual([false, false, false, true, true]);
  });

  it('classifies regex escapes and acronym labels as text but literal paths as paths', () => {
    const rows = [
      { value: String.raw`input\.md`, context: 'literal' as const },
      { value: String.raw`docs\/report\.md`, context: 'literal' as const },
      { value: String.raw`scheduler\.ts`, context: 'literal' as const },
      { value: String.raw`/stages\/[a-z]+\/input\.md/`, context: 'literal' as const },
      { value: 'CPI/FOMC', context: 'prose' as const },
      { value: 'input/.md', context: 'prose' as const },
      { value: 'scheduler/.ts', context: 'prose' as const },
      { value: 'docs/report.md', context: 'prose' as const },
      { value: 'config/.env', context: 'prose' as const },
      { value: String.raw`docs\report.md`, context: 'literal' as const },
    ].map(({ value, context }) => ({ value, decision: classifyGenericPathLexeme(value, context).kind }));

    expect(rows).toEqual([
      { value: String.raw`input\.md`, decision: 'text' },
      { value: String.raw`docs\/report\.md`, decision: 'text' },
      { value: String.raw`scheduler\.ts`, decision: 'text' },
      { value: String.raw`/stages\/[a-z]+\/input\.md/`, decision: 'text' },
      { value: 'CPI/FOMC', decision: 'text' },
      { value: 'input/.md', decision: 'text' },
      { value: 'scheduler/.ts', decision: 'text' },
      { value: 'docs/report.md', decision: 'path' },
      { value: 'config/.env', decision: 'path' },
      { value: String.raw`docs\report.md`, decision: 'path' },
    ]);
  });

  it('discards a structured REPLAN when later records supersede and validate its target', () => {
    const signal: SupervisorReplanSignalV2 = {
      version: 2,
      assessmentId: 'sa_aaaaaaaaaaaaaaaaaaaa',
      targetStage: 'freeze_work',
      attemptIndex: 1,
      attemptStartedAt: '2026-08-01T05:30:00.000Z',
      evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      reason: 'the approach is unrelated',
      timestamp: '2026-08-01T05:31:09.000Z',
    };
    const stages: StageConfig[] = [
      { id: 'freeze_work', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [] },
      { id: 'audit_work', role: 'qa', depends_on: ['freeze_work'], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: true, criterion_refs: [] },
    ];
    const events: RunEvent[] = [
      {
        type: 'supervisor_assessment', runId: 'run', timestamp: '2026-08-01T05:32:00.000Z',
        assessmentId: 'sa_bbbbbbbbbbbbbbbbbbbb', supersedesAssessmentId: signal.assessmentId,
        supervisorVerdict: 'WAIT', source: 'supervisor',
      },
      {
        type: 'stage_complete', runId: 'run', timestamp: '2026-08-01T05:39:41.917Z',
        stageId: 'freeze_work', attemptIndex: 1, attemptStartedAt: signal.attemptStartedAt,
      },
      {
        type: 'stage_complete', runId: 'run', timestamp: '2026-08-01T06:46:00.000Z',
        stageId: 'audit_work', attemptIndex: 1,
      },
    ];

    expect(evaluateSupervisorReplanFreshness({
      signal, events, stages, passedGateIds: ['audit_work'],
    })).toEqual({
      decision: 'discard',
      signalVersion: 2,
      reason: 'superseded by sa_bbbbbbbbbbbbbbbbbbbb; target freeze_work execution 1 subsequently completed; related gate(s) accepted: audit_work',
      supersedingAssessmentIds: ['sa_bbbbbbbbbbbbbbbbbbbb'],
      completedTarget: true,
      relatedAcceptedGateIds: ['audit_work'],
    });
  });

  it('retains a current identified REPLAN and legacy compatibility control', () => {
    const signal: SupervisorReplanSignalV2 = {
      version: 2,
      assessmentId: 'sa_aaaaaaaaaaaaaaaaaaaa',
      targetStage: 'work',
      attemptIndex: 1,
      attemptStartedAt: '2026-08-01T05:30:00.000Z',
      evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      reason: 'current wrong direction',
      timestamp: '2026-08-01T05:31:09.000Z',
    };
    const work: StageConfig = {
      id: 'work', role: 'coder', depends_on: [], prompt_template: '', skills: [],
      dynamic_dispatch: false, is_gate: false, criterion_refs: [],
    };

    expect(evaluateSupervisorReplanFreshness({
      signal, events: [], stages: [work], passedGateIds: [],
    })).toMatchObject({ decision: 'replay', signalVersion: 2 });
    expect(evaluateSupervisorReplanFreshness({
      signal: { reason: 'legacy pivot', timestamp: signal.timestamp },
      events: [], stages: [work], passedGateIds: [],
    })).toMatchObject({ decision: 'replay', signalVersion: 'legacy' });
  });

  it('binds a recorded legacy REPLAN to its supervisor action without guessing an unmatched signal', () => {
    const signal = {
      reason: 'corpus content was mistaken for the stage direction',
      timestamp: '2026-08-01T05:31:09.000Z',
    };
    const events: RunEvent[] = [
      {
        type: 'attempt_started', runId: 'run', timestamp: '2026-08-01T05:30:00.000Z',
        stageId: 'freeze_work', attemptIndex: 1, attemptStartedAt: '2026-08-01T05:30:00.000Z',
      },
      {
        type: 'stage_complete', runId: 'run', timestamp: '2026-08-01T05:39:41.917Z',
        stageId: 'freeze_work', attemptIndex: 1, attemptStartedAt: '2026-08-01T05:30:00.000Z',
      },
    ];
    const matched = reconcileSupervisorReplan({
      signal,
      events,
      supervisorState: { actions: [{
        timestamp: '2026-08-01T05:31:09.010Z',
        verdict: 'REPLAN',
        targetStage: 'freeze_work',
        targetAttemptIndex: 1,
        reason: signal.reason,
      }] },
      supervisorLog: [
        '# Supervisor Log',
        '',
        '## Tick 1 — 2026-08-01T05:31:09.010Z',
        'Verdict: **REPLAN** → freeze_work',
        `Reason: ${signal.reason}`,
        '',
      ].join('\n'),
    });
    const unmatched = reconcileSupervisorReplan({
      signal: { ...signal, reason: 'different legacy reason' },
      events,
      supervisorState: { actions: [{
        timestamp: '2026-08-01T05:31:09.010Z',
        verdict: 'REPLAN',
        targetStage: 'freeze_work',
        targetAttemptIndex: 1,
        reason: signal.reason,
      }] },
    });
    const work: StageConfig = {
      id: 'freeze_work', role: 'coder', depends_on: [], prompt_template: '', skills: [],
      dynamic_dispatch: false, is_gate: false, criterion_refs: [],
    };

    expect(matched.identitySource).toBe('supervisor_state');
    expect(evaluateSupervisorReplanFreshness({
      signal: matched.signal, events: matched.events, stages: [work], passedGateIds: [],
    })).toMatchObject({ decision: 'discard', completedTarget: true });
    expect(unmatched.identitySource).toBe('unresolved_legacy');
    expect(evaluateSupervisorReplanFreshness({
      signal: unmatched.signal, events: unmatched.events, stages: [work], passedGateIds: [],
    })).toMatchObject({ decision: 'replay', signalVersion: 'legacy' });
  });
});
