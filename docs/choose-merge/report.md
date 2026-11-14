# Planner owns the engineering entry — independent takeover review

Outcome: **incomplete under the brief's allowed stopping outcome**. The planner-entry removal, compatibility handling and tests are retained and independently checked. The literal universal `gate-kept` criterion cannot be met while preserving the admission rules and generic graph behavior that the same brief protects. No admission or acceptance policy was invented to hide that conflict.

The unreviewed draft was first preserved verbatim as commit `58c947d`, then rebased onto `a24bba6` (local `main`). Before references in the consumer inventory below refer to the original `1d2af4a` source; current references refer to the rebased tree. The frozen `EVIDENCE.md` was read and left unchanged. Historical operator runs were neither read nor executed. Draft test claims are superseded by the takeover's retained command logs and native Vitest reports.

## 1. Criteria and independent evidence

| Criterion | Result and evidence |
| --- | --- |
| `no-shape-model` | Met. `config/workflows/entry.yaml:3` contains exactly the dynamic planner, without a predecessor or fixed dispatch. Active kind schema at `src/scheduler/sched_admission/configuration.ts:58` excludes shape. `src/decision-graph.ts:9` has no chooser schema or prompt. **starts entry at the planner with no preceding decision or fixed answer** (`spec/planner-entry.test.ts:36`) checks the entire entry graph and rejects an active shape kind; restoring a pre-planner stage fails its stage-count assertion. |
| `planner-owns-shape` | Met. `config/agents/planner.yaml:29` assigns the minimal/decomposed graph to planning. `src/scheduler/sched_loop/ordinary-stage.ts:77` supplies the planner contract; `src/scheduler/sched_policy/dispatch-injection.ts:36` uses the same `createDispatchAdmission` (`src/scheduler/sched_admission/dispatch.ts:205`). **admits a planner graph with %s author duties through dispatch admission and independent acceptance** (`spec/planner-entry.test.ts:45`, counts 1 and 2) checks persisted admission, author execution and independent gate acceptance for both shapes. The minimal success path includes a dormant repair route required by existing admission. |
| `gate-kept` | **Partial / blocked by the scope constraint.** Criterion-bearing work retains gate coverage at `src/scheduler/sched_admission/dispatch.ts:275`; repair-route admission remains at `:233`. **refuses an ungated planner graph with %s author duties before execution** (`spec/planner-entry.test.ts:70`, counts 1 and 2) exercises that boundary. Review, repair and replan tests are retained; examples: **records valid, invalid-default and outside-set refusal in one real scheduler run** (`spec/decision-graph.test.ts:107`), **honors the full gate choice over a planner repair condition (initial pass=%s)** (`:521`), **appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)** (`:344`), and `spec/gate-repair-confirmation.test.ts`. The universal property is disproved below. |
| `old-records-readable` | Met. Recorded kind decoding at `src/scheduler/sched_admission/configuration.ts:69` preserves historical shape metadata; active decoding refuses it. Archived assumptions remain at `src/decision-graph.ts:20`, rendered by `src/run-summary.ts:397`. Typed `ContinuationRefusal` / `retired_shape_decision` at `src/engine-continuation.ts:16` is checked before library launch writes at `src/scheduler/sched_loop/launch.ts:55`. **reads legacy choose/shape through status, listing, summary and rendered UI; refuses resume without mutation** (`spec/planner-entry.test.ts:90`) covers all readers, status CLI, rendered UI, both continuation paths, zero adapter calls, and unchanged run-directory bytes. |
| `no-new-rule` | Met by the source diff and active schema/entry test. No classifier, keyword rule, size threshold, option, flag or declaration key was added. The only historical shape branch is typed-metadata execution refusal (`src/engine-continuation.ts:21`). Research routing remains declaration-owned at `src/scheduler/sched_admission/brief-contract.ts:29`. |
| `light-tests` | Met. Planner-entry cases use stub adapters and stationary attempt clocks (`spec/test-support/stage-deadline.ts:8`); the explicit fixture proposal at `spec/test-support/planner-entry.ts:6` is test data. No test verdict asserts real elapsed time. CLI subprocess timeout is a hang bound. Related-spec selection follows transitive local imports through `src/`, baseline/final mentions of removed symbols, every replay and `spec/engine/`, plus purity. |

### The constraint conflict and smallest alternative

