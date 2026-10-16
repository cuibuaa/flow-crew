# Continue a legacy cancelled run

Cancellation now settles interrupted attempts with exit 143 and publishes the stage status ledger and run projection under the same run lock. Completed stages and earlier settled attempts retain their records. The shared settlement also replaces the equivalent host-restart completion switch.

Explicit continuation recognizes the older cancellation record only when the stopped run retains its cancellation decision and timestamp, the entire interrupted stage record matches its running ledger apart from the cancelled projection status, and existing scheduler/controller/command ownership evidence proves the former execution is gone. The exact deterministic terminal ledger is also accepted after a split settlement publication. Other ledger differences, missing ownership, live or unreadable owners, unknown command fate, incompatible plans and invalid budgets still refuse admission. All checks run before mutation, with state, ledger and owner checks repeated under the run lock. Ordinary stopped-run publication fences remain intact.

## Regression and mutation proofs

The new cancellation specs cover a running child, a closed child, and timeout followed by technical retry. They check terminal attempt/ledger agreement, unchanged completed work and earlier attempts, and refusal of late worker publication after cancellation.

The new legacy specs exercise continuation through completion with only the interrupted stage dispatched, both with and without an earlier timeout. They also cover exact split-ledger convergence, closed children, reused controller PIDs, active command groups, unreadable or malformed identities, missing ownership, and independent ledger/budget/timing errors.

- Focused source regression suite: 5 files, 71 tests passed, direct exit 0.
- Cancellation mutation: restored the old projection-only cancellation instead of shared settlement. All 3 new cancellation cases failed, direct exit 1.
- Continuation mutation: disabled recognition of legacy cancellation. All 6 positive legacy-admission cases failed; 18 refusal cases passed, direct exit 1.
- Both mutations were restored. Their focused runs retained normal test setup; only the build-freshness global setup was omitted during source mutations. The final validation uses the ordinary configuration and a fresh build.

## Private lifecycle verification

The baseline report tested the same deterministic workflow on `131333c → 28c1dcc`: direct cancellation exit 0, direct task-resume exit 1, no new work attempt. Its old-engine control resumed successfully. This change is tested against the same old revision and workflow, using real private daemons and native fixture children.

The lifecycle uses an isolated HOME, state root, temporary directory, socket, installed configuration and deterministic provider stub. Work stays alive for 185 seconds. The ordinary attempt has a 300000 ms deadline. The timeout variant has a 185000 ms deadline, waits for the first attempt to fail with exit 124 and for technical retry 2 to start, then cancels that retry. Old-daemon CLI stop and actual process exit precede the candidate build/start against the same state. Engine source and run state are never patched to admit continuation. Heavy commands use cores 6–11.

Reproduction, with paths supplied by the operator and private dependency directories:

```bash
PROBE_MODE=task PROBE_NEW_ENGINE="$CANDIDATE" \
  taskset -c 6-11 node "$PROBE" redeploy \
  --worktree "$CANDIDATE" --revision 131333c \
  --fixture recovery --timeout 600 --expect complete
PROBE_MODE=task PROBE_CANCEL_WHEN=after-deadline PROBE_NEW_ENGINE="$CANDIDATE" \
  taskset -c 6-11 node "$PROBE" redeploy \
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

Both old private engines had fingerprint `de193c5cb6aa36a36f045c33d0f2b4564e91c2d27a7eff1949425727d31cfea6`, generation `8186fc3a54bb1f63e27f42610dccef95e027d59008a63c192453592494aea9cd`, matching the baseline's cold `131333c` build. Both candidate fingerprints were `ac0e39df45cdf03985f895fd58bb1ddca4c0a1c446011b4751c48485fcb24ff9`, generation `972735da8bbeda69414b5e332929909cc8c0e957108eb76c995e30f2a196b64b`. All four changed runtime source files in each snapshot matched the candidate worktree byte for byte. No real daemon, deployment, task, service manager or state root was accessed.

## Final validation

The required `fc-validate.sh` run finished with `DONE` and all ten direct results `rc=0`: both dependency installs, engine build, lint, TypeScript, UI build, UI tests, full root tests, public-spec isolation under an unmapped UID, and the no-service-manager suite. The final root test command took 330 seconds. The two repository-contract failures found in the first validation (child-probe isolation and status constants) were corrected; their ordinary focused run passed 43 tests before the final full validation. Both real lifecycles were repeated against the final source afterward.

The requested final assertion passed: no nonzero `rc` in the final summary, `DONE` present, and this report nonempty. Mutation receipts, direct lifecycle CLI logs, state/ledger snapshots, build identities, source-byte comparisons and independent verification logs remain in private operator evidence; machine-specific paths and run identifiers are intentionally excluded from this public report.
