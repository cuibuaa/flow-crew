import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFrozenCampaignContract,
  deriveCampaignSuccessor,
  verifyFrozenCampaignContract,
} from '../src/campaign-successor.js';
import type { CampaignSuccessorInput } from '../src/campaign-successor.js';
import {
  advanceCampaignSuccessor,
  createConfiguredCampaignSuccessorRuntime,
  ensureFrozenCampaignContract,
  runCampaign,
} from '../src/campaign.js';
import type { CampaignConfig } from '../src/campaign.js';
import { createBriefAdmission, inspectBrief, verifyBriefAdmission } from '../src/brief-preflight.js';
import { ensureBriefDir } from '../src/brief-versioning.js';
import { rehearseBriefIsolated } from '../src/rehearse.js';
import type { IsolatedRehearsalResult } from '../src/rehearse.js';
import type { TaskCreateInput, TaskEntry } from '../src/task-registry.js';
import { renderGuidanceEnvelope } from '../src/guidance.js';
import { fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';
import { loadClosedLoopCampaignEvidence } from './test-support/closed-loop-campaign-evidence.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `flowcrew-${label}-`));
  tempDirectories.push(directory);
  return directory;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function deriveReplay() {
  const fixture = loadClosedLoopCampaignEvidence();
  const result = deriveCampaignSuccessor(fixture.derivationInput);
  expect(result.status).toBe('derived');
  if (result.status !== 'derived') throw new Error(result.reason);
  return { fixture, result };
}

describe('cancelled campaign successor replay', () => {
  it('derives the 20-minute floor from task 2135/run evidence before consulting the task 2137 oracle', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    expect(JSON.stringify(loaded.derivationInput)).not.toContain('2137');
    expect(JSON.stringify(loaded.derivationInput)).not.toContain('hardFloorAnchor');

    // Derivation is intentionally complete before the comparison-only oracle is read.
    const first = deriveCampaignSuccessor(loaded.derivationInput);
    const second = deriveCampaignSuccessor(structuredClone(loaded.derivationInput));
    expect(first).toEqual(second);
    expect(first.status).toBe('derived');
    if (first.status !== 'derived') throw new Error(first.reason);

    expect(first.floor).toMatchObject(loaded.expectation.floor);
    expect(first.floor.criterionId).toBe(loaded.expectation.convertedCriterionId);
    expect(first.promotedGuidanceIds).toEqual([...loaded.expectation.promotedGuidanceIds].sort());
    expect(first.declinedItemIds).toHaveLength(3);
    expect(first.terminalEvidence).toMatchObject({ evidenceMode: 'bytes', historicalReplay: true });
    expect(first.structuredDiff.entries.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      'promoted_guidance',
      'converted_criterion',
      'declined_item',
    ]));
    expect(first.unifiedDiff).toContain('+## Campaign successor constraints (mechanically derived)');
    expect(first.successorBrief).toContain('`dose_minutes >= 20 minutes`');
    expect(first.successorBrief).toContain('A value below this floor fails this criterion.');
    expect(first.expectation).toEqual({
      expectedFloor: 20,
      latestObservedValue: loaded.expectation.latestObservedDoseMinutes,
      unit: 'minutes',
      within_expected_range: loaded.expectation.within_expected_range,
      method_was_not_adjusted_to_match_expectation: loaded.expectation.method_was_not_adjusted_to_match_expectation,
    });

    const oracle = loaded.oracle;
    expect(oracle.comparisonOnly).toBe(true);
    expect(first.contract.yardstickDigest).toBe(oracle.yardstickDigest);
    expect(oracle.containsHardDoseFloor).toBe(true);
  });

  it('keeps every embedded byte anchor internally exact without opening mutable evidence paths', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    expect(loaded.anchors.length).toBeGreaterThanOrEqual(6);
    for (const anchor of loaded.anchors) {
      expect(Buffer.byteLength(anchor.utf8, 'utf8')).toBe(anchor.byteEndExclusive - anchor.byteStart);
      expect(digest(anchor.utf8)).toBe(anchor.sha256);
    }
    expect(loaded.anchors.some((anchor) => anchor.label === 'b4-guidance-floor-authority')).toBe(true);
    expect(loaded.anchors.some((anchor) => anchor.label === 'b4-dose-series')).toBe(true);
  });

  it('rehearses the derived successor through the real scheduler without mutating the inspected project', async () => {
    const { result } = deriveReplay();
    const projectDir = temporaryDirectory('successor-rehearsal-project');
    const before = readdirSync(projectDir);

    const rehearsal = await rehearseBriefIsolated(result.successorBrief, {
      projectDir,
      label: 'cancelled-run-successor-replay',
    });

    expect(rehearsal.exitCode).toBe(0);
    expect(rehearsal.simulated).toBe(true);
    expect(rehearsal.preflight.contractReady).toBe(true);
    expect(rehearsal.outputInventory.blocking).toBe(0);
    expect(readdirSync(projectDir)).toEqual(before);
  }, 120_000);
});

