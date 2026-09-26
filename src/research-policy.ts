/**
 * Research-mode decision policy — a PURE function decoupled from the scheduler
 * so it is trivially unit-testable.
 *
 * After each measured research round (one direction tested + OOS-measured), the
 * scheduler calls evaluateResearch() with the full ordered history of rounds.
 * The evaluator computes:
 *   - which rounds are KEPT (cumulative stack), per the configured policy
 *   - the running-best metric value
 *   - whether the latest round was kept
 *   - the consecutive-no-improvement streak
 *   - the loop decision: ship | continue | stop_ceiling
 *
 * This replaces the per-phase prose decision-tables that brief authors
 * previously hand-wrote (e.g. "$144~$198 → continue, $128~$144 → ceiling").
 */
import { z } from 'zod';
import type { ResearchConfig, ResearchPolicy } from './store.js';

/**
 * Single source of truth for research policies (P4 of the Atom Architecture).
 * The runtime allow-list (scheduler frontmatter parse) derives from this — no
 * second hardcoded enum. Adding a policy = add a descriptor here + a branch in
 * applyPolicy below.
 */
export const RESEARCH_POLICIES = [
  { id: 'greedy_stack', description: 'Keep every round that improves running-best; stack improvements cumulatively.' },
  { id: 'best_of_n', description: 'Keep only the single best round seen so far (no stacking).' },
  { id: 'replace_if_better', description: 'Replace running-best only when a round strictly beats it.' },
] as const;

export const RESEARCH_POLICY_IDS: readonly string[] = RESEARCH_POLICIES.map((p) => p.id);

/**
 * The same three ids as a parse-time contract. `RESEARCH_POLICY_IDS.includes(...)`
 * answers the membership question but leaves the caller to decide what an unknown
 * value means; every caller so far decided "use the default, say nothing". A schema
 * makes the rejection the caller's to handle rather than the caller's to remember.
 */
export const ResearchPolicySchema = z.enum(['greedy_stack', 'best_of_n', 'replace_if_better']);

export interface ResearchRound {
  label: string;
  /** Present only for a measured round. No-candidate rounds deliberately omit
   * it so the journal never presents the configured baseline as an observation. */
  result?: number;
  /** A round may legitimately discover that there is no safe acting candidate.
   * It consumes budget and counts as no improvement without fabricating a
   * measurement equal to the baseline. */
  outcome?: 'measured' | 'no_candidate';
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
}

export interface ResearchEvaluation {
  runningBest: number;
  keptLabels: string[];
  latestKept: boolean;
  consecutiveNoImprovement: number;
  decision: 'ship' | 'continue' | 'stop_ceiling';
  reason: string;
}

export interface ResearchShipTargetBindings {
  baseline: number;
  target?: number;
  higherIsBetter: boolean;
  improvementMargin: number;
  noOpTolerance: number;
  resultMinimum?: number;
  resultMaximum?: number;
  resultEnum?: number[];
  resultIntegerOnly: boolean;
  resultFieldFloor?: number;
  rejectPositiveResult: boolean;
  outlierLimit?: number;
  resultStdCandidate?: number;
  maxStdRatio: number;
}

export interface ResearchShipTargetAssessment {
  status: 'ceiling_only' | 'already_crossed' | 'reachable' | 'unreachable';
  reason: string;
  bindings: ResearchShipTargetBindings;
  /** A concrete value that passes every locally decidable result/schema/integrity relation. */
  probeResult?: number;
  /** A schema-valid value for a required result_std field, when one is needed. */
  resultStdCandidate?: number;
}

/** True if `a` beats `b` by more than `margin`, under the higher/lower-is-better convention.
 *  margin filters within-noise gains so they don't count as real improvements. */
function isBetter(a: number, b: number, higherIsBetter: boolean, margin = 0): boolean {
  return higherIsBetter ? a > b + margin : a < b - margin;
}

