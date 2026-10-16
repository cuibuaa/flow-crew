# Guard cancellation ledger settlement

Cancellation settles interrupted attempts with exit 143. Under the run lock it publishes a changed stage ledger only when the prior projection was not pending and an existing readable ledger exactly matched that prior projection as persisted JSON. A ledger ahead after a crash between ledger publication and run projection publication, or disagreeing for another reason, remains byte-for-byte untouched; missing or malformed ledgers are also preserved. Cancellation still stops the run, but continuation refuses inconsistent execution evidence. Never-run and repended stages can become skipped in the projection without creating or rewriting their ledgers. Completed stages and earlier settled attempts retain their records. The shared attempt settlement also serves host-restart recovery.

Explicit continuation recognizes the older cancellation record only when the stopped run retains its cancellation decision and timestamp, the entire interrupted stage record matches its running ledger apart from the cancelled projection status, and existing scheduler/controller/command ownership evidence proves the former execution is gone. The exact deterministic terminal ledger is also accepted after a split settlement publication. Other ledger differences, missing ownership, live or unreadable owners, unknown command fate, incompatible plans and invalid budgets still refuse admission. Compatibility checks run before settlement. The run snapshot and ledger digests are rechecked under the run lock; cancellation owner checks run only there, before settlement mutation. Continuation uses its separately proven legacy or split-publication evidence rather than cancellation's prior-projection equality rule. Ordinary stopped-run publication fences remain intact.

## Regression and mutation proofs

The cancellation specs retain running-child, closed-child, and timeout-then-retry settlement coverage, including unchanged completed work and earlier attempts and refusal of late worker publication. They now require no ledger for a never-run stage. Six added cases preserve a crash-ahead completed ledger, an unrelated ledger difference, missing and malformed ledgers, and repended stages with either a retained complete ledger or a matching pending ledger. Both independent ledger-disagreement cases require continuation's specific projection/ledger-disagreement refusal, and preserved files are compared byte for byte.

The legacy specs contain five positive admission cases: ordinary cancellation, timeout before cancellation, closed child, reused controller PID, and exact split-ledger convergence. Nineteen refusal cases cover live or unverifiable ownership and independent execution evidence errors. The two workflow cases run through completion and dispatch only the unfinished stage.

- Focused suite on the final source: five files, 63 tests passed, direct exit 0.
- Ledger-guard mutation: removed the cancellation-only pending/equality/existing-ledger guard. All nine cancellation cases failed, direct exit 1.
- Projection-only cancellation mutation: restored the old running-to-failed projection change and disabled cancellation ledger publication. All three selected interrupted-settlement cases failed, with six other cases skipped, direct exit 1.
- Legacy-recognition mutation: disabled recognition with `if (false && …)`. All five positive admission cases failed, as did the malformed-token live-command refusal case because its expected specific diagnostic changed. Eighteen other refusal cases passed, direct exit 1.
- Every mutant build exited 0; each test used the normal Vitest configuration including the build-freshness global setup. The runtime source and both relevant specs were restored byte for byte and their SHA-256 digests matched the saved final-source baseline. The restored build exited 0 and the repeated ordinary focused run passed all 63 tests across five files, direct exit 0, before commit.

The parent's earlier mutation checks ran before later source/spec edits and used a temporary configuration omitting the build-freshness global setup. Their result was three cancellation failures and six continuation failures with eighteen passes. That sixth continuation failure was the malformed live-command identity refusal test, whose expected error changes when legacy recognition is disabled; there were only five positive admission cases. Those earlier checks were not final-source mutation evidence. The new checks above supersede them.

## Inherited private lifecycle verification

The baseline report tested the same deterministic workflow on `131333c → 28c1dcc`: direct cancellation exit 0, direct task-resume exit 1, no new work attempt. Its old-engine control resumed successfully. The parent change was tested against the same old revision and workflow, using real private daemons and native fixture children. The lifecycle receipts below are inherited parent evidence, not a claim that these long-running lifecycles were repeated for this ledger-guard follow-up.

The lifecycle uses an isolated HOME, state root, temporary directory, socket, installed configuration and deterministic provider stub. Work stays alive for 185 seconds. The ordinary attempt has a 300000 ms deadline. The timeout variant has a 185000 ms deadline, waits for the first attempt to fail with exit 124 and for technical retry 2 to start, then cancels that retry. Old-daemon CLI stop and actual process exit precede the candidate build/start against the same state. Engine source and run state are never patched to admit continuation. Heavy commands use cores 6–11.

