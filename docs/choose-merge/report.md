# Planner owns the engineering entry

## 1. Criteria and evidence

Before references below denote the source snapshot captured before editing, not the older audit checkout. `docs/choose-merge/EVIDENCE.md` was read and left unchanged. No historical operator runs were inspected. The supplied ledger had no completed validation for this change; complete configured validation remains the engine's responsibility after settlement.

| Criterion | Implementation and property evidence |
| --- | --- |
| `no-shape-model` | `config/workflows/entry.yaml:3` contains only the dynamic planner, with no predecessor or fixed dispatch. `src/scheduler/sched_admission/configuration.ts:58` admits only successor/review decision kinds. `src/decision-graph.ts:9` has no chooser schema, failure branch or prompt. `spec/planner-entry.test.ts:35`, **starts entry at the planner with no preceding decision or fixed answer**, checks the whole entry stage list, dependencies, absent decision/dispatch, and rejection of an active shape kind. Adding a pre-planner decision makes this test fail. |
| `planner-owns-shape` | `config/agents/planner.yaml:29` explicitly permits one author followed by an independent gate or decomposition. `src/scheduler/sched_loop/ordinary-stage.ts:53` renders the planner contract; `src/scheduler/sched_policy/dispatch-injection.ts:36` admits its proposal through `createDispatchAdmission` (`src/scheduler/sched_admission/dispatch.ts:205`). `spec/planner-entry.test.ts:44`, **admits a planner graph with %s author duties through dispatch admission and independent acceptance** (1 and 2), checks the same persisted admission report and gate coverage for both. |
| `gate-kept` | **Partial; literal universal guarantee conflicts with the unchanged-admission constraint (below).** The existing gate/repair requirements remain at `src/scheduler/sched_admission/dispatch.ts:233` and criterion coverage at `:275`. A minimal successful path has one author and one independent gate; existing admission also requires a dormant repair route. Review alternatives are expanded by unchanged `src/decision-graph.ts:62`. `spec/planner-entry.test.ts:69`, **refuses an ungated planner graph with %s author duties before execution** (1 and 2), checks refusal before any author. Existing review, repair, replan, branch/join and budget tests in `spec/decision-graph.test.ts`, `spec/gate-repair-confirmation.test.ts`, and the selected repair/replan/engine specs remain. Representative retained tests: **records valid, invalid-default and outside-set refusal in one real scheduler run** (`spec/decision-graph.test.ts:107`); **bounds a self edge without resetting attempts or the iteration budget** (`:119`); **honors the full gate choice over a planner repair condition (initial pass=%s)** (`:521`); **appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)** (`:344`). |
| `old-records-readable` | `src/scheduler/sched_admission/configuration.ts:69` separately decodes historical shape metadata. `src/decision-graph.ts:20` retains archived assumptions, consumed by unchanged `src/run-summary.ts:397`. `src/engine-continuation.ts:16` supplies typed `ContinuationRefusal` with code `retired_shape_decision`; `src/scheduler/sched_loop/launch.ts:55` checks before normalization, claims, recovery or execution. `spec/planner-entry.test.ts:89`, **reads legacy choose/shape through status, listing, summary and rendered UI; refuses resume without mutation**, exercises active versus recorded decoding, status CLI and state view, listing, summary, dashboard conversion, real UI rendering, compatibility preflight, stub execution refusal, and byte-for-byte preservation of the synthetic run directory. |
| `no-new-rule` | The entry contains no routing decision. The diff removes shape selection and all its active exceptions; no classifier, prose rule, threshold, flag, option or declaration key was added. The only new branch on historical `kind: shape` is execution refusal (`src/engine-continuation.ts:21`), based on typed metadata. The existing declaration-owned research selection remains at `src/scheduler/sched_admission/brief-contract.ts:29`. |
| `light-tests` | New scheduler property tests use stub adapters (`spec/planner-entry.test.ts:51`) and the stationary attempt clock in `spec/test-support/stage-deadline.ts:8`; the stub planner (`spec/test-support/planner-entry.ts:17`) declares its graph explicitly. No verdict asserts real elapsed time. Legacy status subprocesses have a hang bound, not a duration assertion. The anti-regression property checks the complete entry graph. Related-spec selection and exact command records are described in section 5. |

### Constraint conflict: the universal gate quantifier

