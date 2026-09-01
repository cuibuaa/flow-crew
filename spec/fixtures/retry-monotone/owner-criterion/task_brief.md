---
inputs:
  - docs/happymj_explore5/
  - docs/happymj_brac_power/
  - docs/happymj_opponent_dist/
  - docs/happymj_defence/
  - docs/happymj_incumbent/
research:
  baseline: 0.0
  policy: greedy_stack
  higher_is_better: true
  result_file: docs/happymj_explore6/round_result.json
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
    command: python3 -m happymj.research_confirm --result docs/happymj_explore6/round_result.json
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
    paths: [docs/happymj_explore6/ship_report.md]
  ceiling_hit:
    paths: [docs/happymj_explore6/ceiling_report.md]
  escalated:
    paths: [docs/happymj_explore6/escalation_note.md]
---

# The three closed questions leave two open axes

## Outcome

A policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies wholly
above zero on its primary evaluation and survives confirmation on a disjoint sample. Failing that,
an account of why the remaining open axes do not change the answer either, resting on measured
attempts sized to actually resolve what they claim.

## What is closed, and what the closures themselves say

Three campaigns closed three framings, each by a configured stop condition, each with every round
carrying its own exactly-zero no-effect control:

- `docs/happymj_explore5/ceiling_report.md` plus `docs/happymj_brac_power/final_measurement.md` —
  when to depart from the incumbent. The one surviving positive resolved negative at 7,150 blocks.
- `docs/happymj_opponent_dist/ceiling_report.md` — the training opponent distribution and
  opponent conditioning.
- `docs/happymj_defence/ceiling_report.md` and `docs/happymj_incumbent/ceiling_report.md` — gated
  departures under six statistical criteria, and the incumbent's own behavioural family.

Read them for what they jointly imply rather than taking this from me. Two properties of the
closures are load-bearing. Almost every近-zero round was measured on 854 paired blocks, whose
interval half-width sits near the size of any effect still plausible, so "indistinguishable from
zero" and "zero" were never separated. And every trained mechanism in those campaigns trained
small; the repository's own `ITERATION_LOG.md` concludes that large-scale self-play throughput was
solved and names it the one lever it expected to change the reinforcement-learning outcome, a
conclusion recorded and then never exercised at scale against this yardstick.

Both axes have prior artifacts: `docs/happymj_resolution/`, `docs/happymj_scale_training/`,
`docs/happymj_scale_v2/`, `docs/happymj_selfplay/checkpoints/`, and whatever else the docs tree
holds. Establish what each already measured and at what configuration before deciding; a
configuration already measured is out of scope unchanged, and which those are is for you to
establish, not to assume untried.

## Where the rest of the evidence is

- `happymj/` — the package: the vectorized engine and its wiring rounds, `measure_brac_power.py`
  for reconstruction/disjointness/control/trimming machinery, every mechanism module the prior
  campaigns left, and the collection and training paths.
- `ITERATION_LOG.md` at the repository root, including its throughput measurements and their
  recorded conditions.
- The main `docs/` tree — sixty-plus campaign directories; the enumeration obligation above
  applies to any axis this campaign decides to touch.

## Constraints

- **The yardstick's semantics do not move**: paired EV per hand, candidate minus the three fixed
  original `HeuristicPolicyV1` opponents, same reward profile, rules hash, fan table, and
  paired-block construction, confirmation on a disjoint sample. **The primary block count is not
  part of the frozen semantics**: a round may size its primary larger than prior campaigns did,
  and must state before opening any outcome what effect size its chosen sample can resolve and
  why that suffices for the decision the round will make.
- All prior campaign directories are read-only. This campaign writes under
  `docs/happymj_explore6/`.
- Never report a policy behaviourally identical to the incumbent as a candidate near zero. Record
  its decision-difference count, and an explicit no-candidate outcome with provenance when a round
  produces nothing servable.
- Freeze every gate, seed range, and threshold before opening any outcome used for selection.
  Arms compared to each other share their initialization.

## What each round's report must show

1. **What "no effect" measures in this round's own serving configuration**, at this round's own
   sample size: a behaviourally identical control, its interval beside the candidate's.

2. **The candidate's decision-level difference from the incumbent**, beside its overall paired EV
   and its EV restricted to blocks where outcomes diverged. A candidate that approaches the
   incumbent by seldom differing must not be recorded as an improvement.

3. **Every headline statistic reports its mean, its median, where the reported value sits in its
   own distribution, and how it moves as the most extreme blocks are removed from each end.**

4. **A round that claims an axis is exhausted shows the dose went up.** A scale round states its
   training volume against what prior campaigns used, in the same units; a resolution round states
   its block count against 854 and the half-width achieved. An axis probed at the old dose closes
   nothing.

5. **Anything built is checked against what the package already provides**, naming the module
   considered and why it does not serve, before writing a new one.

6. **`make build`, `make test`, and `make lint` end green after the last write of each round**,
   each with its direct exit code and totals; never read the exit status after a pipe.

7. **Every test this task writes asserts properties that hold at every point in time.** No test
   may assert that a terminal artifact is absent, and none may assert that a shared campaign file
   names the round that wrote the test.

8. **Each round's result is audited by something other than what produced it, before it counts**,
   with the audit's verdict and identity reported. No terminal artifact is written until that
   audit has run and passed for the round the terminal outcome rests on.

9. **Say what each supplied quantity in this brief depends on that the brief did not state**, and
   whether that changes what it is worth.

10. **Re-read the run's declared reality checks before each terminal write**, run each, report
    each exit code, and repair any check whose field names or paths do not match what the
    emitters actually produce, or which requires an artifact only a later stage writes. State
    such a check as the invariant that holds throughout — at most one terminal artifact, and no
    conflicting pair. Put the repair narrative in the report body, never inside a machine-read
    declaration.

11. **Choose the terminal path by which outcome happened.** A confirmed win writes the ship
    report. A ceiling writes the ceiling report only when a configured stopping condition has
    actually fired, naming which one and the count that satisfies it. A blocker writes the
    escalation note. **A round whose audit concludes the campaign should continue is not a
    terminal outcome: write no terminal artifact and let the next round begin.** Write at most
    one, and only once the campaign itself has ended.

Parenthetical examples in this brief are illustrative, not criteria.

## Out of scope

- Changing the reward profile, rules hash, fan table, or the three fixed evaluation opponents
- Human or platform game records: none exist for this project and none are to be sought
- Re-running any already-measured configuration unchanged
- Writing anywhere under the read-only campaign directories
