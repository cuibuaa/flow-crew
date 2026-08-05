import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCampaignOperatorView,
  type CampaignInboxOverviewLike,
  type CampaignPageSources,
} from '../src/campaign-page.js';
import { fetchCampaignOperatorView } from '../ui/src/components/campaign/client.js';

const CAMPAIGN_ID = 'qa-campaign-source-failure';
const PROJECT_DIR = '/tmp/flowcrew-qa-campaign-project';

function emptyInbox(): CampaignInboxOverviewLike {
  return {
    approvals: { status: 'complete', items: [] },
    deferred: { status: 'complete', items: [] },
    stale: { status: 'complete', items: [] },
    patches: { status: 'complete', items: [], coverage: { succeeded: 1, failed: 0 } },
  };
}

function baseSources(): Partial<CampaignPageSources> {
  return {
    listCampaigns: () => [{
      id: CAMPAIGN_ID,
      name: 'QA source failure campaign',
      storageKey: CAMPAIGN_ID,
      runCount: 1,
      bestScore: null,
    }],
    listRunRecords: () => [],
    readCampaignEntries: () => [],
    readInbox: async () => emptyInbox(),
    readTasks: async () => [],
    hasLiveWorker: () => null,
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('independent anti-cheat probes', () => {
  it('marks classification evidence unknown when a known campaign run cannot be read', async () => {
    const sources = baseSources();
    sources.listRunRecordsByCampaign = () => [{
      runId: 'known-but-unreadable',
      campaignId: CAMPAIGN_ID,
      campaignStorageKey: CAMPAIGN_ID,
      campaignName: 'QA source failure campaign',
      status: 'complete',
    }];
    sources.readRunState = () => { throw new Error('run.json corrupt'); };

    const view = await readCampaignOperatorView(PROJECT_DIR, CAMPAIGN_ID, sources);

    expect(view.identity.classification).toMatchObject({
      kind: 'unknown',
      status: 'partial',
      research: 'unknown',
      engineering: 'unknown',
    });
    expect({
      cost: view.cost.status,
      activity: view.activity.status,
      research: view.research.status,
      engineering: view.engineering.status,
      runs: view.runs.status,
    }).toEqual({
      cost: 'unavailable',
      activity: 'unavailable',
      research: 'unavailable',
      engineering: 'unavailable',
      runs: 'unavailable',
    });
  });

  it('does not report complete zero cost or a complete empty ledger when run discovery fails', async () => {
    const sources = baseSources();
    sources.listRunRecordsByCampaign = () => { throw new Error('run index unreadable'); };
    sources.readRunState = () => { throw new Error('run state unavailable'); };

    const view = await readCampaignOperatorView(PROJECT_DIR, CAMPAIGN_ID, sources);

    expect({
      cost: view.cost.status,
      runs: view.runs.status,
      classification: view.identity.classification,
    }).toEqual({
      cost: 'unavailable',
      runs: 'unavailable',
      classification: expect.objectContaining({
        kind: 'unknown',
        status: 'partial',
        research: 'unknown',
        engineering: 'unknown',
      }),
    });
  });

  it('rejects a malformed operator view before React can dereference missing identity fields', async () => {
    const source = (value: unknown) => ({
      status: 'complete',
      value,
      coverage: { succeeded: 1, failed: 0, total: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        generatedAt: '2026-08-02T12:00:00.000Z',
        identity: {},
        cost: source(null),
        attention: source(null),
        activity: source(null),
        research: source(null),
        engineering: source(null),
        runs: source({ items: [] }),
      }),
    })));

    await expect(fetchCampaignOperatorView(CAMPAIGN_ID)).rejects.toThrow(/contract|identity|响应|契约/i);
  });
});
