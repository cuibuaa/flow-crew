import { describe, expect, it } from 'vitest';
import {
  assessCampaignHygiene,
  CAMPAIGN_CONTEXT_SKIP_THRESHOLD,
} from '../src/campaign-hygiene.js';
import { classifyGenericPathLexeme } from '../src/path-lexeme.js';
import { type StageConfig } from '../src/scheduler.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import type { RunEvent } from '../src/run-events.js';

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

  it('classifies regex escapes and acronym labels as text but literal paths as paths', () => {
    const rows = [
      { value: String.raw`input\.md`, context: 'literal' as const },
      { value: String.raw`docs\/report\.md`, context: 'literal' as const },
      { value: String.raw`scheduler\.ts`, context: 'literal' as const },
      { value: String.raw`/stages\/[a-z]+\/input\.md/`, context: 'literal' as const },
      { value: 'CPI/FOMC', context: 'prose' as const },
      { value: 'input/.md', context: 'prose' as const },
      { value: 'scheduler/.ts', context: 'prose' as const },
      { value: 'docs/report.md', context: 'prose' as const },
      { value: 'config/.env', context: 'prose' as const },
      { value: String.raw`docs\report.md`, context: 'literal' as const },
    ].map(({ value, context }) => ({ value, decision: classifyGenericPathLexeme(value, context).kind }));

    expect(rows).toEqual([
      { value: String.raw`input\.md`, decision: 'text' },
      { value: String.raw`docs\/report\.md`, decision: 'text' },
      { value: String.raw`scheduler\.ts`, decision: 'text' },
      { value: String.raw`/stages\/[a-z]+\/input\.md/`, decision: 'text' },
      { value: 'CPI/FOMC', decision: 'text' },
      { value: 'input/.md', decision: 'text' },
      { value: 'scheduler/.ts', decision: 'text' },
      { value: 'docs/report.md', decision: 'path' },
      { value: 'config/.env', decision: 'path' },
      { value: String.raw`docs\report.md`, decision: 'path' },
    ]);
  });

  

  

  
});