The independent `gate-probe.mjs` was run against the complete `src/` and `config/` snapshot of `a24bba6` and against this tree, using the same parsed one-author proposal with `artifact_contract: {version: 1, produces: [], reads: []}`, no criteria, no outputs and no gate. Both returned `pass: true`, `errors: []`, `criterionGateRefs: {}` (`gate-probe.json`, exit 0). This is an unchanged admission boundary, not a side effect of removing choose.

`src/scheduler/sched_admission/dispatch.ts:257` defaults absent criteria to an empty list; mandatory gate coverage is inside the criterion loop at `:274`, so that loop cannot reject this proposal. Existing **admits planner roots as conditional DAG duties without inventing a chosen successor** (`spec/planner-dispatch-condition.test.ts:29`) runs an ungated planner graph to `complete`. Existing **records valid, invalid-default and outside-set refusal in one real scheduler run** (`spec/decision-graph.test.ts:107`) also requires an ungated generic graph to complete. The brief says both “Every admitted plan still ends in an independent gate before acceptance” and “Out of scope, do not change: ... plan admission rules”, and requires existing generic graph behavior/tests to remain.

Smallest textual alternative: narrow `gate-kept` to **every admitted criterion-bearing plan** while retaining current admission. If the literal universal guarantee is required, the smallest policy alternative is to authorize rejecting ungated planner proposals in `createDispatchAdmission` and updating the conflicting planner-condition contract; that changes an expressly protected rule. Neither alternative was applied. No stage, gate, option or heuristic was inserted outside the planner's admitted graph.

## 2. Consumers and dispositions

This table covers every direct production reference to the removed stage/kind/prompt and its exclusive behavior in the captured starting tree. Unrelated English uses of “choose” are unchanged.

| Consumer (before) | Disposition (after) |
| --- | --- |
| `config/workflows/entry.yaml:4` chooser and `:18` fixed dispatch | Removed both; only planner remains at `:3`. Its dependency on choose is gone. |
| `config/agents/planner.yaml:29` chooser ownership | Planner now owns minimal or decomposed proposals at `:29`; assumptions belong in assigned work. |
| `src/decision-graph.ts:11`, `:54`, `:63` shape schema, invalid-chooser throw, `CHOOSER_PROMPT`; `:59` active assumptions projection | Removed. Generic successor/review schema and defaults remain at `:9`, `:48`; historical `DecisionRecord.assumptions` remains at `:20`. |
| `src/decision-context.ts:5`, `:60` chooser import/task-only input | Removed import and shape input branch. Review-only isolated facts remain at `:58`. |
| `src/worker.ts:107`, `:979` special `decisionResult: 'shape'` validation handling | Boolean decision result only at the same locations. Review/successor defaults remain scheduler-owned. |
| `src/scheduler/sched_loop/ordinary-stage.ts:103`, `:111`, `:117` shape isolation/tool stripping/result mode | Only review decisions use those isolated paths at the same locations; planners use the ordinary dynamic-dispatch path. |
| `src/scheduler/sched_loop/decisions.ts:127`, `:154`, `:168` fixedShape, unknown-target exception, fixed-entry dispatch materialization and admission | Removed all three and their exclusive imports/arguments. Normal destination/replan settlement remains at `:149`, `:156`, `:166`. `src/scheduler/sched_loop/iteration.ts:55` no longer passes the now-unused workflow and role registry to settlement. |
| `src/scheduler/sched_admission/configuration.ts:58`, `:122` shape enum and dispatcher-only rejection | Removed active enum member and redundant custom check. Historical decoder explicitly permits it at `:72`. Normal plan parser at `:123` rejects it via the active schema. |
| `src/scheduler/sched_admission/dispatch.ts:229`, `:267` unknown-successor and criterion-assignment exceptions | Shape exclusions removed at the same lines. All live proposals obey the ordinary checks; gate/repair admission rules were retained. |
| `src/scheduler/sched_admission/frontier.ts:62` chooser exception for reused dispatched IDs | Removed dispatched-ID exception; generic graph/replan ownership remains at `:62`. |
| `src/scheduler/sched_loop/stage-batch.ts:52` shape guard around static plan answering | Removed the guard. `answerWithFixedPlan` at `:200` remains for the public library's fixed `direct.yaml` workflow, admitted by the ordinary dispatcher. Entry has no fixed dispatch. |
| `src/scheduler/sched_policy/dispatch-injection.ts:32`, `:232` shape-containing replan bootstrap filters | Bootstrap now retains only dynamic planners at the same locations; generic revision/admission machinery stays. |
| `src/scheduler/sched_scope/frozen-inputs.ts:29` shape read-only carveout | Removed; independent gates and review decisions retain read-only treatment at the same line. |
| `src/scheduler/sched_settlement/gate-validation.ts:170` shape validation exclusion | Removed; review decisions, planners and gates retain their existing handling at `:160` after the rebase. |
| `src/scheduler/sched_admission/brief-contract.ts:28` chooser description/reason | Says planner at the same lines; declaration-based research routing is unchanged. |

