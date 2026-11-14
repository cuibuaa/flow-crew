import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { runRecordPath } from '../src/run-layout.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  recoverTerminalStudyCompletion,
} from '../src/scheduler.js';
import { runDir, readRunState, writeRunState, type StoreState } from '../src/store.js';

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

describe('terminal study completion contract', () => {
  it('G1: stable final study completion evidence recovers a running run before re-plan', async () => {
    const gateId = 'btc_transfer_multiphase_gate';
    mkdirSync(runRecordPath(runDir(projectDir, runId), 'stages', gateId), { recursive: true });
    writeFileSync(runRecordPath(runDir(projectDir, runId), `verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      model_success: false,
      study_complete: true,
      reason: 'study_complete_without_model_success',
      metric: 'BTCTransferRobustScore',
      value: 93.34564328835455,
      threshold: 300,
    }));

    const state: StoreState = {
      briefAdmission: createBriefAdmission(inspectBrief(''), { kind: 'not_required' }),
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
    };
    // Recovery concludes an existing run under its state lock, as in the engine.
    writeRunState(projectDir, runId, state);
    const recovered = await recoverTerminalStudyCompletion(projectDir, runId, state);

    expect(recovered?.status).toBe('complete');
    expect(recovered?.stages[gateId].status).toBe('complete');
    expect(recovered?.campaignAlert).toEqual(state.campaignAlert);
    expect(readRunState(projectDir, runId).status).toBe('complete');
  });

  it('G2: intermediate phase progress verdict remains non-terminal', async () => {
    const gateId = 'qa_phase3_adaptation_protocols';
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    writeFileSync(runRecordPath(runDir(projectDir, runId), `verdict_${gateId}.json`), JSON.stringify({
      pass: false,
      phase_complete: true,
      continue_next_phase: true,
      reason: 'phase3_complete_continue_next_phase',
    }));

    const recovered = await recoverTerminalStudyCompletion(projectDir, runId, {
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
