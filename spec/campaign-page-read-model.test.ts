import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveCampaignRunTitle,
  deriveRunTokenCost,
  deriveRunWallClock,
  readCampaignOperatorView,
  readCampaignRunPage,
  type CampaignInboxOverviewLike,
  type CampaignPageSources,
} from '../src/campaign-page.js';
import { campaignsRoot, RUN_STATUS, runsRoot, STAGE_STATUS, type StoreState } from '../src/store.js';
import type { CampaignHistoryEntry, CampaignSummaryRecord } from '../src/campaigns.js';
import type { RunIndexRecord } from '../src/run-index.js';
import type { TaskEntry } from '../src/task-registry.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
let fixtureNumber = 0;
let campaignId = '';
let projectDir = '';
let createdRunDirs: string[] = [];
let createdCampaignDirs: string[] = [];

const RESEARCH_WORKFLOW = [
  'name: fixture-research',
  'stages:',
  '  - id: plan',
  '    role: planner',
  '  - id: implement',
  '    role: coder',
  '    is_gate: true',
].join('\n');

function emptyInbox(): CampaignInboxOverviewLike {
  return {
    approvals: { status: 'complete', items: [] },
    deferred: { status: 'complete', items: [] },
    stale: { status: 'complete', items: [] },
    patches: { status: 'complete', items: [], coverage: { succeeded: 1, failed: 0 } },
  };
}

function runState(id: string, extra: Partial<StoreState> = {}): StoreState {
  return {
    runId: id,
    workflowName: 'fixture-workflow',
    projectDir,
    status: RUN_STATUS.COMPLETE,
    stages: {
      plan: { status: STAGE_STATUS.COMPLETE, retries: 0, tokens_in: 0, tokens_out: 0 },
      implement: { status: STAGE_STATUS.COMPLETE, retries: 0, tokens_in: 10, tokens_out: 5 },
    },
    startedAt: '2026-08-02T10:00:00.000Z',
    completedAt: '2026-08-02T11:00:00.000Z',
    taskDescription: '# TASK — 性能 E6: supervisor 开销与并行化',
    campaignId,
    campaignStorageKey: campaignId,
    campaignName: 'Campaign fixture',
    supervise: false,
    ...extra,
  };
}

function writeEvidence(
  state: StoreState,
  options: {
    workflow?: string;
    journal?: unknown;
    summary?: string;
    metric?: { stage?: string; metric: string; value: number; higherIsBetter?: boolean };
    confirm?: unknown;
  } = {},
) {
  const dir = join(runsRoot(), state.runId);
  createdRunDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const workflow = options.workflow ?? [
    'name: fixture-workflow',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '  - id: implement',
    '    role: coder',
  ].join('\n');
  writeFileSync(join(dir, 'workflow.yaml'), `${workflow}\n`, 'utf-8');
  if (options.journal !== undefined) writeFileSync(join(dir, 'research_journal.json'), JSON.stringify(options.journal), 'utf-8');
  if (options.summary !== undefined) writeFileSync(join(dir, 'summary.md'), options.summary, 'utf-8');
  if (options.confirm !== undefined) writeFileSync(join(dir, 'research_confirm.json'), JSON.stringify(options.confirm), 'utf-8');
  if (options.metric) {
    const stage = options.metric.stage ?? 'implement';
    mkdirSync(join(dir, 'stages', stage), { recursive: true });
    writeFileSync(join(dir, 'stages', stage, 'metric.json'), JSON.stringify({
      hasMetric: true,
      metric: options.metric.metric,
      value: options.metric.value,
      higherIsBetter: options.metric.higherIsBetter,
    }), 'utf-8');
  }
}

