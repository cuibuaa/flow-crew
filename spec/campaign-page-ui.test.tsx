// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '../ui/test-support/react-testing';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CampaignPage from '../ui/src/components/campaign/CampaignPage';
import Workspaces from '../ui/src/components/Workspaces';
import type {
  CampaignOperatorIndex,
  CampaignOperatorView,
  CampaignRunRow,
  RunStatus,
  SourceResult,
} from '../ui/src/components/campaign/types';

const RUN_STATUSES: RunStatus[] = [
  'pending', 'running', 'parked', 'complete', 'failed', 'awaiting_approval', 'shipped',
  'ceiling_hit', 'escalated', 'reality_gate_failed', 'phase_complete', 'stopped', 'incomplete',
];

function complete<T>(value: T): SourceResult<T> {
  return { status: 'complete', value, coverage: { succeeded: 1, failed: 0, total: 1 } };
}

function runRow(status: RunStatus, index = 0): CampaignRunRow {
  return {
    runId: `ui-run-${index}-${status}`,
    shortName: index === 0 ? '性能 E6' : `任务 ${index}`,
    fullTitle: index === 0 ? '性能 E6: supervisor 开销与并行化' : `完整任务标题 ${index}`,
    status,
    statusExplanation: `${status} 的独立解释`,
    conclusion: status === 'failed' ? '构建命令失败' : '交付了可验证结果',
    durationMs: 60_000,
    durationPartial: false,
    commits: index === 0 ? ['abcdef1234567890'] : [],
    gates: [],
    zeroWork: index === 1,
    zeroWorkReason: index === 1 ? 'No delivery evidence: no commits and no completed execution stage.' : undefined,
    startedAt: '2026-08-02T10:00:00.000Z',
    completedAt: '2026-08-02T10:01:00.000Z',
    href: `/run/ui-run-${index}-${status}`,
  };
}

function engineeringView(rows: CampaignRunRow[] = [runRow('complete')]): CampaignOperatorView {
  return {
    generatedAt: '2026-08-02T12:00:00.000Z',
    identity: {
      id: 'ui-campaign',
      name: 'UI Campaign',
      storageKey: 'ui-campaign',
      runCount: rows.length,
      startedAt: '2026-08-02T10:00:00.000Z',
      startedAtSource: 'runs',
      classification: {
        kind: 'engineering',
        status: 'complete',
        research: 'absent',
        engineering: 'present',
        acceptedPointCount: 0,
        engineeringRunCount: rows.length,
        reasons: ['no accepted measurement point is proven', `${rows.length} independent engineering run(s)`],
        issues: [],
      },
    },
    cost: complete({
      wallMs: 3_600_000,
      tokens: 12_345,
      supervisorTokens: 3_000,
      runCoverage: { succeeded: rows.length, failed: 0, total: rows.length },
      wallCoverage: { succeeded: rows.length, failed: 0, total: rows.length },
      tokenCoverage: { succeeded: rows.length, failed: 0, total: rows.length },
    }),
    attention: complete({ items: [], total: 0, shown: 0 }),
    activity: complete({ items: [], total: 0, shown: 0 }),
    research: complete(null),
    engineering: complete({
      latest: {
        runId: rows[0]?.runId ?? 'none',
        shortName: rows[0]?.shortName ?? '任务',
        fullTitle: rows[0]?.fullTitle ?? '完整任务',
        status: rows[0]?.status ?? 'complete',
        statusExplanation: rows[0]?.statusExplanation ?? '工程 DAG 完成',
        conclusion: rows[0]?.conclusion ?? '交付了可验证结果',
        commits: rows[0]?.commits ?? [],
        filesChanged: ['src/campaign-page.ts'],
        gates: ['acceptance: complete'],
        href: rows[0]?.href ?? '/run/none',
      },
      deliveryCount: rows.length,
    }),
    runs: complete({ items: rows, shown: rows.length, total: rows.length, nextCursor: null, truncated: false }),
  };
}

