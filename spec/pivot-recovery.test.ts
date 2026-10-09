import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  checkCampaignHealth,
  recoverTerminalStudyCompletion,
  type CampaignEntry,
} from '../src/scheduler.js';
import { runDir } from '../src/store.js';

let projectDir: string;
let runId: string;

beforeEach(() => {
  projectDir = join(tmpdir(), 'pivot-recovery-' + randomBytes(6).toString('hex'));
  runId = 'run-' + randomBytes(4).toString('hex');
  mkdirSync(runDir(projectDir, runId), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('campaign health after a pivot', () => {
  it('recovery — after successful pivot, campaign health resets', () => {
    const entries: CampaignEntry[] = [
      { seq: 1, runId: 'r1', score: 80, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-01T00:00:00Z' },
      { seq: 2, runId: 'r2', score: 75, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-02T00:00:00Z' },
      { seq: 3, runId: 'r3', score: 70, metric: 'acc', gate: 'eval', pass: false, timestamp: '2024-01-03T00:00:00Z' },
      { seq: 4, runId: 'r4', score: 90, metric: 'acc', gate: 'eval', pass: true, timestamp: '2024-01-04T00:00:00Z' },
      { seq: 5, runId: 'r5', score: 92, metric: 'acc', gate: 'eval', pass: true, timestamp: '2024-01-05T00:00:00Z' },
    ];
    const alert = checkCampaignHealth(entries);
    expect(alert).toBeNull();
  });
});

describe('terminal study completion contract', () => {
  it('G1: stable final study completion evidence recovers a running run before re-plan', () => {
    const gateId = 'btc_transfer_multiphase_gate';
    mkdirSync(join(runDir(projectDir, runId), 'stages', gateId), { recursive: true });
    writeFileSync(join(runDir(projectDir, runId), `pre_gate_verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      model_success: false,
      study_complete: true,
      reason: 'study_complete_without_model_success',
      metric: 'BTCTransferRobustScore',
      value: 93.34564328835455,
      threshold: 300,
    }));

    const recovered = recoverTerminalStudyCompletion(projectDir, runId, {
      runId,
      workflowName: 'default',
      projectDir,
      status: 'running',
      stages: {
        plan: { status: 'complete', retries: 0 },
        [gateId]: { status: 'pending', retries: 0 },
      },
      dispatchedStages: [{ id: gateId, is_gate: true }],
      startedAt: '2026-05-04T00:00:00.000Z',
      currentIteration: 11,
      campaignAlert: {
        type: 'regression',
        action: 'inject_researcher',
        message: '2 consecutive score declines',
        source: 'campaign_health',
        triggeredAt: '2026-05-04T00:00:00.000Z',
        iteration: 11,
      },
      researchInjection: {
        source: 'campaign_health',
        triggeredAt: '2026-05-04T00:00:00.000Z',
        iteration: 11,
        alertType: 'regression',
        message: '2 consecutive score declines',
      },
    });

    expect(recovered?.status).toBe('complete');
    expect(recovered?.stages[gateId].status).toBe('complete');
    expect(recovered?.campaignAlert).toBeUndefined();
    expect(recovered?.researchInjection).toBeUndefined();
  });

  it('G2: intermediate phase progress verdict remains non-terminal', () => {
    const gateId = 'qa_phase3_adaptation_protocols';
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    writeFileSync(join(runDir(projectDir, runId), `pre_gate_verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      phase_complete: true,
      continue_next_phase: true,
      reason: 'phase3_complete_continue_next_phase',
    }));

    const recovered = recoverTerminalStudyCompletion(projectDir, runId, {
      runId,
      workflowName: 'default',
      projectDir,
      status: 'running',
      stages: { [gateId]: { status: 'complete', retries: 0 } },
      dispatchedStages: [{ id: gateId, is_gate: true }],
      startedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(recovered).toBeNull();
  });
});