The sentence “Every admitted plan still ends in an independent gate before acceptance” is stronger than the existing admission rules, which the brief explicitly puts out of scope. `src/scheduler/sched_admission/dispatch.ts:275` enforces gate coverage for declared criteria; a proposal with one ordinary author, an explicit empty artifact contract, and no declared criteria or outputs returns `{pass: true, errors: []}`. The same result was reproduced against both the captured before source and final source (`gate-boundary-probe.json`, exit 0) through the exported `inspectDispatchAdmission` with a parsed ordinary stage, `baseStages: []`, and `dispatchStageId: 'plan'`; the command and result are in the evidence ledger. The removed shape exceptions are not involved in that case. The required existing generic decision test **records valid, invalid-default and outside-set refusal in one real scheduler run** (`spec/decision-graph.test.ts:107`) also expects an ungated graph to complete. Changing that acceptance behavior would contradict the requirement that the generic graph behave as before with its existing tests retained and passing. Existing **admits planner roots as conditional DAG duties without inventing a chosen successor** (`spec/planner-dispatch-condition.test.ts:29`) also accepts and completes ungated duty-only work, and was kept as required.

The planner prompt requires independent review, and canonical criterion-bearing plans are tested for mandatory gates. That does not prove the literal universal property: a stub or model can still propose the existing ungated duty-only graph. Rejecting this proposal at admission would change the expressly protected admission rules. Refusing its existing successful completion would break the protected generic-graph behavior/tests; adding a gate outside the admitted graph would make another owner choose part of its shape. No such rule or bypass was added. This report therefore leaves the literal universal part of `gate-kept` unmet and identifies the conflicting sentences rather than silently narrowing it. Review/repair/replan behavior and its coverage are preserved.

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
| `src/scheduler/sched_settlement/gate-validation.ts:170` shape validation exclusion | Removed; review decisions, planners and gates retain their existing handling at the same line. |
| `src/scheduler/sched_admission/brief-contract.ts:28` chooser description/reason | Says planner at the same lines; declaration-based research routing is unchanged. |

Generic consumers were traced and retained: decision lifecycle in `src/scheduler/sched_loop/iteration-setup.ts:74`, `src/scheduler/sched_loop/iteration.ts:57`, `src/scheduler/sched_loop/stage-batch.ts:40`; acceptance/outstanding duties in `src/scheduler/sched_settlement/completion.ts:72`, `src/declared-artifact-audit.ts:18`, `src/scheduler/sched_settlement/gate-verdict.ts:126`; planner/revision identity in `src/scheduler/sched_loop/planner-dispatch.ts:26`, `src/plan-revisions.ts:89`; immutable graph history in `src/store.ts:1227`; own-attempt predecessors in `src/decision-context.ts:59`. These consume generic graph records rather than chooser semantics. Campaign context, declaration-owned research selection, write authority, ship-setup and assessment routing were not redesigned. The complete `POST_AUTHOR_PROMPT`/`declareReviewChoices` suffix is byte-identical to the initial source snapshot.

All four shipped workflow files remain reachable: CLI engineering entry loads `entry.yaml` (`src/cli.ts:1218`); declaration-owned research uses `research.yaml` and its existing constructed workflow; `plan-check --brief` loads `planner.yaml` or research (`src/plan-interface.ts:82`); exported `loadWorkflow`/`runWorkflow` support `direct.yaml` as a fixed-plan library workflow, exercised by `spec/direct-workflow.test.ts`. Historical continuation also loads the recorded workflow. No whole production workflow or code file became unreachable. The chooser-only blocks listed above were deleted, rather than retained beside the planner.

Test consumers now author proposals through `spec/test-support/planner-entry.ts`, or retain their explicitly decomposed proposals. Mock launch fixtures in adapter-availability, quick-foreground, supervised-lifecycle and brief-writer now provide `plan.json`. Ledger retry isolation and write-grant isolation use the retained review kind. Historical JSON fixtures under `spec/fixtures/no-approvals/`, `spec/fixtures/run-tree-continuity.json`, the pinned historical `validation-budget-trial.py`, and the historical push-rendering request remain historical data/standalone replay inputs; they are not reachable from the new entry or a replacement selector. `brief-writer.ts` assumptions are brief inputs, a separate contract.

## 3. What the operator sees for old runs

