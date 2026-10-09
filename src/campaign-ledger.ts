/**
 * Ledger primitive — the loop's accumulated memory across a campaign's runs.
 *
 * Aggregates every prior run's measured candidates (research_journal rounds: label → result) into
 * a compact, deduped digest injected as {ledger_digest}. The Propose step reads it to AVOID
 * re-proposing already-tried directions and converge toward the frontier. Always injected (even
 * with --campaign-context=skip or its legacy alias): it is the compact "what's been tried" ledger,
 * distinct from the verbose narrative context that mode suppresses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsRoot } from './store.js';
import { readCampaignEntries } from './campaigns.js';

interface JournalRound { label?: unknown; result?: unknown }

/** Compact cross-run digest of tried candidates (best result per label) for a campaign. */
export function summarizeLedger(projectDir: string, campaignId: string | undefined, opts: { cap?: number } = {}): string {
  if (!campaignId) return 'none';
  const cap = opts.cap ?? 40;
  let runIds: string[];
  try {
    runIds = [...new Set(readCampaignEntries(projectDir, campaignId).map((e) => e.runId).filter((v): v is string => !!v))];
  } catch {
    return 'none';
  }

  const tried = new Map<string, number>(); // label → best result seen
  for (const runId of runIds) {
    try {
      const jp = join(runsRoot(), runId, 'research_journal.json');
      if (existsSync(jp)) {
        const journal = JSON.parse(readFileSync(jp, 'utf-8')) as { rounds?: JournalRound[] };
        for (const round of journal.rounds ?? []) {
          if (typeof round.label === 'string' && typeof round.result === 'number') {
            const prev = tried.get(round.label);
            if (prev === undefined || round.result > prev) tried.set(round.label, round.result);
          }
        }
      }
    } catch { /* skip unreadable run */ }
  }

  if (!tried.size) return 'none';
  const lines = [...tried.entries()].slice(0, cap).map(([label, result]) => `- ${label} → ${result}`);
  return `Tried directions (${tried.size} — do NOT re-propose the same mechanism):\n${lines.join('\n')}`;
}
