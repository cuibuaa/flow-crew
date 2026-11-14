import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { fixtureResult, declaredDispatch } from './test-support/declared-dispatch.js';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import { loadWorkflow } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
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

describe('campaign context production path', () => {
  it('keeps campaign history and stray knowledge graphs out of planner input', async () => {
    const oldRunId = 'old-terminal-run';
    const oldRunPath = join(fcHome, 'runs', oldRunId);
    mkdirSync(oldRunPath, { recursive: true });
    writeFileSync(runRecordPath(oldRunPath, 'run.json'), JSON.stringify({
      runId: oldRunId,
      projectDir,
      workflowName: 'old-workflow',
      status: RUN_STATUS.INCOMPLETE,
      stages: {},
      startedAt: '2000-01-01T00:00:00.000Z',
      completedAt: '2000-01-01T00:00:01.000Z',
      campaignId: CAMPAIGN_ID,
      campaignStorageKey: CAMPAIGN_ID,
    }), 'utf-8');
    writeFileSync(runRecordPath(oldRunPath, 'iteration_log.md'), 'OLD ITERATION PATH CONTENT', 'utf-8');
    writeFileSync(runRecordPath(oldRunPath, 'research_journal.json'), JSON.stringify({
      rounds: [
        { label: 'never retry the terminal mechanism', result: 1 },
        { label: 'preserve this second direction too', result: 2 },
      ],
    }), 'utf-8');
    writeFileSync(runRecordPath(oldRunPath, 'knowledge_graph.json'), JSON.stringify({ nodes: [{text: 'dead end alpha'}] }));
    writeCampaignEntries([
      historyEntry({
        seq: 1,
        runId: oldRunId,
        score: 99,
        metric: 'OLD_METRIC',
        status: RUN_STATUS.INCOMPLETE,
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
      '  Plan from the admitted task and inputs.',
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
      '  max_retries: 0',
      '  max_iterations: 1',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
      '    artifact_contract: {version: 1, produces: [{id: dispatch, root: run, path: dispatch.yaml}], reads: []}',
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
      CAMPAIGN_ID,
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
    expect(fullPrompt).not.toContain(runRecordPath(oldRunPath, 'iteration_log.md'));
    expect(fullPrompt).not.toContain('old-misleading-next-phase');
    expect(fullPrompt).not.toContain('never retry the terminal mechanism');
    expect(fullPrompt).not.toContain('preserve this second direction too');
    expect(fullPrompt).not.toContain('dead end alpha');
  });
});

class PromptCaptureAdapter implements Adapter {
  readonly calls: Array<{ stageId: string; prompt: string; systemPrompt: string }> = [];

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    this.calls.push({ stageId: opts.stageId, prompt, systemPrompt: role.prompt });
    if (opts.stageId === 'plan') {
      writeFileSync(stageWorkPath(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
        '- id: implement',
        '  role: coder',
        '  depends_on: [plan]',
        '  dependency_reasons: {plan: "perform the newly planned implementation"}',
        '  scope: []',
        '  prompt_template: Perform the fresh implementation.',
      ].join('\n') + '\n', { implement: emptyArtifactContract() }), 'utf-8');
    }
    return fixtureResult({ output: 'ok', exitCode: 0, duration_ms: 1 }, opts);
  }
}