function pageSources(
  states: StoreState[],
  options: {
    entries?: CampaignHistoryEntry[];
    inbox?: CampaignInboxOverviewLike;
    tasks?: TaskEntry[];
    inboxError?: Error;
    tasksError?: Error;
    live?: Record<string, boolean | null>;
  } = {},
): Partial<CampaignPageSources> {
  const summary: CampaignSummaryRecord = {
    id: campaignId,
    name: 'Campaign fixture',
    storageKey: campaignId,
    runCount: states.length,
    bestScore: null,
    latestRun: states.at(-1)?.runId,
    latestTimestamp: states.at(-1)?.startedAt,
  };
  const records: RunIndexRecord[] = states.map((state) => ({
    runId: state.runId,
    status: state.status,
    workflowName: state.workflowName,
    taskDescription: state.taskDescription,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    campaignId,
    campaignStorageKey: campaignId,
    campaignName: state.campaignName,
  }));
  const byId = new Map(states.map((state) => [state.runId, state]));
  return {
    listCampaigns: () => [summary],
    listRunRecords: () => records,
    listRunRecordsByCampaign: () => records,
    readRunState: (_dir, runId) => {
      const state = byId.get(runId);
      if (!state) throw new Error(`missing fixture ${runId}`);
      return state;
    },
    readCampaignEntries: () => options.entries ?? [],
    readInbox: () => options.inboxError ? Promise.reject(options.inboxError) : Promise.resolve(options.inbox ?? emptyInbox()),
    readTasks: () => options.tasksError ? Promise.reject(options.tasksError) : Promise.resolve(options.tasks ?? []),
    hasLiveWorker: (_dir, runId) => options.live?.[runId] ?? true,
    now: () => NOW,
  };
}

beforeEach(() => {
  fixtureNumber += 1;
  campaignId = `campaign-page-fixture-${fixtureNumber}`;
  projectDir = join(runsRoot(), 'fixture-project');
  createdRunDirs = [];
  createdCampaignDirs = [];
});

afterEach(() => {
  for (const dir of createdRunDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of createdCampaignDirs) rmSync(dir, { recursive: true, force: true });
});

