import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCampaignOperatorView } from '../ui/src/components/campaign/client.js';

const source = (value: unknown) => ({
  status: 'complete',
  value,
  coverage: { succeeded: 1, failed: 0, total: 1 },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('campaign operator-view client contract', () => {
  it('rejects malformed identity and source values before rendering', async () => {
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

    await expect(fetchCampaignOperatorView('malformed-fixture'))
      .rejects.toThrow(/identity.*contract/i);
  });

  it('validates each source payload after identity passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        generatedAt: '2026-08-02T12:00:00.000Z',
        identity: {
          id: 'malformed-fixture',
          name: 'Malformed fixture',
          storageKey: 'malformed-fixture',
          runCount: 1,
          startedAt: null,
          startedAtSource: 'unknown',
          classification: {
            kind: 'unknown',
            status: 'complete',
            research: 'absent',
            engineering: 'absent',
            acceptedPointCount: 0,
            engineeringRunCount: 0,
            reasons: [],
            issues: [],
          },
        },
        cost: source(null),
        attention: source({ items: [], total: 0, shown: 0 }),
        activity: source({ items: [], total: 0, shown: 0 }),
        research: source(null),
        engineering: source(null),
        runs: source({ items: [], shown: 0, total: 0, nextCursor: null, truncated: false }),
      }),
    })));

    await expect(fetchCampaignOperatorView('malformed-fixture'))
      .rejects.toThrow(/cost.*contract/i);
  });

  it('rejects the retired flattened error prose instead of making the browser parse it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        generatedAt: '2026-08-02T12:00:00.000Z',
        identity: {
          id: 'structured-fixture',
          name: 'Structured fixture',
          storageKey: 'structured-fixture',
          runCount: 0,
          startedAt: null,
          startedAtSource: 'unknown',
          classification: {
            kind: 'unknown', status: 'complete', research: 'absent', engineering: 'absent',
            acceptedPointCount: 0, engineeringRunCount: 0, reasons: [], issues: [],
          },
        },
        cost: source({
          wallMs: 0,
          tokens: 0,
          supervisorTokens: 0,
          runCoverage: { succeeded: 0, failed: 0, total: 0 },
          wallCoverage: { succeeded: 0, failed: 0, total: 0 },
          tokenCoverage: { succeeded: 0, failed: 0, total: 0 },
        }),
        attention: source({ items: [], total: 0, shown: 0 }),
        activity: source({ items: [], total: 0, shown: 0 }),
        research: source(null),
        engineering: source(null),
        runs: {
          status: 'partial',
          value: { items: [], shown: 0, total: 1, nextCursor: null, truncated: false },
          coverage: { succeeded: 0, failed: 1, total: 1 },
          error: 'workflow for run-1 is missing',
        },
      }),
    })));

    await expect(fetchCampaignOperatorView('structured-fixture'))
      .rejects.toThrow(/run history.*contract/i);
  });
});
