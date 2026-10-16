# Cancellation and continuation compatibility

## Behavior and scope

This follow-up starts at `8fb8604` on the branch based on main `89b0229`. It replaces the stage-by-stage field agreement in `assertContinuationCompatible` with a directional execution invariant:

- Every settled ledger attempt must have the same index, settled status and exit code in the projection. A missing or different settled outcome means the ledger is ahead, and continuation refuses before publishing a repair.
- Unsettled execution in either carrier requires positive owner-death evidence. An unsettled ledger cannot hide behind an already-settled projection. The existing cancellation settlement authority remains limited to a stopped user cancellation with a valid completion time.

Retry counters, stage scheduling status, timestamps, duration, error text and audit metadata need not agree. Pending and skipped projections can retain earlier complete/failed ledgers. Valid attempt indexes, supported statuses and parseable attempt start times remain structural requirements; ignoring timestamp differences does not authorize malformed history. Missing projections, missing execution ledgers, unreadable ledgers, unsupported plans/checkpoints and invalid run budgets still refuse.

The exact legacy-cancellation record match, exact split-settlement match and pending-stage agreement exception are deleted. There is no separate repend compatibility channel. One settled-outcome comparison covers legacy cancellation, split settlement and all the repend shapes. The remaining JSON digests protect against concurrent publication, rather than requiring agreement between carriers.

For an interrupted projection, admission computes its cancellation settlement, checks the invariant, and only then publishes under the existing run lock. It rechecks the projection snapshot, every observed ledger and owner death under that lock. Earlier unresolved attempts that the existing settlement primitive cannot close still refuse. A proven-dead unresolved ledger with an already-settled projection may remain unchanged at admission; the guarantee is absence of a possibly-live owner, not identical files. Summary-only scheduling records carry no attempt outcome to compare.

Cancellation's existing preservation guard is retained: a changed ledger is published only when its previous readable JSON exactly matches the previous projection. Missing, malformed and disagreeing evidence is not overwritten. Pending stages remain pending, and completed stages retain their execution evidence. No runtime state, configuration option or runtime file is added.

## End-to-end evidence

`spec/cancellation-repend-paths.test.ts` invokes the actual scheduler functions, rather than constructing only their resulting shapes:

1. `prepareWorkflowIteration` resets stages for the next iteration.
2. `settleGateRetries` repends the repair stage.
3. `settleGateRetries` runs the repair and then repends its review gate.
4. Terminal ambiguity repends the admitted owner and its ledger.
5. Research progress repends its terminal finalizer and its ledger.

Each starts with a real failed attempt followed by a successful retry. The first three assert that projection retries reset to 0 while the retained ledger has retries 1. They cancel through `RunCancellationCoordinator`, call `assertContinuationCompatible`, and check byte-for-byte ledger preservation. Gate/research dispatch interception stops only at the relevant real scheduler boundary. The gate review case executes the intervening repair through the real runner.

The same three cited-path tests fail on the original guard (`systemic/before-paths.log`, 3/3 failed, direct exit 1) and pass after replacement (`systemic/after-paths.log`, all five cases pass, direct exit 0). This measures the behavior improvement on the same three paths; the other two cases are supplemental coverage, not part of that baseline.

The private daemon spec covers both a matching pending ledger and a retained complete ledger after retry. It creates a private HOME, state root, socket, mock provider and command PATH. The fixture registers a deferred task after constructing its completed/retried/repend history; it does not claim to cancel an actively executing daemon iteration. Each real `task cancel` and `task resume` must exit 0. The resumed run and supervised process must complete with exit 0. `done` and `done2` remain exactly equal in both carriers; only work executes again, retaining its failed first attempt and superseded successful retry. Admission may add audit metadata. Cleanup targets only fixture-owned processes.

Safety specs separately cover an extra settled ledger attempt, different settled statuses (including suspension), different exit codes, and a ledger-first publication crash. They also cover live/unknown owners visible only in the ledger, controller/scheduler/command ownership, invalid cancellation boundaries, historical unresolved attempts, malformed histories, and publication races before locked settlement. The final baseline also refuses unknown projection status before normalization and existing JSON-null, false, zero or empty-string ledgers. Incidental retry, timing, duration and skipped-status differences are positive cases. The deployment refusal fixture now removes actual attempt evidence instead of treating a changed retry budget as corruption.

Initial focused runs exposed two assertion issues: the daemon assertion required exact prior-attempt equality despite admission adding audit metadata, and a deployment fixture still expected retry mismatch refusal. Those tests were corrected without changing runtime behavior. Their failed logs remain separate from passing receipts. An early daemon before/after experiment overlapped a source restoration and is not used as baseline evidence.

## Mutation and focused validation

Thirty-five independent mutations ran against the corrected runtime/spec baseline. Each received its own ordinary build and focused Vitest command with the normal configuration and build-freshness check. Every build exited 0; every test command exited 1 with at least one executed failing test. Thirty-four mutations produce assertion failures; omitting projection inspection instead makes the valid split-settlement test fail with a continuation refusal. Setup failures and skipped tests are not counted as detections.

| Conditions mutated independently | Count |
| --- | ---: |
| Projection/ledger interruption detection, owner proof, cancellation boundaries, settlement and timing | 11 |
| Original carrier validation, existing/falsy ledger validation, history structure and required ledger | 7 |
| Complete/failed/suspended outcome detection and index/status/exit-code matching | 6 |
| Projection/ledger publication races and owner recheck under the lock | 3 |
| Reintroduced retry, attempt-metadata and scheduling-status agreement | 3 |
| Cancellation unchanged-stage, missing/malformed ledger, equality and pending-preservation guards | 5 |

`systemic/verified-mutations/mutations.json` records each exact source mutation, selected test, direct exit, executed failures, timing and restoration hashes. The runner exited 0. Its baseline and restored hashes match, and all restored files match the staged files. The restored ordinary build exited 0. Earlier interrupted mutation runs are separate and are not included in these results.

After restoration, the ordinary focused suite passed all 157 tests across nine files in 66.16 seconds, direct exit 0 (`systemic/restored-focused.log`). It includes both private-daemon cancel/resume lifecycles, all five real scheduler repend paths, cancellation safety/recovery, legacy continuation, deployment continuation and public-spec purity.

Precommit receipts live under the gitignored `docs/cancel-ledger-guard/systemic/` directory, with additional focused legacy receipts under gitignored `docs/`. They are not stored in another task's artifact directory.

## Final-commit acceptance

The supplied VERIFY command is run once after committing this report, the runtime and the specs. It invokes the complete unmodified validator from a clean tree on that final commit. The validator's generated `summary.txt` and individual outputs in the worktree's sibling `.validate` directory are the authoritative post-commit result, including commit identity, direct exits and timings. Success requires all checks to exit 0, `DONE`, and a clean Git tree. No earlier check is copied into that summary, and the summary is never hand-written or edited.

This committed report records precommit evidence; post-commit validation results belong to the validator's receipts, so recording them does not create another unvalidated commit. The validator covers dependency installation, engine/UI builds, lint, TypeScript, root/UI tests, public-spec isolation and operation without service-manager commands. Its public-isolation construction does not reproduce Docker or disabled networking.

All builds, focused tests, mutation commands and validation run with niceness 19 on cores 6–11; focused Vitest commands use `--maxWorkers=2`. No real daemon, deployed checkout, real task or service manager is used. Nothing is merged or pushed. Evidence is written only in this worktree or its `.validate` directory.
