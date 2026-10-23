// Boundary: Metric agreement and threshold policy plus declared contract readers; no scheduler state mutation or launching.
import { RUN_STATUS, runDir } from '../../store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Legacy research settlement may still carry a separate domain comparison. */
function metricFileIndicatesFailure(metric: Record<string, unknown>): boolean {
  if (metric.pass === false) return true;
  const value = typeof metric.value === 'number' ? metric.value : typeof metric.score === 'number' ? metric.score : null;
  const threshold = typeof metric.threshold === 'number' ? metric.threshold : null;
  if (value === null || threshold === null) return false;
  return metric.higherIsBetter !== false && metric.higher_is_better !== false ? value < threshold : value > threshold;
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
): { kind: 'numeric_evidence' | 'score_contract'; reason: string } | null {
  if (verdict.pass !== true || contract.appliesToGates && !contract.appliesToGates.includes(stageId)) return null;
  const candidateValues: unknown[] = [verdict.value, verdict.score, metric?.value, metric?.score];
  const value = candidateValues.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );
  if (typeof value !== 'number') {
    return { kind: 'numeric_evidence', reason: `missing required numeric gate value for metric="${contract.metric}"; only finite numeric evidence is accepted, no finite numeric value was found in the current verdict or metric.json, and contract threshold=${contract.threshold} must be checked mechanically.` };
  }
  const expectedMetric = contract.metric.toLowerCase();
  const synonyms = (contract.metricSynonyms ?? []).map(s => s.toLowerCase());
  const acceptableNames = new Set([expectedMetric, ...synonyms]);
  const verdictMetricName = typeof verdict.metric === 'string' ? verdict.metric.toLowerCase() : '';
  const metricFileName = metric && typeof metric.metric === 'string' ? metric.metric.toLowerCase() : '';
  const metricNameMatches = acceptableNames.has(verdictMetricName) || acceptableNames.has(metricFileName);
  if (!metricNameMatches) {
    return { kind: 'score_contract', reason: `verdict.metric="${verdict.metric ?? ''}" / metric.json.metric="${metric?.metric ?? ''}" does not match contract.metric="${contract.metric}" (synonyms=${JSON.stringify(contract.metricSynonyms ?? [])}). Gate metric was redefined — verdict invalid.` };
  }
  const higherIsBetter = contract.higherIsBetter !== false;
  const terminalOutcome = typeof metric?.outcome === 'string'
    ? metric.outcome
    : typeof verdict.outcome === 'string' ? verdict.outcome : undefined;
  const verifiedCampaignCeiling = terminalOutcome === RUN_STATUS.CEILING_HIT
    && (metric?.phaseComplete === true || metric?.phase_complete === true
      || verdict.phaseComplete === true || verdict.phase_complete === true)
    && metric !== null
    && metricFileIndicatesFailure(metric);
  const mechanicalPass = higherIsBetter ? value >= contract.threshold : value <= contract.threshold;
  if (!mechanicalPass && !verifiedCampaignCeiling) {
    return { kind: 'score_contract', reason: `verdict.pass=true but value=${value} does not satisfy contract (${higherIsBetter ? '>=' : '<='} ${contract.threshold}). Pass set independently of mechanical check — verdict invalid.` };
  }
  return null;
}