/** The improvement margin a round must clear to count: max(absolute floor, SE-multiple × its SE). */
function improvementMargin(r: ResearchRound, minImprovement: number, seMultiple: number): number {
  const se = (typeof r.resultStd === 'number' && Number.isFinite(r.resultStd)) ? Math.abs(r.resultStd) * seMultiple : 0;
  return Math.max(minImprovement, se);
}

interface NumericSchema {
  type?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

interface NumericTypeConstraint {
  allowed: boolean;
  integerOnly: boolean;
}

function numericPropertySchema(config: ResearchConfig, field: string): NumericSchema {
  const properties = config.resultSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const property = (properties as Record<string, unknown>)[field];
  return property && typeof property === 'object' && !Array.isArray(property)
    ? property as NumericSchema
    : {};
}

function numericTypeConstraint(type: unknown): NumericTypeConstraint {
  if (type === undefined || (Array.isArray(type) && type.length === 0)) {
    return { allowed: true, integerOnly: false };
  }
  const types = Array.isArray(type) ? type : [type];
  const allowsNumber = types.includes('number');
  const allowsInteger = types.includes('integer');
  return {
    allowed: allowsNumber || allowsInteger,
    integerOnly: allowsInteger && !allowsNumber,
  };
}

function schemaAllowsNumericValue(value: number, schema: NumericSchema, type: NumericTypeConstraint): boolean {
  if (!Number.isFinite(value) || !type.allowed || (type.integerOnly && !Number.isInteger(value))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  return true;
}

function adjacentFloat(value: number, direction: 1 | -1): number {
  if (!Number.isFinite(value)) return value;
  if (Object.is(value, 0) || Object.is(value, -0)) {
    return direction === 1 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += (value > 0) === (direction === 1) ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function numericEnum(schema: NumericSchema): number[] | undefined {
  if (!Array.isArray(schema.enum)) return undefined;
  return schema.enum.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function requiredResultStd(config: ResearchConfig): boolean {
  return Array.isArray(config.resultSchema?.required)
    && config.resultSchema.required.includes('result_std');
}

function chooseResultStdCandidate(config: ResearchConfig): number | undefined {
  if (!requiredResultStd(config)) return undefined;
  const schema = numericPropertySchema(config, 'result_std');
  const type = numericTypeConstraint(schema.type);
  if (!type.allowed) return undefined;
  const floor = Math.max(
    0,
    typeof schema.minimum === 'number' ? schema.minimum : 0,
    config.integrity?.fieldFloors?.result_std ?? 0,
  );
  const ceiling = Math.min(
    typeof schema.maximum === 'number' ? schema.maximum : Number.MAX_VALUE,
    (config.integrity?.rejectIfPositive ?? []).includes('result_std') ? 0 : Number.MAX_VALUE,
  );
  const declared = numericEnum(schema);
  const candidates = declared ?? [
    floor,
    ...(type.integerOnly ? [Math.ceil(floor)] : []),
    ceiling,
  ];
  return candidates
    .filter((value) => value >= floor && value <= ceiling && schemaAllowsNumericValue(value, schema, type))
    .sort((left, right) => Math.abs(left) - Math.abs(right) || left - right)[0];
}

function targetIsMet(value: number, target: number, higherIsBetter: boolean): boolean {
  return higherIsBetter ? value >= target : value <= target;
}

/**
 * Compare every ship-target binding available before launch. This deliberately
 * does not guess an empirical performance ceiling: a target with no declared
 * schema/integrity contradiction remains reachable even if prior campaigns did
 * not attain it.
 */
export function assessResearchShipTarget(config: ResearchConfig): ResearchShipTargetAssessment {
  const higherIsBetter = config.higherIsBetter !== false;
  const target = config.stop?.beat;
  const resultSchema = numericPropertySchema(config, 'result');
  const resultType = numericTypeConstraint(resultSchema.type);
  const resultEnum = numericEnum(resultSchema);
  const resultStdCandidate = chooseResultStdCandidate(config);
  const resultStdNeeded = requiredResultStd(config);
  const seMultiple = config.stop?.improvementSEMultiple ?? 1;
  const margin = Math.max(
    config.stop?.minImprovement ?? 0,
    resultStdCandidate === undefined ? 0 : Math.abs(resultStdCandidate) * seMultiple,
  );
  const noOpTolerance = config.integrity?.noop === false
    ? 0
    : Math.max(1e-4, Math.abs(config.baseline) * 1e-5);
  const resultMinimum = typeof resultSchema.minimum === 'number' ? resultSchema.minimum : undefined;
  const resultMaximum = typeof resultSchema.maximum === 'number' ? resultSchema.maximum : undefined;
  const resultFieldFloor = config.integrity?.fieldFloors?.result;
  const rejectPositiveResult = (config.integrity?.rejectIfPositive ?? []).includes('result');
  const outlierLimit = Math.abs(config.baseline) > 1e-9
    ? Math.abs(config.baseline) * (config.integrity?.outlierFactor ?? 5)
    : undefined;
  const maxStdRatio = config.integrity?.maxStdRatio ?? 0.30;
  const bindings: ResearchShipTargetBindings = {
    baseline: config.baseline,
    ...(target === undefined ? {} : { target }),
    higherIsBetter,
    improvementMargin: margin,
    noOpTolerance,
    ...(resultMinimum === undefined ? {} : { resultMinimum }),
    ...(resultMaximum === undefined ? {} : { resultMaximum }),
    ...(resultEnum === undefined ? {} : { resultEnum }),
    resultIntegerOnly: resultType.integerOnly,
    ...(resultFieldFloor === undefined ? {} : { resultFieldFloor }),
    rejectPositiveResult,
    ...(outlierLimit === undefined ? {} : { outlierLimit }),
    ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
    maxStdRatio,
  };

  if (target === undefined) {
    return {
      status: 'ceiling_only',
      reason: 'research.stop.beat is absent, so this contract deliberately has no ship target',
      bindings,
      ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
    };
  }
  if (targetIsMet(config.baseline, target, higherIsBetter)) {
    return {
      status: 'already_crossed',
      reason: `baseline ${config.baseline} already satisfies the ${higherIsBetter ? '>=' : '<='} ${target} ship relation`,
      bindings,
      ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
    };
  }
  if (!resultType.allowed) {
    return {
      status: 'unreachable',
      reason: 'research.result_schema.properties.result does not allow a numeric measured result',
      bindings,
      ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
    };
  }
  if (resultStdNeeded && resultStdCandidate === undefined) {
    return {
      status: 'unreachable',
      reason: 'required result_std has no value accepted by its schema and the declared integrity gates',
      bindings,
    };
  }

  let lower = -Number.MAX_VALUE;
  let upper = Number.MAX_VALUE;
  if (resultMinimum !== undefined) lower = Math.max(lower, resultMinimum);
  if (resultMaximum !== undefined) upper = Math.min(upper, resultMaximum);
  if (resultFieldFloor !== undefined) lower = Math.max(lower, resultFieldFloor);
  if (rejectPositiveResult) upper = Math.min(upper, 0);
  if (outlierLimit !== undefined) {
    if (higherIsBetter) upper = Math.min(upper, outlierLimit);
    else lower = Math.max(lower, -outlierLimit);
  }
  if (higherIsBetter) lower = Math.max(lower, target);
  else upper = Math.min(upper, target);

  const improvementBoundary = higherIsBetter
    ? config.baseline + Math.max(margin, noOpTolerance)
    : config.baseline - Math.max(margin, noOpTolerance);
  const boundaries = [
    lower,
    upper,
    target,
    improvementBoundary,
    adjacentFloat(improvementBoundary, higherIsBetter ? 1 : -1),
    config.baseline,
    0,
    1e-6,
    -1e-6,
  ];
  if (resultStdCandidate !== undefined && maxStdRatio > 0) {
    const ratioBoundary = Math.abs(resultStdCandidate) / maxStdRatio;
    boundaries.push(ratioBoundary, -ratioBoundary);
  }
  const declaredCandidates = resultEnum;
  const candidates = new Set<number>();
  for (const boundary of declaredCandidates ?? boundaries) {
    if (!Number.isFinite(boundary)) continue;
    candidates.add(boundary);
    candidates.add(adjacentFloat(boundary, 1));
    candidates.add(adjacentFloat(boundary, -1));
    if (resultType.integerOnly) {
      candidates.add(Math.floor(boundary));
      candidates.add(Math.ceil(boundary));
    }
  }

  const candidatePasses = (value: number): boolean => {
    if (value < lower || value > upper) return false;
    if (!schemaAllowsNumericValue(value, resultSchema, resultType)) return false;
    if (!isBetter(value, config.baseline, higherIsBetter, margin)) return false;
    if (config.integrity?.noop !== false && Math.abs(value - config.baseline) <= noOpTolerance) return false;
    if (!targetIsMet(value, target, higherIsBetter)) return false;
    if (resultStdCandidate !== undefined && Math.abs(value) > 1e-6) {
      const ratio = Math.abs(resultStdCandidate) / Math.abs(value);
      if (ratio > maxStdRatio) return false;
    }
    return true;
  };
  const ordered = [...candidates]
    .filter(candidatePasses)
    .sort((left, right) => higherIsBetter ? left - right : right - left);
  const probeResult = ordered[0];
  if (probeResult === undefined) {
    const direction = higherIsBetter ? 'at or above' : 'at or below';
    return {
      status: 'unreachable',
      reason: `no finite numeric result can be ${direction} ${target}, improve on baseline ${config.baseline}, and pass the declared result schema and integrity bounds`,
      bindings,
      ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
    };
  }
  return {
    status: 'reachable',
    reason: `probe result ${probeResult} satisfies the target, strict-improvement, schema, and integrity relations`,
    bindings,
    probeResult,
    ...(resultStdCandidate === undefined ? {} : { resultStdCandidate }),
  };
}

/**
 * Compute the kept-set + running-best for the given policy over the ordered rounds.
 * Returns kept labels (in round order) and the final running-best value.
 */
function applyPolicy(
  policy: ResearchPolicy,
  baseline: number,
  higherIsBetter: boolean,
  rounds: ResearchRound[],
  minImprovement: number,
  seMultiple: number,
): { keptLabels: string[]; runningBest: number; perRoundKept: boolean[] } {
  const perRoundKept: boolean[] = [];
  const keptLabels: string[] = [];

  if (policy === 'best_of_n' || policy === 'replace_if_better') {
    // Single-slot: keep only the best round seen so far (replaces prior keep).
    let best = baseline;
    let bestLabel: string | null = null;
    for (const r of rounds) {
      if (r.confirmFailed || r.outcome === 'no_candidate' || typeof r.result !== 'number') {
        perRoundKept.push(false);
        continue;
      }
      if (isBetter(r.result, best, higherIsBetter, improvementMargin(r, minImprovement, seMultiple))) {
        best = r.result;
        bestLabel = r.label;
        perRoundKept.push(true);
      } else {
        perRoundKept.push(false);
      }
    }
    if (bestLabel) keptLabels.push(bestLabel);
    return { keptLabels, runningBest: best, perRoundKept };
  }

  // greedy_stack (default): keep a round iff it improves the running best;
  // gains accumulate.
  let runningBest = baseline;
  for (const r of rounds) {
    if (r.confirmFailed || r.outcome === 'no_candidate' || typeof r.result !== 'number') {
      perRoundKept.push(false);
      continue;
    }
    if (isBetter(r.result, runningBest, higherIsBetter, improvementMargin(r, minImprovement, seMultiple))) {
      runningBest = r.result;
      keptLabels.push(r.label);
      perRoundKept.push(true);
    } else {
      perRoundKept.push(false);
    }
  }
  return { keptLabels, runningBest, perRoundKept };
}

/**
 * Floor check for a research-loop ceiling claim, mirroring the unified
 * terminal-state gate's evaluateTerminalFloor but with RESEARCH semantics:
 * measured rounds ARE the attempted stages. Nothing in the engine writes
 * stage_*_verdict.md files — they exist only when a brief instructs a stage to — so
 * globbing for them here would read 0 for every research run and either always block or
 * never fire. Counting rounds is what makes this floor satisfiable without asking the
 * brief to arrange evidence files. Same precedence as the stage-verdict variant:
 * when min_attempted_stages is set and satisfied, wall time is advisory only.
 */
export function evaluateResearchCeilingFloor(
  floor: { minAttemptedStages?: number; minWallMinutes?: number } | undefined,
  roundsAttempted: number,
  elapsedMinutes: number,
): { passed: boolean; reason?: string } {
  if (!floor) return { passed: true };
  if (floor.minAttemptedStages !== undefined) {
    if (roundsAttempted < floor.minAttemptedStages) {
      return { passed: false, reason: `only ${roundsAttempted} research round(s) measured; ceiling floor requires ${floor.minAttemptedStages}` };
    }
    return { passed: true };
  }
  if (floor.minWallMinutes !== undefined && elapsedMinutes < floor.minWallMinutes) {
    return { passed: false, reason: `wall time ${elapsedMinutes.toFixed(1)} min < required ${floor.minWallMinutes} min` };
  }
  return { passed: true };
}

export function evaluateResearch(config: ResearchConfig, rounds: ResearchRound[]): ResearchEvaluation {
  const higherIsBetter = config.higherIsBetter !== false;
  const minImprovement = config.stop?.minImprovement ?? 0;
  const seMultiple = config.stop?.improvementSEMultiple ?? 1; // default: improvement must clear ~1 SE
  const { keptLabels, runningBest, perRoundKept } = applyPolicy(
    config.policy, config.baseline, higherIsBetter, rounds, minImprovement, seMultiple,
  );
  const latestKept = perRoundKept.length > 0 ? perRoundKept[perRoundKept.length - 1] : false;

  // Consecutive no-improvement streak ending at the latest round.
  let consecutiveNoImprovement = 0;
  for (let i = perRoundKept.length - 1; i >= 0; i--) {
    if (perRoundKept[i]) break;
    consecutiveNoImprovement++;
  }

  const stop = config.stop ?? {};

  // 1. Breakthrough: running-best beats the headline target → ship.
  if (keptLabels.length > 0
      && stop.beat !== undefined
      && (higherIsBetter ? runningBest >= stop.beat : runningBest <= stop.beat)) {
    return { runningBest, keptLabels, latestKept, consecutiveNoImprovement, decision: 'ship', reason: `running-best ${runningBest} beats target ${stop.beat}` };
  }

  // 2. Round budget exhausted → ceiling.
  if (stop.maxRounds !== undefined && rounds.length >= stop.maxRounds) {
    return { runningBest, keptLabels, latestKept, consecutiveNoImprovement, decision: 'stop_ceiling', reason: `max_rounds reached (${rounds.length}/${stop.maxRounds})` };
  }

  // 3. Wall budget exhausted → ceiling.
  const latestWall = rounds.length > 0 ? rounds[rounds.length - 1].wallHoursCumulative : undefined;
  if (stop.maxWallHours !== undefined && latestWall !== undefined && latestWall >= stop.maxWallHours) {
    return { runningBest, keptLabels, latestKept, consecutiveNoImprovement, decision: 'stop_ceiling', reason: `max_wall_hours reached (${latestWall.toFixed(2)}/${stop.maxWallHours})` };
  }

  // 4. No-improvement streak → ceiling.
  if (stop.haltAfterNoImprovement !== undefined && consecutiveNoImprovement >= stop.haltAfterNoImprovement) {
    return { runningBest, keptLabels, latestKept, consecutiveNoImprovement, decision: 'stop_ceiling', reason: `${consecutiveNoImprovement} consecutive rounds without improvement` };
  }

  // 5. Otherwise keep exploring.
  return { runningBest, keptLabels, latestKept, consecutiveNoImprovement, decision: 'continue', reason: latestKept ? `latest round improved running-best to ${runningBest}` : 'no improvement this round, but budget remains' };
}
