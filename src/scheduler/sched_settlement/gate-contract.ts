// Boundary: Metric agreement and threshold policy plus declared contract readers; no scheduler state mutation or launching.
import { RUN_STATUS, runDir } from '../../store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explicitPassContradiction } from './gate-evidence.js';

/**
 * Campaign-level gate contract. When present (in `<run_dir>/gate_contract.json`,
 * or copied from `<project>/.fc/campaigns/<campaign_storage_key>/contract.json`
 * at run start), gate verdicts are validated against this contract — preventing
 * agents from silently downgrading the metric or threshold to fake-pass a gate.
 *
 * Example:
 *   { "metric": "qa_skeptical_audience",
 *     "metricSynonyms": ["AIDialyRealAudienceQAGateScore"],
 *     "threshold": 9.5,
 *     "higherIsBetter": true,
 *     "appliesToGates": ["qa_gate", "final_gate"] }
 */
export interface GateContract {
  metric: string;
  metricSynonyms?: string[];
  threshold: number;
  higherIsBetter?: boolean;
  /** Optional whitelist of gate stage IDs the contract applies to. If absent, applies to all is_gate stages. */
  appliesToGates?: string[];
}

export const GATE_METRIC_SYNONYMS: Record<string, string[]> = {
  qa_skeptical_audience: ['skeptical_audience', 'qa_audience'],
};

export function metricNamesMatch(
  metricName: string,
  verdictName: string,
  contract?: GateContract | null,
): boolean {
  const metric = metricName.toLowerCase();
  const verdict = verdictName.toLowerCase();
  if (metric === verdict) return true;
  if ((GATE_METRIC_SYNONYMS[metric] ?? []).map(s => s.toLowerCase()).includes(verdict)
      || (GATE_METRIC_SYNONYMS[verdict] ?? []).map(s => s.toLowerCase()).includes(metric)) return true;
  if (!contract) return false;
  const contractedNames = new Set([
    contract.metric.toLowerCase(),
    ...(contract.metricSynonyms ?? []).map((name) => name.toLowerCase()),
  ]);
  return contractedNames.has(metric) && contractedNames.has(verdict);
}

/**
 * Does metric.json itself report a failure? Either an explicit `pass: false`, or
 * a numeric value that misses its own threshold. Used to decide whether a
 * metric-name difference could be masking anything.
 */
export function metricFileIndicatesFailure(metric: Record<string, unknown>): boolean {
  if (metric.pass === false) return true;
  const value = typeof metric.value === 'number'
    ? metric.value
    : typeof metric.score === 'number' ? metric.score : null;
  const threshold = typeof metric.threshold === 'number' ? metric.threshold : null;
  if (value === null || threshold === null) return false;
  const higherIsBetter = metric.higherIsBetter !== false && metric.higher_is_better !== false;
  return higherIsBetter ? value < threshold : value > threshold;
}

export function validateVerdictAgainstMetricFile(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown>,
  contract?: GateContract | null,
): string | null {
  const metricContradiction = explicitPassContradiction(metric, 'metric.json', verdict.pass === true);
  if (metricContradiction) return metricContradiction;
  // A threshold-free domain observation cannot overrule a passing report
  // audit whose declared measure is zero failing checks. There is no failing
  // threshold to hide in this narrow case; contracted or same-name measures
  // continue through the consistency checks below.
  const metricNotes = typeof metric.notes === 'string' ? metric.notes : '';
  const informationalMetric = metric.informational === true
    || (/\b(?:exploratory|informational|descriptive)\b/i.test(metricNotes)
      && /\b(?:report|audit) gate evaluates\b/i.test(metricNotes));
  if (!contract
    && informationalMetric
    && verdict.pass === true
    && typeof verdict.metric === 'string'
    && /^failing_(?:required_)?checks$/i.test(verdict.metric)
    && verdict.score === 0
    && verdict.threshold === 0
    && typeof metric.metric === 'string'
    && !metricNamesMatch(metric.metric, verdict.metric)
    && typeof metric.value === 'number'
    && Number.isFinite(metric.value)
    && metric.threshold == null) return null;
  if (metric.pass === false && verdict.pass === true) {
    // A closeout/ceiling-deliverable audit legitimately passes (the deliverable is valid)
    // while the beat-metric legitimately fails (no beat) — an honest negative is a valid
    // deliverable. The QA signals this with phase-completion metadata. Honor it from EITHER
    // file: the metric.json OR the verdict itself (observed thrash: the verdict carried
    // phaseComplete/nextPhase but an early metric.json attempt omitted them, so the gate was
    // re-rejected for iterations). This does not weaken the measure-round self-deception guard:
    // a measure round that falsely passes a non-beat is still caught unless it explicitly
    // declares a phase-completion, which the planner reserves for closeout phases.
    if (metric.phaseComplete === true || metric.phase_complete === true || metric.nextPhase || metric.next_phase) return null;
    if (verdict.phaseComplete === true || verdict.phase_complete === true || verdict.nextPhase || verdict.next_phase) return null;
    return 'verdict/metric.json mismatch: metric says fail, verdict says pass';
  }
  if (
    typeof metric.metric === 'string'
    && typeof verdict.metric === 'string'
    && !metricNamesMatch(metric.metric, verdict.metric, contract)
    // A rename is evidence of self-deception only when there is a failure for it
    // to hide. When the metric file reports no failure, the two files simply name
    // different things — a gate's own health metric ("failing_checks") beside the
    // domain metric the brief asked the stage to report — and rejecting that pair
    // makes the gate unpassable no matter what the stage does.
    && metricFileIndicatesFailure(metric)
  ) {
    return `metric name redefined: metric.json="${metric.metric}" vs verdict="${verdict.metric}"`;
  }
  if (
    typeof metric.metric === 'string'
    && typeof verdict.metric === 'string'
    && metricNamesMatch(metric.metric, verdict.metric, contract)
    && typeof metric.threshold === 'number'
    && typeof verdict.threshold === 'number'
    && (metric.higherIsBetter !== false && metric.higher_is_better !== false
      ? verdict.threshold < metric.threshold
      : verdict.threshold > metric.threshold)
  ) {
    return 'threshold downgraded';
  }
  return null;
}

