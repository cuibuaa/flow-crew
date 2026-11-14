import type { StoreState } from './store.js';
import { RUN_STATUS, resolveRunStatus, TERMINAL_STATUSES } from './lifecycle-status.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { updateFileHashSync } from './rollback-content-store.js';
import type { ResearchInstrumentState, ResearchManifest } from './research-measurement.js';
import { RESEARCH_PROTOCOL, parseResearchJSON, type RecordRef } from './research-instrument.js';
import { runRecordPath } from './run-layout.js';
// Read-only journal decoding replaces the history → execution import cycle.
// Status/summary imports must never initialize the instrument process runner.
const read = <T>(path: string): T => parseResearchJSON(readFileSync(path, 'utf8')) as T;
export interface ResearchCommit { previousRevision: number; state: ResearchInstrumentState }
export function verifyResearchRef(record: RecordRef): void {
  const hash = createHash('sha256'); updateFileHashSync(record.path, hash);
  if (hash.digest('hex') !== record.sha256) throw new Error('research_record_digest_mismatch');
}
/** A commit contains result, opaque state and best pointer together. state.json
 * is a projection: a crash after commit replays it without running the program. */
export function readCommittedResearchState(run: string): ResearchInstrumentState {
  const root = runRecordPath(run, 'research_measurement'), path = join(root, 'state.json');
  let state = read<ResearchInstrumentState>(path);
  if (state.protocol !== RESEARCH_PROTOCOL) throw new Error(`Expected ${RESEARCH_PROTOCOL}; legacy records are read-only`);
  const commits = join(root, 'commits');
  if (existsSync(commits)) for (const name of readdirSync(commits).sort()) {
    const commit = read<ResearchCommit>(join(commits, name));
    if (commit.state.revision <= state.revision) continue;
    if (commit.previousRevision !== state.revision || commit.state.revision !== state.revision + 1) throw new Error('research_commit_revision_mismatch');
    state = commit.state;
  }
  for (const outcome of state.history) {
    if (outcome.request) verifyResearchRef(outcome.request);
    verifyResearchRef(outcome.result);
    if (outcome.raw) verifyResearchRef(outcome.raw);
  }
  return state;
}

export interface Item { id: string; metrics: Record<string, number> }
export interface Observation {
  status: 'measured' | 'unmeasured'; fingerprint: string; candidate: string;
  items?: Item[]; reason?: string; detail?: string;
}
export interface GuardObservation {
  passes: boolean; reason?: string; detail?: string; name?: string; baseline?: number; candidate?: number;
  /** Optional independently collected guard identity, checked before its status. */
  fingerprint?: string; expectedFingerprint?: string;
}
export interface Comparison {
  keep: boolean; reason: string;
  metrics: Record<string, { baseline: number; candidate: number; improvement: number; noise: number; threshold: number; improved: boolean }>;
}

/** Historical JSON is a read model, never parsed as an active brief. */
export interface ProducerNotes { hypothesis: string; files_changed: string[]; property_evidence: string }
export interface HistoricalResearchConfig {
  baseline?: number; higherIsBetter?: boolean;
  measurement?: { frozen: string[]; candidate: string[]; primary: string[]; metrics: Record<string, { direction: 'min' | 'max'; scale: string }> };
}
/** A read model only: never admitted, executed, migrated or rewritten. */
export function legacyResearchConfig(value: unknown): HistoricalResearchConfig | undefined {
  if (!value || typeof value !== 'object' || 'protocol' in value) return undefined;
  return value as HistoricalResearchConfig;
}
export interface ResearchRound {
  label: string;
  notes?: ProducerNotes;
  review?: { pass: boolean; reason?: string };
  guards?: GuardObservation[];
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
  comparison?: Comparison;
  measurement?: Observation;
}

export interface ResearchEvaluation {
  runningBest: number;
  keptLabels: string[];
  latestKept: boolean;
  consecutiveNoImprovement: number;
  decision: 'ship' | 'continue' | 'stop_ceiling';
  reason: string;
}


export interface ResearchHistory { rounds: ResearchRound[]; baseline?: Observation }

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
  const historical = read('research_journal.json');
  return decodeLegacyResearchHistory(measured, historical, errors);
}

/** Explicit legacy decoder. Preserve unknown fields and recorded decisions;
 * a protocol record is never reinterpreted as the retired scientific model. */
