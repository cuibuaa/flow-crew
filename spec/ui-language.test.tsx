// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '../ui/test-support/react-testing';
import CampaignIndex from '../ui/src/components/campaign/CampaignIndex';
import CampaignPage from '../ui/src/components/campaign/CampaignPage';
import type {
  CampaignOperatorIndex,
  CampaignOperatorView,
  SourceResult,
} from '../ui/src/components/campaign/types';
import Inbox from '../ui/src/components/Inbox';
import RunDetail from '../ui/src/components/RunDetail';
import type { InboxOverview, RunDetailData } from '../ui/src/types';

vi.mock('../ui/src/api', () => ({
  cancelTask: vi.fn(),
  fetchCampaignBriefDiff: vi.fn(),
  fetchInboxOverview: vi.fn(),
  fetchRunDetail: vi.fn(),
  fetchRunStageOutput: vi.fn(),
  fetchRunSummary: vi.fn(async () => null),
  resolveInboxItem: vi.fn(),
  reviewCampaignPatch: vi.fn(),
}));

const HAN = /\p{Script=Han}/u;
const INTERNAL_QUESTION = /\bQ[1-5]\b/;

function complete<T>(value: T): SourceResult<T> {
  return { status: 'complete', value, coverage: { succeeded: 1, failed: 0, total: 1 } };
}

function stripAllowedUserText(text: string, allowed: readonly string[]): string {
  return allowed.reduce((current, value) => current.replaceAll(value, ''), text);
}

function readableSurface(container: HTMLElement, allowedUserText: readonly string[]) {
  const text = stripAllowedUserText(container.textContent ?? '', allowedUserText);
  const accessibleLabels = [...container.querySelectorAll<HTMLElement>('[aria-label], [title], [alt]')]
    .flatMap((element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('alt')])
    .filter((value): value is string => Boolean(value))
    .map((value) => stripAllowedUserText(value, allowedUserText))
    .join(' ');
  return { text, accessibleLabels };
}

function expectEnglishProductChrome(container: HTMLElement, allowedUserText: readonly string[]) {
  const surface = readableSurface(container, allowedUserText);
  console.info(`[P6_UI_SURFACE] ${JSON.stringify(surface)}`);
  expect(surface.text).not.toMatch(HAN);
  expect(surface.accessibleLabels).not.toMatch(HAN);
  expect(`${surface.text} ${surface.accessibleLabels}`).not.toMatch(INTERNAL_QUESTION);
}

function researchCampaignView(): { view: CampaignOperatorView; userText: string[] } {
  const userText = [
    '用户定义的火箭 campaign',
    '用户任务简称',
    '用户提供的完整 run 标题',
    '用户写下的交付结论',
  ];
  const view: CampaignOperatorView = {
    generatedAt: '2026-08-02T12:00:00.000Z',
    identity: {
      id: 'language-campaign',
      name: userText[0],
      storageKey: 'language-campaign',
      runCount: 1,
      startedAt: '2026-08-02T10:00:00.000Z',
      startedAtSource: 'runs',
      classification: {
        kind: 'research',
        status: 'complete',
        research: 'present',
        engineering: 'absent',
        acceptedPointCount: 1,
        engineeringRunCount: 0,
        reasons: ['one accepted measurement point'],
        issues: [],
      },
    },
    cost: {
      status: 'partial',
      value: {
        wallMs: 60_000,
        tokens: 120,
        supervisorTokens: 20,
        runCoverage: { succeeded: 0, failed: 1, total: 1 },
        wallCoverage: { succeeded: 1, failed: 0, total: 1 },
        tokenCoverage: { succeeded: 0, failed: 1, total: 1 },
      },
      coverage: { succeeded: 0, failed: 1, total: 1 },
      issues: [{
        code: 'cost-token-telemetry-incomplete',
        summary: 'Token or attempt telemetry is incomplete',
        affectedRuns: [{ runId: 'language-run', shortName: userText[1], href: '/run/language-run' }],
      }],
    },
    attention: complete({ items: [], total: 0, shown: 0 }),
    activity: complete({
      items: [{
        runId: 'language-run',
        shortName: userText[1],
        fullTitle: userText[2],
        status: 'running',
        statusExplanation: 'The workflow is executing.',
        durationMs: 60_000,
        durationPartial: false,
        worker: 'live',
        href: '/run/language-run',
      }],
      total: 1,
      shown: 1,
    }),
    research: complete({
      selected: {
        metric: 'SESSION_REUSE_CLI_WALL_BENEFIT_PCT',
        metricKey: 'session_reuse_cli_wall_benefit_pct',
        points: [{
          runId: 'language-run',
          round: 'seq 4',
          metric: 'SESSION_REUSE_CLI_WALL_BENEFIT_PCT',
          metricKey: 'session_reuse_cli_wall_benefit_pct',
          value: 31,
          timestamp: '2026-08-02T10:00:00.000Z',
          direction: 'higher',
          evidence: 'research_journal',
        }],
        hasTrend: false,
        direction: 'higher',
        best: null,
      },
      otherMetrics: [],
      acceptedPointCount: 1,
      confirmNotes: [],
      latestCanonicalStatus: 'shipped',
    }),
    engineering: complete(null),
    runs: complete({
      items: [{
        runId: 'language-run',
        shortName: userText[1],
        fullTitle: userText[2],
        status: 'shipped',
        statusExplanation: 'Delivery was accepted.',
        conclusion: userText[3],
        durationMs: 60_000,
        durationPartial: false,
        commits: ['abcdef123456'],
        gates: [],
        zeroWork: false,
        startedAt: '2026-08-02T10:00:00.000Z',
        completedAt: '2026-08-02T10:01:00.000Z',
        href: '/run/language-run',
      }],
      shown: 1,
      total: 1,
      nextCursor: null,
      truncated: false,
    }),
  };
  return { view, userText };
}