Generic consumers were traced and retained: decision lifecycle in `src/scheduler/sched_loop/iteration-setup.ts:74`, `src/scheduler/sched_loop/iteration.ts:57`, `src/scheduler/sched_loop/stage-batch.ts:40`; acceptance/outstanding duties in `src/scheduler/sched_settlement/completion.ts:72`, `src/declared-artifact-audit.ts:18`, `src/scheduler/sched_settlement/gate-verdict.ts:126`; planner/revision identity in `src/scheduler/sched_loop/planner-dispatch.ts:26`, `src/plan-revisions.ts:89`; immutable graph history in `src/store.ts:1227`; own-attempt predecessors in `src/decision-context.ts:59`. These consume generic graph records rather than chooser semantics. Campaign context, declaration-owned research selection, write authority, ship-setup and assessment routing were not redesigned. The complete `POST_AUTHOR_PROMPT`/`declareReviewChoices` suffix is byte-identical to the initial source snapshot.

All four shipped workflow files remain reachable: CLI engineering entry loads `entry.yaml` (`src/cli.ts:1218`); declaration-owned research uses `research.yaml` and its existing constructed workflow; `plan-check --brief` loads `planner.yaml` or research (`src/plan-interface.ts:82`); exported `loadWorkflow`/`runWorkflow` support `direct.yaml` as a fixed-plan library workflow, exercised by `spec/direct-workflow.test.ts`. Historical continuation also loads the recorded workflow. No whole production workflow or code file became unreachable. The chooser-only blocks listed above were deleted, rather than retained beside the planner.

Test consumers now author proposals through `spec/test-support/planner-entry.ts`, or retain their explicitly decomposed proposals. Mock launch fixtures in adapter-availability, quick-foreground, supervised-lifecycle and brief-writer now provide `plan.json`. Ledger retry isolation and write-grant isolation use the retained review kind. Historical JSON fixtures under `spec/fixtures/no-approvals/`, `spec/fixtures/run-tree-continuity.json`, the pinned historical `validation-budget-trial.py`, and the historical push-rendering request remain historical data/standalone replay inputs; they are not reachable from the new entry or a replacement selector. `brief-writer.ts` assumptions are brief inputs, a separate contract.

## 3. Operator behavior for old runs

Old runs remain listed, with their `choose` stage, successor, outcome, reason and assumptions intact. Status does not relabel them as planner runs. The summary retains its “Chooser assumptions” section. Dashboard conversion and server-rendered UI detail retain the stage. Read-only workflow decoding does not migrate stored bytes.

A recorded workflow or plan containing `kind: shape` receives typed `ContinuationRefusal`, code `retired_shape_decision`, and guidance to start a new planner run with historical evidence. Checks precede normalization, claims, recovery and execution, including direct library launch. `src/engine-continuation.ts:26` prevents refusal publication from mutating retired records. Hashless records keep their existing contract refusal. Generic historical decisions retain their successor decoder. The legacy integration case asserts all run-directory bytes remain unchanged.

## 4. Removed and added mechanisms; measured footprint

Removed: the entry chooser model call and fixed answer (`config/workflows/entry.yaml:4` before → planner-only `:3` after), chooser prompt/input (`src/decision-graph.ts:63`, `src/decision-context.ts:60` before → absent), special shape validation, fixed-entry dispatch materialization (`src/scheduler/sched_loop/decisions.ts:168` before → ordinary destination settlement at `:166` after), and chooser-only admission, readiness, write and replan exceptions inventoried above.