export function decodeLegacyResearchHistory(measured: Record<string, unknown> | null,
  historical: Record<string, unknown> | null, errors: string[] = []): { value: ResearchHistory | null; error?: string } {
  if (measured?.protocol !== undefined) return { value: null };
  if (Array.isArray(measured?.rounds)) return { value: measured as unknown as ResearchHistory };
  if (Array.isArray(historical?.rounds)) return { value: { ...measured, ...historical } as unknown as ResearchHistory };
  if (measured?.baseline) return { value: { ...measured, rounds: [] } as unknown as ResearchHistory };
  if (historical) errors.push('Historical research journal has no rounds list');
  return { value: null, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/** Recorded scientific display metadata belongs only to legacy decoding. */
export function legacyResearchDisplay(config: unknown, baseline?: Observation) {
  const legacy = legacyResearchConfig(config);
  const primary = legacy?.measurement?.primary?.[0];
  return { primary, higherIsBetter: primary ? legacy!.measurement!.metrics?.[primary]?.direction !== 'min' : legacy?.higherIsBetter ?? true,
    baseline: primary ? baseline?.items?.reduce((sum, item) => sum + item.metrics[primary], 0) : legacy?.baseline };
}

/** One read-only projection of protocol records replaces metric reconstruction in
 * summaries and campaign views. The manifest wins; running runs use the same
 * committed journal as crash replay, without writing its state projection. */
export type ProtocolResearchRecord = Omit<ResearchManifest, 'engine_stop_reason'> & {
  engine_stop_reason?: string;
  publication?: { status: string; destination: string; error?: string; [key: string]: unknown };
};
export function readProtocolResearchRecord(directory: string): { value: ProtocolResearchRecord | null; error?: string } {
  try {
    const path = runRecordPath(directory, 'research_manifest.json');
    let value: ProtocolResearchRecord;
    if (existsSync(path)) value = parseResearchJSON(readFileSync(path, 'utf8')) as ProtocolResearchRecord;
    else {
      const statePath = runRecordPath(directory, 'research_measurement/state.json');
      if (!existsSync(statePath)) return { value: null };
      const header = parseResearchJSON(readFileSync(statePath, 'utf8')) as { protocol?: string };
      if (header.protocol !== RESEARCH_PROTOCOL) return { value: null };
      const state = readCommittedResearchState(directory);
      value = { protocol: state.protocol, run_id: state.runId, initial: state.initial, incumbent: state.incumbent,
        instrument_sha256: state.instrument.fingerprint, history: state.history, engine_stop_reason: state.termination?.reason,
        conclusion: state.termination?.conclusion };
    }
    if (value.protocol !== RESEARCH_PROTOCOL || !Array.isArray(value.history) || !value.incumbent) throw new Error('Invalid research protocol record');
    const publication = runRecordPath(directory, 'research_publication.json');
    if (existsSync(publication)) {
      try { value = { ...value, publication: parseResearchJSON(readFileSync(publication, 'utf8')) as ProtocolResearchRecord['publication'] }; }
      catch (error) { value = { ...value, publication: { status: 'unreadable', destination: '', error: String(error) } }; }
    }
    return { value };
  } catch (error) { return { value: null, error: String(error) }; }
}

/** Retired scientific presentation is isolated with the explicit legacy decoder.
 * It renders recorded decisions only and is never called for protocol runs. */
interface ResearchData {
  baseline?: import('./research-history.js').Observation;
  rounds: ResearchRound[];
  decision: Partial<ResearchEvaluation> | null;
}

function readResearchData(runDir: string): ResearchData {
  const journal = readResearchHistory(runDir).value;
  let decision: Partial<ResearchEvaluation> | null = null;
  try { decision = JSON.parse(readFileSync(runRecordPath(runDir, 'research_decision.json'), 'utf8')); } catch { /* archived decision unavailable */ }
  return { rounds: journal?.rounds ?? [], decision, baseline: journal?.baseline };
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderResearchOutcome(state: StoreState, data: ResearchData): string {
  const { higherIsBetter, baseline } = legacyResearchDisplay(state.research, data.baseline);
  const best = data.decision?.runningBest;
  const lines: string[] = [];
  // FIX C — the Decision label must derive from the TERMINAL run.json status, not the
  // research_decision.json snapshot, which can be STALE: rounds integrity-rejected after the
  // last decision write never refresh it, so a snapshot reading `continue`/`ship` can contradict
  // a true terminal `ceiling_hit`/`incomplete`. When the run is terminal, the run.json status is
  // authoritative; the snapshot `reason` is only used as supplementary text and only when the
  // snapshot is consistent with the terminal status (else it would echo a stale rationale).
  const statusResolution = resolveRunStatus(state.status);
  const isTerminal = statusResolution.kind === 'known'
    && TERMINAL_STATUSES.includes(statusResolution.status);
  // Map the terminal status to the policy-decision vocabulary used in the summary.
  const terminalDecisionLabel = statusResolution.kind === 'known'
    ? statusResolution.status === RUN_STATUS.SHIPPED ? 'ship'
      : statusResolution.status === RUN_STATUS.CEILING_HIT ? 'stop_ceiling' : statusResolution.status
    : `unrecognized ${statusResolution.display}`;
  // The snapshot is "consistent" with the terminal only when it agrees (e.g. a real ship snapshot
  // on a shipped run, or a stop_ceiling snapshot on a ceiling_hit run). A `continue` snapshot on a
  // terminal run is by definition stale.
  const snapshotConsistent = isTerminal && data.decision?.decision === terminalDecisionLabel;
  const decisionLabel = isTerminal ? terminalDecisionLabel : (data.decision?.decision ?? state.status);
  const reasonSuffix = snapshotConsistent && data.decision?.reason ? ` — ${data.decision.reason}`
    : (!isTerminal && data.decision?.reason ? ` — ${data.decision.reason}` : '');
  lines.push(`- **Decision:** ${decisionLabel}${reasonSuffix}`);
  if (typeof baseline === 'number' && typeof best === 'number') {
    const delta = best - baseline;
    const improved = higherIsBetter ? delta > 0 : delta < 0;
    const pct = baseline !== 0 ? ` (${delta >= 0 ? '+' : ''}${((delta / Math.abs(baseline)) * 100).toFixed(2)}%)` : '';
    lines.push(`- **Metric:** baseline ${fmtNum(baseline)} → best ${fmtNum(best)}${pct} ${improved ? '↑ improved' : '→ no improvement'}`);
  } else if (typeof best === 'number') {
    lines.push(`- **Running-best:** ${fmtNum(best)}`);
  }
  // Budget-exhaustion decisions contain terminal authority, without measured
  // retention/streak fields. Report those quantities only when recorded.
  const kept = Array.isArray(data.decision?.keptLabels) ? ` | kept: ${data.decision.keptLabels.length}` : '';
  const streak = typeof data.decision?.consecutiveNoImprovement === 'number'
    ? ` | no-improvement streak: ${data.decision.consecutiveNoImprovement}` : '';
  lines.push(`- **Rounds:** ${data.rounds.length}${kept}${streak}`);
  const wall = data.rounds.at(-1)?.wallHoursCumulative;
  if (typeof wall === 'number') lines.push(`- **Wall time:** ${wall.toFixed(1)}h`);
  return `## Outcome\n${lines.join('\n')}`;
}

function renderRoundsSection(data: ResearchData): string {
  if (data.rounds.length === 0) return '';
  const kept = new Set(Array.isArray(data.decision?.keptLabels) ? data.decision.keptLabels : []);
  const MAX = 25;
  const shown = data.rounds.slice(-MAX);
  const lines = shown.map((r) => r.outcome === 'no_candidate'
    ? `- ${r.label}: no candidate${r.reason ? ` — ${r.reason}` : ''}`
    : r.outcome === 'review_rejected' ? `- ${r.label}: review rejected — ${r.reason ?? 'candidate properties rejected'}`
    : r.outcome === 'unmeasured' ? `- ${r.label}: unmeasured — ${r.measurement?.detail ?? r.reason ?? 'measurement unavailable'}`
    : `- ${r.label}: ${typeof r.result === 'number' ? fmtNum(r.result) : 'invalid measurement'}${(r.comparison ? r.comparison.keep : kept.has(r.label)) ? ' ✓ kept' : ''}`);
  let out = `## Rounds (${data.rounds.length})\n${lines.join('\n')}`;
  if (data.rounds.length > MAX) out = `## Rounds (${data.rounds.length}, showing last ${MAX})\n${lines.join('\n')}`;
  return out;
}

export function renderLegacyResearchSummary(directory: string, state: StoreState): string {
  const data = readResearchData(directory);
  return [renderResearchOutcome(state, data), renderRoundsSection(data)].filter(Boolean).join('\n\n');
}

/** Archived campaign status aliases are a legacy display convention, never a
 * verdict for protocol runs. */
export function acceptsLegacyCampaignMeasurement(status: unknown): boolean {
  return status === 'valid_ship' || status === RUN_STATUS.SHIPPED || status === RUN_STATUS.CEILING_HIT;
}
