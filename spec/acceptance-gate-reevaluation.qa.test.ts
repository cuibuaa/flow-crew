import { describe, expect, it } from 'vitest';
import {
  formatCampaignContextBlock,
  selectRelevantCampaignContext,
} from '../src/campaign-context.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import { RUN_STATUS } from '../src/store.js';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

function phaseEntry(overrides: Partial<CampaignHistoryEntry>): CampaignHistoryEntry {
  return {
    seq: 1,
    runId: 'reevaluation-phase-chain',
    pass: true,
    status: RUN_STATUS.RUNNING,
    timestamp: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('acceptance re-evaluation: latest phase completion arbitration', () => {
  it('uses sequence order rather than caller array order to identify the chain-closing completion', () => {
    const selection = selectRelevantCampaignContext([
      phaseEntry({ seq: 30, phase: 'phase-three', phaseComplete: true }),
      phaseEntry({ seq: 10, phase: 'phase-one', phaseComplete: true, nextPhase: 'phase-two' }),
      phaseEntry({ seq: 20, phase: 'phase-two', phaseComplete: true, nextPhase: 'phase-three' }),
    ], NOW);

    expect(selection.recommendedPhase).toBeUndefined();
    expect(formatCampaignContextBlock({ campaignLabel: 'unordered-chain', selection })).toBe('');
  });

  it('lets the newest timestamp break an otherwise tied completion without reviving an older handoff', () => {
    const selection = selectRelevantCampaignContext([
      phaseEntry({
        seq: 7,
        iteration: 2,
        timestamp: '2026-07-31T11:59:00.000Z',
        phase: 'phase-one',
        phaseComplete: true,
        nextPhase: 'obsolete-handoff',
      }),
      phaseEntry({
        seq: 7,
        iteration: 2,
        timestamp: '2026-07-31T12:00:00.000Z',
        phase: 'phase-two',
        phaseComplete: true,
        nextPhase: '   ',
      }),
    ], NOW);

    expect(selection.recommendedPhase).toBeUndefined();
    expect(formatCampaignContextBlock({ campaignLabel: 'timestamp-tie', selection })).toBe('');
  });

  it('allows genuinely newer active progress after a closed chain to establish a new recommendation', () => {
    const selection = selectRelevantCampaignContext([
      phaseEntry({ seq: 1, phase: 'phase-one', phaseComplete: true, nextPhase: 'phase-two' }),
      phaseEntry({ seq: 2, phase: 'phase-two', phaseComplete: true }),
      phaseEntry({ seq: 3, phase: 'phase-three', phaseComplete: false }),
    ], NOW);
    const context = formatCampaignContextBlock({ campaignLabel: 'reopened-chain', selection });

    expect(selection.recommendedPhase).toBe('phase-three');
    expect(context).toContain('Current recommended phase: phase-three');
    expect(context).not.toContain('Current recommended phase: phase-two');
  });
});
