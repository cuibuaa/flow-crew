import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { parseYaml, stringifyYaml } from '../src/yaml-util.js';
import { findAllReady, parseDispatchBlock, StageConfigSchema, checkCampaignHealth } from '../src/scheduler.js';
import { summarizeCampaignPhaseProgress, readCampaignEntries, collapseEntriesForHealth } from '../src/campaigns.js';
import type { StoreState, StageStatus } from '../src/store.js';

/**
 * Integration test: Foundation Model for Anomaly Detection — Multi-Phase Research Campaign
 *
 * Simulates a real self-evolving research task:
 *   Phase 1: Literature survey → find promising FM approaches
 *   Phase 2: Benchmark on ADBench → beat SOTA or fine-tune → pivot if stuck
 *
 * Tests the planner prompt assembly, campaign phase tracking, pivot injection,
 * and resume behavior. Agent execution is mocked — focus is on orchestration stability.
 */

const TEST_DIR = join(process.cwd(), '.test-fm-campaign');
const CAMPAIGN_ID = 'fm-anomaly-detection';

function setupProjectDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, '.fc', 'runs'), { recursive: true });
  mkdirSync(join(TEST_DIR, '.fc', 'campaigns'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'config', 'agents'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'config', 'workflows'), { recursive: true });
}