function indexFixture(): CampaignOperatorIndex {
  return {
    generatedAt: '2026-08-02T12:00:00.000Z',
    campaigns: complete({
      total: 1,
      items: [{
        id: 'ui-campaign',
        name: 'UI Campaign',
        runCount: 1,
        latestStartedAt: '2026-08-02T10:00:00.000Z',
        attention: { status: 'complete', count: 0 },
        activity: { status: 'complete', running: 0, waiting: 0, summary: '当前没有 run 在执行或等待', needsIntervention: false },
        recent: { status: 'complete', runStatus: 'complete', statusExplanation: '工程 DAG 完成', conclusion: '交付了可验证结果' },
        href: '/campaign/ui-campaign',
      }],
    }),
  };
}

function renderCampaign(view: CampaignOperatorView) {
  return render(<MemoryRouter><CampaignPage view={view} /></MemoryRouter>);
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('decision-first campaign UI', () => {
  it('renders exactly five Q-mapped regions, a single complete cost, and no token field in run rows', () => {
    const view = engineeringView([runRow('complete'), runRow('complete', 1)]);
    const { container } = renderCampaign(view);
    const regions = [...container.querySelectorAll<HTMLElement>('[data-answers]')];
    expect(regions).toHaveLength(5);
    expect(regions.map((region) => region.dataset.answers)).toEqual(['Q4', 'Q1 Q5', 'Q2 Q5', 'Q3', 'Q2 Q3 Q5']);
    expect(regions[0]).toHaveTextContent('Total run wall-clock time 1 hr');
    expect(regions[0]).toHaveTextContent('Total tokens 12.3K (including supervisor)');
    expect(regions[1]).toHaveTextContent('Nothing needs your attention');
    expect(regions[1].querySelector('table')).toBeNull();
    expect(regions[4].textContent?.toLowerCase()).not.toContain('token');
    expect(regions[4]).toHaveTextContent('No delivery evidence');
    expect(container).not.toHaveTextContent('Latest score');
    expect(container).not.toHaveTextContent('no range set');
  });

  it('keeps every canonical status visible as its own text label', () => {
    const rows = RUN_STATUSES.map((status, index) => runRow(status, index));
    const { container } = renderCampaign(engineeringView(rows));
    const ledger = container.querySelector<HTMLElement>('.campaign-ledger')!;
    for (const status of RUN_STATUSES) expect(within(ledger).getByText(status, { exact: true })).toBeInTheDocument();
  });

  it('shows one short title and reveals the full title only by click or keyboard disclosure', () => {
    const { container } = renderCampaign(engineeringView());
    const ledger = container.querySelector<HTMLElement>('.campaign-ledger')!;
    const disclosure = ledger.querySelector<HTMLDetailsElement>('.campaign-run-title')!;
    const summary = disclosure.querySelector<HTMLElement>('.campaign-run-title-summary')!;
    expect(within(summary).getByText('性能 E6')).toBeInTheDocument();
    expect(disclosure.querySelector('[role="tooltip"]')).toBeNull();
    expect(disclosure.querySelector('.campaign-run-title-full')).toHaveTextContent('性能 E6: supervisor 开销与并行化');
    summary.focus();
    expect(document.activeElement).toBe(summary);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
  });

  it('does not render research trend/best for engineering, but preserves both for qualified research', () => {
    const engineering = renderCampaign(engineeringView());
    expect(engineering.container.querySelector('[data-testid="research-conclusion"]')).toBeNull();
    engineering.unmount();

    const research = engineeringView();
    research.identity.classification = {
      kind: 'research', status: 'complete', research: 'present', engineering: 'absent',
      acceptedPointCount: 2, engineeringRunCount: 0, reasons: ['2 accepted measurement point(s)'], issues: [],
    };
    research.research = complete({
      selected: {
        metric: 'quality_pct',
        metricKey: 'quality_pct',
        points: [
          { runId: 'r1', round: 'round 1', metric: 'quality_pct', metricKey: 'quality_pct', value: 4, timestamp: null, direction: 'higher', evidence: 'research_journal' },
          { runId: 'r1', round: 'round 2', metric: 'quality_pct', metricKey: 'quality_pct', value: 9, timestamp: null, direction: 'higher', evidence: 'research_journal' },
        ],
        hasTrend: true,
        direction: 'higher',
        best: { runId: 'r1', round: 'round 2', metric: 'quality_pct', metricKey: 'quality_pct', value: 9, timestamp: null, direction: 'higher', evidence: 'research_journal' },
      },
      otherMetrics: [],
      acceptedPointCount: 2,
      confirmNotes: [],
      latestCanonicalStatus: 'shipped',
    });
    research.engineering = complete(null);
    const qualified = renderCampaign(research);
    expect(qualified.container).toHaveTextContent('Measurement 1: 4 → Measurement 2: 9');
    expect(qualified.container).toHaveTextContent('Best measurement (2): 9');
  });

  it('distinguishes an incomplete attention source from the trustworthy empty answer', () => {
    const view = engineeringView();
    view.attention = {
      status: 'partial',
      value: { items: [], total: 0, shown: 0 },
      coverage: { succeeded: 3, failed: 1, total: 4 },
      issues: [{ code: 'approvals-unreadable', summary: 'Approvals could not be read', affectedRuns: [], details: ['approvals unreadable'] }],
    };
    renderCampaign(view);
    expect(screen.getByRole('alert', { name: '' })).toHaveTextContent('Campaign attention list incomplete');
    expect(screen.queryByText('Nothing needs your attention')).not.toBeInTheDocument();
  });

  it.each(['cost', 'attention', 'activity', 'research', 'engineering', 'runs'] as const)(
    'isolates an injected %s source failure to its decision region',
    (area) => {
      const view = engineeringView();
      const error = `${area} injected failure`;
      const failed = <T,>(value: T): SourceResult<T> => ({
        status: 'unavailable',
        value,
        coverage: { succeeded: 0, failed: 1, total: 1 },
        issues: [{ code: `${area}-injected`, summary: error, affectedRuns: [] }],
      });
      const regionIndex = { cost: 0, attention: 1, activity: 2, research: 3, engineering: 3, runs: 4 }[area];
      if (area === 'cost') view.cost = failed(view.cost.value);
      if (area === 'attention') view.attention = failed({ items: [], total: 0, shown: 0 });
      if (area === 'activity') view.activity = failed({ items: [], total: 0, shown: 0 });
      if (area === 'engineering') view.engineering = failed(null);
      if (area === 'runs') view.runs = failed({ items: [], shown: 0, total: 1, nextCursor: null, truncated: false });
      if (area === 'research') {
        view.identity.classification = {
          kind: 'research', status: 'complete', research: 'present', engineering: 'absent',
          acceptedPointCount: 0, engineeringRunCount: 0, reasons: ['research evidence unreadable'], issues: [],
        };
        view.research = failed(null);
        view.engineering = complete(null);
      }

      const { container } = renderCampaign(view);
      const regions = [...container.querySelectorAll<HTMLElement>('[data-answers]')];
      expect(regions).toHaveLength(5);
      expect(regions[regionIndex]).toHaveTextContent(error);
      regions.forEach((region, index) => {
        if (index !== regionIndex) expect(region).not.toHaveTextContent(error);
      });
      expect(regions.filter((region) => !region.textContent?.includes(error))).toHaveLength(4);
    },
  );

  it('loads brief revisions and their diff only after the operator opens the disclosure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/revisions')) {
        return { ok: true, status: 200, json: async () => [{ from: 'v1', to: 'v2', reason: 'clarified the acceptance gate' }] } as Response;
      }
      return { ok: true, status: 200, text: async () => '--- v1\n+++ v2\n-old\n+new' } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCampaign(engineeringView());
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Brief revisions'));
    expect(await screen.findByText('clarified the acceptance gate')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'View diff' }));
    expect(await screen.findByLabelText('v1 → v2 brief diff')).toHaveTextContent('+new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads a compact findings/dead-ends digest only when research evidence is expanded', async () => {
    const view = engineeringView();
    view.identity.classification = {
      kind: 'research', status: 'complete', research: 'present', engineering: 'absent',
      acceptedPointCount: 1, engineeringRunCount: 0, reasons: ['1 accepted measurement point'], issues: [],
    };
    view.research = complete({
      selected: {
        metric: 'quality', metricKey: 'quality', hasTrend: false, direction: 'higher', best: null,
        points: [{ runId: 'r1', round: 'a', metric: 'quality', metricKey: 'quality', value: 4, timestamp: null, direction: 'higher', evidence: 'research_journal' }],
      },
      otherMetrics: [], acceptedPointCount: 1, confirmNotes: [], latestCanonicalStatus: 'shipped',
    });
    view.engineering = complete(null);
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({
        nodes: [
          { id: 'f1', type: 'finding', label: '缓存命中率决定收益', runId: 'r1' },
          { id: 'd1', type: 'dead_end', label: '全量预热反而更慢', runId: 'r1' },
        ],
        edges: [],
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    renderCampaign(view);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Research evidence details'));
    expect(await screen.findByText('缓存命中率决定收益')).toBeInTheDocument();
    expect(screen.getByText('全量预热反而更慢')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the last trusted detail visible when an explicit refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refresh offline')));
    render(
      <MemoryRouter initialEntries={['/campaign/ui-campaign']}>
        <Routes><Route path="/campaign/:id" element={<Workspaces initialIndex={indexFixture()} initialView={engineeringView()} />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('campaign-operator-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '⟳ Refresh' }));
    expect(await screen.findByText(/Refresh failed\. Showing data generated at.*refresh offline/)).toBeInTheDocument();
    expect(screen.getByText('Total run wall-clock time 1 hr')).toBeInTheDocument();
  });

  it('keeps pagination focus in place when the final run page is loaded', async () => {
    const firstPage = Array.from({ length: 12 }, (_, index) => runRow('complete', index));
    const view = engineeringView(firstPage);
    view.runs = complete({ items: firstPage, shown: 12, total: 15, nextCursor: '12', truncated: true });
    const loadOlder = vi.fn(async () => complete({
      items: Array.from({ length: 3 }, (_, index) => runRow('complete', index + 12)),
      shown: 3,
      total: 15,
      nextCursor: null,
      truncated: false,
    }));
    render(<MemoryRouter><CampaignPage view={view} loadOlder={loadOlder} /></MemoryRouter>);
    const button = screen.getByRole('button', { name: 'Load older runs' });
    button.focus();
    fireEvent.click(button);

    const completed = await screen.findByRole('button', { name: 'All runs loaded' });
    expect(completed).toHaveAttribute('aria-disabled', 'true');
    expect(completed).not.toBeDisabled();
    expect(document.activeElement).toBe(completed);
    expect(screen.getByText('Showing 15/15')).toBeInTheDocument();
  });
});

describe('campaign routing and request scale', () => {
  it('keeps /campaign as a real index URL instead of selecting an arbitrary detail', () => {
    render(
      <MemoryRouter initialEntries={['/campaign']}>
        <Routes>
          <Route path="/campaign" element={<><Workspaces initialIndex={indexFixture()} /><LocationProbe /></>} />
          <Route path="/campaign/:id" element={<><Workspaces initialIndex={indexFixture()} /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('campaign-index')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/campaign');
  });

  it('loads one operator index and one operator view with no per-run fanout', async () => {
    window.localStorage.setItem('fc.campaignFilter', 'all');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith('/operator-index') ? indexFixture() : engineeringView();
      return { ok: true, status: 200, statusText: 'OK', json: async () => payload } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/campaign/ui-campaign']}>
        <Routes><Route path="/campaign/:id" element={<Workspaces />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('campaign-operator-page')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(['/api/campaigns/operator-index', '/api/campaigns/ui-campaign/operator-view']);
    expect(urls.some((url) => /\/api\/runs\//.test(url))).toBe(false);
  });
});