describe('campaign page evidence classifier', () => {
  it('keeps a bare engineering benchmark engineering and does not create a research trend', async () => {
    const state = runState('engineering-benchmark');
    writeEvidence(state, { metric: { metric: 'latency_ms', value: 42 } });
    const entries: CampaignHistoryEntry[] = [{
      seq: 1,
      runId: state.runId,
      iteration: 1,
      score: 42,
      metric: 'latency_ms',
      pass: false,
      status: RUN_STATUS.COMPLETE,
      timestamp: state.completedAt!,
    }];
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state], { entries }));

    expect(view.identity.classification).toMatchObject({ kind: 'engineering', research: 'absent', engineering: 'present' });
    expect(view.research.value).toBeNull();
  });

  it('keeps accepted research with a generic workflow DAG research-only', async () => {
    const state = runState('research-generic-dag', {
      status: RUN_STATUS.SHIPPED,
      research: { baseline: 1, policy: 'greedy_stack', higherIsBetter: true },
    });
    writeEvidence(state, {
      workflow: RESEARCH_WORKFLOW,
      journal: { rounds: [{ label: 'candidate-a', result: 2 }] },
      metric: { metric: 'quality_pct', value: 2, higherIsBetter: true },
    });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state]));

    expect(view.identity.classification).toMatchObject({ kind: 'research', research: 'present', engineering: 'absent' });
    expect(view.research.value?.selected?.hasTrend).toBe(false);
  });

  it('classifies independent accepted research plus engineering delivery as mixed', async () => {
    const research = runState('mixed-research', {
      status: RUN_STATUS.SHIPPED,
      research: { baseline: 1, policy: 'greedy_stack' },
    });
    const engineering = runState('mixed-engineering');
    writeEvidence(research, {
      workflow: RESEARCH_WORKFLOW,
      journal: { rounds: [{ label: 'a', result: 2 }] },
      metric: { metric: 'quality', value: 2 },
    });
    writeEvidence(engineering, { summary: '## What was done\n- delivered the independent adapter\n\n## Files changed\n- `src/adapter.ts`' });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([research, engineering]));

    expect(view.identity.classification).toMatchObject({ kind: 'mixed', acceptedPointCount: 1, engineeringRunCount: 1 });
    expect(view.research.value).not.toBeNull();
    expect(view.engineering.value?.latest?.runId).toBe(engineering.runId);
  });

  it('reports unknown instead of guessing when neither evidence shape exists', async () => {
    const state = runState('unknown-shape', { stages: { plan: { status: STAGE_STATUS.COMPLETE, retries: 0 } } });
    writeEvidence(state, { workflow: 'name: fixture\nstages:\n  - id: plan\n    role: planner' });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state]));
    expect(view.identity.classification.kind).toBe('unknown');
  });

  it('treats unreadable workflow stage evidence as unknown instead of guessing engineering from stage ids', async () => {
    const state = runState('workflow-missing');
    writeEvidence(state);
    rmSync(join(runsRoot(), state.runId, 'workflow.yaml'));
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state]));
    expect(view.identity.classification).toMatchObject({ kind: 'unknown', status: 'partial', engineering: 'unknown' });
  });

  it('does not claim research-only when an unreadable run could contain independent engineering work', async () => {
    const research = runState('known-research', {
      status: RUN_STATUS.SHIPPED,
      research: { baseline: 1, policy: 'greedy_stack', higherIsBetter: true },
    });
    const unreadable = runState('unknown-second-shape');
    writeEvidence(research, {
      workflow: RESEARCH_WORKFLOW,
      journal: { rounds: [{ label: 'accepted', result: 2 }] },
      metric: { metric: 'quality_pct', value: 2, higherIsBetter: true },
    });
    const readers = pageSources([research, unreadable]);
    const readKnownState = readers.readRunState!;
    readers.readRunState = (dir, runId) => {
      if (runId === unreadable.runId) throw new Error('second run unreadable');
      return readKnownState(dir, runId);
    };

    const view = await readCampaignOperatorView(projectDir, campaignId, readers);

    expect(view.identity.classification).toMatchObject({
      kind: 'unknown',
      status: 'partial',
      research: 'present',
      engineering: 'unknown',
    });
    expect(view.research.value?.selected?.metric).toBe('quality_pct');
  });

  it('associates an accepted journal with a persisted campaign goal metric', async () => {
    const state = runState('campaign-goal-journal', {
      status: RUN_STATUS.SHIPPED,
      research: { baseline: 0, policy: 'greedy_stack' },
    });
    writeEvidence(state, { workflow: RESEARCH_WORKFLOW, journal: { rounds: [{ label: 'accepted-a', result: 4 }] } });
    const campaignDir = join(campaignsRoot(), campaignId);
    createdCampaignDirs.push(campaignDir);
    mkdirSync(campaignDir, { recursive: true });
    writeFileSync(join(campaignDir, 'state.json'), JSON.stringify({ id: campaignId, name: 'Campaign fixture', goal: { metric: 'quality_pct', higherIsBetter: true } }));

    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state]));
    expect(view.identity.classification.kind).toBe('research');
    expect(view.research.value?.selected?.metric).toBe('quality_pct');
  });
});

