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

export interface ResearchRound {
  label: string;
  result: number;
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
      if (r.confirmFailed) {
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
    if (r.confirmFailed) {
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
  if (stop.beat !== undefined && (higherIsBetter ? runningBest >= stop.beat : runningBest <= stop.beat)) {
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
