export const RESEARCH_FEASIBILITY_MODELS = [
  'independent_repeated_conjunction',
  'formation_count_distribution',
  'not_computable',
] as const;

export interface IndependentRepeatedConjunctionRule {
  label: string;
  model: 'independent_repeated_conjunction';
  population: number;
  perPeriodRate: number;
  periods: number;
}

export interface FormationCountDistributionRule {
  label: string;
  model: 'formation_count_distribution';
  counts: number[];
}

export interface NotComputableFeasibilityRule {
  label: string;
  model: 'not_computable';
  reason: string;
}

export type ResearchFeasibilityRule =
  | IndependentRepeatedConjunctionRule
  | FormationCountDistributionRule
  | NotComputableFeasibilityRule;

export interface ResearchFeasibilityConfig {
  hardFloor: number;
  warnBelow?: number;
  rules: ResearchFeasibilityRule[];
}

export type ResearchFeasibilityParseResult =
  | { status: 'valid'; value: ResearchFeasibilityConfig }
  | { status: 'invalid'; error: string };

export interface DistributionLocation {
  method: 'midrank';
  lowerRank: number;
  upperRank: number;
  of: number;
  percentile: number;
}

export interface StructuralDistributionSummary {
  sampleSize: number;
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  spread: number;
  selectedValue: number;
  selectedStatistic: 'per_period_rate' | 'minimum_formation_count';
  location: DistributionLocation;
}

export interface ResearchFeasibilityEvaluation {
  label: string;
  model: ResearchFeasibilityRule['model'];
  decision: 'fail' | 'warn' | 'ok' | 'not_computable';
  hardFloor: number;
  warnBelow?: number;
  qualifyingMemberCount?: number;
  /** Natural log retained so underflowed counts can still be compared truthfully. */
  logQualifyingMemberCount?: number | null;
  /** Base-10 log retained for scientific reporting; null means the count is exactly zero. */
  log10QualifyingMemberCount?: number | null;
  displayQualifyingMemberCount?: string;
  distribution?: StructuralDistributionSummary;
  reason?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return Object.keys(value).filter((key) => !allow.has(key)).sort();
}

function invalid(error: string): ResearchFeasibilityParseResult {
  return { status: 'invalid', error };
}

function parseRule(raw: unknown, index: number): ResearchFeasibilityRule | string {
  const value = record(raw);
  const at = `research.feasibility.rules[${index}]`;
  if (!value) return `${at} must be a mapping`;
  if (typeof value.label !== 'string' || !value.label.trim()) return `${at}.label must be a non-empty string`;
  if (typeof value.model !== 'string') return `${at}.model must name one documented feasibility model`;
  const label = value.label.trim();

  if (value.model === 'independent_repeated_conjunction') {
    const extra = unexpectedKeys(value, ['label', 'model', 'population', 'per_period_rate', 'periods']);
    if (extra.length) return `${at} has unsupported field(s) for independent_repeated_conjunction: ${extra.join(', ')}`;
    if (!positiveInteger(value.population)) return `${at}.population must be a positive safe integer`;
    if (!finiteNumber(value.per_period_rate) || value.per_period_rate < 0 || value.per_period_rate > 1) {
      return `${at}.per_period_rate must be a finite number from 0 through 1`;
    }
    if (!positiveInteger(value.periods)) return `${at}.periods must be a positive safe integer`;
    return {
      label,
      model: value.model,
      population: value.population,
      perPeriodRate: value.per_period_rate,
      periods: value.periods,
    };
  }

  if (value.model === 'formation_count_distribution') {
    const extra = unexpectedKeys(value, ['label', 'model', 'counts']);
    if (extra.length) return `${at} has unsupported field(s) for formation_count_distribution: ${extra.join(', ')}`;
    if (!Array.isArray(value.counts) || value.counts.length === 0) {
      return `${at}.counts must be a non-empty list of outcome-independent formation counts`;
    }
    if (!value.counts.every(nonNegativeInteger)) {
      return `${at}.counts entries must be non-negative safe integers`;
    }
    return { label, model: value.model, counts: [...value.counts] };
  }

  if (value.model === 'not_computable') {
    const extra = unexpectedKeys(value, ['label', 'model', 'reason']);
    if (extra.length) return `${at} has unsupported field(s) for not_computable: ${extra.join(', ')}`;
    if (typeof value.reason !== 'string' || !value.reason.trim()) {
      return `${at}.reason must name the unavailable structural distribution or quantity`;
    }
    return { label, model: value.model, reason: value.reason.trim() };
  }

  return `${at}.model must be one of ${RESEARCH_FEASIBILITY_MODELS.join(', ')}`;
}

/** Parse and strictly validate the generic `research.feasibility` YAML value. */
export function parseResearchFeasibility(raw: unknown): ResearchFeasibilityParseResult {
  const value = record(raw);
  if (!value) return invalid('research.feasibility must be a mapping');
  const extra = unexpectedKeys(value, ['hard_floor', 'warn_below', 'rules']);
  if (extra.length) return invalid(`research.feasibility has unsupported field(s): ${extra.join(', ')}`);
  if (!finiteNumber(value.hard_floor) || value.hard_floor <= 0) {
    return invalid('research.feasibility.hard_floor must be a positive finite number');
  }
  if (value.warn_below !== undefined
      && (!finiteNumber(value.warn_below) || value.warn_below < value.hard_floor)) {
    return invalid('research.feasibility.warn_below must be a finite number at or above hard_floor');
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    return invalid('research.feasibility.rules must be a non-empty list');
  }

  const rules: ResearchFeasibilityRule[] = [];
  const labels = new Set<string>();
  for (let index = 0; index < value.rules.length; index += 1) {
    const parsed = parseRule(value.rules[index], index);
    if (typeof parsed === 'string') return invalid(parsed);
    if (labels.has(parsed.label)) return invalid(`research.feasibility rule label is duplicated: ${parsed.label}`);
    labels.add(parsed.label);
    rules.push(parsed);
  }

  return {
    status: 'valid',
    value: {
      hardFloor: value.hard_floor,
      ...(value.warn_below === undefined ? {} : { warnBelow: value.warn_below }),
      rules,
    },
  };
}