function campaignIndexFixture(): { index: CampaignOperatorIndex; userText: string[] } {
  const userText = ['用户命名的 campaign', '用户写下的当前活动', '用户写下的最近结论'];
  return {
    userText,
    index: {
      generatedAt: '2026-08-02T12:00:00.000Z',
      campaigns: complete({
        total: 1,
        items: [{
          id: 'language-index',
          name: userText[0],
          runCount: 1,
          latestStartedAt: '2026-08-02T10:00:00.000Z',
          attention: { status: 'complete', count: 0 },
          activity: { status: 'complete', running: 1, waiting: 0, summary: userText[1], needsIntervention: false },
          recent: { status: 'complete', runStatus: 'running', statusExplanation: 'The run is executing.', conclusion: userText[2] },
          href: '/campaign/language-index',
        }],
      }),
    },
  };
}

function inboxFixture(): { overview: InboxOverview; userText: string[] } {
  const userText = [
    '用户审批标题', '用户审批说明', '用户 campaign 名称', '用户 deferred 名称', '用户等待理由',
    '用户 stale campaign', '用户补丁理由', '用户补丁摘要', '用户补丁正文',
  ];
  return {
    userText,
    overview: {
      approvals: {
        status: 'partial',
        items: [{
          runId: 'approval-run', projectDir: '/fixture/project', requestId: 'approval-1', action: 'deploy',
          risk: 'external', title: userText[0], body: userText[1], createdAt: '2026-08-02T10:00:00.000Z',
          state: 'pending', standingRuleEligible: { ok: true }, campaignId: 'language-campaign', campaignName: userText[2],
        }],
        error: 'one approval source could not be read',
        coverage: { succeeded: 1, failed: 1 },
      },
      deferred: { status: 'complete', items: [{ id: 3, name: userText[3], projectDir: '/fixture/project', runId: 'deferred-run', status: 'deferred', deferReason: userText[4], notBefore: null }] },
      stale: { status: 'complete', items: [{ id: 'stale-campaign', name: userText[5], status: 'stale', staleRunId: 'stale-run' }] },
      patches: { status: 'complete', items: [{
        index: 0, ts: '2026-08-02T10:00:00.000Z', campaignId: 'language-campaign', campaignName: userText[2],
        reason: userText[6], patch: { type: 'brief_patch', section: 'Goal', op: 'append', value: userText[8] },
        patchSummary: userText[7], severity: 'medium', briefVersion: 'v1', latestVersion: 'v1', source: 'operator',
      }] },
      campaignCount: 4,
    },
  };
}

