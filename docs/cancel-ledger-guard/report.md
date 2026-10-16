# Cancellation ledger guard and repended continuation

## Base and behavior

This branch was rebased onto main at `89b0229`, the rebased parent containing legacy cancellation continuation. Git dropped the duplicate parent `94c1bc2` and retained the ledger-preservation change from `6f4062f` as `37658cc`. Historical validation of the earlier parent and ledger-guard revision is not final-commit evidence for this follow-up.

Cancellation stops the run and settles interrupted attempts with exit 143. Under the run lock it publishes a changed stage ledger only if an existing readable ledger exactly matches the prior projection as persisted JSON. A crash-ahead ledger, any other disagreement, and missing or malformed ledgers remain untouched. Continuation still refuses inconsistent execution evidence.

Cancellation now retains pending stages as pending, including never-run and repended stages. The stopped run already fences ordinary scheduler publication. Removing the pending-to-skipped conversion also removes the need for a separate pending-ledger exception: the existing unchanged-stage check preserves pending ledgers. Completed stages retain their projections and ledgers. Continuation's compatibility rules are unchanged; it already accepts a pending projection with a settled ledger when immutable attempts and retry counts agree. No new state, admission exception, or configuration was added.

## End-to-end proofs

The public daemon spec creates its own HOME, state root, socket, mock provider and command PATH without service-manager commands. Before cancellation it admits a three-stage workflow, completes `done`, `done2` and `work`, and repends `work` using the store primitive used by the scheduler. Two cases cover a matching pending ledger (as published by terminal/research repend paths) and a retained complete ledger (the iteration-driver form).

Each case invokes the real CLI's `task cancel` through its private daemon, requires direct exit 0, checks byte-for-byte ledger preservation, and calls `assertContinuationCompatible`. It then invokes real `task resume`, requires direct exit 0, waits for the same run to complete and for its supervised workflow exit 0. Both completed stage objects and ledgers remain exactly equal; neither has a mock response available, so redispatch would fail. Work alone receives a second attempt. The first work execution is retained with its superseded disposition; admission may add audit metadata. Cleanup targets only fixture-owned daemon and supervision processes.

The cancellation specs exercise cancellation through `RunCancellationCoordinator` before continuation admission. A crash between ledger and projection publication, unrelated execution evidence, status-only disagreement, missing/malformed ledgers, and independently changed repended attempt/retry records all refuse. Readable files remain byte-for-byte unchanged, absent files stay absent, and refusal does not change the stopped projection. Existing running, closed-child and timeout/retry cancellation cases still verify exit 143, completed work preservation, unchanged earlier attempts, and rejection of late publication.

Before the runtime change, the same cancellation tests failed the pending-state expectations in five cases (direct exit 1). The first admission run also exposed invalid empty-workflow fixtures; these were corrected to valid single-stage workflows. The initial daemon run reached workflow completion in both cases but failed an overly strict prior-work assertion when admission added audit metadata; the corrected assertion retains all execution-field checks. These failed receipts are retained and are not counted as successful validation.

## Independent mutation checks

Each mutation starts from the final runtime source/spec baseline, receives a fresh ordinary build, and uses the normal Vitest configuration with build-freshness verification and `--maxWorkers=2`. Only one guard is changed at a time. The removed pending-specific guard is replaced by the existing unchanged-stage guard and checked independently; the removed pending-to-skipped conversion is also reintroduced independently.

All eight mutant builds exited 0; each mutant test command exited 1 with assertion failures, rather than setup errors.

| Independent mutation | Selected failures | Other selected passes |
| --- | ---: | ---: |
| Remove unchanged-stage skip | 1 | 1 |
| Permit missing ledger replacement | 1 | 0 |
| Permit malformed ledger replacement | 1 | 0 |
| Remove prior-projection equality check | 2 | 0 |
| Restore pending-to-skipped conversion | 4 | 0 |
| Bypass continuation status agreement | 1 | 0 |
| Bypass continuation retry agreement | 1 | 0 |
| Bypass continuation attempt agreement | 1 | 0 |

The unchanged-stage mutation rewrites the compact matching pending ledger; its retained-complete counterpart still passes. The conversion mutation fails both unit positives and both private daemon cases; the retained-complete cases specifically reproduce the projection/ledger-disagreement refusal. The matching-pending cases catch conversion rewriting the previously preserved ledger or changing the pending state. Missing and malformed handling are mutated separately. Continuation status, retry and attempt checks are likewise independent.

The runtime source and all changed specs were restored byte for byte, with matching SHA-256 digests. Before the purity correction described below, the restored build exited 0 and the ordinary focused run passed all 91 tests across seven files in 66.19 seconds, direct exit 0 (including both daemon lifecycles). The final mutation receipts supersede that baseline after making fixture HOME/FC_HOME explicit at both child-process call sites; execution isolation and runtime source are unchanged. All eight mutations were caught again, every mutant and restored build exited 0, restored SHA-256 digests match, and the expanded final focused suite passed 106 tests across eight files in 70.33 seconds, direct exit 0, including public-spec purity. Direct build/test exits, selected failures, timings and restoration receipts are in the task's external `fix2` evidence directory. Earlier combined mutations from the reviewed commit are historical evidence only.

## Final-commit validation

All commands and descendants run with niceness 19 on cores 6–11. The single full validator invocation ran on clean commit `312ae99`. Eight checks passed. The root suite passed 3722 tests and failed only its source-purity test, which also failed the public-isolation check: the new daemon fixture passed an already isolated environment through a variable, whereas the static checker requires HOME and FC_HOME inline at each child-process call. Both private daemon lifecycle cases passed in that full suite. The original full summary and failed logs are retained separately.

The fixture correction makes the existing private paths explicit, without changing runtime behavior or weakening the purity checker. After the correction, the final source/spec mutation checks and focused tests are repeated before commit. To respect the one-full-validation limit, only the failed root-suite and public-isolation checks are repeated after the final commit; the eight successful, unaffected checks are retained with their original commit provenance. The final summary names both commits and each direct result, rather than presenting retained checks as rerun. The verification log checks ancestry from `89b0229`, successful current results and a clean final tree. This report is not rewritten afterward, so the failed-check revalidation follows the final committed write.

The validator covers dependency installation, engine/UI builds, lint, TypeScript, root/UI tests, public-spec isolation under an unmapped UID, and the suite without service-manager commands. No real daemon, deployed checkout, real task, service-manager operation, merge or push is used. Nonempty review diff, focused/mutation logs, build logs, restoration receipts and verification output are kept in the requested task artifact directory; machine-specific paths and run identifiers remain outside the public repository.
