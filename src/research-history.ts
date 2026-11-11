import { readFileSync } from 'node:fs';
import { runRecordPath } from './run-layout.js';
/** Historical JSON is a read model, never parsed as an active brief. */
export interface ProducerNotes { hypothesis: string; files_changed: string[]; property_evidence: string }
export interface HistoricalResearchConfig { baseline?: number; higherIsBetter?: boolean }
export interface ResearchRound {
  label: string;
  notes?: ProducerNotes;
  review?: { pass: boolean; reason?: string };
  guards?: import('./research-measurement.js').GuardObservation[];
  candidate?: string;
  /** Present only for a measured round. No-candidate rounds deliberately omit
   * it so the journal never presents the configured baseline as an observation. */
  result?: number;
  /** A round may legitimately discover that there is no safe acting candidate.
   * It consumes budget and counts as no improvement without fabricating a
   * measurement equal to the baseline. */
  outcome?: 'measured' | 'unmeasured' | 'no_candidate' | 'review_rejected';
  reason?: string;
  /** Optional structured evidence copied from the no-candidate sidecar. */
  evidence?: unknown;
  /** Cross-run standard error of this round's result (from result_std), if reported.
   *  Used to require an improvement to clear the measurement noise before it counts. */
  resultStd?: number;
  /** Cumulative wall hours across the program up to and including this round. */
  wallHoursCumulative?: number;
  /** True when the brief-declared confirm gate rejected this round's ship attempt.
   *  A confirm-failed round is UNCONFIRMED: it must never be kept or count as
   *  running-best (else the same unconfirmed number re-triggers ship→confirm→fail
   *  on every subsequent evaluation), but it still counts toward round budgets
   *  and the no-improvement streak. */
  confirmFailed?: boolean;
  /** Set only by the engine-owned measurement settlement. */
  comparison?: import('./research-measurement.js').Comparison;
  measurement?: import('./research-measurement.js').Observation;
}

export interface ResearchEvaluation {
  runningBest: number;
  keptLabels: string[];
  latestKept: boolean;
  consecutiveNoImprovement: number;
  decision: 'ship' | 'continue' | 'stop_ceiling';
  reason: string;
}


export interface ResearchHistory { rounds: ResearchRound[]; baseline?: import('./research-measurement.js').Observation }

/** Historical measurement runs wrote both records, but only the legacy journal
 * had rounds. Select by structure, not merely by the newer file's existence. */
export function readResearchHistory(directory: string): { value: ResearchHistory | null; error?: string } {
  const errors: string[] = [];
  const read = (path: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(readFileSync(runRecordPath(directory, path), 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      errors.push(`${path}: expected a record`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${path}: ${String(error)}`);
    }
    return null;
  };
  const measured = read('research_measurement/state.json');
  if (Array.isArray(measured?.rounds)) return { value: measured as unknown as ResearchHistory };
  const historical = read('research_journal.json');
  if (Array.isArray(historical?.rounds)) return { value: { ...measured, ...historical } as unknown as ResearchHistory };
  if (measured?.baseline) return { value: { ...measured, rounds: [] } as unknown as ResearchHistory };
  if (historical) errors.push('Historical research journal has no rounds list');
  return { value: null, ...(errors.length ? { error: errors.join('; ') } : {}) };
}