The old run remains listed. Status retains its `choose` stage without relabelling it as a planner. The run state and decision history retain its successor, outcome, reason and assumptions. The summary continues to render its existing “Chooser assumptions” section. Dashboard data retains the stage, and the UI detail component renders it without needing a live shape kind. Read-only decoding does not migrate the stored workflow.

Execution admission is separate. A recorded workflow or admitted plan containing `kind: shape` returns `ContinuationRefusal` / `retired_shape_decision` with guidance to start a new planner run using the historical evidence. Checks happen before normalization or ownership claims, including the library launch path. Refusal recording also checks the historical metadata before any operational write (`src/engine-continuation.ts:26`), so callers cannot mutate these records by publishing the refusal. The synthetic compatibility test checks all run-directory bytes after status, readers and both continuation entrypoints. Older hashless records retain their pre-existing typed contract refusal; no contract is invented for them. Generic historical decisions without the retired kind retain the existing successor decoder.

## 4. Mechanisms and production footprint

Removed mechanisms: pre-planner model call and fixed entry graph (`entry.yaml:4` before); task-only chooser prompt/input (`decision-graph.ts:63`, `decision-context.ts:60` before); shape-only output/validation mode; fixed-entry materialization and scheduling/admission/replan exceptions (section 2). Added compatibility work: separate recorded kind decoding (`configuration.ts:69` after), typed retired-workflow refusal and refusal-publication protection (`engine-continuation.ts:16`, `:26` after), early library launch guard (`launch.ts:55` after). No replacement shape selection mechanism exists. Shipped guidance now describes the planner entry (`guide/brief-contract.md:62`, `guide/configuration.md:145`, `guide/operations.md:298`, `skills/ship.md:43`). Ship skill revision is 55, digest `1160ab38a7e6`; the digest assertion is updated in `spec/ship-docs.test.ts:140`.

Counts use physical lines (`bytes.splitlines()`), all regular files under the same `src/` and `config/` trees. Before counts were captured before editing. There are **18 changed production files**, within the requested approximate 20-file bound; **215 files before and after**, **52,346 → 52,326 lines** overall. The same 18 changed files total **4,511 → 4,491 lines** (20 fewer). No production file was added or deleted.

| Production file | Before | After |
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
| `src/scheduler/sched_settlement/gate-validation.ts` | 297 | 297 |
| `src/worker.ts` | 1,403 | 1,403 |

The measurable benefit established here is fewer mechanisms, one fewer pre-planning model stage, and the source reduction above. The audit provides no matched-run counterfactual for latency, completion rate or quality. Planner over-decomposition remains possible; this change does not claim a measured improvement in those outcomes.

## 5. Test accounting and verification

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

Verification records live in the author stage workspace: `before/counts.json`, `before/src/`, `before/config/`, `before/spec/`, `production-counts.json`, `gate-boundary-probe.json`, `test-title-accounting.json`, `selected-tests.json` (selection reasons), `selected-tests.txt` (exact files), `run-targets.py`, and per-invocation `*-command.json`. The engine evidence ledger records commands/exits separately. These are evidence artifacts, not additional human deliverables.

Author verification used only the related set above and focused repair checks. Exact argument vectors, file filters and exits are in the per-invocation command JSON; standard Vitest JSON/log reports are retained under `verification/` in the stage workspace. Full configured validation is intentionally unmeasured here and belongs to the engine.