export function loadGateContract(projectDir: string, runId?: string, campaignStorageKey?: string): GateContract | null {
  // 1. Per-run override (written by the planner or copied at run start)
  if (runId) {
    const p = join(runDir(projectDir, runId), 'gate_contract.json');
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      if (raw && typeof raw.metric === 'string' && typeof raw.threshold === 'number') return raw as GateContract;
    } catch { /* not found */ }
  }
  // 2. Campaign-level default
  if (campaignStorageKey) {
    const p = join(projectDir, '.fc', 'campaigns', campaignStorageKey, 'contract.json');
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      if (raw && typeof raw.metric === 'string' && typeof raw.threshold === 'number') return raw as GateContract;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Validate a gate verdict against the campaign's contract. Returns null if
 * the verdict honors the contract; returns an error string describing the
 * violation otherwise. Common violations:
 *   - verdict.metric doesn't match contract.metric or any synonym (gate redefined)
 *   - verdict.threshold downgraded below contract.threshold
 *   - verdict.pass is true but verdict.value doesn't satisfy contract.threshold
 *
 * Cross-references `<runDir>/stages/<stageId>/metric.json` to find the
 * authoritative `value` and `metric` name when the verdict file omits them.
 */
export function validateVerdictAgainstContract(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown> | null,
  contract: GateContract,
  stageId: string,
): string | null {
  if (contract.appliesToGates && !contract.appliesToGates.includes(stageId)) return null;
  const candidateValues: unknown[] = [verdict.value, verdict.score, metric?.value, metric?.score];
  const value = candidateValues.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );
  if (typeof value !== 'number') {
    return `missing required numeric gate value for metric="${contract.metric}"; only finite numeric evidence is accepted, no finite numeric value was found in the current verdict or metric.json, and contract threshold=${contract.threshold} must be checked mechanically.`;
  }
  const expectedMetric = contract.metric.toLowerCase();
  const synonyms = (contract.metricSynonyms ?? []).map(s => s.toLowerCase());
  const acceptableNames = new Set([expectedMetric, ...synonyms]);
  const verdictMetricName = typeof verdict.metric === 'string' ? verdict.metric.toLowerCase() : '';
  const metricFileName = metric && typeof metric.metric === 'string' ? metric.metric.toLowerCase() : '';
  const metricNameMatches = acceptableNames.has(verdictMetricName) || acceptableNames.has(metricFileName);
  if (!metricNameMatches) {
    return `verdict.metric="${verdict.metric ?? ''}" / metric.json.metric="${metric?.metric ?? ''}" does not match contract.metric="${contract.metric}" (synonyms=${JSON.stringify(contract.metricSynonyms ?? [])}). Gate metric was redefined — verdict invalid.`;
  }
  const higherIsBetter = contract.higherIsBetter !== false;
  const terminalOutcome = typeof metric?.outcome === 'string'
    ? metric.outcome
    : typeof verdict.outcome === 'string' ? verdict.outcome : undefined;
  const verifiedCampaignCeiling = verdict.pass === true
    && terminalOutcome === RUN_STATUS.CEILING_HIT
    && (metric?.phaseComplete === true || metric?.phase_complete === true
      || verdict.phaseComplete === true || verdict.phase_complete === true)
    && metric !== null
    && metricFileIndicatesFailure(metric);
  const verdictThreshold = typeof verdict.threshold === 'number' ? verdict.threshold : null;
  if (verdictThreshold !== null && !verifiedCampaignCeiling) {
    if (higherIsBetter && verdictThreshold < contract.threshold) {
      return `verdict.threshold=${verdictThreshold} downgraded below contract.threshold=${contract.threshold}. Gate threshold was lowered — verdict invalid.`;
    }
    if (!higherIsBetter && verdictThreshold > contract.threshold) {
      return `verdict.threshold=${verdictThreshold} raised above contract.threshold=${contract.threshold} (lower-is-better). Gate threshold was relaxed — verdict invalid.`;
    }
  }
  const mechanicalPass = higherIsBetter ? value >= contract.threshold : value <= contract.threshold;
  if (verdict.pass === true && !mechanicalPass && !verifiedCampaignCeiling) {
    return `verdict.pass=true but value=${value} does not satisfy contract (${higherIsBetter ? '>=' : '<='} ${contract.threshold}). Pass set independently of mechanical check — verdict invalid.`;
  }
  return null;
}
