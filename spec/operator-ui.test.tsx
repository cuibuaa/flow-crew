// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '../ui/test-support/react-testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CampaignPage from '../ui/src/components/campaign/CampaignPage';
import type {
  CampaignOperatorView,
  CampaignRunReference,
  SourceIssue,
  SourceResult,
} from '../ui/src/components/campaign/types';

vi.mock('../ui/src/api', () => ({
  cancelTask: vi.fn(),
  fetchInboxOverview: vi.fn(),
  resolveInboxItem: vi.fn(),
}));

function complete<T>(value: T): SourceResult<T> {
  return { status: 'complete', value, coverage: { succeeded: 1, failed: 0, total: 1 } };
}

function runRefs(): CampaignRunReference[] {
  return Array.from({ length: 6 }, (_, index) => {
    const ordinal = 6 - index;
    return { runId: `2026-08-0${ordinal}T10-00-00-opaque`, shortName: `P${ordinal}`, href: `/run/opaque-${ordinal}` };
  });
}

function workflowIssue(): SourceIssue {
  return { code: 'workflow-missing', summary: 'Workflow evidence is missing', affectedRuns: runRefs() };
}

function operatorView(): CampaignOperatorView {
  const refs = runRefs();
  const longFailure = Array.from({ length: 80 }, (_, index) => `failure detail ${index + 1}`).join('; ');
  return {
    generatedAt: '2026-08-03T12:00:00.000Z',
    identity: {
      id: 'search-relevance-v2',
      name: 'Search relevance v2',
      storageKey: 'search-relevance-v2',
      runCount: 6,
      startedAt: '2026-08-01T10:00:00.000Z',
      startedAtSource: 'runs',
      classification: {
        kind: 'engineering',
        status: 'partial',
        research: 'absent',
        engineering: 'present',
        acceptedPointCount: 0,
        engineeringRunCount: 6,
        reasons: ['No accepted research measurements were found', '6 engineering runs with execution evidence'],
        issues: [workflowIssue()],
      },
    },
    cost: {
      status: 'partial',
      value: {
        wallMs: 420_000,
        tokens: 12_000,
        runCoverage: { succeeded: 0, failed: 6, total: 6 },
        wallCoverage: { succeeded: 4, failed: 2, total: 6 },
        tokenCoverage: { succeeded: 1, failed: 5, total: 6 },
      },
      coverage: { succeeded: 0, failed: 6, total: 6 },
      issues: [
        { code: 'cost-timing-incomplete', summary: 'Wall-clock timing is incomplete', affectedRuns: refs.slice(0, 2) },
        { code: 'cost-token-telemetry-incomplete', summary: 'Token or attempt telemetry is incomplete', affectedRuns: refs.slice(0, 5) },
      ],
    },
    attention: complete({
      items: [{
        id: 'approval:1',
        kind: 'approval',
        title: 'Deploy production',
        reason: 'Review deployment evidence',
        href: '/inbox',
        priority: 'high',
      }],
      total: 1,
      shown: 1,
    }),
    activity: complete({ items: [], total: 0, shown: 0 }),
    research: complete(null),
    engineering: complete({
      latest: {
        runId: refs[0].runId,
        shortName: 'P6',
        fullTitle: 'P6: Address the failing relevance check',
        status: 'failed',
        statusExplanation: 'Execution failed',
        conclusion: longFailure,
        commits: [],
        filesChanged: [],
        gates: ['reality: failed'],
        href: refs[0].href,
      },
      deliveryCount: 1,
    }),
    runs: {
      status: 'partial',
      value: {
        items: [{
          runId: refs[0].runId,
          shortName: 'P6',
          fullTitle: 'P6: Address the failing relevance check',
          status: 'failed',
          statusExplanation: 'Execution failed',
          conclusion: longFailure,
          durationMs: 60_000,
          durationPartial: false,
          commits: [],
          gates: [],
          zeroWork: true,
          zeroWorkReason: 'No delivery evidence: no commits and no completed execution stage.',
          startedAt: '2026-08-03T10:00:00.000Z',
          completedAt: '2026-08-03T10:01:00.000Z',
          href: refs[0].href,
        }],
        shown: 1,
        total: 6,
        nextCursor: null,
        truncated: false,
      },
      coverage: { succeeded: 0, failed: 6, total: 6 },
      issues: [workflowIssue()],
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('campaign read-through presentation', () => {
  it('states lower bounds and uncertainty scale once, with ordered short-name details one click away', () => {
    const rendered = render(<MemoryRouter><CampaignPage view={operatorView()} /></MemoryRouter>);
    const cost = rendered.container.querySelector<HTMLElement>('.campaign-cost')!;
    const headline = cost.querySelector<HTMLElement>('.campaign-source-notice>div')!;

    expect(cost).toHaveTextContent('At least 7 min of run wall-clock time');
    expect(cost).toHaveTextContent('At least 12.0K total tokens');
    expect(headline).toHaveTextContent('6 of 6 runs have incomplete cost evidence');
    expect(headline).toHaveTextContent('wall-clock timing is incomplete for 2 runs');
    expect(headline).toHaveTextContent('token or attempt telemetry is incomplete for 5 runs');
    expect(headline.textContent).not.toContain('2026-08-');

    const classification = rendered.container.querySelector<HTMLElement>('.campaign-conclusions .campaign-source-notice')!;
    const history = rendered.container.querySelector<HTMLElement>('.campaign-ledger .campaign-source-notice')!;
    expect(classification.querySelector(':scope>div')).toHaveTextContent('Workflow evidence is missing · 6 runs affected');
    expect(history.querySelector(':scope>div')).toHaveTextContent('Workflow evidence is missing · 6 runs affected');
    for (const notice of [classification, history]) {
      const details = notice.querySelector<HTMLDetailsElement>('details')!;
      fireEvent.click(details.querySelector('summary')!);
      expect(details.open).toBe(true);
      expect([...details.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['P6', 'P5', 'P4', 'P3', 'P2', 'P1']);
      expect(details.textContent).not.toContain('2026-08-');
    }
  });

  it('keeps rows scannable and labels failed artifact-less work as a run, not a delivery', () => {
    const rendered = render(<MemoryRouter><CampaignPage view={operatorView()} /></MemoryRouter>);
    const row = rendered.container.querySelector<HTMLElement>('.campaign-run-row')!;
    const title = row.querySelector<HTMLDetailsElement>('.campaign-run-title')!;
    const reason = row.querySelector<HTMLDetailsElement>('.campaign-run-conclusion-details')!;
    const latestReason = rendered.container.querySelector<HTMLDetailsElement>('[data-testid="engineering-conclusion"] .campaign-run-conclusion-details')!;

    expect(rendered.container).toHaveTextContent('Latest engineering run');
    expect(rendered.container).not.toHaveTextContent('Latest engineering delivery');
    expect(title.querySelector('.campaign-run-title-label')).toHaveTextContent('P6');
    expect(title.querySelector('.campaign-run-title-full')).toHaveTextContent('P6: Address the failing relevance check');
    expect(title.textContent).not.toContain('TASK —');
    expect(reason.querySelector('summary')!.textContent!.length).toBeLessThanOrEqual(190);
    expect(reason.querySelector('p')!.textContent!.length).toBeGreaterThan(1_000);
    expect(latestReason.querySelector('summary')!.textContent!.length).toBeLessThanOrEqual(190);
    expect(latestReason.querySelector('p')!.textContent!.length).toBeGreaterThan(1_000);
    fireEvent.click(reason.querySelector('summary')!);
    expect(reason.open).toBe(true);
  });

  it('keeps metadata after the primary history flow and explains engineering campaigns without failure language', () => {
    const rendered = render(<MemoryRouter><CampaignPage view={operatorView()} /></MemoryRouter>);
    const ledger = rendered.container.querySelector<HTMLElement>('.campaign-ledger')!;
    const metadata = rendered.container.querySelector<HTMLElement>('.campaign-metadata')!;
    const position = ledger.compareDocumentPosition(metadata);

    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(metadata).toHaveTextContent('Campaign type');
    expect(metadata).toHaveTextContent('research measurements are not required');
    expect(rendered.container).not.toHaveTextContent('Evidence type');
    expect(rendered.container).not.toHaveTextContent('no accepted measurement point is proven');
  });
});