- Initial private compilation reported a schema-widening type error (exit 2); separating recorded decoding fixed it. A private build initially refused staging beneath the authored source root (exit 1); compiler staging/publication were moved to private `$TMPDIR` outside that source root. The final bounded private build, `nice -n 19 timeout 300 node --import tsx scripts/build.ts "$TMPDIR/choose-generation"`, exited 0 after the last production edit (`verification/choose-build-guard-fix.log`). Public generated paths were temporarily linked to that private generation for checks; the original generated paths were restored afterward.
- The first seven-spec run exited 1 because of one fixture syntax error and inherited author `GIT_*` variables. Those variables made fixture Git commands use the author's stage Git context. The syntax was corrected; test subprocess environments now remove every inherited `GIT_*`. `choose-core-command.json` records the seven-spec rerun, exit 0.
- `choose-related-command.json` records the exact 195-file related run (exit 1). Its failed files and assertions are retained in `related-failures.json`. The failures were the overly strict early legacy preflight, long private Unix socket paths, and the migrated review-isolation fixture's lack of a readable diff. The preflight now scans only retired kind metadata and leaves existing status/layout/admission checks in place. Sparse preparation records, unknown statuses and early-return paths keep their existing behavior. The isolation fixture supplies a readable Git diff, so the real stub executes. Test scratch was shortened inside the worktree, and the CLI integrity fixture reuses private invocation scratch rather than nesting socket aliases.
- `choose-grant-probe-command.json` reproduced the migrated isolation failure (exit 1); `choose-grant-fixed-command.json` records its focused passing repair (exit 0). `choose-compat-probe-command.json` reproduced the early-preflight failures (exit 1). `choose-entry-guards-command.json` and `choose-cancel-env-command.json` record successful socket-environment checks (exit 0 each).
- `choose-guard-fixed-command.json` records the final 24-file focused run, exit 0, including every initially failed spec plus planner-entry, decision graph, canonical contract, archived reader, deployment hold and continuation checks. `repair-tests.txt` records that exact file selection. No assertion was waived to make those failures pass.
- The build replay's existing `npm_execpath` condition skipped it under direct Vitest invocation. It was separately selected through `npm run test -- spec/ux-perf-build-tests.replay.ts` with the same private environment; `choose-build-replay-command.json` records exit 0 with the replay executed, and its standard reports are retained under `verification/`.
- Targeted ESLint over all changed `src/` files exited 0 (`targeted-lint-final.json`); `git diff --check` exited 0. `gate-boundary-probe.mjs` exited 0 and recorded the same ungated admission before and after. That successful reproduction is the remaining criterion conflict, not a passing universal-gate check.

Reproduction from an author workspace uses `nice -n 19 python3 "$STAGE/select-tests.py"`, then `nice -n 19 python3 "$STAGE/run-targets.py" choose-related`; pass the paths in `repair-tests.txt` to that same wrapper for focused repairs. The wrapper invokes bounded, low-priority Vitest with two workers, private worktree temporary storage and FC home/socket, no cache, controlled stub-stage clocks, and real hang bounds. It records its exact subprocess argv and exit. All actual evidence commands are also in the engine ledger. No complete-suite totals are constructed or claimed.

Unchanged-title test bodies adapted for the planner entry or retained review isolation (all their substantive non-chooser checks remain):

- `spec/adapter-availability.test.ts`: **selects the only installed %s CLI at runtime**; **launches foreground quick without project writes (existing brief=%s)**.
- `spec/brief-writer.test.ts`: **raw text reaches the single entry with evidence attached**.
- `spec/decision-graph.test.ts`: **renders one base contract and supplies only the structured assessment record to its reviewer**; **settles repaired work through the current read-only review choice (%s → %s), retaining the rejection**; **checks the rendered router and focused reviewer inputs, closed risk schema and full alternative**; **validates only authors and repairs across decisions, a replan and a review-depth switch, and binds gates to their final trees (declared ignored output=%s)**; **appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)**; **settles deep alternatives without hiding unfinished selected work ($selected, missing=$missing)**; **fails a focused reviewer write without restoring it or accepting a clean retry**; **honors the full gate choice over a planner repair condition (initial pass=%s)**; **admits a separately planned shape and still routes every review through assessment**; **defaults an invalid risk file to full review and supplies current facts without reusing stale risks**; **retains declared run outputs and downstream work through $selected (missing=$omit)**.
- `spec/gate-repair-confirmation.test.ts`: **retains reproduction closure across assessment choices (%s → %s)**; **keeps an accepted repair closed after independent downstream work and reassessment to %s**.
- `spec/ledger-handoff.test.ts`: **gives first and later gates and repair one contract, structured facts, diff and readable paths**; **keeps isolated decision retries cold while retaining their exact own final record**.
- `spec/no-approvals.test.ts`: **keeps a metric-oriented brief engineering by declaration without demanding research fields**.
- `spec/quick-foreground.test.ts`: **foreground %s quick on %s base completes locally with registration, progress, delivery and explicit-only ACK gating**.
- `spec/stage-duration-limit.test.ts`: **%s: at-limit enters, above-limit receives the typed refusal**.
- `spec/write-grant.test.ts`: **preserves admitted external outputs and the shared boundary for a scheduler %s**.

