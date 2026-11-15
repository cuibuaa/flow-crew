import { runRecordPath } from '../../run-layout.js';
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
    const p = runRecordPath(runDir(projectDir, runId), 'gate_contract.json');
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
 * A numeric verdict observation takes precedence; otherwise use the admitted
 * stage-work metric observation. Name and value always come from that carrier.
 * Legacy runs retain their original stage-work topology through stageWorkPath.
 */
export function validateVerdictAgainstContract(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown> | null,
  contract: GateContract,
  stageId: string,
): { kind: 'numeric_evidence' | 'score_contract'; reason: string } | null {
  if (verdict.pass !== true || contract.appliesToGates && !contract.appliesToGates.includes(stageId)) return null;
  const finiteValue = (observation: Record<string, unknown> | null): number | undefined =>
    [observation?.value, observation?.score].find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const observation = finiteValue(verdict) !== undefined ? verdict : metric;
  const value = finiteValue(observation);
  if (typeof value !== 'number') {
    return { kind: 'numeric_evidence', reason: `missing required numeric gate value for metric="${contract.metric}"; only finite numeric evidence is accepted, no finite numeric value was found in the current verdict or metric.json, and contract threshold=${contract.threshold} must be checked mechanically.` };
  }
  const expectedMetric = contract.metric.toLowerCase();
  const synonyms = (contract.metricSynonyms ?? []).map(s => s.toLowerCase());
  const acceptableNames = new Set([expectedMetric, ...synonyms]);
  const metricName = typeof observation?.metric === 'string' ? observation.metric.toLowerCase() : '';
  if (!acceptableNames.has(metricName)) {
    return { kind: 'score_contract', reason: `observation.metric="${observation?.metric ?? ''}" does not match contract.metric="${contract.metric}" (synonyms=${JSON.stringify(contract.metricSynonyms ?? [])}). Gate metric was redefined — verdict invalid.` };
  }
  const higherIsBetter = contract.higherIsBetter !== false;
  const verifiedCampaignCeiling = observation !== null && observation === metric && observation.outcome === RUN_STATUS.CEILING_HIT
    && (observation.phaseComplete === true || observation.phase_complete === true)
    && metricFileIndicatesFailure(observation);
  const mechanicalPass = higherIsBetter ? value >= contract.threshold : value <= contract.threshold;
  if (!mechanicalPass && !verifiedCampaignCeiling) {
    return { kind: 'score_contract', reason: `verdict.pass=true but value=${value} does not satisfy contract (${higherIsBetter ? '>=' : '<='} ${contract.threshold}). Pass set independently of mechanical check — verdict invalid.` };
  }
  return null;
}
