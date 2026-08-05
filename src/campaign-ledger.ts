/**
 * Ledger primitive — the loop's accumulated memory across a campaign's runs.
 *
 * Aggregates every prior run's measured candidates (research_journal rounds: label → result) and
 * dead-ends (KG `dead_end` nodes) into a compact, deduped digest injected as {ledger_digest}. The
 * Propose step reads it to AVOID re-proposing already-tried directions and converge toward the
 * frontier. Always injected (even with --campaign-context=skip or its legacy alias): it is the
 * compact "what's been tried" ledger, distinct from the verbose narrative context that mode suppresses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsRoot } from './store.js';
import { readCampaignEntries } from './campaigns.js';

interface JournalRound { label?: unknown; result?: unknown }
interface KgNodeLite { type?: unknown; text?: unknown; label?: unknown }

/** Compact cross-run digest of tried candidates (best result per label) + dead-ends for a campaign. */
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
  const deadEnds = new Set<string>();
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
      const kp = join(runsRoot(), runId, 'knowledge_graph.json');
      if (existsSync(kp)) {
        const graph = JSON.parse(readFileSync(kp, 'utf-8')) as { nodes?: KgNodeLite[] };
        for (const node of graph.nodes ?? []) {
          if (node.type === 'dead_end') {
            const text = String(node.text ?? node.label ?? '').trim();
            if (text) deadEnds.add(text);
          }
        }
      }
    } catch { /* skip unreadable run */ }
  }

  if (!tried.size && !deadEnds.size) return 'none';
  const parts: string[] = [];
  if (tried.size) {
    const lines = [...tried.entries()].slice(0, cap).map(([label, result]) => `- ${label} → ${result}`);
    parts.push(`Tried directions (${tried.size} — do NOT re-propose the same mechanism):\n${lines.join('\n')}`);
  }
  if (deadEnds.size) {
    // Dead ends are durable safety knowledge. The display cap only bounds tried
    // directions; truncating this set can make a later planner repeat a known trap.
    const lines = [...deadEnds].map((d) => `- ${d}`);
    parts.push(`Dead ends (${deadEnds.size} — avoid):\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}