function runFixture(status: 'parked' | 'complete'): { run: RunDetailData; userText: string[] } {
  const userText = ['用户提供的 stage 输出', '用户写下的 run 问题'];
  return {
    userText,
    run: {
      runId: `language-${status}`,
      campaignId: 'language-campaign',
      projectDir: '/fixture/project',
      workflowName: 'fixture-workflow',
      status,
      startedAt: '2026-08-02T10:00:00.000Z',
      completedAt: status === 'complete' ? '2026-08-02T10:01:00.000Z' : undefined,
      failureReason: userText[1],
      stages: [{
        id: 'implementation', role: 'coder', depends_on: [], status: status === 'complete' ? 'complete' : 'pending',
        attempts: status === 'complete' ? [{ index: 1, status: 'complete', startedAt: '2026-08-02T10:00:00.000Z', duration_ms: 60_000 }] : [],
      }],
      events: [
        { ts: '2026-08-02T10:00:00.000Z', event: 'stage_complete', stage: 'implementation' },
        { ts: '2026-08-02T10:00:01.000Z', event: 'attempt_summary_refresh_requested' },
      ],
      stage_outputs: { implementation: userText[0] },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('campaign language and traceability boundary', () => {
  it('keeps the campaign index English while preserving Chinese campaign-owned content', () => {
    const { index, userText } = campaignIndexFixture();
    const rendered = render(<MemoryRouter><CampaignIndex index={index} /></MemoryRouter>);
    for (const value of userText) expect(rendered.container).toHaveTextContent(value);
    expectEnglishProductChrome(rendered.container, userText);
  });

  it('uses self-explanatory English decision headings without visible Q badges or internal metric labels', () => {
    const { view, userText } = researchCampaignView();
    const rendered = render(<MemoryRouter><CampaignPage view={view} /></MemoryRouter>);
    for (const value of userText) expect(rendered.container).toHaveTextContent(value);
    expectEnglishProductChrome(rendered.container, userText);
    const headings = [...rendered.container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim() ?? '');
    expect(headings.some((heading) => /\bcost\b/i.test(heading))).toBe(true);
    expect(headings.some((heading) => /attention|action required|waiting for you/i.test(heading))).toBe(true);
    expect(headings.some((heading) => /current.*(?:run|work|activity)|active (?:run|work|stage)/i.test(heading))).toBe(true);
    expect(headings.some((heading) => /(?:latest|campaign|final).*(?:outcome|result|conclusion|delivery)|(?:outcome|result|conclusion|delivery).*(?:latest|campaign|final)/i.test(heading))).toBe(true);
    expect(headings.some((heading) => /run.*(?:history|ledger)|history.*run/i.test(heading))).toBe(true);
    expect(rendered.container).not.toHaveTextContent('SESSION_REUSE_CLI_WALL_BENEFIT_PCT');
    expect(rendered.container).not.toHaveTextContent('seq 4');
  });
});

describe('inbox language', () => {
  it('uses CLI-aligned English domain terms while preserving Chinese item content', async () => {
    const { overview, userText } = inboxFixture();
    const rendered = render(<MemoryRouter><Inbox loadOverview={async () => overview} /></MemoryRouter>);
    await waitFor(() => expect(rendered.container.querySelector('[data-testid="inbox-view"]')).toHaveTextContent(userText[0]));
    const diffButton = rendered.container.querySelector<HTMLButtonElement>('.patch-card button[aria-expanded]');
    expect(diffButton).not.toBeNull();
    fireEvent.click(diffButton!);
    await waitFor(() => expect(rendered.container).toHaveTextContent(userText[8]));
    for (const value of userText) expect(rendered.container).toHaveTextContent(value);
    expectEnglishProductChrome(rendered.container, userText);
    expect(rendered.container).toHaveTextContent(/\bInbox\b/);
    expect(rendered.container).toHaveTextContent(/\bcampaign\b/);
    expect(rendered.container).toHaveTextContent(/\brun\b/);
  });
});

describe('run-page language and internal-event boundary', () => {
  it.each(['parked', 'complete'] as const)('renders the %s scene in English and keeps internal event names hidden', async (status) => {
    const { run, userText } = runFixture(status);
    const rendered = render(<MemoryRouter><RunDetail run={run} /></MemoryRouter>);
    await waitFor(() => expect(rendered.container.querySelector('[data-testid="run-detail"]')).not.toBeNull());
    for (const value of userText) expect(rendered.container).toHaveTextContent(value);
    expectEnglishProductChrome(rendered.container, userText);
    expect(rendered.container).not.toHaveTextContent('stage_complete');
    expect(rendered.container).not.toHaveTextContent('attempt_summary_refresh_requested');
  });
});