Exact related-spec selection (source-import references are resolved relative to each spec; imports of `src/scheduler.ts` also count its changed re-exports; removed-string references are scanned in both the before snapshot and final source). Every replay and `spec/engine/` case is included:

```text
spec/acceptance-gate-adversarial.qa.test.ts
spec/acceptance-loop.test.ts
spec/adapter-authentication.test.ts
spec/adapter-availability.test.ts
spec/adapter-input-limit.test.ts
spec/admission-settlement.test.ts
spec/agent-safety-contract.test.ts
spec/attempt-attribution.test.ts
spec/attempt-cost.test.ts
spec/attempt-deadline-wip-regressions.test.ts
spec/attempt-history.test.ts
spec/attempt-signal-watch.test.ts
spec/audit-engine-boundaries-2.test.ts
spec/author-output-cost.test.ts
spec/blocked-result-gate.test.ts
spec/body-unread.test.ts
spec/brief-frontmatter.test.ts
spec/brief-outcome-gate.test.ts
spec/brief-preflight.test.ts
spec/brief-writer.test.ts
spec/campaign-context.test.ts
spec/cancel-repended-daemon.test.ts
spec/cancellation-liveness.test.ts
spec/cancellation-park.test.ts
spec/cancellation-repend-paths.test.ts
spec/cancellation-settlement.test.ts
spec/claude-sessions.test.ts
spec/cli-integrity.test.ts
spec/clock-identity.test.ts
spec/continuation-compatibility.test.ts
spec/contract-reachability-before.test.ts
spec/contract-strict.test.ts
spec/contract-write-authority.replay.test.ts
spec/control-validation.test.ts
spec/criteria-lint.test.ts
spec/decision-graph.test.ts
spec/declared-contract-repair.test.ts
spec/declared-contract.test.ts
spec/declared-replay.test.ts
spec/deployment-hold.test.ts
spec/direct-workflow.test.ts
spec/dispatch-admission-parallel-warning.test.ts
spec/dispatch-document.test.ts
spec/doc-reviewer-contract.test.ts
spec/engine/codex-cleanup.contract.test.ts
spec/engine/context.contract.test.ts
spec/engine/dispatch-retry-and-reject.contract.test.ts
spec/engine/engine-a-plus.contract.test.ts
spec/engine/engine-terminal-truthfulness.contract.test.ts
spec/engine/objective-frontmatter.contract.test.ts
spec/engine-batch-regressions.test.ts
spec/engine-boundaries-2.test.ts
spec/engine-boundaries-3.test.ts
spec/engine-boundaries-4.test.ts
spec/engine-boundaries-5.test.ts
spec/engine-boundaries-6.test.ts
spec/engine-boundaries-8.test.ts
spec/engine-carrier-writers.test.ts
spec/engine-generalization-contracts.test.ts
spec/engine-generalization-runtime.test.ts
spec/engine-integrity-settlement.test.ts
spec/engine-integrity.test.ts
spec/engine-perf-settlement.test.ts
spec/engine-principles-declaration-retry.test.ts
spec/engine-principles-declarations.test.ts
spec/engine-principles-durability.test.ts
spec/engine-principles-independent.test.ts
spec/engine-principles-integration.test.ts
spec/engine-principles-policies.test.ts
spec/engine-records-regressions.test.ts
spec/engine-remediation.test.ts
spec/engine-selfcollision.test.ts
spec/engine-truthfulness.test.ts
spec/entry-guards.test.ts
spec/evidence-ledger.test.ts
spec/execution-default-source.test.ts
spec/external-output-directory.test.ts
spec/fc-tasks.test.ts
spec/fixed-plan-selection.test.ts
spec/fm-campaign-integration.test.ts
spec/forensic-validation.qa.test.ts
spec/frozen-field.test.ts
spec/gate-attempt-contract.test.ts
spec/gate-own-verdict.test.ts
spec/gate-repair-confirmation.test.ts
spec/gate-result.test.ts
spec/gate-retry-entry.test.ts
spec/gate-settlement-identity.test.ts
spec/git-facts-cli.test.ts
spec/git-facts-records.test.ts
spec/git-facts.test.ts
spec/git-metadata-scope.test.ts
spec/graceful-attempt-termination.test.ts
spec/guidance-feasibility-controls.test.ts
spec/invocation-controls.test.ts
spec/invocation-input.test.ts
spec/iteration-log.test.ts
spec/ledger-handoff.test.ts
spec/legacy-write-records.test.ts
spec/lifecycle-log.test.ts
spec/livelog-per-attempt.test.ts
spec/loop-close-terminal.test.ts
spec/measured-setup-launch.test.ts
spec/native-invocation-usage.test.ts
spec/negotiation.test.ts
spec/no-approvals.test.ts
spec/od-validation-receipt.test.ts
spec/orchestration-contract-regressions.test.ts
spec/parallel-scope-batch.test.ts
spec/path-extraction.test.ts
spec/pivot-recovery.test.ts
spec/plan-retry-monotone.test.ts
spec/planner-admission-check.test.ts
spec/planner-carrier.test.ts
spec/planner-contract.test.ts
spec/planner-dispatch-condition.test.ts
spec/planner-entry.test.ts
spec/planner-output-contract.test.ts
spec/planner-read-source.test.ts
spec/project-validation.test.ts
spec/provider-result-contract.test.ts
spec/published-inputs.test.ts
spec/push-rendering.test.ts
spec/quick-foreground.test.ts
spec/reality-check-artifact-admission.test.ts
spec/reevaluation-fix.test.ts
spec/repair-plan-revision.test.ts
spec/repair-replan-budget.test.ts
spec/replan-evidence-retention.test.ts
spec/replan-stage-obligation.test.ts
spec/research-branch-applicability.test.ts
spec/research-loop.test.ts
spec/research-measurement.test.ts
spec/resume-continuation.test.ts
spec/resume-rejected-gate.test.ts
spec/retry-attempt-deadline.test.ts
spec/review-input-bound.test.ts
spec/run-conclusion.test.ts
spec/run-retention-integration.test.ts
spec/run-status-totality.test.ts
spec/run-tree-ownership.test.ts
spec/run-workflow-cleanup.test.ts
spec/runtime-settlement.test.ts
spec/safe-parallel.test.ts
spec/scheduler-retry-policy.test.ts
spec/scheduler-stall-ignored-content.test.ts
spec/scope-dotfile-authorization.test.ts
spec/scope-language.test.ts
spec/session-reuse.test.ts
spec/settlement-reachable.test.ts
spec/ship-docs.test.ts
spec/ship-setup.test.ts
spec/single-author-legacy.test.ts
spec/skill-consolidation-contract.test.ts
spec/spec_runtime/declared-fixtures.test.ts
spec/spec_runtime/pivot-injection.test.ts
spec/spec_services/contract-audit.test.ts
spec/stage-attempt-clock.test.ts
spec/stage-budget.test.ts
spec/stage-duration-limit.test.ts
spec/stage-output-slimming.test.ts
spec/stage-progress.test.ts
spec/stage-record-correction.test.ts
spec/stage-settlement-products.test.ts
spec/stage-watchdog.test.ts
spec/stage-write-contract.test.ts
spec/supervised-lifecycle.test.ts
spec/supervision.test.ts
spec/supervisor-abort-attribution.test.ts
spec/terminal-artifact-acceptance.test.ts
spec/terminal-attempt-delta.test.ts
spec/terminal-final-contract-workflow.test.ts
spec/terminal-freshness.test.ts
spec/terminal-gate-authority.test.ts
spec/terminal-review-order.test.ts
spec/terminal-review-settlement.test.ts
spec/terminal-study-completion.test.ts
spec/timeout-extension-write-time.test.ts
spec/typed-reality-checks.test.ts
spec/ux-perf-build-tests.replay.ts
spec/ux-perf-dashboard-event.replay.ts
spec/ux-perf-engine-loop.replay.ts
spec/ux-perf-operator-surface.replay.tsx
spec/ux-perf-state-daemon.replay.ts
spec/validation-budget.test.ts
spec/validation-data-isolation.test.ts
spec/validation-dependency-sync.test.ts
spec/validation-load.test.ts
spec/validation-ownership.test.ts
spec/verify-contract-independent.qa.test.ts
spec/verify-contract-qa-edge.test.ts
spec/verify-engine-remediation.qa.test.ts
spec/verify-totality-stage.test.ts
spec/write-grant.test.ts
spec/write-scope-subtraction.test.ts
```
