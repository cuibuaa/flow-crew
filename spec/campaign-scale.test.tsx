// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '../ui/test-support/react-testing';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import CampaignPage from '../ui/src/components/campaign/CampaignPage';
import Workspaces from '../ui/src/components/Workspaces';
import type {
  CampaignIndexRow,
  CampaignOperatorIndex,
  CampaignOperatorView,
  CampaignRunRow,
  SourceResult,
} from '../ui/src/components/campaign/types';

function complete<T>(value: T): SourceResult<T> {
  return { status: 'complete', value, coverage: { succeeded: 1, failed: 0, total: 1 } };
}

function campaignIndexRow(index: number): CampaignIndexRow {
  return {
    id: `campaign-${index}`,
    name: `Campaign ${index}`,
    runCount: 1,
    latestStartedAt: '2026-08-02T18:00:00.000Z',
    attention: { status: 'complete', count: index % 7 === 0 ? 1 : 0 },
    activity: {
      status: 'complete',
      running: 1,
      waiting: 0,
      summary: '1 run is executing',
      needsIntervention: false,
    },
    recent: {
      status: 'complete',
      runStatus: 'running',
      statusExplanation: 'The workflow is executing.',
      conclusion: 'Work is still in progress.',
    },
    href: `/campaign/campaign-${index}`,
  };
}

function indexFixture(count: number): CampaignOperatorIndex {
  const items = Array.from({ length: count }, (_, index) => campaignIndexRow(index));
  return {
    generatedAt: '2026-08-02T19:00:00.000Z',
    campaigns: {
      status: 'complete',
      value: { total: count, items },
      coverage: { succeeded: count, failed: 0, total: count },
    },
  };
}

interface ScaleSample {
  campaignCount: number;
  domNodes: number;
  campaignLinks: number;
  campaignRows: number;
  interactiveMs: number;
  focusProbeWorked: boolean;
}

function measureInitialCampaignDom(campaignCount: number): ScaleSample {
  window.localStorage.setItem('fc.campaignFilter', 'all');
  const index = indexFixture(campaignCount);
  const startedAt = performance.now();
  const rendered = render(
    <MemoryRouter initialEntries={['/campaign']}>
      <Routes><Route path="/campaign" element={<Workspaces initialIndex={index} />} /></Routes>
    </MemoryRouter>,
  );
  const focusProbe = rendered.container.querySelector<HTMLElement>('button, a[href]');
  focusProbe?.focus();
  const interactiveMs = performance.now() - startedAt;
  const sample = {
    campaignCount,
    domNodes: document.querySelectorAll('*').length,
    campaignLinks: document.querySelectorAll('a[href^="/campaign/"]').length,
    campaignRows: document.querySelectorAll('.campaign-index-row, .campaign-sidebar-row').length,
    interactiveMs: Number(interactiveMs.toFixed(2)),
    focusProbeWorked: document.activeElement === focusProbe,
  };
  rendered.unmount();
  cleanup();
  return sample;
}

function runRow(index: number, zeroWork = false): CampaignRunRow {
  return {
    runId: `run-${index}`,
    shortName: `Run ${index}`,
    fullTitle: `Full run title ${index}`,
    status: 'complete',
    statusExplanation: 'The engineering workflow completed.',
    conclusion: 'Produced a verified delivery.',
    durationMs: 60_000,
    durationPartial: false,
    commits: zeroWork ? [] : [`abcdef${index}`],
    gates: [],
    zeroWork,
    zeroWorkReason: zeroWork ? 'No delivery evidence: no commits and no completed execution stage.' : undefined,
    startedAt: '2026-08-02T10:00:00.000Z',
    completedAt: '2026-08-02T10:01:00.000Z',
    href: `/run/run-${index}`,
  };
}