describe('fail-closed successor derivation', () => {
  it('escalates when prose has no operator-authorized numeric floor', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const input = structuredClone(loaded.derivationInput);
    input.operatorGuidance = input.operatorGuidance?.map((entry) => ({
      ...entry,
      body: (entry.body ?? '').replaceAll('20 minutes', 'a materially larger dose'),
    }));

    const result = deriveCampaignSuccessor(input);

    expect(result.status).toBe('escalated');
    if (result.status === 'escalated') expect(result.reason).toMatch(/no operator-authorized numeric unit-bearing floor/);
  });

  it('does not let supervisor wording authorize an operator floor', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const input = structuredClone(loaded.derivationInput);
    input.operatorGuidance = input.operatorGuidance?.map((entry) => ({ ...entry, source: 'supervisor' as const }));

    const result = deriveCampaignSuccessor(input);

    expect(result.status).toBe('escalated');
    if (result.status === 'escalated') expect(result.reason).toMatch(/no addressed operator guidance/);
  });

  it('escalates at the frozen run budget and stops before producing successor bytes', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const input: CampaignSuccessorInput = {
      ...structuredClone(loaded.derivationInput),
      campaignProgress: { usedRuns: 4 },
    };

    const result = deriveCampaignSuccessor(input);

    expect(result.status).toBe('escalated');
    if (result.status === 'escalated') expect(result.reason).toBe('campaign run budget exhausted (4/4)');
    expect('successorBrief' in result).toBe(false);
  });

  it('does not continue an ordinary stopped run outside explicit historical replay', () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const input = structuredClone(loaded.derivationInput);
    input.terminal.historicalReplay = false;
    delete input.terminal.artifactId;

    const result = deriveCampaignSuccessor(input);

    expect(result).toEqual({
      status: 'not_applicable',
      reason: 'terminal status stopped is not eligible for autonomous continuation',
    });
  });
});

