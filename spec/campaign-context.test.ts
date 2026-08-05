import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import {
  CAMPAIGN_CONTEXT_MAX_AGE_MS,
  formatCampaignContextBlock,
  selectRelevantCampaignContext,
} from '../src/campaign-context.js';
import { summarizeLedger } from '../src/campaign-ledger.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import { checkCampaignHealth, loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, RUN_STATUS, setFcGlobalDir } from '../src/store.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CAMPAIGN_ID = 'context-filter-campaign';
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

let sandbox: string;
let projectDir: string;
let fcHome: string;
let originalFcHome: string;

beforeAll(() => {
  originalFcHome = fcGlobalDir();
});

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'flowcrew-campaign-context-'));
  projectDir = join(sandbox, 'project');
  fcHome = join(sandbox, 'fc-home');
  setFcGlobalDir(fcHome);
  mkdirSync(join(projectDir, '.fc', 'campaigns'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'config', 'defaults.yaml'), join(projectDir, 'config', 'defaults.yaml'));
});

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  rmSync(sandbox, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(originalFcHome);
});

function historyEntry(overrides: Partial<CampaignHistoryEntry> = {}): CampaignHistoryEntry {
  return {
    seq: 1,
    runId: 'active-run',
    score: 1,
    metric: 'quality',
    pass: true,
    status: RUN_STATUS.RUNNING,
    timestamp: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function writeCampaignEntries(entries: CampaignHistoryEntry[]): void {
  writeFileSync(
    join(projectDir, '.fc', 'campaigns', `${CAMPAIGN_ID}.jsonl`),
    entries.map((entry) => JSON.stringify({ ...entry, campaignId: CAMPAIGN_ID })).join('\n') + '\n',
    'utf-8',
  );
}

describe('campaign context relevance selector', () => {
  it('keeps the exact 30-day boundary and rejects older or invalid timestamps', () => {
    const atBoundary = new Date(NOW - CAMPAIGN_CONTEXT_MAX_AGE_MS).toISOString();
    const selection = selectRelevantCampaignContext([
      historyEntry({ seq: 1, runId: 'boundary', timestamp: atBoundary }),
      historyEntry({ seq: 2, runId: 'too-old', timestamp: new Date(NOW - CAMPAIGN_CONTEXT_MAX_AGE_MS - 1).toISOString() }),
      historyEntry({ seq: 3, runId: 'invalid-time', timestamp: 'not-a-timestamp' }),
    ], NOW);

    expect(selection.scoredEntries.map((entry) => entry.runId)).toEqual(['boundary']);
  });

  it('drops every narrative row for terminal runs but keeps a fresh parked run', () => {
    const selection = selectRelevantCampaignContext([
      historyEntry({ seq: 1, runId: 'terminal-run', score: 9 }),
      historyEntry({ seq: 2, runId: 'terminal-run', kind: 'task_ended', score: undefined, metric: undefined, status: RUN_STATUS.COMPLETE }),
      historyEntry({ seq: 3, runId: 'parked-run', score: 4, status: RUN_STATUS.PARKED }),
    ], NOW);

    expect(selection.scoredEntries.map((entry) => entry.runId)).toEqual(['parked-run']);
  });

  it('closes completed phase detail and carries only a fresh next-phase handoff', () => {
    const selection = selectRelevantCampaignContext([
      historyEntry({ seq: 1, phase: 'phase-one', reason: 'obsolete reason', artifactSummary: 'obsolete artifact' }),
      historyEntry({
        seq: 2,
        phase: 'phase-one',
        phaseComplete: true,
        nextPhase: 'phase-two',
        reason: 'completion reason must not leak',
        artifactSummary: 'completion artifact must not leak',
      }),
    ], NOW);
    const context = formatCampaignContextBlock({ campaignLabel: CAMPAIGN_ID, selection });

    expect(selection.scoredEntries).toEqual([]);
    expect(context).toContain('Current recommended phase: phase-two');
    expect(context).not.toContain('obsolete reason');
    expect(context).not.toContain('obsolete artifact');
    expect(context).not.toContain('completion reason must not leak');
    expect(context).not.toContain('completion artifact must not leak');

    const closedWithoutHandoff = selectRelevantCampaignContext([
      historyEntry({ phase: 'phase-one', phaseComplete: true, nextPhase: undefined }),
    ], NOW);
    expect(formatCampaignContextBlock({ campaignLabel: CAMPAIGN_ID, selection: closedWithoutHandoff })).toBe('');
  });

  it('does not revive an earlier handoff after the latest completed phase closes the chain', () => {
    const selection = selectRelevantCampaignContext([
      historyEntry({
        seq: 1,
        runId: 'phase-chain-run',
        phase: 'phase-one',
        phaseComplete: true,
        nextPhase: 'phase-two',
      }),
      historyEntry({
        seq: 2,
        runId: 'phase-chain-run',
        phase: 'phase-two',
        phaseComplete: false,
      }),
      historyEntry({
        seq: 3,
        runId: 'phase-chain-run',
        phase: 'phase-two',
        phaseComplete: true,
        nextPhase: undefined,
      }),
    ], NOW);

    expect(selection.recommendedPhase).toBeUndefined();
    expect(selection.phaseEntries).toEqual([]);
    expect(formatCampaignContextBlock({ campaignLabel: CAMPAIGN_ID, selection })).toBe('');
  });

  it('builds a block only from active progress and does not emit stale alert shells', () => {
    const active = selectRelevantCampaignContext([
      historyEntry({ seq: 1, runId: 'r1', score: 5, phase: 'active-phase', phaseComplete: false }),
      historyEntry({ seq: 2, runId: 'r2', score: 5 }),
      historyEntry({ seq: 3, runId: 'r3', score: 5 }),
    ], NOW);
    const alert = checkCampaignHealth(active.entries);
    const context = formatCampaignContextBlock({
      campaignLabel: CAMPAIGN_ID,
      selection: active,
      summaryPaths: ['/tmp/relevant-iteration-log.md'],
      alert,
    });

    expect(alert?.type).toBe('plateau');
    expect(context).toContain('=== CAMPAIGN: context-filter-campaign ===');
    expect(context).toContain('Best ever: 5');
    expect(context).toContain('/tmp/relevant-iteration-log.md');
    expect(context).toContain('CAMPAIGN ALERT: plateau');

    const stale = selectRelevantCampaignContext([
      historyEntry({ seq: 1, timestamp: new Date(NOW - CAMPAIGN_CONTEXT_MAX_AGE_MS - 1).toISOString() }),
      historyEntry({ seq: 2, timestamp: new Date(NOW - CAMPAIGN_CONTEXT_MAX_AGE_MS - 2).toISOString() }),
      historyEntry({ seq: 3, timestamp: new Date(NOW - CAMPAIGN_CONTEXT_MAX_AGE_MS - 3).toISOString() }),
    ], NOW);
    expect(checkCampaignHealth(stale.entries)).toBeNull();
    expect(formatCampaignContextBlock({ campaignLabel: CAMPAIGN_ID, selection: stale })).toBe('');
  });
});

describe('campaign context production path', () => {
  it('keeps every dead end even when the tried-direction display is capped', () => {
    const runId = 'ledger-run';
    writeCampaignEntries([
      historyEntry({ runId, status: RUN_STATUS.COMPLETE }),
    ]);
    const runPath = join(fcHome, 'runs', runId);
    mkdirSync(runPath, { recursive: true });
    writeFileSync(join(runPath, 'research_journal.json'), JSON.stringify({
      rounds: [
        { label: 'first direction', result: 1 },
        { label: 'second direction', result: 2 },
      ],
    }), 'utf-8');
    writeFileSync(join(runPath, 'knowledge_graph.json'), JSON.stringify({
      nodes: [
        { type: 'dead_end', text: 'dead end alpha' },
        { type: 'dead_end', text: 'dead end beta' },
        { type: 'dead_end', text: 'dead end gamma' },
      ],
    }), 'utf-8');

    const digest = summarizeLedger(projectDir, CAMPAIGN_ID, { cap: 1 });

    expect(digest).toContain('first direction');
    expect(digest).not.toContain('second direction');
    expect(digest).toContain('dead end alpha');
    expect(digest).toContain('dead end beta');
    expect(digest).toContain('dead end gamma');
  });

  it('does not mislead a new task with a terminal phase, while preserving its dead ends', async () => {
    const oldRunId = 'old-terminal-run';
    const oldRunPath = join(fcHome, 'runs', oldRunId);
    mkdirSync(oldRunPath, { recursive: true });
    writeFileSync(join(oldRunPath, 'run.json'), JSON.stringify({
      runId: oldRunId,
      projectDir,
      workflowName: 'old-workflow',
      status: RUN_STATUS.PHASE_COMPLETE,
      stages: {},
      startedAt: '2000-01-01T00:00:00.000Z',
      completedAt: '2000-01-01T00:00:01.000Z',
      campaignId: CAMPAIGN_ID,
      campaignStorageKey: CAMPAIGN_ID,
    }), 'utf-8');
    writeFileSync(join(oldRunPath, 'iteration_log.md'), 'OLD ITERATION PATH CONTENT', 'utf-8');
    writeFileSync(join(oldRunPath, 'knowledge_graph.json'), JSON.stringify({
      nodes: [
        { type: 'dead_end', text: 'never retry the terminal dead-end mechanism' },
        { type: 'dead_end', text: 'preserve this second dead end too' },
      ],
    }), 'utf-8');
    writeCampaignEntries([
      historyEntry({
        seq: 1,
        runId: oldRunId,
        score: 99,
        metric: 'OLD_METRIC',
        status: RUN_STATUS.PHASE_COMPLETE,
        timestamp: '2000-01-01T00:00:01.000Z',
        phase: 'old-finished-phase',
        phaseComplete: true,
        nextPhase: 'old-misleading-next-phase',
        reason: 'OLD REASON MUST DISAPPEAR',
        artifactSummary: 'OLD ARTIFACT MUST DISAPPEAR',
      }),
    ]);

    writeFileSync(join(projectDir, 'config', 'agents', 'planner.yaml'), [
      'name: planner',
      'description: Planner fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: |',
      '  Durable ledger:',
      '  {ledger_digest}',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), [
      'name: coder',
      'description: Coder fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: coder fixture',
    ].join('\n') + '\n', 'utf-8');
    const workflowPath = join(projectDir, 'config', 'workflows', 'context.yaml');
    writeFileSync(workflowPath, [
      'name: context-scenario',
      'defaults:',
      '  timeout_ms: 5000',
      '  max_retries: 0',
      '  max_iterations: 1',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
    ].join('\n') + '\n', 'utf-8');

    const adapter = new PromptCaptureAdapter();
    const { config, raw } = loadWorkflow(workflowPath);
    const finalState = await runWorkflow(
      config,
      raw,
      projectDir,
      adapter,
      new Map(),
      undefined,
      join(projectDir, 'config', 'agents'),
      undefined,
      'Plan a genuinely new task.',
      true,
      false,
      CAMPAIGN_ID,
      true,
    );

    expect(finalState.status).toBe(RUN_STATUS.COMPLETE);
    const planCall = adapter.calls.find((call) => call.stageId === 'plan');
    expect(planCall).toBeDefined();
    const fullPrompt = `${planCall!.systemPrompt}\n${planCall!.prompt}`;
    expect(fullPrompt).not.toContain('=== CAMPAIGN:');
    expect(fullPrompt).not.toContain('OLD_METRIC');
    expect(fullPrompt).not.toContain('Best ever: 99');
    expect(fullPrompt).not.toContain('OLD REASON MUST DISAPPEAR');
    expect(fullPrompt).not.toContain('OLD ARTIFACT MUST DISAPPEAR');
    expect(fullPrompt).not.toContain(join(oldRunPath, 'iteration_log.md'));
    expect(fullPrompt).not.toContain('old-misleading-next-phase');
    expect(planCall!.systemPrompt).toContain('never retry the terminal dead-end mechanism');
    expect(planCall!.systemPrompt).toContain('preserve this second dead end too');
  });
});

class PromptCaptureAdapter implements Adapter {
  readonly calls: Array<{ stageId: string; prompt: string; systemPrompt: string }> = [];

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    this.calls.push({ stageId: opts.stageId, prompt, systemPrompt: role.prompt });
    if (opts.stageId === 'plan') {
      writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
        '- id: implement',
        '  role: coder',
        '  depends_on: [plan]',
        '  prompt_template: Perform the fresh implementation.',
      ].join('\n') + '\n', 'utf-8');
    }
    return { output: 'ok', exitCode: 0, duration_ms: 1 };
  }
}