describe('research trend admission', () => {
  it('requires two compatible accepted points and direction before naming a best round', async () => {
    const one = runState('trend-one', { status: RUN_STATUS.SHIPPED, research: { baseline: 0, policy: 'greedy_stack' } });
    writeEvidence(one, {
      workflow: RESEARCH_WORKFLOW,
      journal: { rounds: [{ label: 'a', result: 1 }, { label: 'b', result: 3 }] },
      metric: { metric: 'quality_pct', value: 3 },
    });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([one]));
    expect(view.research.value?.selected).toMatchObject({ hasTrend: true, direction: 'higher' });
    expect(view.research.value?.selected?.best).toMatchObject({ round: 'b', value: 3 });

    const unknownDirection = runState('trend-direction-unknown');
    writeEvidence(unknownDirection);
    const entries: CampaignHistoryEntry[] = [1, 2].map((score) => ({
      seq: score,
      runId: unknownDirection.runId,
      iteration: score,
      score,
      metric: 'latency_ms',
      pass: true,
      status: RUN_STATUS.COMPLETE,
      timestamp: `2026-08-02T10:0${score}:00.000Z`,
    }));
    const noBest = await readCampaignOperatorView(projectDir, campaignId, pageSources([unknownDirection], { entries }));
    expect(noBest.research.value?.selected).toMatchObject({ hasTrend: true, direction: 'unknown', best: null });
  });

  it('never joins different metric names into one trend', async () => {
    const first = runState('metric-a', { status: RUN_STATUS.SHIPPED });
    const second = runState('metric-b', { status: RUN_STATUS.SHIPPED, startedAt: '2026-08-02T11:00:00.000Z' });
    writeEvidence(first);
    writeEvidence(second);
    const entries: CampaignHistoryEntry[] = [
      { seq: 1, runId: first.runId, score: 0, metric: 'unreachable_count', pass: true, status: RUN_STATUS.SHIPPED, timestamp: first.startedAt },
      { seq: 2, runId: second.runId, score: 9, metric: 'wall_benefit_pct', pass: true, status: RUN_STATUS.SHIPPED, timestamp: second.startedAt },
    ];
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([first, second], { entries }));
    expect(view.research.value?.selected?.hasTrend).toBe(false);
    expect(view.research.value?.otherMetrics).toHaveLength(1);
  });
});

