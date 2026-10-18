# Independent review of no-race-finish

Scope: the whole working diff against main, including removed competition code/specs, live and archived schemas, scheduler/store control, worker and both native adapters, public instructions, and restored architecture assets. Two independent Codex reviewers examined deadline/adapter behavior and historical continuation/scheduler behavior; the root reviewer checked the combined diff and fixes. The implementation report was read first. Original historical/provider trial evidence was evaluated as reported evidence; no live provider or additional private daemon was contacted.

## Findings: 3, all fixed

1. **Gate rejection could be overwritten at the warning boundary (high).** The worker followed the budget control branch before checking a valid authored `pass:false` result. A replacement finishing call could erase the rejection. The worker now validates and returns that completed rejection before reinvocation. Strengthened B04 returns rejection on the first call and would pass on a second; it reproduced the defect before the fix and requires exactly one invocation plus the original rejection verdict afterward.
2. **Provider backoff could consume the entire finishing interval (medium).** A 30-second retry delay in a 20-second slice slept through the warning because sleep observed only hard stop/cancellation. The existing bounded sleep now also observes the warning, and the existing finite retry loop immediately uses the remaining finishing time. Subsequent retries skip backoff once finishing starts. Hard deadline and cancellation remain authoritative; no retry allowance or clock was added. B39 covers warning during backoff, native-turn guidance, remaining finishing allocation, finite retries and timer disposal.
3. **Wrap-up delivery could be recorded without submitted adapter input (medium).** Preparing a prompt immediately wrote a delivery event, even if a native adapter failed before reporting input. The receipt now uses the existing invocation-input capture and checks its actual user prompt. B37 verifies no timestamp/event when an adapter advertises native capture but reports no submitted input. This receipt establishes input submission at the adapter boundary, not provider acknowledgement or completion; deterministic native children independently cover stdin delivery on both adapters.

## Required review areas

- **Previously deployed runs and mid-race history:** archived workflow/stage/plan schemas retain historical race fields and plan digests; ownership checks still refuse unknown consumers. Completed predecessors and accepted child gate provenance survive; unfinished candidate records/patches remain evidence without selecting or executing candidates. S04/S06 exercise serialized continuation and the public CLI; retained legacy ownership specs exercise unsafe-consumer refusal. No additional defect found.
- **Both native adapters and grace retention:** shared warning/abort control retains a single monotonic hard deadline across native calls, correction and retries. Codex stdin and Claude stream input are covered by deterministic native children, including captured-session and fresh-child paths. Verified forced closure retains admitted files and a typed unfinished handoff; unknown closure refuses execution. Scope/monitor refusal, idle/parent/supervisor abort and genuine rejection retain precedence. No further defect found.
- **Gate and validation time:** independent gates receive fresh budgets; pre-review configured commands share their gate's clock and abort signal. Wrapped reviews cannot publish acceptance, release consumers or run post-review validation. Post-author command validation has its own configured command bound. README wording was clarified to match this distinction.
- **Total bounds:** warning is `max(0, B - W - 5500)`, `W = min(300000, max(1, floor(B/10)))`, hard stop is `max(B, W + 5500)`, with a further bounded child-retirement/observation window. Finite workflow iterations are spent by every retained slice, including cancel/resume and scope suspension; exhaustion retains work as incomplete. Technical retries, repair loops and validation commands retain their existing independent bounds. A configured research wall ceiling prevents another slice at the boundary; there is no newly claimed universal workflow wall deadline.

## Architecture restoration

Restored both assets with git checkout and restored the README HTML image block. Removed only the two race-specific text elements inside the existing Author card; no card or connector was exclusive to race. The SVG layout/style and existing race-free alt text are preserved. Rendered with installed **librsvg and Cairo** through their shared-library APIs at the old PNG size, **1920 × 1080**, and visually inspected the result. Updated the structural regression to require the retained assets and reject obsolete diagram text.

## Validation

Final committed-tree verification exited **0** on commit `fc85c6a`: build passed; lint passed with **0 errors / 17 warnings**; the complete test population passed **308 files / 3,711 tests**, with **zero failures or skips**, in **379.74 seconds**. The requested clean-diff and empty ignored-tracked-file checks passed. `finish-validation.json`, `finish-verify-output.log`, `finish-final-tests.log`, `finish-source-identity.json` and `finish-privacy.json` retain receipts. All **635 tracked files** matched the committed worktree byte for byte before and after verification. Added committed text has zero private-path, private-name or run-identifier matches in the privacy check.

Focused subsets also passed: **21 historical/legacy ownership tests in 2 files**, and **82 deadline/correction tests in 3 files**. These are subsets of the full population, not additional distinct coverage. B04 reproduced its original defect before the fix. No extra live-provider, mutation or private-daemon trial was run.

Commands used CPU affinity **6–11** and **nice 19**. The build rejects staging beneath its own source root, so final verification ran the requested build/lint/full-test pipeline in a clean clone of the same commit inside this worktree, using staging beside that snapshot. Temporary storage remained inside this worktree and was presented as `/tmp` in a private mount namespace; the original UID was preserved and all capabilities were dropped after mounting. This provides normal temporary-path, Git-discovery and Unix-permission behavior. The temporary storage was removed after verification; the source snapshots and logs remain under this ignored report directory.