describe('frozen contract and ordinary launch pipeline', () => {
  it('collects only byte-backed terminal, attributable guidance, and typed run-local evidence', async () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const projectDir = temporaryDirectory('configured-successor-project');
    const runDir = temporaryDirectory('configured-successor-run');
    const admissionPath = join(projectDir, 'parent-admission.json');
    const predecessorBrief = loaded.derivationInput.predecessorBrief;
    const parentReport = inspectBrief(predecessorBrief);
    const parentAdmission = createBriefAdmission(parentReport, parentReport.requiresAcknowledgement
      ? { kind: 'explicit', source: 'cli_digest_flag', at: '2026-09-04T12:00:00.000Z' }
      : { kind: 'not_required' });
    writeFileSync(admissionPath, `${JSON.stringify(parentAdmission)}\n`);
    const goalText = 'A policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies wholly above zero under the frozen evaluation, or an honest ceiling.';
    const yardstickText = String((loaded.derivationInput.campaignContract as Record<string, unknown>).yardstickText);
    const cfg: CampaignConfig = {
      id: 'configured-replay',
      projectDir,
      briefPath: join(projectDir, 'brief.md'),
      goal: { metric: 'paired_ev_per_hand', validRange: [0.001, 1] },
      budget: { maxRuns: 4, maxWallHours: 4 },
      diagnosisRules: [],
      launch: { systemdUnit: 'unused.service', launchScript: join(projectDir, 'unused.sh') },
      closedLoop: {
        goalText,
        yardstick: {
          text: yardstickText,
          metricId: 'paired_ev_per_hand',
          direction: 'increase',
          unit: 'points/hand',
          evaluationConstruction: 'paired blocks followed by disjoint confirmation',
        },
        noProgress: { metricId: 'paired_ev_per_hand', direction: 'increase', rounds: 3, tolerance: 0 },
        evidenceFile: 'campaign-successor-evidence.json',
        parentAdmissionPath: admissionPath,
      },
    };
    const terminalBytes = '{"status":"ceiling_hit","paired_ev_per_hand":0}\n';
    writeFileSync(join(runDir, 'run.json'), terminalBytes);
    writeFileSync(join(runDir, cfg.closedLoop!.evidenceFile), `${JSON.stringify({
      version: 1,
      criterion: loaded.derivationInput.criterion,
      metricSeries: loaded.derivationInput.metricSeries,
      declinedItems: loaded.derivationInput.declinedItems,
    })}\n`);
    const guidanceDir = join(runDir, 'guidance_history');
    mkdirSync(guidanceDir);
    const recordedGuidance = loaded.derivationInput.operatorGuidance![0];
    if (!recordedGuidance.target || !recordedGuidance.createdAt || !recordedGuidance.body) {
      throw new Error('recorded guidance is missing envelope fields');
    }
    writeFileSync(join(guidanceDir, 'iter_1.md'), renderGuidanceEnvelope({
      version: 1,
      id: recordedGuidance.id,
      target: recordedGuidance.target,
      source: recordedGuidance.source,
      createdAt: recordedGuidance.createdAt,
      body: recordedGuidance.body,
      ...(recordedGuidance.quarantined ? {
        quarantined: true,
        quarantineReason: recordedGuidance.quarantineReason,
      } : {}),
    }));

    const runtime = createConfiguredCampaignSuccessorRuntime(cfg, predecessorBrief, '2026-09-04T12:00:00.000Z');
    expect(runtime).toBeDefined();
    const evidence = await runtime!.collectEvidence({
      campaignId: cfg.id,
      iteration: 1,
      runId: 'run-evidence',
      runDir,
      predecessorBrief,
      outcome: { runId: 'run-evidence', status: 'ceiling_hit', result: 0 },
    });

    expect(evidence.terminal).toMatchObject({ status: 'ceiling_hit', artifactBytes: terminalBytes });
    expect(evidence.guidance).toHaveLength(1);
    expect(evidence.guidance?.[0]).toMatchObject({
      id: loaded.derivationInput.operatorGuidance?.[0].id,
      source: 'operator',
      addressed: true,
    });
    expect(evidence.metricSeries).toEqual(loaded.derivationInput.metricSeries);
    expect(evidence.declinedItems).toEqual(loaded.derivationInput.declinedItems);

    const completeBytes = '{"status":"complete","paired_ev_per_hand":0.5}\n';
    writeFileSync(join(runDir, 'run.json'), completeBytes);
    const completeEvidence = await runtime!.collectEvidence({
      campaignId: cfg.id,
      iteration: 2,
      runId: 'run-complete',
      runDir,
      predecessorBrief,
      outcome: { runId: 'run-complete', status: 'complete', result: 0.5 },
    });
    expect(completeEvidence.terminal).toMatchObject({
      status: 'complete', goalMet: true, artifactBytes: completeBytes,
    });
  });

  it('stops a complete goal-satisfying run before collecting successor evidence', async () => {
    const stateDir = temporaryDirectory('goal-met-state');
    const projectDir = temporaryDirectory('goal-met-project');
    const previousStateDir = fcGlobalDir();
    setFcGlobalDir(stateDir);
    try {
      const goalText = 'Goal: keep result inside the frozen acceptance interval.';
      const yardstickText = 'Yardstick: result is measured by the terminal run artifact.';
      const brief = `# Campaign\n\n${goalText}\n\n${yardstickText}\n`;
      const briefPath = join(projectDir, 'brief.md');
      writeFileSync(briefPath, brief);
      const report = inspectBrief(brief);
      const parentAdmission = createBriefAdmission(report, report.requiresAcknowledgement
        ? { kind: 'explicit', source: 'cli_digest_flag', at: '2026-09-04T12:00:00.000Z' }
        : { kind: 'not_required' });
      const contract = createFrozenCampaignContract({
        campaignId: `goal-met-${randomBytes(4).toString('hex')}`,
        createdAt: '2026-09-04T12:00:00.000Z',
        sourceBrief: brief,
        goalText,
        yardstickText,
        yardstick: {
          metricId: 'result', direction: 'increase', unit: 'score',
          evaluationConstruction: 'terminal run result',
        },
        budget: { maxRuns: 1, usedRuns: 0 },
        noProgress: { metricId: 'result', direction: 'increase', rounds: 2, tolerance: 0 },
      });
      const runId = `goal-met-run-${randomBytes(4).toString('hex')}`;
      const runPath = join(runsRoot(), runId);
      const launchPath = join(projectDir, 'launch.sh');
      writeFileSync(launchPath, `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p ${JSON.stringify(runPath)}\nprintf '%s\\n' '${JSON.stringify({
        runId,
        workflowName: 'goal-met-test',
        projectDir,
        status: 'complete',
        stages: {},
        startedAt: '2026-09-04T12:00:00.000Z',
        result: 1.5,
      })}' > ${JSON.stringify(join(runPath, 'run.json'))}\n`);
      chmodSync(launchPath, 0o755);
      const cfg: CampaignConfig = {
        id: contract.campaignId,
        briefPath,
        projectDir,
        goal: { metric: 'result', validRange: [1, 2] },
        budget: { maxRuns: 1, maxWallHours: 0.01 },
        diagnosisRules: [],
        launch: { systemdUnit: 'unused.service', launchScript: launchPath },
      };
      let collectCalls = 0;
      const result = await runCampaign(cfg, {
        successor: {
          contract,
          parentAdmission,
          collectEvidence() {
            collectCalls += 1;
            throw new Error('goal-met run must not derive a successor');
          },
        },
      });

      expect(result.status).toBe('goal_met');
      expect(collectCalls).toBe(0);
    } finally {
      setFcGlobalDir(previousStateDir);
    }
  });

  it('freezes once and rejects later goal or yardstick drift', () => {
    const { fixture } = deriveReplay();
    const stateDir = temporaryDirectory('frozen-campaign-state');
    const goalText = 'A policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies wholly above zero under the frozen evaluation, or an honest ceiling.';
    const yardstickText = String((fixture.derivationInput.campaignContract as Record<string, unknown>).yardstickText);
    const contract = createFrozenCampaignContract({
      campaignId: 'replay-campaign',
      createdAt: '2026-09-04T12:00:00.000Z',
      sourceBrief: fixture.derivationInput.predecessorBrief,
      goalText,
      yardstickText,
      yardstick: {
        metricId: 'paired_ev_per_hand',
        direction: 'increase',
        unit: 'points/hand',
        evaluationConstruction: 'paired candidate-minus-fixed-opponents blocks followed by disjoint confirmation',
      },
      budget: { maxRuns: 4, usedRuns: 0, maxWallMs: 14_400_000, startedAt: '2026-09-04T12:00:00.000Z' },
      noProgress: { metricId: 'paired_ev_per_hand', direction: 'increase', rounds: 3, tolerance: 0 },
    });

    expect(verifyFrozenCampaignContract(contract)).toEqual([]);
    expect(ensureFrozenCampaignContract(stateDir, contract, fixture.derivationInput.predecessorBrief)).toEqual(contract);
    expect(ensureFrozenCampaignContract(stateDir, structuredClone(contract), fixture.derivationInput.predecessorBrief)).toEqual(contract);
    const drifted = structuredClone(contract);
    drifted.budget.maxRuns = 5;
    expect(() => ensureFrozenCampaignContract(stateDir, drifted, fixture.derivationInput.predecessorBrief)).toThrow(/drifted/);
  });

  it('records diff/rehearsal/admission before the ordinary registration call', async () => {
    const loaded = loadClosedLoopCampaignEvidence();
    const projectDir = temporaryDirectory('successor-pipeline-project');
    const campaignStateDir = join(projectDir, 'campaign-state');
    const briefDir = join(projectDir, 'brief-versions');
    ensureBriefDir(briefDir, loaded.derivationInput.predecessorBrief);
    const goalText = 'A policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies wholly above zero under the frozen evaluation, or an honest ceiling.';
    const yardstickText = String((loaded.derivationInput.campaignContract as Record<string, unknown>).yardstickText);
    const contract = createFrozenCampaignContract({
      campaignId: 'replay-campaign',
      createdAt: '2026-09-04T12:00:00.000Z',
      sourceBrief: loaded.derivationInput.predecessorBrief,
      goalText,
      yardstickText,
      yardstick: {
        metricId: 'paired_ev_per_hand',
        direction: 'increase',
        unit: 'points/hand',
        evaluationConstruction: 'paired blocks and disjoint confirmation',
      },
      budget: { maxRuns: 4, usedRuns: 0 },
      noProgress: { metricId: 'paired_ev_per_hand', direction: 'increase', rounds: 3, tolerance: 0 },
    });
    ensureFrozenCampaignContract(campaignStateDir, contract, loaded.derivationInput.predecessorBrief);
    const parentReport = inspectBrief(loaded.derivationInput.predecessorBrief);
    const parentAdmission = createBriefAdmission(parentReport, parentReport.requiresAcknowledgement
      ? { kind: 'explicit', source: 'cli_digest_flag', at: '2026-09-04T12:00:00.000Z' }
      : { kind: 'not_required' });
    const rehearsal: IsolatedRehearsalResult = {
      exitCode: 0,
      findings: [{ level: 'ok', text: 'isolated scheduler rehearsal complete' }],
      simulated: true,
      preflight: { digest: 'recorded-by-stub', contractReady: true, requiresAcknowledgement: false },
      outputInventory: { entries: 3, blocking: 0 },
      diagnosticsLogPath: join(tmpdir(), 'closed-loop-rehearsal.log'),
    };
    let registrations = 0;
    const registerAndLaunch = async (task: TaskCreateInput): Promise<TaskEntry> => {
      registrations += 1;
      const evidenceDir = join(campaignStateDir, 'successors', 'v2');
      expect(existsSync(join(evidenceDir, 'structured_diff.json'))).toBe(true);
      expect(existsSync(join(evidenceDir, 'successor.diff'))).toBe(true);
      expect(existsSync(join(evidenceDir, 'rehearsal.json'))).toBe(true);
      expect(existsSync(join(evidenceDir, 'brief_admission.json'))).toBe(true);
      expect(verifyBriefAdmission(task.brief_text ?? '', task.brief_admission).status).toBe('valid');
      return {
        id: 99,
        name: task.name ?? 'successor',
        kind: 'quick',
        brief_path: join(projectDir, 'task-99-brief.md'),
        brief_admission: task.brief_admission,
        projectDir,
        systemd_unit: 'flowcrew-task-99.service',
        run_id: 'successor-run-99',
        status: 'running',
        attempt: 1,
        max_retries: 2,
        created_at: '2026-09-04T12:00:01.000Z',
        tick_log_path: join(projectDir, 'tick.md'),
      };
    };

    const outcome = await advanceCampaignSuccessor({
      campaignId: 'replay-campaign',
      projectDir,
      campaignStateDir,
      briefDir,
      predecessorBrief: loaded.derivationInput.predecessorBrief,
      parentAdmission,
      contract,
      evidence: {
        terminal: {
          status: 'complete',
          goalMet: false,
          artifactId: 'terminal-artifact.json',
          artifactBytes: '{"status":"complete","goalMet":false}\n',
        },
        operatorGuidance: loaded.derivationInput.operatorGuidance,
        declinedItems: loaded.derivationInput.declinedItems,
        criterion: loaded.derivationInput.criterion,
        metricSeries: loaded.derivationInput.metricSeries,
        campaignProgress: { usedRuns: 1, observedAt: '2026-09-04T12:00:01.000Z' },
      },
      rehearse: async () => rehearsal,
      registerAndLaunch,
      now: '2026-09-04T12:00:01.000Z',
    });

    expect(outcome.status).toBe('launched');
    expect(registrations).toBe(1);
    if (outcome.status !== 'launched') throw new Error(outcome.reason);
    expect(outcome.task.run_id).toBe('successor-run-99');
    expect(readFileSync(join(briefDir, 'HEAD'), 'utf-8')).toBe('v2\n');
    expect(readFileSync(join(campaignStateDir, 'successors', 'v2', 'launch.json'), 'utf-8')).toContain('successor-run-99');
  });
});
