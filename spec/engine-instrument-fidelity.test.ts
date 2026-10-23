import { describe, expect, it } from 'vitest';
import {
  assessCampaignHygiene,
  CAMPAIGN_CONTEXT_SKIP_THRESHOLD,
} from '../src/campaign-hygiene.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';

function ended(seq: number, status: string): CampaignHistoryEntry {
  return {
    seq,
    runId: `run-${seq}`,
    kind: 'task_ended',
    pass: status === 'complete',
    status,
    timestamp: `2026-08-01T00:0${seq}:00.000Z`,
  };
}

describe('engine instrument fidelity boundaries', () => {

  it('derives the adverse-history threshold used by reporting and launch', () => {
    const sweep = [0, 1, 2, 3, 4].map((adverse) => assessCampaignHygiene([
      ...Array.from({ length: adverse }, (_, index) => ended(index + 1, 'failed')),
      ...Array.from({ length: 4 - adverse }, (_, index) => ended(adverse + index + 1, 'complete')),
    ]).suggestContextSkip);

    expect(CAMPAIGN_CONTEXT_SKIP_THRESHOLD).toBe(3);
    expect(sweep).toEqual([false, false, false, true, true]);
  });

});
