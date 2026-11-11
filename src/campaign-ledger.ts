import { readResearchHistory } from './research-history.js';
/**
 * Ledger primitive — the loop's accumulated memory across a campaign's runs.
 *
 * Aggregates every prior run's measured candidates through the shared historical read projection into
 * a compact digest with run provenance injected as {ledger_digest} so proposals can use prior evidence. Always injected
 * (even with --campaign-context=skip or its legacy alias): it is the compact "what's been tried" ledger,
 * distinct from the verbose narrative context that mode suppresses.
 */
import { join } from 'node:path';
import { runsRoot } from './store.js';
import { readCampaignEntries } from './campaigns.js';


/** Compact cross-run digest of tried candidates; display labels never identify a round. */
export function summarizeLedger(projectDir: string, campaignId: string | undefined, opts: { cap?: number } = {}): string {
  if (!campaignId) return 'none';
  const cap = opts.cap ?? 40;
  let runIds: string[];
  try {
    runIds = [...new Set(readCampaignEntries(projectDir, campaignId).map((e) => e.runId).filter((v): v is string => !!v))];
  } catch {
    return 'none';
  }

  const tried: Array<{ runId: string; label: string; result: number }> = [];
  for (const runId of runIds) {
    try {
      const journal = readResearchHistory(join(runsRoot(), runId)).value;
      if (journal) {
        for (const round of journal.rounds ?? []) {
          if (typeof round.label === 'string' && typeof round.result === 'number') {
            tried.push({ runId, label: round.label, result: round.result });
          }
        }
      }
    } catch { /* skip unreadable run */ }
  }

  if (!tried.length) return 'none';
  const lines = tried.slice(0, cap).map(({ runId, label, result }) => `- ${runId}/${label} → ${result}`);
  return `Tried directions (${tried.length}):\n${lines.join('\n')}`;
}