Added: read-only historical kind decoding (`src/scheduler/sched_admission/configuration.ts:69`), typed retired-workflow refusal and protected refusal publication (`src/engine-continuation.ts:16`, `:26`), and pre-write launch guards (`src/scheduler/sched_loop/launch.ts:55`). This compatibility work replaces active shape-specific execution paths. No new production file or selection mechanism was added.

All four shipped workflows remain reachable: engineering CLI `entry.yaml` (`src/cli.ts:1231`); declaration-owned research; `planner.yaml` for `plan-check --brief` (`src/plan-interface.ts:83`); `direct.yaml` through public `loadWorkflow` / `runWorkflow` (`src/scheduler.ts:11`, `spec/direct-workflow.test.ts`). No shipped workflow became unreachable. Main's removal of unreachable helpers remains intact.

The same-work comparison against `a24bba6` uses physical `splitlines()` counts for every regular production file: **214 files, 51,902 → 51,882 lines**. The **18 changed production files** total **4,495 → 4,475 lines**, a net reduction of 20. Against the original draft base `1d2af4a`, production had 215 files / 52,346 lines; main accounts for the intervening helper removals. `production-counts.json` contains all three snapshots.

| Changed production file | Main before | Final after |
| --- | ---: | ---: |
| `config/agents/planner.yaml` | 61 | 65 |
| `config/workflows/entry.yaml` | 47 | 8 |
| `src/decision-context.ts` | 75 | 73 |
| `src/decision-graph.ts` | 99 | 92 |
| `src/engine-continuation.ts` | 92 | 113 |
| `src/scheduler/sched_admission/brief-contract.ts` | 160 | 160 |
| `src/scheduler/sched_admission/configuration.ts` | 185 | 192 |
| `src/scheduler/sched_admission/dispatch.ts` | 309 | 309 |
| `src/scheduler/sched_admission/frontier.ts` | 285 | 284 |
| `src/scheduler/sched_loop/decisions.ts` | 208 | 201 |
| `src/scheduler/sched_loop/iteration.ts` | 64 | 64 |
| `src/scheduler/sched_loop/launch.ts` | 391 | 395 |
| `src/scheduler/sched_loop/ordinary-stage.ts` | 144 | 144 |
| `src/scheduler/sched_loop/stage-batch.ts` | 219 | 219 |
| `src/scheduler/sched_policy/dispatch-injection.ts` | 323 | 323 |
| `src/scheduler/sched_scope/frozen-inputs.ts` | 149 | 149 |
| `src/scheduler/sched_settlement/gate-validation.ts` | 281 | 281 |
| `src/worker.ts` | 1403 | 1403 |

The established benefit is one fewer pre-planning model stage and fewer source mechanisms. The frozen audit has no matched same-task comparison establishing latency, quality or completion-rate improvement. No such improvement is claimed.

Shipped guides describe planner entry (`guide/brief-contract.md:62`, `guide/configuration.md:145`, `guide/operations.md:298`). Ship revision **56**, digest **1160ab38a7e6**, is asserted at `spec/ship-docs.test.ts:140`.

## 5. Complete test-change accounting

No spec file was deleted. Existing generic graph, gate, repair and replan tests remain. Changes to entry call traces replace `choose, implement` with `plan, implement` or remove `choose` before an already scripted planner. They do not remove review, repair, revision, budget, artifact, frozen-input or write-isolation assertions.

Removed chooser-only test templates in `spec/no-approvals.test.ts`:

- **chooses on an ambiguous brief and retains assumptions in the ledger, run record and report without a pause**: active chooser assumptions no longer exist; historical assumptions/readability are covered by the new synthetic legacy test.
- **fails invalid chooser attempts and uses the existing retry without inventing a question or choice**: removed chooser failure interface. Existing planner admission/retry tests remain.
- **recovers from a malformed chooser reply on the next ordinary attempt**: removed chooser reply parser; generic decision defaults and planner retry coverage remain.
- **corrects a stale metric_search reply with $shape without changing engineering mode** (declared missing facts; empty missing facts): removed stale chooser-output contract. The declaration-owned engineering/research test remains.

Removed parameter case: **shape: at-limit enters, above-limit receives the typed refusal** in `spec/stage-duration-limit.test.ts`. The retired path cannot execute; ordinary/planner/review/successor/repair/re-evaluation/research cases remain.

Renamed titles:

- **ignores an outward-effect request slot, completes both decision stages and gates, and reports the gap** → **ignores an outward-effect request slot, completes planning, assessment and gates, and reports the gap**: identifies the new entry path while retaining unattended execution/gap checks.
- **refuses retired research declarations before the chooser: %j** → **refuses retired research declarations before the planner: %j**: declaration refusal still precedes execution.
- Describe groups **model-selected decomposition** → **planner-authored decomposition**, and **one entry, with model-owned shape selection** → **one entry, with planner-owned shape**: accurately name the shape owner; constituent cases remain.

Inverted title/behavior:

- **grants the entry fixed-shape choice before dispatching its conditional implement stage** → **keeps planner-authored root conditions active without a pre-planner grant** (`spec/planner-dispatch-condition.test.ts:66`): the removed chooser grant no longer overrides a planned root's false condition. The generic graph-grant condition test in `spec/decision-graph.test.ts:597` remains unchanged in behavior.

Other deliberately changed historical-identity assertions, with titles retained:

- **appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)**: compares retained planner bootstrap identity instead of removed chooser identity; all revision immutability and budget assertions remain.
- **admits a separately planned shape and still routes every review through assessment**: first decision record is now assessment, with the same independent review assertion.
- **keeps isolated decision retries cold while retaining their exact own final record** (`spec/ledger-handoff.test.ts`): uses a review decision in place of shape; cold retries and exact predecessor checks remain.
- The isolated-decision parameter of **preserves admitted external outputs and the shared boundary for a scheduler %s** (`spec/write-grant.test.ts`): uses review metadata and `risk_areas`, preserving capability checks.

New property templates in `spec/planner-entry.test.ts` are listed in section 1 (minimal/decomposed positive and negative cases plus legacy readers/refusal). The shared fixture authors an explicit graph; it is test support, not an engine selector.

Unchanged-title test bodies adaptedfor the planner entry or retained review isolation (all their substantive non-chooser checks remain):

- `spec/adapter-availability.test.ts`: **selects the only installed %s CLI at runtime**; **launches foreground quick without project writes (existing brief=%s)**.
- `spec/brief-writer.test.ts`: **raw text reaches the single entry with evidence attached**.
- `spec/decision-graph.test.ts`: **renders one base contract and supplies only the structured assessment record to its reviewer**; **settles repaired work through the current read-only review choice (%s → %s), retaining the rejection**; **checks the rendered router and focused reviewer inputs, closed risk schema and full alternative**; **validates only authors and repairs across decisions, a replan and a review-depth switch, and binds gates to their final trees (declared ignored output=%s)**; **appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)**; **settles deep alternatives without hiding unfinished selected work ($selected, missing=$missing)**; **fails a focused reviewer write without restoring it or accepting a clean retry**; **honors the full gate choice over a planner repair condition (initial pass=%s)**; **admits a separately planned shape and still routes every review through assessment**; **defaults an invalid risk file to full review and supplies current facts without reusing stale risks**; **retains declared run outputs and downstream work through $selected (missing=$omit)**.
- `spec/gate-repair-confirmation.test.ts`: **retains reproduction closure across assessment choices (%s → %s)**; **keeps an accepted repair closed after independent downstream work and reassessment to %s**.
- `spec/ledger-handoff.test.ts`: **gives first and later gates and repair one contract, structured facts, diff and readable paths**; **keeps isolated decision retries cold while retaining their exact own final record**.
- `spec/no-approvals.test.ts`: **keeps a metric-oriented brief engineering by declaration without demanding research fields**.
- `spec/quick-foreground.test.ts`: **foreground %s quick on %s base completes locally with registration, progress, delivery and explicit-only ACK gating**.
- `spec/stage-duration-limit.test.ts`: **%s: at-limit enters, above-limit receives the typed refusal**.
- `spec/write-grant.test.ts`: **preserves admitted external outputs and the shared boundary for a scheduler %s**.

## 6. Changes relative to the unreviewed draft