function campaignView(rows: CampaignRunRow[], total: number, nextCursor: string | null): CampaignOperatorView {
  return {
    generatedAt: '2026-08-02T19:00:00.000Z',
    identity: {
      id: 'zero-work-campaign',
      name: 'Zero-work campaign',
      storageKey: 'zero-work-campaign',
      runCount: total,
      startedAt: '2026-08-02T10:00:00.000Z',
      startedAtSource: 'runs',
      classification: {
        kind: 'engineering',
        status: 'complete',
        research: 'absent',
        engineering: 'present',
        acceptedPointCount: 0,
        engineeringRunCount: total,
        reasons: ['No accepted research measurement is present.', `${total} engineering runs are present.`],
        issues: [],
      },
    },
    cost: complete({
      wallMs: total * 60_000,
      tokens: total * 100,
      supervisorTokens: 0,
      runCoverage: { succeeded: total, failed: 0, total },
      wallCoverage: { succeeded: total, failed: 0, total },
      tokenCoverage: { succeeded: total, failed: 0, total },
    }),
    attention: complete({ items: [], total: 0, shown: 0 }),
    activity: complete({ items: [], total: 0, shown: 0 }),
    research: complete(null),
    engineering: complete({
      latest: {
        runId: rows[0]?.runId ?? 'none',
        shortName: rows[0]?.shortName ?? 'No run',
        fullTitle: rows[0]?.fullTitle ?? 'No run recorded',
        status: 'complete',
        statusExplanation: 'The workflow completed.',
        conclusion: 'Produced a verified delivery.',
        commits: rows[0]?.commits ?? [],
        filesChanged: ['src/example.ts'],
        gates: ['acceptance: complete'],
        href: rows[0]?.href ?? '/run/none',
      },
      deliveryCount: rows.filter((row) => !row.zeroWork).length,
    }),
    runs: complete({ items: rows, shown: rows.length, total, nextCursor, truncated: nextCursor !== null }),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('bounded campaign index DOM', () => {
  it('keeps initial rows, campaign links, and DOM under N-independent bounds at 10, 1,700, and 10,000 campaigns', { timeout: 60_000 }, () => {
    const samples = [10, 1_700, 10_000].map(measureInitialCampaignDom);
    console.info(`[P6_CAMPAIGN_SCALE] ${JSON.stringify(samples)}`);
    const violations = samples.filter((sample) => (
      sample.campaignRows > 60
      || sample.campaignLinks > 100
      || sample.domNodes > 1_500
      || sample.interactiveMs > 1_000
      || !sample.focusProbeWorked
    ));
    expect(violations).toEqual([]);
    const saturated = samples.filter((sample) => sample.campaignCount >= 1_700);
    expect(new Set(saturated.map((sample) => sample.campaignRows)).size).toBe(1);
    expect(new Set(saturated.map((sample) => sample.campaignLinks)).size).toBe(1);
    expect(new Set(saturated.map((sample) => sample.domNodes)).size).toBe(1);
  });
});

describe('zero-work run disclosure', () => {
  it('reveals a zero-work marker and its reason when the later ledger page is loaded', async () => {
    const firstPage = Array.from({ length: 12 }, (_, index) => runRow(index));
    const laterPage = [runRow(12), runRow(13, true)];
    const loadOlder = async () => complete({
      items: laterPage,
      shown: laterPage.length,
      total: 14,
      nextCursor: null,
      truncated: false,
    });
    const rendered = render(
      <MemoryRouter>
        <CampaignPage view={campaignView(firstPage, 14, '12')} loadOlder={loadOlder} />
      </MemoryRouter>,
    );
    expect(rendered.container.querySelector('.campaign-zero-work')).toBeNull();
    const loadButton = rendered.container.querySelector<HTMLButtonElement>('.campaign-load-more');
    expect(loadButton).not.toBeNull();
    fireEvent.click(loadButton!);
    await waitFor(() => expect(rendered.container.querySelector('.campaign-zero-work')).not.toBeNull());
    const marker = rendered.container.querySelector<HTMLElement>('.campaign-zero-work')!;
    expect(marker).toHaveTextContent('No delivery evidence: no commits and no completed execution stage.');
    console.info(`[P6_D3] ${JSON.stringify({ loadedRows: rendered.container.querySelectorAll('.campaign-run-row').length, marker: marker.textContent })}`);
  });
});