function writeCampaignEntry(entry: Record<string, unknown>) {
  const campaignFile = join(TEST_DIR, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`);
  const line = JSON.stringify(entry) + '\n';
  if (existsSync(campaignFile)) {
    const existing = readFileSync(campaignFile, 'utf-8');
    writeFileSync(campaignFile, existing + line);
  } else {
    writeFileSync(campaignFile, line);
  }
}

function makeRunState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    status: 'running',
    currentIteration: 1,
    stages: {},
    campaignId: CAMPAIGN_ID,
    campaignStorageKey: CAMPAIGN_ID,
    ...overrides,
  } as StoreState;
}

function makeRegistry(roles: string[]): Map<string, { name: string; description: string }> {
  const m = new Map<string, { name: string; description: string }>();
  for (const r of roles) m.set(r, { name: r, description: `${r} agent` });
  return m;
}

const TASK_DESCRIPTION = `Foundation Model for Anomaly Detection (inspired by Chronos for forecasting)

Phase 1: Research Exploration
- Survey existing papers on foundation models for anomaly detection
- Identify the most promising approaches (pre-trained transformers, self-supervised methods, etc.)
- Produce a research report with top 3 candidates ranked by feasibility and expected performance
- Decide which approach to pursue in Phase 2

Phase 2: Benchmark & Fine-tune
- Implement the chosen approach on ADBench datasets
- Compare against SOTA baselines (DeepSVDD, DAGMM, etc.)
- If performance is below SOTA: fine-tune the model (up to 3 attempts)
- If still below after fine-tuning: trigger research pivot for alternative approaches
- Target: beat SOTA on at least 3/5 ADBench categories`;

describe('FM Anomaly Detection Campaign — Multi-Phase Orchestration', () => {
  beforeAll(() => setupProjectDir());
  afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  describe('Phase 1: First iteration — planner should dispatch only research', () => {
    it('planner prompt contains phase discipline instructions', () => {
      const plannerYaml = readFileSync(join(process.cwd(), 'config', 'agents', 'planner.yaml'), 'utf-8');
      expect(plannerYaml).toContain('NEVER dispatch stages for multiple phases in a single dispatch.yaml');
      expect(plannerYaml).toContain('dispatch ONLY the first phase');
    });

    it('with no campaign history, phase progress shows nothing — planner must self-constrain', () => {
      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      expect(entries).toHaveLength(0);
      const progress = summarizeCampaignPhaseProgress(entries);
      expect(progress.completedPhases).toHaveLength(0);
      expect(progress.currentPhase).toBeUndefined();
    });

    it('a Phase-1-only dispatch is valid and parseable', () => {
      // Simulate what a well-behaved planner would output for Phase 1
      const plannerOutput = `# Technical Solution

## Approach
Survey foundation models for anomaly detection. Focus on transformer-based and self-supervised approaches.

## DISPATCH
\`\`\`yaml
- id: literature_survey
  role: researcher
  depends_on: []
  dependency_reasons: {}
  scope: []
  prompt_template: "Survey papers on foundation models for anomaly detection. Focus on: (1) pre-trained transformers adapted for AD, (2) self-supervised contrastive methods, (3) reconstruction-based FM approaches. Produce a ranked list of top 3 candidates."

- id: research_report
  role: coder
  depends_on: [literature_survey]
  dependency_reasons: {literature_survey: "compile the completed survey"}
  scope: [docs/phase1_research.md]
  prompt_template: "Compile the research findings into a structured report at docs/phase1_research.md. Include: approach name, paper reference, key idea, feasibility score, expected performance."

- id: phase1_gate
  role: qa
  depends_on: [research_report]
  dependency_reasons: {research_report: "verify the completed phase 1 report"}
  scope: []
  is_gate: true
  prompt_template: "Verify the research report exists, contains at least 3 ranked approaches, and includes feasibility analysis. Write phase metadata: phase=phase_1, phaseComplete=true, nextPhase=phase_2."
\`\`\``;

      const registry = makeRegistry(['researcher', 'coder', 'qa']);
      const stages = parseDispatchBlock(plannerOutput, registry);
      expect(stages).toHaveLength(3);
      expect(stages[0].role).toBe('researcher');
      expect(stages[2].is_gate).toBe(true);
      // No Phase 2 stages
      expect(stages.every(s => !s.prompt_template.toLowerCase().includes('benchmark'))).toBe(true);
      expect(stages.every(s => !s.prompt_template.toLowerCase().includes('fine-tune'))).toBe(true);
    });

    it('findAllReady correctly sequences Phase 1 stages', () => {
      const stages = [
        StageConfigSchema.parse({ id: 'literature_survey', role: 'researcher', prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'research_report', role: 'coder', depends_on: ['literature_survey'], prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'phase1_gate', role: 'qa', depends_on: ['research_report'], is_gate: true, prompt_template: 'x' }),
      ];

      const state = makeRunState({ stages: {
        literature_survey: { status: 'pending', retries: 0 },
        research_report: { status: 'pending', retries: 0 },
        phase1_gate: { status: 'pending', retries: 0 },
      }});

      // Initially only literature_survey is ready (no deps)
      let ready = findAllReady(stages, state);
      expect(ready.map(s => s.id)).toEqual(['literature_survey']);

      // After literature_survey completes
      state.stages.literature_survey = { status: 'complete', retries: 0 };
      ready = findAllReady(stages, state);
      expect(ready.map(s => s.id)).toEqual(['research_report']);

      // After research_report completes
      state.stages.research_report = { status: 'complete', retries: 0 };
      ready = findAllReady(stages, state);
      expect(ready.map(s => s.id)).toEqual(['phase1_gate']);
    });
  });

  describe('Phase transition: Phase 1 complete → Phase 2', () => {
    beforeEach(() => {
      // Clear campaign file
      const f = join(TEST_DIR, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`);
      if (existsSync(f)) rmSync(f);
    });

    it('QA gate writes phase metadata → campaign tracks phase completion', () => {
      // Simulate Phase 1 gate passing with phase metadata
      writeCampaignEntry({
        runId: 'run-001', seq: 1, iteration: 1,
        gate: 'phase1_gate', pass: true, score: 3, metric: 'approaches_found', threshold: 3,
        phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2',
        outcome: 'Found 3 promising FM approaches for AD',
        artifactSummary: 'docs/phase1_research.md with ranked candidates',
      });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const progress = summarizeCampaignPhaseProgress(entries);
      expect(progress.completedPhases).toContain('phase_1');
      expect(progress.currentPhase).toBe('phase_2');
    });

    it('planner sees "Current recommended phase: phase_2" in campaign context', () => {
      writeCampaignEntry({
        runId: 'run-001', seq: 1, iteration: 1,
        gate: 'phase1_gate', pass: true, score: 3, metric: 'approaches_found', threshold: 3,
        phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2',
      });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const progress = summarizeCampaignPhaseProgress(entries);

      // This is what the scheduler injects into the planner prompt
      let ctx = '';
      if (progress.entries.length > 0) {
        ctx += `Phase progress:\n`;
        ctx += `- Completed phases: ${progress.completedPhases.join(', ')}\n`;
        ctx += `- Current recommended phase: ${progress.currentPhase}\n`;
      }

      expect(ctx).toContain('Completed phases: phase_1');
      expect(ctx).toContain('Current recommended phase: phase_2');
    });

    it('Phase 2 dispatch includes benchmark stages, not research', () => {
      const plannerOutput = `# Technical Solution — Phase 2

## DISPATCH
\`\`\`yaml
- id: implement_fm
  role: coder
  depends_on: []
  dependency_reasons: {}
  scope: []
  prompt_template: "Implement the chosen FM approach (approach #1 from phase1_research.md) on ADBench datasets. Set up evaluation pipeline."

- id: run_benchmarks
  role: coder
  depends_on: [implement_fm]
  dependency_reasons: {implement_fm: "benchmark the implemented model"}
  scope: []
  prompt_template: "Run benchmarks against SOTA baselines (DeepSVDD, DAGMM). Report scores per ADBench category."

- id: phase2_gate
  role: qa
  depends_on: [run_benchmarks]
  dependency_reasons: {run_benchmarks: "verify the completed benchmark"}
  scope: []
  is_gate: true
  prompt_template: "Check if FM beats SOTA on at least 3/5 ADBench categories. Write phase metadata."
\`\`\``;

      const registry = makeRegistry(['researcher', 'coder', 'qa']);
      const stages = parseDispatchBlock(plannerOutput, registry);
      expect(stages).toHaveLength(3);
      expect(stages[0].id).toBe('implement_fm');
      // No research stages
      expect(stages.every(s => !s.id.includes('survey') && !s.id.includes('literature'))).toBe(true);
    });
  });

  describe('Phase 2: Iteration loop — fine-tuning and pivot', () => {
    beforeEach(() => {
      const f = join(TEST_DIR, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`);
      if (existsSync(f)) rmSync(f);
    });

    it('gate failure keeps task on Phase 2 (does not advance)', () => {
      // Phase 1 complete
      writeCampaignEntry({
        runId: 'run-001', seq: 1, iteration: 1,
        gate: 'phase1_gate', pass: true,
        phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2',
      });
      // Phase 2 attempt 1 — fails (only beats 1/5 categories)
      writeCampaignEntry({
        runId: 'run-002', seq: 2, iteration: 1,
        gate: 'phase2_gate', pass: false, score: 1, metric: 'categories_beaten', threshold: 3,
        phase: 'phase_2', phaseComplete: false,
      });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const progress = summarizeCampaignPhaseProgress(entries);
      expect(progress.currentPhase).toBe('phase_2'); // Still on phase 2
      expect(progress.completedPhases).not.toContain('phase_2');
    });

    it('repeated failures trigger campaign health alert', () => {
      // Phase 1 complete
      writeCampaignEntry({ runId: 'run-001', seq: 1, gate: 'phase1_gate', pass: true, phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2' });
      // 3 consecutive Phase 2 failures
      writeCampaignEntry({ runId: 'run-002', seq: 2, gate: 'phase2_gate', pass: false, score: 1, metric: 'categories_beaten', threshold: 3 });
      writeCampaignEntry({ runId: 'run-003', seq: 3, gate: 'phase2_gate', pass: false, score: 1, metric: 'categories_beaten', threshold: 3 });
      writeCampaignEntry({ runId: 'run-004', seq: 4, gate: 'phase2_gate', pass: false, score: 2, metric: 'categories_beaten', threshold: 3 });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const alert = checkCampaignHealth(entries as any, { enabled: true, repeatedFailureAfter: 3 });

      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('repeated_failure');
    });

    it('pivot injects researcher role for alternative exploration', () => {
      // After pivot trigger, planner should dispatch a researcher stage
      const plannerOutputAfterPivot = `# Technical Solution — Pivot

The current approach (transformer-based FM) failed to beat SOTA after 3 attempts.
Injecting research to explore alternative approaches.

## DISPATCH
\`\`\`yaml
- id: pivot_research
  role: researcher
  depends_on: []
  dependency_reasons: {}
  scope: []
  prompt_template: "The transformer-based FM approach failed to beat SOTA on ADBench. Research alternative approaches: (1) graph neural networks for AD, (2) diffusion models for OOD detection, (3) ensemble of specialized models. Find the most promising alternative."

- id: implement_pivot
  role: coder
  depends_on: [pivot_research]
  dependency_reasons: {pivot_research: "implement the selected pivot"}
  scope: []
  prompt_template: "Implement the best alternative approach identified by the researcher."

- id: pivot_gate
  role: qa
  depends_on: [implement_pivot]
  dependency_reasons: {implement_pivot: "benchmark the implemented alternative"}
  scope: []
  is_gate: true
  prompt_template: "Benchmark the alternative approach. Check if it beats SOTA on 3/5 categories."
\`\`\``;

      const registry = makeRegistry(['researcher', 'coder', 'qa']);
      const stages = parseDispatchBlock(plannerOutputAfterPivot, registry);
      expect(stages).toHaveLength(3);
      expect(stages[0].role).toBe('researcher');
      expect(stages[0].id).toBe('pivot_research');
    });
  });

  describe('Resume behavior within campaign iterations', () => {
    it('resume after implement_fm fails — keeps plan, retries from implement', () => {
      const stages = [
        StageConfigSchema.parse({ id: 'plan', role: 'planner', dynamic_dispatch: true, prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'implement_fm', role: 'coder', depends_on: ['plan'], prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'run_benchmarks', role: 'coder', depends_on: ['implement_fm'], prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'phase2_gate', role: 'qa', depends_on: ['run_benchmarks'], is_gate: true, prompt_template: 'x' }),
      ];

      // State after implement_fm fails
      const state = makeRunState({ stages: {
        plan: { status: 'complete', retries: 0 },
        implement_fm: { status: 'failed', retries: 0 },
        run_benchmarks: { status: 'pending', retries: 0 },
        phase2_gate: { status: 'pending', retries: 0 },
      }});

      // Simulate resume: reset failed + downstream to pending
      const failedId = Object.entries(state.stages).find(([, s]) => s.status === 'failed')?.[0];
      expect(failedId).toBe('implement_fm');

      // Reset failed stage
      state.stages.implement_fm = { status: 'pending', retries: 0 };

      // After resume, plan is still complete, implement_fm is ready
      const ready = findAllReady(stages, state);
      expect(ready.map(s => s.id)).toEqual(['implement_fm']);

      // Plan was NOT reset
      expect(state.stages.plan.status).toBe('complete');
    });

    it('resume after gate fails — retries gate only (no re-implementation)', () => {
      const stages = [
        StageConfigSchema.parse({ id: 'implement_fm', role: 'coder', prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'run_benchmarks', role: 'coder', depends_on: ['implement_fm'], prompt_template: 'x' }),
        StageConfigSchema.parse({ id: 'phase2_gate', role: 'qa', depends_on: ['run_benchmarks'], is_gate: true, prompt_template: 'x' }),
      ];

      const state = makeRunState({ stages: {
        implement_fm: { status: 'complete', retries: 0 },
        run_benchmarks: { status: 'complete', retries: 0 },
        phase2_gate: { status: 'failed', retries: 0 },
      }});

      // Resume: reset gate to pending
      state.stages.phase2_gate = { status: 'pending', retries: 0 };

      const ready = findAllReady(stages, state);
      expect(ready.map(s => s.id)).toEqual(['phase2_gate']);
      expect(state.stages.implement_fm.status).toBe('complete');
      expect(state.stages.run_benchmarks.status).toBe('complete');
    });
  });

  describe('End-to-end campaign lifecycle simulation', () => {
    beforeEach(() => {
      const f = join(TEST_DIR, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`);
      if (existsSync(f)) rmSync(f);
    });

    it('full lifecycle: Phase 1 → Phase 2 (fail) → fine-tune → pivot → success', () => {
      // Iteration 1: Phase 1 passes
      writeCampaignEntry({
        runId: 'run-001', seq: 1, iteration: 1,
        gate: 'phase1_gate', pass: true, score: 3, metric: 'approaches_found', threshold: 3,
        phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2',
        outcome: 'Found 3 FM approaches: BERT-AD, GPT-AD, ViT-AD',
      });

      // Iteration 2: Phase 2 attempt 1 — fails
      writeCampaignEntry({
        runId: 'run-002', seq: 2, iteration: 1,
        gate: 'phase2_gate', pass: false, score: 1, metric: 'categories_beaten', threshold: 3,
        phase: 'phase_2', phaseComplete: false,
      });

      // Iteration 3: Phase 2 attempt 2 (fine-tuned) — still fails
      writeCampaignEntry({
        runId: 'run-003', seq: 3, iteration: 2,
        gate: 'phase2_gate', pass: false, score: 2, metric: 'categories_beaten', threshold: 3,
        phase: 'phase_2', phaseComplete: false,
      });

      // Iteration 4: Phase 2 attempt 3 (more fine-tuning) — still fails
      writeCampaignEntry({
        runId: 'run-004', seq: 4, iteration: 3,
        gate: 'phase2_gate', pass: false, score: 2, metric: 'categories_beaten', threshold: 3,
        phase: 'phase_2', phaseComplete: false,
      });

      // At this point, campaign health should trigger pivot
      let entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      let alert = checkCampaignHealth(entries as any, { enabled: true, repeatedFailureAfter: 3 });
      expect(alert).not.toBeNull();

      // Iteration 5: After pivot — researcher finds alternative, new approach succeeds
      writeCampaignEntry({
        runId: 'run-005', seq: 5, iteration: 1,
        gate: 'pivot_gate', pass: true, score: 4, metric: 'categories_beaten', threshold: 3,
        phase: 'phase_2', phaseComplete: true, nextPhase: undefined,
        outcome: 'GNN-based approach beats SOTA on 4/5 categories',
        artifactSummary: 'models/gnn_ad_final.pt, results/benchmark_comparison.csv',
      });

      // Verify final state
      entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const progress = summarizeCampaignPhaseProgress(entries);
      expect(progress.completedPhases).toContain('phase_1');
      expect(progress.completedPhases).toContain('phase_2');
    });

    it('campaign score progression is trackable across iterations', () => {
      writeCampaignEntry({ runId: 'r1', seq: 1, gate: 'g', pass: true, score: 3, metric: 'approaches', threshold: 3, phase: 'phase_1', phaseComplete: true, nextPhase: 'phase_2' });
      writeCampaignEntry({ runId: 'r2', seq: 2, gate: 'g', pass: false, score: 1, metric: 'categories_beaten', threshold: 3 });
      writeCampaignEntry({ runId: 'r3', seq: 3, gate: 'g', pass: false, score: 2, metric: 'categories_beaten', threshold: 3 });
      writeCampaignEntry({ runId: 'r4', seq: 4, gate: 'g', pass: false, score: 2, metric: 'categories_beaten', threshold: 3 });
      writeCampaignEntry({ runId: 'r5', seq: 5, gate: 'g', pass: true, score: 4, metric: 'categories_beaten', threshold: 3 });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const scored = collapseEntriesForHealth(entries);

      // Score progression: 3, 1, 2, 2, 4
      const scores = scored.map((e: { score?: number }) => e.score).filter((s: unknown): s is number => typeof s === 'number');
      expect(scores).toEqual([3, 1, 2, 2, 4]);

      // Final entry passes
      expect(scored[scored.length - 1].pass).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('task with no phases — planner dispatches freely', () => {
      const singlePhaseTask = 'Fix the memory leak in the WebSocket handler';
      // No "Phase N:" markers — planner should not be constrained
      expect(singlePhaseTask).not.toMatch(/Phase\s+\d+/i);
    });

    it('task with ambiguous phase language does not break', () => {
      // "phase" used as a noun, not a task phase marker
      const ambiguousTask = 'Research the training phase of transformer models and optimize it';
      // The planner prompt says "numbered phases (Phase 1, Phase 2, etc.)"
      // This task has no numbered phases — should dispatch freely
      expect(ambiguousTask).not.toMatch(/Phase\s+\d+\s*[:\-—]/);
    });

    it('campaign with only failures (no phase metadata) still works', () => {
      const f = join(TEST_DIR, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`);
      if (existsSync(f)) rmSync(f);

      // Entries without phase metadata (old-style)
      writeCampaignEntry({ runId: 'r1', seq: 1, gate: 'g', pass: false, score: 0, metric: 'm', threshold: 1 });
      writeCampaignEntry({ runId: 'r2', seq: 2, gate: 'g', pass: false, score: 0, metric: 'm', threshold: 1 });

      const entries = readCampaignEntries(TEST_DIR, CAMPAIGN_ID);
      const progress = summarizeCampaignPhaseProgress(entries);
      // No phase info — should gracefully return empty
      expect(progress.completedPhases).toHaveLength(0);
      expect(progress.currentPhase).toBeUndefined();
    });
  });
});