- Preserved the complete draft in `58c947d` before changing any file; rebased onto `a24bba6`. The rebased preservation commit is `22e341b`.
- Resolved `spec/ledger-handoff.test.ts:1` by retaining main's `evidenceContext` import and the draft's `entryPlan` / `plannerReply` import; main's removal of `buildDependencyContext` remains intact.
- Resolved `spec/ship-docs.test.ts:140` using the digest of the merged skill body. Main's documentation cleanup and the planner-entry text are both retained; advanced the ship revision from 55 to 56 because both branches had independently used 55.
- Fixed the independently reproduced spec-purity failure at `spec/planner-entry.test.ts:116`: the Node status child inherited ambient HOME without an explicit fixture home. It now receives an existing private HOME at `:118`, alongside private FC_HOME/socket and cwd. `spec/spec-purity.test.ts` and the scanner are unchanged.
- Fixed the foreground CLI fixture's nested TMPDIR after the related run and a single-case reproduction showed 120-byte command socket paths failing with `EADDRINUSE`. `spec/quick-foreground.test.ts:84` now reuses the invocation-owned private scratch (`tmpdir()`), giving a 103-byte command socket path in this checkout; no engine socket policy changed. All six foreground cases passed the focused repair run (`quick-fixed.json`, exit 0).
- Replaced the draft's unverifiable validation narrative and stale 195-file selection with independent build, transitive selection, native test reports, baseline/final gate probe and current production counts. Retained the declared constraint conflict after independently reproducing it. No production policy was changed during takeover.

## 7. Independent commands and results

`npm run build` ran first under `nice -n 19` and exited 0 (`build.log`). Changed-source ESLint exited 0 (`lint-command.json`); `git diff --check` exited 0. The baseline/final gate probe exited 0 and disproves the universal property equally on both trees (`gate-probe.json`).

The following are the native Vitest JSON counts for each individual related/focused invocation, not invented totals for full validation. Full argv and exits are in the corresponding command JSON; stdout and native JSON are retained separately. Filtered cases in a focused invocation are reported as pending by Vitest.

| Invocation | Exit | Native passed / failed / pending | Meaning |
| --- | ---: | ---: | --- |
| `purity-before` | 1 | 14 / 1 / 0 | Reproduces the draft failure; explicit private HOME was missing from the status child. |
| `related` | 1 | 4944 / 8 / 0 | The exact 332-file affected set; foreground socket paths and two scratch socket path assertions failed. All other executed assertions passed; original native results retained. |
| `quick-probe` | 1 | 0 / 1 / 5 | One foreground case reproduces the nested socket-path failure; other parameter cases are filtered. |
| `quick-fixed` | 0 | 6 / 0 / 0 | All six foreground cases pass after reusing private invocation scratch. |
| `purity-final` | 0 | 15 / 0 / 0 | All purity assertions pass after the final spec edit; scanner/test unchanged. |
| `scratch-probe` | 1 | 0 / 2 / 22 | Both short-socket assertions reproduce at 114 bytes; other tests are filtered. |
| `scratch-short` | 0 | 2 / 0 / 22 | Both assertions pass at 107 bytes with a worktree-root temporary parent; other tests are filtered. |

The original affected run remains exit 1: its eight failed assertions are retained, with passing focused follow-ups for exactly those cases. No full affected-set rerun or full validation was performed. Both original failed files were unrelated to the planner's gate admission conflict. All 332 selected filenames are matched to native report files by `finalize-reports.py`.



Related files and exact selection reasons are mechanically recorded in `selected-tests.txt` and `selected-tests.json` alongside the task's external report. `select-tests.mjs` parses imports/exports/dynamic imports with TypeScript, resolves local JS-to-TS paths, walks the transitive graph, checks removed identifiers/strings in main and final, and includes every replay, every `spec/engine/` case, every changed spec and purity. The resulting set has **332 of 358 spec files**; 26 unrelated files are excluded. This is a related-spec invocation, not full validation.

`test-title-accounting.json` mechanically records added/removed/retained literal test and describe titles. Parameter changes and unchanged-title assertion changes are listed above. Commands use `nice -n 19`, no CPU pinning, private worktree TMPDIR / FC_HOME / socket, stub stages and controlled attempt clocks. The related run used a private `.tmp_p` parent; the two scratch-lifetime socket cases were reproduced at 114 bytes and then passed with the worktree root as the private temporary parent (107 bytes), without changing their assertions or engine defaults. The test process group is retired by the runner. Full configured validation is reserved for the launcher's single VERIFY invocation and was not run here.

## 8. Diff accounting

- `src+config` relative to `a24bba6`: 18 files, **+72 / -92**.
- `spec` relative to `a24bba6`: 16 files, **+227 / -122**.
