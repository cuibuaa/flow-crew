/**
 * Phase-0 safety net — P3 live-glue contract (mock adapter + mock inner launcher, no LLM/runs).
 *
 * Pins that the live deps wire the campaign_planner output → next direction (or frontier) and the
 * inner launcher → measured outcome, driving the real runCampaignLoop end to end.
 */
import { describe, expect, it } from 'vitest';
import {
  CampaignAwaitingApprovalError,
  parseNextDirection,
  parseScoutDirections,
  scoutDirections,
  runLiveCampaign,
} from '../../src/campaign-loop-live.js';
import type { Adapter, AgentConfig, RunResult } from '../../src/adapters/base.js';
import type { ResearchConfig } from '../../src/store.js';

describe('P3 live-glue — parseNextDirection', () => {
  it('extracts next_direction from JSON (tolerant of surrounding prose)', () => {
    expect(parseNextDirection('thinking...\n{"next_direction": "vpin_toxicity", "why_new": "x"}\ndone')).toBe('vpin_toxicity');
  });
  it('returns null on a frontier verdict', () => {
    expect(parseNextDirection('{"next_direction": null, "frontier": true, "reason": "exhausted"}')).toBeNull();
  });
  it('returns null when there is no parseable direction', () => {
    expect(parseNextDirection('no json here')).toBeNull();
  });
});

const objective = (stop: Record<string, unknown>): ResearchConfig =>
  ({ baseline: 0, policy: 'best_of_n', higherIsBetter: true, stop } as ResearchConfig);

const proposeRole = { name: 'campaign_planner', description: 'x', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'ledger={ledger_digest} ctx={context_inventory}' } as AgentConfig;
const runOpts = { timeout_ms: 1, workDir: '/tmp', runDir: '/tmp', stageId: 'propose' };

/** Mock adapter that emits a fixed sequence of campaign_planner verdicts. */
function mockAdapter(verdicts: string[]): Adapter {
  let i = 0;
  return {
    async run(): Promise<RunResult> { return { output: verdicts[Math.min(i++, verdicts.length - 1)], exitCode: 0, duration_ms: 1 }; },
    async discuss(): Promise<RunResult> { return { output: '', exitCode: 0, duration_ms: 1 }; },
    spawnDiscuss() { throw new Error('unused'); },
    async spawnInteractive() { throw new Error('unused'); },
  } as unknown as Adapter;
}

describe('P3 live-glue — propose prompt carries the domain ledger', () => {
  it('appends briefContext (campaign goal + historical ledger) so the proposer avoids dead directions', async () => {
    let seenPrompt = '';
    const recordingAdapter = {
      async run(prompt: string): Promise<RunResult> { seenPrompt = prompt; return { output: '{"frontier": true, "next_direction": null}', exitCode: 0, duration_ms: 1 }; },
      async discuss(): Promise<RunResult> { return { output: '', exitCode: 0, duration_ms: 1 }; },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    await runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 99, maxRounds: 3, haltAfterNoImprovement: 2 }),
      proposeRole, adapter: recordingAdapter, proposeRunOpts: runOpts,
      launchInner: async () => 'run-x', readBest: () => 0,
      briefContext: 'SENTINEL_LEDGER: vpin_toxicity is DEAD, do not re-propose.',
    });
    expect(seenPrompt).toContain('SENTINEL_LEDGER: vpin_toxicity is DEAD');
    expect(seenPrompt).toContain('CAMPAIGN BRIEF');
  });
});

describe('P3 live-glue — a crashed proposer is NOT a frontier', () => {
  it('throws when the propose adapter call exits non-zero (no false-negative frontier)', async () => {
    const crashingAdapter = {
      async run(): Promise<RunResult> { return { output: 'ERROR: 400 model not supported', exitCode: 1, duration_ms: 1 }; },
      async discuss(): Promise<RunResult> { return { output: '', exitCode: 0, duration_ms: 1 }; },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    await expect(runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 99, maxRounds: 3, haltAfterNoImprovement: 2 }),
      proposeRole, adapter: crashingAdapter, proposeRunOpts: runOpts,
      launchInner: async () => 'run-x', readBest: () => 0,
    })).rejects.toThrow(/proposer failed/);
  });
});