function midpoint(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function midrankLocation(values: readonly number[], selectedValue: number): DistributionLocation {
  let below = 0;
  let equal = 0;
  for (const value of values) {
    if (value < selectedValue) below += 1;
    else if (value === selectedValue) equal += 1;
  }
  return {
    method: 'midrank',
    lowerRank: below + 1,
    upperRank: below + equal,
    of: values.length,
    percentile: 100 * (below + equal / 2) / values.length,
  };
}

function constantDistribution(value: number, sampleSize: number): StructuralDistributionSummary {
  return {
    sampleSize,
    mean: value,
    median: value,
    minimum: value,
    maximum: value,
    spread: 0,
    selectedValue: value,
    selectedStatistic: 'per_period_rate',
    location: {
      method: 'midrank',
      lowerRank: 1,
      upperRank: sampleSize,
      of: sampleSize,
      percentile: 50,
    },
  };
}

function countDistribution(counts: readonly number[]): StructuralDistributionSummary {
  const sorted = [...counts].sort((left, right) => left - right);
  let mean = 0;
  counts.forEach((value, index) => {
    mean += (value - mean) / (index + 1);
  });
  const selectedValue = sorted[0];
  return {
    sampleSize: sorted.length,
    mean,
    median: midpoint(sorted),
    minimum: selectedValue,
    maximum: sorted.at(-1)!,
    spread: sorted.at(-1)! - selectedValue,
    selectedValue,
    selectedStatistic: 'minimum_formation_count',
    location: midrankLocation(sorted, selectedValue),
  };
}

function decisionForLogCount(
  logCount: number,
  hardFloor: number,
  warnBelow: number | undefined,
): 'fail' | 'warn' | 'ok' {
  if (logCount === Number.NEGATIVE_INFINITY) return 'fail';
  const below = (threshold: number): boolean => {
    const logThreshold = Math.log(threshold);
    const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(logCount), Math.abs(logThreshold));
    return logCount < logThreshold - tolerance;
  };
  if (below(hardFloor)) return 'fail';
  if (warnBelow !== undefined && below(warnBelow)) return 'warn';
  return 'ok';
}

function displayCount(count: number, log10Count: number | null): string {
  if (count === 0) {
    return log10Count === null
      ? '0'
      : `approximately 10^${log10Count.toFixed(3)} (numeric value underflowed to 0)`;
  }
  if (count < 0.000001 || count >= 1_000_000_000) return count.toExponential(6);
  return Number.isInteger(count) ? String(count) : String(Number(count.toPrecision(12)));
}

/** Evaluate every declared rule without consulting an outcome or external state. */
export function evaluateResearchFeasibility(
  config: ResearchFeasibilityConfig,
): ResearchFeasibilityEvaluation[] {
  return config.rules.map((rule): ResearchFeasibilityEvaluation => {
    const common = {
      label: rule.label,
      model: rule.model,
      hardFloor: config.hardFloor,
      ...(config.warnBelow === undefined ? {} : { warnBelow: config.warnBelow }),
    };

    if (rule.model === 'not_computable') {
      return { ...common, decision: 'not_computable', reason: rule.reason };
    }

    if (rule.model === 'independent_repeated_conjunction') {
      const logCount = rule.perPeriodRate === 0
        ? Number.NEGATIVE_INFINITY
        : Math.log(rule.population) + rule.periods * Math.log(rule.perPeriodRate);
      const count = logCount === Number.NEGATIVE_INFINITY ? 0 : Math.exp(logCount);
      const log10Count = logCount === Number.NEGATIVE_INFINITY ? null : logCount / Math.LN10;
      return {
        ...common,
        decision: decisionForLogCount(logCount, config.hardFloor, config.warnBelow),
        qualifyingMemberCount: count,
        logQualifyingMemberCount: logCount === Number.NEGATIVE_INFINITY ? null : logCount,
        log10QualifyingMemberCount: log10Count,
        displayQualifyingMemberCount: displayCount(count, log10Count),
        distribution: constantDistribution(rule.perPeriodRate, rule.periods),
      };
    }

    const distribution = countDistribution(rule.counts);
    const count = distribution.selectedValue;
    const logCount = count === 0 ? Number.NEGATIVE_INFINITY : Math.log(count);
    return {
      ...common,
      decision: decisionForLogCount(logCount, config.hardFloor, config.warnBelow),
      qualifyingMemberCount: count,
      logQualifyingMemberCount: count === 0 ? null : logCount,
      log10QualifyingMemberCount: count === 0 ? null : logCount / Math.LN10,
      displayQualifyingMemberCount: displayCount(count, count === 0 ? null : logCount / Math.LN10),
      distribution,
    };
  });
}
