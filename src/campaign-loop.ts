/**
 * Autonomous outer loop (P3) — the SAME loop engine at DIRECTION scope.
 *
 * The campaign is the loop run at the outer scope: a candidate is a *research direction* (not a
 * mechanism), Execute = spawn an inner research loop for that direction, and the decision reuses
 * the SAME policy primitive (evaluateResearch / LoopPolicy) over direction-level outcomes. This is
 * the "one engine, nested scopes" claim made concrete — no second decision system.
 *
 * Dependencies are injected so the loop is deterministically unit-testable with mocks (no live
 * LLM / no spawned runs). The live driver supplies:
 *   - propose: the campaign-planner role (reads {ledger_digest} + {context_inventory}) → the next
 *     genuinely-new direction, or null when it finds none (frontier).
 *   - executeDirection: launch an inner research loop for the direction, return its best outcome.
 */
import { evaluateResearch, type ResearchRound } from './research-policy.js';
import type { ResearchConfig } from './store.js';

export interface DirectionOutcome {
  direction: string;
  /** Best inner-loop result this direction achieved (the inner running-best). */
  bestResult: number;
  /** Cross-run std of the result, if known (feeds the policy's significance margin). */
  resultStd?: number;
  /** The inner run's terminal status, when known. */
  status?: string;
  /**
   * True when the inner run did NOT reach a successful terminal (e.g. reality_gate_failed) — its
   * journaled numbers are an UNVERIFIED claim the inner safety net rejected, so the outer loop must
   * NOT treat them as a real beat. Such an outcome is scored at baseline (no improvement).
   */
  rejected?: boolean;
  /** True when the engine FORCED this direction to satisfy the declared-portfolio coverage floor. */
  forced?: boolean;
}

export interface CampaignLoopDeps {
  /** Propose the next direction NOT in `tried`; return null when none remain (frontier). */
  propose: (tried: string[]) => Promise<string | null>;
  /** Execute a direction (spawn its inner research loop) and return the best outcome. */
  executeDirection: (direction: string) => Promise<DirectionOutcome>;
  /** Campaign-level objective — reused verbatim by the SAME policy (evaluateResearch). */
  objective: ResearchConfig;
  /** Optional observer for progress/telemetry. */
  onOutcome?: (outcome: DirectionOutcome, decision: ResearchRound extends never ? never : string) => void;
}

export interface CampaignLoopResult {
  decision: 'shipped' | 'frontier';
  outcomes: DirectionOutcome[];
  reason: string;
}

/**
 * Drive the outer loop until the policy ships (a direction beat the campaign target), the policy
 * ceilings (frontier: N directions without improvement / budget), or the proposer runs dry.
 */
export async function runCampaignLoop(deps: CampaignLoopDeps): Promise<CampaignLoopResult> {
  const outcomes: DirectionOutcome[] = [];
  const rounds: ResearchRound[] = [];
  // Hard backstop so a misbehaving proposer (always returns a fresh string) can't loop forever;
  // far above any real campaign and well above the policy's maxRounds.
  const HARD_CAP = Math.max((deps.objective.stop?.maxRounds ?? 0) + 5, 200);

  // OUTER-loop empirical floor: the declared portfolio (objective.directions) must be COVERED — each
  // entry forced through one real round — before ANY frontier is honored. This is what stops the LLM
  // proposer from confabulating that an untested direction "failed" and frontier-ing early (observed:
  // it twice declared an untested T2b "failed"). A genuine beat still ships immediately.
  const required = deps.objective.directions ?? [];
  const nextUntestedRequired = (): string | null =>
    required.find((d) => !outcomes.some((o) => o.direction === d)) ?? null;

  while (outcomes.length < HARD_CAP) {
    // Cover declared portfolio directions FIRST (deterministically); only then let the proposer drive.
    let next = nextUntestedRequired();
    const forced = next != null;
    if (!next) {
      const tried = outcomes.map((o) => o.direction);
      next = await deps.propose(tried);
    }
    if (!next) return { decision: 'frontier', outcomes, reason: 'proposer found no new direction (frontier reached)' };

    const outcome = await deps.executeDirection(next);
    if (forced) outcome.forced = true;
    outcomes.push(outcome);
    rounds.push({ label: outcome.direction, result: outcome.bestResult, resultStd: outcome.resultStd });

    const evaluation = evaluateResearch(deps.objective, rounds);
    deps.onOutcome?.(outcome, evaluation.decision);
    if (evaluation.decision === 'ship') return { decision: 'shipped', outcomes, reason: evaluation.reason };
    // Honor a policy ceiling ONLY once every declared portfolio direction has been covered.
    if (evaluation.decision === 'stop_ceiling' && !nextUntestedRequired()) {
      return { decision: 'frontier', outcomes, reason: evaluation.reason };
    }
    // else 'continue', or a ceiling with required directions still untested → keep covering them.
  }
  return { decision: 'frontier', outcomes, reason: `outer-loop hard cap reached (${HARD_CAP})` };
}