describe('P3 live-glue — literature scout (autonomous portfolio expansion)', () => {
  it('parseScoutDirections extracts new_directions (tolerant of prose)', () => {
    expect(parseScoutDirections('searched...\n{"new_directions": ["statistical_jump_model_derisk", "vol_managed"], "scan_summary": "x"}\ndone'))
      .toEqual(['statistical_jump_model_derisk', 'vol_managed']);
  });
  it('parseScoutDirections returns [] when none / unparseable', () => {
    expect(parseScoutDirections('{"new_directions": []}')).toEqual([]);
    expect(parseScoutDirections('no json')).toEqual([]);
  });
  it('scoutDirections returns the literature-found labels from the adapter', async () => {
    const adapter = {
      async run(): Promise<RunResult> { return { output: '{"new_directions":["statistical_jump_model_derisk"],"sources":["arxiv"]}', exitCode: 0, duration_ms: 1 }; },
      async discuss(): Promise<RunResult> { return { output: '', exitCode: 0, duration_ms: 1 }; },
      spawnDiscuss() { throw new Error('unused'); }, async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    const out = await scoutDirections({ projectDir: '/tmp/none', campaignId: 'c', objective: objective({}), scoutRole: proposeRole, adapter, runOpts });
    expect(out).toEqual(['statistical_jump_model_derisk']);
  });
  it('scoutDirections returns [] on scout failure (does NOT block the campaign)', async () => {
    const adapter = {
      async run(): Promise<RunResult> { return { output: 'boom', exitCode: 1, duration_ms: 1 }; },
      async discuss(): Promise<RunResult> { return { output: '', exitCode: 0, duration_ms: 1 }; },
      spawnDiscuss() { throw new Error('unused'); }, async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    expect(await scoutDirections({ projectDir: '/tmp/none', campaignId: 'c', objective: objective({}), scoutRole: proposeRole, adapter, runOpts })).toEqual([]);
  });
});

describe('P3 live-glue — outer loop respects the inner reality-gate verdict', () => {
  it('does NOT ship a reality_gate_failed inner run even with a high journaled result (false-positive leak guard)', async () => {
    const res = await runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 15, maxRounds: 2, haltAfterNoImprovement: 2 }),
      proposeRole, adapter: mockAdapter(['{"next_direction":"d1"}', '{"next_direction":"d2"}', '{"frontier":true,"next_direction":null}']),
      proposeRunOpts: runOpts,
      launchInner: async (d) => `run-${d}`,
      readBest: () => 99, // inner journaled a (cherry-picked, unverified) beat well past the target
      readRunStatus: () => 'reality_gate_failed', // ...but the inner safety net REJECTED it
    });
    expect(res.decision).toBe('frontier'); // rejected → scored at baseline → never ships
    expect(res.outcomes.every((o) => o.rejected && o.bestResult === 0)).toBe(true); // 0 = the helper's baseline
  });

  it('DOES ship a verified beat when the inner run reached a successful terminal', async () => {
    const res = await runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 15, maxRounds: 3, haltAfterNoImprovement: 3 }),
      proposeRole, adapter: mockAdapter(['{"next_direction":"d1"}']),
      proposeRunOpts: runOpts,
      launchInner: async () => 'run-d1',
      readBest: () => 16, // a real beat
      readRunStatus: () => 'ceiling_hit', // inner reached a successful terminal
    });
    expect(res.decision).toBe('shipped');
  });

  it('aborts on a parked inner run without recording a baseline outcome or trying another direction (M5)', async () => {
    const launched: string[] = [];
    let bestReads = 0;
    let caught: unknown;
    try {
      await runLiveCampaign({
        projectDir: '/tmp/none',
        campaignId: 'c',
        objective: objective({ beat: 15, maxRounds: 5, haltAfterNoImprovement: 3 }),
        proposeRole,
        adapter: mockAdapter(['{"next_direction":"approval-direction"}', '{"next_direction":"must-not-run"}']),
        proposeRunOpts: runOpts,
        launchInner: async (direction) => {
          launched.push(direction);
          return 'run-awaiting-approval';
        },
        readBest: () => {
          bestReads++;
          return 99;
        },
        readRunStatus: () => 'parked',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CampaignAwaitingApprovalError);
    expect(caught).toMatchObject({
      runId: 'run-awaiting-approval',
      direction: 'approval-direction',
      status: 'parked',
    });
    expect((caught as Error).message).toContain('awaiting approval');
    expect(launched).toEqual(['approval-direction']);
    expect(bestReads).toBe(0);
  });

  it('refuses an unrecognized inner status instead of fabricating a rejected baseline outcome', async () => {
    let bestReads = 0;
    await expect(runLiveCampaign({
      projectDir: '/tmp/none',
      campaignId: 'c',
      objective: objective({ beat: 15, maxRounds: 3, haltAfterNoImprovement: 3 }),
      proposeRole,
      adapter: mockAdapter(['{"next_direction":"future-status-direction"}']),
      proposeRunOpts: runOpts,
      launchInner: async () => 'run-future-status',
      readBest: () => {
        bestReads += 1;
        return 99;
      },
      readRunStatus: () => 'future_archived_state',
    })).rejects.toThrow(
      /Refusing to score campaign direction 'future-status-direction'.*Unrecognized archived run status "future_archived_state"/,
    );
    expect(bestReads).toBe(0);
  });
});

describe('P3 live-glue — runLiveCampaign (mock adapter + inner launcher)', () => {
  it('explores proposed directions until the policy ceilings, never repeating', async () => {
    const results: Record<string, number> = { d1: 0.5, d2: 0.4, d3: 0.3 };
    const launched: string[] = [];
    const res = await runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 99, maxRounds: 8, haltAfterNoImprovement: 2 }),
      proposeRole, adapter: mockAdapter(['{"next_direction":"d1"}', '{"next_direction":"d2"}', '{"next_direction":"d3"}', '{"next_direction":"d4"}']),
      proposeRunOpts: runOpts,
      launchInner: async (d) => { launched.push(d); return `run-${d}`; },
      readBest: (runId) => results[runId.replace('run-', '')] ?? 0,
    });
    expect(res.decision).toBe('frontier');
    expect(res.outcomes.map((o) => o.direction)).toEqual(['d1', 'd2', 'd3']); // improve, then 2 non-improving → ceiling
    expect(launched).toEqual(['d1', 'd2', 'd3']);
  });

  it('stops at frontier when the planner declares it', async () => {
    const res = await runLiveCampaign({
      projectDir: '/tmp/none', campaignId: 'c', objective: objective({ beat: 99, maxRounds: 50, haltAfterNoImprovement: 50 }),
      proposeRole, adapter: mockAdapter(['{"next_direction":"d1"}', '{"frontier": true, "next_direction": null}']),
      proposeRunOpts: runOpts,
      launchInner: async () => 'run-d1',
      readBest: () => 0.5,
    });
    expect(res.decision).toBe('frontier');
    expect(res.outcomes).toHaveLength(1);
  });
});