describe('cost, canonical states, title, and proof of work', () => {
  it('adds independent supervisor tokens once and never adds supervisor duration to run wall clock', () => {
    const state = runState('cost-proof', {
      supervise: true,
      stages: {
        implement: { status: STAGE_STATUS.COMPLETE, retries: 0, tokens_in: 100, tokens_out: 50, duration_ms: 120_000 },
        _supervisor: { status: STAGE_STATUS.COMPLETE, retries: 0, tokens_in: 999, tokens_out: 999, duration_ms: 800_000 },
      },
      supervisor: {
        status: 'complete',
        calls: 1,
        tokens_in: 30,
        tokens_out: 20,
        duration_ms: 900_000,
        startedAt: '2026-08-02T10:10:00.000Z',
        completedAt: '2026-08-02T10:25:00.000Z',
        attempts: [],
      },
    });
    expect(deriveRunTokenCost(state)).toEqual({
      tokens: 200,
      supervisorTokens: 50,
      complete: true,
      attemptEvidence: { known: 1, recordedUnknown: 0, unrecorded: 0 },
    });
    expect(deriveRunWallClock(state, NOW.getTime())).toEqual({ milliseconds: 3_600_000, partial: false });
    expect(deriveRunWallClock({ ...state, startedAt: 'invalid', completedAt: undefined }, NOW.getTime()))
      .toEqual({ milliseconds: 120_000, partial: true });
  });

  it('uses the agreed short-name rule and deterministic fallbacks', () => {
    expect(deriveCampaignRunTitle('# TASK — 性能 E6: supervisor 开销', 'wf')).toEqual({ fullTitle: '性能 E6: supervisor 开销', shortName: '性能 E6' });
    const unstructured = '这是一个没有约定分隔符而且长度明显超过三十二个 Unicode 字符的完整任务标题';
    expect(Array.from(deriveCampaignRunTitle(unstructured, 'wf').shortName)).toHaveLength(33);
    expect(deriveCampaignRunTitle('', 'readable-workflow')).toEqual({ fullTitle: 'readable-workflow', shortName: 'readable-workflow' });
    expect(deriveCampaignRunTitle('', '')).toEqual({ fullTitle: 'Untitled task', shortName: 'Untitled task' });
  });

  it('groups repeated run issues once and keeps the same newest-first short-name order', async () => {
    const states = [1, 2, 3].map((ordinal) => runState(`opaque-run-${ordinal}`, {
      startedAt: `2026-08-02T1${ordinal}:00:00.000Z`,
      taskDescription: `TASK — P${ordinal}: grouped issue fixture`,
    }));
    for (const state of states) {
      writeEvidence(state);
      rmSync(join(runsRoot(), state.runId, 'workflow.yaml'));
    }

    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources(states));
    const classificationIssue = view.identity.classification.issues.find((item) => item.code === 'workflow-missing');
    const historyIssue = view.runs.issues?.find((item) => item.code === 'workflow-missing');

    expect(classificationIssue?.affectedRuns.map((run) => run.shortName)).toEqual(['P3', 'P2', 'P1']);
    expect(historyIssue?.affectedRuns.map((run) => run.shortName)).toEqual(['P3', 'P2', 'P1']);
    const visibleIssueText = [classificationIssue, historyIssue].flatMap((item) => [
      item?.summary,
      ...(item?.affectedRuns.map((run) => run.shortName) ?? []),
      ...(item?.details ?? []),
    ]).join(' ');
    expect(visibleIssueText).not.toContain('opaque-run-');
  });

  it('tolerates a legacy reality-gate object with no results list', async () => {
    const state = runState('legacy-reality-shape', {
      status: RUN_STATUS.REALITY_GATE_FAILED,
      realityGate: { pass: false } as StoreState['realityGate'],
    });
    writeEvidence(state);

    const page = await readCampaignRunPage(projectDir, campaignId, 0, 12, pageSources([state]));
    expect(page.value.items[0]).toMatchObject({
      status: RUN_STATUS.REALITY_GATE_FAILED,
      conclusion: 'Outcome summary unavailable',
    });
  });

  it('preserves every canonical run status and uses evidence, not duration, for zero-work', async () => {
    const statuses = Object.values(RUN_STATUS);
    const states = statuses.map((status, index) => runState(`canonical-${index}`, {
      status,
      startedAt: `2026-08-02T${String(index).padStart(2, '0')}:00:00.000Z`,
      completedAt: status === RUN_STATUS.RUNNING || status === RUN_STATUS.PENDING || status === RUN_STATUS.PARKED || status === RUN_STATUS.AWAITING_APPROVAL
        ? undefined
        : `2026-08-02T${String(index).padStart(2, '0')}:30:00.000Z`,
      parked: status === RUN_STATUS.PARKED ? {
        requestId: 'approval', action: 'write', reason: 'operator decision', atIteration: 1,
        requestedAt: '2026-08-02T02:10:00.000Z', pausedAt: '2026-08-02T02:20:00.000Z',
      } : undefined,
    }));
    states.forEach((state) => writeEvidence(state));
    const page = await readCampaignRunPage(projectDir, campaignId, 0, 100, pageSources(states));
    expect(new Set(page.value.items.map((row) => row.status))).toEqual(new Set(statuses));
    expect(new Set(page.value.items.map((row) => row.statusExplanation))).toHaveLength(statuses.length);

    const zero = runState('long-zero-work', { stages: { plan: { status: STAGE_STATUS.COMPLETE, retries: 0 } }, startedAt: '2026-08-01T00:00:00.000Z' });
    const instantWithWork = runState('instant-with-work', { startedAt: NOW.toISOString(), completedAt: NOW.toISOString() });
    const commitOnly = runState('commit-only', { stages: { plan: { status: STAGE_STATUS.COMPLETE, retries: 0 } } });
    const stillRunning = runState('running-no-work', { status: RUN_STATUS.RUNNING, completedAt: undefined, stages: {} });
    [zero, instantWithWork, commitOnly, stillRunning].forEach((state) => writeEvidence(state));
    const commitEntry: CampaignHistoryEntry = {
      seq: 1, runId: commitOnly.runId, kind: 'task_ended', pass: false, status: RUN_STATUS.COMPLETE,
      timestamp: commitOnly.completedAt!, completing_commit: 'abc123',
    };
    const proofPage = await readCampaignRunPage(projectDir, campaignId, 0, 100, pageSources([zero, instantWithWork, commitOnly, stillRunning], { entries: [commitEntry] }));
    const byId = new Map(proofPage.value.items.map((row) => [row.runId, row]));
    expect(byId.get(zero.runId)).toMatchObject({ zeroWork: true, zeroWorkReason: 'No delivery evidence: no commits and no completed execution stage.' });
    expect(byId.get(instantWithWork.runId)?.zeroWork).toBe(false);
    expect(byId.get(instantWithWork.runId)?.conclusion).toBe('Outcome summary unavailable');
    expect(byId.get(instantWithWork.runId)?.conclusion).not.toBe(instantWithWork.taskDescription?.replace(/^#\s*/, ''));
    expect(byId.get(commitOnly.runId)?.zeroWork).toBe(false);
    expect(byId.get(stillRunning.runId)?.zeroWork).toBe(false);
  });
});

describe('campaign-local attention and failure isolation', () => {
  it('shows only items belonging to this campaign and uses the earliest valid run start', async () => {
    const early = runState('attention-early', { startedAt: '2026-08-01T08:00:00.000Z' });
    const late = runState('attention-late', { startedAt: '2026-08-02T08:00:00.000Z' });
    writeEvidence(early);
    writeEvidence(late);
    const inbox = emptyInbox();
    inbox.approvals.items.push({
      runId: early.runId,
      projectDir,
      requestId: 'ours',
      action: 'write',
      risk: 'write',
      title: 'Approve our change',
      createdAt: NOW.toISOString(),
      state: 'pending',
      standingRuleEligible: { ok: false },
      campaignId,
    });
    inbox.approvals.items.push({
      runId: 'other-run',
      projectDir,
      requestId: 'theirs',
      action: 'write',
      risk: 'write',
      title: 'Other campaign approval',
      createdAt: NOW.toISOString(),
      state: 'pending',
      standingRuleEligible: { ok: false },
      campaignId: 'other-campaign',
    });
    inbox.deferred.items.push({ id: 1, runId: early.runId, name: 'approval mirror', deferReason: 'approval pending' });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([early, late], { inbox }));
    expect(view.identity).toMatchObject({ startedAt: early.startedAt, startedAtSource: 'runs' });
    expect(view.attention.value.items.map((item) => item.title)).toEqual(['Approve our change']);
  });

  it('keeps cost, activity, conclusions, and runs when the inbox source fails', async () => {
    const state = runState('isolated-inbox-failure');
    writeEvidence(state, { summary: '## What was done\n- delivered useful work' });
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([state], { inboxError: new Error('approval file unreadable') }));
    expect(view.attention.status).toBe('partial');
    expect(view.attention.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'campaign-inbox-unavailable',
        details: expect.arrayContaining(['approval file unreadable']),
      }),
    ]));
    expect(view.cost.status).toBe('complete');
    expect(view.activity.status).toBe('complete');
    expect(view.engineering.value?.latest?.conclusion).toBe('delivered useful work');
    expect(view.runs.value.items).toHaveLength(1);
  });

  it('marks every run-derived answer and both evidence sides unknown when a known run is unreadable', async () => {
    const state = runState('unreadable-known-run');
    const readers = pageSources([state]);
    readers.readRunState = () => { throw new Error('run.json corrupt'); };

    const view = await readCampaignOperatorView(projectDir, campaignId, readers);

    expect(view.identity).toMatchObject({ startedAt: null, startedAtSource: 'unknown' });
    expect(view.identity.classification).toMatchObject({
      kind: 'unknown',
      status: 'partial',
      research: 'unknown',
      engineering: 'unknown',
    });
    expect({
      cost: view.cost.status,
      attention: view.attention.status,
      activity: view.activity.status,
      research: view.research.status,
      engineering: view.engineering.status,
      runs: view.runs.status,
    }).toEqual({
      cost: 'unavailable',
      attention: 'partial',
      activity: 'unavailable',
      research: 'unavailable',
      engineering: 'unavailable',
      runs: 'unavailable',
    });
    expect(view.runs.value).toMatchObject({ items: [], total: 1 });
  });

  it('does not turn a failed run-index lookup into a complete zero-cost empty campaign', async () => {
    const state = runState('undiscoverable-run');
    const readers = pageSources([state]);
    readers.listRunRecordsByCampaign = () => { throw new Error('run index unreadable'); };
    readers.readRunState = () => { throw new Error('run state unavailable'); };

    const view = await readCampaignOperatorView(projectDir, campaignId, readers);

    expect(view.cost.status).toBe('unavailable');
    expect(view.runs.status).toBe('unavailable');
    expect(view.identity.classification).toMatchObject({
      kind: 'unknown',
      status: 'partial',
      research: 'unknown',
      engineering: 'unknown',
    });
  });

  it('marks supervised cost as a known partial instead of silently filling missing supervisor use with zero', async () => {
    const complete = runState('complete-cost');
    const missingSupervisor = runState('missing-supervisor', { supervise: true, supervisor: undefined });
    writeEvidence(complete);
    writeEvidence(missingSupervisor);
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources([complete, missingSupervisor]));
    expect(view.cost.status).toBe('partial');
    expect(view.cost.value.runCoverage).toEqual({ succeeded: 1, failed: 1, total: 2 });
    expect(view.cost.value.wallCoverage).toEqual({ succeeded: 2, failed: 0, total: 2 });
    expect(view.cost.value.tokenCoverage).toEqual({ succeeded: 1, failed: 1, total: 2 });
    expect(view.cost.issues).toEqual([
      expect.objectContaining({
        code: 'cost-token-telemetry-incomplete',
        affectedRuns: [expect.objectContaining({ runId: missingSupervisor.runId, shortName: '性能 E6' })],
      }),
    ]);

    const onlyUnknown = await readCampaignOperatorView(projectDir, campaignId, pageSources([missingSupervisor]));
    expect(onlyUnknown.cost.status).toBe('partial');
    expect(onlyUnknown.cost.value.runCoverage).toEqual({ succeeded: 0, failed: 1, total: 1 });
  });

  it('keeps current running and parked facts visible beside historical shipped work', async () => {
    const historical = runState('activity-shipped', { status: RUN_STATUS.SHIPPED });
    const running = runState('activity-running', { status: RUN_STATUS.RUNNING, completedAt: undefined });
    const parked = runState('activity-parked', {
      status: RUN_STATUS.PARKED,
      completedAt: undefined,
      parked: {
        requestId: 'operator-choice', action: 'continue', reason: '需要操作员决定', atIteration: 1,
        requestedAt: '2026-08-02T10:10:00.000Z', pausedAt: '2026-08-02T10:20:00.000Z',
      },
    });
    [historical, running, parked].forEach((state) => writeEvidence(state));
    const view = await readCampaignOperatorView(projectDir, campaignId, pageSources(
      [historical, running, parked],
      { live: { [running.runId]: false } },
    ));

    expect(view.activity.value.items.map((item) => item.status)).toEqual(expect.arrayContaining([RUN_STATUS.RUNNING, RUN_STATUS.PARKED]));
    expect(view.activity.value.items.find((item) => item.runId === running.runId)?.anomaly).toContain('no live worker can be verified');
    expect(view.attention.value.items.map((item) => item.kind)).toEqual(expect.arrayContaining(['worker_missing', 'parked']));
    expect(view.runs.value.items.find((item) => item.runId === historical.runId)?.status).toBe(RUN_STATUS.SHIPPED);
  });
});