Reproduction, with paths supplied by the operator and private dependency directories:

```bash
PROBE_MODE=task PROBE_NEW_ENGINE="$CANDIDATE" \
  nice -n 19 taskset -c 6-11 node "$PROBE" redeploy \
  --worktree "$CANDIDATE" --revision 131333c \
  --fixture recovery --timeout 600 --expect complete
PROBE_MODE=task PROBE_CANCEL_WHEN=after-deadline PROBE_NEW_ENGINE="$CANDIDATE" \
  nice -n 19 taskset -c 6-11 node "$PROBE" redeploy \
  --worktree "$CANDIDATE" --revision 131333c \
  --fixture recovery --timeout 600 --expect complete
```

The standalone probe from the baseline experiment was adapted outside this repository: an operator-controlled deploy gate pauses after old-daemon exit, dependencies are copied privately to avoid validation-install races, and the timeout predicate waits for the actual timeout-plus-running-retry state instead of requiring the latest attempt to remain failed. Initial dependency-setup failures and the original timeout predicate race were retained as failed receipts; they are not counted as successful lifecycle evidence.

Both final lifecycle harnesses and the independent receipt verifier exited 0. The following are direct child-command exits from each receipt's `checks` array, rather than inferred harness outcomes:

| Lifecycle | Cancel | Old daemon stop | Candidate build | Task resume | Final work attempts |
| --- | ---: | ---: | ---: | ---: | --- |
| In-flight cancellation | 0 | 0 | 0 | 0 | failed 143 → complete 0 |
| Timeout → retry → cancel | 0 | 0 | 0 | 0 | failed 124 → failed 143 → complete 0 |

The actual first-work-attempt-start to cancellation intervals were 185.935 seconds and 186.175 seconds respectively. The timeout was real: its first attempt recorded elapsed 185194 ms and termination cause `attempt_timeout` before retry 2 started. On resume the unfinished attempt settled as `CANCELLED_INTERRUPTED: Cancelled by user`; the earlier timeout remained unchanged and only work received a new attempt (2 ordinarily, 3 after the timeout).

For both successful lifecycles, the complete `done` and `done2` stage objects were JSON-equivalent before cancellation and after completion. The final work ledger exactly matched its run projection, no attempt remained running, the registry was `done`, the run was `complete`, and exactly one run-completed event was recorded. Cleanup confirmed no owned processes or socket remained, including the earlier failed harness trials.

Both old private engines had fingerprint `de193c5cb6aa36a36f045c33d0f2b4564e91c2d27a7eff1949425727d31cfea6`, generation `8186fc3a54bb1f63e27f42610dccef95e027d59008a63c192453592494aea9cd`, matching the baseline's cold `131333c` build. Both parent candidate fingerprints were `ac0e39df45cdf03985f895fd58bb1ddca4c0a1c446011b4751c48485fcb24ff9`, generation `972735da8bbeda69414b5e332929909cc8c0e957108eb76c995e30f2a196b64b`. All four changed runtime source files in each snapshot matched the parent candidate worktree byte for byte. No real daemon, deployment, task, service manager or state root was accessed.

## Validation timing and artifacts

The reviewed parent validation on commit `62dbda3` began after that commit, with a clean tree, and finished with `DONE` and all ten direct results `rc=0`. The review records 508 seconds for the committed run; the previously quoted 330-second measurement belonged to an earlier uncommitted tree. These are historical parent results, not measurements of this follow-up.

This follow-up's focused and mutation checks run on the final runtime source and specs before commit. Each mutant receives a fresh build, the ordinary Vitest configuration and `--maxWorkers=2`; no freshness setup is omitted. All commands and descendants use niceness 19 and cores 6–11. The required single full validation runs after this report and the source are committed, on a clean worktree. Pending at report commit: its ten direct exits, timings and `DONE` marker will be recorded in the external validator summary, with the final clean-tree assertion in the verification log. This report is not rewritten afterward, so that validation follows the last committed write.

The full validator covers both dependency installs, engine build, lint, TypeScript, UI build/tests, root tests, public-spec isolation under an unmapped UID, and the no-service-manager suite. No real daemon, deployment, service-manager operation or real task is used by this follow-up.

The parent's empty `review.diff` and `verify.log` are not evidence. This follow-up retains a nonempty branch-base review diff, focused and mutation logs, build logs, source/spec SHA-256 restoration receipts, and a nonempty verification log alongside the validator outputs in private operator evidence. Machine-specific paths and run identifiers stay outside this public report.