Exploratory environment failures are preserved rather than attributed to production code. The initial local scratch parent inherited the repository ES module setting; explicitly selecting CommonJS matched normal extensionless native fixtures and all 82 focused tests passed. The first full run reached all 3,711 tests with four failures: two nominally non-Git fixtures discovered the enclosing worktree and two Unix socket paths were 114 bytes. A private mount fixed those path assumptions; its first full run passed 3,710 tests but one permission fixture exposed retained capabilities. Dropping those capabilities yielded the final all-pass full population. Source, tests and test selection did not change during these environment corrections.

Write-location deviation: the initial ordinary build used the builder's default system-temporary staging before its staging rules were inspected. That staging write was outside the requested worktree. It published only this worktree's ignored build outputs; no deployed source/distribution, operator state or daemon was changed. Subsequent builds/tests used worktree-backed scratch and the isolated source snapshot. No private auth files were read.


## Finished work at the budget wrap-up boundary

The decision field is the stage-authored `remaining_work` array. A validated author
result with `status: "delivered"` and `remaining_work: []`, or a validated passing
gate verdict with `remaining_work: []`, settles normally even if the warning
arrived before the result was observed or the work finished in the finishing
turn. The author reaches its independent gates, and a gate publishes its verdict.
Neither outcome creates a budget continuation or spends another iteration. A
completed gate rejection retains its existing authority, including older results
without this field.

A nonempty list means unfinished work. An omitted list is ambiguous and retains
the budget handoff: older `delivered` and `pass: true` results can describe a
partial slice, so those fields and free-text summaries cannot safely certify
completion. A blocked author with an empty list also remains unfinished. A
malformed list follows the existing bounded correction/refusal path; it never
certifies completion. Forced stopping still retains unfinished work regardless
of the returned list. Cancellation, closure verification, scope controls and
settlement refusals keep their existing precedence.

One predicate now governs both the warning reinvocation boundary and normal
settlement, including verdict publication, mandatory artifact checks and budget
retention. Warning telemetry is preserved when work completes. The wrap-up
instruction makes continuation conditional and requests the explicit list. Author
generation requires the field to preserve native constrained output; the existing
recorded-handoff schema accepts older results without it. Gate schemas accept the
optional list without changing their existing generation compatibility. No new
scheduler state, option, continuation channel or iteration rule was added.

The same frozen `stage-budget.test.ts` cases were run with three source variants:
original `fc85c6a`, original worker plus only the result-schema extension, and the
complete fix. Every variant built successfully. The schema-only control separates
the deadline defect from the original schema's refusal of the new field.

| Cases | Original source | Original worker, schema support | Fixed source |
| --- | --- | --- | --- |
| B40: author completes on original / finishing invocation | 2 fail | 2 fail | 2 pass |
| B41: gate passes on original / finishing invocation | 2 fail | 2 fail | 2 pass |
| B42: author reports remaining work and continues | fail | pass | pass |
| B43: one iteration, author / gate, original / finishing invocation | 4 fail | 4 fail | 4 pass |
| B44: completed author still owes its declared artifact | fail | fail | pass |
| B45: legacy omission accepted; malformed lists refused | fail | pass | pass |
| B46: blocked author with empty list remains unfinished | fail | pass | pass |
| B17: explicit remaining review work cannot publish acceptance | fail | pass | pass |
| Existing B17: omitted list cannot publish acceptance | pass | pass | pass |
| Total | 13 fail / 1 pass | 9 fail / 5 pass | 14 pass |

B40/B41 assert one invocation when already finished at the warning, two when the
finishing turn completes the work, one attempt and one workflow iteration. Gate
input contains the completed author's result and both units exist. B41 also
checks that the published pass is readable. All four B43 combinations complete
with `max_iterations: 1`; the original worker reports incomplete. B42 still spends
two iterations and consumes the byte-identical authored handoff and retained
file. B35 additionally returns an empty completion list at the hard stop and
still requires forced retention. These observations establish the improvement on
the same deterministic work without making provider speed or token-cost claims.

Local receipts are worktree-relative: `.tmp_verify/proof-baseline-tests.log`,
`.tmp_verify/proof-schema-control-tests.log`, `.tmp_verify/proof-fixed-tests.log`
and the corresponding build logs. Broader focused verification passed **110 tests
in 5 files**; build passed and lint had **0 errors / 17 warnings**. Existing author
generation fixtures were updated to include the newly required field; native
schema compatibility assertions remain enabled. Independent read-only review
found no further defect.

Verification uses an isolated tracked-source snapshot inside the worktree.
Build staging is beside that snapshot because the builder rejects staging under
its source root. A private mount presents worktree-backed scratch as the system
temporary directory; temporary paths are canonicalized before npm runs so native
adapter home checks see physical directories. The original UID is preserved,
mount capabilities are dropped before build/test, and commands use CPU affinity
6–11 and nice 19. No deployed distribution, operator state or daemon is modified.

Write-location deviation: initial npm invocations used the default diagnostic
cache and created logs outside the worktree. Those logs were not read or changed.
Subsequent npm caches, build staging and test scratch use worktree-backed storage.
