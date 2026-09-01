---
inputs:
  - docs/happymj_defence/
  - docs/happymj_explore5/
  - docs/happymj_brac_power/
  - docs/happymj_opponent_dist/
research:
  baseline: 0.0
  policy: greedy_stack
  higher_is_better: true
  result_file: docs/happymj_incumbent/round_result.json
  result_schema:
    type: object
    required: [label, result]
    properties:
      label: {type: string}
      result: {type: number}
  feasibility:
    hard_floor: 2
    rules:
      - label: qualifying_members_per_frozen_rule
        model: not_computable
        reason: >-
          The qualifying-member count depends on the behavioural family and support counts each
          round defines for its own candidate, and rounds after the first are not chosen yet.
  confirm:
    command: python3 -m happymj.research_confirm --result docs/happymj_incumbent/round_result.json
    requires: >-
      The paired interval against three fixed HeuristicPolicyV1 opponents must lie entirely
      above zero on a disjoint sample, recomputed from preserved raw blocks rather than from
      the round's own summary.
    timeout_seconds: 3600
  stop:
    beat: 0.05
    max_rounds: 6
    halt_after_no_improvement: 4
terminal_states:
  shipped:
    paths: [docs/happymj_incumbent/ship_report.md]
  ceiling_hit:
    paths: [docs/happymj_incumbent/ceiling_report.md]
  escalated:
    paths: [docs/happymj_incumbent/escalation_note.md]
---

# Make the incumbent itself stronger

## Outcome

A complete policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies
wholly above zero on the primary evaluation and survives confirmation on a disjoint sample. Failing
that, an account of why the incumbent cannot be improved from within its own behavioural family
either, resting on measured attempts.

## The change of question

Every prior campaign on this yardstick asked one question: when should a learned mechanism depart
from the incumbent. `docs/happymj_defence/ceiling_report.md` closes that question, enumerating the
directions measured shut. This campaign asks a different one: **can the incumbent itself be made
stronger** — a candidate that is not the incumbent plus a departure gate, but a better complete
policy in its own right, judged on the unchanged yardstick. What family to search, how to represent
a candidate, and how to search are yours to decide.

One pattern in the preserved record is worth weighing when you choose, and it is evidence rather
than instruction: across everything measured, the only positive signals that survived any scrutiny
were policies that played more safely than the incumbent — read the defence ceiling report's
characterisation of them rather than my summary.

## Where the evidence is

- `docs/happymj_defence/ceiling_report.md` and `docs/happymj_defence/evidence_summary.md` — what is
  closed, and what every prior positive point estimate turned out to be worth.
- `happymj/baselines.py` — the incumbent itself, and whatever siblings it already has there.
- `happymj/defence_round.py` and the other round modules under `happymj/` — the package has probed
  parts of this space before; establish from their artifacts what was measured against the
  incumbent and at what configuration, before deciding what this campaign does. A configuration
  already measured is out of scope unchanged; which those are is for you to establish.
- `docs/happymj_selfplay/`, `docs/happymj_prior_pool/`, `docs/happymj_opponents/`,
  `docs/happymj_oracle_guiding/`, `docs/happymj_explore4/` — earlier campaigns whose artifacts
  bear on training and evaluation machinery.
- `happymj/measure_brac_power.py` — reusable paired-evaluation, seed-disjointness, no-effect
  control and trimming machinery.
- `ITERATION_LOG.md` in the repository root.

## Constraints

- **The evaluation yardstick does not move.** Every reported result is measured against the three
  original fixed `HeuristicPolicyV1` opponents under the same reward profile, rules hash, fan
  table, and paired-block construction, with a disjoint confirmation sample. Improving the
  incumbent does not change who sits in the opponent seats.
- All prior campaign directories listed above are read-only. This campaign writes under
  `docs/happymj_incumbent/`.
- Never report a policy behaviourally identical to `HeuristicPolicyV1` as a candidate near zero.
  Record its departure count, and record an explicit no-candidate outcome with provenance when a
  round produces nothing servable.
- Freeze every gate, seed range, and threshold before opening any outcome used for selection. Arms
  compared to each other share their initialization.

## What each round's report must show

1. **What "no effect" measures in this round's own serving configuration**: a control behaviourally
   identical to the incumbent, same conditions and sample size, its interval reported beside the
   candidate's. Do not assume it is zero; establish it each round.

2. **The candidate's decision-level difference from the incumbent** — how many decisions differ and
   on what fraction — beside its overall paired EV and its paired EV restricted to blocks where the
   two policies' outcomes actually diverged. A candidate that approaches the incumbent by seldom
   differing must not be recorded as an improvement.

3. **Every headline statistic reports its mean, its median, where the reported value sits in its own
   distribution, and how it moves as the most extreme blocks are removed from each end.** Prior
   rounds' positives were repeatedly tail artifacts; make that visible without being asked.

4. **Anything built is checked against what the package already provides.** Name the existing module
   considered and why it does not serve, before writing a new one.

5. **`make build`, `make test`, and `make lint` end green after the last write of each round**, each
   with its direct exit code and totals; never read the exit status after a pipe.

6. **Every test this task writes asserts properties that hold at every point in time.** No test may
   assert that a terminal artifact is absent, and none may assert that a shared campaign file names
   the round that wrote the test.

7. **Each round's result is audited by something other than what produced it, before it counts**,
   with the audit's verdict and identity reported. No terminal artifact is written until that audit
   has run and passed for the round the terminal outcome rests on.

8. **Say what each supplied quantity in this brief depends on that the brief did not state**, and
   whether that changes what it is worth.

9. **Re-read the run's declared reality checks before each terminal write**, run each, report each
   exit code, and repair any check whose field names or paths do not match what the emitters
   actually produce, or which requires an artifact only a later stage writes. State such a check as
   the invariant that holds throughout — at most one terminal artifact, and no conflicting pair.
   Put the repair narrative in the report body, never inside a machine-read declaration.

10. **Choose the terminal path by which outcome happened.** A confirmed win writes the ship report.
    A ceiling writes the ceiling report only when a configured stopping condition has actually
    fired, naming which one and the count that satisfies it. A blocker writes the escalation note.
    **A round whose audit concludes the campaign should continue is not a terminal outcome: write
    no terminal artifact and let the next round begin.** Write at most one, and only once the
    campaign itself has ended.

Parenthetical examples in this brief are illustrative, not criteria.

## Out of scope

- Changing the reward profile, rules hash, fan table, or the three fixed evaluation opponents
- Human or platform game records: none exist for this project and none are to be sought
- Re-running any already-measured configuration unchanged
- Writing anywhere under the read-only campaign directories listed above
